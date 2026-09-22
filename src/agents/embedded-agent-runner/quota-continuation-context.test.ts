import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../../../packages/ai/src/providers/openai-completions.js";
import { applyProviderPayloadHook } from "../../../packages/ai/src/utils/provider-payload.js";
import { wrapStreamFnWithProviderPromptState } from "./provider-prompt-state.js";
import { assertQuotaPrefixInProviderPayload } from "./quota-continuation-context.js";

const required = [
  { role: "user", content: "Complete both operations without replay." },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "source:first",
        name: "write",
        arguments: { content: "large".repeat(15_000) },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "source:first",
    toolName: "write",
    content: [{ type: "text", text: "first committed" }],
    isError: false,
  },
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "source:second", name: "read", arguments: { path: "second" } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "source:second",
    toolName: "read",
    content: [{ type: "text", text: "second observed" }],
    isError: false,
  },
];
const model: Model = {
  id: "test",
  name: "test",
  provider: "fixture",
  baseUrl: "http://fixture.invalid/v1",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
function payload() {
  return {
    messages: [
      {
        role: "user",
        content:
          "[Fri 2026-09-18 12:00 UTC] Complete both operations without replay.\n\nRuntime: agent=fixture",
      },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "normalized1",
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({ content: "large".repeat(15_000) }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "normalized1", content: "first committed" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "normalized2",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "second" }) },
          },
        ],
      },
      { role: "tool", tool_call_id: "normalized2", content: "second observed" },
      { role: "user", content: "Continue from the existing transcript." },
    ],
  };
}

describe("required quota prefix at final provider admission", () => {
  it("allows provider-owned call-ID normalization without dropping the admitted prefix", () => {
    expect(() => assertQuotaPrefixInProviderPayload(required, payload(), model.api)).not.toThrow();
  });
  it.each(["openai-responses", "anthropic-messages"] as const)(
    "preserves the required prefix in %s final payloads",
    (api) => {
      const wire = payload().messages;
      const rows = wire.flatMap<unknown>((message) => {
        const call = message.tool_calls?.[0];
        if (call) {
          return api === "openai-responses"
            ? [
                {
                  type: "function_call",
                  call_id: call.id,
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              ]
            : [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: call.id,
                      name: call.function.name,
                      input: JSON.parse(call.function.arguments) as unknown,
                    },
                  ],
                },
              ];
        }
        if (message.role === "tool") {
          return api === "openai-responses"
            ? [
                {
                  type: "function_call_output",
                  call_id: message.tool_call_id,
                  output: message.content,
                },
              ]
            : [
                {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: message.tool_call_id,
                      content: message.content,
                    },
                  ],
                },
              ];
        }
        return [{ role: message.role, content: message.content }];
      });
      expect(() =>
        assertQuotaPrefixInProviderPayload(
          required,
          api === "openai-responses" ? { input: rows } : { messages: rows },
          api,
        ),
      ).not.toThrow();
      if (api === "openai-responses") {
        expect(() =>
          assertQuotaPrefixInProviderPayload(
            required,
            { input: [...rows, { type: "item_reference", id: "opaque-image" }] },
            api,
          ),
        ).toThrow(/opaque/);
      }
    },
  );

  it.each([
    "bounded-reader",
    "windowing-engine",
    "post-onPayload",
    "media",
    "duplicate",
    "changed-result",
  ] as const)("refuses %s before the transport receives a request", async (kind) => {
    const outbound = payload();
    if (kind === "bounded-reader") {
      outbound.messages = outbound.messages.slice(3);
    }
    if (kind === "windowing-engine") {
      outbound.messages.splice(1, 2);
    }
    if (kind === "duplicate") {
      outbound.messages.push(...payload().messages.slice(0, 5));
    }
    if (kind === "changed-result") {
      outbound.messages[2]!.content = "a different effect";
    }
    if (kind === "media") {
      Reflect.set(outbound.messages[0]!, "content", [
        { type: "image_url", image_url: { url: "https://example.invalid/private.png" } },
      ]);
    }
    const sent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      state: {},
      effectiveContextTokenBudget: 8192,
      assertFinalPayload: (body, api) => assertQuotaPrefixInProviderPayload(required, body, api),
      streamFn: async (_model, _context, options) => {
        await options?.onPayload?.(outbound, model);
        sent();
        return createAssistantMessageEventStream();
      },
    });
    await expect(
      wrapped(
        model,
        { messages: [] },
        kind === "post-onPayload"
          ? { onPayload: () => ({ messages: outbound.messages.slice(3) }) }
          : {},
      ),
    ).rejects.toThrow(/continuation/i);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("owned quota occurrence inventory", () => {
  it.each(["before-user", "after-user", "before-pair", "after-pair"])(
    "rejects partial duplicate %s even with renamed IDs",
    (kind) => {
      const wire = payload();
      const extra = kind.endsWith("user")
        ? [structuredClone(wire.messages[0]!)]
        : structuredClone(wire.messages.slice(1, 3));
      if (extra[0]?.tool_calls) {
        extra[0].tool_calls[0]!.id = "renamed-duplicate";
        extra[1]!.tool_call_id = "renamed-duplicate";
      }
      wire.messages.splice(kind.startsWith("before") ? 0 : wire.messages.length, 0, ...extra);
      expect(() => assertQuotaPrefixInProviderPayload(required, wire, model.api)).toThrow(/prefix/);
    },
  );
  it.each(["distinct", "reused"])(
    "admits identical older requests with %s IDs only from the owned inventory",
    (identity) => {
      const older = payload().messages.slice(0, 5);
      for (const message of older) {
        if (message.tool_calls) {
          message.tool_calls[0]!.id += "older";
        }
        if (message.tool_call_id) {
          message.tool_call_id += "older";
        }
      }
      const history = structuredClone(required);
      for (const message of identity === "distinct" ? history : []) {
        if (message.toolCallId) {
          message.toolCallId += "older";
        }
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if ("id" in block && block.id) {
            block.id += "older";
          }
        }
      }
      const wire = { messages: [...older, ...payload().messages] };
      expect(() => assertQuotaPrefixInProviderPayload(required, wire, model.api)).toThrow();
      expect(() =>
        assertQuotaPrefixInProviderPayload(required, wire, model.api, {
          before: history,
          after: [{ role: "user", content: "Continue from the existing transcript." }],
        }),
      ).not.toThrow();
    },
  );
});

describe("detached final provider body", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([false, true])(
    "retains the checked nested body through the actual built-in serializer (replacement=%s)",
    async (replacement) => {
      const bodies: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          bodies.push(JSON.parse(init.body));
          const chunk = {
            id: "fixture",
            object: "chat.completion.chunk",
            created: 1,
            model: "test",
            choices: [
              { index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" },
            ],
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }),
      );
      let checked: unknown;
      const wrapped = wrapStreamFnWithProviderPromptState({
        state: {},
        effectiveContextTokenBudget: 8192,
        streamFn: (candidate, context, options) => {
          if (candidate.api !== "openai-completions") {
            throw new Error("Wrong fixture API");
          }
          return streamOpenAICompletions(
            { ...candidate, api: "openai-completions" },
            context,
            options,
          );
        },
        assertFinalPayload(body, api) {
          assertQuotaPrefixInProviderPayload(required, body, api);
          checked = body;
        },
      });
      const stream = await wrapped(
        { ...model, baseUrl: "http://fixture.invalid/v1" },
        { messages: [] },
        {
          apiKey: "synthetic-not-a-secret",
          onPayload(original) {
            if (!original || typeof original !== "object") {
              throw new Error("Expected provider body");
            }
            const body = replacement
              ? { ...payload(), model: "test", stream: true }
              : Object.assign(original, payload());
            const retained = body.messages[2]!;
            queueMicrotask(() =>
              queueMicrotask(() => {
                retained.content = "changed after validation";
              }),
            );
            return replacement ? body : undefined;
          },
        },
      );
      expect((await stream.result()).stopReason).toBe("stop");
      expect(bodies).toEqual([checked]);
    },
  );
  it.each(["accessor", "proxy", "toJSON", "cycle", "date", "symbol", "nonfinite"])(
    "fails closed for %s without a send",
    async (shape) => {
      const body = payload();
      const getter = vi.fn(() => "changed");
      if (shape === "accessor") {
        Object.defineProperty(body.messages[2], "content", { get: getter, enumerable: true });
      }
      if (shape === "proxy") {
        Reflect.set(body, "extra", new Proxy({}, { ownKeys: getter }));
      }
      if (shape === "toJSON") {
        Reflect.set(body, "toJSON", getter);
      }
      if (shape === "cycle") {
        Reflect.set(body, "extra", body);
      }
      if (shape === "date") {
        Reflect.set(body, "extra", new Date());
      }
      if (shape === "symbol") {
        Reflect.set(body, Symbol("extra"), "value");
      }
      if (shape === "nonfinite") {
        Reflect.set(body, "extra", Number.NaN);
      }
      const sent = vi.fn();
      const wrapped = wrapStreamFnWithProviderPromptState({
        state: {},
        effectiveContextTokenBudget: 8192,
        assertFinalPayload: (value, api) =>
          assertQuotaPrefixInProviderPayload(required, value, api),
        streamFn: async (_model, _context, options) => {
          await options?.onPayload?.(body, model);
          sent();
          return createAssistantMessageEventStream();
        },
      });
      await expect(wrapped(model, { messages: [] }, {})).rejects.toThrow(/continuation/i);
      expect(sent).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it("protects provider-created objects in the final normalized snapshot", async () => {
    const body = payload();
    let checked: unknown;
    const wrapped = wrapStreamFnWithProviderPromptState({
      state: {},
      effectiveContextTokenBudget: 8192,
      assertFinalPayload(value, api) {
        assertQuotaPrefixInProviderPayload(required, value, api);
        checked = value;
      },
      streamFn: async (_model, _context, options) => {
        const admitted = await applyProviderPayloadHook(
          options?.onPayload,
          body,
          model,
          (value) => {
            expect(value).not.toBe(body);
            return { ...(value as object), providerOwned: { enabled: true }, stream: true };
          },
        );
        // Even objects created by the provider must shadow JSON's inherited hook.
        // Inspect the final graph instead of modifying process-wide prototypes.
        if (!admitted || typeof admitted !== "object" || !("providerOwned" in admitted)) {
          throw new Error("Missing normalized provider body");
        }
        for (const value of [admitted, admitted.providerOwned]) {
          if (!value || typeof value !== "object") {
            throw new Error("Missing provider-created object");
          }
          expect(Object.isFrozen(value)).toBe(true);
          expect(Object.getOwnPropertyDescriptor(value, "toJSON")).toEqual({
            value: undefined,
            enumerable: false,
            writable: false,
            configurable: false,
          });
        }
        const serialized = JSON.stringify(admitted);
        expect(serialized).toBe(JSON.stringify(checked));
        expect(serialized).toContain('"providerOwned":{"enabled":true}');
        expect(checked).toMatchObject({ providerOwned: { enabled: true }, stream: true });
        return createAssistantMessageEventStream();
      },
    });
    await wrapped(model, { messages: [] }, {});
  });

  it("does not change ordinary onPayload object identity", async () => {
    const body = payload();
    const wrapped = wrapStreamFnWithProviderPromptState({
      state: {},
      effectiveContextTokenBudget: 8192,
      streamFn: async (_model, _context, options) => {
        expect(await options?.onPayload?.(body, model)).toBe(body);
        return createAssistantMessageEventStream();
      },
    });
    await wrapped(model, { messages: [] }, {});
  });
});

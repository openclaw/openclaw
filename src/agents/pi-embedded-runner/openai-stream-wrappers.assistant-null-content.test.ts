import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createAssistantNullContentFixWrapper } from "./openai-stream-wrappers.js";

describe("createAssistantNullContentFixWrapper", () => {
  it("normalizes null content to empty string for assistant messages with tool_calls", () => {
    let capturedPayload: unknown;
    const baseFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          { role: "tool", content: "result", tool_call_id: "call_1" },
        ],
      };
      capturedPayload = payload;
      options?.onPayload?.(payload, _model);
      return (async function* () {
        /* empty */
      })() as unknown as ReturnType<StreamFn>;
    };

    const wrapped = createAssistantNullContentFixWrapper(baseFn);
    const model = {
      api: "openai-completions",
      provider: "custom",
      id: "test",
      baseUrl: "http://localhost:1234",
    } as Parameters<StreamFn>[0];
    void wrapped(model, { messages: [] }, {});

    const messages = (capturedPayload as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBe("");
  });

  it("does not modify assistant messages without tool_calls", () => {
    let capturedPayload: unknown;
    const baseFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: [{ role: "assistant", content: null }],
      };
      capturedPayload = payload;
      options?.onPayload?.(payload, _model);
      return (async function* () {
        /* empty */
      })() as unknown as ReturnType<StreamFn>;
    };

    const wrapped = createAssistantNullContentFixWrapper(baseFn);
    const model = {
      api: "openai-completions",
      provider: "custom",
      id: "test",
      baseUrl: "http://localhost:1234",
    } as Parameters<StreamFn>[0];
    void wrapped(model, { messages: [] }, {});

    const messages = (capturedPayload as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBeNull();
  });

  it("does not modify non-openai-completions APIs", () => {
    let capturedPayload: unknown;
    const baseFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      };
      capturedPayload = payload;
      options?.onPayload?.(payload, _model);
      return (async function* () {
        /* empty */
      })() as unknown as ReturnType<StreamFn>;
    };

    const wrapped = createAssistantNullContentFixWrapper(baseFn);
    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "test",
      baseUrl: "https://api.openai.com",
    } as Parameters<StreamFn>[0];
    void wrapped(model, { messages: [] }, {});

    const messages = (capturedPayload as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBeNull();
  });

  it("preserves existing string content on assistant messages with tool_calls", () => {
    let capturedPayload: unknown;
    const baseFn: StreamFn = (_model, _context, options) => {
      const payload = {
        messages: [
          {
            role: "assistant",
            content: "I will help you.",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
        ],
      };
      capturedPayload = payload;
      options?.onPayload?.(payload, _model);
      return (async function* () {
        /* empty */
      })() as unknown as ReturnType<StreamFn>;
    };

    const wrapped = createAssistantNullContentFixWrapper(baseFn);
    const model = {
      api: "openai-completions",
      provider: "custom",
      id: "test",
      baseUrl: "http://localhost:1234",
    } as Parameters<StreamFn>[0];
    void wrapped(model, { messages: [] }, {});

    const messages = (capturedPayload as Record<string, unknown>).messages as Array<
      Record<string, unknown>
    >;
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toBe("I will help you.");
  });
});

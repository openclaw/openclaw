import type { Context } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicModel,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { createZeroUsage } from "./usage.test-support.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./utils/system-prompt-cache-boundary.js";

function markers(value: unknown, path = ""): Array<{ path: string; control: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => markers(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) =>
    key === "cache_control"
      ? [{ path, control: item }]
      : markers(item, path ? `${path}.${key}` : key),
  );
}

function markerPaths(payload: unknown) {
  return markers(payload)
    .map(({ path }) => path)
    .toSorted();
}

function expectControls(actual: ReturnType<typeof markers>, long: boolean) {
  for (const marker of actual) {
    expect(marker.control).toEqual({ type: "ephemeral", ...(long ? { ttl: "1h" } : {}) });
  }
}

const textBlock = (text: string) => ({ type: "text" as const, text });

type CaptureOptions = NonNullable<Parameters<typeof captureAnthropicRequest>[1]>;
async function capture(
  implementation: "provider" | "transport",
  overrides: Partial<Context> = {},
  options: CaptureOptions = {},
) {
  const { payload } = await captureAnthropicRequest(implementation, {
    cacheRetention: "short",
    ...options,
    context: { ...context, ...overrides },
  });
  return payload;
}

function appendToolTurn(messages: Context["messages"], turn: number): Context["messages"] {
  return [
    ...messages,
    {
      role: "assistant",
      api: anthropicModel.api,
      provider: anthropicModel.provider,
      model: anthropicModel.id,
      timestamp: turn * 2,
      stopReason: "toolUse",
      usage: { ...createZeroUsage(), input: 1, output: 1, totalTokens: 2 },
      content: [
        { type: "toolCall", id: `call_${turn}`, name: "lookup", arguments: { query: "value" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: `call_${turn}`,
      toolName: "lookup",
      timestamp: turn * 2 + 1,
      content: [textBlock(`Result ${turn}`)],
      isError: false,
    },
  ];
}

type RouteOptions = CaptureOptions & {
  withTools?: boolean;
  toolCache?: boolean;
  longCache?: boolean;
};
const oauth = { apiKey: "sk-ant-oat01-synthetic" };
const proxy = "https://proxy.example/v1";
const routes: Array<[string, "short" | "long" | "none", RouteOptions]> = [
  ["direct short", "short", {}],
  ["direct long", "long", {}],
  ["direct uncached", "none", {}],
  ["direct without tools", "short", { withTools: false }],
  ["OAuth long", "long", oauth],
  ["OAuth uncached", "none", oauth],
  ["proxy long", "long", { model: { baseUrl: proxy } }],
  ["Fireworks", "long", { model: { provider: "fireworks" }, toolCache: false, longCache: false }],
  [
    "incompatible proxy",
    "long",
    {
      model: { baseUrl: proxy, compat: { supportsCacheControlOnTools: false } },
      toolCache: false,
    },
  ],
];

describe("Anthropic cache checkpoint transport parity", () => {
  registerParityHostLifecycle();

  it.each(["provider", "transport"] as const)(
    "%s retains the previous checkpoint beyond the provider's 20-block lookback",
    async (implementation) => {
      const messages = appendToolTurn(context.messages, 1);
      const first = await capture(implementation, { messages });
      messages.push({
        role: "user",
        timestamp: 4,
        content: Array.from({ length: 21 }, (_, i) => ({ type: "text", text: `Document ${i}` })),
      });
      const next = await capture(implementation, { messages });
      const paths = markerPaths(next);
      // A large new user turn must not hide the last tool-result checkpoint.
      expect(paths).toContain("messages[2].content[0]");
      expect(paths).toContain("messages[3].content[20]");
      expect(paths).toHaveLength(4);
      expect(first.tools).toEqual(next.tools);
      expect((next.messages as unknown[])[2]).toEqual((first.messages as unknown[])[2]);
    },
  );

  it("keeps every checkpoint before transient context during a tool loop", async () => {
    const transient: Context["messages"] = [
      ...context.messages,
      {
        role: "user",
        content: "Transient runtime facts",
        timestamp: 1,
        runtimeContext: { retained: false },
      },
    ];
    const messages = appendToolTurn(appendToolTurn(transient, 1), 2);
    const payload = await capture("transport", { messages });
    expect(markerPaths(payload)).toEqual(["messages[0].content[0]", "system[0]", "tools[0]"]);
  });

  it.each([
    { name: "absent", systemPrompt: undefined },
    { name: "only dynamic", systemPrompt: `${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic` },
    { name: "empty boundary", systemPrompt: SYSTEM_PROMPT_CACHE_BOUNDARY },
  ])(
    "keeps the OAuth identity fallback checkpoint with $name system text",
    async ({ systemPrompt }) => {
      for (const implementation of ["provider", "transport"] as const) {
        const payload = await capture(implementation, { systemPrompt }, oauth);
        expect(markerPaths(payload)).toEqual(["messages[0].content[0]", "system[1]", "tools[0]"]);
        expect(payload.system).toEqual(
          expect.arrayContaining([
            textBlock("x-anthropic-billing-header: cc_version=2.1.280; cc_entrypoint=sdk-cli;"),
            {
              ...textBlock("You are Claude Code, Anthropic's official CLI for Claude."),
              cache_control: { type: "ephemeral" },
            },
          ]),
        );
      }
    },
  );

  it.each([
    ["direct", "https://api.anthropic.com", undefined, true],
    ["default", undefined, undefined, true],
    ["proxy", proxy, undefined, false],
    ["environment proxy", undefined, proxy, false],
  ] as const)(
    "keeps implicit long TTL host gating identical for %s",
    async (_name, baseUrl, envBaseUrl, long) => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
      vi.stubEnv("ANTHROPIC_BASE_URL", envBaseUrl);
      for (const implementation of ["provider", "transport"] as const) {
        const payload = await capture(
          implementation,
          {},
          { model: { baseUrl }, cacheRetention: undefined },
        );
        const actual = markers(payload);
        expect(actual).toHaveLength(3);
        expectControls(actual, long);
      }
    },
  );

  it.each(routes)(
    "%s: checkpoints stay within budget and advance",
    async (_name, cacheRetention, { withTools = true, ...route }) => {
      let messages: Context["messages"] = context.messages;
      const previousTools = new Map<string, unknown>();
      for (let turn = 0; turn < 3; turn++) {
        messages = turn > 0 ? appendToolTurn(messages, turn) : messages;
        const captured = [];
        for (const implementation of ["provider", "transport"] as const) {
          const payload = await capture(
            implementation,
            {
              tools: withTools
                ? context.tools.flatMap((tool) => [tool, { ...tool, name: "read" }])
                : [],
              systemPrompt: `Stable instructions version ${turn === 2 ? 2 : 1}${SYSTEM_PROMPT_CACHE_BOUNDARY}Turn ${turn}`,
              messages,
            },
            { ...route, cacheRetention },
          );
          const actual = markers(payload);
          const expectedPaths =
            cacheRetention === "none"
              ? []
              : [
                  ...(withTools && route.toolCache !== false ? ["tools[1]"] : []),
                  `system[${route.apiKey ? 2 : 0}]`,
                  `messages[${turn > 1 ? (turn - 1) * 2 : 0}].content[0]`,
                  ...(turn > 0 ? [`messages[${turn * 2}].content[0]`] : []),
                ];
          expect(actual.map((marker) => marker.path).toSorted()).toEqual(expectedPaths.toSorted());
          expect(actual.length).toBeLessThanOrEqual(4);
          expectControls(actual, cacheRetention === "long" && route.longCache !== false);
          if (turn > 0) {
            expect(payload.tools).toEqual(previousTools.get(implementation));
          }
          previousTools.set(implementation, payload.tools);
          captured.push({ markers: actual, system: payload.system });
        }
        expect(captured[1]).toEqual(captured[0]);
      }
    },
  );
});

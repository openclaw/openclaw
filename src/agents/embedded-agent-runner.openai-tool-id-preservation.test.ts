import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSanitizeSessionHistoryHelpersMock,
  createSanitizeSessionHistoryProviderHookRuntimeMock,
  createSanitizeSessionHistoryProviderRuntimeMock,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
  type SanitizeSessionHistoryHarness,
} from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { textToolResult } from "./test-helpers/sparse-transcript.test-support.js";
import { extractToolCallsFromAssistant } from "./tool-call-id.js";

vi.mock("./embedded-agent-helpers.js", async () => await createSanitizeSessionHistoryHelpersMock());

vi.mock(
  "../plugins/provider-runtime.js",
  async () => await createSanitizeSessionHistoryProviderRuntimeMock(),
);
vi.mock(
  "../plugins/provider-hook-runtime.js",
  async () =>
    await createSanitizeSessionHistoryProviderHookRuntimeMock({
      resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) =>
        provider === "openai" || provider === "openrouter"
          ? {
              buildReplayPolicy: () => ({
                sanitizeMode: "images-only",
                sanitizeToolCallIds: false,
                applyAssistantFirstOrderingFix: false,
                validateGeminiTurns: false,
                validateAnthropicTurns: false,
              }),
            }
          : undefined,
      ),
    }),
);

describe("sanitizeSessionHistory openai tool id preservation", () => {
  let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
  });

  const makeSessionManager = () =>
    makeInMemorySessionManager([
      makeModelSnapshotEntry({
        provider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      }),
    ]);

  const callId = (message: AgentMessage | undefined) => {
    if (message?.role !== "assistant") {
      throw new Error("Expected an assistant tool call");
    }
    return extractToolCallsFromAssistant(message)[0]?.id;
  };
  const call = (id: string) =>
    castAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "noop", arguments: {} }],
    });
  const output = (id: string, text: string) =>
    castAgentMessage(textToolResult(id, "noop", text, { isError: false }));
  const user = (content: string) => castAgentMessage({ role: "user", content });
  const sanitize = (
    messages: AgentMessage[],
    overrides: Partial<Parameters<typeof sanitizeSessionHistory>[0]> = {},
  ) =>
    sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      modelId: "gpt-5.4",
      sessionManager: makeSessionManager(),
      sessionId: "test-session",
      ...overrides,
    });

  it("repairs displaced tool results before downgrading pairing IDs", async () => {
    const result = await sanitize([
      call("call_123|fc_123"),
      user("still waiting"),
      output("call_123|fc_123", "ok"),
    ]);
    expect(result[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_123",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    expect(result[2]?.role).toBe("user");
  });

  it("normalizes overlong call IDs and malformed item IDs", async () => {
    const rawId = `call_${"x".repeat(120)}|notfc_${"y".repeat(120)}`;
    const result = await sanitize([call(rawId), output(rawId, "ok")]);
    const id = callId(result[0]);
    expect(id).toMatch(/^call_[A-Za-z0-9_-]{1,59}$/);
    expect(result[1]).toMatchObject({ toolCallId: id });
  });

  it("keeps repeated Kimi calls distinct while repairing the incomplete later turn", async () => {
    const first = "functions.gateway:0|fc_tmp_first";
    const second = "functions.gateway:0|fc_tmp_second";
    const result = await sanitize(
      [
        call(first),
        output(first, "first result"),
        user("check again"),
        call(second),
        user("continue"),
      ],
      { provider: "openrouter", modelId: "moonshotai/kimi-k2.5" },
    );
    const firstId = callId(result[0]);
    const secondId = callId(result[3]);
    expect(firstId).toMatch(/^call_[A-Za-z0-9_-]+$/);
    expect(secondId).toMatch(/^call_[A-Za-z0-9_-]+$/);
    expect(secondId).not.toBe(firstId);
    expect(result[1]).toMatchObject({
      role: "toolResult",
      toolCallId: firstId,
      isError: false,
      content: [{ type: "text", text: "first result" }],
    });
    expect(result[4]).toMatchObject({
      role: "toolResult",
      toolCallId: secondId,
      isError: true,
      content: [{ type: "text", text: "aborted" }],
    });
    const roles = result.map(({ role }) => role);
    expect(roles).toEqual(["assistant", "toolResult", "user", "assistant", "toolResult", "user"]);
  });

  it.each(["openai-responses", "openai-chatgpt-responses", "azure-openai-responses"])(
    "preserves paired tool IDs for an unowned provider using %s",
    async (modelApi) => {
      const id = "call_gateway_0|fc_gateway_0";
      const result = await sanitize(
        [
          castAgentMessage({
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "reasoning",
                thinkingSignature: { id: "rs_1", type: "reasoning" },
              },
              { type: "toolCall", id, name: "noop", arguments: {} },
            ],
          }),
          output(id, ""),
        ],
        {
          modelApi,
          provider: "custom-compatible",
          modelId: undefined,
          sessionManager: makeInMemorySessionManager([]),
        },
      );
      expect(callId(result[0])).toBe(id);
      expect(result[1]).toMatchObject({ toolCallId: id });
    },
  );
});

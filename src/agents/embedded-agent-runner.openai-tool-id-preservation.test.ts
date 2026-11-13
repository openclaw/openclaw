import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, expect, it, vi } from "vitest";
import * as history from "./embedded-agent-runner.sanitize-session-history.test-harness.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { textToolResult } from "./test-helpers/sparse-transcript.test-support.js";
import { extractToolCallsFromAssistant } from "./tool-call-id.js";

vi.mock("./embedded-agent-helpers/images.js", async () => ({
  ...(await vi.importActual<typeof import("./embedded-agent-helpers/images.js")>(
    "./embedded-agent-helpers/images.js",
  )),
  ...history.createSanitizeSessionHistoryImagesMock(),
}));

// mock-isolation: replay policy uses the history harness catalog, not the process plugin runtime.
vi.mock(
  "../plugins/provider-runtime.js",
  async () => await history.createSanitizeSessionHistoryProviderRuntimeMock(),
);
// mock-isolation: replay hooks are supplied by the isolated history harness.
vi.mock(
  "../plugins/provider-hook-runtime.js",
  async () =>
    await history.createSanitizeSessionHistoryProviderHookRuntimeMock({
      // Owning plugins suppress transport fallback; defaults already leave IDs untouched.
      resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) =>
        provider === "openai" || provider === "openrouter"
          ? { buildReplayPolicy: () => ({}) }
          : undefined,
      ),
    }),
);

let sanitizeSessionHistory: history.SanitizeSessionHistoryHarness["sanitizeSessionHistory"];

beforeAll(async () => {
  ({ sanitizeSessionHistory } = await history.loadSanitizeSessionHistoryWithCleanMocks());
});

const model = { provider: "openai", modelApi: "openai-responses", modelId: "gpt-5.4" };

const assistant = (message: AgentMessage | undefined) => {
  if (message?.role !== "assistant") {
    throw new Error("Expected an assistant tool call");
  }
  return message;
};
const callId = (message: AgentMessage | undefined) =>
  extractToolCallsFromAssistant(assistant(message))[0]?.id;
const call = (id: string, prefix: unknown[] = []) =>
  castAgentMessage({
    role: "assistant",
    content: [...prefix, { type: "toolCall", id, name: "noop", arguments: {} }],
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
    ...model,
    sessionManager: history.makeInMemorySessionManager([history.makeModelSnapshotEntry(model)]),
    sessionId: "test-session",
    ...overrides,
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
  expect(firstId).toMatch(/^call_[A-Za-z0-9_-]{1,59}\|fc_tmp_first$/);
  expect(secondId).toMatch(/^call_[A-Za-z0-9_-]{1,59}\|fc_tmp_second$/);
  expect(secondId).not.toBe(firstId);
  for (const [index, toolCallId, isError, text] of [
    [1, firstId, false, "first result"],
    [4, secondId, true, "aborted"],
  ] as const) {
    expect(result[index]).toMatchObject({
      role: "toolResult",
      toolCallId,
      isError,
      content: [{ type: "text", text }],
    });
  }
  const roles = result.map(({ role }) => role);
  expect(roles).toEqual(["assistant", "toolResult", "user", "assistant", "toolResult", "user"]);
});

it("preserves paired tool IDs for an unowned Azure Responses provider", async () => {
  const id = "call_gateway_0|fc_gateway_0";
  const result = await sanitize(
    [call(id, assistant(history.makeReasoningAssistantMessages()[0]).content), output(id, "")],
    {
      modelApi: "azure-openai-responses",
      provider: "custom-compatible",
      modelId: undefined,
      sessionManager: history.makeInMemorySessionManager([]),
    },
  );
  expect(callId(result[0])).toBe(id);
  expect(result[1]).toMatchObject({ toolCallId: id });
});

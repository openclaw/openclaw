// Smoke coverage for session-history sanitization policy wiring.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSanitizeSessionHistoryHelpersMock,
  createSanitizeSessionHistoryProviderHookRuntimeMock,
  createSanitizeSessionHistoryProviderRuntimeMock,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeMockSessionManager,
  type SanitizeSessionHistoryHarness,
} from "./embedded-agent-runner.sanitize-session-history.test-harness.js";

vi.mock("./embedded-agent-helpers.js", async () => await createSanitizeSessionHistoryHelpersMock());

// Provider runtime mocks keep this file focused on high-level policy routing
// while deeper replay-history behavior is covered in the main test suite.
vi.mock(
  "../plugins/provider-runtime.js",
  async () => await createSanitizeSessionHistoryProviderRuntimeMock(),
);
vi.mock(
  "../plugins/provider-hook-runtime.js",
  async () => await createSanitizeSessionHistoryProviderHookRuntimeMock(),
);

let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];
let mockedHelpers: SanitizeSessionHistoryHarness["mockedHelpers"];

describe("sanitizeSessionHistory e2e smoke", () => {
  const mockSessionManager = makeMockSessionManager();

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    sanitizeSessionHistory = harness.sanitizeSessionHistory;
    mockedHelpers = harness.mockedHelpers;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
  });

  it.each(["openai-responses", "openai-chatgpt-responses", "azure-openai-responses"])(
    "preserves paired tool-call ids for an unowned %s provider",
    async (modelApi) => {
      const id = "call_gateway_0|fc_gateway_0";
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "reasoning",
              thinkingSignature: { id: "rs_1", type: "reasoning" },
            },
            { type: "toolCall", id, name: "gateway", arguments: {} },
          ],
        },
        { role: "toolResult", toolCallId: id, toolName: "gateway", content: [], isError: false },
      ] as Parameters<typeof sanitizeSessionHistory>[0]["messages"];

      const result = await sanitizeSessionHistory({
        messages,
        modelApi,
        provider: "custom-compatible",
        sessionManager: mockSessionManager,
        sessionId: "test-session",
      });

      const assistant = result[0] as { content: Array<{ type: string; id?: string }> };
      expect(assistant.content.find((block) => block.type === "toolCall")?.id).toBe(id);
      expect((result[1] as { toolCallId: string }).toolCallId).toBe(id);
    },
  );
});

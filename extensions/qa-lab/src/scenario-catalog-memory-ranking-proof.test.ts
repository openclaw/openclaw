import path from "node:path";
import { expect, it, vi } from "vitest";
import { nestedToolHistoryFixture } from "../test/nested-tool-activity-fixture.js";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const searchCallId = "call-session-memory-ranking";
const currentQuestionResult = { source: "sessions", snippet: "Project Nebula codename?" };
const currentSessionResult = { source: "sessions", snippet: "Project Nebula: ORBIT-10." };
const staleDurableResult = { source: "memory", snippet: "Project Nebula: ORBIT-9." };

async function runRanking(
  params: {
    results?: (typeof currentSessionResult)[];
    providerMode?: "mock-openai" | "live-frontier";
  } = {},
) {
  const state = createQaBusState();
  const results = params.results ?? [currentSessionResult, staleDurableResult];
  const providerMode = params.providerMode ?? "mock-openai";
  const plannedToolArgs = { query: "current Project Nebula codename", maxResults: 6 };
  const directHistoryMessages = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: searchCallId, name: "memory_search", arguments: plannedToolArgs },
      ],
    },
    {
      role: "toolResult",
      toolCallId: searchCallId,
      toolName: "memory_search",
      isError: false,
      content: [{ type: "text", text: JSON.stringify({ results }) }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "The current Project Nebula codename is ORBIT-10." }],
    },
  ];
  const historyMessages =
    providerMode === "live-frontier"
      ? [
          nestedToolHistoryFixture({
            toolName: "memory_search",
            toolCallId: searchCallId,
            input: plannedToolArgs,
            text: JSON.stringify({ results }),
          }),
        ]
      : directHistoryMessages;
  const gatewayCall = vi.fn(
    async (method: string, request: { sessionKey?: string; limit?: number }) => {
      expect(method).toBe("chat.history");
      expect(request.sessionKey).toBe("agent:qa:session-memory-ranking");
      return { messages: historyMessages };
    },
  );
  const fetchJson = vi.fn(async (input: string) => {
    throw new Error(`unexpected QA mock request: ${input}`);
  });
  const runAgentPrompt = vi.fn(async (_env: unknown, options: { message: string }) => {
    expect(options.message).not.toContain("ORBIT-10");
    state.addOutboundMessage({
      accountId: "qa-channel",
      to: "dm:qa-operator",
      text: "The current Project Nebula codename is ORBIT-10.",
    });
  });

  const noop = async () => undefined;
  await runLoadedScenarioFlow("session-memory-ranking", {
    state,
    api: {
      env: {
        providerMode,
        gateway: { workspaceDir: "/qa/workspace", call: gatewayCall },
        ...(providerMode === "mock-openai" ? { mock: { baseUrl: "http://qa.mock" } } : {}),
      },
      path,
      fs: { mkdir: noop, writeFile: noop, utimes: noop },
      readConfigSnapshot: async () => ({ config: {} }),
      patchConfig: noop,
      seedQaSessionTranscript: noop,
      forceMemoryIndex: noop,
      runAgentPrompt,
      fetchJson,
    },
  });

  return { fetchJson, gatewayCall, runAgentPrompt };
}

it("requires successful provider-independent persisted search evidence", async () => {
  const { fetchJson, gatewayCall, runAgentPrompt } = await runRanking({
    providerMode: "live-frontier",
  });

  expect(runAgentPrompt).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      transcriptToolName: "memory_search",
      requireSuccessfulTranscriptToolResult: true,
    }),
  );
  expect(gatewayCall).toHaveBeenCalledWith(
    "chat.history",
    expect.objectContaining({ sessionKey: "agent:qa:session-memory-ranking" }),
    expect.anything(),
  );
  expect(fetchJson).not.toHaveBeenCalled();
});

it("rejects stale facts ahead of current facts even when the current question ranks first", async () => {
  await expect(
    runRanking({
      results: [currentQuestionResult, staleDurableResult, currentSessionResult],
    }),
  ).rejects.toThrow(/rank|stale|durable/i);
});

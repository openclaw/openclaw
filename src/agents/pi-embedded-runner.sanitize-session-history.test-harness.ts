import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { expect, vi } from "vitest";
import * as helpers from "./pi-embedded-helpers.js";

export type SessionEntry = { type: string; customType: string; data: unknown };
export type SanitizeSessionHistoryFn = (params: {
  messages: AgentMessage[];
  modelApi: string;
  provider: string;
  allowedToolNames?: Iterable<string>;
  sessionManager: SessionManager;
  sessionId: string;
  modelId?: string;
}) => Promise<AgentMessage[]>;
export const TEST_SESSION_ID = "test-session";

export function makeModelSnapshotEntry(data: {
  timestamp?: number;
  provider: string;
  modelApi: string;
  modelId: string;
}): SessionEntry {
  return {
    type: "custom",
    customType: "model-snapshot",
    data: {
      timestamp: data.timestamp ?? Date.now(),
      provider: data.provider,
      modelApi: data.modelApi,
      modelId: data.modelId,
    },
  };
}

export function makeInMemorySessionManager(entries: SessionEntry[]): SessionManager {
  return {
    getEntries: vi.fn(() => entries),
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
  } as unknown as SessionManager;
}

export function makeMockSessionManager(): SessionManager {
  return {
    getEntries: vi.fn().mockReturnValue([]),
    appendCustomEntry: vi.fn(),
  } as unknown as SessionManager;
}

export function makeSimpleUserMessages(): AgentMessage[] {
  const messages = [{ role: "user", content: "hello" }];
  return messages as unknown as AgentMessage[];
}

export async function loadSanitizeSessionHistoryWithCleanMocks(): Promise<SanitizeSessionHistoryFn> {
  vi.resetAllMocks();
  vi.mocked(helpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
  const mod = await import("./pi-embedded-runner/google.js");
  return mod.sanitizeSessionHistory;
}

export function makeReasoningAssistantMessages(opts?: {
  thinkingSignature?: "object" | "json";
}): AgentMessage[] {
  const thinkingSignature: unknown =
    opts?.thinkingSignature === "json"
      ? JSON.stringify({ id: "rs_test", type: "reasoning" })
      : { id: "rs_test", type: "reasoning" };

  // Intentional: we want to build message payloads that can carry non-string
  // signatures, but core typing currently expects a string.
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "reasoning",
          thinkingSignature,
        },
      ],
    },
  ];

  return messages as unknown as AgentMessage[];
}

export async function sanitizeWithOpenAIResponses(params: {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
  messages: AgentMessage[];
  sessionManager: SessionManager;
  modelId?: string;
}) {
  return await params.sanitizeSessionHistory({
    messages: params.messages,
    modelApi: "openai-responses",
    provider: "openai",
    sessionManager: params.sessionManager,
    modelId: params.modelId,
    sessionId: TEST_SESSION_ID,
  });
}

export function expectOpenAIResponsesStrictSanitizeCall(
  sanitizeSessionMessagesImagesMock: unknown,
  messages: AgentMessage[],
) {
  expect(sanitizeSessionMessagesImagesMock).toHaveBeenCalledWith(
    messages,
    "session:history",
    expect.objectContaining({
      sanitizeMode: "images-only",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    }),
  );
}

export async function expectGoogleModelApiFullSanitizeCall(params: {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
  messages: AgentMessage[];
  sessionManager: SessionManager;
}) {
  vi.mocked(helpers.isGoogleModelApi).mockReturnValue(true);
  await params.sanitizeSessionHistory({
    messages: params.messages,
    modelApi: "google-generative-ai",
    provider: "google-vertex",
    sessionManager: params.sessionManager,
    sessionId: TEST_SESSION_ID,
  });
  expect(helpers.sanitizeSessionMessagesImages).toHaveBeenCalledWith(
    params.messages,
    "session:history",
    expect.objectContaining({ sanitizeMode: "full", sanitizeToolCallIds: true }),
  );
}

export function makeSnapshotChangedOpenAIReasoningScenario() {
  const sessionEntries = [
    makeModelSnapshotEntry({
      provider: "anthropic",
      modelApi: "anthropic-messages",
      modelId: "claude-3-7",
    }),
  ];
  return {
    sessionManager: makeInMemorySessionManager(sessionEntries),
    messages: makeReasoningAssistantMessages({ thinkingSignature: "object" }),
    modelId: "gpt-5.2-codex",
  };
}

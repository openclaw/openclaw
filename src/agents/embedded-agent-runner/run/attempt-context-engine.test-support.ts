import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { ContextEngine } from "../../../context-engine/types.js";
import { clearMemoryPluginState } from "../../../plugins/memory-state.test-fixtures.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

export type ContextEngineAttemptOptions = Parameters<typeof createContextEngineAttemptRunner>[0];

export const contextEngineInfo = {
  id: "test-context-engine",
  name: "Test Context Engine",
  version: "0.0.1",
};

export function createTestContextEngine(params: Partial<ContextEngine>): ContextEngine {
  return {
    info: { ...contextEngineInfo },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({
      ok: false,
      compacted: false,
      reason: "not used in this test",
    }),
    ...params,
  } as ContextEngine;
}

export type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

export const requireRecord = createRequireRecord("object", "expected-label");

export function requireRecords(value: unknown, label: string): Array<Record<string, unknown>> {
  expect(value, label).toBeInstanceOf(Array);
  return value as Array<Record<string, unknown>>;
}

export function findRecord(
  records: Array<Record<string, unknown>>,
  predicate: (record: Record<string, unknown>) => boolean,
  label: string,
) {
  const record = records.find(predicate);
  if (!record) {
    throw new Error(`expected record: ${label}`);
  }
  return record;
}

export function runtimeContextMessage(messages: unknown) {
  return findRecord(
    requireRecords(messages, "seen messages"),
    (message) => message.customType === "openclaw.runtime-context",
    "runtime context message",
  );
}

export function mockParams(source: MockCallSource) {
  return requireRecord(source.mock.calls[0]?.[0], "mock params");
}

export function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key], key).toEqual(value);
  }
}

export function completedStream(message: unknown) {
  return { result: async () => message, [Symbol.asyncIterator]: () => (async function* () {})() };
}

export function useContextEngineAttemptHarness(sessionKey: string) {
  const hoisted = getHoisted();
  const tempPaths: string[] = [];
  const suiteTempPaths: string[] = [];
  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    clearMemoryPluginState();
    hoisted.detectAndLoadPromptImagesMock.mockClear();
  });
  afterEach(() => {
    suiteTempPaths.push(...tempPaths.splice(0));
    clearMemoryPluginState();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await cleanupTempPaths(suiteTempPaths);
  });
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });
  return {
    hoisted,
    tempPaths,
    runAttempt: (
      options: Omit<ContextEngineAttemptOptions, "sessionKey" | "tempPaths" | "contextEngine"> &
        Partial<Pick<ContextEngineAttemptOptions, "contextEngine" | "sessionKey">> = {},
    ) =>
      createContextEngineAttemptRunner({
        sessionKey,
        tempPaths,
        contextEngine: createContextEngineBootstrapAndAssemble(),
        ...options,
      }),
  };
}

export function signedAssistant(
  thinking: string,
  thinkingSignature: string,
  text: string,
  timestamp: number,
) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking, thinkingSignature },
      { type: "text", text },
    ],
    stopReason: "stop",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    timestamp,
  } as AgentMessage;
}

export const doneMessage = {
  role: "assistant",
  content: "done",
  timestamp: 2,
} as unknown as AgentMessage;

export function capturePrompt(
  transform: boolean | "preprocessed" = false,
  assistant: unknown = doneMessage,
  preprocessedPrompt?: string,
) {
  const seen: {
    prompt?: string;
    messages?: unknown[];
    modelMessages?: unknown[];
    systemPrompt?: string;
  } = {};
  const sessionPrompt: NonNullable<ContextEngineAttemptOptions["sessionPrompt"]> = async (
    session,
    prompt,
  ) => {
    seen.prompt = prompt;
    seen.messages = [...session.messages];
    seen.systemPrompt = session.agent.state.systemPrompt;
    if (transform) {
      const transformContext = (
        session.agent as {
          transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
        }
      ).transformContext;
      const messages = await transformContext?.([
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                transform === "preprocessed"
                  ? `session preprocessed\n\n${preprocessedPrompt ?? prompt}`
                  : prompt,
            },
          ],
          timestamp: 1,
        },
      ]);
      const { normalizeMessagesForLlmBoundary } = await import("./attempt-llm-boundary.js");
      seen.modelMessages = messages && normalizeMessagesForLlmBoundary(messages);
    }
    session.messages = [...session.messages, assistant];
  };
  return { seen, sessionPrompt };
}

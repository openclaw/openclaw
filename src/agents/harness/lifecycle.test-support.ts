import { setImmediate } from "node:timers/promises";
import type { Model } from "openclaw/plugin-sdk/llm";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventMetadata as Metadata,
  type DiagnosticEventPayload as Payload,
  type DiagnosticEventPrivateData as PrivateData,
} from "../../infra/diagnostic-events.js";
import type { DiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import type {
  AgentHarness,
  AgentHarnessAttemptParamsV2 as AttemptParams,
  AgentHarnessSettledTurnFinalizationAttemptParams as SettledParams,
} from "./types.js";

export const createLifecycleHarness = (overrides: Partial<AgentHarness> = {}): AgentHarness => ({
  id: "codex",
  label: "Codex",
  supports: () => ({ supported: true }),
  runAttempt: async () => createAttemptResult(),
  ...overrides,
});

export const createBaseAttemptParams = () => ({
  prompt: "hello",
  sessionId: "session-1",
  runId: "run-1",
  sessionFile: "/tmp/session.jsonl",
  workspaceDir: "/tmp/workspace",
  timeoutMs: 5_000,
  provider: "codex",
  modelId: "gpt-5.4",
  model: { id: "gpt-5.4", provider: "codex" } as Model,
  authStorage: {} as never,
  authProfileStore: { version: 1, profiles: {} },
  modelRegistry: {} as never,
  thinkLevel: "low" as const,
});

export const createAttemptParams = (): AttemptParams =>
  createFinalizationParams() as unknown as AttemptParams;

export const createFinalizationParams = (): SettledParams<AttemptParams> =>
  Object.assign(createBaseAttemptParams(), {
    sessionKey: "session-key",
    messageChannel: "qa",
    trigger: "manual" as const,
  });

export function createDiagnosticTrace(): DiagnosticTraceContext {
  return { traceId: "1".repeat(32), spanId: "2".repeat(16), traceFlags: "01" };
}

export const createFinalAssistant = () =>
  makeAgentAssistantMessage({
    content: [{ type: "text", text: "done" }],
    model: "gpt-5.5",
  });

export const createAttemptResult = (): EmbeddedRunAttemptResult => ({
  terminal: { kind: "ok" },
  sessionIdUsed: "session-1",
  diagnosticTrace: createDiagnosticTrace(),
  messagesSnapshot: [],
  assistantTexts: ["ok"],
  toolMetas: [],
  lastAssistant: undefined,
  didSendViaMessagingTool: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
  cloudCodeAssistFormatError: false,
  replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
});

export const flushDiagnosticEvents = setImmediate;

export function captureDiagnosticEvents(
  filter: (event: Payload) => boolean = (event) => event.type.startsWith("harness.run."),
) {
  const events: Array<{ event: Payload; metadata: Metadata; privateData: PrivateData }> = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
    if (filter(event)) {
      events.push({ event, metadata, privateData });
    }
  });
  return { events, unsubscribe };
}

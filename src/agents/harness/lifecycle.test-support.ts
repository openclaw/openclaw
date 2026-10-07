// Shared fixtures for the harness lifecycle tests.
import type { Model } from "openclaw/plugin-sdk/llm";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../../infra/diagnostic-events.js";
import type { DiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import type {
  AgentHarnessAttemptParamsV2,
  AgentHarnessSettledTurnFinalizationAttemptParams,
} from "./types.js";

export function createAttemptParams(): AgentHarnessAttemptParamsV2 {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "session-key",
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
    thinkLevel: "low",
    messageChannel: "qa",
    trigger: "manual",
  } as unknown as AgentHarnessAttemptParamsV2;
}

export function createFinalizationParams(): AgentHarnessSettledTurnFinalizationAttemptParams<AgentHarnessAttemptParamsV2> {
  const { hostCapabilities: _hostCapabilities, ...params } = createAttemptParams();
  return params;
}

export function createDiagnosticTrace(): DiagnosticTraceContext {
  return {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: "01",
  };
}

export function createFinalAssistant(): NonNullable<EmbeddedRunAttemptResult["lastAssistant"]> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: 0,
  };
}

export function createAttemptResult(): EmbeddedRunAttemptResult {
  return {
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
  };
}

export async function flushDiagnosticEvents(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function captureDiagnosticEvents(
  filter: (event: DiagnosticEventPayload) => boolean = (event) =>
    event.type.startsWith("harness.run."),
): {
  events: Array<{
    event: DiagnosticEventPayload;
    metadata: DiagnosticEventMetadata;
    privateData: DiagnosticEventPrivateData;
  }>;
  unsubscribe: () => void;
} {
  const events: Array<{
    event: DiagnosticEventPayload;
    metadata: DiagnosticEventMetadata;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
    if (filter(event)) {
      events.push({ event, metadata, privateData });
    }
  });
  return { events, unsubscribe };
}

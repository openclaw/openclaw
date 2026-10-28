import { vi } from "vitest";
import type { AssistantMessage } from "../../../llm/types.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { handleEmbeddedAssistantFailure } from "./assistant-failure.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";

export type AssistantFailureInput = Parameters<typeof handleEmbeddedAssistantFailure>[0];

export function makeAssistantFailureInput(
  overrides: Partial<AssistantMessage>,
  options: {
    terminal?: AgentRunAttemptTerminal;
    fallbackConfigured?: boolean;
    profileId?: string;
  } = {},
): AssistantFailureInput & { normalizedAttempt: { attemptAssistant: AssistantMessage } } {
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "anthropic",
    model: "test-model",
    stopReason: "error",
    content: [{ type: "text", text: "Partial answer" }],
    ...overrides,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: options.terminal ?? { kind: "ok" },
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
  const { provider, model } = assistant;
  return {
    runInput: {
      runParams: {
        sessionId: "session:assistant-failover",
        sessionFile: "/tmp/openclaw-assistant-failover-test/session.jsonl",
        runId: "run:assistant-failover",
        workspaceDir: "/tmp/openclaw-assistant-failover-test",
        prompt: "Respond to the user",
        timeoutMs: 60_000,
      },
      fallbackConfigured: options.fallbackConfigured ?? true,
      suspendForFailure: vi.fn(),
      agentDir: "/tmp/openclaw-assistant-failover-test",
      isProbeSession: false,
    },
    normalizedAttempt: {
      attempt,
      attemptAssistant: assistant,
      currentAttemptAssistant: assistant,
      terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
      activeErrorContext: { provider, model },
    },
    preparedRuntime: {
      provider,
      modelId: model,
      model: { id: model },
      attemptedThinking: new Set(["high"]),
      attemptAuthProfileStore: { version: 1, profiles: {} },
      maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    },
    runtime: {
      thinkLevel: "high",
      lastProfileId: options.profileId,
      pluginHarnessOwnsTransport: false,
    },
    providerOwner: undefined,
    getThinkLevel: () => "low",
    runtimeAuthRetry: false,
    failover: {
      resolveAuthProfileFailureReason: vi.fn(() => null),
      maybeMarkAuthProfileFailure: vi.fn(async () => {}),
      advanceAuthProfile: vi.fn(async () => false),
      transientRetryCount: 0,
      overloadProfileRotationLimit: 3,
    },
    emptyErrorRetries: 0,
    overloadProfileRotations: 0,
    previousRetryFailoverReason: null,
    traceAttempts: [],
    suspensionSessionId: "session:assistant-failover",
  };
}

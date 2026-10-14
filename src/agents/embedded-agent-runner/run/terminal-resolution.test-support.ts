import { expect, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveCurrentAttemptAssistant } from "./attempt-terminal-evidence.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./terminal-outcome.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

export type TerminalInput = Parameters<typeof resolveEmbeddedRunTerminal>[0] &
  Partial<Parameters<typeof resolveEmbeddedRunTerminal>[0]["prepared"]>;
type TerminalInputOverrides = Omit<
  Partial<TerminalInput>,
  "runParams" | "retryState" | "sessionPromptState"
> & {
  runParams?: Partial<TerminalInput["runParams"]>;
  retryState?: Partial<TerminalInput["retryState"]>;
  sessionPromptState?: Partial<TerminalInput["sessionPromptState"]>;
};

export function emptyAssistant(overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {}) {
  return buildEmbeddedRunnerAssistant({
    content: [{ type: "text", text: "" }],
    ...overrides,
  });
}

export function makeTerminalInput(overrides: TerminalInputOverrides = {}): TerminalInput {
  const assistant = overrides.attemptAssistant ?? emptyAssistant();
  const attempt =
    overrides.attempt ??
    makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
  const profileStore = { version: 1, profiles: {} };
  const runParams = {
    sessionId: "session:terminal-resolution",
    sessionKey: "agent:main:terminal-resolution",
    runId: "run:terminal-resolution",
    agentDir: "/tmp/openclaw-terminal-resolution",
    workspaceDir: "/tmp/openclaw-terminal-resolution",
    prompt: "Finish the current turn.",
    timeoutMs: 1_000,
    ...overrides.runParams,
  } satisfies TerminalInput["runParams"];
  const base = {
    runParams,
    attempt,
    attemptAssistant: resolveCurrentAttemptAssistant(attempt),
    activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
    modelApi: "openai-responses",
    executionContract: undefined,
    terminalState: resolveEmbeddedRunAttemptTerminalState({
      attempt,
      assistant: resolveCurrentAttemptAssistant(attempt),
    }),
    payloadsWithToolMedia: [],
    recoveredFinalAssistantPayloadsAfterPromptTimeout: undefined,
    finalAssistantVisibleText: undefined,
    finalAssistantRawText: undefined,
    agentMeta: {
      sessionId: runParams.sessionId,
      provider: "openai",
      model: "gpt-5.6-luna",
    },
    attemptToolSummary: undefined,
    failureSignal: undefined,
    attemptCompactionCount: 0,
    replayState: { ...attempt.replayMetadata, replayInvalid: false },
    sessionPromptState: {
      activePrompt: { persisted: true, internal: false },
      suppressNextUserMessagePersistence: false,
      activateInternalPrompt: vi.fn(),
      markOwnedTranscriptRetry: vi.fn(),
      activateCompactionContinuation: vi.fn(),
      clearCompactionContinuation: vi.fn(),
    },
    armPostCompactionGuard: vi.fn(),
    readTerminalToolPresentation: () => undefined,
    resolveReplayInvalid: () => false,
    setTerminalLifecycleMeta: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(async () => undefined),
    assistantProfileFailureReason: null,
    startedAtMs: Date.now(),
    provider: "openai",
    modelId: "gpt-5.6-luna",
    modelTransportId: "gpt-5.6-luna",
    modelTransportApi: "openai-responses",
    requestTransportOverrides: "none",
    authProfileId: undefined,
    profileFailureStore: profileStore,
    attemptAuthProfileStore: profileStore,
    apiKeyInfo: null,
    agentHarnessId: "builtin-openclaw",
    settledTurnFinalizationOutcome: "not-attempted",
    pluginHarnessOwnsTransport: false,
    pluginHarnessOwnsAuthBootstrap: false,
    reportedModelRef: { provider: "openai", model: "gpt-5.6-luna" },
    traceAttempts: [],
    thinkLevel: "off",
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
  } satisfies Omit<TerminalInput, "retryState" | "prepared">;
  return {
    ...base,
    ...overrides,
    prepared: {
      payloads: [],
      replyDeliveryState: "missing",
      timedOutDuringPrompt: false,
      hasSuccessfulFinalAssistantAfterPromptTimeout: false,
      hasPartialAssistantTextAfterPromptTimeout: false,
      terminalToolFailure: undefined,
      ...base,
      ...overrides,
      ...overrides.prepared,
    },
    runParams,
    sessionPromptState: { ...base.sessionPromptState, ...overrides.sessionPromptState },
    retryState: { ...createEmbeddedRunTerminalRetryState(), ...overrides.retryState },
  };
}

export async function resolveTerminalText(
  overrides: TerminalInputOverrides,
): Promise<string | undefined> {
  const resolved = await resolveEmbeddedRunTerminal(makeTerminalInput(overrides));
  expect(resolved.action).toBe("complete");
  if (resolved.action !== "complete") {
    throw new Error("expected terminal resolution to complete");
  }
  return resolved.result.payloads?.[0]?.text;
}

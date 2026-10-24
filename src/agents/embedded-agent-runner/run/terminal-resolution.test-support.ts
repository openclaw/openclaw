import { expect, vi } from "vitest";
import { resolveRawAssistantAnswerText } from "../../../shared/assistant-answer-text.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
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
  assistant?: Parameters<typeof assistantAttempt>[0];
  attemptOverrides?: Parameters<typeof assistantAttempt>[1];
};

export function emptyAssistant(overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {}) {
  return textAssistant("", overrides);
}

export function textAssistant(
  text: string,
  overrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {},
) {
  return buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }], ...overrides });
}

export function assistantAttempt(
  assistant: ReturnType<typeof buildEmbeddedRunnerAssistant> | undefined,
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
) {
  return makeEmbeddedRunnerAttempt({
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    ...overrides,
  });
}

type Resolution = Awaited<ReturnType<typeof resolveEmbeddedRunTerminal>>;
export function expectComplete(
  result: Resolution,
): asserts result is Extract<Resolution, { action: "complete" }> {
  expect(result.action).toBe("complete");
  if (result.action !== "complete") {
    throw new Error("expected terminal resolution to complete");
  }
}

export function makeTerminalInput(input: TerminalInputOverrides = {}): TerminalInput {
  const { assistant: suppliedAssistant, attemptOverrides, ...overrides } = input;
  const assistant = suppliedAssistant ?? overrides.attemptAssistant ?? emptyAssistant();
  const attempt =
    overrides.attempt ??
    ("assistant" in input
      ? assistantAttempt(suppliedAssistant, attemptOverrides)
      : makeEmbeddedRunnerAttempt({
          lastAssistant: assistant,
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        }));
  const profileStore = { version: 1, profiles: {} };
  const runParams = {
    sessionId: "session:terminal-resolution",
    sessionKey: "agent:main:terminal-resolution",
    runId: "run:terminal-resolution",
    messageChannel: "telegram",
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
    agentMeta: { sessionId: runParams.sessionId, provider: "openai", model: "gpt-5.6-luna" },
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
      recoveredFinalAssistantPayloadsAfterPromptTimeout: undefined,
      finalAssistantRawText: undefined,
      attemptToolSummary: undefined,
      failureSignal: undefined,
      replyDeliveryState: "missing",
      sourceReplyDeliveryState: "missing",
      timedOutDuringPrompt: false,
      hasSuccessfulFinalAssistantAfterPromptTimeout: false,
      hasPartialAssistantTextAfterPromptTimeout: false,
      finalAssistantMessageRawText: undefined,
      terminalToolFailure: undefined,
      preparedTerminalReply:
        attempt.preparedTerminalReply ??
        prepareAgentRunTerminalReply({
          rawText:
            overrides.finalAssistantRawText ??
            overrides.finalAssistantVisibleText ??
            resolveRawAssistantAnswerText(resolveCurrentAttemptAssistant(attempt)),
        }),
      ...base,
      ...overrides,
      ...overrides.prepared,
      payloadsForVisibleCompletion:
        overrides.prepared?.payloadsForVisibleCompletion ??
        overrides.payloadsForVisibleCompletion ??
        overrides.payloadsWithToolMedia ??
        [],
      finalAssistantVisibleText:
        overrides.prepared?.finalAssistantVisibleText ?? overrides.finalAssistantVisibleText ?? "",
    },
    runParams,
    sessionPromptState: { ...base.sessionPromptState, ...overrides.sessionPromptState },
    retryState: { ...createEmbeddedRunTerminalRetryState(), ...overrides.retryState },
  };
}

export function resolveTerminal(overrides: TerminalInputOverrides) {
  return resolveEmbeddedRunTerminal(makeTerminalInput(overrides));
}

export async function resolveTerminalText(overrides: TerminalInputOverrides) {
  const resolved = await resolveTerminal(overrides);
  expectComplete(resolved);
  return resolved.result.payloads?.[0]?.text;
}

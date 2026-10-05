import "../../../test-utils/prepare-compiled-subprocesses.js";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import type { Context, Model } from "../../../llm/types.js";
import {
  annotateInterSessionPromptText,
  type InputProvenance,
} from "../../../sessions/input-provenance.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { sanitizeSessionHistory } from "../replay-history.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import { forgetPromptBuildDrainCacheForRun } from "./attempt-prompt-helpers.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

registerAgentSessionLoopTestLifecycle();

const originalBody = "PREFIX_PROOF_ORIGINAL_BODY: inspect the synthetic handoff.";
const model: Model<"anthropic-messages"> = {
  ...testModel,
  api: "anthropic-messages",
  provider: "anthropic",
  id: "claude-opus-4-6",
  // A failed abort cannot contact a vendor endpoint.
  baseUrl: "http://127.0.0.1:1",
};
const lookup = {
  name: "lookup",
  label: "Lookup",
  description: "Read one synthetic fixture value.",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text" as const, text: "SYNTHETIC_LOOKUP_RESULT" }],
    details: {},
  }),
};

async function convertThroughPublicAnthropic(context: Context) {
  const abort = new AbortController();
  let payload: unknown;
  const stream = streamAnthropic(model, context, {
    apiKey: "synthetic-prefix-proof-key",
    cacheRetention: "short",
    signal: abort.signal,
    onPayload: (value) => {
      payload = structuredClone(value);
      abort.abort(new Error("builder capture completed"));
    },
  });
  await stream.result();
  // This is the builder/pre-final-contract view, not completed provider proof.
  return expectDefined(payload, "Anthropic public-hook payload");
}

async function submitRealTurn(input: {
  fixture: Awaited<ReturnType<typeof createTestSession>>;
  manager: SessionManager;
  runId: string;
  body: string;
  timestamp: number;
  workspaceDir: string;
  provenance?: InputProvenance;
}) {
  const canonicalText = input.provenance
    ? annotateInterSessionPromptText(input.body, input.provenance)
    : input.body;
  const message = {
    role: "user" as const,
    content: canonicalText,
    timestamp: input.timestamp,
    idempotencyKey: input.runId,
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
  // The session guard records this prepared user from its actual append receipt.
  const recorder = createUserTurnTranscriptRecorder({
    message,
    target: async () => undefined,
  });
  const manager = guardSessionManager(input.manager, {
    agentId: "main",
    runId: input.runId,
    sessionKey: "agent:main:prefix-proof",
    config: {},
    inputProvenance: input.provenance,
    preparedUserTurnMessage: message,
    preparedUserTurnTranscriptRecorder: recorder,
  });
  const admission = prepareSystemAgentRunAdmission({}, input.runId, "main", input.workspaceDir);
  onTestFinished(() => {
    admission.close();
    forgetPromptBuildDrainCacheForRun(input.runId);
    clearEmbeddedSessionPromptStates(["prefix-proof"]);
  });
  const attempt: EmbeddedRunAttemptParams = {
    admittedRunContext: await admission.admit("embedded"),
    authStorage: input.fixture.modelRegistry.authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: input.fixture.modelRegistry,
    config: {},
    model,
    modelId: model.id,
    provider: model.provider,
    thinkLevel: "off",
    prompt: canonicalText,
    transcriptPrompt: canonicalText,
    inputProvenance: input.provenance,
    userTurnTranscriptRecorder: recorder,
    runId: input.runId,
    sessionId: "prefix-proof",
    sessionKey: "agent:main:prefix-proof",
    sessionFile: "",
    sessionPersistence: "detached",
    trigger: "user",
    timeoutMs: 10_000,
    workspaceDir: input.workspaceDir,
  };
  const policy = resolveTranscriptPolicy({
    config: {},
    provider: model.provider,
    modelId: model.id,
    modelApi: model.api,
    model,
    directApiKey: true,
  });
  const systemPrompt = "A synthetic fixture assistant with one harmless lookup tool.";
  const session = input.fixture.session;
  const boundary = await prepareEmbeddedAttemptSessionBoundary({
    activeSession: session,
    attempt,
    preparedUserTurnMessage: message,
    sessionManager: manager,
    appendOnlyRuntimeContext: policy.appendOnlyRuntimeContext,
    inHistorySystemUpdates: policy.inHistorySystemUpdates,
    getUserTranscriptContexts: () => undefined,
    isRawModelRun: false,
    setActiveSessionSystemPrompt: (text) => session.setBaseSystemPrompt(text),
  });
  const assembly = await prepareEmbeddedAttemptPromptAssembly({
    attempt,
    activeSession: session,
    sessionManager: manager,
    hookRunner: null,
    hookAgentId: "main",
    diagnosticTrace: { traceId: "11111111111111111111111111111111" },
    isRawModelRun: false,
    sessionAgentId: "main",
    runtimeModel: model.id,
    systemPromptText: systemPrompt,
    runAbortSignal: new AbortController().signal,
    applyPromptBuildToolsAllow: () => ["lookup"],
    setActiveSessionSystemPrompt: (text) => session.setBaseSystemPrompt(text),
    setLeasedSteering: () => {},
  });
  const promptState = getEmbeddedSessionPromptState(attempt.sessionId);
  const context = await prepareEmbeddedAttemptPromptContext({
    attempt,
    prompt: assembly,
    messages: session.messages,
    preparedUserTurnMessage: message,
    sessionVersion: manager.getHeader()?.version,
    capabilityToolNames: new Set(["lookup"]),
    boundaryTimezone: boundary.boundaryTimezone,
    includeBoundaryTimestamp: boundary.includeBoundaryTimestamp,
    appendOnlyRuntimeContext: policy.appendOnlyRuntimeContext,
    inHistorySystemUpdates: policy.inHistorySystemUpdates,
    isRawModelRun: false,
    replaceSessionMessages: (messages) => {
      session.agent.state.messages = messages;
    },
    sessionAgentId: "main",
    systemPromptText: systemPrompt,
    toolResultPromptProjectionState: promptState.toolResults,
  });
  boundary.setCurrentUserTimestampOverride(context.currentUserTimestampOverride);
  await submitEmbeddedAttemptPrompt({
    attempt,
    activeSession: session,
    transcriptPrompt: context.promptForSession,
    modelPrompt: context.promptForModel,
    runtimeContextMessage: context.runtimeContextMessageForCurrentTurn,
    appendOnlyRuntimeContext: policy.appendOnlyRuntimeContext,
    appendContext: assembly.promptBuildAppendContext,
    prependContext: assembly.promptBuildPrependContext,
    runtimeOnly: context.promptSubmission.runtimeOnly === true,
    contextTokenBudget: context.contextTokenBudget,
    images: [],
    systemPrompt: session.systemPrompt,
    toolResultAggregateMaxChars: context.promptToolResultAggregateMaxChars,
    toolResultMaxChars: context.promptToolResultMaxChars,
    toolResultPromptProjectionState: promptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: assembly.transcriptLeafId,
    leasedSteering: assembly.leasedSteering,
    onFinalPromptText: () => {},
    onSteeringAcknowledged: () => {},
    assertHostActive: assembly.assertHostActive,
    persistToolResultProjections: async () => {},
    promptActiveSession: (text, options) => session.prompt(text, options),
  });
}

function originalUserText(payload: unknown): string {
  const messages = asOptionalObjectRecord(payload)?.messages;
  if (!Array.isArray(messages)) {
    throw new Error("Expected an Anthropic messages request");
  }
  const entries: readonly unknown[] = messages;
  const matches: string[] = [];
  for (const entry of entries) {
    const message = asOptionalObjectRecord(entry);
    const content = message?.content;
    if (message?.role !== "user") {
      continue;
    }
    if (typeof content === "string") {
      if (content.includes(originalBody)) {
        matches.push(content);
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const blocks: readonly unknown[] = content;
    for (const item of blocks) {
      const block = asOptionalObjectRecord(item);
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.includes(originalBody)
      ) {
        matches.push(block.text);
      }
    }
  }
  expect(matches).toHaveLength(1);
  return expectDefined(matches[0], "unique original user payload");
}

for (const interSession of [true, false]) {
  it(`preserves prior user bytes across active/tool/replay (inter-session=${interSession})`, async () => {
    await withOpenClawTestState({ label: "prompt-replay-prefix-proof" }, async (state) => {
      const contexts: Context[] = [];
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        contexts.push({
          ...context,
          messages: structuredClone(context.messages),
          tools: context.tools?.slice(),
        });
        return createAssistantResultStream(
          createAssistant(
            activeModel,
            contexts.length === 1
              ? [{ type: "toolCall", id: "lookup-1", name: "lookup", arguments: {} }]
              : [{ type: "text", text: "Synthetic fixture turn finished." }],
            contexts.length === 1 ? "toolUse" : "stop",
          ),
        );
      });
      const manager = SessionManager.inMemory();
      const fixture = await createTestSession({
        model,
        sessionManager: manager,
        customTools: [lookup],
      });
      const provenance: InputProvenance | undefined = interSession
        ? {
            kind: "inter_session",
            sourceSessionKey: "agent:source:main",
            sourceChannel: "webchat",
            sourceTool: "sessions_send",
          }
        : undefined;
      await submitRealTurn({
        fixture,
        manager,
        runId: "original-turn",
        body: originalBody,
        timestamp: 1_754_000_000_000,
        workspaceDir: state.workspaceDir,
        provenance,
      });
      const failures = fixture.session.messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({ stopReason: message.stopReason, error: message.errorMessage }));
      expect(contexts, JSON.stringify(failures)).toHaveLength(2);
      const persisted = structuredClone(manager.getPersistedEntries());
      const reopened = SessionManager.fromEntries(structuredClone(persisted));
      const resumed = await createTestSession({
        model,
        sessionManager: reopened,
        customTools: [lookup],
      });
      const replay = await sanitizeSessionHistory({
        messages: reopened.buildSessionContext().messages,
        sessionManager: reopened,
        sessionId: "prefix-proof",
        provider: model.provider,
        modelId: model.id,
        modelApi: model.api,
        model,
        config: {},
      });
      resumed.session.agent.state.messages = replay;
      expect(manager.getPersistedEntries()).toEqual(persisted);
      await submitRealTurn({
        fixture: resumed,
        manager: reopened,
        runId: "next-turn",
        body: "PREFIX_PROOF_NEXT_BODY: proceed normally.",
        timestamp: 1_754_000_000_001,
        workspaceDir: state.workspaceDir,
      });
      expect(contexts).toHaveLength(3);
      const durableUser = reopened
        .buildSessionContext()
        .messages.find(
          (message) =>
            message.role === "user" && JSON.stringify(message.content).includes(originalBody),
        );
      expect(durableUser).toMatchObject({
        content: provenance
          ? annotateInterSessionPromptText(originalBody, provenance)
          : originalBody,
        timestamp: 1_754_000_000_000,
        idempotencyKey: "original-turn",
        ...(provenance ? { provenance } : {}),
      });
      const payloads = [];
      for (const context of contexts) {
        payloads.push(await convertThroughPublicAnthropic(context));
      }
      const texts = payloads.map(originalUserText);
      expect(texts[1]).toBe(texts[0]);
      expect(texts[2]).toBe(texts[0]);
      expect(manager.getPersistedEntries()).toEqual(persisted);
    });
  });
}

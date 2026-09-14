import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { settleReplyDispatcher } from "../../auto-reply/dispatch-dispatcher.js";
import type { dispatchReplyFromConfig as DispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import { emptyConfig } from "../../auto-reply/reply/dispatch-from-config.shared.test-harness.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { buildTestCtx } from "../../auto-reply/reply/test-ctx.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionTranscriptRuntime from "../../plugin-sdk/session-transcript-runtime.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { prepareTerminalWithSettledTurnFinalization } from "./run/settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./run/settled-turn-finalization.test-support.js";

export type MissingFinalizerDeliveryMode =
  | "durable"
  | "detached"
  | "pre-append-abort"
  | "post-append-abort";

export async function runMissingFinalizerDeliveryCase(params: {
  mode: MissingFinalizerDeliveryMode;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  state: OpenClawTestState;
  sessionStoreMocks: {
    databaseEntryLoader?: unknown;
    currentEntry?: Record<string, unknown>;
    loadSessionEntry: ReturnType<typeof vi.fn>;
  };
  dispatchReplyFromConfig: typeof DispatchReplyFromConfig;
}) {
  const { mode, state, sessionStoreMocks } = params;
  const admission = prepareSystemAgentRunAdmission(
    {},
    `prepared-source-${mode}`,
    "main",
    `prepared-source-${mode}`,
  );
  const controller = new AbortController();
  const assistant = buildEmbeddedRunnerAssistant({
    provider: "openai",
    model: "gpt-5.6-luna",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "completed-command", name: "exec", arguments: {} }],
  });
  const attempt = makeEmbeddedRunnerAttempt({
    terminal: { kind: "ok" },
    sessionIdUsed: `session-${mode}`,
    assistantTexts: [],
    messagesSnapshot: [
      { role: "user", content: "Run the command once.", timestamp: 1 },
      assistant,
      {
        role: "toolResult",
        toolCallId: "completed-command",
        toolName: "exec",
        content: [{ type: "text", text: "completed-once" }],
        isError: false,
        timestamp: 3,
      },
    ],
    toolMetas: [{ toolName: "exec", toolCallId: "completed-command", replaySafe: false }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
  attempt.settledTurnFinalizationContext = Object.freeze({ source: "unavailable" });
  fs.mkdirSync(state.sessionsDir(), { recursive: true });
  const target = {
    agentId: "main",
    sessionId: `session-${mode}`,
    sessionKey: `agent:main:prepared-source-${mode}`,
    storePath: path.join(fs.realpathSync(state.sessionsDir()), "sessions.json"),
  };
  const { loadSessionEntryWithDatabase } = await vi.importActual<
    typeof import("../../config/sessions/session-accessor.sqlite-entry.js")
  >("../../config/sessions/session-accessor.sqlite-entry.js");
  sessionStoreMocks.databaseEntryLoader = loadSessionEntryWithDatabase;
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  sessionStoreMocks.currentEntry = { sessionId: target.sessionId, updatedAt: 1 };
  for (const message of attempt.messagesSnapshot) {
    await sessionTranscriptRuntime.appendSessionTranscriptMessageByIdentity({ ...target, message });
  }
  const prefix = await sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries(target);
  const appendAssistantMirrorMessageByIdentity =
    sessionTranscriptRuntime.appendAssistantMirrorMessageByIdentity;
  const appendedIdempotencyKeys: string[] = [];
  const appendSpy = vi
    .spyOn(sessionTranscriptRuntime, "appendAssistantMirrorMessageByIdentity")
    .mockImplementation(async (appendParams) => {
      const result = await appendAssistantMirrorMessageByIdentity(appendParams);
      if (result.ok && appendParams.idempotencyKey) {
        appendedIdempotencyKeys.push(appendParams.idempotencyKey);
      }
      if (mode === "post-append-abort" && result.ok) {
        controller.abort(new Error("cancelled after append"));
      }
      return result;
    });
  const input = createSettledFinalizationTestInput(attempt, await admission.admit("embedded"));
  input.finalization.abortSignal = controller.signal;
  input.terminalBase.runParams.trigger = "user";
  input.terminalBase.runParams.sessionKey = target.sessionKey;
  Object.assign(
    input.finalization.preparedAttempt,
    createResolvedEmbeddedRunnerModel("openai", "gpt-5.6-sol"),
    {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentId: "main",
      sessionKey: target.sessionKey,
      sessionTarget: target,
      authProfileStore: { version: 1, profiles: {} },
      resolvedApiKey: "synthetic-unused-host-key",
      sessionPersistence: mode === "detached" ? "detached" : "durable",
    },
  );
  delete input.finalization.harness.finalizeSettledTurn;
  input.finalization.harness.runAttempt = vi.fn(async () => {
    throw new Error("Completed work must not be replayed");
  });
  if (mode === "pre-append-abort") {
    sessionStoreMocks.loadSessionEntry.mockImplementationOnce(() => {
      controller.abort(new Error("cancelled before append"));
      return sessionStoreMocks.currentEntry;
    });
  }

  try {
    const terminal = await prepareTerminalWithSettledTurnFinalization(input);
    const abortedBeforeDispatch = controller.signal.aborted;
    const fallback =
      mode === "pre-append-abort"
        ? undefined
        : terminal.prepared.payloadsWithToolMedia?.find((payload) =>
            payload.text?.includes("no final summary was produced"),
          );
    const deliver = vi.fn(async (_payload: ReplyPayload) => {});
    const dispatcher = createReplyDispatcher({ deliver });
    sessionStoreMocks.currentEntry = {
      sessionId: "dispatch-session",
      updatedAt: 1,
      sendPolicy: "allow",
    };
    sessionStoreMocks.databaseEntryLoader = undefined;
    await params.dispatchReplyFromConfig({
      ctx: buildTestCtx({ ChatType: "direct", SessionKey: "agent:main:main" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(async () => fallback),
      replyOptions: { sourceReplyDeliveryMode: params.sourceReplyDeliveryMode ?? "automatic" },
    });
    await settleReplyDispatcher({ dispatcher });
    const transcript =
      await sessionTranscriptRuntime.readVisibleSessionTranscriptMessageEntries(target);
    return {
      appends: transcript.length - prefix.length,
      deliveries: deliver.mock.calls.length,
      fallbackDeliveries: deliver.mock.calls.filter(([payload]) => payload.text === fallback?.text)
        .length,
      queuedFinals: dispatcher.getQueuedCounts().final,
      abortedBeforeDispatch,
      appendedIdempotencyKeys,
    };
  } finally {
    appendSpy.mockRestore();
    sessionStoreMocks.databaseEntryLoader = undefined;
    sessionStoreMocks.loadSessionEntry.mockImplementation(() => sessionStoreMocks.currentEntry);
    admission.close();
  }
}

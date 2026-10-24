import { createHash } from "node:crypto";
import type {
  AgentMessage,
  ContextEngineProjection,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  readContextEngineThreadBootstrapProjection,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import { buildCodexSelectedHistoryItems } from "./context-engine-history-items.js";
import {
  isCodexDurableCustomMessage,
  projectContextEngineAssemblyForCodex,
} from "./context-engine-projection.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
import type { CodexAttemptContext } from "./run-attempt-context.js";
import {
  hashCodexAppServerBindingFingerprint,
  type CodexAppServerBindingIdentity,
  type CodexBindingAuthority,
} from "./session-binding.js";
import {
  buildContextEngineBinding,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-context-engine.js";
import { codexLegacyDynamicToolsFingerprint } from "./thread-fingerprints.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import type { CodexThreadRequestContext } from "./thread-lifecycle-preflight.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";

type ProjectionParams = Parameters<typeof projectContextEngineAssemblyForCodex>[0];

function selectHistoryPrefix(
  messages: AgentMessage[],
  source: ContextEngineProjection | undefined,
  previous: string | undefined,
) {
  const hash = createHash("sha256").update(
    JSON.stringify([source?.mode ?? "per_turn", source?.epoch, source?.fingerprint]),
  );
  const fingerprint = () => `selection-v1:${hash.copy().digest("hex")}`;
  let prefixLength = fingerprint() === previous ? 0 : undefined;
  for (let index = 0; index < messages.length; index++) {
    const serialized = JSON.stringify(messages[index]);
    hash.update(`${Buffer.byteLength(serialized)}:`).update(serialized);
    if (fingerprint() === previous) {
      prefixLength = index + 1;
    }
  }
  const deliveredFingerprint = fingerprint();
  const projection: CodexContextEngineThreadBootstrapProjection = {
    mode: "thread_bootstrap",
    epoch: source?.epoch?.trim() || "selected-history",
    fingerprint: prefixLength === undefined ? deliveredFingerprint : previous,
    deliveredFingerprint,
  };
  return { projection, prefixLength };
}

export async function prepareCodexContextEngineHistory(params: {
  assembled: {
    messages: AgentMessage[];
    contextProjection?: ContextEngineProjection;
    systemPromptAddition?: string;
  };
  runtimeParams: CodexAttemptContext["runtime"]["runtimeParams"];
  startupBinding: CodexAttemptContext["runtime"]["connection"]["mutable"]["startupBinding"];
  toolSpecs: Parameters<typeof codexLegacyDynamicToolsFingerprint>[0];
  hasContinuation: boolean;
  continuationMessages: AgentMessage[] | undefined;
  preserveToolPayload: boolean;
  projectionParams: Omit<
    ProjectionParams,
    "assembledMessages" | "systemPromptAddition" | "toolPayloadMode"
  >;
  historyTokenBudget?: number;
  baseDeveloperInstructions: string;
  assertCurrent: () => void;
}) {
  const { assembled, projectionParams, startupBinding, assertCurrent } = params;
  const prepareSeed = params.runtimeParams.hostCapabilities.prepareBoundedSeed;
  const includeMessage = (message: AgentMessage) =>
    (message.role !== "custom" || isCodexDurableCustomMessage(message)) &&
    !(
      message.role === "user" &&
      projectionParams.currentUserTurnIdempotencyKey &&
      Reflect.get(message, "idempotencyKey") === projectionParams.currentUserTurnIdempotencyKey
    );
  const messages = [...assembled.messages, ...(params.continuationMessages ?? [])].filter(
    includeMessage,
  );
  const configured = params.historyTokenBudget !== undefined;
  const selection =
    configured && !prepareSeed
      ? selectHistoryPrefix(
          messages,
          assembled.contextProjection,
          startupBinding?.contextEngine?.projection?.fingerprint,
        )
      : undefined;
  const contextEngineProjection = prepareSeed
    ? undefined
    : (selection?.projection ??
      readContextEngineThreadBootstrapProjection(assembled.contextProjection));
  let projectionDecision;
  if (contextEngineProjection && !params.hasContinuation) {
    const legacyDynamicToolsFingerprint = codexLegacyDynamicToolsFingerprint(params.toolSpecs);
    projectionDecision = resolveContextEngineBootstrapProjectionDecision({
      startupBinding,
      expectedBinding: buildContextEngineBinding(params.runtimeParams, contextEngineProjection),
      dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(legacyDynamicToolsFingerprint),
      legacyDynamicToolsFingerprint,
    });
  } else {
    projectionDecision = { project: true, reason: "per-turn-projection" };
  }
  const renderProjection = (includeAttachments: boolean) =>
    projectContextEngineAssemblyForCodex({
      ...projectionParams,
      assembledMessages: configured ? [] : messages,
      systemPromptAddition: assembled.systemPromptAddition,
      toolPayloadMode: contextEngineProjection || params.preserveToolPayload ? "preserve" : "elide",
      prepareFileContext: includeAttachments ? projectionParams.prepareFileContext : undefined,
    });
  const projection = await renderProjection(projectionDecision.project);
  const buildSeed = (seedMessages: AgentMessage[]) =>
    buildCodexSelectedHistoryItems({
      messages: seedMessages,
      tokenBudget: params.historyTokenBudget,
      prepareFileContext: projectionParams.prepareFileContext,
    });
  const historyBootstrapItems = !configured
    ? undefined
    : prepareSeed
      ? async (assertSeedCurrent: () => void) => {
          // Retain the host's message identities and their prepared media snapshots.
          const seed = (
            await prepareSeed({
              assertCurrent: assertSeedCurrent,
              signal: params.runtimeParams.abortSignal,
              tokenBudget: params.historyTokenBudget,
            })
          ).filter(includeMessage);
          assertSeedCurrent();
          return buildSeed(seed);
        }
      : await buildSeed(messages);
  const historyDeltaItems =
    configured && selection?.prefixLength !== undefined && !projectionDecision.project
      ? await buildSeed(messages.slice(selection.prefixLength))
      : undefined;
  assertCurrent();
  return {
    projection,
    projectionDecision,
    preparedBootstrapProjection:
      !configured && contextEngineProjection ? () => renderProjection(true) : undefined,
    promptState: {
      contextEngineProjection,
      historyBootstrapItems,
      historyDeltaItems,
      promptText:
        configured || projectionDecision.project ? projection.promptText : projectionParams.prompt,
      promptContextRange:
        !configured && projectionDecision.project ? projection.promptContextRange : undefined,
      developerInstructions: joinPresentSections(
        params.baseDeveloperInstructions,
        projection.developerInstructionAddition,
      ),
    },
  };
}

/** Append only an acknowledged prefix's suffix; fresh threads use the complete selection. */
export async function injectCodexHistoryDelta(
  params: CodexStartOrResumeThreadParams,
  options: {
    thread: CodexAppServerThreadLifecycleBinding;
    context: CodexThreadRequestContext;
    bindingIdentity: CodexAppServerBindingIdentity;
    authority: CodexBindingAuthority;
  },
): Promise<void> {
  const items = params.historyDeltaItems;
  if (!items?.length) {
    return;
  }
  const { thread, context, bindingIdentity, authority } = options;
  const { contextEngineBinding, lifecycleTiming, throwIfAborted } = context;
  const assert = authority.assertCurrent;
  throwIfAborted();
  assert();
  if (
    thread.model !== context.startModelSelection.model ||
    (context.startModelProvider && thread.modelProvider !== context.startModelProvider)
  ) {
    throw new Error(
      "Codex selected a different model than the assembled context policy; retry with that model's configured budget.",
    );
  }
  try {
    // A crash after append but before acknowledgement must rotate, never replay this suffix.
    const pendingContextEngine = contextEngineBinding?.projection
      ? {
          ...contextEngineBinding,
          projection: {
            ...contextEngineBinding.projection,
            fingerprint: `pending:${params.contextEngineProjection?.deliveredFingerprint}`,
          },
        }
      : undefined;
    const marked = await params.bindingStore.mutate(
      bindingIdentity,
      { kind: "patch", threadId: thread.threadId, patch: { contextEngine: pendingContextEngine } },
      assert,
      authority,
    );
    if (!marked) {
      throw new CodexThreadBindingConflictError(thread.threadId, "marking history delivery");
    }
    await lifecycleTiming.measure("thread-reuse-seed-history", () =>
      params.client.request(
        "thread/inject_items",
        { threadId: thread.threadId, items },
        {
          signal: params.signal,
          assertCurrent: () => {
            throwIfAborted();
            params.params.hostCapabilities.assertActive();
            assert();
          },
          withCurrent: authority.withCurrent,
        },
      ),
    );
    const acknowledged = buildContextEngineBinding(
      params.params,
      params.contextEngineProjection,
      true,
    );
    const committed = await params.bindingStore.mutate(
      bindingIdentity,
      { kind: "patch", threadId: thread.threadId, patch: { contextEngine: acknowledged } },
      assert,
      authority,
    );
    if (!committed) {
      throw new CodexThreadBindingConflictError(thread.threadId, "acknowledging history delivery");
    }
    thread.contextEngine = acknowledged;
  } catch (error) {
    // Preserve the native transcript but retire uncertain delivery from future reuse.
    await params.bindingStore.mutate(
      bindingIdentity,
      { kind: "clear", threadId: thread.threadId, clientId: thread.clientId },
      assert,
      authority,
    );
    if (!thread.liveThreadOwnership) {
      const released = await unsubscribeCodexThreadBestEffort(params.client, {
        threadId: thread.threadId,
        timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
        assertCurrent: assert,
        withCurrent: authority.withCurrent,
      });
      if (!released) {
        await (params.abandonClient ?? (() => closeCodexStartupClientBestEffort(params.client)))();
        throw new CodexAppServerUnsafeSubscriptionError("Codex reused history cleanup failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
  throwIfAborted();
  assert();
}

/** A provisional thread must acknowledge its full selection before the binding can commit. */
export async function seedCodexHistory(
  params: CodexStartOrResumeThreadParams,
  options: {
    response: { thread: { id: string }; model?: string | null; modelProvider?: string | null };
    expectedModel: string | null | undefined;
    expectedProvider: string | null | undefined;
    lifecycleTiming: CodexThreadRequestContext["lifecycleTiming"];
    assertCurrent: () => void;
  },
): Promise<void> {
  if (params.historyBootstrapItems === undefined) {
    return;
  }
  const { response, expectedModel, expectedProvider, lifecycleTiming, assertCurrent } = options;
  assertCurrent();
  if (
    !response.model ||
    response.model !== expectedModel ||
    (expectedProvider && response.modelProvider !== expectedProvider)
  ) {
    throw new Error(
      "Codex selected a different model than the assembled context policy; retry with that model's configured budget.",
    );
  }
  const items =
    typeof params.historyBootstrapItems === "function"
      ? await params.historyBootstrapItems(assertCurrent)
      : params.historyBootstrapItems;
  if (items.length) {
    await lifecycleTiming.measure("thread-start-seed-history", () =>
      params.client.request(
        "thread/inject_items",
        { threadId: response.thread.id, items },
        { signal: params.signal, assertCurrent, withCurrent: params.authority?.withCurrent },
      ),
    );
  }
  assertCurrent();
}

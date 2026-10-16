import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexAppServerBindingIdentity, CodexBindingAuthority } from "./session-binding.js";
import { buildContextEngineBinding } from "./thread-context-engine.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import type { CodexThreadRequestContext } from "./thread-lifecycle-preflight.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
} from "./thread-lifecycle-types.js";

export async function injectCodexHistoryDelta(
  params: Pick<
    CodexStartOrResumeThreadParams,
    | "historyDeltaItems"
    | "params"
    | "contextEngineProjection"
    | "bindingStore"
    | "client"
    | "signal"
    | "abandonClient"
  >,
  options: {
    thread: CodexAppServerThreadLifecycleBinding;
    context: Pick<
      CodexThreadRequestContext,
      | "startModelSelection"
      | "startModelProvider"
      | "contextEngineBinding"
      | "lifecycleTiming"
      | "throwIfAborted"
    >;
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
  // Only a matched selected prefix can enter this path. A fresh thread
  // receives the full bootstrap in startFreshCodexThread instead.
  try {
    const pendingContextEngine = contextEngineBinding?.projection
      ? {
          ...contextEngineBinding,
          projection: {
            ...contextEngineBinding.projection,
            fingerprint: `pending:${params.contextEngineProjection?.deliveredFingerprint}`,
          },
        }
      : undefined;
    // A crash between native append and acknowledgement must rotate,
    // never append the same suffix again on recovery.
    const marked = await params.bindingStore.mutate(
      bindingIdentity,
      {
        kind: "patch",
        threadId: thread.threadId,
        patch: { contextEngine: pendingContextEngine },
      },
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
    // A lost acknowledgment may have appended the quote. Do not replay it
    // on this physical thread: release its binding, preserving its native
    // transcript, so an ordinary retry starts fresh. Existing startup/warm
    // cleanup owns its subscription; only a provisional new thread is deleted.
    await params.bindingStore.mutate(
      bindingIdentity,
      { kind: "clear", threadId: thread.threadId, clientId: thread.clientId },
      assert,
      authority,
    );
    if (!thread.liveThreadOwnership) {
      // Cold resume acquired a subscription without a transferred warm claim.
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

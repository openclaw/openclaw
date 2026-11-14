import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { formatMediaPlaceholderText } from "openclaw/plugin-sdk/channel-inbound";
import { runInDetachedAsyncContext } from "openclaw/plugin-sdk/concurrency-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  generateConversationLabel as generateTopicLabel,
  planConversationLabelUpdate,
  buildConversationLabelReassessmentPrompt,
  readConversationLabelRefinementSource,
  readConversationLabelResetState,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  getSessionEntryByIdAsync,
  prepareSessionEntryLabelClaim,
  prepareSessionEntryPatch,
} from "openclaw/plugin-sdk/session-store-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";
import type { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import type { createFreshTelegramSessionEntryLoader } from "./bot-message-dispatch-session.js";
import type { DispatchTelegramMessageParams } from "./bot-message-dispatch.types.js";
import { getTelegramTextParts, resolveTelegramPrimaryMedia } from "./bot/helpers.js";
import { getTopicLabelMetadata, updateTopicName } from "./topic-name-cache.js";

const topicLabelQueue = new KeyedAsyncQueue();
const topicLabelLogger = createSubsystemLogger("telegram/topic-label");

type TopicLabelSchedulerParams = Pick<
  DispatchTelegramMessageParams,
  "context" | "cfg" | "bot" | "telegramCfg" | "turnAdoptionLifecycle"
> & {
  dispatchContext: Awaited<ReturnType<typeof resolveDispatchTelegramContext>>;
  loadFreshSessionEntry: ReturnType<typeof createFreshTelegramSessionEntryLoader>;
  isDmTopic: boolean;
  isRoomEvent: boolean;
  isDispatchSuperseded: () => boolean;
  topicNameScope?: string;
  topicSessionBeforeDispatch?: string;
  topicRevisionBeforeDispatch?: string;
};

/** Queue recorded topic input independently of slow reply delivery. */
export function createDmTopicLabelScheduler(params: TopicLabelSchedulerParams) {
  const {
    context,
    cfg,
    bot,
    telegramCfg,
    turnAdoptionLifecycle,
    dispatchContext,
    loadFreshSessionEntry,
    isDmTopic,
    isRoomEvent,
    isDispatchSuperseded,
    topicNameScope,
    topicSessionBeforeDispatch,
    topicRevisionBeforeDispatch,
  } = params;
  const scheduleDmTopicLabel = async () => {
    const sessionKey = dispatchContext.ctxPayload.SessionKey;
    if (!isDmTopic || !sessionKey || !topicNameScope || isRoomEvent) {
      return;
    }
    const { RawBody, BodyForAgent, Body, media, CommandSource } = dispatchContext.ctxPayload;
    const userMessage = truncateUtf16Safe(
      RawBody?.trim() ||
        BodyForAgent?.trim() ||
        formatMediaPlaceholderText(media ?? []) ||
        Body ||
        "",
      500,
    );
    const autoTopicConfig = resolveAutoTopicLabelConfig(
      dispatchContext.groupConfig && "autoTopicLabel" in dispatchContext.groupConfig
        ? dispatchContext.groupConfig.autoTopicLabel
        : undefined,
      telegramCfg.autoTopicLabel,
    );
    if (!autoTopicConfig || !userMessage.trim()) {
      return;
    }
    loadFreshSessionEntry.clear();
    const snapshot = await loadFreshSessionEntry(dispatchContext.route.agentId, sessionKey);
    if (
      !snapshot.entry?.sessionId ||
      (topicSessionBeforeDispatch &&
        (snapshot.entry.sessionId !== topicSessionBeforeDispatch ||
          snapshot.entry.lifecycleRevision !== topicRevisionBeforeDispatch))
    ) {
      return;
    }
    const topicThreadId = dispatchContext.threadSpec.id!;
    const metadata = await getTopicLabelMetadata(
      dispatchContext.chatId,
      topicThreadId,
      topicNameScope,
    );
    // Only Telegram's creation provenance can identify an arbitrary implicit name.
    // A session label is a deliberate name and must always win.
    const implicitName =
      metadata?.isNameImplicit && !snapshot.entry.label?.trim() ? metadata.name : undefined;
    const isPlaceholder = (name: string | undefined) =>
      !name?.trim() || name === "New Thread" || name === "New Chat" || name === implicitName;
    const currentName = [
      snapshot.entry.label,
      metadata?.name,
      dispatchContext.ctxPayload.ThreadLabel,
      snapshot.entry.topicName,
      snapshot.entry.displayName,
    ].find((name) => !isPlaceholder(name));
    const sessionId = snapshot.entry.sessionId;
    const cacheState = metadata?.labelState;
    const cacheMatchesSession =
      cacheState?.sessionId === sessionId &&
      cacheState.lifecycleRevision === snapshot.entry.lifecycleRevision;
    const resetState =
      !CommandSource && !cacheMatchesSession
        ? await readConversationLabelResetState(
            {
              agentId: dispatchContext.route.agentId,
              storePath: snapshot.storePath,
              sessionKey,
              sessionId,
              lifecycleRevision: snapshot.entry.lifecycleRevision,
            },
            () => turnAdoptionLifecycle?.abortSignal?.throwIfAborted(),
          )
        : undefined;
    const priorState = cacheMatchesSession ? cacheState : (resetState ?? cacheState);
    const plan = planConversationLabelUpdate({
      state: priorState,
      currentName,
      sessionId,
      lifecycleRevision: snapshot.entry.lifecycleRevision,
      userMessage,
      userMessages: context.bufferedMessages?.map((message) => {
        const primaryMedia = resolveTelegramPrimaryMedia(message);
        return (
          getTelegramTextParts(message).text ||
          formatMediaPlaceholderText(primaryMedia ? [primaryMedia] : [])
        );
      }),
      isControlCommand: Boolean(CommandSource),
      messageId:
        dispatchContext.ctxPayload.MessageSids?.at(-1) ??
        String(dispatchContext.ctxPayload.MessageSid ?? dispatchContext.msg.message_id),
      messageCount: dispatchContext.ctxPayload.MessageSids?.length,
    });
    if (!plan) {
      return;
    }
    if (!metadata && currentName) {
      await updateTopicName(
        dispatchContext.chatId,
        topicThreadId,
        { name: currentName },
        topicNameScope,
      );
    }
    if (plan.kind === "observe" || plan.kind === "refine") {
      await updateTopicName(
        dispatchContext.chatId,
        topicThreadId,
        { labelState: plan.state },
        topicNameScope,
      );
    }
    if (plan.kind === "observe") {
      return;
    }
    const before = await getTopicLabelMetadata(
      dispatchContext.chatId,
      topicThreadId,
      topicNameScope,
    );
    const previousSessionLabel = snapshot.entry.label;
    const previousSessionDisplayName = snapshot.entry.displayName;
    const previousSessionTopicName = snapshot.entry.topicName;
    const lifecycleRevision = snapshot.entry.lifecycleRevision;
    // Initial session setup may fill empty presentation fields with a channel placeholder.
    // This bookkeeping is not a manual rename, but real names must still fence stale work.
    const sameTitleField = (previousName: string | undefined, nextName: string | undefined) =>
      previousName === nextName ||
      (plan.kind === "initial" && isPlaceholder(previousName) && isPlaceholder(nextName));
    try {
      const namingSource =
        plan.kind === "refine"
          ? await readConversationLabelRefinementSource(
              {
                agentId: dispatchContext.route.agentId,
                sessionId,
                sessionKey,
                storePath: snapshot.storePath,
              },
              userMessage,
              [],
              plan.state,
            )
          : userMessage;
      let label = await generateTopicLabel({
        userMessage: namingSource,
        prompt: currentName
          ? buildConversationLabelReassessmentPrompt(currentName, autoTopicConfig.prompt)
          : autoTopicConfig.prompt,
        maxLength: Math.max(128, currentName?.length ?? 0),
        cfg,
        agentId: dispatchContext.route.agentId,
        agentDir: resolveAgentDir(cfg, dispatchContext.route.agentId),
      });
      if (!label) {
        return;
      }
      // A single coalesced opening can already contain six follow-up messages.
      if (plan.kind === "initial" && plan.state.remainingMessages === 0) {
        const source = await readConversationLabelRefinementSource(
          {
            agentId: dispatchContext.route.agentId,
            sessionId,
            sessionKey,
            storePath: snapshot.storePath,
          },
          userMessage,
          [],
          plan.state,
        ).catch((error: unknown) => {
          logVerbose(`auto-topic-label: transcript read failed: ${String(error)}`);
          return userMessage;
        });
        label =
          (await generateTopicLabel({
            userMessage: source,
            prompt: buildConversationLabelReassessmentPrompt(label, autoTopicConfig.prompt),
            maxLength: Math.max(128, label.length),
            cfg,
            agentId: dispatchContext.route.agentId,
            agentDir: resolveAgentDir(cfg, dispatchContext.route.agentId),
          }).catch((error: unknown) => {
            logVerbose(`auto-topic-label: refinement failed: ${String(error)}`);
            return null;
          })) ?? label;
      }
      const observed = await getTopicLabelMetadata(
        dispatchContext.chatId,
        topicThreadId,
        topicNameScope,
      );
      loadFreshSessionEntry.clear();
      const current = await loadFreshSessionEntry(dispatchContext.route.agentId, sessionKey);
      if (
        isDispatchSuperseded() ||
        observed?.nameRevision !== before?.nameRevision ||
        current.entry?.sessionId !== sessionId ||
        current.entry.lifecycleRevision !== lifecycleRevision ||
        !sameTitleField(previousSessionLabel, current.entry.label) ||
        !sameTitleField(previousSessionDisplayName, current.entry.displayName) ||
        !sameTitleField(previousSessionTopicName, current.entry.topicName)
      ) {
        logVerbose("auto-topic-label: stale naming result skipped");
        return;
      }
      // Generated presentation names must not become explicit labels that shadow later topic edits.
      const shouldClaim =
        Boolean(previousSessionLabel?.trim()) &&
        (previousSessionLabel === currentName ||
          (plan.kind === "initial" && isPlaceholder(previousSessionLabel)));
      const prepare = (
        entry: Parameters<Parameters<typeof prepareSessionEntryPatch>[0]["prepare"]>[0],
      ) => {
        if (
          entry.sessionId !== sessionId ||
          entry.lifecycleRevision !== lifecycleRevision ||
          !sameTitleField(previousSessionLabel, entry.label) ||
          !sameTitleField(previousSessionDisplayName, entry.displayName) ||
          (!sameTitleField(previousSessionTopicName, entry.topicName) && entry.topicName !== label)
        ) {
          return null;
        }
        return {
          topicName: label,
          ...(shouldClaim ? { label } : {}),
          ...(entry.displayName === currentName ||
          (plan.kind === "initial" && isPlaceholder(entry.displayName))
            ? { displayName: label }
            : {}),
        };
      };
      const authority = {
        kind: "host",
        assertCurrent() {
          turnAdoptionLifecycle?.abortSignal?.throwIfAborted();
        },
      } as const;
      const patched = shouldClaim
        ? await prepareSessionEntryLabelClaim({
            agentId: dispatchContext.route.agentId,
            storePath: snapshot.storePath,
            sessionKey,
            label,
            prepare,
            authority,
          })
        : await prepareSessionEntryPatch({
            agentId: dispatchContext.route.agentId,
            storePath: snapshot.storePath,
            sessionKey,
            prepare,
            preserveActivity: true,
            requireWriteSuccess: true,
            authority,
          });
      if (!patched) {
        logVerbose("auto-topic-label: session title changed or label is already in use");
        return;
      }
      const expectedDisplayName =
        current.entry.displayName === currentName ||
        (plan.kind === "initial" && isPlaceholder(current.entry.displayName))
          ? label
          : current.entry.displayName;
      const committed = await getSessionEntryByIdAsync({
        agentId: dispatchContext.route.agentId,
        storePath: snapshot.storePath,
        sessionId,
      });
      const beforeEdit = await getTopicLabelMetadata(
        dispatchContext.chatId,
        topicThreadId,
        topicNameScope,
      );
      if (
        isDispatchSuperseded() ||
        committed?.sessionKey !== sessionKey ||
        committed.entry.sessionId !== sessionId ||
        committed.entry.lifecycleRevision !== lifecycleRevision ||
        committed.entry.topicName !== label ||
        committed.entry.displayName !== expectedDisplayName ||
        (shouldClaim
          ? committed.entry.label !== label
          : !sameTitleField(previousSessionLabel, committed.entry.label)) ||
        beforeEdit?.nameRevision !== before?.nameRevision
      ) {
        logVerbose("auto-topic-label: session or topic changed before Telegram edit");
        return;
      }
      turnAdoptionLifecycle?.abortSignal?.throwIfAborted();
      if (label !== currentName) {
        try {
          await bot.api.editForumTopic(dispatchContext.chatId, topicThreadId, { name: label });
        } catch (error) {
          // Only undo our own unchanged write; a reset or a later manual edit wins.
          const restore = (
            entry: Parameters<Parameters<typeof prepareSessionEntryPatch>[0]["prepare"]>[0],
          ) => {
            if (
              entry.sessionId !== sessionId ||
              entry.lifecycleRevision !== lifecycleRevision ||
              entry.topicName !== label ||
              entry.displayName !== expectedDisplayName ||
              (shouldClaim
                ? entry.label !== label
                : !sameTitleField(previousSessionLabel, entry.label))
            ) {
              return null;
            }
            return {
              label: previousSessionLabel,
              displayName: previousSessionDisplayName,
              topicName: previousSessionTopicName,
            };
          };
          const restoreScope = {
            agentId: dispatchContext.route.agentId,
            storePath: snapshot.storePath,
            sessionKey,
            authority,
            prepare: restore,
          };
          const restored =
            shouldClaim && previousSessionLabel
              ? await prepareSessionEntryLabelClaim({
                  ...restoreScope,
                  label: previousSessionLabel,
                })
              : await prepareSessionEntryPatch({
                  ...restoreScope,
                  preserveActivity: true,
                  requireWriteSuccess: true,
                });
          if (!restored) {
            topicLabelLogger.warn(
              "Telegram topic rename failed and the previous session title could not be restored; inspect the session title before retrying",
            );
          }
          throw error;
        }
      }
      const afterEdit = await getTopicLabelMetadata(
        dispatchContext.chatId,
        topicThreadId,
        topicNameScope,
      );
      if (afterEdit?.nameRevision !== before?.nameRevision && afterEdit?.name !== label) {
        logVerbose("auto-topic-label: topic changed during title persistence");
        return;
      }
      await updateTopicName(
        dispatchContext.chatId,
        topicThreadId,
        {
          name: label,
          labelState: plan.state,
        },
        topicNameScope,
      );
    } catch (err) {
      logVerbose(`auto-topic-label: failed: ${String(err)}`);
    }
  };
  const scheduleTopicLabelAfterRecord = () => {
    if (!isDmTopic || !topicNameScope || isRoomEvent) {
      return;
    }
    const labelQueueKey = JSON.stringify([
      topicNameScope,
      dispatchContext.chatId,
      dispatchContext.threadSpec.id,
    ]);
    void runInDetachedAsyncContext(() =>
      topicLabelQueue.enqueue(labelQueueKey, scheduleDmTopicLabel),
    ).catch((err: unknown) => logVerbose(`auto-topic-label: failed to schedule: ${String(err)}`));
  };
  return scheduleTopicLabelAfterRecord;
}

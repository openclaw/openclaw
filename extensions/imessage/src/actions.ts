import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  createActionGate,
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import { normalizePollInput } from "openclaw/plugin-sdk/poll-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { hasExclusiveIMessageLocalDatabase, resolveIMessageAccount } from "./accounts.js";
import { IMESSAGE_ACTION_NAMES, IMESSAGE_ACTIONS } from "./actions-contract.js";
import { chatContextFromIMessageTarget } from "./chat-context.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";
import { resolveAuthorizedIMessageActionReference } from "./message-action-reference.js";
import { normalizeIMessageMessageId } from "./message-guid.js";
import { describeIMessageMessageTool } from "./message-tool-api.js";
import {
  findLatestIMessageEntryForChat,
  isIMessageCurrentMessageInChatAsync,
  rememberIMessageReplyCache,
  type IMessageChatContext,
} from "./monitor-reply-cache.js";
import { imessageRpcSupportsMethod } from "./private-api-status.js";
import { getCachedIMessagePrivateApiStatus, probeIMessagePrivateApi } from "./probe.js";
import { resolveIMessageRemoteHost } from "./remote-host.js";
import { parseIMessageTarget, type IMessageService, type IMessageTarget } from "./targets.js";

const loadIMessageActionsRuntime = createLazyRuntimeNamedExport(
  () => import("./actions.runtime.js"),
  "imessageActionsRuntime",
);

const log = createSubsystemLogger("channels/imessage");

const providerId = "imessage";

const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  ...IMESSAGE_ACTION_NAMES,
  "upload-file",
]);
const GROUP_MANAGEMENT_ACTIONS = new Set<ChannelMessageActionName>([
  "renameGroup",
  "setGroupIcon",
  "addParticipant",
  "removeParticipant",
  "leaveGroup",
]);

type IMessageConversationReadOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

function readMessageText(params: Record<string, unknown>): string | undefined {
  return readStringParam(params, "text") ?? readStringParam(params, "message");
}

function rejectRedactedIMessageTarget(value: string | undefined): string | undefined {
  if (value === "***") {
    throw new Error(
      "iMessage action target is a redacted display value. Omit the target to use the current conversation.",
    );
  }
  return value;
}

function resolveIMessageDeliveryTarget(args: Record<string, unknown>): string | undefined {
  const chatGuid = rejectRedactedIMessageTarget(readStringParam(args, "chatGuid"));
  const chatId = readPositiveIntegerParam(args, "chatId");
  const chatIdentifier = rejectRedactedIMessageTarget(readStringParam(args, "chatIdentifier"));
  const targets = [
    chatGuid ? `chat_guid:${chatGuid}` : undefined,
    chatId !== undefined ? `chat_id:${chatId}` : undefined,
    chatIdentifier ? `chat_identifier:${chatIdentifier}` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (targets.length > 1) {
    throw new Error("iMessage action received conflicting delivery target aliases.");
  }
  return targets[0];
}

function resolveIMessageActionTarget(params: {
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
}): IMessageTarget | null {
  const rawTarget =
    resolveIMessageDeliveryTarget(params.actionParams) ??
    readStringParam(params.actionParams, "to") ??
    readStringParam(params.actionParams, "target") ??
    (params.currentChannelId?.trim() || undefined);
  rejectRedactedIMessageTarget(rawTarget);
  return rawTarget ? parseIMessageTarget(rawTarget) : null;
}

const IMESSAGE_DELIVERY_TARGET_ALIASES = ["chatGuid", "chatIdentifier", "chatId"];

function currentConversationMatchParams(params: {
  args: Record<string, unknown>;
  accountId: string;
  toolContext: {
    currentMessageId?: string | number;
  };
}) {
  const currentMessageId = params.toolContext.currentMessageId;
  if (currentMessageId === undefined) {
    return undefined;
  }
  return {
    accountId: params.accountId,
    currentMessageId,
    chatContext: {
      chatGuid: readStringParam(params.args, "chatGuid"),
      chatIdentifier: readStringParam(params.args, "chatIdentifier"),
      chatId: readPositiveIntegerParam(params.args, "chatId"),
    },
  };
}

function createIMessageTargetAliases(resourceAliases: string[] = []) {
  return {
    aliases: [...IMESSAGE_DELIVERY_TARGET_ALIASES, ...resourceAliases],
    deliveryTargetAliases: [...IMESSAGE_DELIVERY_TARGET_ALIASES],
    resolveDeliveryTarget: ({ args }: { args: Record<string, unknown> }) =>
      resolveIMessageDeliveryTarget(args),
    matchesCurrentConversationAsync: async (
      params: Parameters<typeof currentConversationMatchParams>[0],
    ) => {
      const match = currentConversationMatchParams(params);
      return match ? await isIMessageCurrentMessageInChatAsync(match) : false;
    },
  };
}

/** An omitted action reference targets the most recent inbound in the same chat. */
function readMessageIdWithChatFallback(
  params: Record<string, unknown>,
  chatContext: IMessageChatContext & { accountId: string },
): string {
  const explicit = readStringParam(params, "messageId");
  if (explicit) {
    return explicit;
  }
  const latest = findLatestIMessageEntryForChat(chatContext);
  if (latest?.messageId) {
    return latest.messageId;
  }
  return readStringParam(params, "messageId", { required: true });
}

type IMessageActionsRuntime = Awaited<ReturnType<typeof loadIMessageActionsRuntime>>;

async function resolveChatGuid(params: {
  action: ChannelMessageActionName;
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
  conversationReadOrigin: IMessageConversationReadOrigin;
  runtime: IMessageActionsRuntime;
  options: {
    cliPath: string;
    dbPath?: string;
    remoteHost?: string;
    timeoutMs?: number;
  };
}): Promise<string> {
  const target = resolveIMessageActionTarget(params);
  if (!target) {
    throw new Error(
      `iMessage ${params.action} requires chatGuid, chatId, chatIdentifier, or a chat target.`,
    );
  }
  if (target.kind === "chat_guid") {
    return target.chatGuid;
  }
  // Messages identifies direct chats by service and handle; resolve all other
  // target shapes through the same account-scoped chat lookup.
  const synthesizedIdentifier =
    target.kind === "handle"
      ? `${target.service === "sms" ? "SMS" : "iMessage"};-;${target.to}`
      : "";
  const lookupTarget =
    target.kind === "handle"
      ? { kind: "chat_identifier" as const, chatIdentifier: synthesizedIdentifier }
      : target;
  const resolved = await params.runtime.resolveChatGuidForTarget({
    target: lookupTarget,
    options: params.options,
    conversationReadOrigin: params.conversationReadOrigin,
  });
  if (resolved) {
    return resolved;
  }
  if (target.kind !== "handle") {
    throw new Error(
      `iMessage ${params.action} failed: chatGuid not found for ${formatUnresolvedTarget(target)}.`,
    );
  }
  // Sends may create a DM; mutations require a registered chat and message.
  if (params.action === "react" || params.action === "edit" || params.action === "unsend") {
    throw new Error(
      `iMessage ${params.action} requires a known chat. ` +
        `No registered chat for the supplied target; send a message first or pass an explicit chatGuid.`,
    );
  }
  return synthesizedIdentifier;
}

function formatUnresolvedTarget(
  target: Extract<IMessageTarget, { kind: "chat_id" | "chat_identifier" }>,
): string {
  // Tool errors must not expose conversation handles.
  return target.kind === "chat_id" ? "chat_id:<redacted>" : "chat_identifier:<redacted>";
}

function buildChatContextFromActionParams(params: {
  actionParams: Record<string, unknown>;
  currentChannelId?: string;
  service?: IMessageService;
}): IMessageChatContext {
  const target = resolveIMessageActionTarget(params);
  return target ? chatContextFromIMessageTarget(target, params.service) : {};
}

function mapTapbackReaction(emoji?: string): string | undefined {
  const value = normalizeOptionalLowercaseString(emoji)?.replace(/\ufe0f/g, "");
  return value
    ? [
        ["love", "heart", "❤"],
        ["like", "+1", "thumbsup", "👍"],
        ["dislike", "-1", "thumbsdown", "👎"],
        ["laugh", "haha", "😂", "🤣"],
        ["emphasize", "!!", "‼"],
        ["question", "?", "？", "❓"],
      ].find((aliases) => aliases.includes(value))?.[0]
    : undefined;
}

function decodeBase64Buffer(params: Record<string, unknown>, action: string): Uint8Array {
  const base64Buffer = readStringParam(params, "buffer");
  if (!base64Buffer) {
    throw new Error(`iMessage ${action} requires buffer (base64) parameter.`);
  }
  const canonical = canonicalizeBase64(base64Buffer.replaceAll("-", "+").replaceAll("_", "/"));
  if (!canonical) {
    throw new Error(`iMessage ${action} buffer must be valid base64.`);
  }
  return Uint8Array.from(Buffer.from(canonical, "base64"));
}

// Hydration must admit raw paths before this adapter receives attachment bytes.
const REPLY_ATTACHMENT_PATH_PARAM_NAMES: readonly string[] = [
  "filePath",
  "path",
  "media",
  "mediaUrl",
  "fileUrl",
] as const;

type ReplyAttachmentSpec = { kind: "buffer"; buffer: Uint8Array; filename: string };

function extractReplyAttachment(
  params: Record<string, unknown>,
): { spec: ReplyAttachmentSpec } | { spec: null; bypassParam: string } | null {
  const buffer = readStringParam(params, "buffer");
  if (buffer) {
    const filename = readStringParam(params, "filename") ?? "attachment.bin";
    return {
      spec: {
        kind: "buffer",
        buffer: decodeBase64Buffer(params, "reply attachment"),
        filename,
      },
    };
  }
  for (const name of REPLY_ATTACHMENT_PATH_PARAM_NAMES) {
    if (readStringParam(params, name)) {
      return { spec: null, bypassParam: name };
    }
  }
  return null;
}

const EFFECT_ALIASES: Record<string, string> = {
  slam: "com.apple.MobileSMS.expressivesend.impact",
  impact: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
  confetti: "com.apple.MobileSMS.expressivesend.confetti",
  lasers: "com.apple.MobileSMS.expressivesend.lasers",
  fireworks: "com.apple.MobileSMS.expressivesend.fireworks",
  balloons: "com.apple.MobileSMS.expressivesend.balloon",
  balloon: "com.apple.MobileSMS.expressivesend.balloon",
  heart: "com.apple.MobileSMS.expressivesend.heart",
  echo: "com.apple.messages.effect.CKEchoEffect",
  happybirthday: "com.apple.messages.effect.CKHappyBirthdayEffect",
  "happy-birthday": "com.apple.messages.effect.CKHappyBirthdayEffect",
  shootingstar: "com.apple.messages.effect.CKShootingStarEffect",
  "shooting-star": "com.apple.messages.effect.CKShootingStarEffect",
  sparkles: "com.apple.messages.effect.CKSparklesEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
};
const KNOWN_EFFECT_IDS = new Set(Object.values(EFFECT_ALIASES));

function effectIdFromParam(raw?: string): string | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (!value) {
    return undefined;
  }
  const resolved = EFFECT_ALIASES[value] ?? raw;
  if (typeof resolved === "string" && KNOWN_EFFECT_IDS.has(resolved)) {
    return resolved;
  }
  throw new Error(
    `iMessage sendWithEffect rejected unknown effect "${raw}". ` +
      "Use one of: slam, loud, gentle, invisibleink, confetti, lasers, fireworks, balloon, heart, " +
      "echo, happybirthday, shootingstar, sparkles, spotlight (or the full com.apple.MobileSMS.expressivesend.* / com.apple.messages.effect.* identifier).",
  );
}

function assertActionEnabled(
  action: ChannelMessageActionName,
  actionsConfig: Record<string, boolean | undefined> | undefined,
): void {
  const canonicalAction = action === "upload-file" ? "sendAttachment" : action;
  const spec = IMESSAGE_ACTIONS[canonicalAction as keyof typeof IMESSAGE_ACTIONS];
  if (!spec?.gate || !createActionGate(actionsConfig)(spec.gate)) {
    throw new Error(`iMessage ${action} is disabled in config.`);
  }
}

export const imessageMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeIMessageMessageTool,
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  requiresTrustedRequesterSender: ({ action, toolContext }) =>
    normalizeOptionalLowercaseString(toolContext?.currentChannelProvider) === "imessage" &&
    GROUP_MANAGEMENT_ACTIONS.has(action),
  messageActionTargetAliases: {
    react: createIMessageTargetAliases(["messageId"]),
    edit: createIMessageTargetAliases(["messageId"]),
    unsend: createIMessageTargetAliases(["messageId"]),
    reply: createIMessageTargetAliases(["messageId"]),
    sendWithEffect: createIMessageTargetAliases(),
    sendAttachment: createIMessageTargetAliases(),
    poll: createIMessageTargetAliases(),
    "poll-vote": createIMessageTargetAliases(["pollId", "messageId"]),
    "upload-file": createIMessageTargetAliases(),
    renameGroup: createIMessageTargetAliases(),
    setGroupIcon: createIMessageTargetAliases(),
    addParticipant: createIMessageTargetAliases(),
    removeParticipant: createIMessageTargetAliases(),
    leaveGroup: createIMessageTargetAliases(),
  },
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    toolContext,
    senderIsOwner,
    gatewayClientScopes,
    conversationReadOrigin,
  }) => {
    // Group administration mutates the host's Messages identity, so model-driven
    // actions need owner provenance or an admin-scoped Gateway caller.
    if (
      GROUP_MANAGEMENT_ACTIONS.has(action) &&
      senderIsOwner !== true &&
      !gatewayClientScopes?.includes("operator.admin")
    ) {
      throw new Error("iMessage group management requires an owner or operator.admin requester.");
    }
    const runtime = await loadIMessageActionsRuntime();
    const account = resolveIMessageAccount({
      cfg,
      accountId: accountId ?? undefined,
    });
    assertActionEnabled(action, account.config.actions);
    const cliPathForProbe = account.config.cliPath?.trim() || "imsg";
    const remoteHost = await resolveIMessageRemoteHost({
      cliPath: cliPathForProbe,
      remoteHost: account.config.remoteHost,
    });
    let privateApiStatus = getCachedIMessagePrivateApiStatus(cliPathForProbe);
    const probePrivateApiStatus = async (forceRefresh = false) => {
      privateApiStatus = await probeIMessagePrivateApi(
        cliPathForProbe,
        account.config.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS,
        forceRefresh ? { forceRefresh: true } : undefined,
      );
    };
    const assertPrivateApiEnabled = async () => {
      if (privateApiStatus?.available !== true) {
        // The first action may precede any status probe after imsg launch.
        await probePrivateApiStatus();
      }
      if (!privateApiStatus?.available) {
        // Keep bridge rejection visible even if the model omits the tool error.
        const reason = privateApiStatus?.statusMessage
          ? ` imsg reports: ${privateApiStatus.statusMessage}`
          : "";
        log.warn(
          `iMessage ${action} blocked: private API bridge unavailable (accountId=${account.accountId}, cliPath=${cliPathForProbe}). Run \`imsg launch\` to re-inject the dylib, then \`openclaw channels status --probe\` to refresh.${reason}`,
        );
        throw new Error(
          `iMessage ${action} requires the imsg private API bridge. Run imsg launch, then openclaw channels status --probe to refresh capability detection.${reason}`,
        );
      }
    };
    const opts = {
      cliPath: cliPathForProbe,
      dbPath: account.config.dbPath?.trim() || undefined,
      remoteHost,
      timeoutMs: account.config.probeTimeoutMs,
    };
    const attestedConversationReadOrigin = conversationReadOrigin ?? "delegated";
    const chatGuid = async () =>
      await resolveChatGuid({
        action,
        actionParams: params,
        currentChannelId: toolContext?.currentChannelId,
        conversationReadOrigin: attestedConversationReadOrigin,
        runtime,
        options: opts,
      });
    const messageReference = async (input?: { messageId?: string; requireFromMe?: boolean }) => {
      const inputChatContext = buildChatContextFromActionParams({
        actionParams: params,
        currentChannelId: toolContext?.currentChannelId,
        service: account.config.service,
      });
      return await resolveAuthorizedIMessageActionReference({
        messageId: input?.messageId,
        inputChatContext,
        requireFromMe: input?.requireFromMe,
        resolveFallbackMessageId: (chatContext) =>
          readMessageIdWithChatFallback(params, { ...chatContext, accountId: account.accountId }),
        resolveMessageId: runtime.resolveIMessageMessageId,
        resolveChatGuid: chatGuid,
        authorize: (authorization) => runtime.authorizeMessageReference(authorization),
        authorization: {
          accountId: account.accountId,
          cliPath: opts.cliPath,
          dbPath: opts.dbPath,
          hasExclusiveLocalDatabase: hasExclusiveIMessageLocalDatabase({
            cfg,
            account,
            cliPath: opts.cliPath,
            dbPath: opts.dbPath,
            remoteHost: opts.remoteHost,
          }),
          remoteHost: opts.remoteHost,
          conversationReadOrigin: attestedConversationReadOrigin,
        },
      });
    };

    const completeOutboundBridgeMessage = async (
      result: { messageId: string },
      targetChatGuid: string,
      details?: Record<string, unknown>,
    ) => {
      const messageId = normalizeIMessageMessageId(result.messageId);
      if (messageId) {
        await rememberIMessageReplyCache({
          accountId: account.accountId,
          messageId,
          chatGuid: targetChatGuid,
          timestamp: Date.now(),
          isFromMe: true,
        });
      }
      return jsonResult({ ok: true, messageId: result.messageId, ...details });
    };

    await assertPrivateApiEnabled();

    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove an iMessage reaction.",
      });
      const reaction = mapTapbackReaction(emoji);
      const TAPBACK_KINDS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
      // Unknown removal fans out: the bridge no-ops tapback kinds that are absent.
      if (!remove && (isEmpty || !reaction)) {
        throw new Error(
          "iMessage react supports love, like, dislike, laugh, emphasize, and question tapbacks.",
        );
      }
      const partIndex = readNonNegativeIntegerParam(params, "partIndex");
      const reference = await messageReference();
      const reactionsToSend = remove && !reaction ? [...TAPBACK_KINDS] : reaction ? [reaction] : [];
      for (const kind of reactionsToSend) {
        await runtime.sendReaction({
          chatGuid: reference.chatGuid,
          messageId: reference.messageId,
          reaction: kind,
          remove: remove || undefined,
          partIndex,
          options: opts,
        });
      }
      return jsonResult({ ok: true, ...(remove ? { removed: true } : { added: reaction }) });
    }

    if (action === "edit") {
      const text =
        readStringParam(params, "text") ??
        readStringParam(params, "newText") ??
        readStringParam(params, "message");
      if (!text) {
        throw new Error("iMessage edit requires text, newText, or message.");
      }
      const partIndex = readNonNegativeIntegerParam(params, "partIndex");
      const backwardsCompatMessage = readStringParam(params, "backwardsCompatMessage");
      const reference = await messageReference({ requireFromMe: true });
      await runtime.editMessage({
        chatGuid: reference.chatGuid,
        messageId: reference.messageId,
        text,
        backwardsCompatMessage,
        partIndex,
        options: opts,
      });
      return jsonResult({ ok: true, edited: reference.messageId });
    }

    if (action === "unsend") {
      const partIndex = readNonNegativeIntegerParam(params, "partIndex");
      const reference = await messageReference({ requireFromMe: true });
      await runtime.unsendMessage({
        chatGuid: reference.chatGuid,
        messageId: reference.messageId,
        partIndex,
        options: opts,
      });
      return jsonResult({ ok: true, unsent: reference.messageId });
    }

    if (action === "reply") {
      const text = readMessageText(params);
      if (!text) {
        throw new Error("iMessage reply requires text or message.");
      }
      const reference = await messageReference();
      const attachment = extractReplyAttachment(params);
      if (attachment) {
        if (attachment.spec === null) {
          throw new Error(
            `iMessage reply rejected \`${attachment.bypassParam}\` because it did not pass through the outbound media resolver. ` +
              'Pass a base64 `buffer` + `filename` directly, or invoke message(action: "reply") through the runner so the resolver ' +
              "can validate the path against mediaLocalRoots/sandbox/size before sending.",
          );
        }
        // Older local imsg builds cannot attach files to send-rich; never drop the file.
        if (
          !opts.remoteHost &&
          privateApiStatus?.cliCapabilities?.sendRichSupportsAttachment !== true
        ) {
          throw new Error(
            "iMessage reply with an attachment needs an imsg build that exposes `send-rich --file` " +
              "(openclaw/imsg#114). Upgrade imsg, or use action 'upload-file' (with filePath/filename) " +
              "or action 'send' (with media) to deliver the file plus a separate 'reply' for any text.",
          );
        }
      }
      const partIndex = readNonNegativeIntegerParam(params, "partIndex");
      const result = await runtime.sendRichMessage({
        chatGuid: reference.chatGuid,
        text,
        replyToMessageId: reference.messageId,
        partIndex,
        attachment: attachment?.spec ?? undefined,
        options: opts,
      });
      return await completeOutboundBridgeMessage(result, reference.chatGuid, {
        repliedTo: reference.messageId,
      });
    }

    if (action === "sendWithEffect") {
      const text = readMessageText(params);
      const effectId = effectIdFromParam(
        readStringParam(params, "effectId") ?? readStringParam(params, "effect"),
      );
      if (!text || !effectId) {
        throw new Error("iMessage sendWithEffect requires text/message and effect/effectId.");
      }
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendRichMessage({
        chatGuid: resolvedChatGuid,
        text,
        effectId,
        options: opts,
      });
      return await completeOutboundBridgeMessage(result, resolvedChatGuid, { effect: effectId });
    }

    if (action === "renameGroup") {
      const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
      if (!displayName) {
        throw new Error("iMessage renameGroup requires displayName or name.");
      }
      const resolvedChatGuid = await chatGuid();
      await runtime.renameGroup({
        chatGuid: resolvedChatGuid,
        displayName,
        options: opts,
      });
      return jsonResult({ ok: true, renamed: resolvedChatGuid, displayName });
    }

    if (action === "setGroupIcon") {
      const filename =
        readStringParam(params, "filename") ?? readStringParam(params, "name") ?? "icon.png";
      const resolvedChatGuid = await chatGuid();
      await runtime.setGroupIcon({
        chatGuid: resolvedChatGuid,
        buffer: decodeBase64Buffer(params, action),
        filename,
        options: opts,
      });
      return jsonResult({ ok: true, chatGuid: resolvedChatGuid, iconSet: true });
    }

    if (action === "addParticipant" || action === "removeParticipant") {
      const address = readStringParam(params, "address") ?? readStringParam(params, "participant");
      if (!address) {
        throw new Error(`iMessage ${action} requires address or participant.`);
      }
      const resolvedChatGuid = await chatGuid();
      await runtime[action]({
        chatGuid: resolvedChatGuid,
        address,
        options: opts,
      });
      return jsonResult({
        ok: true,
        [action === "addParticipant" ? "added" : "removed"]: address,
        chatGuid: resolvedChatGuid,
      });
    }

    if (action === "leaveGroup") {
      const resolvedChatGuid = await chatGuid();
      await runtime.leaveGroup({
        chatGuid: resolvedChatGuid,
        options: opts,
      });
      return jsonResult({ ok: true, left: resolvedChatGuid });
    }

    if (action === "sendAttachment" || action === "upload-file") {
      const filename = readStringParam(params, "filename", { required: true });
      const asVoice = readBooleanParam(params, "asVoice");
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendAttachment({
        chatGuid: resolvedChatGuid,
        buffer: decodeBase64Buffer(params, action),
        filename,
        asVoice: asVoice ?? undefined,
        options: opts,
      });
      return await completeOutboundBridgeMessage(result, resolvedChatGuid);
    }

    if (action === "poll") {
      if (privateApiStatus?.selectors?.pollPayloadMessage !== true) {
        await probePrivateApiStatus(true);
      }
      if (privateApiStatus?.selectors?.pollPayloadMessage !== true) {
        throw new Error(
          "iMessage poll requires an imsg bridge that advertises the pollPayloadMessage selector. Update imsg, run imsg launch to re-inject the bridge, then run openclaw channels status --probe to refresh capability detection.",
        );
      }
      const question = readStringParam(params, "pollQuestion", { required: true });
      const rawChoices = readStringArrayParam(params, "pollOption", { required: true });
      const poll = normalizePollInput({ question, options: rawChoices }, { maxOptions: 12 });
      const resolvedChatGuid = await chatGuid();
      const result = await runtime.sendPoll({
        chatGuid: resolvedChatGuid,
        question: poll.question,
        choices: poll.options,
        options: opts,
      });
      return await completeOutboundBridgeMessage(result, resolvedChatGuid);
    }

    if (action === "poll-vote") {
      if (
        privateApiStatus?.selectors?.pollVoteMessage !== true ||
        !imessageRpcSupportsMethod(privateApiStatus, "poll.vote")
      ) {
        await probePrivateApiStatus(true);
      }
      if (privateApiStatus?.selectors?.pollVoteMessage !== true) {
        throw new Error(
          "iMessage poll-vote requires an imsg bridge that advertises the pollVoteMessage selector. Update imsg, run imsg launch to re-inject the bridge, then run openclaw channels status --probe to refresh capability detection.",
        );
      }
      // A previously injected helper can be newer than cliPath. The selector
      // proves native construction; rpc_methods proves this binary has vote.
      if (!imessageRpcSupportsMethod(privateApiStatus, "poll.vote")) {
        throw new Error(
          "iMessage poll-vote requires an imsg build that advertises the poll.vote capability. Update imsg, then run openclaw channels status --probe to refresh capability detection.",
        );
      }
      // An omitted reference means the current inbound poll, as for reactions.
      const pollRef =
        readStringParam(params, "pollId") ??
        readStringParam(params, "pollGuid") ??
        readStringParam(params, "messageId") ??
        (toolContext?.currentMessageId != null ? String(toolContext.currentMessageId) : undefined);
      if (!pollRef) {
        throw new Error("iMessage poll-vote requires the poll message id (pollId or messageId).");
      }
      // Require one selector so conflicting choices cannot silently win by precedence.
      const optionIndex = readPositiveIntegerParam(params, "pollOptionIndex");
      const optionId = readStringParam(params, "pollOptionId");
      const optionText = readStringParam(params, "pollOptionText");
      const selectorCount = [
        optionIndex !== undefined,
        Boolean(optionId),
        Boolean(optionText),
      ].filter(Boolean).length;
      if (selectorCount === 0) {
        throw new Error(
          "iMessage poll-vote requires pollOptionIndex, pollOptionId, or pollOptionText.",
        );
      }
      if (selectorCount > 1) {
        throw new Error(
          "iMessage poll-vote requires exactly one of pollOptionIndex, pollOptionId, or pollOptionText.",
        );
      }
      const pollReference = await messageReference({ messageId: pollRef });
      const result = await runtime.sendPollVote({
        chatGuid: pollReference.chatGuid,
        pollGuid: pollReference.messageId,
        optionIndex,
        optionId: optionId ?? undefined,
        optionText: optionText ?? undefined,
        options: opts,
      });
      return await completeOutboundBridgeMessage(
        result,
        pollReference.chatGuid,
        result.optionText ? { pollVotedOption: result.optionText } : undefined,
      );
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

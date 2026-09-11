// Matrix plugin module implements tool actions behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import {
  createActionGate,
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
  ToolAuthorizationError,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import {
  bootstrapMatrixVerification,
  acceptMatrixVerification,
  cancelMatrixVerification,
  confirmMatrixVerificationReciprocateQr,
  confirmMatrixVerificationSas,
  deleteMatrixMessage,
  editMatrixMessage,
  generateMatrixVerificationQr,
  getMatrixEncryptionStatus,
  getMatrixRoomKeyBackupStatus,
  getMatrixVerificationStatus,
  getMatrixMemberInfo,
  getMatrixRoomInfo,
  getMatrixVerificationSas,
  listMatrixEmojis,
  listMatrixPins,
  listMatrixReactions,
  listMatrixVerifications,
  mismatchMatrixVerificationSas,
  pinMatrixMessage,
  readMatrixMessages,
  requestMatrixVerification,
  restoreMatrixRoomKeyBackup,
  removeMatrixReactions,
  scanMatrixVerificationQr,
  sendMatrixMessage,
  startMatrixVerification,
  unpinMatrixMessage,
  voteMatrixPoll,
  verifyMatrixRecoveryKey,
} from "./matrix/actions.js";
import type { MatrixMessageSummary } from "./matrix/actions/types.js";
import { withAuthorizedMatrixReadTarget } from "./matrix/read-policy.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { reactMatrixMessage } from "./matrix/send.js";
import { applyMatrixProfileUpdate } from "./profile-update.js";
import type { CoreConfig, MatrixAccountConfig } from "./types.js";

function projectMatrixMessagesForDisplay(messages: readonly MatrixMessageSummary[]) {
  return messages.map((message) => ({
    ...message,
    ...(message.eventId ? { id: message.eventId } : {}),
    ...(message.sender ? { authorTag: message.sender } : {}),
    ...(message.body !== undefined ? { content: message.body } : {}),
    ...(typeof message.timestamp === "number" &&
    Number.isFinite(message.timestamp) &&
    Math.abs(message.timestamp) <= 8_640_000_000_000_000
      ? { ts: new Date(message.timestamp).toISOString() }
      : {}),
  }));
}

function readRoomId(params: Record<string, unknown>): string {
  const direct = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
  if (direct) {
    return direct;
  }
  return readStringParam(params, "to", { required: true });
}

function toSnakeCaseKey(key: string): string {
  return normalizeOptionalLowercaseString(
    key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  )!;
}

function readRawParam(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return params[snakeKey];
  }
  return undefined;
}

function readStringAliasParam(
  params: Record<string, unknown>,
  keys: string[],
  options: { required?: boolean } = {},
): string | undefined {
  for (const key of keys) {
    const raw = readRawParam(params, key);
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  if (options.required) {
    throw new Error(`${keys[0]} required`);
  }
  return undefined;
}

function readPositiveIntegerArrayParam(params: Record<string, unknown>, key: string): number[] {
  const raw = readRawParam(params, key);
  if (raw == null) {
    return [];
  }
  return (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
    if (value == null || value === "") {
      return [];
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }
      if (!/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(trimmed)) {
        return [];
      }
    }
    const index = readPositiveIntegerParam({ [key]: value }, key, {
      message: `${key} must contain positive integers.`,
    });
    return index === undefined ? [] : [index];
  });
}

export async function handleMatrixAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown>> {
  const { action, params } = ctx;
  const cfg = ctx.cfg as CoreConfig;

  // Keep each branch's validation order around account resolution and gating.
  // Some reaction checks intentionally run afterward.
  const prepareAction = (gate?: {
    name: keyof NonNullable<MatrixAccountConfig["actions"]>;
    disabledMessage: string;
  }) => {
    const accountParams =
      action === "poll-vote" || action === "permissions"
        ? { ...params, ...(ctx.accountId ? { accountId: ctx.accountId } : {}) }
        : { accountId: ctx.accountId };
    const accountId = readStringParam(accountParams, "accountId");
    const isActionEnabled = createActionGate(
      resolveMatrixAccountConfig({ cfg, accountId }).actions,
    );
    if (gate && !isActionEnabled(gate.name)) {
      throw new Error(gate.disabledMessage);
    }
    const clientOpts = { cfg, ...(accountId ? { accountId } : {}) };
    const withReadTarget = async <T>(
      roomId: string,
      run: (target: { roomId: string; client: MatrixClient }) => Promise<T>,
    ) =>
      await withAuthorizedMatrixReadTarget({
        cfg,
        accountId,
        roomId,
        context: {
          accountId: ctx.accountId,
          requesterAccountId: ctx.requesterAccountId,
          currentChannelId: ctx.toolContext?.currentChannelId,
          currentChannelProvider: ctx.toolContext?.currentChannelProvider,
          currentChatType: ctx.toolContext?.currentChatType,
          conversationReadOrigin: ctx.conversationReadOrigin,
        },
        opts: clientOpts,
        run,
      });
    return { accountId, clientOpts, withReadTarget };
  };

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    const mediaUrl =
      readStringParam(params, "media", { trim: false }) ??
      readStringParam(params, "mediaUrl", { trim: false }) ??
      readStringParam(params, "filePath", { trim: false }) ??
      readStringParam(params, "path", { trim: false });
    const content = readStringParam(params, "message", {
      required: !mediaUrl,
      allowEmpty: true,
      trim: false,
    });
    const replyToId = readStringParam(params, "replyTo");
    const threadId = readStringParam(params, "threadId");
    const audioAsVoice =
      typeof params.asVoice === "boolean"
        ? params.asVoice
        : typeof params.audioAsVoice === "boolean"
          ? params.audioAsVoice
          : undefined;
    const { clientOpts } = prepareAction({
      name: "messages",
      disabledMessage: "Matrix messages are disabled.",
    });
    const result = await sendMatrixMessage(to, content, {
      mediaUrl: mediaUrl ?? undefined,
      ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
      mediaLocalRoots: ctx.mediaLocalRoots,
      replyToId: replyToId ?? undefined,
      threadId: threadId ?? undefined,
      audioAsVoice,
      ...clientOpts,
    });
    return jsonResult({ ok: true, result });
  }

  if (action === "react") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const emojiValue = readStringParam(params, "emoji", { allowEmpty: true });
    const removeValue = typeof params.remove === "boolean" ? params.remove : undefined;
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction({
      name: "reactions",
      disabledMessage: "Matrix reactions are disabled.",
    });
    // Emoji-required and empty-remove errors follow the action gate; only the
    // public message/room selectors were validated before it.
    const { emoji, remove, isEmpty } = readReactionParams(
      { emoji: emojiValue, remove: removeValue },
      { removeErrorMessage: "Emoji is required to remove a Matrix reaction." },
    );
    if (remove || isEmpty) {
      const result = await withReadTarget(roomId, async (target) =>
        removeMatrixReactions(target.roomId, messageId, {
          ...clientOpts,
          client: target.client,
          emoji: remove ? emoji : undefined,
        }),
      );
      return jsonResult({ ok: true, removed: result.removed });
    }
    await withReadTarget(roomId, async (target) =>
      reactMatrixMessage(target.roomId, messageId, emoji, {
        ...clientOpts,
        client: target.client,
      }),
    );
    return jsonResult({ ok: true, added: emoji });
  }

  if (action === "reactions") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const limit = readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    });
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction({
      name: "reactions",
      disabledMessage: "Matrix reactions are disabled.",
    });
    const reactions = await withReadTarget(roomId, async (target) =>
      listMatrixReactions(target.roomId, messageId, {
        ...clientOpts,
        client: target.client,
        limit: limit ?? undefined,
      }),
    );
    return jsonResult({ ok: true, reactions });
  }

  if (action === "emoji-list") {
    const roomId =
      readStringParam(params, "roomId") ??
      readStringParam(params, "channelId") ??
      readStringParam(params, "to") ??
      (ctx.toolContext?.currentChannelProvider === "matrix"
        ? ctx.toolContext.currentChannelId
        : undefined);
    if (!roomId) {
      throw new Error("Matrix emoji-list requires a roomId or current Matrix conversation.");
    }
    const limit = readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    });
    const { clientOpts, withReadTarget } = prepareAction({
      name: "reactions",
      disabledMessage: "Matrix reactions are disabled.",
    });
    // The bound conversation bypasses the parameter reader above. Preserve
    // its late normalization and missing-room error after the action gate.
    const resolvedRoomId = readRoomId({ roomId });
    const emojis = await withReadTarget(resolvedRoomId, async (target) =>
      listMatrixEmojis(target.roomId, {
        ...clientOpts,
        client: target.client,
        limit,
      }),
    );
    return jsonResult({ ok: true, emojis });
  }

  if (action === "read") {
    const limit = readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    });
    const roomId = readRoomId(params);
    const before = readStringParam(params, "before");
    const after = readStringParam(params, "after");
    const threadId = readStringParam(params, "threadId");
    const { clientOpts, withReadTarget } = prepareAction({
      name: "messages",
      disabledMessage: "Matrix messages are disabled.",
    });
    const result = await withReadTarget(roomId, async (target) => {
      const messages = await readMatrixMessages(target.roomId, {
        limit: limit ?? undefined,
        before: before ?? undefined,
        after: after ?? undefined,
        threadId: threadId ?? undefined,
        ...clientOpts,
        client: target.client,
      });
      return {
        ...messages,
        messages: projectMatrixMessagesForDisplay(messages.messages),
        roomId: target.roomId,
        ...(threadId ? { threadId } : {}),
      };
    });
    return jsonResult({ ok: true, ...result });
  }

  if (action === "edit") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const content = readStringParam(params, "message", { required: true, trim: false });
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction({
      name: "messages",
      disabledMessage: "Matrix messages are disabled.",
    });
    const result = await withReadTarget(roomId, async (target) =>
      editMatrixMessage(target.roomId, messageId, content, {
        ...clientOpts,
        client: target.client,
      }),
    );
    return jsonResult({ ok: true, result });
  }

  if (action === "delete") {
    const messageId = readStringParam(params, "messageId", { required: true });
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction({
      name: "messages",
      disabledMessage: "Matrix messages are disabled.",
    });
    await withReadTarget(roomId, async (target) =>
      deleteMatrixMessage(target.roomId, messageId, {
        reason: undefined,
        ...clientOpts,
        client: target.client,
      }),
    );
    return jsonResult({ ok: true, deleted: true });
  }

  if (action === "pin" || action === "unpin" || action === "list-pins") {
    const request =
      action === "list-pins"
        ? { kind: "list" as const }
        : { kind: action, messageId: readStringParam(params, "messageId", { required: true }) };
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction({
      name: "pins",
      disabledMessage: "Matrix pins are disabled.",
    });
    return await withReadTarget(roomId, async (target) => {
      const actionOpts = { ...clientOpts, client: target.client };
      if (request.kind === "pin") {
        const result = await pinMatrixMessage(target.roomId, request.messageId, actionOpts);
        return jsonResult({ ok: true, pinned: result.pinned });
      }
      if (request.kind === "unpin") {
        const result = await unpinMatrixMessage(target.roomId, request.messageId, actionOpts);
        return jsonResult({ ok: true, pinned: result.pinned });
      }
      const result = await listMatrixPins(target.roomId, actionOpts);
      return jsonResult({
        ok: true,
        pinned: result.pinned,
        events: result.events,
        pins: projectMatrixMessagesForDisplay(result.events),
      });
    });
  }

  if (action === "set-profile") {
    if (ctx.senderIsOwner !== true) {
      throw new ToolAuthorizationError("Matrix profile updates require owner access.");
    }
    const avatarPath =
      readStringParam(params, "avatarPath") ??
      readStringParam(params, "path") ??
      readStringParam(params, "filePath");
    const displayName = readStringParam(params, "displayName") ?? readStringParam(params, "name");
    const avatarUrl = readStringParam(params, "avatarUrl");
    const { accountId } = prepareAction({
      name: "profile",
      disabledMessage: "Matrix profile updates are disabled.",
    });
    const result = await applyMatrixProfileUpdate({
      cfg,
      account: accountId,
      displayName,
      avatarUrl,
      avatarPath,
      mediaLocalRoots: ctx.mediaLocalRoots,
    });
    return jsonResult({ ok: true, ...result });
  }

  if (action === "member-info") {
    const userId = readStringParam(params, "userId", { required: true });
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction({
      name: "memberInfo",
      disabledMessage: "Matrix member info is disabled.",
    });
    const result = await withReadTarget(roomId, async (target) =>
      getMatrixMemberInfo(userId, { roomId: target.roomId, ...clientOpts, client: target.client }),
    );
    return jsonResult({ ok: true, member: result });
  }

  if (action === "channel-info") {
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction({
      name: "channelInfo",
      disabledMessage: "Matrix room info is disabled.",
    });
    const result = await withReadTarget(roomId, async (target) =>
      getMatrixRoomInfo(target.roomId, { ...clientOpts, client: target.client }),
    );
    return jsonResult({ ok: true, room: result });
  }

  if (action === "poll-vote") {
    const { clientOpts, withReadTarget } = prepareAction();
    const roomId = readRoomId(params);
    const pollId = readStringAliasParam(params, ["pollId", "messageId"], { required: true });
    if (!pollId) {
      throw new Error("pollId required");
    }
    const optionId = readStringParam(params, "pollOptionId");
    const optionIndex = readPositiveIntegerParam(params, "pollOptionIndex", {
      message: "pollOptionIndex must be a positive integer.",
    });
    const optionIds = [
      ...(readStringArrayParam(params, "pollOptionIds") ?? []),
      ...(optionId ? [optionId] : []),
    ];
    const optionIndexes = [
      ...readPositiveIntegerArrayParam(params, "pollOptionIndexes"),
      ...(optionIndex !== undefined ? [optionIndex] : []),
    ];
    const result = await withReadTarget(roomId, async (target) => {
      return await voteMatrixPoll(target.roomId, pollId, {
        ...clientOpts,
        client: target.client,
        optionIds,
        optionIndexes,
      });
    });
    return jsonResult({ ok: true, result });
  }

  if (action === "permissions") {
    if (ctx.senderIsOwner !== true) {
      throw new ToolAuthorizationError("Matrix verification actions require owner access.");
    }
    const operation = normalizeLowercaseStringOrEmpty(
      readStringParam(params, "operation") ??
        readStringParam(params, "mode") ??
        "verification-list",
    );
    const operationToAction: Record<string, string> = {
      "encryption-status": "encryptionStatus",
      "verification-status": "verificationStatus",
      "verification-bootstrap": "verificationBootstrap",
      "verification-recovery-key": "verificationRecoveryKey",
      "verification-backup-status": "verificationBackupStatus",
      "verification-backup-restore": "verificationBackupRestore",
      "verification-list": "verificationList",
      "verification-request": "verificationRequest",
      "verification-accept": "verificationAccept",
      "verification-cancel": "verificationCancel",
      "verification-start": "verificationStart",
      "verification-generate-qr": "verificationGenerateQr",
      "verification-scan-qr": "verificationScanQr",
      "verification-sas": "verificationSas",
      "verification-confirm": "verificationConfirm",
      "verification-mismatch": "verificationMismatch",
      "verification-confirm-qr": "verificationConfirmQr",
    };
    // The operation inventory is closed; inherited Object keys are not actions.
    if (!Object.hasOwn(operationToAction, operation)) {
      throw new Error(
        `Unsupported Matrix permissions operation: ${operation}. Supported values: ${Object.keys(
          operationToAction,
        ).join(", ")}`,
      );
    }

    const resolvedAction = operationToAction[operation];
    const { clientOpts } = prepareAction({
      name: "verification",
      disabledMessage: "Matrix verification actions are disabled.",
    });
    const requestId =
      readStringParam(params, "requestId") ??
      readStringParam(params, "verificationId") ??
      readStringParam(params, "id");

    if (resolvedAction === "encryptionStatus") {
      const includeRecoveryKey = params.includeRecoveryKey === true;
      const status = await getMatrixEncryptionStatus({ includeRecoveryKey, ...clientOpts });
      return jsonResult({ ok: true, status });
    }
    if (resolvedAction === "verificationStatus") {
      const includeRecoveryKey = params.includeRecoveryKey === true;
      const status = await getMatrixVerificationStatus({ includeRecoveryKey, ...clientOpts });
      return jsonResult({ ok: true, status });
    }
    if (resolvedAction === "verificationBootstrap") {
      const recoveryKey =
        readStringParam(params, "recoveryKey", { trim: false }) ??
        readStringParam(params, "key", { trim: false });
      const result = await bootstrapMatrixVerification({
        recoveryKey: recoveryKey ?? undefined,
        forceResetCrossSigning: params.forceResetCrossSigning === true,
        ...clientOpts,
      });
      return jsonResult({ ok: result.success, result });
    }
    if (resolvedAction === "verificationRecoveryKey") {
      const recoveryKey =
        readStringParam(params, "recoveryKey", { trim: false }) ??
        readStringParam(params, "key", { trim: false });
      const result = await verifyMatrixRecoveryKey(
        readStringParam({ recoveryKey }, "recoveryKey", { required: true, trim: false }),
        clientOpts,
      );
      return jsonResult({ ok: result.success, result });
    }
    if (resolvedAction === "verificationBackupStatus") {
      const status = await getMatrixRoomKeyBackupStatus(clientOpts);
      return jsonResult({ ok: true, status });
    }
    if (resolvedAction === "verificationBackupRestore") {
      const recoveryKey =
        readStringParam(params, "recoveryKey", { trim: false }) ??
        readStringParam(params, "key", { trim: false });
      const result = await restoreMatrixRoomKeyBackup({
        recoveryKey: recoveryKey ?? undefined,
        ...clientOpts,
      });
      return jsonResult({ ok: result.success, result });
    }
    if (resolvedAction === "verificationList") {
      const verifications = await listMatrixVerifications(clientOpts);
      return jsonResult({ ok: true, verifications });
    }
    if (resolvedAction === "verificationRequest") {
      const userId = readStringParam(params, "userId");
      const deviceId = readStringParam(params, "deviceId");
      const roomId = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
      const ownUser = typeof params.ownUser === "boolean" ? params.ownUser : undefined;
      const verification = await requestMatrixVerification({
        ownUser,
        userId: userId ?? undefined,
        deviceId: deviceId ?? undefined,
        roomId: roomId ?? undefined,
        ...clientOpts,
      });
      return jsonResult({ ok: true, verification });
    }
    if (resolvedAction === "verificationAccept") {
      const verification = await acceptMatrixVerification(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (resolvedAction === "verificationCancel") {
      const reason = readStringParam(params, "reason");
      const code = readStringParam(params, "code");
      const verification = await cancelMatrixVerification(
        readStringParam({ requestId }, "requestId", { required: true }),
        { reason: reason ?? undefined, code: code ?? undefined, ...clientOpts },
      );
      return jsonResult({ ok: true, verification });
    }
    if (resolvedAction === "verificationStart") {
      const methodRaw = readStringParam(params, "method");
      const method = normalizeOptionalLowercaseString(methodRaw);
      if (method && method !== "sas") {
        throw new Error(
          "Matrix verificationStart only supports method=sas; use verificationGenerateQr/verificationScanQr for QR flows.",
        );
      }
      const verification = await startMatrixVerification(
        readStringParam({ requestId }, "requestId", { required: true }),
        { method: "sas", ...clientOpts },
      );
      return jsonResult({ ok: true, verification });
    }
    if (resolvedAction === "verificationGenerateQr") {
      const qr = await generateMatrixVerificationQr(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, ...qr });
    }
    if (resolvedAction === "verificationScanQr") {
      const qrDataBase64 =
        readStringParam(params, "qrDataBase64") ??
        readStringParam(params, "qrData") ??
        readStringParam(params, "qr");
      const verification = await scanMatrixVerificationQr(
        readStringParam({ requestId }, "requestId", { required: true }),
        readStringParam({ qrDataBase64 }, "qrDataBase64", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (resolvedAction === "verificationSas") {
      const sas = await getMatrixVerificationSas(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, sas });
    }
    if (resolvedAction === "verificationConfirm") {
      const verification = await confirmMatrixVerificationSas(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (resolvedAction === "verificationMismatch") {
      const verification = await mismatchMatrixVerificationSas(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
    if (resolvedAction === "verificationConfirmQr") {
      const verification = await confirmMatrixVerificationReciprocateQr(
        readStringParam({ requestId }, "requestId", { required: true }),
        clientOpts,
      );
      return jsonResult({ ok: true, verification });
    }
  }

  throw new Error(`Action ${action} is not supported for provider matrix.`);
}

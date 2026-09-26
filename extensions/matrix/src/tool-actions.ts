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
  deleteMatrixMessage,
  editMatrixMessage,
  readMatrixMessage,
  readMatrixMessages,
  sendMatrixMessage,
} from "./matrix/actions/messages.js";
import { pinMatrixMessage, unpinMatrixMessage, listMatrixPins } from "./matrix/actions/pins.js";
import { voteMatrixPoll } from "./matrix/actions/polls.js";
import {
  listMatrixEmojis,
  listMatrixReactions,
  removeMatrixReactions,
} from "./matrix/actions/reactions.js";
import { getMatrixMemberInfo, getMatrixRoomInfo } from "./matrix/actions/room.js";
import type { MatrixMessageSummary } from "./matrix/actions/types.js";
import {
  bootstrapMatrixVerification,
  acceptMatrixVerification,
  cancelMatrixVerification,
  confirmMatrixVerificationReciprocateQr,
  confirmMatrixVerificationSas,
  generateMatrixVerificationQr,
  getMatrixEncryptionStatus,
  getMatrixRoomKeyBackupStatus,
  getMatrixVerificationStatus,
  getMatrixVerificationSas,
  listMatrixVerifications,
  mismatchMatrixVerificationSas,
  requestMatrixVerification,
  restoreMatrixRoomKeyBackup,
  scanMatrixVerificationQr,
  startMatrixVerification,
  verifyMatrixRecoveryKey,
} from "./matrix/actions/verification.js";
import { withAuthorizedMatrixReadTarget } from "./matrix/read-policy.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { reactMatrixMessage } from "./matrix/send.js";
import { applyMatrixProfileUpdate } from "./profile-update.js";
import type { CoreConfig, MatrixAccountConfig } from "./types.js";

const MATRIX_ACTION_DISABLED_MESSAGES = {
  messages: "Matrix messages are disabled.",
  reactions: "Matrix reactions are disabled.",
  pins: "Matrix pins are disabled.",
  profile: "Matrix profile updates are disabled.",
  memberInfo: "Matrix member info is disabled.",
  channelInfo: "Matrix room info is disabled.",
  verification: "Matrix verification actions are disabled.",
} satisfies Record<keyof NonNullable<MatrixAccountConfig["actions"]>, string>;

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
  const prepareAction = (gate?: keyof typeof MATRIX_ACTION_DISABLED_MESSAGES) => {
    const accountParams =
      action === "poll-vote" || action === "permissions"
        ? { ...params, ...(ctx.accountId ? { accountId: ctx.accountId } : {}) }
        : { accountId: ctx.accountId };
    const accountId = readStringParam(accountParams, "accountId");
    const isActionEnabled = createActionGate(
      resolveMatrixAccountConfig({ cfg, accountId }).actions,
    );
    if (gate && !isActionEnabled(gate)) {
      throw new Error(MATRIX_ACTION_DISABLED_MESSAGES[gate]);
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
    const { clientOpts } = prepareAction("messages");
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
    const { clientOpts, withReadTarget } = prepareAction("reactions");
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
    const { clientOpts, withReadTarget } = prepareAction("reactions");
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
    const { clientOpts, withReadTarget } = prepareAction("reactions");
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
    const messageId = readStringParam(params, "messageId");
    const { clientOpts, withReadTarget } = prepareAction("messages");
    const result = await withReadTarget(roomId, async (target) => {
      if (messageId) {
        const message = await readMatrixMessage(target.roomId, messageId, {
          ...clientOpts,
          client: target.client,
        });
        return {
          messages: projectMatrixMessagesForDisplay([message]),
          roomId: target.roomId,
        };
      }
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
    const { clientOpts, withReadTarget } = prepareAction("messages");
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
    const { clientOpts, withReadTarget } = prepareAction("messages");
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
    const { clientOpts, withReadTarget } = prepareAction("pins");
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
    const { accountId } = prepareAction("profile");
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
    const { clientOpts, withReadTarget } = prepareAction("memberInfo");
    const result = await withReadTarget(roomId, async (target) =>
      getMatrixMemberInfo(userId, { roomId: target.roomId, ...clientOpts, client: target.client }),
    );
    return jsonResult({ ok: true, member: result });
  }

  if (action === "channel-info") {
    const roomId = readRoomId(params);
    const { clientOpts, withReadTarget } = prepareAction("channelInfo");
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
    const operations: Record<string, () => Promise<AgentToolResult<unknown>>> = {
      "encryption-status": async () =>
        jsonResult({
          ok: true,
          status: await getMatrixEncryptionStatus({
            includeRecoveryKey: params.includeRecoveryKey === true,
            ...clientOpts,
          }),
        }),
      "verification-status": async () =>
        jsonResult({
          ok: true,
          status: await getMatrixVerificationStatus({
            includeRecoveryKey: params.includeRecoveryKey === true,
            ...clientOpts,
          }),
        }),
      "verification-bootstrap": async () => {
        const result = await bootstrapMatrixVerification({
          recoveryKey: readRecoveryKey(),
          forceResetCrossSigning: params.forceResetCrossSigning === true,
          ...clientOpts,
        });
        return jsonResult({ ok: result.success, result });
      },
      "verification-recovery-key": async () => {
        const recoveryKey = readRecoveryKey();
        const result = await verifyMatrixRecoveryKey(
          readStringParam({ recoveryKey }, "recoveryKey", { required: true, trim: false }),
          clientOpts,
        );
        return jsonResult({ ok: result.success, result });
      },
      "verification-backup-status": async () =>
        jsonResult({ ok: true, status: await getMatrixRoomKeyBackupStatus(clientOpts) }),
      "verification-backup-restore": async () => {
        const result = await restoreMatrixRoomKeyBackup({
          recoveryKey: readRecoveryKey(),
          ...clientOpts,
        });
        return jsonResult({ ok: result.success, result });
      },
      "verification-list": async () =>
        jsonResult({ ok: true, verifications: await listMatrixVerifications(clientOpts) }),
      "verification-request": async () => {
        const userId = readStringParam(params, "userId");
        const deviceId = readStringParam(params, "deviceId");
        const roomId = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
        const ownUser = typeof params.ownUser === "boolean" ? params.ownUser : undefined;
        const verification = await requestMatrixVerification({
          ownUser,
          userId,
          deviceId,
          roomId,
          ...clientOpts,
        });
        return jsonResult({ ok: true, verification });
      },
      "verification-accept": () => runVerification(acceptMatrixVerification),
      "verification-cancel": async () => {
        const reason = readStringParam(params, "reason");
        const code = readStringParam(params, "code");
        return runVerification((id, opts) =>
          cancelMatrixVerification(id, { reason, code, ...opts }),
        );
      },
      "verification-start": async () => {
        const method = normalizeOptionalLowercaseString(readStringParam(params, "method"));
        if (method && method !== "sas") {
          throw new Error(
            "Matrix verificationStart only supports method=sas; use verificationGenerateQr/verificationScanQr for QR flows.",
          );
        }
        return runVerification((id, opts) =>
          startMatrixVerification(id, { method: "sas", ...opts }),
        );
      },
      "verification-generate-qr": async () => {
        const qr = await generateMatrixVerificationQr(requireRequestId(), clientOpts);
        return jsonResult({ ok: true, ...qr });
      },
      "verification-scan-qr": async () => {
        const qrDataBase64 =
          readStringParam(params, "qrDataBase64") ??
          readStringParam(params, "qrData") ??
          readStringParam(params, "qr");
        return runVerification((id, opts) =>
          scanMatrixVerificationQr(
            id,
            readStringParam({ qrDataBase64 }, "qrDataBase64", { required: true }),
            opts,
          ),
        );
      },
      "verification-sas": async () =>
        jsonResult({
          ok: true,
          sas: await getMatrixVerificationSas(requireRequestId(), clientOpts),
        }),
      "verification-confirm": () => runVerification(confirmMatrixVerificationSas),
      "verification-mismatch": () => runVerification(mismatchMatrixVerificationSas),
      "verification-confirm-qr": () => runVerification(confirmMatrixVerificationReciprocateQr),
    };
    // Reject unknown operations before account resolution; inherited keys are not actions.
    const runOperation = Object.hasOwn(operations, operation) ? operations[operation] : undefined;
    if (!runOperation) {
      throw new Error(
        `Unsupported Matrix permissions operation: ${operation}. Supported values: ${Object.keys(
          operations,
        ).join(", ")}`,
      );
    }
    const { clientOpts } = prepareAction("verification");
    const requestId =
      readStringParam(params, "requestId") ??
      readStringParam(params, "verificationId") ??
      readStringParam(params, "id");
    const requireRequestId = () => readStringParam({ requestId }, "requestId", { required: true });
    const readRecoveryKey = () =>
      readStringParam(params, "recoveryKey", { trim: false }) ??
      readStringParam(params, "key", { trim: false });
    const runVerification = async (run: typeof acceptMatrixVerification) =>
      jsonResult({ ok: true, verification: await run(requireRequestId(), clientOpts) });
    return await runOperation();
  }

  throw new Error(`Action ${action} is not supported for provider matrix.`);
}

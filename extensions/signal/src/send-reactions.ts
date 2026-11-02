import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client-adapter.js";
import { normalizeSignalReactionRecipient } from "./normalize.js";
import { resolveSignalRpcContext } from "./rpc-context.js";
import type { SignalRpcOpts } from "./send.js";

export type SignalReactionOpts = SignalRpcOpts & {
  targetAuthor?: string;
  targetAuthorUuid?: string;
  groupId?: string;
  assertDirectAdapterHandoff?: () => void;
};

export type SignalReactionResult = {
  ok: boolean;
  timestamp?: number;
};

function createSignalReactionSender(remove: boolean) {
  return async (
    recipient: string,
    targetTimestamp: number,
    emoji: string,
    opts: SignalReactionOpts,
  ): Promise<SignalReactionResult> => {
    const cfg = requireRuntimeConfig(opts.cfg, "Signal reactions");
    const accountInfo = resolveSignalAccount({
      cfg,
      accountId: opts.accountId,
    });
    const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);

    const normalizedRecipient = normalizeSignalReactionRecipient(recipient);
    const groupId = opts.groupId?.trim();
    const operation = `Signal reaction${remove ? " removal" : ""}`;
    if (!normalizedRecipient && !groupId) {
      throw new Error(`Recipient or groupId is required for ${operation}`);
    }
    if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
      throw new Error(`Valid targetTimestamp is required for ${operation}`);
    }
    const normalizedEmoji = emoji?.trim();
    if (!normalizedEmoji) {
      throw new Error(`Emoji is required for ${operation}`);
    }

    const targetAuthor = [opts.targetAuthor, opts.targetAuthorUuid, normalizedRecipient]
      .map((candidate) => normalizeSignalReactionRecipient(candidate ?? ""))
      .find(Boolean);
    if (groupId && !targetAuthor) {
      throw new Error(`targetAuthor is required for group reaction${remove ? " removal" : "s"}`);
    }

    const requestParams: Record<string, unknown> = {
      emoji: normalizedEmoji,
      targetTimestamp,
      ...(remove ? { remove: true } : {}),
      ...(targetAuthor ? { targetAuthor } : {}),
    };
    if (normalizedRecipient) {
      requestParams.recipients = [normalizedRecipient];
    }
    if (groupId) {
      requestParams.groupIds = [groupId];
    }
    if (account) {
      requestParams.account = account;
    }

    const result = await signalRpcRequest<{ timestamp?: number }>("sendReaction", requestParams, {
      baseUrl,
      timeoutMs: opts.timeoutMs,
      transportKind: opts.transportKind ?? accountInfo.transport.kind,
      assertDirectAdapterHandoff: opts.assertDirectAdapterHandoff,
    });

    return {
      ok: true,
      timestamp: result?.timestamp,
    };
  };
}

export const sendReactionSignal = createSignalReactionSender(false);
export const removeReactionSignal = createSignalReactionSender(true);

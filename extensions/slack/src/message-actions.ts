import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractToolSend, type ChannelToolSend } from "openclaw/plugin-sdk/tool-send";
import { inspectSlackAccount } from "./account-inspect.js";
import { listSlackAccountIds } from "./accounts.js";
import { normalizeSlackThreadTsCandidate, resolveSlackThreadTsValue } from "./thread-ts.js";

export function listSlackMessageActions(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ChannelMessageActionName[] {
  const accounts = (
    accountId
      ? [inspectSlackAccount({ cfg, accountId })]
      : listSlackAccountIds(cfg).map((listedAccountId) =>
          inspectSlackAccount({ cfg, accountId: listedAccountId }),
        )
  ).filter(
    (account) =>
      account.enabled &&
      (account.identity === "user"
        ? account.userTokenStatus === "available"
        : account.botTokenStatus === "available"),
  );
  if (accounts.length === 0) {
    return [];
  }

  const gates = accounts.map((account) =>
    createActionGate(account.actions ?? cfg.channels?.slack?.actions),
  );
  const actions: ChannelMessageActionName[] = ["send"];
  for (const [gate, enabledActions] of [
    ["reactions", ["react", "reactions"]],
    [
      "messages",
      [
        "channel-create",
        "conversation-open",
        "read",
        "edit",
        "delete",
        "download-file",
        "upload-file",
      ],
    ],
    ["pins", ["pin", "unpin", "list-pins"]],
    ["memberInfo", ["member-info"]],
    ["emojiList", ["emoji-list"]],
  ] as const) {
    if (gates.some((isEnabled) => isEnabled(gate))) {
      actions.push(...enabledActions);
    }
  }
  return actions;
}

export function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null {
  const action = args.action;
  if (
    action !== "sendMessage" &&
    action !== "uploadFile" &&
    action !== "send" &&
    action !== "upload-file"
  ) {
    return null;
  }
  const extracted = extractToolSend(args, action);
  if (!extracted) {
    return null;
  }
  const nativeThreadTs =
    typeof args.threadTs === "string" ? normalizeSlackThreadTsCandidate(args.threadTs) : undefined;
  const replyTo =
    typeof args.replyTo === "string" ? normalizeSlackThreadTsCandidate(args.replyTo) : undefined;
  const threadTs =
    action === "send"
      ? resolveSlackThreadTsValue({ replyToId: replyTo, threadId: extracted.threadId })
      : action === "upload-file"
        ? (normalizeSlackThreadTsCandidate(extracted.threadId) ?? replyTo)
        : (nativeThreadTs ?? normalizeSlackThreadTsCandidate(extracted.threadId));
  const threadSuppressed =
    extracted.threadSuppressed === true || args.topLevel === true || args.threadTs === null;
  return {
    ...extracted,
    threadId: threadTs ?? extracted.threadId,
    ...(!threadTs && !extracted.threadId && !threadSuppressed ? { threadImplicit: true } : {}),
    ...(threadSuppressed ? { threadSuppressed: true } : {}),
  };
}

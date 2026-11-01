import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { RuntimeEnv } from "../runtime-api.js";
import { literalizeFeishuCardTables } from "./card-table-shapes.js";
import { resolveConfiguredHttpTimeoutMs } from "./client-timeout.js";
import { createFeishuClient } from "./client.js";
import { plainReasoningText } from "./reasoning-structure.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import type { ResolvedFeishuAccount } from "./types.js";

/** What a streaming card shows for `text`: off mode escapes its tables to literal rows. */
export function projectFeishuStreamingCardText(text: string, tableMode: MarkdownTableMode): string {
  return tableMode === "off" ? literalizeFeishuCardTables(text) : text;
}

/** Admit captured snapshots in order while the session owns provider writes. */
export function queueFeishuStreamingUpdate(params: {
  queue: Promise<void>;
  session: FeishuStreamingSession | null;
  startPromise: Promise<void> | null;
  text: string;
  tableMode: MarkdownTableMode;
  textChunkLimit: number;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { queue, session, startPromise, text, accountId, runtime } = params;
  // Keep authored state and receipt keys intact; only the card's display projection
  // escapes off-mode tables, including the separately accumulated reasoning stream.
  const displayed = projectFeishuStreamingCardText(text, params.tableMode);
  if (displayed !== text && displayed.length > params.textChunkLimit) {
    return queue;
  }
  return queue.then(async () => {
    if (startPromise) {
      await startPromise;
    }
    if (session?.isActive()) {
      // update admits pending text synchronously. Let the session own write ordering
      // and replacement; awaiting transport here would serialize obsolete snapshots.
      // Its retained write queue still propagates failures through awaited close/discard.
      void session
        .update(displayed)
        .catch((error: unknown) =>
          runtime.error(`feishu[${accountId}] streaming update failed: ${String(error)}`),
        );
    }
  });
}

export function mergeStreamingFinalText(
  previousText: string,
  nextText: string,
  appendError: boolean,
): string {
  if (!appendError || !previousText || nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.endsWith(`\n\n${nextText}`)) {
    return previousText;
  }
  return `${previousText}\n\n${nextText}`;
}

export const formatReasoningPrefix = (thinking: string): string => {
  if (!thinking) {
    return "";
  }
  const lines = plainReasoningText(thinking)
    .split("\n")
    .map((line) => `> ${line}`);
  return `> 💭 **Thinking**\n${lines.join("\n")}`;
};

export function createFeishuReplyStream(
  account: ResolvedFeishuAccount,
  runtime: RuntimeEnv,
  sendTarget: string,
  options: () => Parameters<FeishuStreamingSession["start"]>[2],
) {
  const creds =
    account.appId && account.appSecret
      ? {
          appId: account.appId,
          appSecret: account.appSecret,
          domain: account.domain,
          httpTimeoutMs: resolveConfiguredHttpTimeoutMs(account),
        }
      : null;
  if (!creds) {
    return undefined;
  }
  const session = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
    runtime.log(`feishu[${account.accountId}] ${message}`),
  );
  const streamingTarget = sendTarget
    .replace(/^(feishu|lark):/i, "")
    .replace(/^(chat|user|group|dm|open_id):/i, "")
    .trim();
  return {
    session,
    start: () => session.start(streamingTarget, resolveReceiveIdType(sendTarget), options()),
  };
}

export function combineFeishuStreamText(thinking: string, answer: string, status: string): string {
  const content = [thinking ? formatReasoningPrefix(thinking) : "", answer]
    .filter(Boolean)
    .join("\n\n---\n\n");
  return [content, status].filter(Boolean).join("\n\n");
}

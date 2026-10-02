import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";

export type DiscordUser = {
  id: string;
  username?: string;
  bot?: boolean;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  attachments?: DiscordAttachment[];
  content?: string;
  reactions?: DiscordReaction[];
  timestamp?: string;
  author?: DiscordUser;
  referenced_message?: { id?: string } | null;
};

type DiscordAttachment = {
  id?: string;
  filename?: string;
  size?: number;
  url?: string;
};

type DiscordReaction = {
  count?: number;
  emoji?: {
    id?: string | null;
    name?: string | null;
  };
  me?: boolean;
};

export type DiscordObservedMessage = {
  messageId: string;
  channelId: string;
  guildId?: string;
  senderId: string;
  senderIsBot: boolean;
  senderUsername?: string;
  scenarioId?: string;
  scenarioTitle?: string;
  matchedScenario?: boolean;
  text: string;
  triggerMessageId?: string;
  triggerTimestamp?: string;
  replyToMessageId?: string;
  timestamp?: string;
};

export type DiscordReactionSnapshot = {
  elapsedMs: number;
  observedAt: string;
  reactions: Array<{
    count: number;
    emoji: string;
    me: boolean;
  }>;
};

export function buildDiscordWebMessageUrl(params: {
  guildId: string;
  messageId?: string;
  threadId: string;
}) {
  return `https://discord.com/channels/${params.guildId}/${params.threadId}${
    params.messageId ? `/${params.messageId}` : ""
  }`;
}

export function normalizeDiscordObservedMessage(
  message: DiscordMessage,
): DiscordObservedMessage | null {
  if (!message.author?.id) {
    return null;
  }
  return {
    messageId: message.id,
    channelId: message.channel_id,
    guildId: message.guild_id,
    senderId: message.author.id,
    senderIsBot: message.author.bot === true,
    senderUsername: message.author.username,
    text: message.content ?? "",
    replyToMessageId: message.referenced_message?.id,
    timestamp: message.timestamp,
  };
}

function reactionEmojiName(reaction: DiscordReaction) {
  return reaction.emoji?.name?.trim() || reaction.emoji?.id?.trim() || "";
}

export function normalizeDiscordReactionSnapshot(params: {
  message: DiscordMessage;
  observedAt: Date;
  startedAtMs: number;
}): DiscordReactionSnapshot {
  return {
    elapsedMs: Math.max(0, params.observedAt.getTime() - params.startedAtMs),
    observedAt: params.observedAt.toISOString(),
    reactions: (params.message.reactions ?? [])
      .map((reaction) => ({
        emoji: reactionEmojiName(reaction),
        count: Math.max(0, Math.floor(reaction.count ?? 0)),
        me: reaction.me === true,
      }))
      .filter((reaction) => reaction.emoji.length > 0)
      .toSorted((a, b) => a.emoji.localeCompare(b.emoji)),
  };
}

export function collectSeenReactionSequence(
  snapshots: readonly DiscordReactionSnapshot[],
  expectedSequence: readonly string[],
) {
  const seen = new Set<string>();
  const sequence: string[] = [];
  for (const snapshot of snapshots) {
    const snapshotEmojis = new Set(snapshot.reactions.map((reaction) => reaction.emoji));
    for (const emoji of expectedSequence) {
      if (snapshotEmojis.has(emoji) && !seen.has(emoji)) {
        seen.add(emoji);
        sequence.push(emoji);
      }
    }
  }
  return sequence;
}

export function renderDiscordStatusReactionHtml(params: {
  expectedSequence: readonly string[];
  scenarioTitle: string;
  seenSequence: readonly string[];
  snapshots: readonly DiscordReactionSnapshot[];
}) {
  const rows = params.snapshots
    .map((snapshot) => {
      const reactions = snapshot.reactions
        .map(
          (reaction) =>
            `<span class="pill"><span class="emoji">${escapeHtml(reaction.emoji)}</span><span class="count">${reaction.count}</span></span>`,
        )
        .join("");
      return `<tr><td>${snapshot.elapsedMs}ms</td><td>${escapeHtml(snapshot.observedAt)}</td><td>${reactions || '<span class="muted">none</span>'}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(params.scenarioTitle)}</title>
  <style>
    body { margin: 0; background: #313338; color: #f2f3f5; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: 1040px; padding: 32px; }
    h1 { font-size: 26px; margin: 0 0 8px; font-weight: 700; letter-spacing: 0; }
    .sub { color: #b5bac1; margin-bottom: 24px; }
    .message { background: #2b2d31; border-left: 4px solid #5865f2; padding: 20px; border-radius: 8px; margin-bottom: 24px; }
    .author { color: #f2f3f5; font-weight: 700; margin-bottom: 8px; }
    .content { color: #dbdee1; line-height: 1.45; }
    .sequence { display: flex; gap: 12px; margin-top: 18px; align-items: center; }
    .step { background: #404249; border: 1px solid #4e5058; border-radius: 18px; padding: 7px 12px; font-size: 20px; min-width: 42px; text-align: center; }
    .step.seen { background: #1f3b2d; border-color: #2d7d46; }
    table { width: 100%; border-collapse: collapse; background: #2b2d31; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #404249; vertical-align: top; }
    th { color: #b5bac1; font-size: 13px; text-transform: uppercase; }
    .pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #4e5058; border-radius: 14px; padding: 4px 9px; margin: 0 8px 8px 0; background: #383a40; }
    .emoji { font-size: 18px; }
    .count { color: #b5bac1; font-size: 13px; }
    .muted { color: #949ba4; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.scenarioTitle)}</h1>
    <div class="sub">Expected: ${params.expectedSequence.map(escapeHtml).join(" → ")} · Seen: ${params.seenSequence.map(escapeHtml).join(" → ") || "none"}</div>
    <section class="message">
      <div class="author">Mantis Discord QA</div>
      <div class="content">Reaction timeline captured from the real Discord triggering message via REST polling.</div>
      <div class="sequence">
        ${params.expectedSequence
          .map(
            (emoji) =>
              `<span class="step ${params.seenSequence.includes(emoji) ? "seen" : ""}">${escapeHtml(emoji)}</span>`,
          )
          .join("")}
      </div>
    </section>
    <table>
      <thead><tr><th>Elapsed</th><th>Observed At</th><th>Reactions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

export function renderDiscordThreadReplyAttachmentHtml(params: {
  attachmentFilenames: readonly string[];
  expectedAttachmentFilename: string;
  messageContent?: string;
  scenarioTitle: string;
  status: "pass" | "fail";
  threadName: string;
}) {
  const hasAttachment = params.attachmentFilenames.includes(params.expectedAttachmentFilename);
  const attachmentRows =
    params.attachmentFilenames.length > 0
      ? params.attachmentFilenames
          .map((filename) => `<span class="attachment">${escapeHtml(filename)}</span>`)
          .join("")
      : '<span class="missing">No attachments on the SUT thread reply</span>';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(params.scenarioTitle)}</title>
  <style>
    body { margin: 0; background: #313338; color: #f2f3f5; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: 1040px; padding: 32px; }
    h1 { font-size: 26px; margin: 0 0 8px; font-weight: 700; letter-spacing: 0; }
    .sub { color: #b5bac1; margin-bottom: 24px; }
    .message { background: #2b2d31; border-left: 4px solid ${hasAttachment ? "#23a55a" : "#da373c"}; padding: 20px; border-radius: 8px; }
    .author { color: #f2f3f5; font-weight: 700; margin-bottom: 8px; }
    .content { color: #dbdee1; line-height: 1.45; margin-bottom: 16px; }
    .badge { display: inline-flex; align-items: center; border-radius: 16px; padding: 6px 10px; font-size: 13px; font-weight: 700; background: ${hasAttachment ? "#1f3b2d" : "#4a2527"}; border: 1px solid ${hasAttachment ? "#2d7d46" : "#a1282e"}; color: #f2f3f5; margin-bottom: 18px; }
    .attachments { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
    .attachment { display: inline-flex; align-items: center; gap: 8px; border: 1px solid #5865f2; background: #202136; color: #cfd4ff; border-radius: 6px; padding: 10px 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .attachment::before { content: "file"; color: #b5bac1; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 12px; text-transform: uppercase; }
    .missing { color: #ffb4b4; border: 1px solid #a1282e; background: #3a2023; border-radius: 6px; padding: 10px 12px; }
    .expected { color: #b5bac1; margin-top: 18px; font-size: 14px; }
    code { color: #f2f3f5; background: #1e1f22; border-radius: 4px; padding: 2px 5px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(params.scenarioTitle)}</h1>
    <div class="sub">Thread: ${escapeHtml(params.threadName)}</div>
    <section class="message">
      <div class="author">OpenClaw Discord SUT</div>
      <div class="badge">${params.status === "pass" ? "Attachment found" : "Attachment missing"}</div>
      <div class="content">${escapeHtml(params.messageContent ?? "No SUT reply content captured")}</div>
      <div class="attachments">${attachmentRows}</div>
      <div class="expected">Expected attachment: <code>${escapeHtml(params.expectedAttachmentFilename)}</code></div>
    </section>
  </main>
</body>
</html>`;
}

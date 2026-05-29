import { handleDiscordMessageAction } from "../extensions/discord/src/actions/handle-action.js";
/**
 * Repro script for PR #81243: action: "fetch" for Discord single-message retrieval.
 *
 * Calls handleDiscordMessageAction directly to prove the fetch action works
 * end-to-end against the real Discord API, without needing a full gateway boot.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=<token> DISCORD_CHANNEL_ID=<id> DISCORD_MESSAGE_ID=<id> \
 *     node --import tsx scripts/repro-fetch.ts
 *   DISCORD_BOT_TOKEN=<token> DISCORD_MESSAGE_URL=<url> \
 *     node --import tsx scripts/repro-fetch.ts
 *
 * DISCORD_BOT_TOKEN is read from env only — never from config files, never printed.
 * Redact all IDs before pasting output into PR bodies.
 */
import type { OpenClawConfig } from "../src/config/types.js";

const channelId = process.env.DISCORD_CHANNEL_ID?.trim();
const messageId = process.env.DISCORD_MESSAGE_ID?.trim();
const messageUrl = process.env.DISCORD_MESSAGE_URL?.trim();

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("Error: DISCORD_BOT_TOKEN env var is required");
  process.exit(1);
}
if (!messageUrl && (!channelId || !messageId)) {
  console.error("Error: set DISCORD_MESSAGE_URL or both DISCORD_CHANNEL_ID + DISCORD_MESSAGE_ID");
  process.exit(1);
}

// Minimal config — token is picked up from DISCORD_BOT_TOKEN env by the Discord extension.
const cfg = { channels: { discord: { enabled: true } } } as unknown as OpenClawConfig;

const params: Record<string, string> = {};
if (messageUrl) {
  params.url = messageUrl;
} else {
  params.channelId = channelId!;
  params.messageId = messageId!;
}

console.log(`Branch: ${process.env.GIT_BRANCH ?? "(current)"}`);
console.log(
  `Calling handleDiscordMessageAction({ action: "fetch", params: ${JSON.stringify(params)} })`,
);
console.log();

try {
  const result = await handleDiscordMessageAction({
    action: "fetch",
    params,
    cfg,
    accountId: null,
    requesterSenderId: null,
    toolContext: undefined,
    mediaAccess: undefined,
    mediaLocalRoots: undefined,
    mediaReadFile: undefined,
  });
  console.log("--- result ---");
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("--- error ---");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

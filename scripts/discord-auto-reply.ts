import { exec } from "node:child_process";
import process from "node:process";
import { fetchDiscord } from "../src/discord/api.js";
import { normalizeDiscordToken } from "../src/discord/token.js";

// --- Configuration ---
const POLLING_INTERVAL_MS = 10_000;
const CHANNEL_NAME_TARGET = "general";

// --- Types ---
type DiscordUser = {
  id: string;
  username: string;
  discriminator: string;
};

type DiscordGuild = {
  id: string;
  name: string;
};

type DiscordChannel = {
  id: string;
  name: string;
  type: number;
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  author: DiscordUser;
  content: string;
  mentions: DiscordUser[];
  referenced_message?: DiscordMessage | null;
  timestamp: string;
};

// --- State ---
const processedMessageIds = new Set<string>();

async function main() {
  const token = normalizeDiscordToken(process.env.DISCORD_TOKEN);
  if (!token) {
    console.error("Error: DISCORD_TOKEN is not set.");
    process.exit(1);
  }

  console.log("Starting Discord Auto-Reply Bot (System Event Trigger)...");

  // 1. Get Self User
  const me = await fetchDiscord<DiscordUser>("/users/@me", token);
  console.log(`Logged in as: ${me.username} (${me.id})`);

  // 2. Find Guild and Channel
  const guilds = await fetchDiscord<DiscordGuild[]>("/users/@me/guilds", token);
  if (guilds.length === 0) {
    console.error("Error: Bot is not in any guilds.");
    process.exit(1);
  }

  let targetChannelId: string | undefined;
  let targetGuildName: string | undefined;

  // Simple search for the first channel matching TARGET in any guild
  for (const guild of guilds) {
    const channels = await fetchDiscord<DiscordChannel[]>(`/guilds/${guild.id}/channels`, token);
    const match = channels.find(
      (c) => c.name.toLowerCase() === CHANNEL_NAME_TARGET.toLowerCase() && c.type === 0, // 0 = GUILD_TEXT
    );
    if (match) {
      targetChannelId = match.id;
      targetGuildName = guild.name;
      break;
    }
  }

  if (!targetChannelId) {
    console.error(`Error: Could not find channel '#${CHANNEL_NAME_TARGET}' in any guild.`);
    process.exit(1);
  }

  console.log(`Listening in: ${targetGuildName} -> #${CHANNEL_NAME_TARGET} (${targetChannelId})`);

  // 3. Polling Loop
  setInterval(async () => {
    try {
      await pollMessages(token, me.id, targetChannelId);
    } catch (err) {
      console.error("Polling error:", err);
    }
  }, POLLING_INTERVAL_MS);
}

async function pollMessages(token: string, myId: string, channelId: string) {
  // Fetch latest messages
  const messages = await fetchDiscord<DiscordMessage[]>(
    `/channels/${channelId}/messages?limit=10`,
    token,
  );

  // Sort by time ascending so we process oldest first if multiple
  messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const msg of messages) {
    // Skip my own messages
    if (msg.author.id === myId) {
      continue;
    }

    // Skip if already processed
    if (processedMessageIds.has(msg.id)) {
      continue;
    }

    // Check conditions:
    // A. Mentioned me directly
    const isMentioned = msg.mentions.some((u) => u.id === myId);

    // B. Replied to one of my messages
    const isReplyToMe = msg.referenced_message?.author.id === myId;

    if (isMentioned || isReplyToMe) {
      console.log(`Found relevant message from ${msg.author.username}: "${msg.content}"`);

      await triggerOpenClawEvent(msg.author.username, msg.content);

      // Mark as processed
      processedMessageIds.add(msg.id);
    }
  }
}

async function triggerOpenClawEvent(author: string, content: string) {
  // Escape quotes in content to avoid shell issues (basic)
  const safeContent = content.replace(/"/g, '\\"');
  // Use global CLI command
  const command = `openclaw system event --text "Discord Message from ${author}: ${safeContent}" --mode now`;

  console.log(`Triggering agent: ${command}`);

  exec(command, (error, stdout, _stderr) => {
    if (error) {
      console.error(`Error triggering event: ${error.message}`);
      return;
    }
    console.log(`Event trigger stdout: ${stdout}`);
  });
}

main().catch(console.error);

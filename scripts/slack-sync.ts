#!/usr/bin/env -S node --import tsx
/**
 * Slack Channel History Sync
 *
 * Fetches new messages from monitored Slack channels since lastSyncAt and
 * appends them to ~/.openclaw/cache/slack/{channelId}.json. Designed to run
 * daily via LaunchAgent but safe to run more frequently (deduplicates by ts).
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/slack-sync.ts              # sync all configured channels
 *   pnpm exec tsx scripts/slack-sync.ts --force      # ignore lastSyncAt, fetch last 90 days
 *
 * Requires: SLACK_BOT_TOKEN in env, or channels.slack.botToken in ~/.openclaw/openclaw.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(homedir(), ".openclaw", "cache", "slack");
const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
const SLACK_API = "https://slack.com/api";

function formatCaught(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  bot_id?: string;
  [key: string]: unknown;
}

interface SlackMeta {
  lastSyncAt: string;
  channels: Record<string, { messageCount: number; lastTs: string | null }>;
}

interface ChannelConfig {
  id: string;
  name: string;
}

// Monitored channels: performance grading + ops monitoring.
// Rep-specific channels should be added here once configured.
const MONITORED_CHANNELS: ChannelConfig[] = [
  { id: "C0AB50H2K9R", name: "#corporate-operations" },
  // Add rep channels below as they are configured:
  // { id: "C_EXAMPLE1", name: "#rep-john-doe" },
];

function resolveBotToken(): string {
  if (process.env.SLACK_BOT_TOKEN) {
    return process.env.SLACK_BOT_TOKEN;
  }

  // Extract botToken from config via regex (avoids JSON5 parsing issues)
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const match = raw.match(/"botToken"\s*:\s*"(xoxb-[^"]+)"/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // fall through
  }

  for (const envPath of [join(process.cwd(), ".env"), join(homedir(), ".openclaw", ".env")]) {
    try {
      const content = readFileSync(envPath, "utf-8");
      const match = content.match(/^SLACK_BOT_TOKEN=(.+)$/m);
      if (match?.[1]) {
        return match[1].trim();
      }
    } catch {
      // skip
    }
  }

  throw new Error("SLACK_BOT_TOKEN not found in env, config, or .env files");
}

const BOT_TOKEN = resolveBotToken();

async function slackApi<T>(method: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Slack API ${method} HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API ${method} error: ${data.error}`);
  }
  return data;
}

function loadMeta(): SlackMeta {
  const metaPath = join(CACHE_DIR, "meta.json");
  if (existsSync(metaPath)) {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  }
  return { lastSyncAt: "", channels: {} };
}

function saveMeta(meta: SlackMeta): void {
  writeFileSync(join(CACHE_DIR, "meta.json"), JSON.stringify(meta, null, 2));
}

function loadChannelCache(channelId: string): SlackMessage[] {
  const path = join(CACHE_DIR, `${channelId}.json`);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return [];
}

function saveChannelCache(channelId: string, messages: SlackMessage[]): void {
  writeFileSync(join(CACHE_DIR, `${channelId}.json`), JSON.stringify(messages, null, 2));
}

interface ConversationsHistoryResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
}

async function fetchChannelHistory(channelId: string, oldest?: string): Promise<SlackMessage[]> {
  const all: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string | number> = {
      channel: channelId,
      limit: 200,
    };
    if (oldest) {
      params.oldest = oldest;
    }
    if (cursor) {
      params.cursor = cursor;
    }

    const data = await slackApi<ConversationsHistoryResponse>("conversations.history", params);
    all.push(...(data.messages ?? []));

    cursor = data.response_metadata?.next_cursor;
    if (cursor && !cursor.trim()) {
      cursor = undefined;
    }

    if (data.has_more && cursor) {
      await new Promise((r) => setTimeout(r, 500));
    }
  } while (cursor);

  return all;
}

async function syncChannel(
  channel: ChannelConfig,
  meta: SlackMeta,
  force: boolean,
): Promise<number> {
  const existing = loadChannelCache(channel.id);
  const existingTs = new Set(existing.map((m) => m.ts));

  // Determine oldest timestamp to fetch from
  let oldest: string | undefined;
  if (force) {
    const ninetyDaysAgo = (Date.now() / 1000 - 90 * 86400).toFixed(6);
    oldest = ninetyDaysAgo;
  } else if (meta.channels[channel.id]?.lastTs) {
    oldest = meta.channels[channel.id].lastTs!;
  } else if (meta.lastSyncAt) {
    oldest = (new Date(meta.lastSyncAt).getTime() / 1000).toFixed(6);
  } else {
    // First run: fetch last 90 days
    const ninetyDaysAgo = (Date.now() / 1000 - 90 * 86400).toFixed(6);
    oldest = ninetyDaysAgo;
  }

  console.log(`  fetching ${channel.name} (${channel.id}) since ${oldest ?? "beginning"}...`);
  const newMessages = await fetchChannelHistory(channel.id, oldest);

  // Deduplicate and merge
  let added = 0;
  for (const msg of newMessages) {
    if (!existingTs.has(msg.ts)) {
      existing.push(msg);
      existingTs.add(msg.ts);
      added++;
    }
  }

  // Sort by ts ascending
  existing.sort((a, b) => Number(a.ts) - Number(b.ts));

  saveChannelCache(channel.id, existing);

  // Update meta for this channel
  const lastTs = existing.length > 0 ? existing[existing.length - 1].ts : null;
  meta.channels[channel.id] = {
    messageCount: existing.length,
    lastTs,
  };

  return added;
}

async function main() {
  const force = process.argv.includes("--force");
  const startMs = Date.now();

  console.log(`Slack Sync — ${new Date().toISOString()}`);
  console.log(`Cache dir: ${CACHE_DIR}`);
  console.log(`Channels: ${MONITORED_CHANNELS.map((c) => c.name).join(", ")}`);
  if (force) {
    console.log("Mode: --force (fetching last 90 days)");
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  const meta = loadMeta();
  let totalAdded = 0;

  for (const channel of MONITORED_CHANNELS) {
    try {
      const added = await syncChannel(channel, meta, force);
      console.log(
        `  ${channel.name}: +${added} new messages (${meta.channels[channel.id].messageCount} total)`,
      );
      totalAdded += added;
    } catch (err) {
      console.error(`  ${channel.name}: FAILED — ${formatCaught(err)}`);
    }
  }

  meta.lastSyncAt = new Date().toISOString();
  saveMeta(meta);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `\nDone in ${elapsed}s — ${totalAdded} new messages across ${MONITORED_CHANNELS.length} channels`,
  );
}

main().catch((err) => {
  console.error("Slack sync failed:", err);
  process.exit(1);
});

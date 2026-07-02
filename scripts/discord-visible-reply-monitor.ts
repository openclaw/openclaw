#!/usr/bin/env node
// Monitors Discord channel turns for human prompts that did not get a visible bot reply.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDiscordRestClient } from "../extensions/discord/src/client.js";
import { getCurrentUser } from "../extensions/discord/src/internal/api.users.js";
import { readMessagesDiscord } from "../extensions/discord/src/send.messages.js";
import { sendMessageDiscord } from "../extensions/discord/src/send.outbound.js";
import { readConfigFileSnapshot } from "../src/config/config.js";
import {
  analyzeVisibleReplyGaps,
  filterUnalertedGaps,
  formatVisibleReplyGapAlert,
  type DiscordVisibleReplyMessage,
} from "./lib/discord-visible-reply-monitor.js";

type MonitorState = {
  alertedPromptIds?: string[];
};

type Args = {
  channelId: string;
  alertTarget: string;
  accountId?: string;
  token?: string;
  thresholdMs: number;
  limit: number;
  statePath: string;
  botUserIds: Set<string>;
  promptAuthorIds: Set<string>;
  dryRun: boolean;
};

const DEFAULT_CHANNEL_ID = "1468361476585558210"; // #fiducian-chat
const DEFAULT_ALERT_TARGET = "channel:1473914995309023417"; // #task-notifications
const DEFAULT_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_LIMIT = 50;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await readConfigFileSnapshot({ suppressFutureVersionWarning: true });
  const cfg = snapshot.config;
  const botUserIds = new Set(args.botUserIds);
  const token = normalizeOptionalToken(args.token ?? process.env.DISCORD_BOT_TOKEN);
  if (botUserIds.size === 0) {
    const { rest } = createDiscordRestClient({ cfg, accountId: args.accountId, token });
    const me = await getCurrentUser(rest);
    botUserIds.add(me.id);
  }

  const rawMessages = await readMessagesDiscord(
    args.channelId,
    { limit: args.limit },
    { cfg, accountId: args.accountId, token },
  );
  const messages = rawMessages as DiscordVisibleReplyMessage[];
  const state = await readState(args.statePath);
  const alertedPromptIds = new Set(state.alertedPromptIds ?? []);
  const gaps = filterUnalertedGaps({
    gaps: analyzeVisibleReplyGaps({
      messages,
      thresholdMs: args.thresholdMs,
      botUserIds,
      promptAuthorIds: args.promptAuthorIds,
    }),
    alertedPromptIds,
  });

  for (const gap of gaps) {
    const alert = formatVisibleReplyGapAlert({ channelId: args.channelId, gap });
    if (args.dryRun) {
      process.stdout.write(`${alert}\n`);
    } else {
      await sendMessageDiscord(args.alertTarget, alert, {
        cfg,
        accountId: args.accountId,
        token,
        silent: true,
      });
    }
    alertedPromptIds.add(gap.promptId);
  }

  await writeState(args.statePath, { alertedPromptIds: [...alertedPromptIds].slice(-500) });
  process.stdout.write(
    JSON.stringify({ ok: true, checked: messages.length, gaps: gaps.length, dryRun: args.dryRun }) +
      "\n",
  );
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    if (arg === "--dry-run") {
      flags.add(arg);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    values.set(arg, next);
    i += 1;
  }
  const thresholdMin = parsePositiveNumber(
    values.get("--threshold-min") ?? process.env.OPENCLAW_VISIBLE_REPLY_THRESHOLD_MIN,
    DEFAULT_THRESHOLD_MS / 60_000,
  );
  return {
    channelId: normalizeChannelId(
      values.get("--channel") ?? process.env.OPENCLAW_VISIBLE_REPLY_CHANNEL ?? DEFAULT_CHANNEL_ID,
    ),
    alertTarget:
      values.get("--alert-target") ??
      process.env.OPENCLAW_VISIBLE_REPLY_ALERT_TARGET ??
      DEFAULT_ALERT_TARGET,
    accountId: values.get("--account") ?? process.env.OPENCLAW_VISIBLE_REPLY_ACCOUNT,
    token: values.get("--token") ?? process.env.OPENCLAW_VISIBLE_REPLY_DISCORD_TOKEN,
    thresholdMs: Math.round(thresholdMin * 60_000),
    limit: Math.floor(parsePositiveNumber(values.get("--limit"), DEFAULT_LIMIT)),
    statePath:
      values.get("--state") ??
      process.env.OPENCLAW_VISIBLE_REPLY_STATE ??
      path.join(os.homedir(), ".openclaw", "discord-visible-reply-monitor.json"),
    botUserIds: parseIdSet(
      values.get("--bot-user-id") ?? process.env.OPENCLAW_VISIBLE_REPLY_BOT_USER_IDS,
    ),
    promptAuthorIds: parseIdSet(
      values.get("--prompt-author-id") ?? process.env.OPENCLAW_VISIBLE_REPLY_PROMPT_AUTHOR_IDS,
    ),
    dryRun: flags.has("--dry-run"),
  };
}

function normalizeChannelId(input: string): string {
  return input.trim().replace(/^channel:/u, "");
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, got ${raw}`);
  }
  return parsed;
}

function normalizeOptionalToken(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function parseIdSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

async function readState(statePath: string): Promise<MonitorState> {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8")) as MonitorState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function writeState(statePath: string, state: MonitorState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
});

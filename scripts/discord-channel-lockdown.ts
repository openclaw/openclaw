/**
 * Discord Channel Permission Lockdown Script
 *
 * Denies SendMessages permission for bot accounts in channels NOT in their allowlist.
 * This is a defense-in-depth measure — even if the code-level guard fails, bots
 * physically cannot send to channels they shouldn't touch.
 *
 * Usage:
 *   node --import tsx scripts/discord-channel-lockdown.ts              # dry-run
 *   node --import tsx scripts/discord-channel-lockdown.ts --apply      # execute
 *   node --import tsx scripts/discord-channel-lockdown.ts --rollback <file>  # undo
 */

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig } from "../src/config/config.js";
import { loadConfig } from "../src/config/config.js";
import {
  listEnabledDiscordAccounts,
  type ResolvedDiscordAccount,
} from "../src/discord/accounts.js";
import { enforceOutboundAllowlist } from "../src/discord/send.outbound-allowlist.js";
import { DiscordSendError } from "../src/discord/send.types.js";

// Discord permission bit for SendMessages.
const SEND_MESSAGES_BIT = 1n << 11n; // 2048

// Message-capable channel types. Skip containers (Category, Forum, Media, Directory).
const MESSAGE_CAPABLE_TYPES = new Set([
  0, // GuildText
  2, // GuildVoice (has text chat)
  5, // GuildAnnouncement
  13, // GuildStageVoice (has text chat)
]);

type PermissionOverwrite = {
  id: string;
  type: number; // 0 = role, 1 = member
  allow: string;
  deny: string;
};

type ChannelInfo = {
  id: string;
  guild_id?: string;
  type: number;
  name?: string;
  parent_id?: string;
  permission_overwrites?: PermissionOverwrite[];
};

type RollbackEntry = {
  channelId: string;
  channelName?: string;
  botUserId: string;
  accountId: string;
  guildId: string;
  before: { allow: string; deny: string } | null;
  after: { allow: string; deny: string };
};

type ActionRow = {
  accountId: string;
  guildName: string;
  guildId: string;
  channelName: string;
  channelId: string;
  channelType: number;
  action: "deny" | "allow" | "skip";
  reason: string;
  beforeDeny?: string;
  afterDeny?: string;
};

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const rollbackIdx = args.indexOf("--rollback");
  const rollbackFile = rollbackIdx !== -1 ? args[rollbackIdx + 1] : undefined;
  return { apply, rollbackFile };
}

async function fetchJson<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord API ${path}: ${res.status} ${res.statusText} ${body}`);
  }
  return res.json() as Promise<T>;
}

async function putPermissionOverwrite(
  token: string,
  channelId: string,
  targetId: string,
  allow: string,
  deny: string,
): Promise<void> {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/permissions/${targetId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: 1, allow, deny }), // type 1 = member
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Discord API PUT /channels/${channelId}/permissions/${targetId}: ${res.status} ${res.statusText} ${body}`,
    );
  }
}

async function getBotUserId(token: string): Promise<string> {
  const me = await fetchJson<{ id: string }>(token, "/users/@me");
  return me.id;
}

async function getGuildChannels(token: string, guildId: string): Promise<ChannelInfo[]> {
  return fetchJson<ChannelInfo[]>(token, `/guilds/${guildId}/channels`);
}

async function getBotGuilds(token: string): Promise<Array<{ id: string; name: string }>> {
  return fetchJson<Array<{ id: string; name: string }>>(token, "/users/@me/guilds");
}

function isChannelAllowed(params: {
  cfg: OpenClawConfig;
  account: ResolvedDiscordAccount;
  guildId: string;
  guildName: string;
  channelId: string;
  channelName?: string;
  isThread: boolean;
  parentChannelId?: string;
  parentChannelName?: string;
}): boolean {
  try {
    enforceOutboundAllowlist({
      cfg: params.cfg,
      accountId: params.account.accountId,
      channelId: params.channelId,
      channelName: params.channelName,
      guildId: params.guildId,
      guildName: params.guildName,
      isDm: false,
      isThread: params.isThread,
      parentChannelId: params.parentChannelId,
      parentChannelName: params.parentChannelName,
    });
    return true;
  } catch (err) {
    if (err instanceof DiscordSendError && err.kind === "outbound-blocked") {
      return false;
    }
    throw err;
  }
}

function formatTable(rows: ActionRow[]): string {
  if (rows.length === 0) {
    return "No channels to process.";
  }

  const headers = ["Account", "Guild", "Channel", "Type", "Action", "Reason", "Deny Before→After"];
  const data = rows.map((r) => [
    r.accountId,
    `${r.guildName} (${r.guildId})`,
    `${r.channelName} (${r.channelId})`,
    String(r.channelType),
    r.action,
    r.reason,
    r.action === "deny" ? `${r.beforeDeny ?? "0"} → ${r.afterDeny ?? "0"}` : "-",
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => (row[i] ?? "").length)),
  );
  const sep = widths.map((w) => "-".repeat(w)).join(" | ");
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join(" | ");
  const dataLines = data.map((row) =>
    row.map((cell, i) => (cell ?? "").padEnd(widths[i])).join(" | "),
  );
  return [headerLine, sep, ...dataLines].join("\n");
}

async function runLockdown(apply: boolean): Promise<void> {
  const cfg = loadConfig();
  const accounts = listEnabledDiscordAccounts(cfg);

  if (accounts.length === 0) {
    console.log("No enabled Discord accounts found.");
    return;
  }

  const policy = cfg.channels?.defaults?.groupPolicy;
  console.log(`\nGlobal default groupPolicy: ${policy ?? "(not set)"}`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}\n`);

  const allActions: ActionRow[] = [];
  const rollbackEntries: RollbackEntry[] = [];

  for (const account of accounts) {
    const accountPolicy = account.config.groupPolicy ?? policy ?? "open";
    console.log(`\n--- Account: ${account.accountId} (policy: ${accountPolicy}) ---`);

    if (!account.token) {
      console.log(`  SKIP: No token available for account "${account.accountId}"`);
      continue;
    }

    if (accountPolicy === "open") {
      console.log("  SKIP: groupPolicy is 'open' — no lockdown needed.");
      continue;
    }

    const botUserId = await getBotUserId(account.token);
    console.log(`  Bot user ID: ${botUserId}`);

    const guilds = await getBotGuilds(account.token);
    console.log(`  Guilds: ${guilds.length}`);

    for (const guild of guilds) {
      const channels = await getGuildChannels(account.token, guild.id);
      const channelNameById = new Map(
        channels.map((channel) => [channel.id, channel.name]).filter(([id]) => Boolean(id)),
      );

      for (const channel of channels) {
        if (!MESSAGE_CAPABLE_TYPES.has(channel.type)) {
          allActions.push({
            accountId: account.accountId,
            guildName: guild.name,
            guildId: guild.id,
            channelName: channel.name ?? "?",
            channelId: channel.id,
            channelType: channel.type,
            action: "skip",
            reason: "non-message channel type",
          });
          continue;
        }

        const isThread = channel.type === 11 || channel.type === 12 || channel.type === 10;
        const parentChannelId =
          typeof channel.parent_id === "string" ? channel.parent_id : undefined;
        const parentChannelName = parentChannelId
          ? channelNameById.get(parentChannelId)
          : undefined;
        const allowed = isChannelAllowed({
          cfg,
          account,
          guildId: guild.id,
          guildName: guild.name,
          channelId: channel.id,
          channelName: channel.name,
          isThread,
          parentChannelId,
          parentChannelName: parentChannelName ?? undefined,
        });

        if (allowed) {
          allActions.push({
            accountId: account.accountId,
            guildName: guild.name,
            guildId: guild.id,
            channelName: channel.name ?? "?",
            channelId: channel.id,
            channelType: channel.type,
            action: "allow",
            reason: "in allowlist",
          });
          continue;
        }

        // Channel NOT in allowlist — deny SendMessages.
        const existingOverwrite = channel.permission_overwrites?.find((ow) => ow.id === botUserId);
        const existingDeny = BigInt(existingOverwrite?.deny ?? "0");
        const existingAllow = BigInt(existingOverwrite?.allow ?? "0");

        // Merge deny bits: preserve existing + add SendMessages.
        const newDeny = existingDeny | SEND_MESSAGES_BIT;

        if (newDeny === existingDeny) {
          allActions.push({
            accountId: account.accountId,
            guildName: guild.name,
            guildId: guild.id,
            channelName: channel.name ?? "?",
            channelId: channel.id,
            channelType: channel.type,
            action: "skip",
            reason: "SendMessages already denied",
          });
          continue;
        }

        rollbackEntries.push({
          channelId: channel.id,
          channelName: channel.name,
          botUserId,
          accountId: account.accountId,
          guildId: guild.id,
          before: existingOverwrite
            ? { allow: existingOverwrite.allow, deny: existingOverwrite.deny }
            : null,
          after: { allow: existingAllow.toString(), deny: newDeny.toString() },
        });

        allActions.push({
          accountId: account.accountId,
          guildName: guild.name,
          guildId: guild.id,
          channelName: channel.name ?? "?",
          channelId: channel.id,
          channelType: channel.type,
          action: "deny",
          reason: "not in allowlist",
          beforeDeny: existingDeny.toString(),
          afterDeny: newDeny.toString(),
        });

        if (apply) {
          await putPermissionOverwrite(
            account.token,
            channel.id,
            botUserId,
            existingAllow.toString(),
            newDeny.toString(),
          );
          console.log(
            `  APPLIED: ${channel.name} (${channel.id}) — deny ${existingDeny} → ${newDeny}`,
          );
        } else {
          console.log(
            `  WOULD DENY: ${channel.name} (${channel.id}) — deny ${existingDeny} → ${newDeny}`,
          );
        }
      }
    }
  }

  // Write rollback snapshot.
  if (rollbackEntries.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rollbackPath = join(process.cwd(), "scripts", `lockdown-rollback-${timestamp}.json`);
    writeFileSync(rollbackPath, JSON.stringify(rollbackEntries, null, 2));
    console.log(`\nRollback file written to: ${rollbackPath}`);
  }

  // Print summary table.
  console.log("\n=== Summary ===\n");
  console.log(formatTable(allActions));

  const denyCount = allActions.filter((a) => a.action === "deny").length;
  const allowCount = allActions.filter((a) => a.action === "allow").length;
  const skipCount = allActions.filter((a) => a.action === "skip").length;
  console.log(`\nTotal: ${denyCount} deny, ${allowCount} allow, ${skipCount} skip`);
}

async function runRollback(rollbackFile: string): Promise<void> {
  const raw = readFileSync(rollbackFile, "utf-8");
  const entries = JSON.parse(raw) as RollbackEntry[];

  if (entries.length === 0) {
    console.log("Rollback file is empty.");
    return;
  }

  const cfg = loadConfig();
  const accounts = listEnabledDiscordAccounts(cfg);
  const tokenByAccount = new Map(accounts.map((a) => [a.accountId, a.token]));

  console.log(`Rolling back ${entries.length} permission overwrites...\n`);

  for (const entry of entries) {
    const token = tokenByAccount.get(entry.accountId);
    if (!token) {
      console.log(`  SKIP: No token for account "${entry.accountId}" (channel ${entry.channelId})`);
      continue;
    }

    if (entry.before === null) {
      // No previous overwrite existed — remove the overwrite entirely.
      const res = await fetch(
        `https://discord.com/api/v10/channels/${entry.channelId}/permissions/${entry.botUserId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bot ${token}` },
        },
      );
      if (res.ok) {
        console.log(`  REVERTED: ${entry.channelName ?? entry.channelId} — removed overwrite`);
      } else {
        console.log(`  FAILED: ${entry.channelName ?? entry.channelId} — DELETE ${res.status}`);
      }
    } else {
      // Restore previous overwrite.
      await putPermissionOverwrite(
        token,
        entry.channelId,
        entry.botUserId,
        entry.before.allow,
        entry.before.deny,
      );
      console.log(
        `  REVERTED: ${entry.channelName ?? entry.channelId} — restored deny=${entry.before.deny}`,
      );
    }
  }

  console.log("\nRollback complete.");
}

async function main() {
  const { apply, rollbackFile } = parseArgs();

  if (rollbackFile) {
    await runRollback(rollbackFile);
  } else {
    await runLockdown(apply);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

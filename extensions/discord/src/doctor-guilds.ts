import type { DiscordGuildEntry, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { inspectDiscordAccount } from "./account-inspect.js";
import { listDiscordAccountIds } from "./accounts.js";
import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS } from "./api.js";
import { listGuilds } from "./guilds.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";

type GuildScope = {
  guilds: Record<string, DiscordGuildEntry>;
  accountKey?: string;
  entry: DiscordGuildEntry;
  name: string;
  path: string;
};

export function namedGuildRules(cfg: OpenClawConfig): GuildScope[] {
  const discord = cfg.channels?.discord;
  const rules: GuildScope[] = [];
  const add = (guilds: Record<string, DiscordGuildEntry> | undefined, accountKey?: string) => {
    if (!guilds) {
      return;
    }
    for (const [name, entry] of Object.entries(guilds)) {
      if (name === "*" || /^\d+$/.test(name)) {
        continue;
      }
      const scope =
        accountKey === undefined
          ? "channels.discord"
          : `channels.discord.accounts[${JSON.stringify(accountKey)}]`;
      rules.push({
        guilds,
        accountKey,
        entry,
        name,
        path: `${scope}.guilds[${JSON.stringify(name)}]`.replace(/\p{Cc}/gu, " "),
      });
    }
  };
  if (discord) {
    add(discord.guilds);
    for (const [key, account] of Object.entries(discord.accounts ?? {})) {
      add(account.guilds, key);
    }
  }
  return rules;
}

export function guildIdGuidance(path: string, doctorFixCommand: string): string {
  return `- ${path} uses a server name. Rename the key to the numeric server ID in your config or run "${doctorFixCommand}" interactively.`;
}

export async function findDiscordGuildPauses(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const rules = namedGuildRules(cfg);
  const changes: Array<{ rule: GuildScope; accountId: string; ids: string[] }> = [];
  const warnings: string[] = [];
  if (!rules.length) {
    return { changes, warnings };
  }
  for (const accountId of listDiscordAccountIds(cfg)) {
    const account = inspectDiscordAccount({ cfg, accountId, envToken: env.DISCORD_BOT_TOKEN });
    const effectiveRules = rules.filter(({ guilds }) => guilds === account.config.guilds);
    if (!account.enabled || !effectiveRules.length) {
      continue;
    }
    let guilds;
    try {
      if (!account.token) {
        throw new Error("Discord token unavailable");
      }
      const { createNonExitingRuntime } = await import("openclaw/plugin-sdk/runtime-env");
      const { resolveDiscordRestFetch } = await import("./monitor/rest-fetch.js");
      guilds = await listGuilds(
        account.token,
        resolveDiscordRestFetch(account.config.proxy, createNonExitingRuntime()),
        {
          allPages: true,
          timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS,
        },
      );
    } catch {
      warnings.push(
        `- Discord account ${JSON.stringify(accountId)}: could not check the server directory for name collisions. Check the bot credentials and connection, or replace the name keys with server IDs manually.`,
      );
      continue;
    }
    for (const rule of effectiveRules) {
      const slug = normalizeDiscordSlug(rule.name);
      const matches = new Set(guilds.filter((g) => slug && g.slug === slug).map((g) => g.id));
      const paused = rule.entry.doctorPausedGuildIds?.[accountId] ?? [];
      if (matches.size > 1 || paused.length > 0) {
        const ids = [...new Set([...paused, ...matches])].toSorted();
        if (ids.some((id) => !paused.includes(id))) {
          changes.push({ rule, accountId, ids });
        } else {
          warnings.push(
            `- Discord account ${accountId}: server access remains paused for ${rule.path}. ${guildIdGuidance(rule.path, "openclaw doctor --fix").slice(2)}`,
          );
        }
      }
    }
  }
  return { changes, warnings };
}

export function applyDiscordGuildPauses(
  cfg: OpenClawConfig,
  changes: Awaited<ReturnType<typeof findDiscordGuildPauses>>["changes"],
): string[] {
  const notes: string[] = [];
  for (const { rule, accountId, ids } of changes) {
    const discord = cfg.channels?.discord;
    const scope = rule.accountKey === undefined ? discord : discord?.accounts?.[rule.accountKey];
    const entry = scope?.guilds?.[rule.name];
    if (!entry) {
      throw new Error(
        `Discord rule ${rule.path} changed during the server directory check. Run Doctor again.`,
      );
    }
    entry.doctorPausedGuildIds = { ...entry.doctorPausedGuildIds, [accountId]: ids };
    notes.push(
      `Discord account ${accountId}: paused servers ${ids.join(", ")} for ${rule.path}. To resume, rename the rule to the intended numeric server ID in your config or run "openclaw doctor --fix" interactively.`,
    );
  }
  return notes;
}

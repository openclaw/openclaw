import type { DiscordGuildEntry } from "openclaw/plugin-sdk/config-contracts";
import {
  patchScopedAccountConfig,
  promptChannelAccessConfig,
  WizardCancelledError,
} from "openclaw/plugin-sdk/setup";
import { createSetupTranslator, type ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import { terminalText } from "openclaw/plugin-sdk/terminal-safe-text";
import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS, fetchDiscord } from "./api.js";
import { isDiscordThreadChannelType } from "./channel-type.js";
import {
  fetchDiscordGuildsPage,
  listDiscordGuildChannels,
  type DiscordGuild,
  type DiscordGuildChannel,
} from "./guilds.js";
import { normalizeDiscordDisplaySlug, normalizeDiscordSlug } from "./monitor/allow-list.js";
import { parseDiscordAllowlistInput } from "./resolve-allowlist-common.js";
import { fetchChannel } from "./resolve-channels.js";
import { resolveDiscordSetupAccountConfig } from "./setup-account-state.js";
import { normalizeDiscordToken, resolveDiscordToken } from "./token.js";

const t = createSetupTranslator();
type SelectedChannel = {
  id: string;
  name?: string | null;
  type?: number;
  parentId?: string | null;
};
type Selection = { guild: DiscordGuild; channel?: SelectedChannel };
type Lookup = Selection | { reason: string; requireGuild?: boolean };
const timeout = { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS };
const isNumericId = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

function matchesConfiguredName(key: string, name: string) {
  // Startup can resolve legacy keys by their ASCII or Unicode display slug.
  return (
    [normalizeDiscordSlug, normalizeDiscordDisplaySlug].some((normalize) => {
      const slug = normalize(key);
      return slug !== "" && slug === normalize(name);
    }) || key === name
  );
}

// A numeric entry must not take precedence over an authored name or wildcard rule.
async function wouldShadowRule(
  token: string,
  guilds: Record<string, DiscordGuildEntry>,
  namedGuilds: string[],
  { guild, channel }: Selection,
) {
  const existing = guilds[guild.id];
  if (existing && (!channel || existing.channels?.[channel.id])) {
    return false;
  }
  const aliases = namedGuilds.filter(
    (key) =>
      matchesConfiguredName(key, guild.name) ||
      parseDiscordAllowlistInput(key, "channel").guildId === guild.id,
  );
  if (!existing && (aliases.length || guilds["*"])) {
    return true;
  }
  const keys = [guild.id, ...aliases].flatMap((key) => Object.keys(guilds[key]?.channels ?? {}));
  if (!channel || !keys.length) {
    return false;
  }
  const covers = (target: SelectedChannel) =>
    keys.some(
      (key) =>
        key === "*" ||
        key === target.id ||
        key === target.name ||
        (!isNumericId(key) && (!target.name || matchesConfiguredName(key, target.name))),
    );
  if (covers(channel)) {
    return true;
  }
  if (!isDiscordThreadChannelType(channel.type)) {
    return false;
  }
  // An explicit thread entry also takes precedence over its parent's rule.
  if (!isNumericId(channel.parentId) || keys.includes(channel.parentId)) {
    return true;
  }
  const parent = await fetchChannel(token, fetch, channel.parentId);
  return parent.status !== "found" || parent.channel.guildId !== guild.id || covers(parent.channel);
}

function setupDirectory(token: string, hasNamedGuilds: boolean) {
  let directory: Promise<DiscordGuild[]> | undefined;
  const channels = new Map<string, Promise<DiscordGuildChannel[]>>();
  return async (
    parsed: ReturnType<typeof parseDiscordAllowlistInput>,
    selectedGuild?: string,
  ): Promise<Lookup> => {
    const guildId = selectedGuild ?? parsed.guildId;
    let channelQuery = parsed.name;
    if (parsed.id) {
      const result = await fetchChannel(token, fetch, parsed.id);
      // An ID-scoped numeric channel name (e.g. 111/2024) is a supported input.
      if (result.status === "not-found" && guildId) {
        channelQuery = parsed.id;
      } else if (
        result.status !== "found" ||
        result.channel.id !== parsed.id ||
        !isNumericId(result.channel.guildId) ||
        (guildId && guildId !== result.channel.guildId)
      ) {
        return { reason: "Channel ID could not be verified in the selected server." };
      } else {
        const id = result.channel.guildId;
        const guild = hasNamedGuilds
          ? await fetchDiscord<DiscordGuild>(`/guilds/${id}`, token, fetch, timeout)
          : { id, name: "" };
        if (guild.id !== id || (hasNamedGuilds && !guild.name)) {
          return { reason: "Could not check the server against existing named rules." };
        }
        return { guild, channel: result.channel };
      }
    }

    let guilds: DiscordGuild[];
    if (guildId) {
      if (!isNumericId(guildId)) {
        return { reason: "Enter a numeric server ID.", requireGuild: true };
      }
      const guild = await fetchDiscord<DiscordGuild>(`/guilds/${guildId}`, token, fetch, timeout);
      if (guild.id !== guildId || !guild.name) {
        return { reason: "Server ID could not be verified." };
      }
      guilds = [guild];
    } else {
      // A bot may belong to more guilds than the 200 returned by this endpoint.
      // A full or incomplete page cannot establish that a name is unique.
      directory ??= fetchDiscordGuildsPage(token, fetch, timeout);
      guilds = await directory;
      if (guilds.length >= 200 || guilds.some((g) => !isNumericId(g.id) || !g.name)) {
        return { reason: "Discord returned an incomplete server list.", requireGuild: true };
      }
      if (parsed.guild) {
        const slug = normalizeDiscordDisplaySlug(parsed.guild);
        guilds = guilds.filter(
          (g) => g.name === parsed.guild || (slug && normalizeDiscordDisplaySlug(g.name) === slug),
        );
        if (guilds.length > 1) {
          return { reason: "Multiple servers match this name.", requireGuild: true };
        }
      }
    }
    if (parsed.guildOnly) {
      return guilds[0] ? { guild: guilds[0] } : { reason: "No matching server." };
    }
    const name = (channelQuery ?? "").replace(/^#/, "");
    const slug = normalizeDiscordDisplaySlug(name);
    let match: Selection | undefined;
    for (const guild of guilds) {
      let pending = channels.get(guild.id);
      if (!pending) {
        pending = listDiscordGuildChannels(token, fetch, guild.id);
        channels.set(guild.id, pending);
      }
      for (const channel of await pending) {
        if (!isNumericId(channel.id) || typeof channel.name !== "string") {
          return {
            reason: "Discord returned an incomplete channel list.",
            requireGuild: !guildId && !parsed.guild,
          };
        }
        if (
          channel.id !== name &&
          channel.name !== name &&
          (!slug || normalizeDiscordDisplaySlug(channel.name) !== slug)
        ) {
          continue;
        }
        if (match) {
          return guildId || parsed.guild
            ? { reason: "Multiple channels match in this server. Enter the channel ID." }
            : { reason: "Multiple channels match. Select the server first.", requireGuild: true };
        }
        match = { guild, channel: { id: channel.id, name: channel.name } };
      }
    }
    return match ?? { reason: "No matching channel." };
  };
}

export const configureDiscordGuildAccess: NonNullable<ChannelSetupWizard["finalize"]> = async ({
  cfg,
  accountId,
  credentialValues,
  prompter,
}) => {
  const title = t("wizard.discord.allowlistTitle");
  const account = resolveDiscordSetupAccountConfig({ cfg, accountId }).config;
  const currentPolicy = account.groupPolicy ?? cfg.channels?.defaults?.groupPolicy;
  const guilds = { ...account.guilds };
  const hasGuilds = Object.keys(guilds).length > 0;
  const previouslyEmpty = !hasGuilds && (currentPolicy ?? "allowlist") === "allowlist";
  const confirmEmpty = async () => {
    await prompter.note("An empty Discord allowlist blocks all server messages.", title);
    if (
      await prompter.confirm({
        message: "Finish with an empty Discord allowlist?",
        initialValue: false,
      })
    ) {
      return true;
    }
    if (previouslyEmpty) {
      throw new WizardCancelledError("Discord setup cancelled at the empty allowlist warning.");
    }
    return false;
  };
  const access = await promptChannelAccessConfig({
    prompter,
    label: t("wizard.discord.channelsLabel"),
    currentPolicy: currentPolicy ?? "allowlist",
    defaultPrompt: !hasGuilds,
    updatePrompt: Boolean(account.guilds),
    placeholder: "My Server, My Server/#general, #support, guild:<id>, channel ID",
  });
  if (!access) {
    if (previouslyEmpty) {
      await confirmEmpty();
    }
    return { cfg };
  }
  const patch = (changes: { groupPolicy: typeof access.policy; guilds?: typeof guilds }) => ({
    cfg: patchScopedAccountConfig({
      cfg,
      accountId,
      channelKey: "discord",
      patch: changes,
      scopeDefaultToAccounts: Boolean(cfg.channels?.discord?.accounts),
    }),
  });
  if (access.policy !== "allowlist") {
    return patch({ groupPolicy: access.policy });
  }

  let token =
    resolveDiscordToken(cfg, { accountId }).token ||
    normalizeDiscordToken(credentialValues.token, "channels.discord.token");
  const namedGuilds = Object.keys(guilds).filter((key) => key !== "*" && !isNumericId(key));
  let lookup = token ? setupDirectory(token, namedGuilds.length > 0) : undefined;
  let added = 0;
  let matched = 0;
  for (const entry of access.entries) {
    let input = entry;
    let selectedGuild: string | undefined;
    for (;;) {
      const parsed = parseDiscordAllowlistInput(
        input.replace(/^(?:guild|server):(\d+)\//i, "$1/"),
        "channel",
      );
      let result: Lookup;
      try {
        result = lookup
          ? await lookup(parsed, selectedGuild)
          : { reason: "No bot token is available for lookup." };
        if (
          "guild" in result &&
          token &&
          (await wouldShadowRule(token, guilds, namedGuilds, result))
        ) {
          result = {
            reason:
              "A numeric entry would override an existing rule. Keep or edit that rule in your configuration.",
          };
        }
      } catch {
        result = {
          reason: "Discord lookup failed. Verify the bot token and its access to the server.",
          requireGuild: !selectedGuild && !parsed.id && !parsed.guildId,
        };
      }
      if ("guild" in result) {
        const { guild, channel } = result;
        const existing = guilds[guild.id];
        const alreadyPresent = channel
          ? Boolean(existing?.channels?.[channel.id])
          : Boolean(existing);
        if (!alreadyPresent) {
          guilds[guild.id] = channel
            ? { ...existing, channels: { ...existing?.channels, [channel.id]: { enabled: true } } }
            : {};
          added++;
        }
        matched++;
        const target =
          terminalText`${guild.name} (guild:${guild.id})` +
          (channel ? terminalText` / #${channel.name} (${channel.id})` : "");
        await prompter.note(
          terminalText`${entry} → ${target} — ${alreadyPresent ? "already configured" : "added"}`,
          title,
        );
        break;
      }
      await prompter.note(
        terminalText`${entry}: ${result.reason}${result.requireGuild ? " Enter guild:<id> to select the intended server." : ""}`,
        title,
      );
      const action = await prompter.select({
        message: "Resolve this entry?",
        options: [
          { value: "retry", label: "Retry lookup" },
          { value: "skip", label: "Skip this entry" },
        ],
      });
      if (action === "skip") {
        break;
      }
      if (!token) {
        token = normalizeDiscordToken(
          await prompter.text({
            message: "This account’s bot token (used only for this lookup)",
            sensitive: true,
          }),
          "channels.discord.token",
        );
      } else if (result.requireGuild) {
        const raw = await prompter.text({
          message: "Server ID (guild:<id>)",
          validate: (v) => (/^guild:\d+$/i.test(v.trim()) ? undefined : "Enter guild:<id>."),
        });
        selectedGuild = raw.trim().slice("guild:".length);
      } else {
        input = (
          await prompter.text({ message: "Retry with this server or channel", initialValue: input })
        ).trim();
        selectedGuild = undefined;
      }
      lookup = token ? setupDirectory(token, namedGuilds.length > 0) : undefined;
    }
  }
  await prompter.note(
    `Added ${added} allowlist entries. Skipped ${access.entries.length - matched}.`,
    title,
  );
  const skippedEdit =
    !added && matched < access.entries.length && (currentPolicy || account.guilds);
  if (!matched && !hasGuilds && (!skippedEdit || previouslyEmpty)) {
    if (!(await confirmEmpty())) {
      return { cfg };
    }
  }
  if (skippedEdit) {
    await prompter.note("Kept the previous Discord access settings.", title);
    return { cfg };
  }
  return patch({ groupPolicy: "allowlist", ...(added ? { guilds } : {}) });
};

import { patchScopedAccountConfig, promptChannelAccessConfig } from "openclaw/plugin-sdk/setup";
import { createSetupTranslator, type ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import { terminalText } from "openclaw/plugin-sdk/terminal-safe-text";
import { DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS, fetchDiscord } from "./api.js";
import {
  fetchDiscordGuildsPage,
  listDiscordGuildChannels,
  type DiscordGuild,
  type DiscordGuildChannel,
} from "./guilds.js";
import { normalizeDiscordDisplaySlug } from "./monitor/allow-list.js";
import { parseDiscordAllowlistInput } from "./resolve-allowlist-common.js";
import { fetchChannel } from "./resolve-channels.js";
import { resolveDiscordSetupAccountConfig } from "./setup-account-state.js";
import { normalizeDiscordToken, resolveDiscordToken } from "./token.js";

const t = createSetupTranslator();
type Selection = { guild: DiscordGuild; channel?: { id: string; name?: string | null } };
type Lookup = Selection | { reason: string; requireGuild?: boolean };
const timeout = { timeoutMs: DISCORD_DIRECTORY_LOOKUP_TIMEOUT_MS };
const isNumericId = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);

function setupDirectory(token: string) {
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
        return { guild: { id: result.channel.guildId, name: "" }, channel: result.channel };
      }
    }

    let guilds: DiscordGuild[];
    if (guildId) {
      if (!isNumericId(guildId)) {
        return { reason: "Enter a numeric server ID.", requireGuild: true };
      }
      const guild = await fetchDiscord<DiscordGuild>(`/guilds/${guildId}`, token, fetch, timeout);
      if (guild.id !== guildId) {
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
  const access = await promptChannelAccessConfig({
    prompter,
    label: t("wizard.discord.channelsLabel"),
    currentPolicy: currentPolicy ?? "allowlist",
    defaultPrompt: !hasGuilds,
    updatePrompt: Boolean(account.guilds),
    placeholder: "My Server, My Server/#general, #support, guild:<id>, channel ID",
  });
  if (!access) {
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
  let lookup = token ? setupDirectory(token) : undefined;
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
      lookup = token ? setupDirectory(token) : undefined;
    }
  }
  await prompter.note(
    `Added ${added} allowlist entries. Skipped ${access.entries.length - matched}.`,
    title,
  );
  const skippedEdit =
    !added && matched < access.entries.length && (currentPolicy || account.guilds);
  if (!hasGuilds && !matched && (!skippedEdit || currentPolicy === "allowlist")) {
    await prompter.note("An empty Discord allowlist blocks all server messages.", title);
  }
  if (skippedEdit) {
    await prompter.note("Kept the previous Discord access settings.", title);
    return { cfg };
  }
  if (!matched && !hasGuilds) {
    if (
      !(await prompter.confirm({
        message: "Finish with an empty Discord allowlist?",
        initialValue: false,
      }))
    ) {
      await prompter.note("Kept the previous Discord access settings.", title);
      return { cfg };
    }
  }
  return patch({ groupPolicy: "allowlist", ...(added ? { guilds } : {}) });
};

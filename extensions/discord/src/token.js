import { normalizeResolvedSecretInputString } from "../../../src/config/types.secrets.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
function normalizeDiscordToken(raw, path) {
  const trimmed = normalizeResolvedSecretInputString({ value: raw, path });
  if (!trimmed) {
    return void 0;
  }
  return trimmed.replace(/^Bot\s+/i, "");
}
function resolveDiscordToken(cfg, opts = {}) {
  const accountId = normalizeAccountId(opts.accountId);
  const discordCfg = cfg?.channels?.discord;
  const resolveAccountCfg = (id) => {
    const accounts = discordCfg?.accounts;
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
      return void 0;
    }
    const direct = accounts[id];
    if (direct) {
      return direct;
    }
    const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === id);
    return matchKey ? accounts[matchKey] : void 0;
  };
  const accountCfg = resolveAccountCfg(accountId);
  const hasAccountToken = Boolean(
    accountCfg && Object.prototype.hasOwnProperty.call(accountCfg, "token")
  );
  const accountToken = normalizeDiscordToken(
    accountCfg?.token ?? void 0,
    `channels.discord.accounts.${accountId}.token`
  );
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }
  if (hasAccountToken) {
    return { token: "", source: "none" };
  }
  const configToken = normalizeDiscordToken(
    discordCfg?.token ?? void 0,
    "channels.discord.token"
  );
  if (configToken) {
    return { token: configToken, source: "config" };
  }
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN") : void 0;
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  return { token: "", source: "none" };
}
export {
  normalizeDiscordToken,
  resolveDiscordToken
};

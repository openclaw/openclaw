import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId
} from "openclaw/plugin-sdk/twitch";
function normalizeTwitchToken(raw) {
  if (!raw) {
    return void 0;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return void 0;
  }
  return trimmed.startsWith("oauth:") ? trimmed : `oauth:${trimmed}`;
}
function resolveTwitchToken(cfg, opts = {}) {
  const accountId = normalizeAccountId(opts.accountId);
  const twitchCfg = cfg?.channels?.twitch;
  const accountCfg = accountId === DEFAULT_ACCOUNT_ID ? twitchCfg?.accounts?.[DEFAULT_ACCOUNT_ID] : twitchCfg?.accounts?.[accountId];
  let token;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    token = normalizeTwitchToken(
      (typeof twitchCfg?.accessToken === "string" ? twitchCfg.accessToken : void 0) || accountCfg?.accessToken
    );
  } else {
    token = normalizeTwitchToken(accountCfg?.accessToken);
  }
  if (token) {
    return { token, source: "config" };
  }
  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv ? normalizeTwitchToken(opts.envToken ?? process.env.OPENCLAW_TWITCH_ACCESS_TOKEN) : void 0;
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  return { token: "", source: "none" };
}
export {
  resolveTwitchToken
};

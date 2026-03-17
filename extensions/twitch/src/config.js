const DEFAULT_ACCOUNT_ID = "default";
function getAccountConfig(coreConfig, accountId) {
  if (!coreConfig || typeof coreConfig !== "object") {
    return null;
  }
  const cfg = coreConfig;
  const twitch = cfg.channels?.twitch;
  const twitchRaw = twitch;
  const accounts = twitchRaw?.accounts;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const accountFromAccounts = accounts?.[DEFAULT_ACCOUNT_ID];
    const baseLevel = {
      username: typeof twitchRaw?.username === "string" ? twitchRaw.username : void 0,
      accessToken: typeof twitchRaw?.accessToken === "string" ? twitchRaw.accessToken : void 0,
      clientId: typeof twitchRaw?.clientId === "string" ? twitchRaw.clientId : void 0,
      channel: typeof twitchRaw?.channel === "string" ? twitchRaw.channel : void 0,
      enabled: typeof twitchRaw?.enabled === "boolean" ? twitchRaw.enabled : void 0,
      allowFrom: Array.isArray(twitchRaw?.allowFrom) ? twitchRaw.allowFrom : void 0,
      allowedRoles: Array.isArray(twitchRaw?.allowedRoles) ? twitchRaw.allowedRoles : void 0,
      requireMention: typeof twitchRaw?.requireMention === "boolean" ? twitchRaw.requireMention : void 0,
      clientSecret: typeof twitchRaw?.clientSecret === "string" ? twitchRaw.clientSecret : void 0,
      refreshToken: typeof twitchRaw?.refreshToken === "string" ? twitchRaw.refreshToken : void 0,
      expiresIn: typeof twitchRaw?.expiresIn === "number" ? twitchRaw.expiresIn : void 0,
      obtainmentTimestamp: typeof twitchRaw?.obtainmentTimestamp === "number" ? twitchRaw.obtainmentTimestamp : void 0
    };
    const merged = {
      ...accountFromAccounts,
      ...baseLevel
    };
    if (merged.username) {
      return merged;
    }
    if (accountFromAccounts) {
      return accountFromAccounts;
    }
    return null;
  }
  if (!accounts || !accounts[accountId]) {
    return null;
  }
  return accounts[accountId];
}
function listAccountIds(cfg) {
  const twitch = cfg.channels?.twitch;
  const twitchRaw = twitch;
  const accountMap = twitchRaw?.accounts;
  const ids = [];
  if (accountMap) {
    ids.push(...Object.keys(accountMap));
  }
  const hasBaseLevelConfig = twitchRaw && (typeof twitchRaw.username === "string" || typeof twitchRaw.accessToken === "string" || typeof twitchRaw.channel === "string");
  if (hasBaseLevelConfig && !ids.includes(DEFAULT_ACCOUNT_ID)) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }
  return ids;
}
export {
  DEFAULT_ACCOUNT_ID,
  getAccountConfig,
  listAccountIds
};

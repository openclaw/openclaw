function getChannelConfig(cfg) {
  return cfg?.channels?.["synology-chat"];
}
function parseAllowedUserIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function parseRateLimitPerMinute(raw) {
  if (raw == null) {
    return 30;
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return 30;
  }
  return Number.parseInt(trimmed, 10);
}
function listAccountIds(cfg) {
  const channelCfg = getChannelConfig(cfg);
  if (!channelCfg) return [];
  const ids = /* @__PURE__ */ new Set();
  const hasBaseToken = channelCfg.token || process.env.SYNOLOGY_CHAT_TOKEN;
  if (hasBaseToken) {
    ids.add("default");
  }
  if (channelCfg.accounts) {
    for (const id of Object.keys(channelCfg.accounts)) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}
function resolveAccount(cfg, accountId) {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = accountId || "default";
  const accountOverride = channelCfg.accounts?.[id] ?? {};
  const envToken = process.env.SYNOLOGY_CHAT_TOKEN ?? "";
  const envIncomingUrl = process.env.SYNOLOGY_CHAT_INCOMING_URL ?? "";
  const envNasHost = process.env.SYNOLOGY_NAS_HOST ?? "localhost";
  const envAllowedUserIds = process.env.SYNOLOGY_ALLOWED_USER_IDS ?? "";
  const envRateLimitValue = parseRateLimitPerMinute(process.env.SYNOLOGY_RATE_LIMIT);
  const envBotName = process.env.OPENCLAW_BOT_NAME ?? "OpenClaw";
  return {
    accountId: id,
    enabled: accountOverride.enabled ?? channelCfg.enabled ?? true,
    token: accountOverride.token ?? channelCfg.token ?? envToken,
    incomingUrl: accountOverride.incomingUrl ?? channelCfg.incomingUrl ?? envIncomingUrl,
    nasHost: accountOverride.nasHost ?? channelCfg.nasHost ?? envNasHost,
    webhookPath: accountOverride.webhookPath ?? channelCfg.webhookPath ?? "/webhook/synology",
    dmPolicy: accountOverride.dmPolicy ?? channelCfg.dmPolicy ?? "allowlist",
    allowedUserIds: parseAllowedUserIds(
      accountOverride.allowedUserIds ?? channelCfg.allowedUserIds ?? envAllowedUserIds
    ),
    rateLimitPerMinute: accountOverride.rateLimitPerMinute ?? channelCfg.rateLimitPerMinute ?? envRateLimitValue,
    botName: accountOverride.botName ?? channelCfg.botName ?? envBotName,
    allowInsecureSsl: accountOverride.allowInsecureSsl ?? channelCfg.allowInsecureSsl ?? false
  };
}
export {
  listAccountIds,
  resolveAccount
};

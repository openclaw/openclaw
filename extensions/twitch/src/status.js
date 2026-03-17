import { getAccountConfig } from "./config.js";
import { resolveTwitchToken } from "./token.js";
import { isAccountConfigured } from "./utils/twitch.js";
function collectTwitchStatusIssues(accounts, getCfg) {
  const issues = [];
  for (const entry of accounts) {
    const accountId = entry.accountId;
    if (!accountId) {
      continue;
    }
    let account = null;
    let cfg;
    if (getCfg) {
      try {
        cfg = getCfg();
        account = getAccountConfig(cfg, accountId);
      } catch {
      }
    }
    if (!entry.configured) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "config",
        message: "Twitch account is not properly configured",
        fix: "Add required fields: username, accessToken, and clientId to your account configuration"
      });
      continue;
    }
    if (entry.enabled === false) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "config",
        message: "Twitch account is disabled",
        fix: "Set enabled: true in your account configuration to enable this account"
      });
      continue;
    }
    if (account && account.username && account.accessToken && !account.clientId) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "config",
        message: "Twitch client ID is required",
        fix: "Add clientId to your Twitch account configuration (from Twitch Developer Portal)"
      });
    }
    const tokenResolution = cfg ? resolveTwitchToken(cfg, { accountId }) : { token: "", source: "none" };
    if (account && isAccountConfigured(account, tokenResolution.token)) {
      if (account.accessToken?.startsWith("oauth:")) {
        issues.push({
          channel: "twitch",
          accountId,
          kind: "config",
          message: "Token contains 'oauth:' prefix (will be stripped)",
          fix: "The 'oauth:' prefix is optional. You can use just the token value, or keep it as-is (it will be normalized automatically)."
        });
      }
      if (account.clientSecret && !account.refreshToken) {
        issues.push({
          channel: "twitch",
          accountId,
          kind: "config",
          message: "clientSecret provided without refreshToken",
          fix: "For automatic token refresh, provide both clientSecret and refreshToken. Otherwise, clientSecret is not needed."
        });
      }
      if (account.allowFrom && account.allowFrom.length === 0) {
        issues.push({
          channel: "twitch",
          accountId,
          kind: "config",
          message: "allowFrom is configured but empty",
          fix: "Either add user IDs to allowFrom, remove the allowFrom field, or use allowedRoles instead."
        });
      }
      if (account.allowedRoles?.includes("all") && account.allowFrom && account.allowFrom.length > 0) {
        issues.push({
          channel: "twitch",
          accountId,
          kind: "intent",
          message: "allowedRoles is set to 'all' but allowFrom is also configured",
          fix: "When allowedRoles is 'all', the allowFrom list is not needed. Remove allowFrom or set allowedRoles to specific roles."
        });
      }
    }
    if (entry.lastError) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "runtime",
        message: `Last error: ${entry.lastError}`,
        fix: "Check your token validity and network connection. Ensure the bot has the required OAuth scopes."
      });
    }
    if (entry.configured && !entry.running && !entry.lastStartAt && !entry.lastInboundAt && !entry.lastOutboundAt) {
      issues.push({
        channel: "twitch",
        accountId,
        kind: "runtime",
        message: "Account has never connected successfully",
        fix: "Start the Twitch gateway to begin receiving messages. Check logs for connection errors."
      });
    }
    if (entry.running && entry.lastStartAt) {
      const uptime = Date.now() - entry.lastStartAt;
      const daysSinceStart = uptime / (1e3 * 60 * 60 * 24);
      if (daysSinceStart > 7) {
        issues.push({
          channel: "twitch",
          accountId,
          kind: "runtime",
          message: `Connection has been running for ${Math.floor(daysSinceStart)} days`,
          fix: "Consider restarting the connection periodically to refresh the connection. Twitch tokens may expire after long periods."
        });
      }
    }
  }
  return issues;
}
export {
  collectTwitchStatusIssues
};

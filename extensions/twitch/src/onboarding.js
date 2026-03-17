import {
  formatDocsLink,
  promptChannelAccessConfig
} from "openclaw/plugin-sdk/twitch";
import { DEFAULT_ACCOUNT_ID, getAccountConfig } from "./config.js";
import { isAccountConfigured } from "./utils/twitch.js";
const channel = "twitch";
function setTwitchAccount(cfg, account) {
  const existing = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
  const merged = {
    username: account.username ?? existing?.username ?? "",
    accessToken: account.accessToken ?? existing?.accessToken ?? "",
    clientId: account.clientId ?? existing?.clientId ?? "",
    channel: account.channel ?? existing?.channel ?? "",
    enabled: account.enabled ?? existing?.enabled ?? true,
    allowFrom: account.allowFrom ?? existing?.allowFrom,
    allowedRoles: account.allowedRoles ?? existing?.allowedRoles,
    requireMention: account.requireMention ?? existing?.requireMention,
    clientSecret: account.clientSecret ?? existing?.clientSecret,
    refreshToken: account.refreshToken ?? existing?.refreshToken,
    expiresIn: account.expiresIn ?? existing?.expiresIn,
    obtainmentTimestamp: account.obtainmentTimestamp ?? existing?.obtainmentTimestamp
  };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      twitch: {
        ...cfg.channels?.twitch,
        enabled: true,
        accounts: {
          ...cfg.channels?.twitch?.accounts,
          [DEFAULT_ACCOUNT_ID]: merged
        }
      }
    }
  };
}
async function noteTwitchSetupHelp(prompter) {
  await prompter.note(
    [
      "Twitch requires a bot account with OAuth token.",
      "1. Create a Twitch application at https://dev.twitch.tv/console",
      "2. Generate a token with scopes: chat:read and chat:write",
      "   Use https://twitchtokengenerator.com/ or https://twitchapps.com/tmi/",
      "3. Copy the token (starts with 'oauth:') and Client ID",
      "Env vars supported: OPENCLAW_TWITCH_ACCESS_TOKEN",
      `Docs: ${formatDocsLink("/channels/twitch", "channels/twitch")}`
    ].join("\n"),
    "Twitch setup"
  );
}
async function promptToken(prompter, account, envToken) {
  const existingToken = account?.accessToken ?? "";
  if (existingToken && !envToken) {
    const keepToken = await prompter.confirm({
      message: "Access token already configured. Keep it?",
      initialValue: true
    });
    if (keepToken) {
      return existingToken;
    }
  }
  return String(
    await prompter.text({
      message: "Twitch OAuth token (oauth:...)",
      initialValue: envToken ?? "",
      validate: (value) => {
        const raw = String(value ?? "").trim();
        if (!raw) {
          return "Required";
        }
        if (!raw.startsWith("oauth:")) {
          return "Token should start with 'oauth:'";
        }
        return void 0;
      }
    })
  ).trim();
}
async function promptUsername(prompter, account) {
  return String(
    await prompter.text({
      message: "Twitch bot username",
      initialValue: account?.username ?? "",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim();
}
async function promptClientId(prompter, account) {
  return String(
    await prompter.text({
      message: "Twitch Client ID",
      initialValue: account?.clientId ?? "",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim();
}
async function promptChannelName(prompter, account) {
  const channelName = String(
    await prompter.text({
      message: "Channel to join",
      initialValue: account?.channel ?? "",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim();
  return channelName;
}
async function promptRefreshTokenSetup(prompter, account) {
  const useRefresh = await prompter.confirm({
    message: "Enable automatic token refresh (requires client secret and refresh token)?",
    initialValue: Boolean(account?.clientSecret && account?.refreshToken)
  });
  if (!useRefresh) {
    return {};
  }
  const clientSecret = String(
    await prompter.text({
      message: "Twitch Client Secret (for token refresh)",
      initialValue: account?.clientSecret ?? "",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim() || void 0;
  const refreshToken = String(
    await prompter.text({
      message: "Twitch Refresh Token",
      initialValue: account?.refreshToken ?? "",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim() || void 0;
  return { clientSecret, refreshToken };
}
async function configureWithEnvToken(cfg, prompter, account, envToken, forceAllowFrom, dmPolicy2) {
  const useEnv = await prompter.confirm({
    message: "Twitch env var OPENCLAW_TWITCH_ACCESS_TOKEN detected. Use env token?",
    initialValue: true
  });
  if (!useEnv) {
    return null;
  }
  const username = await promptUsername(prompter, account);
  const clientId = await promptClientId(prompter, account);
  const cfgWithAccount = setTwitchAccount(cfg, {
    username,
    clientId,
    accessToken: "",
    // Will use env var
    enabled: true
  });
  if (forceAllowFrom && dmPolicy2.promptAllowFrom) {
    return { cfg: await dmPolicy2.promptAllowFrom({ cfg: cfgWithAccount, prompter }) };
  }
  return { cfg: cfgWithAccount };
}
function setTwitchAccessControl(cfg, allowedRoles, requireMention) {
  const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
  if (!account) {
    return cfg;
  }
  return setTwitchAccount(cfg, {
    ...account,
    allowedRoles,
    requireMention
  });
}
const dmPolicy = {
  label: "Twitch",
  channel,
  policyKey: "channels.twitch.allowedRoles",
  // Twitch uses roles instead of DM policy
  allowFromKey: "channels.twitch.accounts.default.allowFrom",
  getCurrent: (cfg) => {
    const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
    if (account?.allowedRoles?.includes("all")) {
      return "open";
    }
    if (account?.allowFrom && account.allowFrom.length > 0) {
      return "allowlist";
    }
    return "disabled";
  },
  setPolicy: (cfg, policy) => {
    const allowedRoles = policy === "open" ? ["all"] : policy === "allowlist" ? [] : ["moderator"];
    return setTwitchAccessControl(cfg, allowedRoles, true);
  },
  promptAllowFrom: async ({ cfg, prompter }) => {
    const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
    const existingAllowFrom = account?.allowFrom ?? [];
    const entry = await prompter.text({
      message: "Twitch allowFrom (user IDs, one per line, recommended for security)",
      placeholder: "123456789",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0
    });
    const allowFrom = String(entry ?? "").split(/[\n,;]+/g).map((s) => s.trim()).filter(Boolean);
    return setTwitchAccount(cfg, {
      ...account ?? void 0,
      allowFrom
    });
  }
};
const twitchOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
    const configured = account ? isAccountConfigured(account) : false;
    return {
      channel,
      configured,
      statusLines: [`Twitch: ${configured ? "configured" : "needs username, token, and clientId"}`],
      selectionHint: configured ? "configured" : "needs setup"
    };
  },
  configure: async ({ cfg, prompter, forceAllowFrom }) => {
    const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
    if (!account || !isAccountConfigured(account)) {
      await noteTwitchSetupHelp(prompter);
    }
    const envToken = process.env.OPENCLAW_TWITCH_ACCESS_TOKEN?.trim();
    if (envToken && !account?.accessToken) {
      const envResult = await configureWithEnvToken(
        cfg,
        prompter,
        account,
        envToken,
        forceAllowFrom,
        dmPolicy
      );
      if (envResult) {
        return envResult;
      }
    }
    const username = await promptUsername(prompter, account);
    const token = await promptToken(prompter, account, envToken);
    const clientId = await promptClientId(prompter, account);
    const channelName = await promptChannelName(prompter, account);
    const { clientSecret, refreshToken } = await promptRefreshTokenSetup(prompter, account);
    const cfgWithAccount = setTwitchAccount(cfg, {
      username,
      accessToken: token,
      clientId,
      channel: channelName,
      clientSecret,
      refreshToken,
      enabled: true
    });
    const cfgWithAllowFrom = forceAllowFrom && dmPolicy.promptAllowFrom ? await dmPolicy.promptAllowFrom({ cfg: cfgWithAccount, prompter }) : cfgWithAccount;
    if (!account?.allowFrom || account.allowFrom.length === 0) {
      const accessConfig = await promptChannelAccessConfig({
        prompter,
        label: "Twitch chat",
        currentPolicy: account?.allowedRoles?.includes("all") ? "open" : account?.allowedRoles?.includes("moderator") ? "allowlist" : "disabled",
        currentEntries: [],
        placeholder: "",
        updatePrompt: false
      });
      if (accessConfig) {
        const allowedRoles = accessConfig.policy === "open" ? ["all"] : accessConfig.policy === "allowlist" ? ["moderator", "vip"] : [];
        const cfgWithAccessControl = setTwitchAccessControl(cfgWithAllowFrom, allowedRoles, true);
        return { cfg: cfgWithAccessControl };
      }
    }
    return { cfg: cfgWithAllowFrom };
  },
  dmPolicy,
  disable: (cfg) => {
    const twitch = cfg.channels?.twitch;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        twitch: { ...twitch, enabled: false }
      }
    };
  }
};
export {
  configureWithEnvToken,
  promptChannelName,
  promptClientId,
  promptRefreshTokenSetup,
  promptToken,
  promptUsername,
  twitchOnboardingAdapter
};

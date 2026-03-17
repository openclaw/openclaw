import {
  buildSingleChannelSecretPromptState,
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  normalizeAccountId,
  promptSingleChannelSecretInput,
  runSingleChannelSecretStep,
  resolveAccountIdForConfigure,
  setTopLevelChannelDmPolicyWithAllowFrom
} from "openclaw/plugin-sdk/zalo";
import { listZaloAccountIds, resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";
const channel = "zalo";
function setZaloDmPolicy(cfg, dmPolicy2) {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel: "zalo",
    dmPolicy: dmPolicy2
  });
}
function setZaloUpdateMode(cfg, accountId, mode, webhookUrl, webhookSecret, webhookPath) {
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  if (mode === "polling") {
    if (isDefault) {
      const {
        webhookUrl: _url2,
        webhookSecret: _secret2,
        webhookPath: _path2,
        ...rest2
      } = cfg.channels?.zalo ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          zalo: rest2
        }
      };
    }
    const accounts2 = { ...cfg.channels?.zalo?.accounts };
    const existing = accounts2[accountId] ?? {};
    const { webhookUrl: _url, webhookSecret: _secret, webhookPath: _path, ...rest } = existing;
    accounts2[accountId] = rest;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          accounts: accounts2
        }
      }
    };
  }
  if (isDefault) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          webhookUrl,
          webhookSecret,
          webhookPath
        }
      }
    };
  }
  const accounts = { ...cfg.channels?.zalo?.accounts };
  accounts[accountId] = {
    ...accounts[accountId],
    webhookUrl,
    webhookSecret,
    webhookPath
  };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        accounts
      }
    }
  };
}
async function noteZaloTokenHelp(prompter) {
  await prompter.note(
    [
      "1) Open Zalo Bot Platform: https://bot.zaloplatforms.com",
      "2) Create a bot and get the token",
      "3) Token looks like 12345689:abc-xyz",
      "Tip: you can also set ZALO_BOT_TOKEN in your env.",
      "Docs: https://docs.openclaw.ai/channels/zalo"
    ].join("\n"),
    "Zalo bot token"
  );
}
async function promptZaloAllowFrom(params) {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveZaloAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: "Zalo allowFrom (user id)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      if (!/^\d+$/.test(raw)) {
        return "Use a numeric Zalo user id";
      }
      return void 0;
    }
  });
  const normalized = String(entry).trim();
  const unique = mergeAllowFromEntries(existingAllowFrom, [normalized]);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zalo: {
          ...cfg.channels?.zalo,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique
        }
      }
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zalo: {
        ...cfg.channels?.zalo,
        enabled: true,
        accounts: {
          ...cfg.channels?.zalo?.accounts,
          [accountId]: {
            ...cfg.channels?.zalo?.accounts?.[accountId],
            enabled: cfg.channels?.zalo?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique
          }
        }
      }
    }
  };
}
const dmPolicy = {
  label: "Zalo",
  channel,
  policyKey: "channels.zalo.dmPolicy",
  allowFromKey: "channels.zalo.allowFrom",
  getCurrent: (cfg) => cfg.channels?.zalo?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setZaloDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id = accountId && normalizeAccountId(accountId) ? normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID : resolveDefaultZaloAccountId(cfg);
    return promptZaloAllowFrom({
      cfg,
      prompter,
      accountId: id
    });
  }
};
const zaloOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listZaloAccountIds(cfg).some((accountId) => {
      const account = resolveZaloAccount({
        cfg,
        accountId,
        allowUnresolvedSecretRef: true
      });
      return Boolean(account.token) || hasConfiguredSecretInput(account.config.botToken) || Boolean(account.config.tokenFile?.trim());
    });
    return {
      channel,
      configured,
      statusLines: [`Zalo: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "recommended \xB7 configured" : "recommended \xB7 newcomer-friendly",
      quickstartScore: configured ? 1 : 10
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom
  }) => {
    const defaultZaloAccountId = resolveDefaultZaloAccountId(cfg);
    const zaloAccountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Zalo",
      accountOverride: accountOverrides.zalo,
      shouldPromptAccountIds,
      listAccountIds: listZaloAccountIds,
      defaultAccountId: defaultZaloAccountId
    });
    let next = cfg;
    const resolvedAccount = resolveZaloAccount({
      cfg: next,
      accountId: zaloAccountId,
      allowUnresolvedSecretRef: true
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = zaloAccountId === DEFAULT_ACCOUNT_ID;
    const hasConfigToken = Boolean(
      hasConfiguredSecretInput(resolvedAccount.config.botToken) || resolvedAccount.config.tokenFile
    );
    const tokenStep = await runSingleChannelSecretStep({
      cfg: next,
      prompter,
      providerHint: "zalo",
      credentialLabel: "bot token",
      accountConfigured,
      hasConfigToken,
      allowEnv,
      envValue: process.env.ZALO_BOT_TOKEN,
      envPrompt: "ZALO_BOT_TOKEN detected. Use env var?",
      keepPrompt: "Zalo token already configured. Keep it?",
      inputPrompt: "Enter Zalo bot token",
      preferredEnvVar: "ZALO_BOT_TOKEN",
      onMissingConfigured: async () => await noteZaloTokenHelp(prompter),
      applyUseEnv: async (cfg2) => zaloAccountId === DEFAULT_ACCOUNT_ID ? {
        ...cfg2,
        channels: {
          ...cfg2.channels,
          zalo: {
            ...cfg2.channels?.zalo,
            enabled: true
          }
        }
      } : cfg2,
      applySet: async (cfg2, value) => zaloAccountId === DEFAULT_ACCOUNT_ID ? {
        ...cfg2,
        channels: {
          ...cfg2.channels,
          zalo: {
            ...cfg2.channels?.zalo,
            enabled: true,
            botToken: value
          }
        }
      } : {
        ...cfg2,
        channels: {
          ...cfg2.channels,
          zalo: {
            ...cfg2.channels?.zalo,
            enabled: true,
            accounts: {
              ...cfg2.channels?.zalo?.accounts,
              [zaloAccountId]: {
                ...cfg2.channels?.zalo?.accounts?.[zaloAccountId],
                enabled: true,
                botToken: value
              }
            }
          }
        }
      }
    });
    next = tokenStep.cfg;
    const wantsWebhook = await prompter.confirm({
      message: "Use webhook mode for Zalo?",
      initialValue: Boolean(resolvedAccount.config.webhookUrl)
    });
    if (wantsWebhook) {
      const webhookUrl = String(
        await prompter.text({
          message: "Webhook URL (https://...) ",
          initialValue: resolvedAccount.config.webhookUrl,
          validate: (value) => value?.trim()?.startsWith("https://") ? void 0 : "HTTPS URL required"
        })
      ).trim();
      const defaultPath = (() => {
        try {
          return new URL(webhookUrl).pathname || "/zalo-webhook";
        } catch {
          return "/zalo-webhook";
        }
      })();
      let webhookSecretResult = await promptSingleChannelSecretInput({
        cfg: next,
        prompter,
        providerHint: "zalo-webhook",
        credentialLabel: "webhook secret",
        ...buildSingleChannelSecretPromptState({
          accountConfigured: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
          hasConfigToken: hasConfiguredSecretInput(resolvedAccount.config.webhookSecret),
          allowEnv: false
        }),
        envPrompt: "",
        keepPrompt: "Zalo webhook secret already configured. Keep it?",
        inputPrompt: "Webhook secret (8-256 chars)",
        preferredEnvVar: "ZALO_WEBHOOK_SECRET"
      });
      while (webhookSecretResult.action === "set" && typeof webhookSecretResult.value === "string" && (webhookSecretResult.value.length < 8 || webhookSecretResult.value.length > 256)) {
        await prompter.note("Webhook secret must be between 8 and 256 characters.", "Zalo webhook");
        webhookSecretResult = await promptSingleChannelSecretInput({
          cfg: next,
          prompter,
          providerHint: "zalo-webhook",
          credentialLabel: "webhook secret",
          ...buildSingleChannelSecretPromptState({
            accountConfigured: false,
            hasConfigToken: false,
            allowEnv: false
          }),
          envPrompt: "",
          keepPrompt: "Zalo webhook secret already configured. Keep it?",
          inputPrompt: "Webhook secret (8-256 chars)",
          preferredEnvVar: "ZALO_WEBHOOK_SECRET"
        });
      }
      const webhookSecret = webhookSecretResult.action === "set" ? webhookSecretResult.value : resolvedAccount.config.webhookSecret;
      const webhookPath = String(
        await prompter.text({
          message: "Webhook path (optional)",
          initialValue: resolvedAccount.config.webhookPath ?? defaultPath
        })
      ).trim();
      next = setZaloUpdateMode(
        next,
        zaloAccountId,
        "webhook",
        webhookUrl,
        webhookSecret,
        webhookPath || void 0
      );
    } else {
      next = setZaloUpdateMode(next, zaloAccountId, "polling");
    }
    if (forceAllowFrom) {
      next = await promptZaloAllowFrom({
        cfg: next,
        prompter,
        accountId: zaloAccountId
      });
    }
    return { cfg: next, accountId: zaloAccountId };
  }
};
export {
  zaloOnboardingAdapter
};

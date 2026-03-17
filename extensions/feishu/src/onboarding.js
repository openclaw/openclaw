import {
  buildSingleChannelSecretPromptState,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitOnboardingEntries
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuCredentials } from "./accounts.js";
import { probeFeishu } from "./probe.js";
const channel = "feishu";
function normalizeString(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed || void 0;
}
function setFeishuDmPolicy(cfg, dmPolicy2) {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel: "feishu",
    dmPolicy: dmPolicy2
  });
}
function setFeishuAllowFrom(cfg, allowFrom) {
  return setTopLevelChannelAllowFrom({
    cfg,
    channel: "feishu",
    allowFrom
  });
}
async function promptFeishuAllowFrom(params) {
  const existing = params.cfg.channels?.feishu?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist Feishu DMs by open_id or user_id.",
      "You can find user open_id in Feishu admin console or via API.",
      "Examples:",
      "- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    ].join("\n"),
    "Feishu allowlist"
  );
  while (true) {
    const entry = await params.prompter.text({
      message: "Feishu allowFrom (user open_ids)",
      placeholder: "ou_xxxxx, ou_yyyyy",
      initialValue: existing[0] ? String(existing[0]) : void 0,
      validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
    });
    const parts = splitOnboardingEntries(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "Feishu allowlist");
      continue;
    }
    const unique = mergeAllowFromEntries(existing, parts);
    return setFeishuAllowFrom(params.cfg, unique);
  }
}
async function noteFeishuCredentialHelp(prompter) {
  await prompter.note(
    [
      "1) Go to Feishu Open Platform (open.feishu.cn)",
      "2) Create a self-built app",
      "3) Get App ID and App Secret from Credentials page",
      "4) Enable required permissions: im:message, im:chat, contact:user.base:readonly",
      "5) Publish the app or add it to a test group",
      "Tip: you can also set FEISHU_APP_ID / FEISHU_APP_SECRET env vars.",
      `Docs: ${formatDocsLink("/channels/feishu", "feishu")}`
    ].join("\n"),
    "Feishu credentials"
  );
}
async function promptFeishuAppId(params) {
  const appId = String(
    await params.prompter.text({
      message: "Enter Feishu App ID",
      initialValue: params.initialValue,
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim();
  return appId;
}
function setFeishuGroupPolicy(cfg, groupPolicy) {
  return setTopLevelChannelGroupPolicy({
    cfg,
    channel: "feishu",
    groupPolicy,
    enabled: true
  });
}
function setFeishuGroupAllowFrom(cfg, groupAllowFrom) {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        groupAllowFrom
      }
    }
  };
}
const dmPolicy = {
  label: "Feishu",
  channel,
  policyKey: "channels.feishu.dmPolicy",
  allowFromKey: "channels.feishu.allowFrom",
  getCurrent: (cfg) => cfg.channels?.feishu?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setFeishuDmPolicy(cfg, policy),
  promptAllowFrom: promptFeishuAllowFrom
};
const feishuOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const feishuCfg = cfg.channels?.feishu;
    const isAppIdConfigured = (value) => {
      const asString = normalizeString(value);
      if (asString) {
        return true;
      }
      if (!value || typeof value !== "object") {
        return false;
      }
      const rec = value;
      const source = normalizeString(rec.source)?.toLowerCase();
      const id = normalizeString(rec.id);
      if (source === "env" && id) {
        return Boolean(normalizeString(process.env[id]));
      }
      return hasConfiguredSecretInput(value);
    };
    const topLevelConfigured = Boolean(
      isAppIdConfigured(feishuCfg?.appId) && hasConfiguredSecretInput(feishuCfg?.appSecret)
    );
    const accountConfigured = Object.values(feishuCfg?.accounts ?? {}).some((account) => {
      if (!account || typeof account !== "object") {
        return false;
      }
      const hasOwnAppId = Object.prototype.hasOwnProperty.call(account, "appId");
      const hasOwnAppSecret = Object.prototype.hasOwnProperty.call(account, "appSecret");
      const accountAppIdConfigured = hasOwnAppId ? isAppIdConfigured(account.appId) : isAppIdConfigured(feishuCfg?.appId);
      const accountSecretConfigured = hasOwnAppSecret ? hasConfiguredSecretInput(account.appSecret) : hasConfiguredSecretInput(feishuCfg?.appSecret);
      return Boolean(accountAppIdConfigured && accountSecretConfigured);
    });
    const configured = topLevelConfigured || accountConfigured;
    const resolvedCredentials = resolveFeishuCredentials(feishuCfg, {
      allowUnresolvedSecretRef: true
    });
    let probeResult = null;
    if (configured && resolvedCredentials) {
      try {
        probeResult = await probeFeishu(resolvedCredentials);
      } catch {
      }
    }
    const statusLines = [];
    if (!configured) {
      statusLines.push("Feishu: needs app credentials");
    } else if (probeResult?.ok) {
      statusLines.push(
        `Feishu: connected as ${probeResult.botName ?? probeResult.botOpenId ?? "bot"}`
      );
    } else {
      statusLines.push("Feishu: configured (connection not verified)");
    }
    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0
    };
  },
  configure: async ({ cfg, prompter }) => {
    const feishuCfg = cfg.channels?.feishu;
    const resolved = resolveFeishuCredentials(feishuCfg, {
      allowUnresolvedSecretRef: true
    });
    const hasConfigSecret = hasConfiguredSecretInput(feishuCfg?.appSecret);
    const hasConfigCreds = Boolean(
      typeof feishuCfg?.appId === "string" && feishuCfg.appId.trim() && hasConfigSecret
    );
    const appSecretPromptState = buildSingleChannelSecretPromptState({
      accountConfigured: Boolean(resolved),
      hasConfigToken: hasConfigSecret,
      allowEnv: !hasConfigCreds && Boolean(process.env.FEISHU_APP_ID?.trim()),
      envValue: process.env.FEISHU_APP_SECRET
    });
    let next = cfg;
    let appId = null;
    let appSecret = null;
    let appSecretProbeValue = null;
    if (!resolved) {
      await noteFeishuCredentialHelp(prompter);
    }
    const appSecretResult = await promptSingleChannelSecretInput({
      cfg: next,
      prompter,
      providerHint: "feishu",
      credentialLabel: "App Secret",
      accountConfigured: appSecretPromptState.accountConfigured,
      canUseEnv: appSecretPromptState.canUseEnv,
      hasConfigToken: appSecretPromptState.hasConfigToken,
      envPrompt: "FEISHU_APP_ID + FEISHU_APP_SECRET detected. Use env vars?",
      keepPrompt: "Feishu App Secret already configured. Keep it?",
      inputPrompt: "Enter Feishu App Secret",
      preferredEnvVar: "FEISHU_APP_SECRET"
    });
    if (appSecretResult.action === "use-env") {
      next = {
        ...next,
        channels: {
          ...next.channels,
          feishu: { ...next.channels?.feishu, enabled: true }
        }
      };
    } else if (appSecretResult.action === "set") {
      appSecret = appSecretResult.value;
      appSecretProbeValue = appSecretResult.resolvedValue;
      appId = await promptFeishuAppId({
        prompter,
        initialValue: normalizeString(feishuCfg?.appId) ?? normalizeString(process.env.FEISHU_APP_ID)
      });
    }
    if (appId && appSecret) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          feishu: {
            ...next.channels?.feishu,
            enabled: true,
            appId,
            appSecret
          }
        }
      };
      try {
        const probe = await probeFeishu({
          appId,
          appSecret: appSecretProbeValue ?? void 0,
          domain: next.channels?.feishu?.domain
        });
        if (probe.ok) {
          await prompter.note(
            `Connected as ${probe.botName ?? probe.botOpenId ?? "bot"}`,
            "Feishu connection test"
          );
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            "Feishu connection test"
          );
        }
      } catch (err) {
        await prompter.note(`Connection test failed: ${String(err)}`, "Feishu connection test");
      }
    }
    const currentMode = next.channels?.feishu?.connectionMode ?? "websocket";
    const connectionMode = await prompter.select({
      message: "Feishu connection mode",
      options: [
        { value: "websocket", label: "WebSocket (default)" },
        { value: "webhook", label: "Webhook" }
      ],
      initialValue: currentMode
    });
    next = {
      ...next,
      channels: {
        ...next.channels,
        feishu: {
          ...next.channels?.feishu,
          connectionMode
        }
      }
    };
    if (connectionMode === "webhook") {
      const currentVerificationToken = next.channels?.feishu?.verificationToken;
      const verificationTokenPromptState = buildSingleChannelSecretPromptState({
        accountConfigured: hasConfiguredSecretInput(currentVerificationToken),
        hasConfigToken: hasConfiguredSecretInput(currentVerificationToken),
        allowEnv: false
      });
      const verificationTokenResult = await promptSingleChannelSecretInput({
        cfg: next,
        prompter,
        providerHint: "feishu-webhook",
        credentialLabel: "verification token",
        accountConfigured: verificationTokenPromptState.accountConfigured,
        canUseEnv: verificationTokenPromptState.canUseEnv,
        hasConfigToken: verificationTokenPromptState.hasConfigToken,
        envPrompt: "",
        keepPrompt: "Feishu verification token already configured. Keep it?",
        inputPrompt: "Enter Feishu verification token",
        preferredEnvVar: "FEISHU_VERIFICATION_TOKEN"
      });
      if (verificationTokenResult.action === "set") {
        next = {
          ...next,
          channels: {
            ...next.channels,
            feishu: {
              ...next.channels?.feishu,
              verificationToken: verificationTokenResult.value
            }
          }
        };
      }
      const currentEncryptKey = next.channels?.feishu?.encryptKey;
      const encryptKeyPromptState = buildSingleChannelSecretPromptState({
        accountConfigured: hasConfiguredSecretInput(currentEncryptKey),
        hasConfigToken: hasConfiguredSecretInput(currentEncryptKey),
        allowEnv: false
      });
      const encryptKeyResult = await promptSingleChannelSecretInput({
        cfg: next,
        prompter,
        providerHint: "feishu-webhook",
        credentialLabel: "encrypt key",
        accountConfigured: encryptKeyPromptState.accountConfigured,
        canUseEnv: encryptKeyPromptState.canUseEnv,
        hasConfigToken: encryptKeyPromptState.hasConfigToken,
        envPrompt: "",
        keepPrompt: "Feishu encrypt key already configured. Keep it?",
        inputPrompt: "Enter Feishu encrypt key",
        preferredEnvVar: "FEISHU_ENCRYPT_KEY"
      });
      if (encryptKeyResult.action === "set") {
        next = {
          ...next,
          channels: {
            ...next.channels,
            feishu: {
              ...next.channels?.feishu,
              encryptKey: encryptKeyResult.value
            }
          }
        };
      }
      const currentWebhookPath = next.channels?.feishu?.webhookPath;
      const webhookPath = String(
        await prompter.text({
          message: "Feishu webhook path",
          initialValue: currentWebhookPath ?? "/feishu/events",
          validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
        })
      ).trim();
      next = {
        ...next,
        channels: {
          ...next.channels,
          feishu: {
            ...next.channels?.feishu,
            webhookPath
          }
        }
      };
    }
    const currentDomain = next.channels?.feishu?.domain ?? "feishu";
    const domain = await prompter.select({
      message: "Which Feishu domain?",
      options: [
        { value: "feishu", label: "Feishu (feishu.cn) - China" },
        { value: "lark", label: "Lark (larksuite.com) - International" }
      ],
      initialValue: currentDomain
    });
    if (domain) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          feishu: {
            ...next.channels?.feishu,
            domain
          }
        }
      };
    }
    const groupPolicy = await prompter.select({
      message: "Group chat policy",
      options: [
        { value: "allowlist", label: "Allowlist - only respond in specific groups" },
        { value: "open", label: "Open - respond in all groups (requires mention)" },
        { value: "disabled", label: "Disabled - don't respond in groups" }
      ],
      initialValue: next.channels?.feishu?.groupPolicy ?? "allowlist"
    });
    if (groupPolicy) {
      next = setFeishuGroupPolicy(next, groupPolicy);
    }
    if (groupPolicy === "allowlist") {
      const existing = next.channels?.feishu?.groupAllowFrom ?? [];
      const entry = await prompter.text({
        message: "Group chat allowlist (chat_ids)",
        placeholder: "oc_xxxxx, oc_yyyyy",
        initialValue: existing.length > 0 ? existing.map(String).join(", ") : void 0
      });
      if (entry) {
        const parts = splitOnboardingEntries(String(entry));
        if (parts.length > 0) {
          next = setFeishuGroupAllowFrom(next, parts);
        }
      }
    }
    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: { ...cfg.channels?.feishu, enabled: false }
    }
  })
};
export {
  feishuOnboardingAdapter
};

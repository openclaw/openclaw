import { createChannelDmPolicy } from "openclaw/plugin-sdk/channel-dm-policy";
import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  patchScopedAccountConfig,
  promptSingleChannelSecretInput,
  setSetupChannelEnabled,
  splitSetupEntries,
  createSetupTranslator,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type SecretInput,
} from "openclaw/plugin-sdk/setup";
import { normalizeOptionalString as normalizeString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultFeishuAccountId, resolveFeishuAccount } from "./accounts.js";
import type { AppRegistrationResult } from "./app-registration.js";
import type { FeishuConfig, FeishuDomain } from "./types.js";

const t = createSetupTranslator();

const channel = "feishu" as const;
const SCAN_TO_CREATE_TP = "ob_cli_app";
const FEISHU_SETUP_FLOW_KEY = "_flow";

function isFeishuConfigured(cfg: OpenClawConfig): boolean {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  const isAppIdConfigured = (value: unknown): boolean => {
    const asString = normalizeString(value);
    if (asString) {
      return true;
    }
    if (!value || typeof value !== "object") {
      return false;
    }
    const rec = value as Record<string, unknown>;
    const source = normalizeString(rec.source)?.toLowerCase();
    const id = normalizeString(rec.id);
    if (source === "env" && id) {
      return Boolean(normalizeString(process.env[id]));
    }
    return hasConfiguredSecretInput(value);
  };

  const isConfigured = (account: Pick<FeishuConfig, "appId" | "appSecret"> | undefined) =>
    isAppIdConfigured(account?.appId) && hasConfiguredSecretInput(account?.appSecret);
  return (
    isConfigured(feishuCfg) ||
    Object.values(feishuCfg?.accounts ?? {}).some(
      (account) =>
        account && typeof account === "object" && isConfigured({ ...feishuCfg, ...account }),
    )
  );
}

function patchFeishuConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: { enabled: true, ...patch },
  });
}

function resolveFeishuSetupAccount(cfg: OpenClawConfig, requestedAccountId?: string | null) {
  const accountId = requestedAccountId ?? resolveDefaultFeishuAccountId(cfg);
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  const account = accountId === DEFAULT_ACCOUNT_ID ? undefined : feishuCfg?.accounts?.[accountId];
  return {
    accountId,
    config: {
      dmPolicy: account?.dmPolicy ?? feishuCfg?.dmPolicy,
      allowFrom: account?.allowFrom ?? feishuCfg?.allowFrom,
    },
  };
}

async function promptFeishuAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  prompter: Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0]["prompter"];
}): Promise<OpenClawConfig> {
  const account = resolveFeishuSetupAccount(params.cfg, params.accountId);
  const existingAllowFrom = account.config.allowFrom ?? [];
  await params.prompter.note(
    [
      t("wizard.feishu.allowlistIntro"),
      t("wizard.feishu.allowlistFindUser"),
      t("wizard.feishu.examples"),
      "- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ].join("\n"),
    t("wizard.feishu.allowlistTitle"),
  );
  const entry = await params.prompter.text({
    message: t("wizard.feishu.allowFromPrompt"),
    placeholder: "ou_xxxxx, ou_yyyyy",
    initialValue:
      existingAllowFrom.length > 0 ? existingAllowFrom.map(String).join(", ") : undefined,
  });
  const mergedAllowFrom = mergeAllowFromEntries(existingAllowFrom, splitSetupEntries(entry));
  return patchFeishuConfig(params.cfg, account.accountId, { allowFrom: mergedAllowFrom });
}

async function noteFeishuCredentialHelp(
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<void> {
  await prompter.note(
    [
      t("wizard.feishu.credentialsStepOpenPlatform"),
      t("wizard.feishu.credentialsStepCreateApp"),
      t("wizard.feishu.credentialsStepGetCredentials"),
      t("wizard.feishu.credentialsStepPermissions"),
      t("wizard.feishu.credentialsStepPublish"),
      t("wizard.feishu.credentialsEnvTip"),
      t("wizard.channels.docs", { link: formatDocsLink("/channels/feishu", "feishu") }),
    ].join("\n"),
    t("wizard.feishu.credentialsTitle"),
  );
}

const feishuDmPolicy = createChannelDmPolicy({
  label: "Feishu",
  channel,
  resolveAccount: resolveFeishuSetupAccount,
  resolveAllowFrom: ({ policy }) => (policy === "open" ? ["*"] : undefined),
  applyPatch: ({ cfg, account, patch }) => patchFeishuConfig(cfg, account.accountId, patch),
  promptAllowFrom: promptFeishuAllowFrom,
});

type WizardPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];

async function runScanToCreate(
  prompter: WizardPrompter,
  domain: FeishuDomain,
  beforePersistentEffect?: () => Promise<void>,
): Promise<AppRegistrationResult | null> {
  const { beginAppRegistration, initAppRegistration, pollAppRegistration, printQrCode } =
    await import("./app-registration.js");
  try {
    await initAppRegistration(domain);
  } catch {
    await prompter.note(t("wizard.feishu.scanUnavailable"), t("wizard.feishu.setupTitle"));
    return null;
  }

  await beforePersistentEffect?.();
  const begin = await beginAppRegistration(domain);

  await prompter.note(t("wizard.feishu.scanQr"), t("wizard.feishu.scanTitle"));
  await printQrCode(begin.qrUrl);

  const progress = prompter.progress(t("wizard.feishu.fetchingConfig"));

  const outcome = await pollAppRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    initialDomain: domain,
    tp: SCAN_TO_CREATE_TP,
  });

  const statusMessages = {
    success: "wizard.feishu.scanCompleted",
    access_denied: "wizard.feishu.scanDenied",
    expired: "wizard.feishu.scanExpired",
    timeout: "wizard.feishu.scanTimedOut",
  };
  progress.stop(
    outcome.status === "error"
      ? t("wizard.feishu.scanError", { error: outcome.message })
      : t(statusMessages[outcome.status]),
  );
  return outcome.status === "success" ? outcome.result : null;
}

async function runNewAppFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}): Promise<{ cfg: OpenClawConfig }> {
  const { prompter, options } = params;
  let next = params.cfg;

  // Resolve target account: defaultAccount > first account key > top-level.
  const targetAccountId = resolveDefaultFeishuAccountId(next);

  let appId: string | null;
  let appSecret: SecretInput | null = null;
  let appSecretProbeValue: string | null = null;
  let scanOpenId: string | undefined;
  const feishuCfg = next.channels?.feishu as FeishuConfig | undefined;
  const currentDomain = feishuCfg?.domain ?? "feishu";
  const setupMethod = await prompter.select({
    message: t("wizard.feishu.setupMethodPrompt"),
    options: [
      { value: "manual", label: t("wizard.feishu.setupMethodManual") },
      { value: "scan", label: t("wizard.feishu.setupMethodScan") },
    ],
    initialValue: "manual",
  });
  const selectedDomain = await prompter.select<FeishuDomain>({
    message: t("wizard.feishu.domainPrompt"),
    options: [
      { value: "feishu", label: t("wizard.feishu.domainFeishu") },
      { value: "lark", label: t("wizard.feishu.domainLark") },
    ],
    initialValue: currentDomain,
  });
  let scanDomain = selectedDomain;

  const scanResult =
    setupMethod === "scan"
      ? await runScanToCreate(prompter, selectedDomain, options?.beforePersistentEffect)
      : null;
  if (scanResult) {
    appId = scanResult.appId;
    appSecret = scanResult.appSecret;
    scanDomain = scanResult.domain;
    scanOpenId = scanResult.openId;
  } else {
    await noteFeishuCredentialHelp(prompter);

    appId = (
      await prompter.text({
        message: t("wizard.feishu.appIdPrompt"),
        initialValue: normalizeString(process.env.FEISHU_APP_ID),
        validate: (value) => (value?.trim() ? undefined : t("common.required")),
      })
    ).trim();

    const appSecretResult = await promptSingleChannelSecretInput({
      cfg: next,
      prompter,
      providerHint: "feishu",
      credentialLabel: "App Secret",
      secretInputMode: options?.secretInputMode,
      accountConfigured: false,
      canUseEnv: false,
      hasConfigToken: false,
      envPrompt: "",
      keepPrompt: t("wizard.feishu.appSecretKeep"),
      inputPrompt: t("wizard.feishu.appSecretPrompt"),
      preferredEnvVar: "FEISHU_APP_SECRET",
    });
    if (appSecretResult.action === "set") {
      appSecret = appSecretResult.value;
      appSecretProbeValue = appSecretResult.resolvedValue;
    }

    if (appId && appSecretProbeValue) {
      const { getAppOwnerOpenId } = await import("./app-registration.js");
      scanOpenId = await getAppOwnerOpenId({
        appId,
        appSecret: appSecretProbeValue,
        domain: selectedDomain,
      });
    }
  }

  const groupPolicy = (await prompter.select({
    message: t("wizard.feishu.groupPolicyPrompt"),
    options: [
      { value: "allowlist", label: t("wizard.feishu.groupPolicyAllowlist") },
      { value: "open", label: t("wizard.feishu.groupPolicyOpen") },
      { value: "disabled", label: t("wizard.feishu.groupPolicyDisabled") },
    ],
    initialValue: "allowlist",
  })) as "allowlist" | "open" | "disabled";

  const configProgress = prompter.progress(t("wizard.feishu.configuring"));
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });

  next = patchFeishuConfig(next, targetAccountId, {
    ...(appId && appSecret ? { appId, appSecret, connectionMode: "websocket" } : {}),
    ...(scanDomain ? { domain: scanDomain } : {}),
    ...(scanOpenId ? { dmPolicy: "allowlist", allowFrom: [scanOpenId] } : {}),
    groupPolicy,
    ...(groupPolicy === "open" ? { requireMention: true } : {}),
  });

  configProgress.stop(t("wizard.feishu.botConfigured"));

  return { cfg: next };
}

async function runEditFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}): Promise<{ cfg: OpenClawConfig }> {
  const { cfg, prompter, options } = params;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  // Check existing appId (top-level or first configured account).
  // Supports both plain string and SecretRef (env-backed) appId values.
  const resolveAppIdLabel = (value: unknown): string | undefined => {
    const asString = normalizeString(value);
    if (asString) {
      return asString;
    }
    if (value && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      if (normalizeString(rec.source) && normalizeString(rec.id)) {
        const envValue = normalizeString(process.env[rec.id as string]);
        return envValue ?? `env:${String(rec.id)}`;
      }
      if (hasConfiguredSecretInput(value)) {
        return "(configured)";
      }
    }
    return undefined;
  };
  const existingAppId =
    resolveAppIdLabel(feishuCfg?.appId) ??
    Object.values(feishuCfg?.accounts ?? {}).reduce<string | undefined>((found, account) => {
      if (found) {
        return found;
      }
      if (account && typeof account === "object") {
        return resolveAppIdLabel((account as Record<string, unknown>).appId);
      }
      return undefined;
    }, undefined);
  if (
    !existingAppId ||
    !(await prompter.confirm({
      message: t("wizard.feishu.existingBotPrompt", { appId: existingAppId }),
      initialValue: true,
    }))
  ) {
    return runNewAppFlow({ cfg, prompter, options });
  }

  await prompter.note(t("wizard.feishu.botConfigured"), "");

  return { cfg };
}

export async function runFeishuLogin(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const runFlow = isFeishuConfigured(cfg) ? runEditFlow : runNewAppFlow;
  const result = await runFlow({ cfg, prompter, options: {} });
  return result.cfg;
}

export const feishuSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId, cfg }) =>
    (typeof accountOverride === "string" && accountOverride.trim()
      ? accountOverride.trim()
      : undefined) ??
    resolveDefaultFeishuAccountId(cfg) ??
    defaultAccountId,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsAppCredentials"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsAppCreds"),
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isFeishuConfigured(cfg),
    resolveStatusLines: async ({ cfg, accountId, configured }) => {
      const account = resolveFeishuAccount({ cfg, accountId });
      let probeResult = null;
      if (configured && account.configured) {
        try {
          const { probeFeishu } = await import("./probe.js");
          probeResult = await probeFeishu(account);
        } catch {}
      }
      if (!configured) {
        return [`Feishu: ${t("wizard.channels.statusNeedsAppCredentials")}`];
      }
      if (probeResult?.ok) {
        return [
          `Feishu: ${t("wizard.channels.statusConnectedAs", {
            name: probeResult.botName ?? probeResult.botOpenId ?? "bot",
          })}`,
        ];
      }
      return [`Feishu: ${t("wizard.channels.statusConfiguredConnectionNotVerified")}`];
    },
  },

  prepare: async ({ cfg, credentialValues }) => ({
    credentialValues: {
      ...credentialValues,
      [FEISHU_SETUP_FLOW_KEY]: isFeishuConfigured(cfg) ? "edit" : "new",
    },
  }),

  credentials: [],

  finalize: async ({ cfg, prompter, options, credentialValues }) => {
    const flow = credentialValues[FEISHU_SETUP_FLOW_KEY] ?? "new";

    return (flow === "edit" ? runEditFlow : runNewAppFlow)({ cfg, prompter, options });
  },

  dmPolicy: feishuDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

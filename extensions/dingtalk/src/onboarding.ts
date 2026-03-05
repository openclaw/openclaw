import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  ClawdbotConfig,
  DmPolicy,
  SecretInput,
  WizardPrompter,
} from "openclaw/plugin-sdk/dingtalk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  promptSingleChannelSecretInput,
} from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkCredentials } from "./accounts.js";
import { probeDingtalk } from "./probe.js";
import type { DingtalkConfig } from "./types.js";

const channel = "dingtalk" as const;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

// 设置 DM 策略 / Set DM policy
function setDingtalkDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy): ClawdbotConfig {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.channels?.dingtalk?.allowFrom)?.map((entry) => String(entry))
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.dingtalk,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

// 设置 DM 白名单 / Set DM allowlist
function setDingtalkAllowFrom(cfg: ClawdbotConfig, allowFrom: string[]): ClawdbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: { ...cfg.channels?.dingtalk, allowFrom },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// 提示输入白名单 / Prompt for allowlist
async function promptDingtalkAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
}): Promise<ClawdbotConfig> {
  const existing = params.cfg.channels?.dingtalk?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist DingTalk DMs by staffId.",
      "You can find user staffId in DingTalk admin console.",
      "Examples:",
      "- 123456789",
      "- manager1234",
    ].join("\n"),
    "DingTalk allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "DingTalk allowFrom (staffIds)",
      placeholder: "123456, 789012",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "DingTalk allowlist");
      continue;
    }
    const unique = [
      ...new Set([
        ...existing.map((v: string | number) => String(v).trim()).filter(Boolean),
        ...parts,
      ]),
    ];
    return setDingtalkAllowFrom(params.cfg, unique);
  }
}

// 凭证帮助提示 / Credential help note
async function noteDingtalkCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Go to DingTalk Developer Console (open-dev.dingtalk.com)",
      "2) Create an internal enterprise app",
      "3) Get Client ID and Client Secret from app page",
      "4) Enable Robot capability, select Stream mode",
      "5) Publish the app and set visible range",
      "Tip: you can also set DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET env vars.",
      `Docs: ${formatDocsLink("/channels/dingtalk", "dingtalk")}`,
    ].join("\n"),
    "DingTalk credentials",
  );
}

// 提示输入 Client ID / Prompt for Client ID
async function promptDingtalkClientId(params: {
  prompter: WizardPrompter;
  initialValue?: string;
}): Promise<string> {
  return String(
    await params.prompter.text({
      message: "Enter DingTalk Client ID (AppKey)",
      initialValue: params.initialValue,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
}

// 设置群组策略 / Set group policy
function setDingtalkGroupPolicy(
  cfg: ClawdbotConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
): ClawdbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: { ...cfg.channels?.dingtalk, enabled: true, groupPolicy },
    },
  };
}

// 设置群组白名单 / Set group allowlist
function setDingtalkGroupAllowFrom(cfg: ClawdbotConfig, groupAllowFrom: string[]): ClawdbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: { ...cfg.channels?.dingtalk, groupAllowFrom },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "DingTalk",
  channel,
  policyKey: "channels.dingtalk.dmPolicy",
  allowFromKey: "channels.dingtalk.allowFrom",
  getCurrent: (cfg) =>
    (cfg.channels?.dingtalk as DingtalkConfig | undefined)?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setDingtalkDmPolicy(cfg, policy),
  promptAllowFrom: promptDingtalkAllowFrom,
};

// 钉钉引导适配器 / DingTalk onboarding adapter
export const dingtalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg }) => {
    const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;

    const isClientIdConfigured = (value: unknown): boolean => {
      const asString = normalizeString(value);
      if (asString) return true;
      if (!value || typeof value !== "object") return false;
      const rec = value as Record<string, unknown>;
      const source = normalizeString(rec.source)?.toLowerCase();
      const id = normalizeString(rec.id);
      if (source === "env" && id) {
        return Boolean(normalizeString(process.env[id]));
      }
      return hasConfiguredSecretInput(value);
    };

    const topLevelConfigured = Boolean(
      isClientIdConfigured(dingtalkCfg?.clientId) &&
      hasConfiguredSecretInput(dingtalkCfg?.clientSecret),
    );

    const accountConfigured = Object.values(dingtalkCfg?.accounts ?? {}).some((account) => {
      if (!account || typeof account !== "object") return false;
      const a = account as Record<string, unknown>;
      const hasOwnClientId = Object.prototype.hasOwnProperty.call(a, "clientId");
      const hasOwnClientSecret = Object.prototype.hasOwnProperty.call(a, "clientSecret");
      const clientIdOk = hasOwnClientId
        ? isClientIdConfigured(a.clientId)
        : isClientIdConfigured(dingtalkCfg?.clientId);
      const clientSecretOk = hasOwnClientSecret
        ? hasConfiguredSecretInput(a.clientSecret)
        : hasConfiguredSecretInput(dingtalkCfg?.clientSecret);
      return Boolean(clientIdOk && clientSecretOk);
    });

    const configured = topLevelConfigured || accountConfigured;
    const resolvedCredentials = resolveDingtalkCredentials(dingtalkCfg, {
      allowUnresolvedSecretRef: true,
    });

    let probeResult = null;
    if (configured && resolvedCredentials) {
      try {
        probeResult = await probeDingtalk(resolvedCredentials);
      } catch {
        // 忽略探测错误 / Ignore probe errors
      }
    }

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("DingTalk: needs app credentials");
    } else if (probeResult?.ok) {
      statusLines.push(`DingTalk: connected (clientId: ${resolvedCredentials?.clientId})`);
    } else {
      statusLines.push("DingTalk: configured (connection not verified)");
    }

    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter }) => {
    const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
    const resolved = resolveDingtalkCredentials(dingtalkCfg, {
      allowUnresolvedSecretRef: true,
    });
    const hasConfigSecret = hasConfiguredSecretInput(dingtalkCfg?.clientSecret);
    const hasConfigCreds = Boolean(
      typeof dingtalkCfg?.clientId === "string" && dingtalkCfg.clientId.trim() && hasConfigSecret,
    );
    const canUseEnv = Boolean(
      !hasConfigCreds &&
      process.env.DINGTALK_CLIENT_ID?.trim() &&
      process.env.DINGTALK_CLIENT_SECRET?.trim(),
    );

    let next = cfg;
    let clientId: string | null = null;
    let clientSecret: SecretInput | null = null;
    let clientSecretProbeValue: string | null = null;

    if (!resolved) {
      await noteDingtalkCredentialHelp(prompter);
    }

    const secretResult = await promptSingleChannelSecretInput({
      cfg: next,
      prompter,
      providerHint: "dingtalk",
      credentialLabel: "Client Secret",
      accountConfigured: Boolean(resolved),
      canUseEnv,
      hasConfigToken: hasConfigSecret,
      envPrompt: "DINGTALK_CLIENT_ID + DINGTALK_CLIENT_SECRET detected. Use env vars?",
      keepPrompt: "DingTalk Client Secret already configured. Keep it?",
      inputPrompt: "Enter DingTalk Client Secret (AppSecret)",
      preferredEnvVar: "DINGTALK_CLIENT_SECRET",
    });

    if (secretResult.action === "use-env") {
      clientId = process.env.DINGTALK_CLIENT_ID?.trim() ?? null;
      next = {
        ...next,
        channels: {
          ...next.channels,
          dingtalk: {
            ...next.channels?.dingtalk,
            enabled: true,
            clientId: clientId ?? undefined,
            clientSecret: { source: "env", provider: "env", id: "DINGTALK_CLIENT_SECRET" },
          },
        },
      };
    } else if (secretResult.action === "set") {
      clientSecret = secretResult.value;
      clientSecretProbeValue = secretResult.resolvedValue;
      clientId = await promptDingtalkClientId({
        prompter,
        initialValue:
          normalizeString(dingtalkCfg?.clientId) ?? normalizeString(process.env.DINGTALK_CLIENT_ID),
      });
    }

    if (clientId && clientSecret) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          dingtalk: {
            ...next.channels?.dingtalk,
            enabled: true,
            clientId,
            clientSecret,
          },
        },
      };

      // 测试连接 / Test connection
      try {
        const probe = await probeDingtalk({
          clientId,
          clientSecret: clientSecretProbeValue ?? undefined,
        });
        if (probe.ok) {
          await prompter.note(`Connected (clientId: ${clientId})`, "DingTalk connection test");
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            "DingTalk connection test",
          );
        }
      } catch (err) {
        await prompter.note(`Connection test failed: ${String(err)}`, "DingTalk connection test");
      }
    }

    // 群组策略 / Group policy
    const groupPolicy = await prompter.select({
      message: "Group chat policy",
      options: [
        { value: "open", label: "Open - respond in all groups (requires mention)" },
        { value: "allowlist", label: "Allowlist - only respond in specific groups" },
        { value: "disabled", label: "Disabled - don't respond in groups" },
      ],
      initialValue: (next.channels?.dingtalk as DingtalkConfig | undefined)?.groupPolicy ?? "open",
    });
    if (groupPolicy) {
      next = setDingtalkGroupPolicy(next, groupPolicy as "open" | "allowlist" | "disabled");
    }

    // 群组白名单 / Group allowlist
    if (groupPolicy === "allowlist") {
      const existing =
        (next.channels?.dingtalk as DingtalkConfig | undefined)?.groupAllowFrom ?? [];
      const entry = await prompter.text({
        message: "Group allowlist (conversationIds)",
        placeholder: "cidXXXX, cidYYYY",
        initialValue: existing.length > 0 ? existing.map(String).join(", ") : undefined,
      });
      if (entry) {
        const parts = parseAllowFromInput(String(entry));
        if (parts.length > 0) {
          next = setDingtalkGroupAllowFrom(next, parts);
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
      dingtalk: { ...cfg.channels?.dingtalk, enabled: false },
    },
  }),
};

import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  ClawdbotConfig,
  DmPolicy,
  SecretInput,
  WizardPrompter,
} from "openclaw/plugin-sdk/feishu";
import {
  buildSingleChannelSecretPromptState,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  promptSingleChannelSecretInput,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuCredentials } from "./accounts.js";
import { probeFeishu } from "./probe.js";
import type { FeishuConfig } from "./types.js";

const channel = "feishu" as const;

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function setFeishuDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy): ClawdbotConfig {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel: "feishu",
    dmPolicy,
  }) as ClawdbotConfig;
}

function setFeishuAllowFrom(cfg: ClawdbotConfig, allowFrom: string[]): ClawdbotConfig {
  return setTopLevelChannelAllowFrom({
    cfg,
    channel: "feishu",
    allowFrom,
  }) as ClawdbotConfig;
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptFeishuAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
}): Promise<ClawdbotConfig> {
  const existing = params.cfg.channels?.feishu?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist Feishu DMs by open_id or user_id.",
      "You can find user open_id in Feishu admin console or via API.",
      "Examples:",
      "- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ].join("\n"),
    "Feishu allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "Feishu allowFrom (user open_ids)",
      placeholder: "ou_xxxxx, ou_yyyyy",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "Feishu allowlist");
      continue;
    }

    const unique = [
      ...new Set([
        ...existing.map((v: string | number) => String(v).trim()).filter(Boolean),
        ...parts,
      ]),
    ];
    return setFeishuAllowFrom(params.cfg, unique);
  }
}

async function noteFeishuCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Go to Feishu Open Platform (open.feishu.cn)",
      "2) Create a self-built app",
      "3) Get App ID and App Secret from Credentials page",
      "4) Enable required permissions: im:message, im:chat, contact:user.base:readonly",
      "5) Publish the app or add it to a test group",
      "Tip: you can also set FEISHU_APP_ID / FEISHU_APP_SECRET env vars.",
      `Docs: ${formatDocsLink("/channels/feishu", "feishu")}`,
    ].join("\n"),
    "Feishu credentials",
  );
}

async function promptFeishuAppId(params: {
  prompter: WizardPrompter;
  initialValue?: string;
}): Promise<string> {
  const appId = String(
    await params.prompter.text({
      message: "Enter Feishu App ID",
      initialValue: params.initialValue,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  return appId;
}

function setFeishuGroupPolicy(
  cfg: ClawdbotConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
): ClawdbotConfig {
  return setTopLevelChannelGroupPolicy({
    cfg,
    channel: "feishu",
    groupPolicy,
    enabled: true,
  }) as ClawdbotConfig;
}

function setFeishuGroupAllowFrom(cfg: ClawdbotConfig, groupAllowFrom: string[]): ClawdbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        groupAllowFrom,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Feishu",
  channel,
  policyKey: "channels.feishu.dmPolicy",
  allowFromKey: "channels.feishu.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.feishu as FeishuConfig | undefined)?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setFeishuDmPolicy(cfg, policy),
  promptAllowFrom: promptFeishuAllowFrom,
};

export const feishuOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
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

    const topLevelConfigured = Boolean(
      isAppIdConfigured(feishuCfg?.appId) && hasConfiguredSecretInput(feishuCfg?.appSecret),
    );

    const accountConfigured = Object.values(feishuCfg?.accounts ?? {}).some((account) => {
      if (!account || typeof account !== "object") {
        return false;
      }
      const hasOwnAppId = Object.prototype.hasOwnProperty.call(account, "appId");
      const hasOwnAppSecret = Object.prototype.hasOwnProperty.call(account, "appSecret");
      const accountAppIdConfigured = hasOwnAppId
        ? isAppIdConfigured((account as Record<string, unknown>).appId)
        : isAppIdConfigured(feishuCfg?.appId);
      const accountSecretConfigured = hasOwnAppSecret
        ? hasConfiguredSecretInput((account as Record<string, unknown>).appSecret)
        : hasConfiguredSecretInput(feishuCfg?.appSecret);
      return Boolean(accountAppIdConfigured && accountSecretConfigured);
    });

    const configured = topLevelConfigured || accountConfigured;
    const resolvedCredentials = resolveFeishuCredentials(feishuCfg, {
      allowUnresolvedSecretRef: true,
    });

    // Try to probe if configured
    let probeResult = null;
    if (configured && resolvedCredentials) {
      try {
        probeResult = await probeFeishu(resolvedCredentials);
      } catch {
        // Ignore probe errors
      }
    }

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("Feishu: needs app credentials");
    } else if (probeResult?.ok) {
      statusLines.push(
        `Feishu: connected as ${probeResult.botName ?? probeResult.botOpenId ?? "bot"}`,
      );
    } else {
      statusLines.push("Feishu: configured (connection not verified)");
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
    const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
    const resolved = resolveFeishuCredentials(feishuCfg, {
      allowUnresolvedSecretRef: true,
    });
    const hasConfigSecret = hasConfiguredSecretInput(feishuCfg?.appSecret);
    const hasConfigCreds = Boolean(
      typeof feishuCfg?.appId === "string" && feishuCfg.appId.trim() && hasConfigSecret,
    );
    const appSecretPromptState = buildSingleChannelSecretPromptState({
      accountConfigured: Boolean(resolved),
      hasConfigToken: hasConfigSecret,
      allowEnv: !hasConfigCreds && Boolean(process.env.FEISHU_APP_ID?.trim()),
      envValue: process.env.FEISHU_APP_SECRET,
    });

    let next = cfg;
    let appId: string | null = null;
    let appSecret: SecretInput | null = null;
    let appSecretProbeValue: string | null = null;

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
      preferredEnvVar: "FEISHU_APP_SECRET",
    });

    if (appSecretResult.action === "use-env") {
      next = {
        ...next,
        channels: {
          ...next.channels,
          feishu: { ...next.channels?.feishu, enabled: true },
        },
      };
    } else if (appSecretResult.action === "set") {
      appSecret = appSecretResult.value;
      appSecretProbeValue = appSecretResult.resolvedValue;
      appId = await promptFeishuAppId({
        prompter,
        initialValue:
          normalizeString(feishuCfg?.appId) ?? normalizeString(process.env.FEISHU_APP_ID),
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
            appSecret,
          },
        },
      };

      // Test connection
      try {
        const probe = await probeFeishu({
          appId,
          appSecret: appSecretProbeValue ?? undefined,
          domain: (next.channels?.feishu as FeishuConfig | undefined)?.domain,
        });
        if (probe.ok) {
          await prompter.note(
            `Connected as ${probe.botName ?? probe.botOpenId ?? "bot"}`,
            "Feishu connection test",
          );
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            "Feishu connection test",
          );
        }
      } catch (err) {
        await prompter.note(`Connection test failed: ${String(err)}`, "Feishu connection test");
      }
    }

    const currentMode =
      (next.channels?.feishu as FeishuConfig | undefined)?.connectionMode ?? "websocket";
    const connectionMode = (await prompter.select({
      message: "Feishu connection mode",
      options: [
        { value: "websocket", label: "WebSocket (default)" },
        { value: "webhook", label: "Webhook" },
      ],
      initialValue: currentMode,
    })) as "websocket" | "webhook";
    next = {
      ...next,
      channels: {
        ...next.channels,
        feishu: {
          ...next.channels?.feishu,
          connectionMode,
        },
      },
    };

    if (connectionMode === "webhook") {
      const currentVerificationToken = (next.channels?.feishu as FeishuConfig | undefined)
        ?.verificationToken;
      const verificationTokenPromptState = buildSingleChannelSecretPromptState({
        accountConfigured: hasConfiguredSecretInput(currentVerificationToken),
        hasConfigToken: hasConfiguredSecretInput(currentVerificationToken),
        allowEnv: false,
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
        preferredEnvVar: "FEISHU_VERIFICATION_TOKEN",
      });
      if (verificationTokenResult.action === "set") {
        next = {
          ...next,
          channels: {
            ...next.channels,
            feishu: {
              ...next.channels?.feishu,
              verificationToken: verificationTokenResult.value,
            },
          },
        };
      }
      const currentWebhookPath = (next.channels?.feishu as FeishuConfig | undefined)?.webhookPath;
      const webhookPath = String(
        await prompter.text({
          message: "Feishu webhook path",
          initialValue: currentWebhookPath ?? "/feishu/events",
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();
      next = {
        ...next,
        channels: {
          ...next.channels,
          feishu: {
            ...next.channels?.feishu,
            webhookPath,
          },
        },
      };
    }

    // Domain selection
    const currentDomain = (next.channels?.feishu as FeishuConfig | undefined)?.domain ?? "feishu";
    const domain = await prompter.select({
      message: "Which Feishu domain?",
      options: [
        { value: "feishu", label: "Feishu (feishu.cn) - China" },
        { value: "lark", label: "Lark (larksuite.com) - International" },
      ],
      initialValue: currentDomain,
    });
    if (domain) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          feishu: {
            ...next.channels?.feishu,
            domain: domain as "feishu" | "lark",
          },
        },
      };
    }

    // Group policy
    const groupPolicy = await prompter.select({
      message: "Group chat policy",
      options: [
        { value: "allowlist", label: "Allowlist - only respond in specific groups" },
        { value: "open", label: "Open - respond in all groups (requires mention)" },
        { value: "disabled", label: "Disabled - don't respond in groups" },
      ],
      initialValue: (next.channels?.feishu as FeishuConfig | undefined)?.groupPolicy ?? "allowlist",
    });
    if (groupPolicy) {
      next = setFeishuGroupPolicy(next, groupPolicy as "open" | "allowlist" | "disabled");
    }

    // Group allowlist if needed
    if (groupPolicy === "allowlist") {
      const existing = (next.channels?.feishu as FeishuConfig | undefined)?.groupAllowFrom ?? [];
      const entry = await prompter.text({
        message: "Group chat allowlist (chat_ids)",
        placeholder: "oc_xxxxx, oc_yyyyy",
        initialValue: existing.length > 0 ? existing.map(String).join(", ") : undefined,
      });
      if (entry) {
        const parts = parseAllowFromInput(String(entry));
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
      feishu: { ...cfg.channels?.feishu, enabled: false },
    },
  }),
};

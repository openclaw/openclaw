import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";

/** DmPolicy shape accepted by ChannelSetupWizard — extracted from wizard type for consistency. */
type WizardDmPolicy = NonNullable<ChannelSetupWizard["dmPolicy"]>;
import {
  listBlueBubblesAccountIds,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import {
  blueBubblesSetupAdapter,
  setBlueBubblesAllowFrom,
  setBlueBubblesDmPolicy,
} from "./setup-core.js";
import { parseBlueBubblesAllowTarget } from "./targets.js";
import { normalizeBlueBubblesServerUrl } from "./types.js";
import { DEFAULT_WEBHOOK_PATH } from "./webhook-shared.js";

const channel = "bluebubbles" as const;

function parseBlueBubblesAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateBlueBubblesAllowFromEntry(value: string): string | null {
  try {
    if (value === "*") {
      return value;
    }
    const parsed = parseBlueBubblesAllowTarget(value);
    if (parsed.kind === "handle" && !parsed.handle) {
      return null;
    }
    return value.trim() || null;
  } catch {
    return null;
  }
}

const promptBlueBubblesAllowFrom = createPromptParsedAllowFromForAccount({
  defaultAccountId: (cfg) => resolveDefaultBlueBubblesAccountId(cfg),
  noteTitle: "BlueBubbles allowlist",
  noteLines: [
    "Allowlist BlueBubbles DMs by handle or chat target.",
    "Examples:",
    "- +15555550123",
    "- user@example.com",
    "- chat_id:123",
    "- chat_guid:iMessage;-;+15555550123",
    "Multiple entries: comma- or newline-separated.",
    `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
  ],
  message: "BlueBubbles allowFrom (handle or chat_id)",
  placeholder: "+15555550123, user@example.com, chat_id:123",
  parseEntries: (raw) => {
    const entries = parseBlueBubblesAllowFromInput(raw);
    for (const entry of entries) {
      if (!validateBlueBubblesAllowFromEntry(entry)) {
        return { entries: [], error: `Invalid entry: ${entry}` };
      }
    }
    return { entries };
  },
  getExistingAllowFrom: ({ cfg, accountId }) =>
    resolveBlueBubblesAccount({ cfg, accountId }).config.allowFrom ?? [],
  applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
    setBlueBubblesAllowFrom(cfg, accountId, allowFrom),
});

function validateBlueBubblesServerUrlInput(value: unknown): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "Required";
  }
  try {
    const normalized = normalizeBlueBubblesServerUrl(trimmed);
    new URL(normalized);
    return undefined;
  } catch {
    return "Invalid URL format";
  }
}

function applyBlueBubblesSetupPatch(
  cfg: OpenClawConfig,
  accountId: string,
  patch: {
    serverUrl?: string;
    password?: unknown;
    webhookPath?: string;
  },
): OpenClawConfig {
  return applyBlueBubblesConnectionConfig({
    cfg,
    accountId,
    patch,
    onlyDefinedFields: true,
    accountEnabled: "preserve-or-true",
  });
}

function resolveBlueBubblesServerUrl(cfg: OpenClawConfig, accountId: string): string | undefined {
  return resolveBlueBubblesAccount({ cfg, accountId }).config.serverUrl?.trim() || undefined;
}

function resolveBlueBubblesWebhookPath(cfg: OpenClawConfig, accountId: string): string | undefined {
  return resolveBlueBubblesAccount({ cfg, accountId }).config.webhookPath?.trim() || undefined;
}

function validateBlueBubblesWebhookPath(value: string): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "Required";
  }
  if (!trimmed.startsWith("/")) {
    return "Path must start with /";
  }
  return undefined;
}

const dmPolicy: WizardDmPolicy = {
  label: "BlueBubbles",
  channel,
  policyKey: "channels.bluebubbles.dmPolicy",
  allowFromKey: "channels.bluebubbles.allowFrom",
  getCurrent: (cfg) => cfg.channels?.bluebubbles?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setBlueBubblesDmPolicy(cfg, policy),
  // Wrap to accept optional accountId (falls back to default) as required by WizardDmPolicy.
  promptAllowFrom: ({ cfg, prompter, accountId }) =>
    promptBlueBubblesAllowFrom({
      cfg,
      prompter,
      accountId: accountId ?? resolveDefaultBlueBubblesAccountId(cfg),
    }),
};

export const blueBubblesSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    ...createStandardChannelSetupStatus({
      channelLabel: "BlueBubbles",
      configuredLabel: "configured",
      unconfiguredLabel: "needs setup",
      configuredHint: "configured",
      unconfiguredHint: "iMessage via BlueBubbles app",
      configuredScore: 1,
      unconfiguredScore: 0,
      includeStatusLine: true,
      resolveConfigured: ({ cfg }) =>
        listBlueBubblesAccountIds(cfg).some((accountId) => {
          const account = resolveBlueBubblesAccount({ cfg, accountId });
          return account.configured;
        }),
    }),
    resolveSelectionHint: ({ cfg }) =>
      listBlueBubblesAccountIds(cfg).some((accountId) => {
        const account = resolveBlueBubblesAccount({ cfg, accountId });
        return account.configured;
      })
        ? "configured"
        : "iMessage via BlueBubbles app",
  },
  prepare: async ({ cfg, accountId, prompter }) => {
    const existingWebhookPath = resolveBlueBubblesWebhookPath(cfg, accountId);
    const wantsCustomWebhook = await prompter.confirm({
      message: `Configure a custom webhook path? (default: ${DEFAULT_WEBHOOK_PATH})`,
      initialValue: Boolean(existingWebhookPath && existingWebhookPath !== DEFAULT_WEBHOOK_PATH),
    });
    // Store the user's preference as a sentinel value in the config so that
    // the webhookPath textInput's shouldPrompt can read it without credentialValues.
    return {
      cfg: applyBlueBubblesSetupPatch(cfg, accountId, {
        webhookPath: wantsCustomWebhook
          ? (existingWebhookPath ?? DEFAULT_WEBHOOK_PATH)
          : DEFAULT_WEBHOOK_PATH,
      }),
    };
  },
  credentials: [
    {
      inputKey: "password",
      providerHint: channel,
      credentialLabel: "server password",
      helpTitle: "BlueBubbles password",
      helpLines: [
        "Enter the BlueBubbles server password.",
        "Find this in the BlueBubbles Server app under Settings.",
      ],
      envPrompt: "",
      keepPrompt: "BlueBubbles password already set. Keep it?",
      inputPrompt: "BlueBubbles password",
      inspect: ({ cfg, accountId }) => {
        const existingPassword = resolveBlueBubblesAccount({ cfg, accountId }).config.password;
        return {
          accountConfigured: resolveBlueBubblesAccount({ cfg, accountId }).configured,
          hasConfiguredValue: hasConfiguredSecretInput(existingPassword),
          resolvedValue: normalizeSecretInputString(existingPassword) ?? undefined,
        };
      },
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          password: resolvedValue,
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "httpUrl",
      message: "BlueBubbles server URL",
      placeholder: "http://192.168.1.100:1234",
      helpTitle: "BlueBubbles server URL",
      helpLines: [
        "Enter the BlueBubbles server URL (e.g., http://192.168.1.100:1234).",
        "Find this in the BlueBubbles Server app under Connection.",
        `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
      ],
      currentValue: ({ cfg, accountId }) => resolveBlueBubblesServerUrl(cfg, accountId),
      validate: ({ value }) => validateBlueBubblesServerUrlInput(value),
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          serverUrl: String(value).trim(),
        }),
    },
    {
      inputKey: "webhookPath",
      message: "Webhook path",
      placeholder: DEFAULT_WEBHOOK_PATH,
      currentValue: ({ cfg, accountId }) => {
        const value = resolveBlueBubblesWebhookPath(cfg, accountId);
        return value && value !== DEFAULT_WEBHOOK_PATH ? value : undefined;
      },
      // Only prompt for a custom webhook path when the existing path is non-default,
      // indicating the user opted in during prepare().
      shouldPrompt: ({ cfg, accountId }) => {
        const current = resolveBlueBubblesWebhookPath(cfg, accountId);
        return Boolean(current && current !== DEFAULT_WEBHOOK_PATH);
      },
      validate: ({ value }) => validateBlueBubblesWebhookPath(value),
      applySet: async ({ cfg, accountId, value }) =>
        applyBlueBubblesSetupPatch(cfg, accountId, {
          webhookPath: String(value).trim(),
        }),
    },
  ],
  completionNote: [
    "BlueBubbles next steps:",
    "Configure the webhook URL in BlueBubbles Server:",
    "1. Open BlueBubbles Server -> Settings -> Webhooks",
    "2. Add your OpenClaw gateway URL + webhook path",
    `   Example: https://your-gateway-host:3000${DEFAULT_WEBHOOK_PATH}`,
    "3. Enable the webhook and save",
    `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
  ].join("\n"),
  dmPolicy,
  allowFrom: createAllowFromSection({
    helpTitle: "BlueBubbles allowlist",
    helpLines: [
      "Allowlist BlueBubbles DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:iMessage;-;+15555550123",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ],
    message: "BlueBubbles allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
    invalidWithoutCredentialNote:
      "Use a BlueBubbles handle or chat target like +15555550123 or chat_id:123.",
    parseInputs: parseBlueBubblesAllowFromInput,
    parseId: (raw) => validateBlueBubblesAllowFromEntry(raw),
    apply: async ({ cfg, accountId, allowFrom }) =>
      setBlueBubblesAllowFrom(cfg, accountId, allowFrom),
  }),
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      bluebubbles: {
        ...cfg.channels?.bluebubbles,
        enabled: false,
      },
    },
  }),
};

export { blueBubblesSetupAdapter };

import { type ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
  createSetupTranslator,
  DEFAULT_ACCOUNT_ID,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  promptParsedAllowFromForAccount,
  setAccountAllowFromForChannel,
  setSetupChannelEnabled,
  createStandardChannelSetupStatus,
  type ChannelSetupAdapter,
  type OpenClawConfig,
  type WizardPrompter,
  type DmPolicy,
} from "openclaw/plugin-sdk/setup";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDefaultSpectrumAccountId, resolveSpectrumAccount } from "./accounts.js";
import { imessageSpectrumPlugin } from "./channel.js";

const t = createSetupTranslator();
const CHANNEL = "imessage-spectrum" as const;

function parseSpectrumAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return { error: "Empty entry" };
    return { value: trimmed };
  });
}

async function promptSpectrumAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSpectrumAccountId(params.cfg),
    prompter: params.prompter,
    noteTitle: t("wizard.imessageSpectrum.allowlistTitle"),
    noteLines: [
      t("wizard.imessageSpectrum.allowlistIntro"),
      "- you@icloud.com",
      t("wizard.imessageSpectrum.multipleEntries"),
      `Docs: ${formatDocsLink("/channels/imessage-spectrum", "imessage-spectrum")}`,
    ],
    message: t("wizard.imessageSpectrum.allowFromPrompt"),
    placeholder: "you@icloud.com, friend@icloud.com",
    parseEntries: parseSpectrumAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveSpectrumAccount({ cfg, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setAccountAllowFromForChannel({ cfg, channel: CHANNEL, accountId, allowFrom }),
  });
}

export const spectrumDmPolicy = {
  label: "iMessage (Spectrum)",
  channel: CHANNEL,
  policyKey: "channels.imessage-spectrum.dmPolicy",
  allowFromKey: "channels.imessage-spectrum.allowFrom",
  resolveConfigKeys: (cfg: OpenClawConfig, accountId?: string) => {
    const id = accountId ?? resolveDefaultSpectrumAccountId(cfg);
    return id !== DEFAULT_ACCOUNT_ID
      ? {
          policyKey: `channels.imessage-spectrum.accounts.${id}.dmPolicy`,
          allowFromKey: `channels.imessage-spectrum.accounts.${id}.allowFrom`,
        }
      : {
          policyKey: "channels.imessage-spectrum.dmPolicy",
          allowFromKey: "channels.imessage-spectrum.allowFrom",
        };
  },
  getCurrent: (cfg: OpenClawConfig, accountId?: string) =>
    (resolveSpectrumAccount({ cfg, accountId: accountId ?? resolveDefaultSpectrumAccountId(cfg) })
      .config.dmPolicy as DmPolicy) ?? "pairing",
  setPolicy: (
    cfg: OpenClawConfig,
    policy: "pairing" | "allowlist" | "open" | "disabled",
    accountId?: string,
  ) =>
    patchChannelConfigForAccount({
      cfg,
      channel: CHANNEL,
      accountId: accountId ?? resolveDefaultSpectrumAccountId(cfg),
      patch: { dmPolicy: policy },
    }),
  promptAllowFrom: promptSpectrumAllowFrom,
};

const spectrumInput = (input: Record<string, unknown>) => ({
  projectId: input.projectId as string | undefined,
  projectSecret: (input.projectSecret ?? input.secret) as string | undefined,
});

const spectrumSetupPatchBuilder = (input: Record<string, unknown>) => ({
  ...(input.projectId ? { projectId: input.projectId as string } : {}),
  ...(input.projectSecret || input.secret
    ? { projectSecret: (input.projectSecret ?? input.secret) as string }
    : {}),
  ...(input.webhookSecret ? { webhookSecret: input.webhookSecret as string } : {}),
  ...(input.webhookBaseUrl ? { webhookBaseUrl: input.webhookBaseUrl as string } : {}),
});

function spectrumWebhookConfigPath(accountId?: string): string {
  const normalized = accountId?.trim();
  return normalized && normalized !== DEFAULT_ACCOUNT_ID
    ? `channels.imessage-spectrum.accounts.${normalized}.webhookSecret`
    : "channels.imessage-spectrum.webhookSecret";
}

function spectrumWebhookBaseUrlConfigPath(accountId?: string): string {
  const normalized = accountId?.trim();
  return normalized && normalized !== DEFAULT_ACCOUNT_ID
    ? `channels.imessage-spectrum.accounts.${normalized}.webhookBaseUrl`
    : "channels.imessage-spectrum.webhookBaseUrl";
}

function normalizeWebhookBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildSpectrumWebhookUrl(webhookBaseUrl: string): string {
  const base = normalizeWebhookBaseUrl(webhookBaseUrl);
  return base
    ? `${base}/channels/imessage-spectrum/webhook`
    : "<public-base-url>/channels/imessage-spectrum/webhook";
}

export function buildSpectrumWebhookRegistrationCurl(params: {
  projectId: string;
  webhookBaseUrl?: string;
}): string {
  const projectId = params.projectId.trim() || "<PROJECT_ID>";
  const webhookUrl = buildSpectrumWebhookUrl(params.webhookBaseUrl ?? "");
  return [
    `SPECTRUM_PROJECT_ID=${shellSingleQuote(projectId)}`,
    `SPECTRUM_PROJECT_SECRET='<paste-project-secret>'`,
    `curl -sS -X POST "https://spectrum.photon.codes/projects/$SPECTRUM_PROJECT_ID/webhooks/" \\`,
    `  -u "$SPECTRUM_PROJECT_ID:$SPECTRUM_PROJECT_SECRET" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellSingleQuote(JSON.stringify({ webhookUrl }))}`,
  ].join("\n");
}

function buildSpectrumWebhookSetupNote(params: {
  projectId: string;
  webhookBaseUrl: string;
  accountId?: string;
}): string {
  const webhookUrl = buildSpectrumWebhookUrl(params.webhookBaseUrl);
  const webhookBaseUrlPath = spectrumWebhookBaseUrlConfigPath(params.accountId);
  const webhookSecretPath = spectrumWebhookConfigPath(params.accountId);
  const lines = [
    "Use this after your public HTTPS gateway URL is reachable.",
    "",
    `Webhook URL: ${webhookUrl}`,
    "",
    buildSpectrumWebhookRegistrationCurl({
      projectId: params.projectId,
      webhookBaseUrl: params.webhookBaseUrl,
    }),
    "",
    "Photon returns a signing secret in the response. Paste that value into the next prompt.",
    `Save later: ${formatCliCommand(`openclaw config set ${webhookSecretPath} <signingSecret>`)}`,
  ];

  if (!params.webhookBaseUrl.trim()) {
    lines.splice(
      1,
      0,
      `Set the base URL later: ${formatCliCommand(
        `openclaw config set ${webhookBaseUrlPath} <https-url>`,
      )}`,
    );
  }

  return lines.join("\n");
}

export const spectrumSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: CHANNEL,
  validateInput: createSetupInputPresenceValidator({
    validate: ({ input }) => {
      const i = spectrumInput(input as Record<string, unknown>);
      if (!i.projectId || !i.projectSecret) {
        return "iMessage (Spectrum) requires --project-id and --project-secret.";
      }
      return null;
    },
  }),
  buildPatch: (input) => spectrumSetupPatchBuilder(input as Record<string, unknown>),
});

export const imessageSpectrumSetupPlugin: ChannelPlugin = {
  ...imessageSpectrumPlugin,
  setupWizard: {
    channel: CHANNEL,
    introNote: {
      title: "iMessage (Spectrum)",
      lines: [
        "Connect OpenClaw to iMessage through Spectrum by Photon.",
        "You need a Spectrum Project ID and Project Secret from Photon.",
        "Inbound messages also need a public HTTPS gateway URL and Photon webhook signing secret.",
      ],
    },
    status: createStandardChannelSetupStatus({
      channelLabel: "iMessage (Spectrum)",
      configuredLabel: "Configured",
      unconfiguredLabel: "Missing project credentials",
      resolveConfigured: ({ cfg }) => resolveSpectrumAccount({ cfg }).configured,
    }),
    credentials: [],
    finalize: async ({ cfg, accountId, prompter }) => {
      const account = resolveSpectrumAccount({ cfg, accountId });

      const projectId = (
        await prompter.text({
          message: "Spectrum Project ID",
          initialValue: account.projectId || undefined,
          placeholder: "proj_...",
          validate: (val) => (val?.trim() ? undefined : "Spectrum Project ID is required."),
        })
      ).trim();

      const projectSecret = (
        await prompter.text({
          message: "Spectrum Project Secret",
          initialValue: account.projectSecret || undefined,
          placeholder: "Paste the project secret from Photon",
          sensitive: true,
          validate: (val) => (val?.trim() ? undefined : "Spectrum Project Secret is required."),
        })
      ).trim();

      const webhookBaseUrl = (
        await prompter.text({
          message: "Public Webhook Base URL",
          initialValue: account.webhookBaseUrl || undefined,
          placeholder: "https://your-gateway.example.com",
          validate: (val) => {
            const trimmed = val?.trim() ?? "";
            if (!trimmed) {
              return undefined;
            }
            try {
              const url = new URL(trimmed);
              return url.protocol === "https:" ? undefined : "Use an https:// URL.";
            } catch {
              return "Enter a valid https:// URL, or leave blank to add it later.";
            }
          },
        })
      )
        .trim()
        .replace(/\/+$/, "");

      if (!account.webhookSecret) {
        await prompter.note(
          buildSpectrumWebhookSetupNote({ projectId, webhookBaseUrl, accountId }),
          "Photon webhook",
        );
      }

      const webhookSecret = (
        await prompter.text({
          message: "Webhook Signing Secret",
          initialValue: account.webhookSecret || undefined,
          placeholder: "Paste Photon signingSecret, or leave blank to add later",
          sensitive: true,
        })
      ).trim();

      const next = patchChannelConfigForAccount({
        cfg,
        channel: CHANNEL,
        accountId,
        patch: {
          enabled: true,
          projectId,
          projectSecret,
          ...(webhookBaseUrl ? { webhookBaseUrl } : {}),
          ...(webhookSecret ? { webhookSecret } : {}),
        },
      });

      return { cfg: next };
    },
    completionNote: {
      title: "iMessage (Spectrum) Setup Complete",
      lines: [
        "Gateway",
        "- Expose OpenClaw with a stable HTTPS URL, for example Cloudflare Tunnel to http://localhost:18789.",
        `- Save it with: ${formatCliCommand(
          "openclaw config set channels.imessage-spectrum.webhookBaseUrl <https-url>",
        )}`,
        "",
        "Photon webhook",
        "- Register the webhook using the curl command shown during setup.",
        "- Paste the returned signingSecret into channels.imessage-spectrum.webhookSecret.",
        "",
        "Verify",
        `- Restart: ${formatCliCommand("openclaw gateway restart")}`,
        `- Health: ${formatCliCommand("curl <public-base-url>/channels/imessage-spectrum/health")}`,
        `- Doctor: ${formatCliCommand("openclaw doctor imessage-spectrum")}`,
      ],
    },
    dmPolicy: spectrumDmPolicy,
    disable: (cfg) => setSetupChannelEnabled(cfg, CHANNEL, false),
  },
};

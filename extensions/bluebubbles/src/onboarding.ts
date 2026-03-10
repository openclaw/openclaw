import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  DmPolicy,
  WizardPrompter,
} from "openclaw/plugin-sdk/bluebubbles";
import {
  formatDocsLink,
  mergeAllowFromEntries,
  normalizeAccountId,
  patchScopedAccountConfig,
  resolveAccountIdForConfigure,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "openclaw/plugin-sdk/bluebubbles";
import {
  listBlueBubblesAccountIds,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { applyBlueBubblesConnectionConfig } from "./config-apply.js";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./secret-input.js";
import { parseBlueBubblesAllowTarget } from "./targets.js";
import { normalizeBlueBubblesServerUrl } from "./types.js";

const channel = "bluebubbles" as const;

function setBlueBubblesDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel: "bluebubbles",
    dmPolicy,
  });
}

function setBlueBubblesAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: { allowFrom },
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  });
}

function parseBlueBubblesAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptBlueBubblesAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultBlueBubblesAccountId(params.cfg);
  const resolved = resolveBlueBubblesAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist BlueBubbles DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:iMessage;-;+15555550123",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ].join("\n"),
    "BlueBubbles allowlist",
  );
  const entry = await params.prompter.text({
    message: "BlueBubbles allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parts = parseBlueBubblesAllowFromInput(raw);
      for (const part of parts) {
        if (part === "*") {
          continue;
        }
        const parsed = parseBlueBubblesAllowTarget(part);
        if (parsed.kind === "handle" && !parsed.handle) {
          return `Invalid entry: ${part}`;
        }
      }
      return undefined;
    },
  });
  const parts = parseBlueBubblesAllowFromInput(String(entry));
  const unique = mergeAllowFromEntries(undefined, parts);
  return setBlueBubblesAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "BlueBubbles",
  channel,
  policyKey: "channels.bluebubbles.dmPolicy",
  allowFromKey: "channels.bluebubbles.allowFrom",
  getCurrent: (cfg) => cfg.channels?.bluebubbles?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setBlueBubblesDmPolicy(cfg, policy),
  promptAllowFrom: promptBlueBubblesAllowFrom,
};

export const blueBubblesOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listBlueBubblesAccountIds(cfg).some((accountId) => {
      const account = resolveBlueBubblesAccount({ cfg, accountId });
      return account.configured;
    });
    return {
      channel,
      configured,
      statusLines: [`BlueBubbles: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "iMessage via BlueBubbles app",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const defaultAccountId = resolveDefaultBlueBubblesAccountId(cfg);
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "BlueBubbles",
      accountOverride: accountOverrides.bluebubbles,
      shouldPromptAccountIds,
      listAccountIds: listBlueBubblesAccountIds,
      defaultAccountId,
    });

    let next = cfg;
    const resolvedAccount = resolveBlueBubblesAccount({ cfg: next, accountId });
    const validateServerUrlInput = (value: unknown): string | undefined => {
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
    };
    const promptServerUrl = async (initialValue?: string): Promise<string> => {
      const entered = await prompter.text({
        message: "BlueBubbles server URL",
        placeholder: "http://192.168.1.100:1234",
        initialValue,
        validate: validateServerUrlInput,
      });
      return String(entered).trim();
    };

    // Prompt for server URL
    let serverUrl = resolvedAccount.config.serverUrl?.trim();
    if (!serverUrl) {
      await prompter.note(
        [
          "Enter the BlueBubbles server URL (e.g., http://192.168.1.100:1234).",
          "Find this in the BlueBubbles Server app under Connection.",
          `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
        ].join("\n"),
        "BlueBubbles server URL",
      );
      serverUrl = await promptServerUrl();
    } else {
      const keepUrl = await prompter.confirm({
        message: `BlueBubbles server URL already set (${serverUrl}). Keep it?`,
        initialValue: true,
      });
      if (!keepUrl) {
        serverUrl = await promptServerUrl(serverUrl);
      }
    }

    // Prompt for password
    const existingPassword = resolvedAccount.config.password;
    const existingPasswordText = normalizeSecretInputString(existingPassword);
    const hasConfiguredPassword = hasConfiguredSecretInput(existingPassword);
    let password: unknown = existingPasswordText;
    if (!hasConfiguredPassword) {
      await prompter.note(
        [
          "Enter the BlueBubbles server password.",
          "Find this in the BlueBubbles Server app under Settings.",
        ].join("\n"),
        "BlueBubbles password",
      );
      const entered = await prompter.text({
        message: "BlueBubbles password",
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      });
      password = String(entered).trim();
    } else {
      const keepPassword = await prompter.confirm({
        message: "BlueBubbles password already set. Keep it?",
        initialValue: true,
      });
      if (!keepPassword) {
        const entered = await prompter.text({
          message: "BlueBubbles password",
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        });
        password = String(entered).trim();
      } else if (!existingPasswordText) {
        password = existingPassword;
      }
    }

    // Prompt for webhook path (optional)
    const existingWebhookPath = resolvedAccount.config.webhookPath?.trim();
    const wantsWebhook = await prompter.confirm({
      message: "Configure a custom webhook path? (default: /bluebubbles-webhook)",
      initialValue: Boolean(existingWebhookPath && existingWebhookPath !== "/bluebubbles-webhook"),
    });
    let webhookPath = "/bluebubbles-webhook";
    if (wantsWebhook) {
      const entered = await prompter.text({
        message: "Webhook path",
        placeholder: "/bluebubbles-webhook",
        initialValue: existingWebhookPath || "/bluebubbles-webhook",
        validate: (value) => {
          const trimmed = String(value ?? "").trim();
          if (!trimmed) {
            return "Required";
          }
          if (!trimmed.startsWith("/")) {
            return "Path must start with /";
          }
          return undefined;
        },
      });
      webhookPath = String(entered).trim();
    }

    // Apply config
    next = applyBlueBubblesConnectionConfig({
      cfg: next,
      accountId,
      patch: {
        serverUrl,
        password,
        webhookPath,
      },
      accountEnabled: "preserve-or-true",
    });

    await prompter.note(
      [
        "Configure the webhook URL in BlueBubbles Server:",
        "1. Open BlueBubbles Server → Settings → Webhooks",
        "2. Add your OpenClaw gateway URL + webhook path",
        "   Example: https://your-gateway-host:3000/bluebubbles-webhook",
        "3. Enable the webhook and save",
        "",
        `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
      ].join("\n"),
      "BlueBubbles next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      bluebubbles: { ...cfg.channels?.bluebubbles, enabled: false },
    },
  }),
};

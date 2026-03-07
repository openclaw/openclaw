import type { OpenClawConfig, DmPolicy } from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  formatDocsLink,
  mergeAllowFromEntries,
  promptAccountId,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type WizardPrompter,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk";
import {
  listGoHighLevelAccountIds,
  resolveDefaultGoHighLevelAccountId,
  resolveGoHighLevelAccount,
} from "./accounts.js";

const channel = "gohighlevel" as const;

const ENV_API_KEY_NAMES = ["GHL_API_KEY", "GHL_TOKEN"] as const;

function setGoHighLevelDmPolicy(cfg: OpenClawConfig, policy: DmPolicy) {
  const allowFrom =
    policy === "open"
      ? addWildcardAllowFrom(cfg.channels?.["gohighlevel"]?.dm?.allowFrom)
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      gohighlevel: {
        ...cfg.channels?.["gohighlevel"],
        dm: {
          ...cfg.channels?.["gohighlevel"]?.dm,
          policy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const current = params.cfg.channels?.["gohighlevel"]?.dm?.allowFrom ?? [];
  const entry = await params.prompter.text({
    message: "GoHighLevel allowFrom (contact IDs or phone numbers)",
    placeholder: "contactId1, +15551234567",
    initialValue: current[0] ? String(current[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  const parts = parseAllowFromInput(String(entry));
  const unique = mergeAllowFromEntries(undefined, parts);
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      gohighlevel: {
        ...params.cfg.channels?.["gohighlevel"],
        enabled: true,
        dm: {
          ...params.cfg.channels?.["gohighlevel"]?.dm,
          policy: "allowlist",
          allowFrom: unique,
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "GoHighLevel",
  channel,
  policyKey: "channels.gohighlevel.dm.policy",
  allowFromKey: "channels.gohighlevel.dm.allowFrom",
  getCurrent: (cfg) => cfg.channels?.["gohighlevel"]?.dm?.policy ?? "open",
  setPolicy: (cfg, policy) => setGoHighLevelDmPolicy(cfg, policy),
  promptAllowFrom,
};

function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const { cfg, accountId, patch } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        gohighlevel: {
          ...cfg.channels?.["gohighlevel"],
          enabled: true,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      gohighlevel: {
        ...cfg.channels?.["gohighlevel"],
        enabled: true,
        accounts: {
          ...cfg.channels?.["gohighlevel"]?.accounts,
          [accountId]: {
            ...cfg.channels?.["gohighlevel"]?.accounts?.[accountId],
            enabled: true,
            ...patch,
          },
        },
      },
    },
  };
}

async function promptCredentials(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const envKeyName = ENV_API_KEY_NAMES.find((n) => process.env[n]?.trim());
  const envReady = accountId === DEFAULT_ACCOUNT_ID && Boolean(envKeyName);
  if (envReady) {
    const useEnv = await prompter.confirm({
      message: `Use ${envKeyName} env var?`,
      initialValue: true,
    });
    if (useEnv) {
      return applyAccountConfig({ cfg, accountId, patch: {} });
    }
  }

  const apiKey = await prompter.text({
    message: "GoHighLevel API key (Private Integration Token)",
    placeholder: "pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return applyAccountConfig({
    cfg,
    accountId,
    patch: { apiKey: String(apiKey).trim() },
  });
}

async function promptLocationId(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const account = resolveGoHighLevelAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const currentLocation = account.locationId ?? "";
  const locationId = await params.prompter.text({
    message: "GoHighLevel Location ID",
    placeholder: "xxxxxxxxxxxxxxxxxxxxxxxx",
    initialValue: currentLocation || undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });
  return applyAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: { locationId: String(locationId).trim() },
  });
}

async function noteGoHighLevelSetup(prompter: WizardPrompter) {
  await prompter.note(
    [
      "GoHighLevel uses a Private Integration Token for API access.",
      "Create one in Settings > Integrations > Private Integrations.",
      "Configure a GHL Workflow with 'Customer Replied' trigger to send webhooks.",
      `Docs: ${formatDocsLink("/channels/gohighlevel", "channels/gohighlevel")}`,
    ].join("\n"),
    "GoHighLevel setup",
  );
}

export const gohighlevelOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listGoHighLevelAccountIds(cfg).some(
      (accountId) => resolveGoHighLevelAccount({ cfg, accountId }).credentialSource !== "none",
    );
    return {
      channel,
      configured,
      statusLines: [`GoHighLevel: ${configured ? "configured" : "needs API key"}`],
      selectionHint: configured ? "configured" : "needs auth",
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides["gohighlevel"]?.trim();
    const defaultAccountId = resolveDefaultGoHighLevelAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "GoHighLevel",
        currentId: accountId,
        listAccountIds: listGoHighLevelAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    await noteGoHighLevelSetup(prompter);
    next = await promptCredentials({ cfg: next, prompter, accountId });
    next = await promptLocationId({ cfg: next, prompter, accountId });

    return { cfg: next, accountId };
  },
};

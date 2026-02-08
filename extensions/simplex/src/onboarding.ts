import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  DmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  normalizeAccountId,
  promptAccountId,
} from "openclaw/plugin-sdk";
import {
  listSimplexAccountIds,
  resolveDefaultSimplexAccountId,
  resolveSimplexAccount,
} from "./accounts.js";

const channel = "simplex" as const;

function hasSimplexConfig(cfg: OpenClawConfig): boolean {
  const entry = cfg.channels?.simplex;
  if (!entry || typeof entry !== "object") {
    return false;
  }
  return Object.keys(entry as Record<string, unknown>).length > 0;
}

function setSimplexEnabled(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        simplex: {
          ...cfg.channels?.simplex,
          enabled: true,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      simplex: {
        ...cfg.channels?.simplex,
        enabled: true,
        accounts: {
          ...cfg.channels?.simplex?.accounts,
          [accountId]: {
            ...cfg.channels?.simplex?.accounts?.[accountId],
            enabled: true,
          },
        },
      },
    },
  };
}

function setSimplexDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.simplex?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      simplex: {
        ...cfg.channels?.simplex,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setSimplexAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        simplex: {
          ...cfg.channels?.simplex,
          enabled: true,
          allowFrom,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      simplex: {
        ...cfg.channels?.simplex,
        enabled: true,
        accounts: {
          ...cfg.channels?.simplex?.accounts,
          [accountId]: {
            ...cfg.channels?.simplex?.accounts?.[accountId],
            enabled: true,
            allowFrom,
          },
        },
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .replaceAll("\n", ",")
    .replaceAll(";", ",")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function noteSimplexSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Install the simplex-chat CLI on the gateway host.",
      "Run simplex-chat once to finish profile setup if prompted.",
      "Use the Control UI to create invite or address links.",
      `Docs: ${formatDocsLink("/channels/simplex", "channels/simplex")}`,
    ].join("\n"),
    "SimpleX setup",
  );
}

async function promptSimplexAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const resolvedAccountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultSimplexAccountId(params.cfg);
  const resolved = resolveSimplexAccount({
    cfg: params.cfg,
    accountId: resolvedAccountId,
  });
  const existingAllowFrom = resolved.config.allowFrom ?? [];

  await params.prompter.note(
    [
      "Allowlist SimpleX contacts or groups.",
      "Use contact ids (prefix @ or contact:) or group ids (# or group:).",
      "Examples:",
      "- @abc123",
      "- contact:abc123",
      "- #groupId",
    ].join("\n"),
    "SimpleX allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "SimpleX allowFrom (contact or group id)",
      placeholder: "@contactId, #groupId",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const values = parseAllowFromInput(String(entry));
    if (values.length === 0) {
      await params.prompter.note("Enter at least one id.", "SimpleX allowlist");
      continue;
    }
    const merged = [
      ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
      ...values,
    ];
    const unique = [...new Set(merged)];
    return setSimplexAllowFrom(params.cfg, resolvedAccountId, unique);
  }
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "SimpleX",
  channel,
  policyKey: "channels.simplex.dmPolicy",
  allowFromKey: "channels.simplex.allowFrom",
  getCurrent: (cfg) => cfg.channels?.simplex?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setSimplexDmPolicy(cfg, policy),
  promptAllowFrom: promptSimplexAllowFrom,
};

export const simplexOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = hasSimplexConfig(cfg);
    return {
      channel,
      configured,
      statusLines: [`SimpleX: ${configured ? "configured" : "not configured"}`],
      selectionHint: configured ? "configured" : "not configured",
      quickstartScore: configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter, shouldPromptAccountIds, forceAllowFrom }) => {
    const defaultAccountId = resolveDefaultSimplexAccountId(cfg);
    const accountId = shouldPromptAccountIds
      ? await promptAccountId({
          cfg,
          prompter,
          label: "SimpleX",
          listAccountIds: listSimplexAccountIds,
          defaultAccountId,
        })
      : defaultAccountId;

    if (!hasSimplexConfig(cfg)) {
      await noteSimplexSetup(prompter);
    }

    let next = setSimplexEnabled(cfg, accountId);

    if (forceAllowFrom && dmPolicy.promptAllowFrom) {
      next = await dmPolicy.promptAllowFrom({ cfg: next, prompter, accountId });
    }

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      simplex: {
        ...cfg.channels?.simplex,
        enabled: false,
      },
    },
  }),
};

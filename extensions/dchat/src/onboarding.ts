import type { DmPolicy } from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  formatDocsLink,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import { listDchatAccountIds, resolveDchatAccount, type CoreConfig } from "./config-schema.js";

const channel = "dchat" as const;

function setDchatDmPolicy(cfg: CoreConfig, policy: DmPolicy) {
  const existingAllowFrom = cfg.channels?.dchat?.dm?.allowFrom ?? [];
  const allowFrom =
    policy === "open"
      ? addWildcardAllowFrom(existingAllowFrom)
      : existingAllowFrom.filter((e) => String(e) !== "*");
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dchat: {
        ...cfg.channels?.dchat,
        dm: {
          ...cfg.channels?.dchat?.dm,
          policy,
          allowFrom,
        },
      },
    },
  };
}

async function promptDchatAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
}): Promise<CoreConfig> {
  const { cfg, prompter } = params;
  const existingAllowFrom = cfg.channels?.dchat?.dm?.allowFrom ?? [];

  const entry = await prompter.text({
    message: "NKN address to allow (full public key hex)",
    placeholder: "abc123...def456 (64-char hex NKN address)",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const parts = String(entry)
    .split(/[\n,;]+/g)
    .map((e) => e.trim())
    .filter(Boolean);

  const unique = mergeAllowFromEntries(existingAllowFrom, parts);
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dchat: {
        ...cfg.channels?.dchat,
        enabled: true,
        dm: {
          ...cfg.channels?.dchat?.dm,
          policy: "allowlist",
          allowFrom: unique,
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "D-Chat",
  channel,
  policyKey: "channels.dchat.dm.policy",
  allowFromKey: "channels.dchat.dm.allowFrom",
  getCurrent: (cfg) => ((cfg as CoreConfig).channels?.dchat?.dm?.policy as DmPolicy) ?? "pairing",
  setPolicy: (cfg, policy) => setDchatDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: promptDchatAllowFrom,
};

export const dchatOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const typedCfg = cfg as CoreConfig;
    const accountIds = listDchatAccountIds(typedCfg);
    const anyConfigured = accountIds.some(
      (id) => resolveDchatAccount({ cfg: typedCfg, accountId: id }).configured,
    );
    return {
      channel,
      configured: anyConfigured,
      statusLines: [`D-Chat: ${anyConfigured ? "configured" : "needs wallet seed"}`],
      selectionHint: anyConfigured ? "configured" : "needs seed",
    };
  },
  configure: async ({ cfg, prompter, forceAllowFrom }) => {
    let next = cfg as CoreConfig;
    const existing = next.channels?.dchat ?? {};
    const account = resolveDchatAccount({ cfg: next });

    if (!account.configured) {
      await prompter.note(
        [
          "D-Chat uses the NKN relay network for decentralized E2E encrypted messaging.",
          "You need a wallet seed (64-character hex string) to connect.",
          "Generate one with nkn-sdk or use an existing seed from D-Chat/nMobile.",
          `Docs: ${formatDocsLink("/channels/dchat", "channels/dchat")}`,
        ].join("\n"),
        "D-Chat setup",
      );
    }

    // Check for env var (validate same 64-hex format as prompted input)
    const envSeed = process.env.DCHAT_SEED?.trim() || process.env.NKN_SEED?.trim();
    if (envSeed && /^[0-9a-f]{64}$/i.test(envSeed) && !existing.seed) {
      const useEnv = await prompter.confirm({
        message: "NKN seed env var detected. Use env value?",
        initialValue: true,
      });
      if (useEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            dchat: {
              ...next.channels?.dchat,
              enabled: true,
              seed: envSeed,
            },
          },
        };
        if (forceAllowFrom) {
          next = await promptDchatAllowFrom({ cfg: next, prompter });
        }
        return { cfg: next };
      }
    }

    // Prompt for seed
    let seed = existing.seed ?? "";
    if (seed) {
      const keep = await prompter.confirm({
        message: "Wallet seed already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        seed = "";
      }
    }

    if (!seed) {
      seed = String(
        await prompter.text({
          message: "NKN wallet seed (64-char hex)",
          validate: (value) => {
            const raw = String(value ?? "").trim();
            if (!raw) return "Required";
            if (!/^[0-9a-f]{64}$/i.test(raw)) {
              return "Must be a 64-character hex string";
            }
            return undefined;
          },
        }),
      ).trim();
    }

    next = {
      ...next,
      channels: {
        ...next.channels,
        dchat: {
          ...next.channels?.dchat,
          enabled: true,
          seed,
        },
      },
    };

    if (forceAllowFrom) {
      next = await promptDchatAllowFrom({ cfg: next, prompter });
    }

    return { cfg: next };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      dchat: { ...(cfg as CoreConfig).channels?.dchat, enabled: false },
    },
  }),
};

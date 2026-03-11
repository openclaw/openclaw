import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  DmPolicy,
} from "openclaw/plugin-sdk";
import { addWildcardAllowFrom, DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import { resolveNovaCredentials } from "./credentials.js";

const channel = "nova" as const;

function setNovaDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.channels?.nova?.allowFrom)?.map((entry) => String(entry))
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      nova: {
        ...cfg.channels?.nova,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setNovaAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      nova: {
        ...cfg.channels?.nova,
        allowFrom,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Nova",
  channel,
  policyKey: "channels.nova.dmPolicy",
  allowFromKey: "channels.nova.allowFrom",
  getCurrent: (cfg) => cfg.channels?.nova?.dmPolicy ?? "allowlist",
  setPolicy: (cfg, policy) => setNovaDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter }) => {
    const existing = cfg.channels?.nova?.allowFrom ?? [];
    const entry = await prompter.text({
      message: "Nova allowFrom (user ids, comma-separated)",
      placeholder: "nova-user-id-1, nova-user-id-2",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = String(entry)
      .split(/[\n,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    const unique = [
      ...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...parts]),
    ];
    return setNovaAllowFrom(cfg, unique);
  },
};

export const novaOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = Boolean(resolveNovaCredentials(cfg.channels?.nova));
    return {
      channel,
      configured,
      statusLines: [`Nova: ${configured ? "configured" : "needs credentials"}`],
      selectionHint: configured ? "configured" : "needs credentials",
      quickstartScore: configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const resolved = resolveNovaCredentials(cfg.channels?.nova);
    let next = cfg;
    let apiKey: string | null = null;
    let userId: string | null = null;
    let baseUrl: string | null = null;

    const hasConfigCreds = Boolean(
      cfg.channels?.nova?.apiKey?.trim() && cfg.channels?.nova?.userId?.trim(),
    );
    const canUseEnv = Boolean(
      !hasConfigCreds && process.env.NOVA_API_KEY?.trim() && process.env.NOVA_USER_ID?.trim(),
    );

    if (!resolved) {
      await prompter.note(
        [
          "Configure Nova channel.",
          "You need:",
          "- API key (Bearer token)",
          "- User ID (your Nova user identity)",
          "- Base URL (optional, defaults to wss://ws.nova-claw.agi.amazon.dev)",
          "Tip: set NOVA_API_KEY / NOVA_USER_ID env vars.",
        ].join("\n"),
        "Nova credentials",
      );
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message: "NOVA_API_KEY + NOVA_USER_ID detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            nova: { ...next.channels?.nova, enabled: true },
          },
        };
      } else {
        apiKey = await promptApiKey(prompter);
        userId = await promptUserId(prompter);
        baseUrl = await promptBaseUrl(prompter);
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "Nova credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        apiKey = await promptApiKey(prompter);
        userId = await promptUserId(prompter);
        baseUrl = await promptBaseUrl(prompter);
      }
    } else {
      apiKey = await promptApiKey(prompter);
      userId = await promptUserId(prompter);
      baseUrl = await promptBaseUrl(prompter);
    }

    if (apiKey && userId) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          nova: {
            ...next.channels?.nova,
            enabled: true,
            ...(baseUrl ? { baseUrl } : {}),
            apiKey,
            userId,
          },
        },
      };
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      nova: { ...cfg.channels?.nova, enabled: false },
    },
  }),
};

type Prompter = Parameters<ChannelOnboardingAdapter["configure"]>[0]["prompter"];

async function promptApiKey(prompter: Prompter): Promise<string> {
  return String(
    await prompter.text({
      message: "Nova API key",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptUserId(prompter: Prompter): Promise<string> {
  return String(
    await prompter.text({
      message: "Nova user ID",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();
}

async function promptBaseUrl(prompter: Prompter): Promise<string | null> {
  const value = String(
    await prompter.text({
      message: "Base URL (leave empty for default)",
      placeholder: "wss://ws.nova-claw.agi.amazon.dev",
    }),
  ).trim();
  return value || null;
}

import type { ChannelOnboardingAdapter, OpenClawConfig } from "openclaw/plugin-sdk/compat";
import {
  promptAccountId,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  formatDocsLink,
} from "openclaw/plugin-sdk/compat";
import { getXChannel } from "./runtime.js";

const channel = "x" as const;

type XCredentialInput = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  pollIntervalSeconds?: number;
  proxy?: string;
  allowFrom?: string[];
  actionsAllowFrom?: string[];
};

function parsePollIntervalSeconds(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 15) {
    return undefined;
  }
  return parsed;
}

function writeAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: XCredentialInput;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const existingX = cfg.channels?.x ?? {};
  const accountPatch = {
    enabled: true,
    consumerKey: input.consumerKey,
    consumerSecret: input.consumerSecret,
    accessToken: input.accessToken,
    accessTokenSecret: input.accessTokenSecret,
    ...(input.pollIntervalSeconds ? { pollIntervalSeconds: input.pollIntervalSeconds } : {}),
    ...(input.proxy ? { proxy: input.proxy } : {}),
    ...(input.allowFrom ? { allowFrom: input.allowFrom } : {}),
    ...(input.actionsAllowFrom ? { actionsAllowFrom: input.actionsAllowFrom } : {}),
  };

  if (accountId === DEFAULT_ACCOUNT_ID && !existingX.accounts) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        x: {
          ...existingX,
          ...accountPatch,
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      x: {
        ...existingX,
        enabled: true,
        accounts: {
          ...existingX.accounts,
          [accountId]: {
            ...existingX.accounts?.[accountId],
            ...accountPatch,
          },
        },
      },
    },
  };
}

export const xOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const xChannel = getXChannel();
    const configured = xChannel
      .listXAccountIds(cfg)
      .some((accountId: string) =>
        xChannel.isXAccountConfigured(xChannel.resolveXAccount(cfg, accountId)),
      );
    return {
      channel,
      configured,
      statusLines: [`X (Twitter): ${configured ? "configured" : "needs API credentials"}`],
      selectionHint: configured ? "configured · credentials present" : "new · add credentials",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const xChannel = getXChannel();
    await prompter.note(
      [
        "Create credentials in the X Developer Portal (API key/secret + access token/secret).",
        "For mentions/replies to work, app and account permissions must allow read/write access.",
        `Docs: ${formatDocsLink("/channels/x")}`,
      ].join("\n"),
      "X credentials",
    );

    const xOverride = accountOverrides.x?.trim();
    const defaultAccountId = xChannel.defaultAccountId ?? DEFAULT_ACCOUNT_ID;
    let xAccountId = xOverride ? normalizeAccountId(xOverride) : defaultAccountId;
    if (shouldPromptAccountIds && !xOverride) {
      xAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "X",
        currentId: xAccountId,
        listAccountIds: (nextCfg) => xChannel.listXAccountIds(nextCfg),
        defaultAccountId,
      });
    }

    const existing = xChannel.resolveXAccount(cfg, xAccountId);
    const hasExistingCreds = xChannel.isXAccountConfigured(existing);
    const keepExisting =
      hasExistingCreds &&
      (await prompter.confirm({
        message: "X credentials already configured. Keep existing credentials?",
        initialValue: true,
      }));

    let next = cfg;
    if (!keepExisting) {
      const consumerKey = (
        await prompter.text({
          message: "X Consumer Key (API Key)",
          initialValue: existing?.consumerKey ?? "",
          validate: (value) => (value.trim() ? undefined : "Required"),
        })
      ).trim();
      const consumerSecret = (
        await prompter.text({
          message: "X Consumer Secret (API Secret)",
          initialValue: existing?.consumerSecret ?? "",
          validate: (value) => (value.trim() ? undefined : "Required"),
        })
      ).trim();
      const accessToken = (
        await prompter.text({
          message: "X Access Token",
          initialValue: existing?.accessToken ?? "",
          validate: (value) => (value.trim() ? undefined : "Required"),
        })
      ).trim();
      const accessTokenSecret = (
        await prompter.text({
          message: "X Access Token Secret",
          initialValue: existing?.accessTokenSecret ?? "",
          validate: (value) => (value.trim() ? undefined : "Required"),
        })
      ).trim();
      const pollIntervalInput = await prompter.text({
        message: "Poll interval in seconds (optional, min 15)",
        initialValue: existing?.pollIntervalSeconds ? String(existing.pollIntervalSeconds) : "60",
        validate: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return undefined;
          }
          const parsed = Number.parseInt(trimmed, 10);
          if (!Number.isFinite(parsed) || parsed < 15) {
            return "Must be a number >= 15";
          }
          return undefined;
        },
      });
      const proxyInput = await prompter.text({
        message: "HTTP proxy URL (optional)",
        initialValue: existing?.proxy ?? "",
        placeholder: "http://127.0.0.1:7890",
      });

      // Prompt for X user IDs used in allowFrom / actionsAllowFrom.
      // These control who can mention the bot and who can trigger proactive actions.
      const existingAllowFrom = existing?.allowFrom ?? [];
      const existingActionsAllowFrom = existing?.actionsAllowFrom ?? [];
      const allowFromInput = await prompter.text({
        message: "Your X user ID(s) for allowFrom (comma-separated, required for mentions)",
        placeholder: "12345678",
        initialValue: existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "12345678",
        validate: (value) =>
          String(value ?? "").trim() ? undefined : "Required — enter at least one X user ID",
      });
      const allowFrom = String(allowFromInput ?? "")
        .split(/[\n,;]+/g)
        .map((s) => s.trim())
        .filter(Boolean);

      const actionsAllowFromInput = await prompter.text({
        message: "X user ID(s) for actionsAllowFrom (comma-separated, for proactive actions)",
        placeholder: "12345678",
        initialValue:
          existingActionsAllowFrom.length > 0
            ? existingActionsAllowFrom.join(", ")
            : allowFrom.length > 0
              ? allowFrom.join(", ")
              : "12345678",
      });
      const actionsAllowFrom = String(actionsAllowFromInput ?? "")
        .split(/[\n,;]+/g)
        .map((s) => s.trim())
        .filter(Boolean);

      next = writeAccountConfig({
        cfg: next,
        accountId: xAccountId,
        input: {
          consumerKey,
          consumerSecret,
          accessToken,
          accessTokenSecret,
          pollIntervalSeconds: parsePollIntervalSeconds(pollIntervalInput),
          proxy: proxyInput.trim() || undefined,
          allowFrom: allowFrom.length > 0 ? allowFrom : undefined,
          actionsAllowFrom: actionsAllowFrom.length > 0 ? actionsAllowFrom : undefined,
        },
      });
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          x: {
            ...next.channels?.x,
            enabled: true,
          },
        },
      };
    }

    return { cfg: next, accountId: xAccountId };
  },
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      x: { ...cfg.channels?.x, enabled: false },
    },
  }),
};

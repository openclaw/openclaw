import type { ChannelOnboardingAdapter } from "../../../src/channels/plugins/onboarding-types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { promptAccountId } from "../../../src/channels/plugins/onboarding/helpers.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../src/routing/session-key.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import { getXRuntime } from "./runtime.js";

const channel = "x" as const;

type XCredentialInput = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  pollIntervalSeconds?: number;
  proxy?: string;
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
    const configured = getXRuntime()
      .channel.x.listXAccountIds(cfg)
      .some((accountId) =>
        getXRuntime().channel.x.isXAccountConfigured(
          getXRuntime().channel.x.resolveXAccount(cfg, accountId),
        ),
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
    await prompter.note(
      [
        "Create credentials in the X Developer Portal (API key/secret + access token/secret).",
        "For mentions/replies to work, app and account permissions must allow read/write access.",
        `Docs: ${formatDocsLink("/channels/x")}`,
      ].join("\n"),
      "X credentials",
    );

    const xOverride = accountOverrides.x?.trim();
    const defaultAccountId = getXRuntime().channel.x.defaultAccountId ?? DEFAULT_ACCOUNT_ID;
    let xAccountId = xOverride ? normalizeAccountId(xOverride) : defaultAccountId;
    if (shouldPromptAccountIds && !xOverride) {
      xAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "X",
        currentId: xAccountId,
        listAccountIds: (nextCfg) => getXRuntime().channel.x.listXAccountIds(nextCfg),
        defaultAccountId,
      });
    }

    const existing = getXRuntime().channel.x.resolveXAccount(cfg, xAccountId);
    const hasExistingCreds = getXRuntime().channel.x.isXAccountConfigured(existing);
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

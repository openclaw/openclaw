import crypto from "node:crypto";
import { configureClient } from "@tloncorp/api";
import type {
  ChannelOutboundAdapter,
  ChannelPlugin,
  ChannelSetupInput,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "openclaw/plugin-sdk";
import { buildTlonAccountFields } from "./account-fields.js";
import { tlonChannelConfigSchema } from "./config-schema.js";
import { monitorTlonProvider } from "./monitor/index.js";
import { tlonOnboardingAdapter } from "./onboarding.js";
import { formatTargetHint, normalizeShip, parseTlonTarget } from "./targets.js";
import { resolveTlonAccount, listTlonAccountIds } from "./types.js";
import { authenticate } from "./urbit/auth.js";
import { ssrfPolicyFromAllowPrivateNetwork } from "./urbit/context.js";
import { urbitFetch } from "./urbit/fetch.js";
import {
  buildMediaStory,
  sendDm,
  sendGroupMessage,
  sendDmWithStory,
  sendGroupMessageWithStory,
} from "./urbit/send.js";
import { uploadImageFromUrl } from "./urbit/upload.js";

// Simple HTTP-only poke that doesn't open an EventSource (avoids conflict with monitor's SSE)
async function createHttpPokeApi(params: {
  url: string;
  code: string;
  ship: string;
  allowPrivateNetwork?: boolean;
}) {
  const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(params.allowPrivateNetwork);
  const cookie = await authenticate(params.url, params.code, { ssrfPolicy });
  const channelId = `${Math.floor(Date.now() / 1000)}-${crypto.randomUUID()}`;
  const channelUrl = `${params.url}/~/channel/${channelId}`;
  const shipName = params.ship.replace(/^~/, "");

  return {
    poke: async (pokeParams: { app: string; mark: string; json: unknown }) => {
      const pokeId = Date.now();
      const pokeData = {
        id: pokeId,
        action: "poke",
        ship: shipName,
        app: pokeParams.app,
        mark: pokeParams.mark,
        json: pokeParams.json,
      };

      const response = await fetch(channelUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie.split(";")[0],
        },
        body: JSON.stringify([pokeData]),
      });

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        throw new Error(`Poke failed: ${response.status} - ${errorText}`);
      }

      return pokeId;
    },
    delete: async () => {
      // No-op for HTTP-only client
    },
  };
}

const TLON_CHANNEL_ID = "tlon" as const;

type TlonSetupInput = ChannelSetupInput & {
  ship?: string;
  url?: string;
  code?: string;
  allowPrivateNetwork?: boolean;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
  ownerShip?: string;
};

function applyTlonSetupConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: TlonSetupInput;
}): OpenClawConfig {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;
  const namedConfig = applyAccountNameToChannelSection({
    cfg,
    channelKey: "tlon",
    accountId,
    name: input.name,
  });
  const base = namedConfig.channels?.tlon ?? {};

  const payload = buildTlonAccountFields(input);

  if (useDefault) {
    return {
      ...namedConfig,
      channels: {
        ...namedConfig.channels,
        tlon: {
          ...base,
          enabled: true,
          ...payload,
        },
      },
    };
  }

  return {
    ...namedConfig,
    channels: {
      ...namedConfig.channels,
      tlon: {
        ...base,
        enabled: base.enabled ?? true,
        accounts: {
          ...(base as { accounts?: Record<string, unknown> }).accounts,
          [accountId]: {
            ...(base as { accounts?: Record<string, Record<string, unknown>> }).accounts?.[
              accountId
            ],
            enabled: true,
            ...payload,
          },
        },
      },
    },
  };
}

const tlonOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 10000,
  resolveTarget: ({ to }) => {
    const parsed = parseTlonTarget(to ?? "");
    if (!parsed) {
      return {
        ok: false,
        error: new Error(`Invalid Tlon target. Use ${formatTargetHint()}`),
      };
    }
    if (parsed.kind === "dm") {
      return { ok: true, to: parsed.ship };
    }
    return { ok: true, to: parsed.nest };
  },
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    const account = resolveTlonAccount(cfg, accountId ?? undefined);
    if (!account.configured || !account.ship || !account.url || !account.code) {
      throw new Error("Tlon account not configured");
    }

    const parsed = parseTlonTarget(to);
    if (!parsed) {
      throw new Error(`Invalid Tlon target. Use ${formatTargetHint()}`);
    }

    // Use HTTP-only poke (no EventSource) to avoid conflicts with monitor's SSE connection
    const api = await createHttpPokeApi({
      url: account.url,
      ship: account.ship,
      code: account.code,
      allowPrivateNetwork: account.allowPrivateNetwork ?? undefined,
    });

    try {
      const fromShip = normalizeShip(account.ship);
      if (parsed.kind === "dm") {
        return await sendDm({
          api,
          fromShip,
          toShip: parsed.ship,
          text,
        });
      }
      const replyId = (replyToId ?? threadId) ? String(replyToId ?? threadId) : undefined;
      return await sendGroupMessage({
        api,
        fromShip,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName,
        text,
        replyToId: replyId,
      });
    } finally {
      try {
        await api.delete();
      } catch {
        // ignore cleanup errors
      }
    }
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
    const account = resolveTlonAccount(cfg, accountId ?? undefined);
    if (!account.configured || !account.ship || !account.url || !account.code) {
      throw new Error("Tlon account not configured");
    }

    const parsed = parseTlonTarget(to);
    if (!parsed) {
      throw new Error(`Invalid Tlon target. Use ${formatTargetHint()}`);
    }

    // Configure the API client for uploads
    configureClient({
      shipUrl: account.url,
      shipName: account.ship.replace(/^~/, ""),
      verbose: false,
      getCode: async () => account.code!,
    });

    const uploadedUrl = mediaUrl ? await uploadImageFromUrl(mediaUrl) : undefined;

    const api = await createHttpPokeApi({
      url: account.url,
      ship: account.ship,
      code: account.code,
      allowPrivateNetwork: account.allowPrivateNetwork ?? undefined,
    });

    try {
      const fromShip = normalizeShip(account.ship);
      const story = buildMediaStory(text, uploadedUrl);

      if (parsed.kind === "dm") {
        return await sendDmWithStory({
          api,
          fromShip,
          toShip: parsed.ship,
          story,
        });
      }
      const replyId = (replyToId ?? threadId) ? String(replyToId ?? threadId) : undefined;
      return await sendGroupMessageWithStory({
        api,
        fromShip,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName,
        story,
        replyToId: replyId,
      });
    } finally {
      try {
        await api.delete();
      } catch {
        // ignore cleanup errors
      }
    }
  },
};

export const tlonPlugin: ChannelPlugin = {
  id: TLON_CHANNEL_ID,
  meta: {
    id: TLON_CHANNEL_ID,
    label: "Tlon",
    selectionLabel: "Tlon (Urbit)",
    docsPath: "/channels/tlon",
    docsLabel: "tlon",
    blurb: "Decentralized messaging on Urbit",
    aliases: ["urbit"],
    order: 90,
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    media: true,
    reply: true,
    threads: true,
  },
  onboarding: tlonOnboardingAdapter,
  reload: { configPrefixes: ["channels.tlon"] },
  configSchema: tlonChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listTlonAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTlonAccount(cfg, accountId ?? undefined),
    defaultAccountId: () => "default",
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const useDefault = !accountId || accountId === "default";
      if (useDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            tlon: {
              ...cfg.channels?.tlon,
              enabled,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          tlon: {
            ...cfg.channels?.tlon,
            accounts: {
              ...cfg.channels?.tlon?.accounts,
              [accountId]: {
                ...cfg.channels?.tlon?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
    deleteAccount: ({ cfg, accountId }) => {
      const useDefault = !accountId || accountId === "default";
      if (useDefault) {
        const {
          ship: _ship,
          code: _code,
          url: _url,
          name: _name,
          ...rest
        } = cfg.channels?.tlon ?? {};
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            tlon: rest,
          },
        } as OpenClawConfig;
      }
      const { [accountId]: _removed, ...remainingAccounts } = cfg.channels?.tlon?.accounts ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          tlon: {
            ...cfg.channels?.tlon,
            accounts: remainingAccounts,
          },
        },
      } as OpenClawConfig;
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      ship: account.ship,
      url: account.url,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg,
        channelKey: "tlon",
        accountId,
        name,
      }),
    validateInput: ({ cfg, accountId, input }) => {
      const setupInput = input as TlonSetupInput;
      const resolved = resolveTlonAccount(cfg, accountId ?? undefined);
      const ship = setupInput.ship?.trim() || resolved.ship;
      const url = setupInput.url?.trim() || resolved.url;
      const code = setupInput.code?.trim() || resolved.code;
      if (!ship) {
        return "Tlon requires --ship.";
      }
      if (!url) {
        return "Tlon requires --url.";
      }
      if (!code) {
        return "Tlon requires --code.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyTlonSetupConfig({
        cfg: cfg,
        accountId,
        input: input as TlonSetupInput,
      }),
  },
  messaging: {
    normalizeTarget: (target) => {
      const parsed = parseTlonTarget(target);
      if (!parsed) {
        return target.trim();
      }
      if (parsed.kind === "dm") {
        return parsed.ship;
      }
      return parsed.nest;
    },
    targetResolver: {
      looksLikeId: (target) => Boolean(parseTlonTarget(target)),
      hint: formatTargetHint(),
    },
  },
  outbound: tlonOutbound,
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) => {
      return accounts.flatMap((account) => {
        if (!account.configured) {
          return [
            {
              channel: TLON_CHANNEL_ID,
              accountId: account.accountId,
              kind: "config",
              message: "Account not configured (missing ship, code, or url)",
            },
          ];
        }
        return [];
      });
    },
    buildChannelSummary: ({ snapshot }) => {
      const s = snapshot as { configured?: boolean; ship?: string; url?: string };
      return {
        configured: s.configured ?? false,
        ship: s.ship ?? null,
        url: s.url ?? null,
      };
    },
    probeAccount: async ({ account }) => {
      if (!account.configured || !account.ship || !account.url || !account.code) {
        return { ok: false, error: "Not configured" };
      }
      try {
        const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(account.allowPrivateNetwork);
        const cookie = await authenticate(account.url, account.code, { ssrfPolicy });
        // Simple probe - just verify we can reach /~/name
        const { response, release } = await urbitFetch({
          baseUrl: account.url,
          path: "/~/name",
          init: {
            method: "GET",
            headers: { Cookie: cookie },
          },
          ssrfPolicy,
          timeoutMs: 30_000,
          auditContext: "tlon-probe-account",
        });
        try {
          if (!response.ok) {
            return { ok: false, error: `Name request failed: ${response.status}` };
          }
          return { ok: true };
        } finally {
          await release();
        }
      } catch (error) {
        return { ok: false, error: (error as { message?: string })?.message ?? String(error) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      // Tlon-specific snapshot with ship/url for status display
      const snapshot = {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        ship: account.ship,
        url: account.url,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
      };
      return snapshot as import("openclaw/plugin-sdk").ChannelAccountSnapshot;
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        ship: account.ship,
        url: account.url,
      } as import("openclaw/plugin-sdk").ChannelAccountSnapshot);
      ctx.log?.info(`[${account.accountId}] starting Tlon provider for ${account.ship ?? "tlon"}`);
      return monitorTlonProvider({
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: account.accountId,
      });
    },
  },
};

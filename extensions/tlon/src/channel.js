import crypto from "node:crypto";
import { configureClient } from "@tloncorp/api";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId
} from "openclaw/plugin-sdk/tlon";
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
  sendGroupMessageWithStory
} from "./urbit/send.js";
import { uploadImageFromUrl } from "./urbit/upload.js";
async function createHttpPokeApi(params) {
  const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(params.allowPrivateNetwork);
  const cookie = await authenticate(params.url, params.code, { ssrfPolicy });
  const channelId = `${Math.floor(Date.now() / 1e3)}-${crypto.randomUUID()}`;
  const channelPath = `/~/channel/${channelId}`;
  const shipName = params.ship.replace(/^~/, "");
  return {
    poke: async (pokeParams) => {
      const pokeId = Date.now();
      const pokeData = {
        id: pokeId,
        action: "poke",
        ship: shipName,
        app: pokeParams.app,
        mark: pokeParams.mark,
        json: pokeParams.json
      };
      const { response, release } = await urbitFetch({
        baseUrl: params.url,
        path: channelPath,
        init: {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie.split(";")[0]
          },
          body: JSON.stringify([pokeData])
        },
        ssrfPolicy,
        auditContext: "tlon-poke"
      });
      try {
        if (!response.ok && response.status !== 204) {
          const errorText = await response.text();
          throw new Error(`Poke failed: ${response.status} - ${errorText}`);
        }
        return pokeId;
      } finally {
        await release();
      }
    },
    delete: async () => {
    }
  };
}
const TLON_CHANNEL_ID = "tlon";
function applyTlonSetupConfig(params) {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;
  const namedConfig = applyAccountNameToChannelSection({
    cfg,
    channelKey: "tlon",
    accountId,
    name: input.name
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
          ...payload
        }
      }
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
          ...base.accounts,
          [accountId]: {
            ...base.accounts?.[accountId],
            enabled: true,
            ...payload
          }
        }
      }
    }
  };
}
function resolveOutboundContext(params) {
  const account = resolveTlonAccount(params.cfg, params.accountId ?? void 0);
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured");
  }
  const parsed = parseTlonTarget(params.to);
  if (!parsed) {
    throw new Error(`Invalid Tlon target. Use ${formatTargetHint()}`);
  }
  return { account, parsed };
}
function resolveReplyId(replyToId, threadId) {
  return replyToId ?? threadId ? String(replyToId ?? threadId) : void 0;
}
async function withHttpPokeAccountApi(account, run) {
  const api = await createHttpPokeApi({
    url: account.url,
    ship: account.ship,
    code: account.code,
    allowPrivateNetwork: account.allowPrivateNetwork ?? void 0
  });
  try {
    return await run(api);
  } finally {
    try {
      await api.delete();
    } catch {
    }
  }
}
const tlonOutbound = {
  deliveryMode: "direct",
  textChunkLimit: 1e4,
  resolveTarget: ({ to }) => {
    const parsed = parseTlonTarget(to ?? "");
    if (!parsed) {
      return {
        ok: false,
        error: new Error(`Invalid Tlon target. Use ${formatTargetHint()}`)
      };
    }
    if (parsed.kind === "dm") {
      return { ok: true, to: parsed.ship };
    }
    return { ok: true, to: parsed.nest };
  },
  sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => {
    const { account, parsed } = resolveOutboundContext({ cfg, accountId, to });
    return withHttpPokeAccountApi(account, async (api) => {
      const fromShip = normalizeShip(account.ship);
      if (parsed.kind === "dm") {
        return await sendDm({
          api,
          fromShip,
          toShip: parsed.ship,
          text
        });
      }
      return await sendGroupMessage({
        api,
        fromShip,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName,
        text,
        replyToId: resolveReplyId(replyToId, threadId)
      });
    });
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) => {
    const { account, parsed } = resolveOutboundContext({ cfg, accountId, to });
    configureClient({
      shipUrl: account.url,
      shipName: account.ship.replace(/^~/, ""),
      verbose: false,
      getCode: async () => account.code
    });
    const uploadedUrl = mediaUrl ? await uploadImageFromUrl(mediaUrl) : void 0;
    return withHttpPokeAccountApi(account, async (api) => {
      const fromShip = normalizeShip(account.ship);
      const story = buildMediaStory(text, uploadedUrl);
      if (parsed.kind === "dm") {
        return await sendDmWithStory({
          api,
          fromShip,
          toShip: parsed.ship,
          story
        });
      }
      return await sendGroupMessageWithStory({
        api,
        fromShip,
        hostShip: parsed.hostShip,
        channelName: parsed.channelName,
        story,
        replyToId: resolveReplyId(replyToId, threadId)
      });
    });
  }
};
const tlonPlugin = {
  id: TLON_CHANNEL_ID,
  meta: {
    id: TLON_CHANNEL_ID,
    label: "Tlon",
    selectionLabel: "Tlon (Urbit)",
    docsPath: "/channels/tlon",
    docsLabel: "tlon",
    blurb: "Decentralized messaging on Urbit",
    aliases: ["urbit"],
    order: 90
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    media: true,
    reply: true,
    threads: true
  },
  onboarding: tlonOnboardingAdapter,
  reload: { configPrefixes: ["channels.tlon"] },
  configSchema: tlonChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listTlonAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTlonAccount(cfg, accountId ?? void 0),
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
              enabled
            }
          }
        };
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
                enabled
              }
            }
          }
        }
      };
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
            tlon: rest
          }
        };
      }
      const { [accountId]: _removed, ...remainingAccounts } = cfg.channels?.tlon?.accounts ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          tlon: {
            ...cfg.channels?.tlon,
            accounts: remainingAccounts
          }
        }
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      ship: account.ship,
      url: account.url
    })
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
      cfg,
      channelKey: "tlon",
      accountId,
      name
    }),
    validateInput: ({ cfg, accountId, input }) => {
      const setupInput = input;
      const resolved = resolveTlonAccount(cfg, accountId ?? void 0);
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
    applyAccountConfig: ({ cfg, accountId, input }) => applyTlonSetupConfig({
      cfg,
      accountId,
      input
    })
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
      hint: formatTargetHint()
    }
  },
  outbound: tlonOutbound,
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null
    },
    collectStatusIssues: (accounts) => {
      return accounts.flatMap((account) => {
        if (!account.configured) {
          return [
            {
              channel: TLON_CHANNEL_ID,
              accountId: account.accountId,
              kind: "config",
              message: "Account not configured (missing ship, code, or url)"
            }
          ];
        }
        return [];
      });
    },
    buildChannelSummary: ({ snapshot }) => {
      const s = snapshot;
      return {
        configured: s.configured ?? false,
        ship: s.ship ?? null,
        url: s.url ?? null
      };
    },
    probeAccount: async ({ account }) => {
      if (!account.configured || !account.ship || !account.url || !account.code) {
        return { ok: false, error: "Not configured" };
      }
      try {
        const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(account.allowPrivateNetwork);
        const cookie = await authenticate(account.url, account.code, { ssrfPolicy });
        const { response, release } = await urbitFetch({
          baseUrl: account.url,
          path: "/~/name",
          init: {
            method: "GET",
            headers: { Cookie: cookie }
          },
          ssrfPolicy,
          timeoutMs: 3e4,
          auditContext: "tlon-probe-account"
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
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => {
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
        probe
      };
      return snapshot;
    }
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        ship: account.ship,
        url: account.url
      });
      ctx.log?.info(`[${account.accountId}] starting Tlon provider for ${account.ship ?? "tlon"}`);
      return monitorTlonProvider({
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: account.accountId
      });
    }
  }
};
export {
  tlonPlugin
};

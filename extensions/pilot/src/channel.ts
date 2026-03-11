import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  createAccountStatusSink,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  runPassiveAccountLifecycle,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/pilot";
import {
  listPilotAccountIds,
  resolveDefaultPilotAccountId,
  resolvePilotAccount,
  type ResolvedPilotAccount,
} from "./accounts.js";
import { PilotConfigSchema } from "./config-schema.js";
import { monitorPilotProvider } from "./monitor.js";
import {
  normalizePilotTarget,
  looksLikePilotTargetId,
  normalizePilotAllowEntry,
} from "./normalize.js";
import { pilotOnboardingAdapter } from "./onboarding.js";
import { probePilot } from "./probe.js";
import { getPilotRuntime } from "./runtime.js";
import { sendPilotMessage } from "./send.js";
import type { CoreConfig, PilotProbe } from "./types.js";

const meta = {
  id: "pilot" as const,
  label: "Pilot Protocol",
  selectionLabel: "Pilot Protocol",
  blurb: "P2P overlay network for autonomous agents",
  order: 900,
};

export const pilotPlugin: ChannelPlugin<ResolvedPilotAccount, PilotProbe> = {
  id: "pilot",
  meta,
  onboarding: pilotOnboardingAdapter,
  pairing: {
    idLabel: "pilotAddress",
    normalizeAllowEntry: (entry) => normalizePilotAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      const target = normalizePilotAllowEntry(id);
      if (!target) {
        throw new Error(`invalid Pilot pairing id: ${id}`);
      }
      await sendPilotMessage(target, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.pilot"] },
  configSchema: buildChannelConfigSchema(PilotConfigSchema),
  config: {
    listAccountIds: (cfg) => listPilotAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolvePilotAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultPilotAccountId(cfg as CoreConfig),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      hostname: account.hostname,
      socketPath: account.socketPath,
      registry: account.registry,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }) => {
      const policy = account.config.dmPolicy ?? "pairing";
      return {
        policy,
        allowFrom: account.config.allowFrom ?? [],
      };
    },
  },
  messaging: {
    normalizeTarget: normalizePilotTarget,
    targetResolver: {
      looksLikeId: looksLikePilotTargetId,
      hint: "<address (N:NNNN.HHHH.LLLL) | hostname>",
    },
  },
  resolver: {
    resolveTargets: async ({ inputs }) => {
      return inputs.map((input) => {
        const normalized = normalizePilotTarget(input);
        if (!normalized) {
          return {
            input,
            resolved: false,
            note: "invalid Pilot target",
          };
        }
        return {
          input,
          resolved: true,
          id: normalized,
          name: normalized,
        };
      });
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolvePilotAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() ?? "";
      const ids = new Set<string>();

      for (const entry of account.config.allowFrom ?? []) {
        const normalized = normalizePilotAllowEntry(String(entry));
        if (normalized && normalized !== "*") {
          ids.add(normalized);
        }
      }

      return Array.from(ids)
        .filter((id) => (q ? id.includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }));
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getPilotRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const result = await sendPilotMessage(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
      return { channel: "pilot", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ account, snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      hostname: account.hostname,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg, account, timeoutMs }) =>
      probePilot(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      hostname: account.hostname,
      socketPath: account.socketPath,
      registry: account.registry,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });
      if (!account.configured) {
        throw new Error(
          `Pilot is not configured for account "${account.accountId}" (need hostname in channels.pilot).`,
        );
      }
      ctx.log?.info(
        `[${account.accountId}] starting Pilot provider (hostname=${account.hostname})`,
      );
      await runPassiveAccountLifecycle({
        abortSignal: ctx.abortSignal,
        start: async () =>
          await monitorPilotProvider({
            accountId: account.accountId,
            config: ctx.cfg as CoreConfig,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            statusSink,
          }),
        stop: async (monitor) => {
          monitor.stop();
        },
      });
    },
  },
};

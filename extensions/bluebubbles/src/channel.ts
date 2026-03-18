import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createOpenGroupPolicyRestrictSendersWarningCollector,
  projectWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createPairingPrefixStripper,
  createTextPairingAdapter,
} from "openclaw/plugin-sdk/channel-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import {
  listBlueBubblesAccountIds,
  type ResolvedBlueBubblesAccount,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { bluebubblesMessageActions } from "./actions.js";
import type { BlueBubblesProbe } from "./channel.runtime.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "./group-policy.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "./runtime-api.js";
import {
  buildChannelConfigSchema,
  buildComputedAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
  collectBlueBubblesStatusIssues,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "./runtime-api.js";
import { resolveBlueBubblesOutboundSessionRoute } from "./session-route.js";
import { blueBubblesSetupAdapter } from "./setup-core.js";
import { blueBubblesSetupWizard } from "./setup-surface.js";
import {
  extractHandleFromChatGuid,
  inferBlueBubblesTargetChatType,
  looksLikeBlueBubblesExplicitTargetId,
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesHandle,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesTarget,
} from "./targets.js";

const loadBlueBubblesChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "blueBubblesChannelRuntime",
);

const bluebubblesConfigAdapter = createScopedChannelConfigAdapter<ResolvedBlueBubblesAccount>({
  sectionKey: "bluebubbles",
  listAccountIds: listBlueBubblesAccountIds,
  resolveAccount: (cfg, accountId) => resolveBlueBubblesAccount({ cfg, accountId }),
  defaultAccountId: resolveDefaultBlueBubblesAccountId,
  clearBaseFields: ["serverUrl", "password", "name", "webhookPath"],
  resolveAllowFrom: (account: ResolvedBlueBubblesAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: (entry) => normalizeBlueBubblesHandle(entry.replace(/^bluebubbles:/i, "")),
    }),
});

const resolveBlueBubblesDmPolicy = createScopedDmSecurityResolver<ResolvedBlueBubblesAccount>({
  channelKey: "bluebubbles",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeBlueBubblesHandle(raw.replace(/^bluebubbles:/i, "")),
});

const collectBlueBubblesSecurityWarnings =
  createOpenGroupPolicyRestrictSendersWarningCollector<ResolvedBlueBubblesAccount>({
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    defaultGroupPolicy: "allowlist",
    surface: "BlueBubbles groups",
    openScope: "any member",
    groupPolicyPath: "channels.bluebubbles.groupPolicy",
    groupAllowFromPath: "channels.bluebubbles.groupAllowFrom",
    mentionGated: false,
  });

const meta = {
  id: "bluebubbles",
  label: "BlueBubbles",
  selectionLabel: "BlueBubbles (macOS app)",
  detailLabel: "BlueBubbles",
  docsPath: "/channels/bluebubbles",
  docsLabel: "bluebubbles",
  blurb: "iMessage via the BlueBubbles mac app + REST API.",
  systemImage: "bubble.left.and.text.bubble.right",
  aliases: ["bb"],
  order: 75,
  preferOver: ["imessage"],
};

export const bluebubblesPlugin: ChannelPlugin<ResolvedBlueBubblesAccount> = {
  id: "bluebubbles",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    effects: true,
    groupManagement: true,
  },
  groups: {
    resolveRequireMention: resolveBlueBubblesGroupRequireMention,
    resolveToolPolicy: resolveBlueBubblesGroupToolPolicy,
  },
  threading: {
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
      hasRepliedRef,
    }),
  },
  reload: { configPrefixes: ["channels.bluebubbles"] },
  configSchema: buildChannelConfigSchema(BlueBubblesConfigSchema),
  setupWizard: blueBubblesSetupWizard,
  config: {
    ...bluebubblesConfigAdapter,
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
  },
  actions: bluebubblesMessageActions,
  security: {
    resolveDmPolicy: resolveBlueBubblesDmPolicy,
    collectWarnings: projectWarningCollector(
      ({ account }: { account: ResolvedBlueBubblesAccount }) => account,
      collectBlueBubblesSecurityWarnings,
    ),
  },
  messaging: {
    normalizeTarget: normalizeBlueBubblesMessagingTarget,
    inferTargetChatType: ({ to }) => inferBlueBubblesTargetChatType(to),
    resolveOutboundSessionRoute: (params) => resolveBlueBubblesOutboundSessionRoute(params),
    targetResolver: {
      looksLikeId: looksLikeBlueBubblesExplicitTargetId,
      hint: "<handle|chat_guid:GUID|chat_id:ID|chat_identifier:ID>",
      resolveTarget: async ({ normalized }) => {
        const to = normalized?.trim();
        if (!to) {
          return null;
        }
        const chatType = inferBlueBubblesTargetChatType(to);
        if (!chatType) {
          return null;
        }
        return {
          to,
          kind: chatType === "direct" ? "user" : "group",
          source: "normalized" as const,
        };
      },
    },
    formatTargetDisplay: ({ target, display }) => {
      const shouldParseDisplay = (value: string): boolean => {
        if (looksLikeBlueBubblesTargetId(value)) {
          return true;
        }
        return /^(bluebubbles:|chat_guid:|chat_id:|chat_identifier:)/i.test(value);
      };

      // Helper to extract a clean handle from any BlueBubbles target format
      const extractCleanDisplay = (value: string | undefined): string | null => {
        const trimmed = value?.trim();
        if (!trimmed) {
          return null;
        }
        try {
          const parsed = parseBlueBubblesTarget(trimmed);
          if (parsed.kind === "chat_guid") {
            const handle = extractHandleFromChatGuid(parsed.chatGuid);
            if (handle) {
              return handle;
            }
          }
          if (parsed.kind === "handle") {
            return normalizeBlueBubblesHandle(parsed.to);
          }
        } catch {
          // Fall through
        }
        // Strip common prefixes and try raw extraction
        const stripped = trimmed
          .replace(/^bluebubbles:/i, "")
          .replace(/^chat_guid:/i, "")
          .replace(/^chat_id:/i, "")
          .replace(/^chat_identifier:/i, "");
        const handle = extractHandleFromChatGuid(stripped);
        if (handle) {
          return handle;
        }
        // Don't return raw chat_guid formats - they contain internal routing info
        if (stripped.includes(";-;") || stripped.includes(";+;")) {
          return null;
        }
        return stripped;
      };

      // Try to get a clean display from the display parameter first
      const trimmedDisplay = display?.trim();
      if (trimmedDisplay) {
        if (!shouldParseDisplay(trimmedDisplay)) {
          return trimmedDisplay;
        }
        const cleanDisplay = extractCleanDisplay(trimmedDisplay);
        if (cleanDisplay) {
          return cleanDisplay;
        }
      }

      // Fall back to extracting from target
      const cleanTarget = extractCleanDisplay(target);
      if (cleanTarget) {
        return cleanTarget;
      }

      // Last resort: return display or target as-is
      return display?.trim() || target?.trim() || "";
    },
  },
  setup: blueBubblesSetupAdapter,
  pairing: createTextPairingAdapter({
    idLabel: "bluebubblesSenderId",
    message: PAIRING_APPROVED_MESSAGE,
    normalizeAllowEntry: createPairingPrefixStripper(/^bluebubbles:/i, normalizeBlueBubblesHandle),
    notify: async ({ cfg, id, message }) => {
      await (
        await loadBlueBubblesChannelRuntime()
      ).sendMessageBlueBubbles(id, message, {
        cfg: cfg,
      });
    },
  }),
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to BlueBubbles requires --to <handle|chat_guid:GUID>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const runtime = await loadBlueBubblesChannelRuntime();
      const rawReplyToId = typeof replyToId === "string" ? replyToId.trim() : "";
      // Resolve short ID (e.g., "5") to full UUID
      const replyToMessageGuid = rawReplyToId
        ? runtime.resolveBlueBubblesMessageId(rawReplyToId, { requireKnownShortId: true })
        : "";
      const result = await runtime.sendMessageBlueBubbles(to, text, {
        cfg: cfg,
        accountId: accountId ?? undefined,
        replyToMessageGuid: replyToMessageGuid || undefined,
      });
      return { channel: "bluebubbles", ...result };
    },
    sendMedia: async (ctx) => {
      const runtime = await loadBlueBubblesChannelRuntime();
      const { cfg, to, text, mediaUrl, accountId, replyToId } = ctx;
      const { mediaPath, mediaBuffer, contentType, filename, caption } = ctx as {
        mediaPath?: string;
        mediaBuffer?: Uint8Array;
        contentType?: string;
        filename?: string;
        caption?: string;
      };
      const resolvedCaption = caption ?? text;
      const result = await runtime.sendBlueBubblesMedia({
        cfg: cfg,
        to,
        mediaUrl,
        mediaPath,
        mediaBuffer,
        contentType,
        filename,
        caption: resolvedCaption ?? undefined,
        replyToId: replyToId ?? null,
        accountId: accountId ?? undefined,
      });

      return { channel: "bluebubbles", ...result };
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
    collectStatusIssues: collectBlueBubblesStatusIssues,
    buildChannelSummary: ({ snapshot }) =>
      buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
    probeAccount: async ({ account, timeoutMs }) =>
      (await loadBlueBubblesChannelRuntime()).probeBlueBubbles({
        baseUrl: account.baseUrl,
        password: account.config.password ?? null,
        timeoutMs,
      }),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const running = runtime?.running ?? false;
      const probeOk = (probe as BlueBubblesProbe | undefined)?.ok;
      const base = buildComputedAccountStatusSnapshot({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        runtime,
        probe,
      });
      return {
        ...base,
        baseUrl: account.baseUrl,
        connected: probeOk ?? running,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const runtime = await loadBlueBubblesChannelRuntime();
      const account = ctx.account;
      const webhookPath = runtime.resolveWebhookPathFromConfig(account.config);
      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });
      statusSink({
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (webhook=${webhookPath})`);
      return runtime.monitorBlueBubblesProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
        webhookPath,
      });
    },
  },
};

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type {
  ChannelMessageActionAdapter,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { buildChannelConfigSchema, GoogleChatConfigSchema } from "../config-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  googleChatApprovalCapability,
  shouldSuppressLocalGoogleChatExecApprovalPrompt,
} from "./approval-native.js";
import { createGoogleChatPluginBase, GOOGLECHAT_CHANNEL_ID } from "./channel-base.js";
import {
  googlechatDirectoryAdapter,
  googlechatGroupsAdapter,
  googlechatMessageAdapter,
  googlechatOutboundAdapter,
  googlechatPairingTextAdapter,
  googlechatSecurityAdapter,
  googlechatThreadingAdapter,
} from "./channel.adapters.js";
import {
  legacyConfigRules as GOOGLECHAT_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeGoogleChatCompatibilityConfig,
} from "./doctor-contract.js";
import { collectGoogleChatMutableAllowlistWarnings } from "./doctor.js";
import { startGoogleChatGatewayAccount } from "./gateway.js";
import {
  describeGoogleChatMessageTool,
  supportsGoogleChatMessageAction,
} from "./message-tool-api.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSessionRoute,
} from "./targets.js";

const loadGoogleChatChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "googleChatChannelRuntime",
);

const googlechatActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeGoogleChatMessageTool,
  supportsAction: supportsGoogleChatMessageAction,
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async (ctx) => {
    const { googlechatMessageActions } = await import("./actions.js");
    if (!googlechatMessageActions.handleAction) {
      throw new Error("Google Chat actions are not available.");
    }
    return await googlechatMessageActions.handleAction(ctx);
  },
};

export const googlechatPlugin = createChatChannelPlugin({
  base: {
    ...createGoogleChatPluginBase({
      configSchema: buildChannelConfigSchema(GoogleChatConfigSchema),
    }),
    approvalCapability: googleChatApprovalCapability,
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    groups: googlechatGroupsAdapter,
    messaging: {
      targetPrefixes: ["googlechat", "google-chat", "gchat"],
      targetIdComparison: "case-sensitive",
      normalizeTarget: normalizeGoogleChatTarget,
      inferTargetChatType: ({ to }) => {
        const target = normalizeGoogleChatTarget(to);
        if (!target) {
          return undefined;
        }
        if (isGoogleChatUserTarget(target)) {
          return "direct";
        }
        return isGoogleChatSpaceTarget(target) ? "group" : undefined;
      },
      resolveOutboundSessionRoute: (params) => resolveGoogleChatOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: (raw, normalized) => {
          const value = normalized ?? raw.trim();
          return isGoogleChatSpaceTarget(value) || isGoogleChatUserTarget(value);
        },
        hint: "<spaces/{space}|users/{user}>",
      },
    },
    directory: googlechatDirectoryAdapter,
    message: googlechatMessageAdapter,
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        const resolved = inputs.map((input) => {
          const normalized = normalizeGoogleChatTarget(input);
          if (!normalized) {
            return { input, resolved: false, note: "empty target" };
          }
          if (kind === "user" && isGoogleChatUserTarget(normalized)) {
            return { input, resolved: true, id: normalized };
          }
          if (kind === "group" && isGoogleChatSpaceTarget(normalized)) {
            return { input, resolved: true, id: normalized };
          }
          return {
            input,
            resolved: false,
            note: "use spaces/{space} or users/{user}",
          };
        });
        return resolved;
      },
    },
    actions: googlechatActions,
    doctor: {
      dmAllowFromMode: "topOnly",
      groupModel: "route",
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
      legacyConfigRules: GOOGLECHAT_LEGACY_CONFIG_RULES,
      normalizeCompatibilityConfig: normalizeGoogleChatCompatibilityConfig,
      collectMutableAllowlistWarnings: collectGoogleChatMutableAllowlistWarnings,
    },
    status: createComputedAccountStatusAdapter<ResolvedGoogleChatAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts): ChannelStatusIssue[] =>
        accounts.flatMap((entry) => {
          const accountId = entry.accountId ?? DEFAULT_ACCOUNT_ID;
          const enabled = entry.enabled !== false;
          const configured = entry.configured === true;
          if (!enabled || !configured) {
            return [];
          }
          const issues: ChannelStatusIssue[] = [];
          if (!entry.audience) {
            issues.push({
              channel: GOOGLECHAT_CHANNEL_ID,
              accountId,
              kind: "config",
              message: "Google Chat audience is missing (set channels.googlechat.audience).",
              fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
            });
          }
          if (!entry.audienceType) {
            issues.push({
              channel: GOOGLECHAT_CHANNEL_ID,
              accountId,
              kind: "config",
              message: "Google Chat audienceType is missing (app-url or project-number).",
              fix: "Set channels.googlechat.audienceType and channels.googlechat.audience.",
            });
          }
          return issues;
        }),
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveProbedChannelStatusSummary(snapshot, {
          credentialSource: snapshot.credentialSource ?? "none",
          audienceType: snapshot.audienceType ?? null,
          audience: snapshot.audience ?? null,
          webhookPath: snapshot.webhookPath ?? null,
          webhookUrl: snapshot.webhookUrl ?? null,
        }),
      probeAccount: async ({ account }) =>
        (await loadGoogleChatChannelRuntime()).probeGoogleChat(account),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.credentialSource !== "none",
        extra: {
          credentialSource: account.credentialSource,
          tokenStatus: account.tokenStatus,
          audienceType: account.config.audienceType,
          audience: account.config.audience,
          webhookPath: account.config.webhookPath,
          webhookUrl: account.config.webhookUrl,
          dmPolicy: account.config.dmPolicy ?? "pairing",
        },
      }),
    }),
    gateway: {
      startAccount: startGoogleChatGatewayAccount,
    },
  },
  pairing: {
    text: googlechatPairingTextAdapter,
  },
  security: googlechatSecurityAdapter,
  threading: googlechatThreadingAdapter,
  outbound: {
    ...googlechatOutboundAdapter,
    base: {
      ...googlechatOutboundAdapter.base,
      shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
        shouldSuppressLocalGoogleChatExecApprovalPrompt({
          cfg,
          accountId,
          payload,
          hint,
        }),
    },
  },
});

import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { Type } from "typebox";
import { requiresExplicitMatrixDefaultAccount } from "./account-selection.js";
import {
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  resolveMatrixAccountAsync,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import type { CoreConfig } from "./types.js";

const MATRIX_PLUGIN_HANDLED_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll-vote",
  "react",
  "reactions",
  "emoji-list",
  "read",
  "edit",
  "delete",
  "pin",
  "unpin",
  "list-pins",
  "set-profile",
  "member-info",
  "channel-info",
  "permissions",
]);
const MATRIX_PROFILE_MEDIA_PROPERTIES = {
  avatarUrl: Type.Optional(
    Type.String({
      description:
        "Profile avatar URL for Matrix self-profile update actions. Matrix accepts mxc:// and http(s) URLs.",
    }),
  ),
  avatar_url: Type.Optional(
    Type.String({
      description:
        "snake_case alias of avatarUrl for Matrix self-profile update actions. Matrix accepts mxc:// and http(s) URLs.",
    }),
  ),
  avatarPath: Type.Optional(
    Type.String({
      description:
        "Local avatar file path for Matrix self-profile update actions. Matrix uploads this file and sets the resulting MXC URI.",
    }),
  ),
  avatar_path: Type.Optional(
    Type.String({
      description:
        "snake_case alias of avatarPath for Matrix self-profile update actions. Matrix uploads this file and sets the resulting MXC URI.",
    }),
  ),
} as const;
const MATRIX_PROFILE_MEDIA_SOURCE_PARAMS = Object.freeze(["avatarUrl", "avatarPath"]);

function createMatrixExposedActions(params: {
  gate: ReturnType<typeof createActionGate>;
  encryptionEnabled: boolean;
  senderIsOwner?: boolean;
}) {
  const actions = new Set<ChannelMessageActionName>(["poll", "poll-vote"]);
  const addGatedActions = (gate: string, ...names: ChannelMessageActionName[]) => {
    if (params.gate(gate)) {
      for (const name of names) {
        actions.add(name);
      }
    }
  };
  addGatedActions("messages", "send", "read", "edit", "delete");
  addGatedActions("reactions", "react", "reactions", "emoji-list");
  addGatedActions("pins", "pin", "unpin", "list-pins");
  if (params.gate("profile") && params.senderIsOwner === true) {
    actions.add("set-profile");
  }
  addGatedActions("memberInfo", "member-info");
  addGatedActions("channelInfo", "channel-info");
  if (params.encryptionEnabled && params.gate("verification") && params.senderIsOwner === true) {
    actions.add("permissions");
  }
  return actions;
}

function buildMatrixProfileToolSchema(): ChannelMessageToolSchemaContribution {
  return {
    actions: ["set-profile"],
    properties: {
      displayName: Type.Optional(
        Type.String({
          description: "Profile display name for Matrix self-profile update actions.",
        }),
      ),
      display_name: Type.Optional(
        Type.String({
          description: "snake_case alias of displayName for Matrix self-profile update actions.",
        }),
      ),
      ...MATRIX_PROFILE_MEDIA_PROPERTIES,
    },
  };
}

function resolveMatrixActionAccount(params: { cfg: CoreConfig; accountId?: string | null }) {
  if (!params.accountId && requiresExplicitMatrixDefaultAccount(params.cfg)) {
    return null;
  }
  const account = resolveMatrixAccount({
    cfg: params.cfg,
    accountId: params.accountId ?? resolveDefaultMatrixAccountId(params.cfg),
  });
  return account.enabled && account.configured ? account : null;
}

function describeMatrixMessageTool(
  account: ResolvedMatrixAccount | null,
  senderIsOwner?: boolean,
): ChannelMessageToolDiscovery {
  if (!account?.enabled || !account.configured) {
    return { actions: [], capabilities: [] };
  }
  const gate = createActionGate(account.config.actions);
  const actions = createMatrixExposedActions({
    gate,
    encryptionEnabled: account.config.encryption === true,
    senderIsOwner,
  });
  const listedActions = Array.from(actions);
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (actions.has("set-profile")) {
    schema.push(buildMatrixProfileToolSchema());
  }
  if (actions.has("react")) {
    schema.push({
      actions: ["react", "reactions"],
      properties: {
        emoji: Type.Optional(
          Type.String({
            description: `Unicode emoji or custom emote shortcode.${actions.has("emoji-list") ? ' Discover room and personal custom emotes with action:"emoji-list".' : ""}`,
          }),
        ),
      },
    });
  }
  return {
    actions: listedActions,
    capabilities: ["presentation"],
    schema: schema.length > 1 ? schema : (schema[0] ?? null),
    mediaSourceParams: listedActions.includes("set-profile")
      ? { "set-profile": MATRIX_PROFILE_MEDIA_SOURCE_PARAMS }
      : null,
  };
}

export const matrixMessageActions: ChannelMessageActionAdapter = {
  providerOwnedReadGates: true,
  readAuthorityActions: [
    "read",
    "reactions",
    "list-pins",
    "emoji-list",
    "member-info",
    "channel-info",
  ],
  /** @deprecated Use describeMessageToolAsync; removed in the next Plugin SDK major. */
  describeMessageTool: ({ cfg, accountId, senderIsOwner }) => {
    return describeMatrixMessageTool(
      resolveMatrixActionAccount({ cfg: cfg as CoreConfig, accountId }),
      senderIsOwner,
    );
  },
  describeMessageToolAsync: async ({ cfg, accountId, senderIsOwner }) => {
    // SAFETY: The host validates channels.matrix against this plugin's config schema.
    const resolvedCfg = cfg as CoreConfig;
    const account =
      !accountId && requiresExplicitMatrixDefaultAccount(resolvedCfg)
        ? null
        : await resolveMatrixAccountAsync({
            cfg: resolvedCfg,
            accountId: accountId ?? resolveDefaultMatrixAccountId(resolvedCfg),
          });
    return describeMatrixMessageTool(account, senderIsOwner);
  },
  supportsAction: ({ action }) => MATRIX_PLUGIN_HANDLED_ACTIONS.has(action),
  extractToolSend: ({ args }) => {
    return extractToolSend(args, "sendMessage");
  },
  prepareSendPayload: async ({ ctx, payload }) => {
    if (ctx.action !== "send") {
      return null;
    }
    const cfg = ctx.cfg as CoreConfig;
    if (!ctx.accountId && requiresExplicitMatrixDefaultAccount(cfg)) {
      return null;
    }
    const account = await resolveMatrixAccountAsync({ cfg, accountId: ctx.accountId });
    return account.enabled &&
      account.configured &&
      createActionGate(account.config.actions)("messages")
      ? payload
      : null;
  },
  handleAction: async (ctx) => {
    const { handleMatrixAction } = await import("./tool-actions.js");
    return await handleMatrixAction(ctx);
  },
};

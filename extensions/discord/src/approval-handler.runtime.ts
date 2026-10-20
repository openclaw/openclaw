import {
  ButtonStyle,
  ComponentType,
  type APIButtonComponent,
  type APIContainerComponent,
} from "discord-api-types/v10";
import {
  createChannelApprovalNativeRuntimeAdapterAsync,
  type ApprovalViewModel,
  type ChannelApprovalCapabilityHandlerContext,
  type PendingApprovalView,
  type ExpiredApprovalView,
  type ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalActionDescriptor } from "openclaw/plugin-sdk/approval-reply-runtime";
import { formatChannelApprovalResolvedLabel } from "openclaw/plugin-sdk/approval-runtime";
import type {
  DiscordExecApprovalConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { logDebug, logError } from "openclaw/plugin-sdk/logging-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { findGraphemeChunkEnd } from "openclaw/plugin-sdk/text-grapheme";
import { buildExecApprovalCustomId, DISCORD_APPROVAL_DECISIONS } from "./approval-custom-id.js";
import {
  DISCORD_APPROVAL_ALLOWED_MENTIONS,
  formatDiscordApprovalDisplayValue,
} from "./approval-message-safety.js";
import { discordApprovalMessageUpdates } from "./approval-message-updates.js";
import { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
import { isDiscordExecApprovalClientEnabled } from "./exec-approvals.js";
import {
  createChannelMessage,
  deleteChannelMessage,
  editChannelMessage,
} from "./internal/api.messages.js";
import { createUserDmChannel } from "./internal/api.users.js";
import { colorToNumber } from "./internal/components.base.js";
import { serializePayload, type MessagePayloadObject } from "./internal/payload.js";
import {
  createDiscordClient,
  createDiscordMessageNonce,
  stripUndefinedFields,
} from "./send.shared.js";

export { buildExecApprovalCustomId };

type PendingApproval = {
  discordMessageId: string;
  discordChannelId: string;
};
type DiscordPendingDelivery = {
  body: ReturnType<typeof stripUndefinedFields>;
};
type PreparedDeliveryTarget = {
  discordChannelId: string;
  recipientUserId?: string;
};

type DiscordApprovalHandlerContext = {
  token: string;
  config: DiscordExecApprovalConfig;
};

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: DiscordApprovalHandlerContext;
} | null {
  const context = params.context as DiscordApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.token || !accountId) {
    return null;
  }
  return { accountId, context };
}

function createApprovalActionButton(
  view: Pick<PendingApprovalView, "approvalId" | "approvalKind">,
  descriptor: ExecApprovalActionDescriptor,
): APIButtonComponent {
  return {
    type: ComponentType.Button,
    custom_id: buildExecApprovalCustomId(view.approvalId, view.approvalKind, descriptor.decision),
    label: descriptor.label,
    style:
      descriptor.style === "success"
        ? ButtonStyle.Success
        : descriptor.style === "primary"
          ? ButtonStyle.Primary
          : descriptor.style === "danger"
            ? ButtonStyle.Danger
            : ButtonStyle.Secondary,
  };
}

function buildExecApprovalPayload(container: APIContainerComponent): MessagePayloadObject {
  return { components: [container], allowed_mentions: DISCORD_APPROVAL_ALLOWED_MENTIONS };
}

function formatCommandPreview(commandText: string, maxChars: number): string {
  const end = findGraphemeChunkEnd(commandText, 0, maxChars, maxChars, false);
  const preview = end < commandText.length ? `${commandText.slice(0, end)}...` : commandText;
  return preview.replace(/`/g, "\u200b`");
}

function createApprovalContainer(view: ApprovalViewModel): APIContainerComponent {
  const plugin = view.approvalKind === "plugin";
  const systemAgent = view.approvalKind === "system-agent";
  const pending = view.phase === "pending";
  const approvalLabel = plugin ? "Plugin" : systemAgent ? "OpenClaw Change" : "Exec";
  const commandPreview = formatCommandPreview(
    plugin ? view.title : view.commandText,
    plugin ? 700 : pending ? 1000 : 500,
  );
  const secondaryText = plugin ? view.description : view.commandPreview;
  const commandSecondaryPreview = secondaryText
    ? formatCommandPreview(secondaryText, plugin ? 1000 : pending ? 500 : 300)
    : null;
  const decisionLabel =
    view.phase === "resolved"
      ? formatChannelApprovalResolvedLabel(
          view,
          (decision) => DISCORD_APPROVAL_DECISIONS[decision].label,
        )
      : undefined;
  const title = pending
    ? `${approvalLabel} Approval Required`
    : `${approvalLabel} Approval: ${view.phase === "expired" ? "Expired" : decisionLabel}`;
  const description = pending
    ? plugin
      ? "A plugin action needs your approval."
      : systemAgent
        ? "An OpenClaw change needs your approval."
        : "A command needs your approval."
    : view.phase === "expired"
      ? "This approval request has expired."
      : view.resolvedBy
        ? `Resolved by ${formatDiscordApprovalDisplayValue(view.resolvedBy)}`
        : "Resolved";
  const accentColor =
    view.phase === "expired"
      ? "#99AAB5"
      : view.phase === "resolved"
        ? DISCORD_APPROVAL_DECISIONS[view.decision].color
        : plugin
          ? view.severity === "critical"
            ? "#ED4245"
            : view.severity === "info"
              ? "#5865F2"
              : "#FAA61A"
          : "#FFA500";
  const approvalId = formatDiscordApprovalDisplayValue(view.approvalId);
  const footer = pending
    ? `Expires <t:${Math.max(0, Math.floor(view.expiresAtMs / 1000))}:R> · ID: ${approvalId}`
    : `ID: ${approvalId}`;

  const components: APIContainerComponent["components"] = [
    { type: ComponentType.TextDisplay, content: `## ${title}` },
    { type: ComponentType.TextDisplay, content: description },
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    {
      type: ComponentType.TextDisplay,
      content: `### ${systemAgent ? "Change" : "Command"}\n\`\`\`\n${commandPreview}\n\`\`\``,
    },
  ];
  if (commandSecondaryPreview) {
    components.push({
      type: ComponentType.TextDisplay,
      content: `### Shell Preview\n\`\`\`\n${commandSecondaryPreview}\n\`\`\``,
    });
  }
  if (view.metadata.length) {
    components.push({
      type: ComponentType.TextDisplay,
      content: view.metadata.map((item) => `- ${item.label}: ${item.value}`).join("\n"),
    });
  }
  if (pending) {
    components.push({
      type: ComponentType.ActionRow,
      components: view.actions.map((descriptor) => createApprovalActionButton(view, descriptor)),
    });
  }
  components.push(
    { type: ComponentType.Separator, divider: false, spacing: 1 },
    { type: ComponentType.TextDisplay, content: `-# ${footer}` },
  );
  return { type: ComponentType.Container, components, accent_color: colorToNumber(accentColor) };
}

async function finalizeMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  cleanupAfterResolve?: boolean;
  channelId: string;
  messageId: string;
  container: APIContainerComponent;
}): Promise<void> {
  const operations = params.cleanupAfterResolve ? ["delete", "update"] : ["update"];
  for (const operation of operations) {
    try {
      const { rest, request: discordRequest } = createDiscordClient({
        cfg: params.cfg,
        token: params.token,
        accountId: params.accountId,
      });
      let request: () => Promise<unknown>;
      if (operation === "delete") {
        request = () => deleteChannelMessage(rest, params.channelId, params.messageId);
      } else {
        const payload = buildExecApprovalPayload(params.container);
        request = () =>
          editChannelMessage(rest, params.channelId, params.messageId, {
            body: stripUndefinedFields(serializePayload(payload)),
          });
      }
      await discordApprovalMessageUpdates.enqueue(params.messageId, () =>
        discordRequest(request, `${operation}-approval`),
      );
      return;
    } catch (err) {
      logError(`discord approvals: failed to ${operation} message: ${String(err)}`);
    }
  }
}

function buildTerminalApprovalResult(
  params: ChannelApprovalCapabilityHandlerContext & {
    view: ResolvedApprovalView | ExpiredApprovalView;
  },
) {
  if (!resolveHandlerContext(params)) {
    return { kind: "delete" } as const;
  }
  return { kind: "update", payload: createApprovalContainer(params.view) } as const;
}

export const discordApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapterAsync<
  DiscordPendingDelivery,
  PreparedDeliveryTarget,
  PendingApproval,
  never
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isDiscordExecApprovalClientEnabled({
            cfg: params.cfg,
            accountId: resolved.accountId,
            configOverride: resolved.context.config,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? shouldHandleDiscordApprovalRequest({
            cfg: params.cfg,
            accountId: resolved.accountId,
            request: params.request,
            configOverride: resolved.context.config,
          })
        : false;
    },
  },
  presentation: {
    buildPendingPayload: ({ cfg, accountId, context, view }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return { body: {} };
      }
      const container = createApprovalContainer(view);
      return {
        body: stripUndefinedFields(serializePayload(buildExecApprovalPayload(container))),
      };
    },
    buildResolvedResult: buildTerminalApprovalResult,
    buildExpiredResult: buildTerminalApprovalResult,
  },
  transport: {
    prepareTarget: async ({ cfg, accountId, context, plannedTarget }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      if (plannedTarget.surface === "origin") {
        const destinationId =
          typeof plannedTarget.target.threadId === "string" &&
          plannedTarget.target.threadId.trim().length > 0
            ? plannedTarget.target.threadId.trim()
            : plannedTarget.target.to;
        return {
          dedupeKey: destinationId,
          target: {
            discordChannelId: destinationId,
          },
        };
      }
      const { rest, request: discordRequest } = createDiscordClient({
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
      });
      const userId = plannedTarget.target.to;
      const dmChannel = await discordRequest(() => createUserDmChannel(rest, userId), "dm-channel");
      if (!dmChannel?.id) {
        logError(`discord approvals: failed to create DM for user ${userId}`);
        return null;
      }
      return {
        dedupeKey: dmChannel.id,
        target: {
          discordChannelId: dmChannel.id,
          recipientUserId: userId,
        },
      };
    },
    deliverPending: async ({
      cfg,
      accountId,
      context,
      plannedTarget,
      preparedTarget,
      pendingPayload,
    }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const { rest, request: discordRequest } = createDiscordClient({
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
      });
      // Each destination is a distinct logical create. Reuse its nonce only across
      // retries so multi-target approvals cannot deduplicate into the wrong channel.
      const body = {
        ...pendingPayload.body,
        nonce: createDiscordMessageNonce(),
        enforce_nonce: true,
      };
      const message = await discordRequest(
        () => createChannelMessage(rest, preparedTarget.discordChannelId, { body }),
        plannedTarget.surface === "origin" ? "send-approval-channel" : "send-approval",
        { safety: "nonce-protected-create" },
      );
      if (!message?.id) {
        if (plannedTarget.surface === "origin") {
          logError("discord approvals: failed to send to channel");
        } else if (preparedTarget.recipientUserId) {
          logError(
            `discord approvals: failed to send message to user ${preparedTarget.recipientUserId}`,
          );
        }
        return null;
      }
      return {
        discordMessageId: message.id,
        discordChannelId: preparedTarget.discordChannelId,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload, phase }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const container = payload as APIContainerComponent;
      await finalizeMessage({
        cfg,
        accountId: resolved.accountId,
        token: resolved.context.token,
        cleanupAfterResolve:
          phase === "resolved" ? resolved.context.config.cleanupAfterResolve : false,
        channelId: entry.discordChannelId,
        messageId: entry.discordMessageId,
        container,
      });
    },
  },
  observe: {
    onDuplicateSkipped: ({ preparedTarget, request }) => {
      logDebug(
        `discord approvals: skipping duplicate approval ${request.id} for channel ${preparedTarget.dedupeKey}`,
      );
    },
    onDelivered: ({ plannedTarget, preparedTarget, request }) => {
      if (plannedTarget.surface === "origin") {
        logDebug(
          `discord approvals: sent approval ${request.id} to channel ${preparedTarget.target.discordChannelId}`,
        );
        return;
      }
      logDebug(`discord approvals: sent approval ${request.id} to user ${plannedTarget.target.to}`);
    },
    onDeliveryError: ({ error, plannedTarget }) => {
      if (plannedTarget.surface === "origin") {
        logError(`discord approvals: failed to send to channel: ${String(error)}`);
        return;
      }
      logError(
        `discord approvals: failed to notify user ${plannedTarget.target.to}: ${String(error)}`,
      );
    },
  },
});

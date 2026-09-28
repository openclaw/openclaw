import { ButtonStyle } from "discord-api-types/v10";
import {
  createChannelApprovalNativeRuntimeAdapter,
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
import { buildExecApprovalCustomId } from "./approval-custom-id.js";
import {
  DISCORD_APPROVAL_ALLOWED_MENTIONS,
  formatDiscordApprovalDisplayValue,
} from "./approval-message-safety.js";
import { discordApprovalMessageUpdates } from "./approval-message-updates.js";
import { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
import { isDiscordExecApprovalClientEnabled } from "./exec-approvals.js";
import {
  Button,
  createChannelMessage,
  createUserDmChannel,
  deleteChannelMessage,
  editChannelMessage,
  Row,
  Separator,
  TextDisplay,
  serializePayload,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "./internal/discord.js";
import {
  createDiscordClient,
  createDiscordMessageNonce,
  stripUndefinedFields,
} from "./send.shared.js";
import { DiscordUiContainer } from "./ui.js";

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

class ExecApprovalActionButton extends Button {
  override customId: string;
  override label: string;
  override style: ButtonStyle;

  constructor(params: {
    approvalId: string;
    approvalKind: PendingApprovalView["approvalKind"];
    descriptor: ExecApprovalActionDescriptor;
  }) {
    super();
    this.customId = buildExecApprovalCustomId(
      params.approvalId,
      params.approvalKind,
      params.descriptor.decision,
    );
    this.label = params.descriptor.label;
    this.style =
      params.descriptor.style === "success"
        ? ButtonStyle.Success
        : params.descriptor.style === "primary"
          ? ButtonStyle.Primary
          : params.descriptor.style === "danger"
            ? ButtonStyle.Danger
            : ButtonStyle.Secondary;
  }
}

function createApprovalActionRow(view: PendingApprovalView): Row<Button> {
  return new Row(
    view.actions.map(
      (descriptor) =>
        new ExecApprovalActionButton({
          approvalId: view.approvalId,
          approvalKind: view.approvalKind,
          descriptor,
        }),
    ),
  );
}

function buildExecApprovalPayload(container: DiscordUiContainer): MessagePayloadObject {
  const components: TopLevelComponents[] = [container];
  return { components, allowed_mentions: DISCORD_APPROVAL_ALLOWED_MENTIONS };
}

function formatCommandPreview(commandText: string, maxChars: number): string {
  const end = findGraphemeChunkEnd(commandText, 0, maxChars, maxChars, false);
  const preview = end < commandText.length ? `${commandText.slice(0, end)}...` : commandText;
  return preview.replace(/`/g, "\u200b`");
}

function formatOptionalCommandPreview(
  commandText: string | null | undefined,
  maxChars: number,
): string | null {
  if (!commandText) {
    return null;
  }
  return formatCommandPreview(commandText, maxChars);
}

function createApprovalContainer(params: {
  view: ApprovalViewModel;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): DiscordUiContainer {
  const { view } = params;
  const plugin = view.approvalKind === "plugin";
  const systemAgent = view.approvalKind === "system-agent";
  const pending = view.phase === "pending";
  const approvalLabel = plugin ? "Plugin" : systemAgent ? "OpenClaw Change" : "Exec";
  const { commandPreview, commandSecondaryPreview } = plugin
    ? {
        commandPreview: formatCommandPreview(view.title, 700),
        commandSecondaryPreview: formatOptionalCommandPreview(view.description, 1000),
      }
    : {
        commandPreview: formatCommandPreview(view.commandText, pending ? 1000 : 500),
        commandSecondaryPreview: formatOptionalCommandPreview(
          view.commandPreview,
          pending ? 500 : 300,
        ),
      };
  const decisionLabel =
    view.phase === "resolved"
      ? formatChannelApprovalResolvedLabel(view, (decision) =>
          decision === "allow-once"
            ? "Allowed (once)"
            : decision === "allow-always"
              ? "Allowed (always)"
              : "Denied",
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
        ? view.decision === "deny"
          ? "#ED4245"
          : view.decision === "allow-always"
            ? "#5865F2"
            : "#57F287"
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

  const components: Array<TextDisplay | Separator | Row<Button>> = [
    new TextDisplay(`## ${title}`),
    new TextDisplay(description),
    new Separator({ divider: true, spacing: "small" }),
    new TextDisplay(`### ${systemAgent ? "Change" : "Command"}\n\`\`\`\n${commandPreview}\n\`\`\``),
  ];
  if (commandSecondaryPreview) {
    components.push(
      new TextDisplay(`### Shell Preview\n\`\`\`\n${commandSecondaryPreview}\n\`\`\``),
    );
  }
  if (view.metadata.length) {
    components.push(
      new TextDisplay(view.metadata.map((item) => `- ${item.label}: ${item.value}`).join("\n")),
    );
  }
  if (params.actionRow) {
    components.push(params.actionRow);
  }
  components.push(
    new Separator({ divider: false, spacing: "small" }),
    new TextDisplay(`-# ${footer}`),
  );
  return new DiscordUiContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    components,
    accentColor,
  });
}

async function updateMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  channelId: string;
  messageId: string;
  container: DiscordUiContainer;
}): Promise<void> {
  try {
    const { rest, request: discordRequest } = createDiscordClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    });
    const payload = buildExecApprovalPayload(params.container);
    await discordApprovalMessageUpdates.enqueue(params.messageId, () =>
      discordRequest(
        () =>
          editChannelMessage(rest, params.channelId, params.messageId, {
            body: stripUndefinedFields(serializePayload(payload)),
          }),
        "update-approval",
      ),
    );
  } catch (err) {
    logError(`discord approvals: failed to update message: ${String(err)}`);
  }
}

async function finalizeMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  cleanupAfterResolve?: boolean;
  channelId: string;
  messageId: string;
  container: DiscordUiContainer;
}): Promise<void> {
  if (!params.cleanupAfterResolve) {
    await updateMessage(params);
    return;
  }
  try {
    const { rest, request: discordRequest } = createDiscordClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    });
    await discordApprovalMessageUpdates.enqueue(params.messageId, () =>
      discordRequest(
        () => deleteChannelMessage(rest, params.channelId, params.messageId),
        "delete-approval",
      ),
    );
  } catch (err) {
    logError(`discord approvals: failed to delete message: ${String(err)}`);
    await updateMessage(params);
  }
}

function buildTerminalApprovalResult(
  params: ChannelApprovalCapabilityHandlerContext & {
    view: ResolvedApprovalView | ExpiredApprovalView;
  },
) {
  const resolved = resolveHandlerContext(params);
  if (!resolved) {
    return { kind: "delete" } as const;
  }
  const container = createApprovalContainer({
    view: params.view,
    cfg: params.cfg,
    accountId: resolved.accountId,
  });
  return { kind: "update", payload: container } as const;
}

export const discordApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
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
      const container = createApprovalContainer({
        view,
        cfg,
        accountId: resolved.accountId,
        actionRow: createApprovalActionRow(view),
      });
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
      const dmChannel = (await discordRequest(
        () => createUserDmChannel(rest, userId),
        "dm-channel",
      )) as { id: string };
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
      const message = (await discordRequest(
        () =>
          createChannelMessage<{ id: string; channel_id: string }>(
            rest,
            preparedTarget.discordChannelId,
            {
              body,
            },
          ),
        plannedTarget.surface === "origin" ? "send-approval-channel" : "send-approval",
        { safety: "nonce-protected-create" },
      )) as { id: string; channel_id: string };
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
      const container = payload as DiscordUiContainer;
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

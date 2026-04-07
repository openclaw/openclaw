import {
  Button,
  Row,
  Separator,
  TextDisplay,
  serializePayload,
  type ButtonInteraction,
  type ComponentData,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "@buape/carbon";
import { ButtonStyle, Routes } from "discord-api-types/v10";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ExecApprovalActionDescriptor,
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
  PluginApprovalRequest,
  PluginApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import {
  buildExecApprovalActionDescriptors,
  createChannelNativeApprovalRuntime,
  getExecApprovalApproverDmNoticeText,
  resolveExecApprovalCommandDisplay,
  type ExecApprovalChannelRuntime,
} from "openclaw/plugin-sdk/infra-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logDebug, logError } from "openclaw/plugin-sdk/text-runtime";
import {
  createDiscordApprovalCapability,
  shouldHandleDiscordApprovalRequest,
} from "../approval-native.js";
import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalClientEnabled,
} from "../exec-approvals.js";
import { createDiscordClient, stripUndefinedFields } from "../send.shared.js";
import { DiscordUiContainer } from "../ui.js";

const EXEC_APPROVAL_KEY = "execapproval";
export { extractDiscordChannelId } from "../approval-native.js";
export type {
  ExecApprovalRequest,
  ExecApprovalResolved,
  PluginApprovalRequest,
  PluginApprovalResolved,
};

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type ApprovalKind = "exec" | "plugin";

function buildDiscordApprovalDmRedirectNotice(): { content: string } {
  return {
    content: getExecApprovalApproverDmNoticeText(),
  };
}

type PendingApproval = {
  discordMessageId: string;
  discordChannelId: string;
  timeoutId?: NodeJS.Timeout;
};
type DiscordPendingDelivery = {
  body: ReturnType<typeof stripUndefinedFields>;
};
type PreparedDeliveryTarget = {
  discordChannelId: string;
  recipientUserId?: string;
};

function resolveApprovalKindFromId(approvalId: string): ApprovalKind {
  return approvalId.startsWith("plugin:") ? "plugin" : "exec";
}

function isPluginApprovalRequest(request: ApprovalRequest): request is PluginApprovalRequest {
  return resolveApprovalKindFromId(request.id) === "plugin";
}

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildExecApprovalCustomId(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  return [`${EXEC_APPROVAL_KEY}:id=${encodeCustomIdValue(approvalId)}`, `action=${action}`].join(
    ";",
  );
}

export function parseExecApprovalData(
  data: ComponentData,
): { approvalId: string; action: ExecApprovalDecision } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawId = coerce(data.id);
  const rawAction = coerce(data.action);
  if (!rawId || !rawAction) {
    return null;
  }
  const action = rawAction as ExecApprovalDecision;
  if (action !== "allow-once" && action !== "allow-always" && action !== "deny") {
    return null;
  }
  return {
    approvalId: decodeCustomIdValue(rawId),
    action,
  };
}

type ExecApprovalContainerParams = {
  cfg: OpenClawConfig;
  accountId: string;
  title: string;
  description?: string;
  commandPreview: string;
  commandSecondaryPreview?: string | null;
  metadataLines?: string[];
  actionRow?: Row<Button>;
  footer?: string;
  accentColor?: string;
};

class ExecApprovalContainer extends DiscordUiContainer {
  constructor(params: ExecApprovalContainerParams) {
    const components: Array<TextDisplay | Separator | Row<Button>> = [
      new TextDisplay(`## ${params.title}`),
    ];
    if (params.description) {
      components.push(new TextDisplay(params.description));
    }
    components.push(new Separator({ divider: true, spacing: "small" }));
    components.push(new TextDisplay(`### Command\n\`\`\`\n${params.commandPreview}\n\`\`\``));
    if (params.commandSecondaryPreview) {
      components.push(
        new TextDisplay(`### Shell Preview\n\`\`\`\n${params.commandSecondaryPreview}\n\`\`\``),
      );
    }
    if (params.metadataLines?.length) {
      components.push(new TextDisplay(params.metadataLines.join("\n")));
    }
    if (params.actionRow) {
      components.push(params.actionRow);
    }
    if (params.footer) {
      components.push(new Separator({ divider: false, spacing: "small" }));
      components.push(new TextDisplay(`-# ${params.footer}`));
    }
    super({
      cfg: params.cfg,
      accountId: params.accountId,
      components,
      accentColor: params.accentColor,
    });
  }
}

class ExecApprovalActionButton extends Button {
  customId: string;
  label: string;
  style: ButtonStyle;

  constructor(params: { approvalId: string; descriptor: ExecApprovalActionDescriptor }) {
    super();
    this.customId = buildExecApprovalCustomId(params.approvalId, params.descriptor.decision);
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

class ExecApprovalActionRow extends Row<Button> {
  constructor(params: {
    approvalId: string;
    ask?: string | null;
    allowedDecisions?: readonly ExecApprovalDecision[];
  }) {
    super(
      buildExecApprovalActionDescriptors({
        approvalCommandId: params.approvalId,
        ask: params.ask,
        allowedDecisions: params.allowedDecisions,
      }).map(
        (descriptor) => new ExecApprovalActionButton({ approvalId: params.approvalId, descriptor }),
      ),
    );
  }
}

function createApprovalActionRow(request: ApprovalRequest): Row<Button> {
  if (isPluginApprovalRequest(request)) {
    return new ExecApprovalActionRow({
      approvalId: request.id,
    });
  }
  return new ExecApprovalActionRow({
    approvalId: request.id,
    ask: request.request.ask,
    allowedDecisions: request.request.allowedDecisions,
  });
}

function buildExecApprovalMetadataLines(request: ExecApprovalRequest): string[] {
  const lines: string[] = [];
  if (request.request.cwd) {
    lines.push(`- Working Directory: ${request.request.cwd}`);
  }
  if (request.request.host) {
    lines.push(`- Host: ${request.request.host}`);
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    lines.push(`- Env Overrides: ${request.request.envKeys.join(", ")}`);
  }
  if (request.request.agentId) {
    lines.push(`- Agent: ${request.request.agentId}`);
  }
  return lines;
}

function buildPluginApprovalMetadataLines(request: PluginApprovalRequest): string[] {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  lines.push(
    `- Severity: ${severity === "critical" ? "Critical" : severity === "info" ? "Info" : "Warning"}`,
  );
  if (request.request.toolName) {
    lines.push(`- Tool: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`- Plugin: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`- Agent: ${request.request.agentId}`);
  }
  return lines;
}

function buildExecApprovalPayload(container: DiscordUiContainer): MessagePayloadObject {
  const components: TopLevelComponents[] = [container];
  return { components };
}

function formatCommandPreview(commandText: string, maxChars: number): string {
  const commandRaw =
    commandText.length > maxChars ? `${commandText.slice(0, maxChars)}...` : commandText;
  return commandRaw.replace(/`/g, "\u200b`");
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

function resolveExecApprovalPreviews(
  request: ExecApprovalRequest["request"],
  maxChars: number,
  secondaryMaxChars: number,
): { commandPreview: string; commandSecondaryPreview: string | null } {
  const { commandText, commandPreview: secondaryPreview } =
    resolveExecApprovalCommandDisplay(request);
  return {
    commandPreview: formatCommandPreview(commandText, maxChars),
    commandSecondaryPreview: formatOptionalCommandPreview(secondaryPreview, secondaryMaxChars),
  };
}

function createExecApprovalRequestContainer(params: {
  request: ExecApprovalRequest;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveExecApprovalPreviews(
    params.request.request,
    1000,
    500,
  );
  const expiresAtSeconds = Math.max(0, Math.floor(params.request.expiresAtMs / 1000));

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    commandPreview,
    commandSecondaryPreview,
    metadataLines: buildExecApprovalMetadataLines(params.request),
    actionRow: params.actionRow,
    footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.request.id}`,
    accentColor: "#FFA500",
  });
}

function createPluginApprovalRequestContainer(params: {
  request: PluginApprovalRequest;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): ExecApprovalContainer {
  const expiresAtSeconds = Math.max(0, Math.floor(params.request.expiresAtMs / 1000));
  const severity = params.request.request.severity ?? "warning";
  const accentColor =
    severity === "critical" ? "#ED4245" : severity === "info" ? "#5865F2" : "#FAA61A";
  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Plugin Approval Required",
    description: "A plugin action needs your approval.",
    commandPreview: formatCommandPreview(params.request.request.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.request.request.description, 1000),
    metadataLines: buildPluginApprovalMetadataLines(params.request),
    actionRow: params.actionRow,
    footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.request.id}`,
    accentColor,
  });
}

function createExecResolvedContainer(params: {
  request: ExecApprovalRequest;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveExecApprovalPreviews(
    params.request.request,
    500,
    300,
  );

  const decisionLabel =
    params.decision === "allow-once"
      ? "Allowed (once)"
      : params.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";

  const accentColor =
    params.decision === "deny"
      ? "#ED4245"
      : params.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: `Exec Approval: ${decisionLabel}`,
    description: params.resolvedBy ? `Resolved by ${params.resolvedBy}` : "Resolved",
    commandPreview,
    commandSecondaryPreview,
    footer: `ID: ${params.request.id}`,
    accentColor,
  });
}

function createPluginResolvedContainer(params: {
  request: PluginApprovalRequest;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const decisionLabel =
    params.decision === "allow-once"
      ? "Allowed (once)"
      : params.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";

  const accentColor =
    params.decision === "deny"
      ? "#ED4245"
      : params.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: `Plugin Approval: ${decisionLabel}`,
    description: params.resolvedBy ? `Resolved by ${params.resolvedBy}` : "Resolved",
    commandPreview: formatCommandPreview(params.request.request.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.request.request.description, 1000),
    metadataLines: buildPluginApprovalMetadataLines(params.request),
    footer: `ID: ${params.request.id}`,
    accentColor,
  });
}

function createExecExpiredContainer(params: {
  request: ExecApprovalRequest;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveExecApprovalPreviews(
    params.request.request,
    500,
    300,
  );

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Exec Approval: Expired",
    description: "This approval request has expired.",
    commandPreview,
    commandSecondaryPreview,
    footer: `ID: ${params.request.id}`,
    accentColor: "#99AAB5",
  });
}

function createPluginExpiredContainer(params: {
  request: PluginApprovalRequest;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Plugin Approval: Expired",
    description: "This approval request has expired.",
    commandPreview: formatCommandPreview(params.request.request.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.request.request.description, 1000),
    metadataLines: buildPluginApprovalMetadataLines(params.request),
    footer: `ID: ${params.request.id}`,
    accentColor: "#99AAB5",
  });
}

export type DiscordExecApprovalHandlerOpts = {
  token: string;
  accountId: string;
  config: DiscordExecApprovalConfig;
  gatewayUrl?: string;
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  onResolve?: (id: string, decision: ExecApprovalDecision) => Promise<void>;
};

export class DiscordExecApprovalHandler {
  private readonly runtime: ExecApprovalChannelRuntime<ApprovalRequest, ApprovalResolved>;
  private opts: DiscordExecApprovalHandlerOpts;

  constructor(opts: DiscordExecApprovalHandlerOpts) {
    this.opts = opts;
    this.runtime = createChannelNativeApprovalRuntime<
      PendingApproval,
      PreparedDeliveryTarget,
      DiscordPendingDelivery
    >({
      label: "discord/exec-approvals",
      clientDisplayName: "Discord Exec Approvals",
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      gatewayUrl: this.opts.gatewayUrl,
      eventKinds: ["exec", "plugin"],
      nativeAdapter: createDiscordApprovalCapability(this.opts.config).native,
      isConfigured: () =>
        isDiscordExecApprovalClientEnabled({
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
          configOverride: this.opts.config,
        }),
      shouldHandle: (request) => this.shouldHandle(request),
      buildPendingContent: ({ request }) => {
        const actionRow = createApprovalActionRow(request);
        const container = isPluginApprovalRequest(request)
          ? createPluginApprovalRequestContainer({
              request,
              cfg: this.opts.cfg,
              accountId: this.opts.accountId,
              actionRow,
            })
          : createExecApprovalRequestContainer({
              request,
              cfg: this.opts.cfg,
              accountId: this.opts.accountId,
              actionRow,
            });
        const payload = buildExecApprovalPayload(container);
        return {
          body: stripUndefinedFields(serializePayload(payload)),
        };
      },
      sendOriginNotice: async ({ originTarget }) => {
        const { rest, request: discordRequest } = createDiscordClient(
          { token: this.opts.token, accountId: this.opts.accountId },
          this.opts.cfg,
        );
        await discordRequest(
          () =>
            rest.post(Routes.channelMessages(originTarget.to), {
              body: buildDiscordApprovalDmRedirectNotice(),
            }) as Promise<{ id: string; channel_id: string }>,
          "send-approval-dm-redirect-notice",
        );
      },
      prepareTarget: async ({ plannedTarget }) => {
        const { rest, request: discordRequest } = createDiscordClient(
          { token: this.opts.token, accountId: this.opts.accountId },
          this.opts.cfg,
        );
        if (plannedTarget.surface === "origin") {
          return {
            dedupeKey: plannedTarget.target.to,
            target: {
              discordChannelId: plannedTarget.target.to,
            },
          };
        }

        const userId = plannedTarget.target.to;
        const dmChannel = (await discordRequest(
          () =>
            rest.post(Routes.userChannels(), {
              body: { recipient_id: userId },
            }) as Promise<{ id: string }>,
          "dm-channel",
        )) as { id: string };

        if (!dmChannel?.id) {
          logError(`discord exec approvals: failed to create DM for user ${userId}`);
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
      deliverTarget: async ({
        plannedTarget,
        preparedTarget,
        pendingContent,
        request: _request,
      }) => {
        const { rest, request: discordRequest } = createDiscordClient(
          { token: this.opts.token, accountId: this.opts.accountId },
          this.opts.cfg,
        );
        const message = (await discordRequest(
          () =>
            rest.post(Routes.channelMessages(preparedTarget.discordChannelId), {
              body: pendingContent.body,
            }) as Promise<{ id: string; channel_id: string }>,
          plannedTarget.surface === "origin" ? "send-approval-channel" : "send-approval",
        )) as { id: string; channel_id: string };

        if (!message?.id) {
          if (plannedTarget.surface === "origin") {
            logError("discord exec approvals: failed to send to channel");
          } else if (preparedTarget.recipientUserId) {
            logError(
              `discord exec approvals: failed to send message to user ${preparedTarget.recipientUserId}`,
            );
          }
          return null;
        }

        return {
          discordMessageId: message.id,
          discordChannelId: preparedTarget.discordChannelId,
        };
      },
      onOriginNoticeError: ({ error }) => {
        logError(`discord exec approvals: failed to send DM redirect notice: ${String(error)}`);
      },
      onDuplicateSkipped: ({ preparedTarget, request }) => {
        logDebug(
          `discord exec approvals: skipping duplicate approval ${request.id} for channel ${preparedTarget.dedupeKey}`,
        );
      },
      onDelivered: ({ plannedTarget, preparedTarget, request }) => {
        if (plannedTarget.surface === "origin") {
          logDebug(
            `discord exec approvals: sent approval ${request.id} to channel ${preparedTarget.target.discordChannelId}`,
          );
          return;
        }
        logDebug(
          `discord exec approvals: sent approval ${request.id} to user ${plannedTarget.target.to}`,
        );
      },
      onDeliveryError: ({ error, plannedTarget }) => {
        if (plannedTarget.surface === "origin") {
          logError(`discord exec approvals: failed to send to channel: ${String(error)}`);
          return;
        }
        logError(
          `discord exec approvals: failed to notify user ${plannedTarget.target.to}: ${String(error)}`,
        );
      },
      finalizeResolved: async ({ request, resolved, entries }) => {
        await this.finalizeResolved(request, resolved, entries);
      },
      finalizeExpired: async ({ request, entries }) => {
        await this.finalizeExpired(request, entries);
      },
    });
  }

  shouldHandle(request: ApprovalRequest): boolean {
    return shouldHandleDiscordApprovalRequest({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request,
      configOverride: this.opts.config,
    });
  }

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  async handleApprovalRequested(request: ApprovalRequest): Promise<void> {
    await this.runtime.handleRequested(request);
  }

  async handleApprovalResolved(resolved: ApprovalResolved): Promise<void> {
    await this.runtime.handleResolved(resolved);
  }

  async handleApprovalTimeout(approvalId: string, _source?: "channel" | "dm"): Promise<void> {
    await this.runtime.handleExpired(approvalId);
  }

  private async finalizeResolved(
    request: ApprovalRequest,
    resolved: ApprovalResolved,
    entries: PendingApproval[],
  ): Promise<void> {
    const container = isPluginApprovalRequest(request)
      ? createPluginResolvedContainer({
          request,
          decision: resolved.decision,
          resolvedBy: resolved.resolvedBy,
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
        })
      : createExecResolvedContainer({
          request,
          decision: resolved.decision,
          resolvedBy: resolved.resolvedBy,
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
        });

    for (const pending of entries) {
      await this.finalizeMessage(pending.discordChannelId, pending.discordMessageId, container);
    }
  }

  private async finalizeExpired(
    request: ApprovalRequest,
    entries: PendingApproval[],
  ): Promise<void> {
    const container = isPluginApprovalRequest(request)
      ? createPluginExpiredContainer({
          request,
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
        })
      : createExecExpiredContainer({
          request,
          cfg: this.opts.cfg,
          accountId: this.opts.accountId,
        });
    for (const pending of entries) {
      await this.finalizeMessage(pending.discordChannelId, pending.discordMessageId, container);
    }
  }

  private async finalizeMessage(
    channelId: string,
    messageId: string,
    container: DiscordUiContainer,
  ): Promise<void> {
    if (!this.opts.config.cleanupAfterResolve) {
      await this.updateMessage(channelId, messageId, container);
      return;
    }

    try {
      const { rest, request: discordRequest } = createDiscordClient(
        { token: this.opts.token, accountId: this.opts.accountId },
        this.opts.cfg,
      );

      await discordRequest(
        () => rest.delete(Routes.channelMessage(channelId, messageId)) as Promise<void>,
        "delete-approval",
      );
    } catch (err) {
      logError(`discord exec approvals: failed to delete message: ${String(err)}`);
      await this.updateMessage(channelId, messageId, container);
    }
  }

  private async updateMessage(
    channelId: string,
    messageId: string,
    container: DiscordUiContainer,
  ): Promise<void> {
    try {
      const { rest, request: discordRequest } = createDiscordClient(
        { token: this.opts.token, accountId: this.opts.accountId },
        this.opts.cfg,
      );
      const payload = buildExecApprovalPayload(container);

      await discordRequest(
        () =>
          rest.patch(Routes.channelMessage(channelId, messageId), {
            body: stripUndefinedFields(serializePayload(payload)),
          }),
        "update-approval",
      );
    } catch (err) {
      logError(`discord exec approvals: failed to update message: ${String(err)}`);
    }
  }

  async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    const method =
      resolveApprovalKindFromId(approvalId) === "plugin"
        ? "plugin.approval.resolve"
        : "exec.approval.resolve";
    logDebug(`discord exec approvals: resolving ${approvalId} with ${decision} via ${method}`);

    try {
      await this.runtime.request(method, {
        id: approvalId,
        decision,
      });
      logDebug(`discord exec approvals: resolved ${approvalId} successfully`);
      return true;
    } catch (err) {
      logError(`discord exec approvals: resolve failed: ${String(err)}`);
      return false;
    }
  }

  /** Return the list of configured approver IDs. */
  getApprovers(): string[] {
    return getDiscordExecApprovalApprovers({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      configOverride: this.opts.config,
    });
  }
}

export type ExecApprovalButtonContext = {
  handler: DiscordExecApprovalHandler;
};

export class ExecApprovalButton extends Button {
  label = "execapproval";
  customId = `${EXEC_APPROVAL_KEY}:seed=1`;
  style = ButtonStyle.Primary;
  private ctx: ExecApprovalButtonContext;

  constructor(ctx: ExecApprovalButtonContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseExecApprovalData(data);
    if (!parsed) {
      try {
        await interaction.reply({
          content: "This approval is no longer valid.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    // Verify the user is an authorized approver
    const approvers = this.ctx.handler.getApprovers();
    const userId = interaction.userId;
    if (!approvers.some((id) => String(id) === userId)) {
      try {
        await interaction.reply({
          content: "⛔ You are not authorized to approve exec requests.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const decisionLabel =
      parsed.action === "allow-once"
        ? "Allowed (once)"
        : parsed.action === "allow-always"
          ? "Allowed (always)"
          : "Denied";

    // Acknowledge immediately so Discord does not fail the interaction while
    // the gateway resolve roundtrip completes. The resolved event will update
    // the approval card in-place with the final state.
    try {
      await interaction.acknowledge();
    } catch {
      // Interaction may have expired, try to continue anyway
    }

    const ok = await this.ctx.handler.resolveApproval(parsed.approvalId, parsed.action);

    if (!ok) {
      try {
        await interaction.followUp({
          content: `Failed to submit approval decision for **${decisionLabel}**. The request may have expired or already been resolved.`,
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
    }
    // On success, the handleApprovalResolved event will update the message with the final result
  }
}

export function createExecApprovalButton(ctx: ExecApprovalButtonContext): Button {
  return new ExecApprovalButton(ctx);
}

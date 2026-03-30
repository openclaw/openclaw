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
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordExecApprovalConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  createExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntime,
} from "openclaw/plugin-sdk/infra-runtime";
import { buildExecApprovalActionDescriptors } from "openclaw/plugin-sdk/infra-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/infra-runtime";
import { getExecApprovalApproverDmNoticeText } from "openclaw/plugin-sdk/infra-runtime";
import type {
  ExecApprovalActionDescriptor,
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
  PluginApprovalRequest,
  PluginApprovalResolved,
} from "openclaw/plugin-sdk/infra-runtime";
import {
  normalizeAccountId,
  normalizeMessageChannel,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { compileSafeRegex, testRegexWithBoundedInput } from "openclaw/plugin-sdk/security-runtime";
import { logDebug, logError } from "openclaw/plugin-sdk/text-runtime";
import { createDiscordClient, stripUndefinedFields } from "../send.shared.js";
import { DiscordUiContainer } from "../ui.js";

const EXEC_APPROVAL_KEY = "execapproval";
export type {
  ExecApprovalRequest,
  ExecApprovalResolved,
  PluginApprovalRequest,
  PluginApprovalResolved,
};

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type ApprovalKind = "exec" | "plugin";

/** Extract Discord channel ID from a session key like "agent:main:discord:channel:123456789" */
export function extractDiscordChannelId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  // Session key format: agent:<id>:discord:channel:<channelId> or agent:<id>:discord:group:<channelId>
  const match = sessionKey.match(/discord:(?:channel|group):(\d+)/);
  return match ? match[1] : null;
}

function buildDiscordApprovalDmRedirectNotice(): { content: string } {
  return {
    content: getExecApprovalApproverDmNoticeText(),
  };
}

type PendingApproval = {
  discordMessageId: string;
  discordChannelId: string;
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
  constructor(approvalId: string) {
    super([
      ...buildExecApprovalActionDescriptors({ approvalCommandId: approvalId }).map(
        (descriptor) => new ExecApprovalActionButton({ approvalId, descriptor }),
      ),
    ]);
  }
}

function resolveExecApprovalAccountId(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): string | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const channel = normalizeMessageChannel(entry?.origin?.provider ?? entry?.lastChannel);
    if (channel && channel !== "discord") {
      return null;
    }
    const accountId = entry?.origin?.accountId ?? entry?.lastAccountId;
    return accountId?.trim() || null;
  } catch {
    return null;
  }
}

function resolvePluginApprovalAccountId(params: {
  cfg: OpenClawConfig;
  request: PluginApprovalRequest;
}): string | null {
  const fromSession = resolveExecApprovalAccountId({
    cfg: params.cfg,
    request: {
      id: params.request.id,
      request: {
        command: params.request.request.title,
        sessionKey: params.request.request.sessionKey ?? undefined,
      },
      createdAtMs: params.request.createdAtMs,
      expiresAtMs: params.request.expiresAtMs,
    },
  });
  if (fromSession) {
    return fromSession;
  }
  return params.request.request.turnSourceAccountId?.trim() || null;
}

function resolveApprovalAccountId(params: {
  cfg: OpenClawConfig;
  request: ApprovalRequest;
}): string | null {
  return isPluginApprovalRequest(params.request)
    ? resolvePluginApprovalAccountId({ cfg: params.cfg, request: params.request })
    : resolveExecApprovalAccountId({ cfg: params.cfg, request: params.request });
}

function resolveApprovalAgentId(request: ApprovalRequest): string | null {
  return request.request.agentId?.trim() || null;
}

function resolveApprovalSessionKey(request: ApprovalRequest): string | null {
  return request.request.sessionKey?.trim() || null;
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
    this.runtime = createExecApprovalChannelRuntime<PendingApproval, ApprovalRequest, ApprovalResolved>({
      label: "discord/exec-approvals",
      clientDisplayName: "Discord Exec Approvals",
      cfg: this.opts.cfg,
      gatewayUrl: this.opts.gatewayUrl,
      eventKinds: ["exec", "plugin"],
      isConfigured: () =>
        Boolean(this.opts.config.enabled && (this.opts.config.approvers?.length ?? 0) > 0),
      shouldHandle: (request) => this.shouldHandle(request),
      deliverRequested: async (request) => await this.deliverRequested(request),
      finalizeResolved: async ({ request, resolved, entries }) => {
        await this.finalizeResolved(request, resolved, entries);
      },
      finalizeExpired: async ({ request, entries }) => {
        await this.finalizeExpired(request, entries);
      },
    });
  }

  shouldHandle(request: ApprovalRequest): boolean {
    const config = this.opts.config;
    if (!config.enabled) {
      return false;
    }
    if (!config.approvers || config.approvers.length === 0) {
      return false;
    }

    const requestAccountId = resolveApprovalAccountId({
      cfg: this.opts.cfg,
      request,
    });
    if (requestAccountId) {
      const handlerAccountId = normalizeAccountId(this.opts.accountId);
      if (normalizeAccountId(requestAccountId) !== handlerAccountId) {
        return false;
      }
    }

    // Check agent filter
    if (config.agentFilter?.length) {
      const agentId = resolveApprovalAgentId(request);
      if (!agentId) {
        return false;
      }
      if (!config.agentFilter.includes(agentId)) {
        return false;
      }
    }

    // Check session filter (substring match)
    if (config.sessionFilter?.length) {
      const session = resolveApprovalSessionKey(request);
      if (!session) {
        return false;
      }
      const matches = config.sessionFilter.some((p) => {
        if (session.includes(p)) {
          return true;
        }
        const regex = compileSafeRegex(p);
        return regex ? testRegexWithBoundedInput(regex, session) : false;
      });
      if (!matches) {
        return false;
      }
    }

    return true;
  }

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  private async deliverRequested(request: ApprovalRequest): Promise<PendingApproval[]> {
    const { rest, request: discordRequest } = createDiscordClient(
      { token: this.opts.token, accountId: this.opts.accountId },
      this.opts.cfg,
    );

    const actionRow = new ExecApprovalActionRow(request.id);
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
    const body = stripUndefinedFields(serializePayload(payload));

    const target = this.opts.config.target ?? "dm";
    const sendToDm = target === "dm" || target === "both";
    const sendToChannel = target === "channel" || target === "both";
    let fallbackToDm = false;
    const pendingEntries: PendingApproval[] = [];
    const originatingChannelId =
      target === "dm"
        ? extractDiscordChannelId(resolveApprovalSessionKey(request))
        : null;

    if (target === "dm" && originatingChannelId) {
      try {
        await discordRequest(
          () =>
            rest.post(Routes.channelMessages(originatingChannelId), {
              body: buildDiscordApprovalDmRedirectNotice(),
            }) as Promise<{ id: string; channel_id: string }>,
          "send-approval-dm-redirect-notice",
        );
      } catch (err) {
        logError(`discord exec approvals: failed to send DM redirect notice: ${String(err)}`);
      }
    }

    // Send to originating channel if configured
    if (sendToChannel) {
      const sessionKey = resolveApprovalSessionKey(request);
      const channelId = extractDiscordChannelId(sessionKey);
      if (channelId) {
        try {
          const message = (await discordRequest(
            () =>
              rest.post(Routes.channelMessages(channelId), {
                body,
              }) as Promise<{ id: string; channel_id: string }>,
            "send-approval-channel",
          )) as { id: string; channel_id: string };

          if (message?.id) {
            pendingEntries.push({
              discordMessageId: message.id,
              discordChannelId: channelId,
            });

            logDebug(`discord exec approvals: sent approval ${request.id} to channel ${channelId}`);
          }
        } catch (err) {
          logError(`discord exec approvals: failed to send to channel: ${String(err)}`);
        }
      } else {
        if (!sendToDm) {
          logError(
            `discord exec approvals: target is "channel" but could not extract channel id from session key "${sessionKey ?? "(none)"}" — falling back to DM delivery for approval ${request.id}`,
          );
          fallbackToDm = true;
        } else {
          logDebug("discord exec approvals: could not extract channel id from session key");
        }
      }
    }

    // Send to approver DMs if configured (or as fallback when channel extraction fails)
    if (sendToDm || fallbackToDm) {
      const approvers = this.opts.config.approvers ?? [];

      for (const approver of approvers) {
        const userId = String(approver);
        try {
          // Create DM channel
          const dmChannel = (await discordRequest(
            () =>
              rest.post(Routes.userChannels(), {
                body: { recipient_id: userId },
              }) as Promise<{ id: string }>,
            "dm-channel",
          )) as { id: string };

          if (!dmChannel?.id) {
            logError(`discord exec approvals: failed to create DM for user ${userId}`);
            continue;
          }

          // Send message with components v2 + buttons
          const message = (await discordRequest(
            () =>
              rest.post(Routes.channelMessages(dmChannel.id), {
                body,
              }) as Promise<{ id: string; channel_id: string }>,
            "send-approval",
          )) as { id: string; channel_id: string };

          if (!message?.id) {
            logError(`discord exec approvals: failed to send message to user ${userId}`);
            continue;
          }

          pendingEntries.push({
            discordMessageId: message.id,
            discordChannelId: dmChannel.id,
          });

          logDebug(`discord exec approvals: sent approval ${request.id} to user ${userId}`);
        } catch (err) {
          logError(`discord exec approvals: failed to notify user ${userId}: ${String(err)}`);
        }
      }
    }
    return pendingEntries;
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
    return this.opts.config.approvers ?? [];
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

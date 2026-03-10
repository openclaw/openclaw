import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { loadSessionStore, resolveStorePath } from "../../../../src/config/sessions.js";
import { buildGatewayConnectionDetails } from "../../../../src/gateway/call.js";
import { GatewayClient } from "../../../../src/gateway/client.js";
import { resolveGatewayConnectionAuth } from "../../../../src/gateway/connection-auth.js";
import type { EventFrame } from "../../../../src/gateway/protocol/index.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "../../../../src/infra/exec-approvals.js";
import { resolveSessionDeliveryTarget } from "../../../../src/infra/outbound/targets.js";
import {
  normalizeAccountId,
  resolveAgentIdFromSessionKey,
} from "../../../../src/routing/session-key.js";
import {
  compileSafeRegex,
  testRegexWithBoundedInput,
} from "../../../../src/security/safe-regex.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  normalizeMessageChannel,
} from "../../../../src/utils/message-channel.js";
import type { ZulipExecApprovalConfig } from "../types.js";
import type { ZulipClient } from "./client.js";
import { updateZulipMessage } from "./client.js";
import { resolveZulipUserInputs } from "./resolve-users.js";
import { sendZulipComponentMessage } from "./send-components.js";
import { sendMessageZulip } from "./send.js";

const DEFAULT_TARGET = "dm" as const;
const DEFAULT_APPROVAL_AGENT_ID = "main";
const DEFAULT_STREAM_TOPIC = "exec-approvals";

export const ZULIP_EXEC_APPROVAL_CALLBACK_PREFIX = "exec_approval:";

type PendingApprovalMessage = {
  messageId: number;
  target: string;
};

type PendingApproval = {
  request: ExecApprovalRequest;
  messages: PendingApprovalMessage[];
  timeoutId: NodeJS.Timeout;
};

export type ZulipExecApprovalHandlerOpts = {
  client: ZulipClient;
  accountId: string;
  config: ZulipExecApprovalConfig;
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  gatewayUrl?: string;
  widgetsEnabled?: boolean;
};

export type ZulipExecApprovalCallbackResult = {
  handled: boolean;
  consume: boolean;
};

function encodeCallbackValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCallbackValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildZulipExecApprovalCallbackData(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  return `${ZULIP_EXEC_APPROVAL_CALLBACK_PREFIX}${encodeCallbackValue(approvalId)}:${action}`;
}

export function parseZulipExecApprovalCallbackData(
  callbackData?: string | null,
): { approvalId: string; action: ExecApprovalDecision } | null {
  const raw = callbackData?.trim();
  if (!raw || !raw.startsWith(ZULIP_EXEC_APPROVAL_CALLBACK_PREFIX)) {
    return null;
  }
  const rest = raw.slice(ZULIP_EXEC_APPROVAL_CALLBACK_PREFIX.length);
  const splitAt = rest.lastIndexOf(":");
  if (splitAt <= 0) {
    return null;
  }
  const approvalId = decodeCallbackValue(rest.slice(0, splitAt));
  const action = rest.slice(splitAt + 1) as ExecApprovalDecision;
  if (action !== "allow-once" && action !== "allow-always" && action !== "deny") {
    return null;
  }
  return { approvalId, action };
}

function normalizeApproverUserIds(approvers?: Array<string | number>): number[] {
  const ids = new Set<number>();
  for (const approver of approvers ?? []) {
    const raw = typeof approver === "number" ? approver : Number.parseInt(String(approver), 10);
    if (Number.isFinite(raw) && raw > 0) {
      ids.add(raw);
    }
  }
  return [...ids];
}

async function resolveApproverUserIds(params: {
  client: ZulipClient;
  approvers?: Array<string | number>;
}): Promise<number[]> {
  const numeric = normalizeApproverUserIds(params.approvers);
  const pending = (params.approvers ?? []).filter((entry) => {
    const trimmed = String(entry).trim();
    return trimmed && !/^\d+$/.test(trimmed);
  });
  if (pending.length === 0) {
    return numeric;
  }
  const resolutions = await resolveZulipUserInputs({
    client: params.client,
    inputs: pending,
  });
  for (const resolved of resolutions) {
    const userId = resolved.id ? Number.parseInt(resolved.id, 10) : NaN;
    if (resolved.resolved && Number.isFinite(userId) && userId > 0) {
      numeric.push(userId);
    }
  }
  return [...new Set(numeric)];
}

function formatApprovalCommand(
  command: string,
  maxChars: number,
): { inline: boolean; text: string } {
  const trimmed = command.length > maxChars ? `${command.slice(0, maxChars)}...` : command;
  if (!trimmed.includes("\n") && !trimmed.includes("`")) {
    return { inline: true, text: `\`${trimmed}\`` };
  }
  let fence = "```";
  while (trimmed.includes(fence)) {
    fence += "`";
  }
  return { inline: false, text: `${fence}\n${trimmed}\n${fence}` };
}

function buildMetadataLines(request: ExecApprovalRequest): string[] {
  const lines: string[] = [];
  if (request.request.cwd) {
    lines.push(`- CWD: ${request.request.cwd}`);
  }
  if (request.request.nodeId) {
    lines.push(`- Node: ${request.request.nodeId}`);
  }
  if (request.request.host) {
    lines.push(`- Host: ${request.request.host}`);
  }
  if (request.request.agentId) {
    lines.push(`- Agent: ${request.request.agentId}`);
  }
  if (request.request.security) {
    lines.push(`- Security: ${request.request.security}`);
  }
  if (request.request.ask) {
    lines.push(`- Ask: ${request.request.ask}`);
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    lines.push(`- Env overrides: ${request.request.envKeys.join(", ")}`);
  }
  return lines;
}

function buildRequestMessage(params: {
  request: ExecApprovalRequest;
  includeReplyInstructions: boolean;
}): string {
  const command = formatApprovalCommand(params.request.request.command, 1000);
  const lines: string[] = [
    "### 🔒 Exec approval required",
    `ID: ${params.request.id}`,
    command.inline ? `Command: ${command.text}` : `Command:\n${command.text}`,
    ...buildMetadataLines(params.request),
    `Expires in: ${Math.max(0, Math.round((params.request.expiresAtMs - Date.now()) / 1000))}s`,
  ];
  lines.push(
    params.includeReplyInstructions
      ? "Reply with: `/approve <id> allow-once|allow-always|deny`"
      : "Use the buttons below to approve or deny.",
  );
  return lines.join("\n");
}

function decisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "Allowed (once)";
  }
  if (decision === "allow-always") {
    return "Allowed (always)";
  }
  return "Denied";
}

function buildResolvedMessage(params: {
  request: ExecApprovalRequest;
  resolved: ExecApprovalResolved;
  cleanupAfterResolve?: boolean;
}): string {
  const by = params.resolved.resolvedBy ? ` Resolved by ${params.resolved.resolvedBy}.` : "";
  if (params.cleanupAfterResolve) {
    return `✅ Exec approval ${decisionLabel(params.resolved.decision)}.${by} ID: ${params.request.id}`;
  }
  const command = formatApprovalCommand(params.request.request.command, 500);
  return [
    `### ✅ Exec approval: ${decisionLabel(params.resolved.decision)}`,
    by.trim() || "Resolved.",
    command.inline ? `Command: ${command.text}` : `Command:\n${command.text}`,
    `ID: ${params.request.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildExpiredMessage(params: {
  request: ExecApprovalRequest;
  cleanupAfterResolve?: boolean;
}): string {
  if (params.cleanupAfterResolve) {
    return `⏱️ Exec approval expired. ID: ${params.request.id}`;
  }
  const command = formatApprovalCommand(params.request.request.command, 500);
  return [
    "### ⏱️ Exec approval expired",
    command.inline ? `Command: ${command.text}` : `Command:\n${command.text}`,
    `ID: ${params.request.id}`,
  ].join("\n");
}

function buildSyntheticSessionKey(request: ExecApprovalRequest): string {
  const agentId = request.request.agentId?.trim() || DEFAULT_APPROVAL_AGENT_ID;
  return `agent:${agentId}:zulip:exec-approval:${request.id}`;
}

function resolveZulipSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): { to: string; accountId?: string } | null {
  const turnSourceChannel = normalizeMessageChannel(params.request.request.turnSourceChannel);
  const turnSourceTo = params.request.request.turnSourceTo?.trim() || undefined;
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || undefined;

  if (turnSourceChannel === "zulip" && turnSourceTo) {
    return { to: turnSourceTo, accountId: turnSourceAccountId };
  }

  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }

  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const target = resolveSessionDeliveryTarget({
      entry,
      requestedChannel: "last",
      turnSourceChannel: turnSourceChannel === "zulip" ? "zulip" : undefined,
      turnSourceTo: turnSourceChannel === "zulip" ? turnSourceTo : undefined,
      turnSourceAccountId: turnSourceChannel === "zulip" ? turnSourceAccountId : undefined,
      turnSourceThreadId:
        turnSourceChannel === "zulip"
          ? (params.request.request.turnSourceThreadId ?? undefined)
          : undefined,
    });
    if (target.channel && target.channel !== "zulip") {
      return null;
    }
    if (!target.to?.trim()) {
      return null;
    }
    return {
      to: target.to.trim(),
      accountId: target.accountId?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

function resolveZulipApprovalAccountId(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): string | null {
  const sessionTarget = resolveZulipSessionTarget(params);
  return sessionTarget?.accountId?.trim() || null;
}

function resolveConfiguredApprovalStreamTarget(config: ZulipExecApprovalConfig): string | null {
  const stream = config.stream?.trim();
  if (!stream) {
    return null;
  }
  const topic = config.topic?.trim() || DEFAULT_STREAM_TOPIC;
  return `stream:${stream}:topic:${topic}`;
}

export class ZulipExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private opts: ZulipExecApprovalHandlerOpts;
  private started = false;
  private approverUserIds: number[] = [];

  constructor(opts: ZulipExecApprovalHandlerOpts) {
    this.opts = opts;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    const config = this.opts.config;
    if (!config.enabled) {
      return false;
    }
    if (this.getApproverUserIds().length === 0) {
      return false;
    }

    const requestAccountId = resolveZulipApprovalAccountId({
      cfg: this.opts.cfg,
      request,
    });
    if (requestAccountId) {
      if (normalizeAccountId(requestAccountId) !== normalizeAccountId(this.opts.accountId)) {
        return false;
      }
    }

    if (config.agentFilter?.length) {
      if (!request.request.agentId || !config.agentFilter.includes(request.request.agentId)) {
        return false;
      }
    }

    if (config.sessionFilter?.length) {
      const session = request.request.sessionKey;
      if (!session) {
        return false;
      }
      const matches = config.sessionFilter.some((pattern) => {
        if (session.includes(pattern)) {
          return true;
        }
        const regex = compileSafeRegex(pattern);
        return regex ? testRegexWithBoundedInput(regex, session) : false;
      });
      if (!matches) {
        return false;
      }
    }

    return true;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!this.opts.config.enabled) {
      this.opts.runtime?.log?.("zulip exec approvals: disabled");
      return;
    }

    this.approverUserIds = await resolveApproverUserIds({
      client: this.opts.client,
      approvers: this.opts.config.approvers,
    }).catch((error) => {
      this.opts.runtime?.error?.(
        `zulip exec approvals: approver resolution failed: ${String(error)}`,
      );
      return normalizeApproverUserIds(this.opts.config.approvers);
    });

    if (this.getApproverUserIds().length === 0) {
      this.opts.runtime?.log?.("zulip exec approvals: no approver user IDs resolved");
      return;
    }

    const { url: gatewayUrl, urlSource } = buildGatewayConnectionDetails({
      config: this.opts.cfg,
      url: this.opts.gatewayUrl,
    });
    const gatewayUrlOverrideSource =
      urlSource === "cli --url"
        ? "cli"
        : urlSource === "env OPENCLAW_GATEWAY_URL"
          ? "env"
          : undefined;
    const auth = await resolveGatewayConnectionAuth({
      config: this.opts.cfg,
      env: process.env,
      urlOverride: gatewayUrlOverrideSource ? gatewayUrl : undefined,
      urlOverrideSource: gatewayUrlOverrideSource,
    });

    this.gatewayClient = new GatewayClient({
      url: gatewayUrl,
      token: auth.token,
      password: auth.password,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Zulip Exec Approvals",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onHelloOk: () => {
        this.opts.runtime?.log?.("zulip exec approvals: connected to gateway");
      },
      onConnectError: (err) => {
        this.opts.runtime?.error?.(`zulip exec approvals: connect error: ${err.message}`);
      },
      onClose: (code, reason) => {
        this.opts.runtime?.log?.(`zulip exec approvals: gateway closed: ${code} ${reason}`);
      },
    });

    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.approverUserIds = [];
    this.gatewayClient?.stop();
    this.gatewayClient = null;
  }

  getApproverUserIds(): number[] {
    return this.approverUserIds.length > 0
      ? [...this.approverUserIds]
      : normalizeApproverUserIds(this.opts.config.approvers);
  }

  canResolveUser(userId: number): boolean {
    return this.getApproverUserIds().includes(userId);
  }

  async handleCallback(params: {
    callbackData?: string | null;
    senderId: number;
  }): Promise<ZulipExecApprovalCallbackResult> {
    const parsed = parseZulipExecApprovalCallbackData(params.callbackData);
    if (!parsed) {
      return { handled: false, consume: false };
    }
    if (!this.canResolveUser(params.senderId)) {
      this.opts.runtime?.log?.(
        `zulip exec approvals: unauthorized approval click from ${params.senderId} for ${parsed.approvalId}`,
      );
      return { handled: true, consume: false };
    }
    await this.resolveApproval(parsed.approvalId, parsed.action);
    return { handled: true, consume: true };
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      void this.handleApprovalRequested(evt.payload as ExecApprovalRequest);
    } else if (evt.event === "exec.approval.resolved") {
      void this.handleApprovalResolved(evt.payload as ExecApprovalResolved);
    }
  }

  private async handleApprovalRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) {
      return;
    }

    const existing = this.pending.get(request.id);
    if (existing) {
      clearTimeout(existing.timeoutId);
      this.pending.delete(request.id);
    }

    const approverUserIds = this.getApproverUserIds();
    const targetMode = this.opts.config.target ?? DEFAULT_TARGET;
    const sendToSession = targetMode === "session" || targetMode === "both";
    const sendToDm = targetMode === "dm" || targetMode === "both";
    const sendToConfiguredStream = targetMode === "stream";
    let fallbackToDm = false;
    const messages: PendingApprovalMessage[] = [];

    if (sendToConfiguredStream) {
      const configuredTarget = resolveConfiguredApprovalStreamTarget(this.opts.config);
      if (configuredTarget) {
        const sent = await this.sendApprovalPrompt({
          request,
          to: configuredTarget,
          allowedUsers: approverUserIds,
        });
        if (sent) {
          messages.push(sent);
        }
      } else {
        this.opts.runtime?.error?.(
          'zulip exec approvals: target="stream" configured without execApprovals.stream',
        );
      }
    }

    if (sendToSession) {
      const sessionTarget = resolveZulipSessionTarget({ cfg: this.opts.cfg, request });
      if (
        sessionTarget?.to &&
        (!sessionTarget.accountId ||
          normalizeAccountId(sessionTarget.accountId) === normalizeAccountId(this.opts.accountId))
      ) {
        const sent = await this.sendApprovalPrompt({
          request,
          to: sessionTarget.to,
          allowedUsers: approverUserIds,
        });
        if (sent) {
          messages.push(sent);
        }
      } else if (!sendToDm) {
        fallbackToDm = true;
      }
    }

    if (sendToDm || fallbackToDm) {
      for (const approverUserId of approverUserIds) {
        const sent = await this.sendApprovalPrompt({
          request,
          to: `dm:${approverUserId}`,
          allowedUsers: [approverUserId],
        });
        if (sent) {
          messages.push(sent);
        }
      }
    }

    if (messages.length === 0) {
      return;
    }

    const timeoutId = setTimeout(
      () => {
        void this.handleApprovalTimeout(request.id);
      },
      Math.max(0, request.expiresAtMs - Date.now()),
    );
    timeoutId.unref?.();

    this.pending.set(request.id, {
      request,
      messages,
      timeoutId,
    });
  }

  private async sendApprovalPrompt(params: {
    request: ExecApprovalRequest;
    to: string;
    allowedUsers: number[];
  }): Promise<PendingApprovalMessage | null> {
    try {
      const result = this.opts.widgetsEnabled
        ? await sendZulipComponentMessage(
            params.to,
            buildRequestMessage({ request: params.request, includeReplyInstructions: false }),
            {
              heading: "Exec Approval Required",
              buttons: [
                {
                  label: "Allow once",
                  style: "success",
                  callbackData: buildZulipExecApprovalCallbackData(params.request.id, "allow-once"),
                  allowedUsers: params.allowedUsers,
                },
                {
                  label: "Always allow",
                  style: "primary",
                  callbackData: buildZulipExecApprovalCallbackData(
                    params.request.id,
                    "allow-always",
                  ),
                  allowedUsers: params.allowedUsers,
                },
                {
                  label: "Deny",
                  style: "danger",
                  callbackData: buildZulipExecApprovalCallbackData(params.request.id, "deny"),
                  allowedUsers: params.allowedUsers,
                },
              ],
            },
            {
              cfg: this.opts.cfg,
              accountId: this.opts.accountId,
              sessionKey: buildSyntheticSessionKey(params.request),
              agentId: params.request.request.agentId?.trim() || DEFAULT_APPROVAL_AGENT_ID,
            },
          )
        : await sendMessageZulip(
            params.to,
            buildRequestMessage({ request: params.request, includeReplyInstructions: true }),
            {
              cfg: this.opts.cfg,
              accountId: this.opts.accountId,
            },
          );

      const messageId = Number.parseInt(result.messageId, 10);
      if (!Number.isFinite(messageId)) {
        return null;
      }
      return {
        messageId,
        target: result.target,
      };
    } catch (err) {
      this.opts.runtime?.error?.(
        `zulip exec approvals: failed to send approval prompt: ${String(err)}`,
      );
      return null;
    }
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    const pending = this.pending.get(resolved.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(resolved.id);

    const content = buildResolvedMessage({
      request: pending.request,
      resolved,
      cleanupAfterResolve: this.opts.config.cleanupAfterResolve,
    });
    await Promise.allSettled(
      pending.messages.map((message) =>
        this.updateApprovalMessage(message.messageId, content, resolved.id),
      ),
    );
  }

  private async handleApprovalTimeout(approvalId: string): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(approvalId);

    const content = buildExpiredMessage({
      request: pending.request,
      cleanupAfterResolve: this.opts.config.cleanupAfterResolve,
    });
    await Promise.allSettled(
      pending.messages.map((message) =>
        this.updateApprovalMessage(message.messageId, content, approvalId),
      ),
    );
  }

  private async updateApprovalMessage(
    messageId: number,
    content: string,
    approvalId: string,
  ): Promise<void> {
    try {
      await updateZulipMessage(this.opts.client, { messageId, content });
    } catch (err) {
      this.opts.runtime?.error?.(
        `zulip exec approvals: failed to update message ${messageId} for ${approvalId}: ${String(err)}`,
      );
    }
  }

  async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    if (!this.gatewayClient) {
      this.opts.runtime?.error?.("zulip exec approvals: gateway client not connected");
      return false;
    }
    try {
      await this.gatewayClient.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      return true;
    } catch (err) {
      this.opts.runtime?.error?.(`zulip exec approvals: resolve failed: ${String(err)}`);
      return false;
    }
  }
}

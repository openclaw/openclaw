import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "../../infra/outbound/payloads.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import type { RuntimeEnv } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;
type StatusTagName =
  | "STOP"
  | "WORKING"
  | "WAITING"
  | "CHECKING"
  | "LEARNING"
  | "FIXING"
  | "COMPLETE"
  | "BLOCKED";
type AgentDeliveryResult = RunResult & {
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
};
type DeliveryTaskContext = {
  taskId?: string;
  paperclipIssueId?: string;
  receiptId?: string;
  headlineLabel?: "Task" | "Goal" | "Topic";
  headline?: string;
};

const NESTED_LOG_PREFIX = "[agent:nested]";
const TERMINAL_STATUS_TAG_RE =
  /^\[(STOP|WORKING|WAITING|CHECKING|LEARNING|FIXING|COMPLETE|BLOCKED)\]:\s*(.+)$/;

function extractLastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

function hasTerminalStatusTag(text: string | undefined): boolean {
  if (typeof text !== "string") {
    return false;
  }
  const lastLine = extractLastNonEmptyLine(text);
  if (!lastLine) {
    return false;
  }
  const normalized =
    lastLine.startsWith("`") && lastLine.endsWith("`") && lastLine.length > 2
      ? lastLine.slice(1, -1).trim()
      : lastLine;
  return TERMINAL_STATUS_TAG_RE.test(normalized);
}

function formatStatusTagLine(tag: StatusTagName, reason: string): string {
  return `\`[${tag}]: ${reason.trim()}\``;
}

function normalizeInlineCodeValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function formatStructuredFieldLine(label: string, value: string | undefined): string | undefined {
  const normalized = normalizeInlineCodeValue(value);
  return normalized ? `\`${label}\`: \`${normalized}\`` : undefined;
}

function resolveDeliveryTaskContext(opts: AgentCommandOpts): DeliveryTaskContext {
  const headline =
    normalizeInlineCodeValue(opts.currentGoal) ??
    normalizeInlineCodeValue(opts.intentSummary) ??
    normalizeInlineCodeValue(opts.successCriteria) ??
    normalizeInlineCodeValue(opts.message);
  return {
    taskId: normalizeInlineCodeValue(opts.chiefTaskId),
    paperclipIssueId: normalizeInlineCodeValue(opts.paperclipIssueId),
    receiptId: normalizeInlineCodeValue(opts.inboundReceiptId),
    headlineLabel: opts.currentGoal ? "Goal" : opts.intentSummary || opts.successCriteria ? "Task" : "Topic",
    headline,
  };
}

function isTelegramDeliveryTarget(opts: AgentCommandOpts, deliveryChannel?: string): boolean {
  const candidates = [
    deliveryChannel,
    opts.replyChannel,
    opts.channel,
    opts.messageChannel,
    opts.runContext?.messageChannel,
  ]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter(Boolean);
  return candidates.includes("telegram");
}

function buildTelegramTaskContextLines(opts: AgentCommandOpts): string[] {
  const context = resolveDeliveryTaskContext(opts);
  return [
    formatStructuredFieldLine("Task ID", context.taskId),
    formatStructuredFieldLine("Paperclip issue", context.paperclipIssueId),
    formatStructuredFieldLine("Receipt ID", context.receiptId),
    context.headlineLabel && context.headline
      ? formatStructuredFieldLine(context.headlineLabel, context.headline)
      : undefined,
  ].filter((value): value is string => Boolean(value));
}

function ensureTelegramStructuredContext(params: {
  payloads: ReplyPayload[];
  opts: AgentCommandOpts;
  deliveryChannel?: string;
}): ReplyPayload[] {
  if (!isTelegramDeliveryTarget(params.opts, params.deliveryChannel)) {
    return params.payloads;
  }
  const contextLines = buildTelegramTaskContextLines(params.opts);
  if (contextLines.length === 0) {
    return params.payloads;
  }
  const payloads = [...params.payloads];
  const firstTextIndex = payloads.findIndex((payload) => typeof payload.text === "string");
  if (firstTextIndex < 0) {
    return payloads;
  }
  const firstPayload = payloads[firstTextIndex]!;
  const text = firstPayload.text ?? "";
  if (text.includes("`Task ID`") || text.includes("`Goal`") || text.includes("`Task`") || text.includes("`Topic`")) {
    return payloads;
  }
  payloads[firstTextIndex] = {
    ...firstPayload,
    text: [...contextLines, text.trim()].filter(Boolean).join("\n"),
  };
  return payloads;
}

function classifyTerminalPayloadState(payloads: ReplyPayload[]): "waiting" | "blocked" | "complete" {
  const preview = payloads
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (
    /\b(awaiting input|need more info|need more information|need clarification|please provide|can you clarify|could you clarify)\b/i.test(
      preview,
    ) ||
    /\[\[?waiting\]?\]\s*:/i.test(preview)
  ) {
    return "waiting";
  }
  if (
    /\b(blocked|cannot proceed|can't proceed|awaiting approval|dependency|missing permission)\b/i.test(
      preview,
    ) ||
    /\[\[?blocked\]?\]\s*:/i.test(preview)
  ) {
    return "blocked";
  }
  return "complete";
}

function buildTerminalStatus(params: {
  result: AgentDeliveryResult;
  payloads: ReplyPayload[];
}): { tag: StatusTagName; reason: string } {
  const stopReason =
    typeof params.result.meta?.stopReason === "string" ? params.result.meta.stopReason : undefined;
  const durationMs =
    typeof params.result.meta?.durationMs === "number" ? params.result.meta.durationMs : undefined;
  const hasErrorPayload = params.payloads.some((payload) => payload.isError === true);
  if (stopReason === "tool_calls" || stopReason === "toolUse") {
    return {
      tag: "WORKING",
      reason: "đang xử lý, dự kiến cần hơn 60 giây vì model/tool vẫn đang chạy",
    };
  }
  if (stopReason === "length" || stopReason === "max_tokens") {
    return {
      tag: "STOP",
      reason: "đã dừng do chạm giới hạn token",
    };
  }
  if (hasErrorPayload || params.result.meta?.error || params.result.meta?.aborted) {
    return {
      tag: "STOP",
      reason: stopReason ? `đã dừng với trạng thái ${stopReason}` : "đã dừng do lỗi trong lúc xử lý",
    };
  }
  const payloadState = classifyTerminalPayloadState(params.payloads);
  if (payloadState === "waiting") {
    return {
      tag: "WAITING",
      reason: "đang chờ thêm thông tin hoặc xác nhận để tiếp tục",
    };
  }
  if (payloadState === "blocked") {
    return {
      tag: "BLOCKED",
      reason: "đang bị chặn bởi phụ thuộc hoặc cần can thiệp thủ công",
    };
  }
  if (typeof durationMs === "number" && durationMs >= 60_000) {
    return {
      tag: "COMPLETE",
      reason: `đã hoàn tất sau ${Math.max(1, Math.round(durationMs / 1_000))} giây xử lý`,
    };
  }
  return {
    tag: "COMPLETE",
    reason: "đã hoàn tất tác vụ hiện tại",
  };
}

function buildNoReplyFallbackPayload(
  result: AgentDeliveryResult,
  opts: AgentCommandOpts,
  deliveryChannel?: string,
): ReplyPayload {
  const stopReason =
    typeof result.meta?.stopReason === "string" ? result.meta.stopReason : undefined;
  const durationMs =
    typeof result.meta?.durationMs === "number" ? result.meta.durationMs : undefined;
  if (stopReason === "tool_calls" || stopReason === "toolUse") {
    const reason = "đang xử lý, dự kiến cần hơn 60 giây vì model/tool vẫn đang chạy";
    const payload: ReplyPayload = {
      text: [
        "Đang xử lý. Chief sẽ gửi cập nhật an toàn ngay khi có trạng thái phù hợp để báo ra ngoài.",
        formatStructuredFieldLine("Reason", reason),
        formatStructuredFieldLine(
          "Next",
          "Tiếp tục theo dõi run hiện tại và gửi heartbeat hoặc kết quả cuối ngay khi sẵn sàng",
        ),
        formatStatusTagLine("WORKING", reason),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n"),
    };
    return ensureTelegramStructuredContext({
      payloads: [payload],
      opts,
      deliveryChannel,
    })[0]!;
  }
  if (result.meta?.error || result.meta?.aborted) {
    const payload: ReplyPayload = {
      text: [
        "Lần chạy vừa kết thúc nhưng chưa có cập nhật cuối cùng sẵn sàng để gửi.",
        formatStructuredFieldLine(
          "Reason",
          "Lần chạy gặp lỗi trước khi tạo được phản hồi cuối có thể gửi cho user",
        ),
        formatStructuredFieldLine(
          "Next",
          "Tổng hợp lại trạng thái an toàn hoặc khởi tạo nhánh recovery nếu cần",
        ),
        formatStatusTagLine("STOP", "chưa có cập nhật cuối cùng sẵn sàng để gửi do lần chạy gặp lỗi"),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n"),
      isError: true,
    };
    return ensureTelegramStructuredContext({
      payloads: [payload],
      opts,
      deliveryChannel,
    })[0]!;
  }
  if (typeof durationMs === "number" && durationMs >= 60_000) {
    const payload: ReplyPayload = {
      text: [
        "Lần chạy đã kết thúc nhưng chưa tạo được cập nhật cuối cùng sẵn sàng để gửi.",
        formatStructuredFieldLine("Reason", "Run kết thúc nhưng không sinh được phản hồi cuối có thể giao ra ngoài"),
        formatStructuredFieldLine(
          "Next",
          "Tổng hợp lại tiến độ, blocker, và hành động tiếp theo trước khi gửi tin kế tiếp",
        ),
        formatStatusTagLine("STOP", "chưa có cập nhật cuối cùng sẵn sàng để gửi"),
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n"),
      isError: true,
    };
    return ensureTelegramStructuredContext({
      payloads: [payload],
      opts,
      deliveryChannel,
    })[0]!;
  }
  const payload: ReplyPayload = {
    text: [
      "Lần chạy đã kết thúc nhưng chưa có cập nhật cuối cùng sẵn sàng để gửi.",
      formatStructuredFieldLine("Reason", "Chưa có phản hồi cuối cùng đủ an toàn để phát ra ngoài"),
      formatStructuredFieldLine(
        "Next",
        "Tổng hợp lại trạng thái hiện tại và gửi terminal summary hoặc recovery update",
      ),
      formatStatusTagLine("STOP", "chưa có cập nhật cuối cùng sẵn sàng để gửi"),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n"),
    isError: true,
  };
  return ensureTelegramStructuredContext({
    payloads: [payload],
    opts,
    deliveryChannel,
  })[0]!;
}

function ensureTerminalStatusPayloads(params: {
  payloads: ReplyPayload[];
  result: AgentDeliveryResult;
  opts: AgentCommandOpts;
  deliveryChannel?: string;
}): ReplyPayload[] {
  const status = buildTerminalStatus(params);
  const statusLine = formatStatusTagLine(status.tag, status.reason);
  const payloads = ensureTelegramStructuredContext({
    payloads:
      params.payloads.length > 0
        ? [...params.payloads]
        : [buildNoReplyFallbackPayload(params.result, params.opts, params.deliveryChannel)],
    opts: params.opts,
    deliveryChannel: params.deliveryChannel,
  });
  const lastTextIndex = (() => {
    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      if (typeof payloads[index]?.text === "string") {
        return index;
      }
    }
    return -1;
  })();

  if (lastTextIndex >= 0) {
    const lastPayload = payloads[lastTextIndex]!;
    if (hasTerminalStatusTag(lastPayload.text)) {
      return payloads;
    }
    payloads[lastTextIndex] = {
      ...lastPayload,
      text: [lastPayload.text?.trimEnd() ?? "", statusLine].filter(Boolean).join("\n\n"),
    };
    return payloads;
  }

  payloads.push({ text: statusLine });
  return payloads;
}

function formatNestedLogPrefix(opts: AgentCommandOpts, sessionKey?: string): string {
  const parts = [NESTED_LOG_PREFIX];
  const session = sessionKey ?? opts.sessionKey ?? opts.sessionId;
  if (session) {
    parts.push(`session=${session}`);
  }
  if (opts.runId) {
    parts.push(`run=${opts.runId}`);
  }
  const channel = opts.messageChannel ?? opts.channel;
  if (channel) {
    parts.push(`channel=${channel}`);
  }
  if (opts.to) {
    parts.push(`to=${opts.to}`);
  }
  if (opts.accountId) {
    parts.push(`account=${opts.accountId}`);
  }
  return parts.join(" ");
}

function logNestedOutput(
  runtime: RuntimeEnv,
  opts: AgentCommandOpts,
  output: string,
  sessionKey?: string,
) {
  const prefix = formatNestedLogPrefix(opts, sessionKey);
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    runtime.log(`${prefix} ${line}`);
  }
}

export function normalizeAgentCommandReplyPayloads(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  payloads: RunResult["payloads"];
  result: RunResult;
  deliveryChannel?: string;
  accountId?: string;
  applyChannelTransforms?: boolean;
}): ReplyPayload[] {
  const payloads = params.payloads ?? [];
  if (payloads.length === 0) {
    return [];
  }
  const channel =
    params.deliveryChannel && !isInternalMessageChannel(params.deliveryChannel)
      ? (normalizeChannelId(params.deliveryChannel) ?? params.deliveryChannel)
      : undefined;
  if (!channel) {
    return payloads as ReplyPayload[];
  }

  const sessionKey = params.outboundSession?.key ?? params.opts.sessionKey;
  const agentId =
    params.outboundSession?.agentId ??
    resolveSessionAgentId({
      sessionKey,
      config: params.cfg,
    });
  const replyPrefix = createReplyPrefixContext({
    cfg: params.cfg,
    agentId,
    channel,
    accountId: params.accountId,
  });
  const modelUsed = params.result.meta.agentMeta?.model;
  const providerUsed = params.result.meta.agentMeta?.provider;
  if (providerUsed && modelUsed) {
    replyPrefix.onModelSelected({
      provider: providerUsed,
      model: modelUsed,
      thinkLevel: undefined,
    });
  }
  const responsePrefixContext = replyPrefix.responsePrefixContextProvider();
  const applyChannelTransforms = params.applyChannelTransforms ?? true;

  const normalizedPayloads: ReplyPayload[] = [];
  for (const payload of payloads) {
    const normalized = normalizeReplyPayload(payload as ReplyPayload, {
      responsePrefix: replyPrefix.responsePrefix,
      enableSlackInteractiveReplies: replyPrefix.enableSlackInteractiveReplies,
      applyChannelTransforms,
      responsePrefixContext,
    });
    if (normalized) {
      normalizedPayloads.push(normalized);
    }
  }
  return normalizedPayloads;
}

export async function deliverAgentCommandResult(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: RunResult["payloads"];
}) {
  const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
  const deliveryResult = result as AgentDeliveryResult;
  const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
  const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
  const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
  const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: deliver,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId,
  });
  let deliveryChannel = deliveryPlan.resolvedChannel;
  const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
  if (deliver && isInternalMessageChannel(deliveryChannel) && !explicitChannelHint) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      deliveryChannel = selection.channel;
    } catch {
      // Keep the internal channel marker; error handling below reports the failure.
    }
  }
  const effectiveDeliveryPlan =
    deliveryChannel === deliveryPlan.resolvedChannel
      ? deliveryPlan
      : {
          ...deliveryPlan,
          resolvedChannel: deliveryChannel,
        };
  // Channel docking: delivery channels are resolved via plugin registry.
  const deliveryPlugin = !isInternalMessageChannel(deliveryChannel)
    ? getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel)
    : undefined;

  const isDeliveryChannelKnown =
    isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);

  const targetMode =
    opts.deliveryTargetMode ??
    effectiveDeliveryPlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedAccountId = effectiveDeliveryPlan.resolvedAccountId;
  const resolved =
    deliver && isDeliveryChannelKnown && deliveryChannel
      ? resolveAgentOutboundTarget({
          cfg,
          plan: effectiveDeliveryPlan,
          targetMode,
          validateExplicitTarget: true,
        })
      : {
          resolvedTarget: null,
          resolvedTo: effectiveDeliveryPlan.resolvedTo,
          targetMode,
        };
  const resolvedTarget = resolved.resolvedTarget;
  const deliveryTarget = resolved.resolvedTo;
  const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
  const resolvedReplyToId =
    deliveryChannel === "slack" && resolvedThreadId != null ? String(resolvedThreadId) : undefined;
  const resolvedThreadTarget = deliveryChannel === "slack" ? undefined : resolvedThreadId;

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  };

  if (deliver) {
    if (isInternalMessageChannel(deliveryChannel)) {
      const err = new Error(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      );
      if (!bestEffortDeliver) {
        throw err;
      }
      logDeliveryError(err);
    } else if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      if (!bestEffortDeliver) {
        throw err;
      }
      logDeliveryError(err);
    } else if (resolvedTarget && !resolvedTarget.ok) {
      if (!bestEffortDeliver) {
        throw resolvedTarget.error;
      }
      logDeliveryError(resolvedTarget.error);
    }
  }

  if (
    (!payloads || payloads.length === 0) &&
    (deliveryResult.didSendViaMessagingTool === true ||
      deliveryResult.didSendDeterministicApprovalPrompt === true)
  ) {
    runtime.log(
      deliveryResult.didSendViaMessagingTool === true
        ? "Reply already delivered by messaging tool."
        : "Approval prompt already delivered.",
    );
    return { payloads: [], meta: result.meta, deliveryConfirmed: true };
  }

  const normalizedReplyPayloads = normalizeAgentCommandReplyPayloads({
    cfg,
    opts,
    outboundSession,
    payloads,
    result,
    deliveryChannel,
    accountId: resolvedAccountId,
    applyChannelTransforms: deliver,
  });
  const effectiveReplyPayloads = ensureTerminalStatusPayloads({
    payloads: normalizedReplyPayloads,
    result: deliveryResult,
    opts,
    deliveryChannel,
  });
  const normalizedPayloads = normalizeOutboundPayloadsForJson(effectiveReplyPayloads);
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          payloads: normalizedPayloads,
          meta: result.meta,
        }),
        null,
        2,
      ),
    );
    if (!deliver) {
      return { payloads: normalizedPayloads, meta: result.meta, deliveryConfirmed: true };
    }
  }
  const deliveryPayloads = normalizeOutboundPayloads(effectiveReplyPayloads);
  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) {
      return;
    }
    const output = formatOutboundPayloadLog(payload);
    if (!output) {
      return;
    }
    if (opts.lane === AGENT_LANE_NESTED) {
      logNestedOutput(runtime, opts, output, effectiveSessionKey);
      return;
    }
    runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) {
      logPayload(payload);
    }
    return { payloads: normalizedPayloads, meta: result.meta, deliveryConfirmed: deliveryPayloads.length > 0 };
  }
  if (deliver && deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
    if (deliveryTarget) {
      await deliverOutboundPayloads({
        cfg,
        channel: deliveryChannel,
        to: deliveryTarget,
        accountId: resolvedAccountId,
        payloads: deliveryPayloads,
        session: outboundSession,
        replyToId: resolvedReplyToId ?? null,
        threadId: resolvedThreadTarget ?? null,
        bestEffort: bestEffortDeliver,
        onError: (err) => logDeliveryError(err),
        onPayload: logPayload,
        deps: createOutboundSendDeps(deps),
      });
    }
  }

  return {
    payloads: normalizedPayloads,
    meta: result.meta,
    deliveryConfirmed: deliveryPayloads.length > 0,
  };
}

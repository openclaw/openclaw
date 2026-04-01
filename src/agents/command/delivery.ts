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

function buildTerminalStatusAscii(params: {
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
      reason: "waiting for tool or continuation to finish",
    };
  }
  if (stopReason === "length" || stopReason === "max_tokens") {
    return {
      tag: "STOP",
      reason: "stopped after hitting the token limit",
    };
  }
  if (hasErrorPayload || params.result.meta?.error || params.result.meta?.aborted) {
    return {
      tag: "STOP",
      reason: stopReason ? `run stopped with status ${stopReason}` : "run stopped because of an error",
    };
  }
  const payloadState = classifyTerminalPayloadState(params.payloads);
  if (payloadState === "waiting") {
    return {
      tag: "WAITING",
      reason: "waiting for required input before work can continue",
    };
  }
  if (payloadState === "blocked") {
    return {
      tag: "BLOCKED",
      reason: "work is blocked pending a dependency or manual intervention",
    };
  }
  if (typeof durationMs === "number" && durationMs >= 60_000) {
    return {
      tag: "COMPLETE",
      reason: `completed after ${Math.max(1, Math.round(durationMs / 1_000))}s of processing`,
    };
  }
  return {
    tag: "COMPLETE",
    reason: "finished the current task",
  };
}

function buildTerminalStatus(params: {
  result: AgentDeliveryResult;
  payloads: ReplyPayload[];
}): { tag: StatusTagName; reason: string } {
  return buildTerminalStatusAscii(params);
  const stopReason =
    typeof params.result.meta?.stopReason === "string" ? params.result.meta.stopReason : undefined;
  const durationMs =
    typeof params.result.meta?.durationMs === "number" ? params.result.meta.durationMs : undefined;
  const hasErrorPayload = params.payloads.some((payload) => payload.isError === true);
  if (stopReason === "tool_calls" || stopReason === "toolUse") {
    return {
      tag: "WORKING",
      reason: "đang chờ tool hoặc continuation hoàn tất",
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
      reason: stopReason ? `run dừng với trạng thái ${stopReason}` : "run dừng do lỗi",
    };
  }
  if (typeof durationMs === "number" && durationMs >= 60_000) {
    return {
      tag: "STOP",
      reason: `đã hoàn tất sau ${Math.max(1, Math.round(durationMs / 1_000))}s xử lý`,
    };
  }
  return {
    tag: "STOP",
    reason: "đã xử lý xong task hiện tại",
  };
}

function buildNoReplyFallbackPayloadAscii(result: AgentDeliveryResult): ReplyPayload {
  const stopReason =
    typeof result.meta?.stopReason === "string" ? result.meta.stopReason : undefined;
  const durationMs =
    typeof result.meta?.durationMs === "number" ? result.meta.durationMs : undefined;
  if (stopReason === "tool_calls" || stopReason === "toolUse") {
    return {
      text: [
        "Still waiting for a tool or continuation to finish. No final reply is available yet.",
        formatStatusTagLine("WORKING", "waiting for tool or continuation to finish"),
      ].join("\n\n"),
    };
  }
  if (result.meta?.error || result.meta?.aborted) {
    return {
      text: [
        "The run ended with an error before it produced a final reply.",
        formatStatusTagLine("STOP", "run stopped because of an error before a final reply"),
      ].join("\n\n"),
      isError: true,
    };
  }
  if (typeof durationMs === "number" && durationMs >= 60_000) {
    return {
      text: [
        `The run finished after ${Math.max(1, Math.round(durationMs / 1_000))}s but did not produce a final reply.`,
        formatStatusTagLine(
          "STOP",
          `no final reply after ${Math.max(1, Math.round(durationMs / 1_000))}s of processing`,
        ),
      ].join("\n\n"),
      isError: true,
    };
  }
  return {
    text: [
      "The run finished but did not produce a final reply.",
      formatStatusTagLine("STOP", "no final reply was produced"),
    ].join("\n\n"),
    isError: true,
  };
}

function buildNoReplyFallbackPayload(result: AgentDeliveryResult): ReplyPayload {
  return buildNoReplyFallbackPayloadAscii(result);
  const stopReason =
    typeof result.meta?.stopReason === "string" ? result.meta.stopReason : undefined;
  const durationMs =
    typeof result.meta?.durationMs === "number" ? result.meta.durationMs : undefined;
  if (stopReason === "tool_calls" || stopReason === "toolUse") {
    return {
      text: [
        "Đang chờ tool hoặc continuation hoàn tất, chưa có phản hồi cuối cùng.",
        formatStatusTagLine("WORKING", "đang chờ tool hoặc continuation hoàn tất"),
      ].join("\n\n"),
    };
  }
  if (result.meta?.error || result.meta?.aborted) {
    return {
      text: [
        "Run kết thúc với lỗi trước khi tạo phản hồi cuối cùng.",
        formatStatusTagLine("STOP", "run dừng do lỗi trước khi tạo phản hồi cuối cùng"),
      ].join("\n\n"),
      isError: true,
    };
  }
  if (typeof durationMs === "number" && durationMs >= 60_000) {
    return {
      text: [
        `Run đã kết thúc sau ${Math.max(1, Math.round(durationMs / 1_000))}s nhưng không tạo phản hồi cuối cùng.`,
        formatStatusTagLine(
          "STOP",
          `không tạo phản hồi cuối cùng sau ${Math.max(1, Math.round(durationMs / 1_000))}s xử lý`,
        ),
      ].join("\n\n"),
      isError: true,
    };
  }
  return {
    text: [
      "Run đã kết thúc nhưng không tạo phản hồi cuối cùng.",
      formatStatusTagLine("STOP", "không tạo phản hồi cuối cùng"),
    ].join("\n\n"),
    isError: true,
  };
}

function ensureTerminalStatusPayloads(params: {
  payloads: ReplyPayload[];
  result: AgentDeliveryResult;
}): ReplyPayload[] {
  const status = buildTerminalStatus(params);
  const statusLine = formatStatusTagLine(status.tag, status.reason);
  const payloads =
    params.payloads.length > 0 ? [...params.payloads] : [buildNoReplyFallbackPayload(params.result)];
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

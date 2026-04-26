import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../../infra/outbound/envelope.js";
import {
  createOutboundPayloadPlan,
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  projectOutboundPayloadPlanForJson,
  projectOutboundPayloadPlanForOutbound,
} from "../../infra/outbound/payloads.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import type { RuntimeEnv } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { isNestedAgentLane } from "../lanes.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;

const NESTED_LOG_PREFIX = "[agent:nested]";

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

async function normalizeReplyMediaPathsForDelivery(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  sessionKey?: string;
  outboundSession: OutboundSessionContext | undefined;
  deliveryChannel: string;
  accountId?: string;
}): Promise<ReplyPayload[]> {
  if (params.payloads.length === 0) {
    return params.payloads;
  }
  const agentId =
    params.outboundSession?.agentId ??
    resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const workspaceDir = agentId ? resolveAgentWorkspaceDir(params.cfg, agentId) : undefined;
  if (!workspaceDir) {
    return params.payloads;
  }
  const normalizeMediaPaths = createReplyMediaPathNormalizer({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId,
    workspaceDir,
    messageProvider: params.deliveryChannel,
    accountId: params.accountId,
  });
  const result: ReplyPayload[] = [];
  for (const payload of params.payloads) {
    result.push(await normalizeMediaPaths(payload));
  }
  return result;
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
  const applyChannelTransforms = params.applyChannelTransforms ?? true;
  const deliveryPlugin = applyChannelTransforms ? getChannelPlugin(channel) : undefined;

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
  const transformReplyPayload = deliveryPlugin?.messaging?.transformReplyPayload
    ? (payload: ReplyPayload) =>
        deliveryPlugin.messaging?.transformReplyPayload?.({
          payload,
          cfg: params.cfg,
          accountId: params.accountId,
        }) ?? payload
    : undefined;

  const normalizedPayloads: ReplyPayload[] = [];
  for (const payload of payloads) {
    const normalized = normalizeReplyPayload(payload as ReplyPayload, {
      responsePrefix: replyPrefix.responsePrefix,
      applyChannelTransforms,
      responsePrefixContext,
      transformReplyPayload,
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
  const deliveryPlugin =
    deliver && !isInternalMessageChannel(deliveryChannel)
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
  const replyTransport =
    deliveryPlugin?.threading?.resolveReplyTransport?.({
      cfg,
      accountId: resolvedAccountId,
      threadId: resolvedThreadId,
    }) ?? null;
  const resolvedReplyToId = replyTransport?.replyToId ?? undefined;
  const resolvedThreadTarget =
    replyTransport && Object.hasOwn(replyTransport, "threadId")
      ? (replyTransport.threadId ?? null)
      : (resolvedThreadId ?? null);

  const logDeliveryError = (err: unknown) => {
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  };

  let hadPreflightError = false;
  if (deliver) {
    if (isInternalMessageChannel(deliveryChannel)) {
      const err = new Error(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      );
      if (!bestEffortDeliver) {
        throw err;
      }
      hadPreflightError = true;
      logDeliveryError(err);
    } else if (!isDeliveryChannelKnown) {
      const err = new Error(`Unknown channel: ${deliveryChannel}`);
      if (!bestEffortDeliver) {
        throw err;
      }
      hadPreflightError = true;
      logDeliveryError(err);
    } else if (resolvedTarget && !resolvedTarget.ok) {
      if (!bestEffortDeliver) {
        throw resolvedTarget.error;
      }
      hadPreflightError = true;
      logDeliveryError(resolvedTarget.error);
    }
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
  // Auto-reply-style media-path normalization must also run for the CLI
  // `--deliver` path. Without it, relative `MEDIA:./out/photo.png` tokens
  // reach the outbound loader unresolved and `assertLocalMediaAllowed` fails
  // with "Local media path is not under an allowed directory". Mirrors the
  // normalizer wiring in `src/auto-reply/reply/agent-runner.ts`.
  const mediaNormalizedReplyPayloads =
    deliver && !isInternalMessageChannel(deliveryChannel)
      ? await normalizeReplyMediaPathsForDelivery({
          cfg,
          payloads: normalizedReplyPayloads,
          sessionKey: effectiveSessionKey,
          outboundSession,
          deliveryChannel,
          accountId: resolvedAccountId,
        })
      : normalizedReplyPayloads;
  const outboundPayloadPlan = createOutboundPayloadPlan(mediaNormalizedReplyPayloads);
  const normalizedPayloads = projectOutboundPayloadPlanForJson(outboundPayloadPlan);
  // Only emit early JSON envelope when not delivering — the delivery path
  // emits its own envelope below with deliveryStatus attached (#57766).
  if (opts.json && !deliver) {
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
    return { payloads: normalizedPayloads, meta: result.meta };
  }

  if (!payloads || payloads.length === 0) {
    const noPayloadStatus = deliver
      ? {
          requested: true,
          attempted: false,
          succeeded: false,
          ...(hadPreflightError ? { error: true } : {}),
        }
      : undefined;
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            ...buildOutboundResultEnvelope({ payloads: [], meta: result.meta }),
            ...(noPayloadStatus ? { deliveryStatus: noPayloadStatus } : {}),
          },
          null,
          2,
        ),
      );
    } else {
      runtime.log("No reply from agent.");
    }
    return { payloads: [], meta: result.meta, deliveryStatus: noPayloadStatus };
  }

  const deliveryPayloads = projectOutboundPayloadPlanForOutbound(outboundPayloadPlan);
  const logPayload = (payload: NormalizedOutboundPayload) => {
    if (opts.json) {
      return;
    }
    const output = formatOutboundPayloadLog(payload);
    if (!output) {
      return;
    }
    if (isNestedAgentLane(opts.lane)) {
      logNestedOutput(runtime, opts, output, effectiveSessionKey);
      return;
    }
    runtime.log(output);
  };
  if (!deliver) {
    for (const payload of deliveryPayloads) {
      logPayload(payload);
    }
  }
  let deliveryAttempted = false;
  let deliverySucceeded = false;
  let deliveryThrewError = false;
  let hadPartialFailure = false;
  if (
    deliver &&
    deliveryChannel &&
    !isInternalMessageChannel(deliveryChannel) &&
    deliveryPayloads.length > 0
  ) {
    if (deliveryTarget) {
      deliveryAttempted = true;
      try {
        const results = await deliverOutboundPayloads({
          cfg,
          channel: deliveryChannel,
          to: deliveryTarget,
          accountId: resolvedAccountId,
          payloads: deliveryPayloads,
          session: outboundSession,
          replyToId: resolvedReplyToId ?? null,
          threadId: resolvedThreadTarget ?? null,
          bestEffort: bestEffortDeliver,
          onError: (err) => {
            hadPartialFailure = true;
            logDeliveryError(err);
          },
          onPayload: logPayload,
          deps: createOutboundSendDeps(deps),
        });
        // Note: zero results can mean either a real silent failure (e.g.
        // adapter returned []) or intentional hook cancellation (message_sending
        // hook returned cancel:true). We conservatively treat both as not-succeeded
        // since catching silent failures is this patch's primary goal. A future
        // change to deliverOutboundPayloads could expose cancellation metadata to
        // distinguish the two cases.
        deliverySucceeded = results.length > 0;
      } catch (err) {
        if (!bestEffortDeliver) {
          throw err;
        }
        deliveryThrewError = true;
        logDeliveryError(err);
      }
    }
  }

  // Log when delivery was requested but didn't succeed. This catches silent
  // failures caused by stale delivery context (e.g., after model fallback or
  // error recovery) where the response is written to the session transcript
  // but never actually sent to the external channel.
  if (deliver && deliveryPayloads.length > 0 && !deliverySucceeded && !opts.json) {
    const reason = !deliveryChannel
      ? "no delivery channel resolved"
      : isInternalMessageChannel(deliveryChannel)
        ? "channel resolved to internal"
        : !deliveryTarget
          ? "no delivery target resolved"
          : deliveryThrewError
            ? "delivery threw an error"
            : "delivery returned zero results";
    runtime.log(
      `[delivery] delivery requested but not completed: ${reason} ` +
        `(session=${effectiveSessionKey ?? "unknown"} channel=${deliveryChannel ?? "none"} ` +
        `target=${deliveryTarget ?? "none"} payloads=${deliveryPayloads.length})`,
    );
  }

  const deliveryStatusResult = deliver
    ? {
        requested: true,
        attempted: deliveryAttempted,
        succeeded: deliverySucceeded,
        ...(hadPartialFailure ? { hadPartialFailure: true } : {}),
        ...(deliveryThrewError || hadPreflightError ? { error: true } : {}),
      }
    : undefined;

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ...buildOutboundResultEnvelope({
            payloads: normalizedPayloads,
            meta: result.meta,
          }),
          ...(deliveryStatusResult ? { deliveryStatus: deliveryStatusResult } : {}),
        },
        null,
        2,
      ),
    );
  }

  return {
    payloads: normalizedPayloads,
    meta: result.meta,
    deliveryStatus: deliveryStatusResult,
  };
}

import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitContinuityDiagnostic } from "../../infra/continuity-diagnostics.js";
import {
  type AgentDeliveryPlan,
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
import { resolveGatewaySessionStoreTarget } from "../../gateway/session-utils.js";
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

type LiveOutboundSessionEntry = {
  entry: SessionEntry;
  storeKey: string;
  canonicalKey: string;
};

type DeliveryPlanArgs = Parameters<typeof resolveAgentDeliveryPlan>[0];

type BoundaryDeliverySeed = {
  boundaryId?: string;
  checkpointId?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

function loadLiveOutboundSessionEntry(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
}): LiveOutboundSessionEntry | null {
  const sessionKey = typeof params.sessionKey === "string" && params.sessionKey.trim()
    ? params.sessionKey.trim()
    : "";
  if (!sessionKey) {
    return null;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: sessionKey,
    });
    const store = loadSessionStore(target.storePath);
    for (const key of target.storeKeys ?? []) {
      const entry = store[key];
      if (entry) {
        return {
          entry,
          storeKey: key,
          canonicalKey: target.canonicalKey,
        };
      }
    }
    const entry = store[target.canonicalKey];
    return entry
      ? {
          entry,
          storeKey: target.canonicalKey,
          canonicalKey: target.canonicalKey,
        }
      : null;
  } catch (err) {
    emitContinuityDiagnostic({
      type: "diag.outbound.live_lookup_failed",
      severity: "info",
      sessionKey,
      phase: "before_delivery",
      correlation: { sessionKey },
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

function snapshotDeliveryPlan(plan: AgentDeliveryPlan): Record<string, unknown> {
  return {
    channel: plan.resolvedChannel,
    to: plan.resolvedTo,
    accountId: plan.resolvedAccountId,
    threadId: plan.resolvedThreadId,
    targetMode: plan.deliveryTargetMode,
  };
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

function maybeEmitOutboundReresolveDiagnostic(params: {
  sessionKey?: string;
  carriedPlan: AgentDeliveryPlan;
  livePlan: AgentDeliveryPlan | null;
  carriedEntry?: SessionEntry;
  liveEntry?: SessionEntry;
  liveStoreKey?: string;
}): void {
  if (!params.livePlan) {
    return;
  }
  const carried = snapshotDeliveryPlan(params.carriedPlan);
  const live = snapshotDeliveryPlan(params.livePlan);
  if (stableJson(carried) === stableJson(live)) {
    return;
  }
  emitContinuityDiagnostic({
    type: "diag.outbound.target_reresolved",
    severity: "warn",
    sessionKey: params.sessionKey,
    phase: "before_delivery",
    correlation: {
      sessionKey: params.sessionKey,
      storeKey: params.liveStoreKey,
    },
    details: {
      carried,
      live,
      carriedUpdatedAt: params.carriedEntry?.updatedAt,
      liveUpdatedAt: params.liveEntry?.updatedAt,
    },
  });
}

function isPlainBoundaryObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() ? value.trim() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readBoundaryDeliverySeed(entry: SessionEntry | undefined): BoundaryDeliverySeed | null {
  const restore = isPlainBoundaryObject(entry?.continuityRestore)
    ? entry.continuityRestore
    : undefined;
  const marker = isPlainBoundaryObject(restore?.usedBoundary) ? restore.usedBoundary : undefined;
  const metadata = isPlainBoundaryObject(marker?.boundaryMetadata)
    ? marker.boundaryMetadata
    : undefined;
  const state = isPlainBoundaryObject(metadata?.state) ? metadata.state : undefined;
  if (!marker || !metadata || !state) {
    return null;
  }
  const outbound = isPlainBoundaryObject(state.outbound) ? state.outbound : {};
  const binding = isPlainBoundaryObject(state.sessionBinding) ? state.sessionBinding : {};
  const channel = nonEmptyString(outbound.channel) ?? nonEmptyString(binding.channel);
  const to = nonEmptyString(outbound.targetId) ?? nonEmptyString(binding.targetId);
  const accountId = nonEmptyString(binding.accountId);
  const threadId = nonEmptyString(outbound.threadId) ?? nonEmptyString(binding.threadId);
  if (!channel && !to && !accountId && !threadId) {
    return null;
  }
  return {
    boundaryId:
      nonEmptyString(marker.boundaryId) ??
      nonEmptyString(metadata.boundaryId) ??
      nonEmptyString(marker.checkpointId),
    checkpointId: nonEmptyString(marker.checkpointId),
    channel,
    to,
    accountId,
    threadId,
  };
}

function missingDeliveryField(entry: SessionEntry | undefined, field: keyof SessionEntry): boolean {
  if (!entry) {
    return true;
  }
  const value = entry[field];
  return value === undefined || value === null || value === "";
}

function applyBoundaryDeliveryFallback(entry: SessionEntry | undefined): {
  entry: SessionEntry | undefined;
  appliedFields: string[];
  seed: BoundaryDeliverySeed | null;
} {
  const seed = readBoundaryDeliverySeed(entry);
  if (!seed) {
    return { entry, appliedFields: [], seed: null };
  }
  const next: SessionEntry = entry ? { ...entry } : ({ sessionId: "" } as SessionEntry);
  const appliedFields: string[] = [];
  const context = isPlainBoundaryObject(next.deliveryContext) ? { ...next.deliveryContext } : {};
  if (
    seed.channel &&
    missingDeliveryField(next, "lastChannel") &&
    missingDeliveryField(next, "channel") &&
    !nonEmptyString(context.channel)
  ) {
    next.lastChannel = seed.channel as SessionEntry["lastChannel"];
    context.channel = seed.channel;
    appliedFields.push("channel");
  }
  if (seed.to && missingDeliveryField(next, "lastTo") && !nonEmptyString(context.to)) {
    next.lastTo = seed.to;
    context.to = seed.to;
    appliedFields.push("to");
  }
  if (
    seed.accountId &&
    missingDeliveryField(next, "lastAccountId") &&
    !nonEmptyString(context.accountId)
  ) {
    next.lastAccountId = seed.accountId;
    context.accountId = seed.accountId;
    appliedFields.push("accountId");
  }
  if (
    seed.threadId &&
    missingDeliveryField(next, "lastThreadId") &&
    !nonEmptyString(context.threadId)
  ) {
    next.lastThreadId = seed.threadId;
    context.threadId = seed.threadId;
    appliedFields.push("threadId");
  }
  if (appliedFields.length > 0) {
    next.deliveryContext = context as SessionEntry["deliveryContext"];
  }
  return {
    entry: appliedFields.length > 0 ? next : entry,
    appliedFields,
    seed,
  };
}

function maybeEmitBoundaryDeliveryFallbackDiagnostic(params: {
  sessionKey?: string;
  planSource: "live" | "carried";
  appliedFields?: string[];
  seed?: BoundaryDeliverySeed | null;
  plan?: AgentDeliveryPlan;
}): void {
  if (!params.appliedFields?.length || !params.seed) {
    return;
  }
  emitContinuityDiagnostic({
    type: "continuity.restore.boundary_fallback_applied",
    severity: "info",
    sessionKey: params.sessionKey,
    phase: "before_delivery",
    correlation: {
      boundaryId: params.seed.boundaryId,
      checkpointId: params.seed.checkpointId,
      sessionKey: params.sessionKey,
      planSource: params.planSource,
    },
    details: {
      appliedFields: params.appliedFields,
      seed: params.seed,
      plan: params.plan ? snapshotDeliveryPlan(params.plan) : undefined,
    },
  });
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
  hasPendingSpawnedChildren?: boolean;
}) {
  const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
  const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
  const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
  const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
  const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
  const deliveryPlanArgs: Omit<DeliveryPlanArgs, "sessionEntry"> = {
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: deliver,
    turnSourceChannel,
    turnSourceTo,
    turnSourceAccountId,
    turnSourceThreadId,
  };
  const carriedBoundaryFallback = applyBoundaryDeliveryFallback(sessionEntry);
  const carriedDeliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry: carriedBoundaryFallback.entry,
    ...deliveryPlanArgs,
  });
  const liveOutboundSession = deliver
    ? loadLiveOutboundSessionEntry({
        cfg,
        sessionKey: effectiveSessionKey,
      })
    : null;
  const liveBoundaryFallback = liveOutboundSession?.entry
    ? applyBoundaryDeliveryFallback(liveOutboundSession.entry)
    : null;
  const liveDeliveryPlan = liveBoundaryFallback?.entry
    ? resolveAgentDeliveryPlan({
        sessionEntry: liveBoundaryFallback.entry,
        ...deliveryPlanArgs,
      })
    : null;
  maybeEmitOutboundReresolveDiagnostic({
    sessionKey: effectiveSessionKey,
    carriedPlan: carriedDeliveryPlan,
    livePlan: liveDeliveryPlan,
    carriedEntry: sessionEntry,
    liveEntry: liveOutboundSession?.entry,
    liveStoreKey: liveOutboundSession?.storeKey,
  });
  const deliveryPlan = liveDeliveryPlan ?? carriedDeliveryPlan;
  const selectedFallback = liveDeliveryPlan ? liveBoundaryFallback : carriedBoundaryFallback;
  maybeEmitBoundaryDeliveryFallbackDiagnostic({
    sessionKey: effectiveSessionKey,
    planSource: liveDeliveryPlan ? "live" : "carried",
    appliedFields: selectedFallback?.appliedFields,
    seed: selectedFallback?.seed,
    plan: deliveryPlan,
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
  const outboundPayloadPlan = createOutboundPayloadPlan(mediaNormalizedReplyPayloads, {
    cfg,
    sessionKey: effectiveSessionKey,
    surface: deliveryChannel,
    hasPendingSpawnedChildren: params.hasPendingSpawnedChildren,
  });
  const normalizedPayloads = projectOutboundPayloadPlanForJson(outboundPayloadPlan);
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
      return { payloads: normalizedPayloads, meta: result.meta };
    }
  }

  if (!payloads || payloads.length === 0) {
    runtime.log("No reply from agent.");
    return { payloads: [], meta: result.meta };
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

  return { payloads: normalizedPayloads, meta: result.meta };
}

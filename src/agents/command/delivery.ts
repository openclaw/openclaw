/**
 * Normalizes and delivers agent command results to outbound channels.
 */
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope-config.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  copyReplyPayloadMetadata,
  type ReplyPayload,
  formatBtwTextForExternalDelivery,
} from "../../auto-reply/reply-payload.js";
import {
  normalizeReplyPayloadOutcome,
  type NormalizeReplyOutcome,
  type NormalizeReplySkipReason,
} from "../../auto-reply/reply/normalize-reply.js";
import { resolvePendingFinalDeliveryCompletion } from "../../auto-reply/reply/pending-final-delivery.js";
import { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.runtime.js";
import {
  filterMessagingToolMediaDuplicates,
  hasEnabledDeliveryOperation,
  resolveMessagingToolPayloadDedupe,
} from "../../auto-reply/reply/reply-payloads-dedupe.runtime.js";
import { resolveResponsePrefixTemplate } from "../../auto-reply/reply/response-prefix-template.js";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import { sendDurableMessageBatchCore } from "../../channels/message/runtime.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import { formatUnknownChannelMessage } from "../../cli/error-format.js";
import { createOutboundSendDeps, type CliDeps } from "../../cli/outbound-send-deps.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { toErrorObject } from "../../infra/errors.js";
import {
  resolveAgentDeliveryPlanWithSessionRoute,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { resolveAgentOutboundIdentity } from "../../infra/outbound/identity.js";
import {
  createOutboundPayloadPlan,
  formatOutboundPayloadLog,
  type NormalizedOutboundPayload,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForJson,
  projectOutboundPayloadPlanForOutbound,
} from "../../infra/outbound/payloads.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { normalizeSentMediaUrlsForDelivery } from "../delivery-evidence-values.js";
import { isNestedAgentLane } from "../lanes.js";
import {
  createAgentCommandDeliveryGuard,
  createRestartOnlyAbortSignal,
} from "./delivery-authority.js";
import {
  buildDeliveryResult,
  deliveryStatusFromDurableSend,
  type AgentCommandDeliveryResult,
  type AgentCommandDeliveryStatus,
  type DurableSendResult,
} from "./delivery-result.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<ReturnType<(typeof import("../embedded-agent.js"))["runEmbeddedAgent"]>>;

const NESTED_LOG_PREFIX = "[agent:nested]";

type FreshSessionEntryForDeliveryResolver = () => Promise<SessionEntry | undefined>;

type FreshSessionDeliveryRefreshParams =
  | {
      expectedSessionIdForFreshDelivery: string;
      resolveFreshSessionEntryForDelivery: FreshSessionEntryForDeliveryResolver;
    }
  | {
      expectedSessionIdForFreshDelivery?: string;
      resolveFreshSessionEntryForDelivery?: undefined;
    };

type DeliverAgentCommandResultParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  sessionEntry: SessionEntry | undefined;
  result: RunResult;
  payloads: ReplyPayload[] | undefined;
  /** Channel plugin already selected and bootstrapped by the caller. */
  preparedPlugin?: ChannelPlugin;
  assertDeliveryCurrent?: () => void;
  onDeliveryResult?: (result: AgentCommandDeliveryResult) => void;
} & FreshSessionDeliveryRefreshParams;

function isFreshDeliverySessionMatch(
  freshSessionEntry: SessionEntry,
  expectedSessionId: string | undefined,
): boolean {
  const normalizedExpected = expectedSessionId?.trim();
  return Boolean(normalizedExpected && freshSessionEntry.sessionId === normalizedExpected);
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

function preDeliveryFailureStatus(reason: string): AgentCommandDeliveryStatus {
  return {
    requested: true,
    attempted: false,
    status: "failed",
    succeeded: false,
    error: true,
    reason,
  };
}

function noVisiblePayloadStatus(reason?: NormalizeReplySkipReason): AgentCommandDeliveryStatus {
  return {
    requested: true,
    attempted: false,
    status: "suppressed",
    succeeded: true,
    reason: reason === "channel_transform" ? reason : "no_visible_payload",
    resultCount: 0,
  };
}

async function normalizeReplyMediaPathsForDelivery(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  sessionKey?: string;
  outboundSession: OutboundSessionContext | undefined;
  deliveryChannel: string;
  accountId?: string;
}): Promise<{
  payloads: ReplyPayload[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}> {
  if (params.payloads.length === 0) {
    return { payloads: params.payloads };
  }
  const agentId =
    params.outboundSession?.agentId ??
    resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const workspaceDir = agentId ? resolveAgentWorkspaceDir(params.cfg, agentId) : undefined;
  if (!workspaceDir) {
    return { payloads: params.payloads };
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
  return { payloads: result, normalizeMediaPaths };
}

const UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

async function filterAlreadyDeliveredReplyPayloads(params: {
  cfg: OpenClawConfig;
  payloads: ReplyPayload[];
  result: RunResult;
  deliveryChannel: string;
  deliveryTarget: string;
  accountId?: string;
  sourceAccountId?: string;
  defaultAccountId?: string;
  threadId?: string | number;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
  normalizeSentTexts?: (sentTexts: readonly string[]) => string[];
}): Promise<ReplyPayload[]> {
  const sentTexts = params.result.messagingToolSentTexts ?? [];
  const sentMediaUrls = params.result.messagingToolSentMediaUrls ?? [];
  // The message tool injects the run account after telemetry captures its
  // original args. Preserve that source route before falling back to default.
  const implicitToolAccountId = params.sourceAccountId ?? params.defaultAccountId;
  const sentTargets = (params.result.messagingToolSentTargets ?? []).flatMap((target) => {
    if (target.accountId || !params.accountId) {
      return [target];
    }
    return implicitToolAccountId ? [{ ...target, accountId: implicitToolAccountId }] : [];
  });
  if (sentTexts.length === 0 && sentMediaUrls.length === 0 && sentTargets.length === 0) {
    return params.payloads;
  }

  const decision = resolveMessagingToolPayloadDedupe({
    config: params.cfg,
    messageProvider: params.deliveryChannel,
    messagingToolSentTargets: sentTargets,
    originatingTo: params.deliveryTarget,
    originatingThreadId: params.threadId,
    accountId: params.accountId,
  });
  if (!decision.matchingRoute) {
    return params.payloads;
  }
  const routeSentMediaUrls = decision.useGlobalSentMediaUrlEvidenceFallback
    ? sentMediaUrls
    : decision.routeSentMediaUrls;
  const rawRouteSentTexts = decision.useGlobalSentTextEvidenceFallback
    ? sentTexts
    : decision.routeSentTexts;
  const routeSentTexts = params.normalizeSentTexts?.(rawRouteSentTexts) ?? rawRouteSentTexts;
  const exactRouteSentTexts = new Set(routeSentTexts.filter((text) => Boolean(text.trim())));
  const normalizedSentMediaUrls = await normalizeSentMediaUrlsForDelivery({
    sentMediaUrls: routeSentMediaUrls,
    normalizeMediaPaths: params.normalizeMediaPaths,
  });
  const mediaFiltered = filterMessagingToolMediaDuplicates({
    payloads: params.payloads,
    sentMediaUrls: normalizedSentMediaUrls,
  });

  const filteredPayloads: ReplyPayload[] = [];
  for (const candidate of mediaFiltered) {
    if (hasEnabledDeliveryOperation(candidate)) {
      filteredPayloads.push(candidate);
      continue;
    }
    const effectiveCandidateText =
      formatBtwTextForExternalDelivery(candidate) ?? candidate.text ?? "";
    if (!effectiveCandidateText.trim() || !exactRouteSentTexts.has(effectiveCandidateText)) {
      filteredPayloads.push(candidate);
      continue;
    }
    const withoutDuplicateText = copyReplyPayloadMetadata(candidate, {
      ...candidate,
      text: undefined,
    });
    if (
      hasReplyPayloadContent(withoutDuplicateText, {
        trimText: true,
        extraContent: withoutDuplicateText.location != null,
      })
    ) {
      filteredPayloads.push(withoutDuplicateText);
    }
  }
  return filteredPayloads;
}

/** Normalizes reply payloads and media paths before delivery. */
function normalizeAgentCommandReplyPayloads(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  payloads: ReplyPayload[] | undefined;
  result: RunResult;
  deliveryChannel?: string;
  plugin?: ChannelPlugin;
  accountId?: string;
  applyChannelTransforms?: boolean;
  includeRunModelContext?: boolean;
}): NormalizeReplyOutcome<ReplyPayload[]> {
  const payloads = params.payloads ?? [];
  if (payloads.length === 0) {
    return { kind: "suppress", reason: "empty" };
  }
  const channel =
    params.deliveryChannel && !isInternalMessageChannel(params.deliveryChannel)
      ? (normalizeChannelId(params.deliveryChannel) ?? params.deliveryChannel)
      : undefined;
  if (!channel) {
    return { kind: "deliver", payload: payloads };
  }
  const applyChannelTransforms = params.applyChannelTransforms ?? true;
  const deliveryPlugin = applyChannelTransforms ? params.plugin : undefined;

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
  if (params.includeRunModelContext !== false && providerUsed && modelUsed) {
    replyPrefix.onModelSelected({
      provider: providerUsed,
      model: modelUsed,
      thinkLevel: undefined,
    });
  }
  const responsePrefixContext = replyPrefix.responsePrefixContextProvider();
  const resolvedResponsePrefix = resolveResponsePrefixTemplate(
    replyPrefix.responsePrefix,
    responsePrefixContext,
  );
  const responsePrefix =
    params.includeRunModelContext === false &&
    resolvedResponsePrefix &&
    UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN.test(resolvedResponsePrefix)
      ? undefined
      : replyPrefix.responsePrefix;
  const deliveryMessaging = deliveryPlugin?.messaging;
  const transformReplyPayload = createChannelReplyTransform({
    messaging: deliveryMessaging,
    cfg: params.cfg,
    accountId: params.accountId,
  });

  const normalizedPayloads: ReplyPayload[] = [];
  let suppressionReason: NormalizeReplySkipReason | undefined;
  for (const payload of payloads) {
    const outcome = normalizeReplyPayloadOutcome(payload, {
      responsePrefix,
      applyChannelTransforms,
      responsePrefixContext,
      transformReplyPayload,
    });
    if (outcome.kind === "deliver") {
      normalizedPayloads.push(outcome.payload);
    } else if (suppressionReason === undefined || outcome.reason === "channel_transform") {
      suppressionReason = outcome.reason;
    }
  }
  return normalizedPayloads.length > 0
    ? { kind: "deliver", payload: normalizedPayloads }
    : { kind: "suppress", reason: suppressionReason ?? "empty" };
}

/** Delivers an agent command result or records why delivery was skipped. */
export async function deliverAgentCommandResult(
  params: DeliverAgentCommandResultParams,
): Promise<AgentCommandDeliveryResult> {
  params.assertDeliveryCurrent?.();
  const { cfg, deps, runtime, opts, outboundSession, sessionEntry, payloads, result } = params;
  const effectiveSessionKey = outboundSession?.key ?? opts.sessionKey;
  const deliveryAgentId =
    outboundSession?.agentId ??
    resolveSessionAgentId({
      sessionKey: effectiveSessionKey,
      config: cfg,
    }) ??
    resolveDefaultAgentId(cfg);
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const turnSourceChannel = opts.runContext?.messageChannel ?? opts.messageChannel;
  const turnSourceTo = opts.runContext?.currentChannelId ?? opts.to;
  const turnSourceAccountId = opts.runContext?.accountId ?? opts.accountId;
  const turnSourceThreadId = opts.runContext?.currentThreadTs ?? opts.threadId;
  const explicitChannelHint = (opts.replyChannel ?? opts.channel)?.trim();
  const resolveDeliveryRouting = async (candidateSessionEntry: SessionEntry | undefined) => {
    const deliveryPlan = await resolveAgentDeliveryPlanWithSessionRoute({
      cfg,
      agentId: deliveryAgentId,
      currentSessionKey: effectiveSessionKey,
      sessionEntry: candidateSessionEntry,
      requestedChannel: opts.replyChannel ?? opts.channel,
      explicitTo: opts.replyTo ?? opts.to,
      explicitThreadId: opts.threadId,
      accountId: opts.replyAccountId ?? opts.accountId,
      wantsDelivery: deliver,
      preparedPlugin: params.preparedPlugin,
      turnSourceChannel,
      turnSourceTo,
      turnSourceAccountId,
      turnSourceThreadId,
    });
    params.assertDeliveryCurrent?.();
    let deliveryChannel = deliveryPlan.resolvedChannel;
    let preparedPlugin = deliveryPlan.plugin;
    if (deliver && isInternalMessageChannel(deliveryChannel) && !explicitChannelHint) {
      try {
        const selection = await resolveMessageChannelSelection({ cfg });
        params.assertDeliveryCurrent?.();
        deliveryChannel = selection.channel;
        preparedPlugin = selection.plugin;
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
            plugin: preparedPlugin,
          };
    // Bundled/setup channels may be dockable before they appear in the registered
    // deliverable-id list. Resolve only when upstream planning prepared no plugin.
    const deliveryPlugin =
      deliver && !isInternalMessageChannel(deliveryChannel)
        ? (effectiveDeliveryPlan.plugin ??
          getChannelPlugin(normalizeChannelId(deliveryChannel) ?? deliveryChannel))
        : undefined;
    const pluginDeliveryPlan =
      deliveryPlugin && deliveryPlugin !== effectiveDeliveryPlan.plugin
        ? { ...effectiveDeliveryPlan, plugin: deliveryPlugin }
        : effectiveDeliveryPlan;
    const isDeliveryChannelKnown =
      isInternalMessageChannel(deliveryChannel) || Boolean(deliveryPlugin);
    const targetMode =
      opts.deliveryTargetMode ??
      pluginDeliveryPlan.deliveryTargetMode ??
      (opts.to ? "explicit" : "implicit");
    const defaultAccountId =
      !pluginDeliveryPlan.resolvedAccountId && deliveryPlugin?.config?.listAccountIds
        ? resolveChannelDefaultAccountId({ plugin: deliveryPlugin, cfg })
        : undefined;
    const resolvedAccountId = pluginDeliveryPlan.resolvedAccountId ?? defaultAccountId;
    const resolvedDeliveryPlan =
      resolvedAccountId === pluginDeliveryPlan.resolvedAccountId
        ? pluginDeliveryPlan
        : { ...pluginDeliveryPlan, resolvedAccountId };
    const resolved =
      deliver && isDeliveryChannelKnown && deliveryChannel
        ? resolveAgentOutboundTarget({
            cfg,
            plan: resolvedDeliveryPlan,
            targetMode,
            validateExplicitTarget: true,
          })
        : {
            resolvedTarget: null,
            resolvedTo: effectiveDeliveryPlan.resolvedTo,
            targetMode,
          };
    const resolvedThreadId = deliveryPlan.resolvedThreadId ?? opts.threadId;
    const replyTransport =
      deliveryPlugin?.threading?.resolveReplyTransport?.({
        cfg,
        accountId: resolvedAccountId,
        threadId: resolvedThreadId,
      }) ?? null;
    return {
      deliveryChannel,
      deliveryPlugin,
      isDeliveryChannelKnown,
      defaultAccountId,
      resolvedAccountId,
      resolvedTarget: resolved.resolvedTarget,
      deliveryTarget: resolved.resolvedTo,
      resolvedReplyToId: replyTransport?.replyToId ?? undefined,
      resolvedThreadTarget:
        replyTransport && Object.hasOwn(replyTransport, "threadId")
          ? (replyTransport.threadId ?? null)
          : (resolvedThreadId ?? null),
    };
  };
  const deliveryRoutingFailureReason = (
    route: Awaited<ReturnType<typeof resolveDeliveryRouting>>,
  ): string | undefined => {
    if (!deliver) {
      return undefined;
    }
    if (isInternalMessageChannel(route.deliveryChannel)) {
      return "channel_resolved_to_internal";
    }
    if (!route.isDeliveryChannelKnown) {
      return "unknown_channel";
    }
    if (route.resolvedTarget && !route.resolvedTarget.ok) {
      return "invalid_delivery_target";
    }
    if (!route.deliveryTarget) {
      return "no_delivery_target";
    }
    return undefined;
  };
  let deliveryRouting = await resolveDeliveryRouting(sessionEntry);
  params.assertDeliveryCurrent?.();
  const routingFailure = deliveryRoutingFailureReason(deliveryRouting);
  if (routingFailure && routingFailure !== "unknown_channel") {
    const freshSessionEntry = await params.resolveFreshSessionEntryForDelivery?.();
    params.assertDeliveryCurrent?.();
    const expectedFreshSessionId =
      params.expectedSessionIdForFreshDelivery ?? sessionEntry?.sessionId;
    if (
      freshSessionEntry &&
      freshSessionEntry !== sessionEntry &&
      isFreshDeliverySessionMatch(freshSessionEntry, expectedFreshSessionId)
    ) {
      const freshRouting = await resolveDeliveryRouting(freshSessionEntry);
      params.assertDeliveryCurrent?.();
      if (!deliveryRoutingFailureReason(freshRouting)) {
        if (!opts.json) {
          runtime.log(
            `[delivery] refreshed session routing before final delivery (session=${effectiveSessionKey ?? "unknown"} channel=${freshRouting.deliveryChannel})`,
          );
        }
        deliveryRouting = freshRouting;
      }
    }
  }
  const {
    deliveryChannel,
    isDeliveryChannelKnown,
    defaultAccountId,
    resolvedAccountId,
    resolvedTarget,
    deliveryTarget,
    resolvedReplyToId,
    resolvedThreadTarget,
    deliveryPlugin,
  } = deliveryRouting;

  let deliveryLoggedError = false;
  const logDeliveryError = (err: unknown) => {
    deliveryLoggedError = true;
    const message = `Delivery failed (${deliveryChannel}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  };
  let strictPreDeliveryError: unknown;
  let deliveryStatus: AgentCommandDeliveryStatus | undefined;
  const handlePreDeliveryError = (err: unknown, reason: string) => {
    deliveryStatus = preDeliveryFailureStatus(reason);
    if (!bestEffortDeliver) {
      if (opts.json) {
        strictPreDeliveryError = err;
        return;
      }
      throw err;
    }
    logDeliveryError(err);
  };

  if (deliver) {
    if (isInternalMessageChannel(deliveryChannel)) {
      const err = new Error(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      );
      handlePreDeliveryError(err, "channel_resolved_to_internal");
    } else if (!isDeliveryChannelKnown) {
      const err = new Error(formatUnknownChannelMessage({ channel: deliveryChannel }));
      handlePreDeliveryError(err, "unknown_channel");
    } else if (resolvedTarget && !resolvedTarget.ok) {
      handlePreDeliveryError(resolvedTarget.error, "invalid_delivery_target");
    }
  }

  const normalizeReplyPayloads = (
    replyPayloads: ReplyPayload[] | undefined,
    includeRunModelContext = true,
  ) =>
    normalizeAgentCommandReplyPayloads({
      cfg,
      opts,
      outboundSession,
      payloads: replyPayloads,
      result,
      deliveryChannel,
      plugin: deliveryPlugin,
      accountId: resolvedAccountId,
      applyChannelTransforms: deliver,
      includeRunModelContext,
    });
  const replyNormalization = normalizeReplyPayloads(payloads);
  const normalizedReplyPayloads =
    replyNormalization.kind === "deliver" ? replyNormalization.payload : [];
  const canonicalReplyPayloads = projectOutboundPayloadPlanForDelivery(
    createOutboundPayloadPlan(normalizedReplyPayloads),
  );
  const shouldFilterDeliveredPayloads =
    deliver &&
    !deliveryStatus &&
    Boolean(deliveryTarget) &&
    !isInternalMessageChannel(deliveryChannel);
  const normalizeSentTexts = (sentTexts: readonly string[]) => {
    const outcome = normalizeReplyPayloads(
      sentTexts.map((text) => ({ text })),
      false,
    );
    return (outcome.kind === "deliver" ? outcome.payload : []).flatMap((payload) =>
      payload.text?.trim() ? [payload.text] : [],
    );
  };
  const filterDeliveredPayloads = (
    replyPayloads: ReplyPayload[],
    normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>,
  ) => {
    if (!shouldFilterDeliveredPayloads || !deliveryTarget) {
      return Promise.resolve(replyPayloads);
    }
    return filterAlreadyDeliveredReplyPayloads({
      cfg,
      payloads: replyPayloads,
      result,
      deliveryChannel,
      deliveryTarget,
      accountId: resolvedAccountId,
      sourceAccountId: turnSourceAccountId,
      defaultAccountId,
      // Command delivery projects payloads onto one batch route below, so
      // per-payload reply metadata does not change the destination here.
      threadId: resolvedThreadTarget ?? resolvedReplyToId ?? undefined,
      normalizeMediaPaths,
      normalizeSentTexts,
    });
  };
  // Remove exact raw media matches before blocked-path normalization can turn
  // a successful message-tool send into a false media failure warning.
  const rawFilteredReplyPayloads = await filterDeliveredPayloads(canonicalReplyPayloads);
  // Auto-reply-style media-path normalization must also run for the CLI
  // `--deliver` path. Without it, relative reply media paths reach the
  // outbound loader unresolved and `assertLocalMediaAllowed` fails with
  // "Local media path is not under an allowed directory". Mirrors the
  // normalizer wiring in `src/auto-reply/reply/agent-runner.ts`.
  const mediaNormalization =
    deliver && !deliveryStatus && !isInternalMessageChannel(deliveryChannel)
      ? await normalizeReplyMediaPathsForDelivery({
          cfg,
          payloads: rawFilteredReplyPayloads,
          sessionKey: effectiveSessionKey,
          outboundSession,
          deliveryChannel,
          accountId: resolvedAccountId,
        })
      : { payloads: rawFilteredReplyPayloads };
  const mediaNormalizedReplyPayloads = await filterDeliveredPayloads(
    mediaNormalization.payloads,
    mediaNormalization.normalizeMediaPaths,
  );
  params.assertDeliveryCurrent?.();
  const outboundPayloadPlan = createOutboundPayloadPlan(mediaNormalizedReplyPayloads);
  const normalizedPayloads = projectOutboundPayloadPlanForJson(outboundPayloadPlan);
  const completeDelivery = (
    status?: AgentCommandDeliveryStatus,
    deliverySucceeded?: boolean,
  ): AgentCommandDeliveryResult => {
    if (opts.json) {
      const meta = result.meta;
      writeRuntimeJson(runtime, {
        payloads: [...normalizedPayloads],
        ...(meta ? { meta } : {}),
        ...(status ? { deliveryStatus: status } : {}),
      });
    }
    const deliveryResult = buildDeliveryResult({
      payloads: normalizedPayloads,
      meta: result.meta,
      result,
      deliverySucceeded,
      deliveryStatus: status,
    });
    params.onDeliveryResult?.(deliveryResult);
    return deliveryResult;
  };
  if (strictPreDeliveryError) {
    completeDelivery(deliveryStatus);
    throw toErrorObject(strictPreDeliveryError, "Non-Error thrown");
  }

  const deliveryPayloads = projectOutboundPayloadPlanForOutbound(outboundPayloadPlan);
  if (deliveryPayloads.length === 0) {
    deliveryStatus = deliver
      ? (deliveryStatus ??
        noVisiblePayloadStatus(
          replyNormalization.kind === "suppress" ? replyNormalization.reason : undefined,
        ))
      : undefined;
    return completeDelivery(deliveryStatus, deliveryStatus?.succeeded === true ? true : undefined);
  }

  let deliverySucceeded = false;
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
    return completeDelivery();
  }
  if (deliveryChannel && !isInternalMessageChannel(deliveryChannel)) {
    if (deliveryTarget && !deliveryStatus) {
      params.assertDeliveryCurrent?.();
      // The outbound projection contains transport data, not private payload metadata.
      const completion = resolvePendingFinalDeliveryCompletion(payloads);
      const assertPlatformSendCurrent = createAgentCommandDeliveryGuard(params, completion);
      const restartAbort = createRestartOnlyAbortSignal(opts.abortSignal);
      let send: DurableSendResult;
      try {
        send = await sendDurableMessageBatchCore({
          cfg,
          channel: deliveryChannel,
          to: deliveryTarget,
          accountId: resolvedAccountId,
          payloads: deliveryPayloads,
          ...(completion
            ? {
                deliveryCompletion: completion,
                deliveryIntentId: completion.deliveryId,
              }
            : {}),
          session: outboundSession,
          identity: resolveAgentOutboundIdentity(cfg, deliveryAgentId),
          replyPayloadSendingHook: {
            kind: "final",
            channel: deliveryChannel,
            ...(effectiveSessionKey ? { sessionKey: effectiveSessionKey } : {}),
            ...(opts.runId ? { runId: opts.runId } : {}),
            context: {
              channelId: deliveryChannel,
              ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
              conversationId: deliveryTarget,
              ...(effectiveSessionKey ? { sessionKey: effectiveSessionKey } : {}),
              ...(opts.runId ? { runId: opts.runId } : {}),
            },
          },
          replyToId: resolvedReplyToId ?? null,
          threadId: resolvedThreadTarget ?? null,
          bestEffort: bestEffortDeliver,
          durability: bestEffortDeliver ? "best_effort" : "required",
          signal: restartAbort.signal,
          onDeliveryIntent: restartAbort.dispose,
          onPlatformSendDispatch: async () => assertPlatformSendCurrent(),
          assertDirectAdapterHandoff: assertPlatformSendCurrent,
          onError: logDeliveryError,
          onPayload: logPayload,
          deps: createOutboundSendDeps(deps),
        });
      } finally {
        restartAbort.dispose();
      }
      if (restartAbort.signal?.aborted && send.status === "failed") {
        throw restartAbort.signal.reason;
      }
      deliveryStatus = deliveryStatusFromDurableSend(send);
      if (!bestEffortDeliver && (send.status === "failed" || send.status === "partial_failed")) {
        completeDelivery(deliveryStatus, false);
        throw send.error;
      }
      deliverySucceeded = send.status === "sent" || send.status === "suppressed";
    }
  }
  if (!deliveryStatus) {
    deliveryStatus = preDeliveryFailureStatus("no_delivery_target");
  }
  if (!deliverySucceeded && !opts.json && !deliveryLoggedError) {
    const message =
      `[delivery] delivery requested but not completed: ${deliveryStatus?.status ?? "unknown"} ` +
      `(reason=${deliveryStatus?.reason ?? "none"} session=${effectiveSessionKey ?? "unknown"} ` +
      `channel=${deliveryChannel ?? "none"} target=${deliveryTarget ?? "none"} ` +
      `payloads=${deliveryPayloads.length})`;
    runtime.error?.(message);
    if (!runtime.error) {
      runtime.log(message);
    }
  }

  return completeDelivery(deliveryStatus, deliverySucceeded);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

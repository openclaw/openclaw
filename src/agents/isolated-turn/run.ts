/**
 * Core isolated agent turn execution.
 *
 * This module provides the generic agent turn execution logic used by both
 * cron and spool (and potentially other triggers). It handles:
 * - Agent/model resolution
 * - Session management
 * - Thinking/timeout resolution
 * - Agent execution with model fallback
 * - Result processing
 * - Delivery handling
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { MessagingToolSend } from "../pi-embedded-messaging.js";
import type { IsolatedAgentTurnParams, IsolatedAgentTurnResult } from "./types.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../../auto-reply/thinking.js";
import { createOutboundSendDeps } from "../../cli/outbound-send-deps.js";
import { resolveSessionTranscriptPath, updateSessionStore } from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { logWarn } from "../../logger.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  buildSafeExternalPrompt,
  detectSuspiciousPatterns,
  getHookType,
  isExternalHookSession,
} from "../../security/external-content.js";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agent-scope.js";
import { runCliAgent } from "../cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../cli-session.js";
import { lookupContextTokens } from "../context.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { loadModelCatalog } from "../model-catalog.js";
import { runWithModelFallback } from "../model-fallback.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveThinkingDefault,
} from "../model-selection.js";
import { runEmbeddedPiAgent } from "../pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../skills.js";
import { getSkillsSnapshotVersion } from "../skills/refresh.js";
import { resolveAgentTimeoutMs } from "../timeout.js";
import { hasNonzeroUsage } from "../usage.js";
import { ensureAgentWorkspace } from "../workspace.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import {
  isHeartbeatOnlyResponse,
  pickLastDeliverablePayload,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveIsolatedSession } from "./session.js";

function matchesMessagingToolDeliveryTarget(
  target: MessagingToolSend,
  delivery: { channel: string; to?: string; accountId?: string },
): boolean {
  if (!delivery.to || !target.to) {
    return false;
  }
  const channel = delivery.channel.trim().toLowerCase();
  const provider = target.provider?.trim().toLowerCase();
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (target.accountId && delivery.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  return target.to === delivery.to;
}

/**
 * Format the message prefix based on the source type.
 */
function formatMessagePrefix(source: IsolatedAgentTurnParams["source"]): string {
  switch (source.type) {
    case "cron":
      return `[cron:${source.id} ${source.name}]`;
    case "spool":
      return `[spool:${source.id}]`;
  }
}

/**
 * Get the default lane based on the source type.
 */
function getDefaultLane(source: IsolatedAgentTurnParams["source"]): string {
  return source.type;
}

/**
 * Run an isolated agent turn with the provided parameters.
 *
 * This is the core execution logic shared by cron, spool, and other triggers.
 */
export async function runIsolatedAgentTurn(
  params: IsolatedAgentTurnParams,
): Promise<IsolatedAgentTurnResult> {
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const requestedAgentId =
    typeof params.agentId === "string" && params.agentId.trim() ? params.agentId : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(params.cfg, normalizedRequested)
    : undefined;
  const { model: overrideModel, ...agentOverrideRest } = agentConfigOverride ?? {};
  const agentId = agentConfigOverride ? (normalizedRequested ?? defaultAgentId) : defaultAgentId;
  const agentCfg: AgentDefaultsConfig = Object.assign(
    {},
    params.cfg.agents?.defaults,
    agentOverrideRest as Partial<AgentDefaultsConfig>,
  );
  if (typeof overrideModel === "string") {
    agentCfg.model = { primary: overrideModel };
  } else if (overrideModel) {
    agentCfg.model = overrideModel;
  }
  const cfgWithAgentDefaults: OpenClawConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };

  const baseSessionKey = (
    params.sessionKey?.trim() || `${params.source.type}:${params.source.id}`
  ).trim();
  const agentSessionKey = buildAgentMainSessionKey({
    agentId,
    mainKey: baseSessionKey,
  });

  const workspaceDirRaw = resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = resolveAgentDir(params.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;

  const resolvedDefault = resolveConfiguredModelRef({
    cfg: cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;
  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: cfgWithAgentDefaults });
    }
    return catalog;
  };

  // Resolve model - prefer hooks.gmail.model for Gmail hooks.
  const isGmailHook = baseSessionKey.startsWith("hook:gmail:");
  const hooksGmailModelRef = isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalog(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
    }
  }

  const modelOverrideRaw = params.model;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = resolveAllowedModelRef({
      cfg: cfgWithAgentDefaults,
      catalog: await loadCatalog(),
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      return { status: "error", error: resolvedOverride.error };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
  }

  const now = Date.now();
  const isolatedSession = resolveIsolatedSession({
    cfg: params.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
  });
  const runSessionId = isolatedSession.sessionEntry.sessionId;
  // Only create :run: keys for cron sources (spool sessions don't need duplication,
  // and session listing only filters cron run keys)
  const runSessionKey =
    params.source.type === "cron" && baseSessionKey.startsWith("cron:")
      ? `${agentSessionKey}:run:${runSessionId}`
      : agentSessionKey;
  const persistSessionEntry = async () => {
    isolatedSession.store[agentSessionKey] = isolatedSession.sessionEntry;
    if (runSessionKey !== agentSessionKey) {
      isolatedSession.store[runSessionKey] = isolatedSession.sessionEntry;
    }
    await updateSessionStore(isolatedSession.storePath, (store) => {
      store[agentSessionKey] = isolatedSession.sessionEntry;
      if (runSessionKey !== agentSessionKey) {
        store[runSessionKey] = isolatedSession.sessionEntry;
      }
    });
  };
  const withRunSession = (
    result: Omit<IsolatedAgentTurnResult, "sessionId" | "sessionKey">,
  ): IsolatedAgentTurnResult => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: runSessionKey,
  });
  // Apply session label if provided and not already set.
  if (params.sessionLabel && !isolatedSession.sessionEntry.label?.trim()) {
    isolatedSession.sessionEntry.label = params.sessionLabel;
  }

  // Resolve thinking level - payload thinking > hooks.gmail.thinking > agent default
  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking)
    : undefined;
  const thinkOverride = normalizeThinkLevel(agentCfg?.thinkingDefault);
  const payloadThink = normalizeThinkLevel(params.thinking ?? undefined);
  let thinkLevel = payloadThink ?? hooksGmailThinking ?? thinkOverride;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      catalog: await loadCatalog(),
    });
  }
  if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    logWarn(
      `[${params.source.type}:${params.source.id}] Thinking level "xhigh" is not supported for ${provider}/${model}; downgrading to "high".`,
    );
    thinkLevel = "high";
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds: params.timeoutSeconds,
  });

  const deliveryMode =
    params.deliver === true ? "explicit" : params.deliver === false ? "off" : "auto";
  const hasExplicitTarget = Boolean(params.to && params.to.trim());
  const deliveryRequested =
    deliveryMode === "explicit" || (deliveryMode === "auto" && hasExplicitTarget);
  const bestEffortDeliver = params.bestEffortDeliver === true;

  const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {
    channel: params.channel ?? "last",
    to: params.to,
  });

  const userTimezone = resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(params.cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(new Date(now), userTimezone, userTimeFormat) ?? new Date(now).toISOString();
  const timeLine = `Current time: ${formattedTime} (${userTimezone})`;
  const prefix = formatMessagePrefix(params.source);
  const base = `${prefix} ${params.message}`.trim();

  // SECURITY: Wrap external hook content with security boundaries to prevent prompt injection
  // unless explicitly allowed via a dangerous config override.
  const isExternalHook = isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    params.allowUnsafeExternalContent === true ||
    (isGmailHook && params.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    // Log suspicious patterns for security monitoring
    const suspiciousPatterns = detectSuspiciousPatterns(params.message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  if (shouldWrapExternal) {
    // Wrap external content with security boundaries
    const hookType = getHookType(baseSessionKey);
    const safeContent = buildSafeExternalPrompt({
      content: params.message,
      source: hookType,
      jobName: params.source.name,
      jobId: params.source.id,
      timestamp: formattedTime,
    });

    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    // Internal/trusted source - use original format
    commandBody = `${base}\n${timeLine}`.trim();
  }
  if (deliveryRequested) {
    commandBody =
      `${commandBody}\n\nReturn your summary as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
  }

  const existingSnapshot = isolatedSession.sessionEntry.skillsSnapshot;
  const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
  const needsSkillsSnapshot =
    !existingSnapshot || existingSnapshot.version !== skillsSnapshotVersion;
  const skillsSnapshot = needsSkillsSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfgWithAgentDefaults,
        eligibility: { remote: getRemoteSkillEligibility() },
        snapshotVersion: skillsSnapshotVersion,
      })
    : isolatedSession.sessionEntry.skillsSnapshot;
  if (needsSkillsSnapshot && skillsSnapshot) {
    isolatedSession.sessionEntry = {
      ...isolatedSession.sessionEntry,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    await persistSessionEntry();
  }

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  isolatedSession.sessionEntry.systemSent = true;
  await persistSessionEntry();

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = provider;
  let fallbackModel = model;
  try {
    const sessionFile = resolveSessionTranscriptPath(
      isolatedSession.sessionEntry.sessionId,
      agentId,
    );
    const resolvedVerboseLevel =
      normalizeVerboseLevel(isolatedSession.sessionEntry.verboseLevel) ??
      normalizeVerboseLevel(agentCfg?.verboseDefault) ??
      "off";
    registerAgentRunContext(isolatedSession.sessionEntry.sessionId, {
      sessionKey: agentSessionKey,
      verboseLevel: resolvedVerboseLevel,
    });
    const messageChannel = resolvedDelivery.channel;
    const lane = params.lane ?? getDefaultLane(params.source);
    const fallbackResult = await runWithModelFallback({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      agentDir,
      fallbacksOverride: resolveAgentModelFallbacksOverride(params.cfg, agentId),
      run: (providerOverride, modelOverride) => {
        if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
          const cliSessionId = getCliSessionId(isolatedSession.sessionEntry, providerOverride);
          return runCliAgent({
            sessionId: isolatedSession.sessionEntry.sessionId,
            sessionKey: agentSessionKey,
            agentId,
            sessionFile,
            workspaceDir,
            config: cfgWithAgentDefaults,
            prompt: commandBody,
            provider: providerOverride,
            model: modelOverride,
            thinkLevel,
            timeoutMs,
            runId: isolatedSession.sessionEntry.sessionId,
            cliSessionId,
          });
        }
        return runEmbeddedPiAgent({
          sessionId: isolatedSession.sessionEntry.sessionId,
          sessionKey: agentSessionKey,
          agentId,
          messageChannel,
          agentAccountId: resolvedDelivery.accountId,
          sessionFile,
          workspaceDir,
          config: cfgWithAgentDefaults,
          skillsSnapshot,
          prompt: commandBody,
          lane,
          provider: providerOverride,
          model: modelOverride,
          thinkLevel,
          verboseLevel: resolvedVerboseLevel,
          timeoutMs,
          runId: isolatedSession.sessionEntry.sessionId,
          requireExplicitMessageTarget: true,
          disableMessageTool: deliveryRequested,
        });
      },
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
  } catch (err) {
    return withRunSession({ status: "error", error: String(err) });
  }

  const payloads = runResult.payloads ?? [];

  // Update token+model fields in the session store.
  {
    const usage = runResult.meta.agentMeta?.usage;
    const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed = runResult.meta.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

    isolatedSession.sessionEntry.modelProvider = providerUsed;
    isolatedSession.sessionEntry.model = modelUsed;
    isolatedSession.sessionEntry.contextTokens = contextTokens;
    if (isCliProvider(providerUsed, cfgWithAgentDefaults)) {
      const cliSessionId = runResult.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(isolatedSession.sessionEntry, providerUsed, cliSessionId);
      }
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const promptTokens = input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      isolatedSession.sessionEntry.inputTokens = input;
      isolatedSession.sessionEntry.outputTokens = output;
      isolatedSession.sessionEntry.totalTokens =
        promptTokens > 0 ? promptTokens : (usage.total ?? input);
    }
    await persistSessionEntry();
  }
  const firstText = payloads[0]?.text ?? "";
  const summary = pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);
  const outputText = pickLastNonEmptyTextFromPayloads(payloads);
  const synthesizedText = outputText?.trim() || summary?.trim() || undefined;
  const deliveryPayload = pickLastDeliverablePayload(payloads);
  const deliveryPayloads =
    deliveryPayload !== undefined
      ? [deliveryPayload]
      : synthesizedText
        ? [{ text: synthesizedText }]
        : [];

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  const ackMaxChars = resolveHeartbeatAckMaxChars(agentCfg);
  const skipHeartbeatDelivery = deliveryRequested && isHeartbeatOnlyResponse(payloads, ackMaxChars);
  const skipMessagingToolDelivery =
    deliveryRequested &&
    deliveryMode === "auto" &&
    runResult.didSendViaMessagingTool === true &&
    (runResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
      }),
    );

  if (deliveryRequested && !skipHeartbeatDelivery && !skipMessagingToolDelivery) {
    if (resolvedDelivery.error) {
      if (!bestEffortDeliver) {
        return withRunSession({
          status: "error",
          error: resolvedDelivery.error.message,
          summary,
          outputText,
        });
      }
      logWarn(`[${params.source.type}:${params.source.id}] ${resolvedDelivery.error.message}`);
      return withRunSession({ status: "ok", summary, outputText });
    }
    if (!resolvedDelivery.to) {
      const message = `${params.source.type} delivery target is missing`;
      if (!bestEffortDeliver) {
        return withRunSession({
          status: "error",
          error: message,
          summary,
          outputText,
        });
      }
      logWarn(`[${params.source.type}:${params.source.id}] ${message}`);
      return withRunSession({ status: "ok", summary, outputText });
    }
    try {
      await deliverOutboundPayloads({
        cfg: cfgWithAgentDefaults,
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
        threadId: resolvedDelivery.threadId,
        payloads: deliveryPayloads,
        bestEffort: bestEffortDeliver,
        deps: createOutboundSendDeps(params.deps),
      });
    } catch (err) {
      if (!bestEffortDeliver) {
        return withRunSession({ status: "error", summary, outputText, error: String(err) });
      }
    }
  }

  return withRunSession({ status: "ok", summary, outputText });
}

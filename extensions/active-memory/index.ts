import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRememberAcrossConversations } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { getMemoryCapabilityRegistration } from "openclaw/plugin-sdk/memory-host-core";
import {
  normalizePluginsConfig,
  resolveLivePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { rethrowIncognitoSessionError } from "openclaw/plugin-sdk/session-store-runtime";
import {
  applyCliRuntimeRecallTimeoutDefault,
  hasDeprecatedModelFallbackPolicy,
  normalizePluginConfig,
  readActiveMemoryConfig,
} from "./config.js";
import { resolveRecallEscalationDecision } from "./escalation.js";
import { buildPromptPrefix, buildRecallOutcomePrefix } from "./prompt.js";
import { buildQuery, buildSearchQuery, extractRecentTurns, getModelRef } from "./query.js";
import { forgetActiveRecallRun, toSingleLineErrorMessage } from "./recall-state.js";
import { maybeResolveActiveRecall } from "./recall.js";
import {
  ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT,
  formatActiveMemoryCommandHelp,
  isActiveMemoryGloballyEnabled,
  isActiveMemoryPluginEnabled,
  isAllowedChatId,
  isEligibleInteractiveSession,
  isEnabledForAgent,
  isSessionActiveMemoryDisabled,
  lacksAdminToMutateActiveMemoryGlobal,
  resolveChatType,
  resolveCommandSessionKey,
  setSessionActiveMemoryDisabled,
  shouldSkipActiveMemoryForHarnessSession,
  updateActiveMemoryGlobalEnabledInConfig,
} from "./session-policy.js";
import {
  persistPluginStatusLines,
  prepareActiveMemorySession,
  resolveStatusUpdateAgentId,
  type ActiveMemorySessionSnapshot,
} from "./session.js";
import { createActiveMemoryHookDeadline } from "./transcript.js";
import {
  forgetTriggerRecallRun,
  resolveTriggerRecall,
  type TriggerRecallSource,
} from "./trigger-recall.js";
import {
  ACTIVE_MEMORY_STATUS_PREFIX,
  HOOK_TIMEOUT_RECOVERY_GRACE_MS,
  MAX_SETUP_GRACE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TRIGGER_LOOKUP_SETTLE_RESERVE_MS,
  type ConversationRecallContext,
} from "./types.js";

export default definePluginEntry({
  id: "active-memory",
  name: "Active Memory",
  description: "Proactively surfaces relevant memory before eligible conversational replies.",
  register(api: OpenClawPluginApi) {
    const readCurrentConfig = () => readActiveMemoryConfig(api);
    const resolveSelectedRecallToolNames = (cfg: OpenClawConfig) => {
      const selectedPluginId = normalizePluginsConfig(cfg.plugins).slots.memory;
      const registration = getMemoryCapabilityRegistration();
      if (!registration || registration.pluginId !== selectedPluginId) {
        return undefined;
      }
      return registration.capability.recallToolNames;
    };
    const initialConfig = readCurrentConfig();
    let config = normalizePluginConfig(
      api.pluginConfig,
      initialConfig,
      resolveSelectedRecallToolNames(initialConfig),
    );
    const warnDeprecatedModelFallbackPolicy = (pluginConfig: unknown) => {
      if (hasDeprecatedModelFallbackPolicy(pluginConfig)) {
        // modelFallback is a last model-selection candidate, never runtime failover.
        api.logger.warn?.(
          "active-memory: config.modelFallbackPolicy is deprecated and no longer changes runtime behavior. " +
            "config.modelFallback is a chain-resolution last-resort (consulted only when config.model, " +
            "the current run's model, and the agent's configured default all resolve to nothing) — " +
            "it is NOT a runtime failover that substitutes a different model when the resolved model errors out.",
        );
      }
    };
    warnDeprecatedModelFallbackPolicy(api.pluginConfig);
    const refreshLiveConfigFromRuntime = () => {
      const livePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "active-memory",
        api.pluginConfig as Record<string, unknown>,
      );
      const liveConfig = readCurrentConfig();
      const effectivePluginConfig = !isActiveMemoryPluginEnabled(liveConfig)
        ? { enabled: false }
        : (livePluginConfig ?? {});
      config = normalizePluginConfig(
        effectivePluginConfig,
        liveConfig,
        resolveSelectedRecallToolNames(liveConfig),
      );
      if (livePluginConfig) {
        warnDeprecatedModelFallbackPolicy(livePluginConfig);
      }
    };
    api.registerCommand({
      name: "active-memory",
      description: "Enable, disable, or inspect Active Memory for this session.",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      handler: async (ctx) => {
        const tokens = ctx.args?.trim().split(/\s+/).filter(Boolean) ?? [];
        const isGlobal = tokens.includes("--global");
        const action = (tokens.find((token) => token !== "--global") ?? "status").toLowerCase();
        if (action === "help") {
          return { text: formatActiveMemoryCommandHelp() };
        }
        const enabled = ["on", "enable", "enabled"].includes(action)
          ? true
          : ["off", "disable", "disabled"].includes(action)
            ? false
            : undefined;
        refreshLiveConfigFromRuntime();
        if (isGlobal) {
          const currentConfig = api.runtime.config.current() as OpenClawConfig;
          if (action === "status") {
            return {
              text: `Active Memory: ${isActiveMemoryGloballyEnabled(currentConfig) ? "on" : "off"} globally.`,
            };
          }
          if (
            lacksAdminToMutateActiveMemoryGlobal({
              senderIsOwner: ctx.senderIsOwner,
              gatewayClientScopes: ctx.gatewayClientScopes,
            })
          ) {
            return {
              text: ACTIVE_MEMORY_GLOBAL_MUTATION_ADMIN_REQUIRED_TEXT,
            };
          }
          if (enabled !== undefined) {
            await api.runtime.config.mutateConfigFile({
              afterWrite: { mode: "auto" },
              writeOptions: {
                assertCurrent: Array.isArray(ctx.gatewayClientScopes)
                  ? undefined
                  : ctx.assertOwnerCurrent,
              },
              mutate: (draft) => {
                const nextConfig = updateActiveMemoryGlobalEnabledInConfig(draft, enabled);
                Object.assign(draft, nextConfig);
              },
            });
            refreshLiveConfigFromRuntime();
            return { text: `Active Memory: ${enabled ? "on" : "off"} globally.` };
          }
        }
        const sessionKey = await resolveCommandSessionKey({
          api,
          config,
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
        });
        if (!sessionKey) {
          return {
            text: "Active Memory: session toggle unavailable because this command has no session context.",
          };
        }
        const commandAgentId = resolveStatusUpdateAgentId({ sessionKey });
        const liveConfig = readCurrentConfig();
        const triggerRecallConfigured = isEnabledForAgent(config, commandAgentId);
        const rememberEnabled =
          config.enabled && resolveRememberAcrossConversations(liveConfig, commandAgentId);
        if (!triggerRecallConfigured && !rememberEnabled) {
          return { text: "Active Memory: off for this session." };
        }
        if (action === "status") {
          const disabled = await isSessionActiveMemoryDisabled({ api, sessionKey });
          return {
            text: [
              `Active Memory: ${disabled ? "off" : "on"} for this session.`,
              `Trigger recall configuration: ${triggerRecallConfigured ? "on" : "off"} for agent ${commandAgentId}.`,
              `Remember across conversations setting: ${rememberEnabled ? "on" : "off"}.`,
            ].join("\n"),
          };
        }
        if (enabled !== undefined) {
          await setSessionActiveMemoryDisabled({ api, sessionKey, disabled: !enabled });
          if (!enabled) {
            await persistPluginStatusLines({ api, agentId: commandAgentId, sessionKey });
          }
          return { text: `Active Memory: ${enabled ? "on" : "off"} for this session.` };
        }
        return {
          text: `Unknown Active Memory action: ${action}\n\n${formatActiveMemoryCommandHelp()}`,
        };
      },
    });

    // Preflight and recall own separate deadlines. Reserve enough hook time for
    // both maxima so preflight latency cannot consume recall settlement time.
    const beforePromptBuildTimeoutMs =
      MAX_TIMEOUT_MS + MAX_SETUP_GRACE_TIMEOUT_MS + HOOK_TIMEOUT_RECOVERY_GRACE_MS * 2;
    // Actionable skips stay visible even when optional recall logging is off.
    const logRecallSkipped = (reason: string) => {
      api.logger.info?.(`active-memory: recall skipped reason=${reason}`);
    };
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const toolAuthority = ctx.toolAuthority;
        if (!toolAuthority) {
          // Defensive only: the host filters authority-required registrations
          // out of the unauthorized pass, so this never runs in production.
          api.logger.debug?.(
            "active-memory: recall skipped because this prompt has no turn tool authority",
          );
          return undefined;
        }
        toolAuthority.assertActive();
        refreshLiveConfigFromRuntime();
        const liveConfig = readCurrentConfig();
        // Resolve the runner's CLI budget before arming any recall deadlines.
        const timeoutAgentId = resolveStatusUpdateAgentId(ctx);
        const timeoutModelRef =
          (timeoutAgentId
            ? getModelRef(liveConfig, timeoutAgentId, config, {
                modelProviderId: ctx.modelProviderId,
                modelId: ctx.modelId,
              })
            : { provider: ctx.modelProviderId, model: ctx.modelId }) ?? {};
        const cliDispatchEligibility =
          await api.runtime.agent.resolveCliBackendDispatchEligibilityAsync({
            provider: timeoutModelRef.provider,
            model: timeoutModelRef.model,
            config: liveConfig,
            ...(timeoutAgentId
              ? {
                  agentId: timeoutAgentId,
                  agentDir: resolveAgentDir(liveConfig, timeoutAgentId),
                  workspaceDir: resolveAgentWorkspaceDir(liveConfig, timeoutAgentId),
                }
              : {}),
          });
        const invocationConfig = applyCliRuntimeRecallTimeoutDefault(
          config,
          cliDispatchEligibility !== undefined,
        );
        const authorityAllowedRecallTools = invocationConfig.toolsAllow.filter((toolName) =>
          toolAuthority.allows(toolName),
        );
        const liveRecallTimeoutMs =
          invocationConfig.timeoutMs +
          invocationConfig.setupGraceTimeoutMs +
          HOOK_TIMEOUT_RECOVERY_GRACE_MS;
        const deadlineController = new AbortController();
        const hookDeadline = createActiveMemoryHookDeadline();
        const armHookDeadline = (timeoutMs: number, phase: "preflight" | "recall") => {
          hookDeadline.arm(timeoutMs, () => {
            deadlineController.abort(
              new Error(`active-memory ${phase} timeout after ${timeoutMs}ms`),
            );
            api.logger.warn?.(
              `active-memory: before_prompt_build ${phase} timed out after ${String(timeoutMs)}ms; skipping memory lookup`,
            );
          });
        };
        armHookDeadline(HOOK_TIMEOUT_RECOVERY_GRACE_MS, "preflight");
        const handlerPromise = (async () => {
          try {
            const resolvedAgentId = resolveStatusUpdateAgentId(ctx);
            const storePath = api.runtime.agent.session.resolveStorePath(
              liveConfig.session?.store,
              {
                agentId: resolvedAgentId || undefined,
              },
            );
            let preparedSession: ActiveMemorySessionSnapshot | undefined;
            let resolvedSessionKey = ctx.sessionKey?.trim() || undefined;
            if (!resolvedSessionKey && resolvedAgentId) {
              preparedSession = await prepareActiveMemorySession({
                api,
                agentId: resolvedAgentId,
                sessionId: ctx.sessionId,
                storePath,
              });
              resolvedSessionKey = preparedSession.sessionKey;
            }
            const effectiveAgentId =
              resolvedAgentId || resolveStatusUpdateAgentId({ sessionKey: resolvedSessionKey });
            // Publication is the final boundary: recall that settled after its deadline,
            // tool authority, hook lifetime, or memory audience lapsed is never injected.
            const publishPrependContext = (parts: Array<string | undefined>) => {
              const prependContext = parts.filter(Boolean).join("\n");
              if (!prependContext) {
                return undefined;
              }
              deadlineController.signal.throwIfAborted();
              toolAuthority.assertActive();
              ctx.hookInvocation?.assertActive();
              ctx.assertMemoryAudienceCurrent?.();
              return { prependContext };
            };
            const skipRecall = async (reason: string) => {
              logRecallSkipped(reason);
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
              });
            };
            if (authorityAllowedRecallTools.length === 0) {
              await persistPluginStatusLines({
                api,
                agentId: effectiveAgentId,
                sessionKey: resolvedSessionKey,
                statusLine: `${ACTIVE_MEMORY_STATUS_PREFIX} status=policy-disabled`,
              });
              logRecallSkipped("policy-disabled");
              toolAuthority.assertActive();
              return undefined;
            }
            preparedSession ??= resolvedSessionKey
              ? await prepareActiveMemorySession({
                  api,
                  agentId: effectiveAgentId,
                  sessionKey: resolvedSessionKey,
                  storePath,
                })
              : { entry: undefined, readFailed: false };
            if (shouldSkipActiveMemoryForHarnessSession(preparedSession)) {
              logRecallSkipped("harness-session");
              return undefined;
            }
            const sessionDisabled = await isSessionActiveMemoryDisabled({
              api,
              sessionKey: resolvedSessionKey,
            });
            deadlineController.signal.throwIfAborted();
            toolAuthority.assertActive();
            if (sessionDisabled) {
              await skipRecall("session-disabled");
              return undefined;
            }
            const sessionContext = {
              ...ctx,
              sessionKey: resolvedSessionKey ?? ctx.sessionKey,
            };
            if (!isEligibleInteractiveSession(sessionContext)) {
              await skipRecall("session-ineligible");
              return undefined;
            }
            const destinationContext = {
              ...sessionContext,
              mainKey: liveConfig.session?.mainKey ?? api.config.session?.mainKey,
            };
            // Use the producer's request, never infer it from user-controlled envelope markers.
            const currentUserMessage = event.currentUserMessage ?? event.prompt;
            if (event.currentUserMessage !== undefined && !currentUserMessage.trim()) {
              api.logger.debug?.("active-memory: recall skipped reason=no-current-text");
              return undefined;
            }
            // Omission preserves legacy producers. Explicit text without an admission ID
            // cannot identify a request, even when the correlation runId and text match.
            const requestKey =
              event.currentUserMessage === undefined
                ? undefined
                : event.currentUserMessageId
                  ? JSON.stringify({
                      message: currentUserMessage,
                      messageId: event.currentUserMessageId,
                    })
                  : null;
            const recentTurns = extractRecentTurns(event.messages);
            const searchQuery = buildSearchQuery({
              latestUserMessage: currentUserMessage,
              recentTurns,
            });
            const memorySlot = normalizePluginsConfig(liveConfig.plugins).slots.memory;
            const memoryCapabilityRegistration = getMemoryCapabilityRegistration();
            const memoryCapability =
              memoryCapabilityRegistration && memoryCapabilityRegistration.pluginId === memorySlot
                ? memoryCapabilityRegistration.capability
                : undefined;
            const deterministicRecallToolName = memoryCapability?.deterministicRecallToolName;
            const chatType = resolveChatType(destinationContext);
            const privateDestination = chatType === "direct" || chatType === "explicit";
            const chatIdAllowed = isAllowedChatId(invocationConfig, destinationContext);
            const activeMemoryConfigured = isEnabledForAgent(invocationConfig, effectiveAgentId);
            let laneOne: { context?: string; hasStrongHit: boolean; injectedCount: number } = {
              hasStrongHit: false,
              injectedCount: 0,
            };
            // Tool policy gates lane one on the slot owner's own recall tools: every recall
            // tool a native provider declares, or a legacy owner's deterministic recall tool.
            const nativeRecallToolNames = memoryCapability?.providerRuntime
              ? (memoryCapability.recallToolNames ?? [])
              : undefined;
            const laneOneSource: TriggerRecallSource | undefined = nativeRecallToolNames
              ? resolvedSessionKey &&
                nativeRecallToolNames.length > 0 &&
                nativeRecallToolNames.every((toolName) => toolAuthority.allows(toolName))
                ? {
                    kind: "native",
                    context: {
                      authority: {
                        kind: "session",
                        sessionKey: resolvedSessionKey,
                        sessionId: ctx.sessionId,
                        sandboxed: ctx.sandboxed === true,
                        audience: ctx.memoryAudience,
                      },
                      signal: deadlineController.signal,
                      assertCurrent() {
                        deadlineController.signal.throwIfAborted();
                        toolAuthority.assertActive();
                        ctx.hookInvocation?.assertActive();
                        ctx.assertMemoryAudienceCurrent?.();
                      },
                    },
                  }
                : undefined
              : deterministicRecallToolName &&
                  authorityAllowedRecallTools.includes(deterministicRecallToolName)
                ? { kind: "legacy" }
                : undefined;
            if (
              activeMemoryConfigured &&
              effectiveAgentId &&
              laneOneSource &&
              privateDestination &&
              chatIdAllowed
            ) {
              toolAuthority.assertActive();
              // Leave headroom to start model recall before the preflight watchdog;
              // even a zero-delay trigger timeout can lose that race.
              const triggerLookupTimeoutMs =
                hookDeadline.remainingMs() - TRIGGER_LOOKUP_SETTLE_RESERVE_MS;
              if (triggerLookupTimeoutMs > 0) {
                laneOne = await resolveTriggerRecall({
                  cfg: liveConfig,
                  agentId: effectiveAgentId,
                  source: laneOneSource,
                  query: searchQuery,
                  message: currentUserMessage,
                  activeProjectKeys: ctx.activeProjectKeys,
                  signal: AbortSignal.timeout(triggerLookupTimeoutMs),
                  runId: ctx.runId,
                  requestKey,
                  authorityFingerprint: toolAuthority.fingerprint,
                  debug: (message) => api.logger.debug?.(message),
                }).catch((error: unknown) => {
                  rethrowIncognitoSessionError(error);
                  api.logger.debug?.(
                    `active-memory: lane-1 trigger recall failed: ${toSingleLineErrorMessage(error)}`,
                  );
                  return { hasStrongHit: false, injectedCount: 0 };
                });
                toolAuthority.assertActive();
                if (laneOne.context && laneOne.injectedCount > 0 && invocationConfig.logging) {
                  api.logger.info?.(
                    `active-memory: lane-1 injected ${laneOne.injectedCount} trigger-matched entries`,
                  );
                }
              } else {
                api.logger.debug?.(
                  "active-memory: lane-1 trigger recall skipped: preflight budget exhausted",
                );
              }
            } else if (invocationConfig.enabled && effectiveAgentId && !activeMemoryConfigured) {
              const line = `active-memory: lane-1 skipped reason=agent-not-configured agent=${effectiveAgentId}`;
              api.logger.debug?.(line);
              if (invocationConfig.logging) {
                api.logger.info?.(line);
              }
            }
            const laneOneContext = laneOne.context;
            const activeMemoryAllowed =
              activeMemoryConfigured &&
              chatType !== undefined &&
              invocationConfig.allowedChatTypes.includes(chatType) &&
              chatIdAllowed;
            const productRecallRequested = Boolean(
              invocationConfig.enabled &&
              resolvedSessionKey &&
              resolveRememberAcrossConversations(liveConfig, effectiveAgentId) &&
              privateDestination &&
              chatIdAllowed,
            );
            const productRecallEligible =
              productRecallRequested && memoryCapability?.supportsPrivateTranscriptRecall === true;
            if (productRecallRequested && !productRecallEligible) {
              api.logger.warn?.(
                "active-memory: the current memory provider does not support protected private transcript recall; skipping Remember across conversations",
              );
            }
            const productRecallToolName =
              productRecallEligible &&
              deterministicRecallToolName &&
              authorityAllowedRecallTools.includes(deterministicRecallToolName)
                ? deterministicRecallToolName
                : undefined;
            const productRecallAllowed = Boolean(productRecallToolName);
            if (productRecallEligible && !productRecallAllowed) {
              api.logger.warn?.(
                `active-memory: ${deterministicRecallToolName ?? "the provider's direct recall tool"} is unavailable; skipping Remember across conversations private transcript recall`,
              );
            }
            if (!activeMemoryAllowed && !productRecallAllowed) {
              await skipRecall("destination-not-allowed");
              return publishPrependContext([laneOneContext]);
            }
            const escalationDecision = resolveRecallEscalationDecision({
              mode: invocationConfig.mode,
              message: currentUserMessage,
              hasStrongLaneOneHit: laneOne.hasStrongHit,
            });
            if (escalationDecision !== "recall") {
              // Ordinary turns intentionally skip recall in the default escalation mode.
              api.logger.debug?.(`active-memory: recall skipped reason=${escalationDecision}`);
              const outcomeContext =
                escalationDecision === "no-recall-intent"
                  ? buildRecallOutcomePrefix("skipped-no-recall-intent")
                  : undefined;
              return publishPrependContext([laneOneContext, outcomeContext]);
            }
            const conversationRecall: ConversationRecallContext | undefined =
              productRecallAllowed && resolvedSessionKey
                ? {
                    anchorSessionKey: resolvedSessionKey,
                    scope: "same-agent-private",
                    corpus: activeMemoryAllowed ? "configured" : "sessions",
                  }
                : undefined;
            const recallConfig =
              productRecallToolName && !activeMemoryAllowed
                ? { ...invocationConfig, toolsAllow: [productRecallToolName] }
                : { ...invocationConfig, toolsAllow: authorityAllowedRecallTools };
            const query = buildQuery({
              latestUserMessage: currentUserMessage,
              recentTurns,
              config: recallConfig,
            });
            // Start recall with its full configured budget. The preceding
            // session/config checks must not consume abort-settlement time.
            armHookDeadline(liveRecallTimeoutMs, "recall");
            toolAuthority.assertActive();
            const result = await maybeResolveActiveRecall({
              api,
              runtimeConfig: liveConfig,
              config: recallConfig,
              agentId: effectiveAgentId,
              sessionKey: resolvedSessionKey,
              sessionId: ctx.sessionId,
              sessionEntry: preparedSession.entry,
              storePath,
              messageProvider: ctx.messageProvider,
              channelId: ctx.channelId,
              query,
              requestKey,
              searchQuery,
              currentModelProviderId: ctx.modelProviderId,
              currentModelId: ctx.modelId,
              conversationRecall,
              abortSignal: deadlineController.signal,
              runId: ctx.runId,
              authorityFingerprint: toolAuthority.fingerprint,
              memorySlot: memorySlot ?? undefined,
              activeProjectKeys: ctx.activeProjectKeys,
              memoryAudience: ctx.memoryAudience,
              assertMemoryAudienceCurrent: ctx.assertMemoryAudienceCurrent,
            });
            const recallContext = result.summary
              ? buildPromptPrefix(result.summary)
              : result.status === "unavailable"
                ? buildRecallOutcomePrefix(result.status)
                : undefined;
            return publishPrependContext([laneOneContext, recallContext]);
          } catch (error) {
            rethrowIncognitoSessionError(error);
            if (deadlineController.signal.aborted) {
              return undefined;
            }
            const message = toSingleLineErrorMessage(error);
            api.logger.warn?.(
              `active-memory: before_prompt_build failed, skipping memory lookup: ${message}`,
            );
            return undefined;
          }
        })();
        try {
          const result = await Promise.race([handlerPromise, hookDeadline.promise]);
          return typeof result === "symbol" ? undefined : result;
        } finally {
          hookDeadline.stop();
        }
      },
      { timeoutMs: beforePromptBuildTimeoutMs, requiresToolAuthority: true },
    );
    api.on("agent_end", (event, ctx) => {
      const runId = event.runId ?? ctx.runId;
      forgetActiveRecallRun(runId);
      forgetTriggerRecallRun(runId);
    });
  },
});

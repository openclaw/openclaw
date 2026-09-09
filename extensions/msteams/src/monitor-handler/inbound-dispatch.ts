// Msteams plugin module dispatches prepared inbound turns and owns reply lifecycle handling.
import { readFile } from "node:fs/promises";
import {
  createChannelInboundEnvelopeBuilder,
  hasFinalInboundReplyDispatch,
  resolveInboundReplyDispatchCounts,
  resolveInboundSupplementalSenderAllowed,
  toInboundMediaFactsWithMetadata,
} from "openclaw/plugin-sdk/channel-inbound";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { codexChannelLoginRuntime } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { setAuthProfileOrder } from "../../../../src/agents/auth-profiles.js";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "../../runtime-api.js";
import { formatUnknownError } from "../errors.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsReplyPolicy } from "../policy.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import { recordMSTeamsSentMessage } from "../sent-message-cache.js";
import type { admitMSTeamsMessage } from "./access.js";
import { resolveMSTeamsSenderAccess } from "./access.js";
import type { prepareMSTeamsInboundContent } from "./inbound-content.js";
import type { assembleMSTeamsInboundFacts } from "./inbound-facts.js";
import { createMSTeamsSmokeProofTrace } from "./smoke-proof-trace.js";
import type { prepareMSTeamsThreadRouting, resolveMSTeamsThreadContext } from "./thread-context.js";

type MSTeamsInboundDispatchResult =
  | { kind: "completed"; finalResponses: number }
  | { kind: "failed" };

type MSTeamsEmployeeContainerDispatchConfig = {
  enabled?: boolean;
  gatewayUrlTemplate?: string;
  tokenConfigPathTemplate?: string;
  agentId?: string;
  waitTimeoutMs?: number;
};

type GatewayAgentAccepted = {
  runId?: string;
};

type GatewayAgentWaitResult = {
  status?: string;
  error?: string;
  terminalReply?: {
    text?: string;
  };
};

type TeamsLoginDeviceCode = {
  title: string;
  code: string;
  expiresInMinutes?: number;
  message?: string;
};

function formatTeamsLoginDeviceCode(params: TeamsLoginDeviceCode): string {
  return [
    params.title,
    "",
    params.message?.trim(),
    "Open https://auth.openai.com/codex/device and enter this code:",
    params.code,
    params.expiresInMinutes
      ? `Code expires in ${params.expiresInMinutes} minutes. Never share it.`
      : "Never share this code.",
  ]
    .filter((line): line is string => Boolean(line && line.trim()))
    .join("\n");
}

type EmployeeContainerOpenClawConfig = OpenClawConfig & {
  agents?: {
    defaults?: { workspace?: string; model?: string };
    entries?: Record<
      string,
      { workspace?: string; agentDir?: string; model?: string; name?: string }
    >;
  };
};

function readEmployeeContainerDispatchConfig(
  cfg: OpenClawConfig,
): MSTeamsEmployeeContainerDispatchConfig | undefined {
  return cfg.channels?.msteams?.employeeContainerDispatch as
    | MSTeamsEmployeeContainerDispatchConfig
    | undefined;
}

function fillEmployeeTemplate(template: string, agentId: string): string {
  return template.replaceAll("{agentId}", agentId);
}

function resolveEmployeeGatewayUrl(
  dispatchCfg: MSTeamsEmployeeContainerDispatchConfig,
  agentId: string,
): string {
  return fillEmployeeTemplate(
    dispatchCfg.gatewayUrlTemplate ??
      "ws://employee-agent-{agentId}_employee-agent-{agentId}:18789",
    agentId,
  );
}

function resolveEmployeeConfigPath(
  dispatchCfg: MSTeamsEmployeeContainerDispatchConfig,
  agentId: string,
): string {
  return fillEmployeeTemplate(
    dispatchCfg.tokenConfigPathTemplate ??
      "/srv/openclaw/data/employee-agents/{agentId}/config/openclaw.json",
    agentId,
  );
}

async function readEmployeeContainerConfig(
  dispatchCfg: MSTeamsEmployeeContainerDispatchConfig,
  agentId: string,
): Promise<EmployeeContainerOpenClawConfig> {
  return JSON.parse(
    await readFile(resolveEmployeeConfigPath(dispatchCfg, agentId), "utf8"),
  ) as EmployeeContainerOpenClawConfig;
}

async function readEmployeeGatewayToken(
  dispatchCfg: MSTeamsEmployeeContainerDispatchConfig,
  agentId: string,
): Promise<string> {
  const parsed = await readEmployeeContainerConfig(dispatchCfg, agentId);
  const token = parsed.gateway?.auth?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error(`employee container gateway token missing for ${agentId}`);
  }
  return token;
}

function resolveEmployeeHostRoot(
  dispatchCfg: MSTeamsEmployeeContainerDispatchConfig,
  agentId: string,
): string {
  const configPath = resolveEmployeeConfigPath(dispatchCfg, agentId);
  const suffix = "/config/openclaw.json";
  if (!configPath.endsWith(suffix)) {
    throw new Error(`employee container config path must end with ${suffix} to start Codex login`);
  }
  return configPath.slice(0, -suffix.length);
}

function prepareEmployeeCodexLoginConfig(params: {
  cfg: EmployeeContainerOpenClawConfig;
  hostRoot: string;
  employeeAgentId: string;
}): EmployeeContainerOpenClawConfig {
  const cloned = JSON.parse(JSON.stringify(params.cfg)) as EmployeeContainerOpenClawConfig;
  cloned.agents = cloned.agents ?? {};
  cloned.agents.defaults = {
    ...cloned.agents.defaults,
    workspace: `${params.hostRoot}/workspace`,
  };
  cloned.agents.entries = cloned.agents.entries ?? {};
  const entry = cloned.agents.entries[params.employeeAgentId] ?? {};
  cloned.agents.entries[params.employeeAgentId] = {
    ...entry,
    workspace: `${params.hostRoot}/workspace`,
    agentDir: `${params.hostRoot}/state/.openclaw/agents/${params.employeeAgentId}/agent`,
  };
  return cloned;
}

function resolveEmployeeContainerSessionKey(routeAgentId: string, sessionKey: string): string {
  const prefix = `agent:${routeAgentId}:`;
  return sessionKey.startsWith(prefix)
    ? `agent:main:${sessionKey.slice(prefix.length)}`
    : sessionKey;
}

function shouldDispatchToEmployeeContainer(params: {
  cfg: OpenClawConfig;
  isDirectMessage: boolean;
  routeAgentId: string;
}): MSTeamsEmployeeContainerDispatchConfig | undefined {
  const dispatchCfg = readEmployeeContainerDispatchConfig(params.cfg);
  if (dispatchCfg?.enabled !== true) {
    return undefined;
  }
  if (!params.isDirectMessage) {
    return undefined;
  }
  if (!params.routeAgentId || params.routeAgentId === "main") {
    return undefined;
  }
  return dispatchCfg;
}

function isMissingOpenAIAuthError(err: unknown): boolean {
  const message = formatUnknownError(err);
  return /401 Unauthorized/u.test(message) && /Missing bearer/u.test(message);
}

function isEmployeeContainerAuthEnrollmentTriggerError(err: unknown): boolean {
  return isMissingOpenAIAuthError(err);
}

export async function startEmployeeCodexDeviceLogin(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  routeAgentId: string;
  delivery?: ReturnType<typeof createMSTeamsReplyDispatcher>["delivery"];
  settleDelivery?: ReturnType<
    typeof createMSTeamsReplyDispatcher
  >["dispatcherOptions"]["onSettled"];
  sendText?: (text: string) => Promise<void>;
  log: MSTeamsMessageHandlerDeps["log"];
}): Promise<MSTeamsInboundDispatchResult | undefined> {
  const dispatchCfg = readEmployeeContainerDispatchConfig(params.cfg);
  if (dispatchCfg?.enabled !== true) {
    return undefined;
  }
  const employeeAgentId = dispatchCfg.agentId?.trim() || "main";
  const hostRoot = resolveEmployeeHostRoot(dispatchCfg, params.routeAgentId);
  const employeeCfg = prepareEmployeeCodexLoginConfig({
    cfg: await readEmployeeContainerConfig(dispatchCfg, params.routeAgentId),
    hostRoot,
    employeeAgentId,
  });
  let finalResponses = 0;
  const deliverText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (params.sendText) {
      await params.sendText(trimmed);
    } else if (params.delivery) {
      const delivered = await params.delivery.deliver({ text: trimmed }, {
        kind: "final",
        stage: "final",
      } as never);
      // Device-code prompts are produced before the login flow completes, so
      // flush the queued Teams reply now instead of waiting for the final login
      // completion path to settle the dispatcher.
      await params.settleDelivery?.();
      await delivered?.finalization;
    } else {
      throw new Error("employee Codex login delivery target missing");
    }
    finalResponses += 1;
  };

  const loginResult = await codexChannelLoginRuntime.runDeviceLoginFlow({
    provider: "openai",
    agentId: employeeAgentId,
    config: employeeCfg,
    runtime: params.runtime,
    sendMessage: deliverText,
    sendDeviceCode: async (deviceCode) => {
      await deliverText(formatTeamsLoginDeviceCode(deviceCode));
    },
    unsupportedPromptMessage: "Teams onboarding supports only fixed Codex device-code auth.",
  });
  const hasOpenAIProfile = loginResult.profiles.some((profile) => profile.provider === "openai");
  const openAIProfileId = loginResult.profiles.find(
    (profile) => profile.provider === "openai",
  )?.profileId;
  if (!hasOpenAIProfile || !openAIProfileId) {
    throw new Error("employee Codex login completed without an OpenAI auth profile");
  }
  const employeeAgentDir = employeeCfg.agents?.entries?.[employeeAgentId]?.agentDir;
  if (!employeeAgentDir) {
    throw new Error(
      `employee Codex login cannot persist OpenAI auth order without an agentDir for ${employeeAgentId}`,
    );
  }
  const updatedAuthStore = await setAuthProfileOrder({
    agentDir: employeeAgentDir,
    provider: "openai",
    order: [openAIProfileId],
  });
  const persistedOrder = updatedAuthStore?.order?.openai;
  if (!persistedOrder?.includes(openAIProfileId)) {
    throw new Error("employee Codex login completed but OpenAI auth order was not persisted");
  }
  await deliverText(
    "Codex login complete. Your main agent has been associated with your frontier provider. Try interacting with your agent, such as asking what its name is or what it knows.",
  );
  await params.settleDelivery?.();
  params.log.info("msteams employee container Codex device-code login complete", {
    routeAgentId: params.routeAgentId,
    finalResponses,
  });
  return { kind: "completed", finalResponses };
}

async function dispatchViaEmployeeContainer(params: {
  cfg: OpenClawConfig;
  routeAgentId: string;
  routeSessionKey: string;
  message: string;
  messageId?: string;
  delivery: ReturnType<typeof createMSTeamsReplyDispatcher>["delivery"];
  settleDelivery?: ReturnType<
    typeof createMSTeamsReplyDispatcher
  >["dispatcherOptions"]["onSettled"];
  log: MSTeamsMessageHandlerDeps["log"];
}): Promise<MSTeamsInboundDispatchResult | undefined> {
  const dispatchCfg = readEmployeeContainerDispatchConfig(params.cfg);
  if (dispatchCfg?.enabled !== true) {
    return undefined;
  }
  const employeeAgentId = dispatchCfg.agentId?.trim() || "main";
  const sessionKey = resolveEmployeeContainerSessionKey(
    params.routeAgentId,
    params.routeSessionKey,
  );
  const url = resolveEmployeeGatewayUrl(dispatchCfg, params.routeAgentId);
  const token = await readEmployeeGatewayToken(dispatchCfg, params.routeAgentId);
  const waitTimeoutMs = Math.max(1, Math.floor(dispatchCfg.waitTimeoutMs ?? 180_000));
  const idempotencyKey = `msteams-employee-container:${params.routeAgentId}:${
    params.messageId ?? sessionKey
  }`;
  params.log.info("dispatching msteams turn to employee container", {
    routeAgentId: params.routeAgentId,
    employeeAgentId,
    sessionKey,
  });
  const accepted = (await callGatewayFromCli(
    "agent",
    { url, token, timeout: String(waitTimeoutMs) },
    {
      agentId: employeeAgentId,
      sessionKey,
      message: params.message,
      idempotencyKey,
      deliver: false,
      timeout: Math.ceil(waitTimeoutMs / 1000),
      sourceReplyDeliveryMode: "automatic",
    },
    { scopes: ["operator.write"] },
  )) as GatewayAgentAccepted;
  if (!accepted.runId) {
    throw new Error("employee container agent run did not return a runId");
  }
  const waitResult = (await callGatewayFromCli(
    "agent.wait",
    { url, token, timeout: String(waitTimeoutMs + 10_000) },
    { runId: accepted.runId, timeoutMs: waitTimeoutMs },
    { scopes: ["operator.write"] },
  )) as GatewayAgentWaitResult;
  if (waitResult.status !== "ok") {
    const errorDetail = waitResult.error?.trim();
    throw new Error(
      `employee container agent run ended with status ${waitResult.status ?? "unknown"}${
        errorDetail ? `: ${errorDetail}` : ""
      }`,
    );
  }
  const text = waitResult.terminalReply?.text?.trim();
  if (!text) {
    return { kind: "completed", finalResponses: 0 };
  }
  const payload: ReplyPayload = { text };
  const result = await params.delivery.deliver(payload, {
    kind: "final",
    stage: "final",
  } as never);
  await params.settleDelivery?.();
  await result?.finalization;
  return { kind: "completed", finalResponses: 1 };
}

export async function dispatchMSTeamsInboundTurn(params: {
  cfg: MSTeamsMessageHandlerDeps["cfg"];
  runtime: RuntimeEnv;
  appId: string;
  app: MSTeamsMessageHandlerDeps["app"];
  tokenProvider: MSTeamsMessageHandlerDeps["tokenProvider"];
  textLimit: number;
  log: MSTeamsMessageHandlerDeps["log"];
  logVerboseMessage: (message: string) => void;
  facts: ReturnType<typeof assembleMSTeamsInboundFacts>;
  admission: NonNullable<Awaited<ReturnType<typeof admitMSTeamsMessage>>>;
  content: NonNullable<Awaited<ReturnType<typeof prepareMSTeamsInboundContent>>>;
  routing: ReturnType<typeof prepareMSTeamsThreadRouting>;
  thread: Awaited<ReturnType<typeof resolveMSTeamsThreadContext>>;
  replyStyle: ReturnType<typeof resolveMSTeamsReplyPolicy>["replyStyle"];
  timestamp?: Date;
  contextVisibilityMode: "all" | "allowlist" | "allowlist_quote";
  mentionWasEffective: boolean;
  conversationHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
}): Promise<MSTeamsInboundDispatchResult> {
  const core = getMSTeamsRuntime();
  const {
    cfg,
    runtime,
    appId,
    app,
    tokenProvider,
    textLimit,
    log,
    logVerboseMessage,
    facts,
    admission,
    content,
    routing,
    thread,
    replyStyle,
    timestamp,
    contextVisibilityMode,
    conversationHistories,
    historyLimit,
  } = params;
  const { context, activity, rawBody, text, quoteInfo, conversationRef } = facts;
  const {
    senderId,
    senderName,
    isDirectMessage,
    allowNameMatching,
    groupPolicy,
    commandAuthorized,
    effectiveGroupAllowFrom,
  } = admission;
  const { route } = routing;
  const { agentBody, inboundMedia } = content;
  const { teamAadGroupId, quoteBodyFull, quoteSenderId, quoteSenderName, threadContext } = thread;
  const { conversationId, conversationType, isChannel, teamId, graphChannelId } = facts;
  const teamsFrom = isDirectMessage
    ? `msteams:${senderId}`
    : isChannel
      ? `msteams:channel:${conversationId}`
      : `msteams:group:${conversationId}`;
  const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;
  const envelopeFrom = isDirectMessage ? senderName : conversationType;
  const buildEnvelope = createChannelInboundEnvelopeBuilder({ cfg, route });
  const body = buildEnvelope({
    channel: "Teams",
    from: envelopeFrom,
    timestamp,
    body: agentBody,
  });
  let combinedBody = body;
  const isRoomish = !isDirectMessage;
  const historyKey = isRoomish ? conversationId : undefined;
  if (isRoomish && historyKey) {
    const channelHistory = createChannelHistoryWindow({
      historyMap: conversationHistories,
    });
    combinedBody = channelHistory.buildPendingContext({
      historyKey,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        buildEnvelope({
          channel: "Teams",
          from: conversationType,
          timestamp: entry.timestamp,
          previousTimestamp: null,
          body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
        }),
    });
  }

  const inboundHistory =
    isRoomish && historyKey && historyLimit > 0
      ? createChannelHistoryWindow({
          historyMap: conversationHistories,
        }).buildInboundHistory({
          historyKey,
          limit: historyLimit,
        })
      : undefined;
  const commandBody = text.trim();
  const quoteSenderAllowed =
    quoteInfo && quoteInfo.sender
      ? resolveInboundSupplementalSenderAllowed({
          isGroup: !isDirectMessage,
          groupPolicy,
          allowFrom: effectiveGroupAllowFrom,
          isSenderAllowed: (allowFrom) =>
            resolveMSTeamsAllowlistMatch({
              allowFrom,
              senderId: quoteSenderId ?? "",
              senderName: quoteSenderName,
              allowNameMatching,
            }).allowed,
        })
      : true;
  const bodyForAgent = threadContext
    ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${agentBody}`
    : agentBody;
  // Teams channel actions need both the AAD group and Graph channel ids.
  const nativeChannelId =
    isChannel && teamAadGroupId ? `${teamAadGroupId}/${graphChannelId}` : undefined;
  // Thread routing owns the final session key, so mint the bound result at dispatch preparation.
  const boundIngress = await resolveMSTeamsSenderAccess({
    cfg,
    activity,
    hasControlCommand: admission.isControlCommand,
    conversationThreadId: facts.threadId,
    contextBinding: {
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      ...(activity.id ? { messageId: activity.id } : {}),
      ...(nativeChannelId ? { nativeChannelId } : {}),
      inboundEventKind: "user_request",
    },
  });
  const ctxPayload = core.channel.inbound.buildContext({
    channelIngress: boundIngress.channelIngress,
    channel: "msteams",
    contextVisibility: contextVisibilityMode,
    supplemental: {
      quote: quoteInfo
        ? {
            id: quoteInfo.id ?? activity.replyToId ?? undefined,
            body: quoteBodyFull ?? quoteInfo.body,
            sender: quoteInfo.sender,
            senderAllowed: quoteSenderAllowed,
            isQuote: true,
          }
        : undefined,
    },
    media: await toInboundMediaFactsWithMetadata(inboundMedia),
    messageId: activity.id,
    timestamp: timestamp?.getTime() ?? Date.now(),
    from: teamsFrom,
    sender: {
      id: senderId,
      name: senderName,
    },
    conversation: {
      kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      id: conversationId,
      label: envelopeFrom,
      spaceId: teamId,
      nativeChannelId,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: teamsTo,
      // A user target is a mutable lookup alias; the conversation id is the
      // authoritative route for message-tool reply suppression.
      originatingTo: `conversation:${conversationId}`,
      // Channel-only thread root (facts.threadId) so messaging-tool evidence matches
      // session/origin thread ids; keep replyToId as parent. Undefined for DM/group.
      messageThreadId: facts.threadId ?? undefined,
      replyToId: activity.replyToId ?? undefined,
      nativeChannelId,
    },
    message: {
      body: combinedBody,
      bodyForAgent,
      inboundHistory,
      rawBody,
      commandBody,
    },
    sessionTranscript: { historyLimit: isRoomish ? historyLimit : 0 },
    access: {
      mentions: {
        canDetectMention: !isDirectMessage,
        wasMentioned: isDirectMessage || params.mentionWasEffective,
      },
      commands: {
        authorized: commandAuthorized === true,
      },
    },
    extra: {
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      ReplyToIsQuote: quoteInfo ? true : undefined,
    },
  });

  const preview = sliceUtf16Safe(rawBody.replace(/\s+/g, " "), 0, 160);
  logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);
  log.info(
    "msteams inbound proof trace",
    createMSTeamsSmokeProofTrace({
      accountId: route.accountId,
      conversationId,
      messageId: activity.id,
      route,
      employeeIntakeSessionVisible: Boolean(ctxPayload.SessionKey && route.agentId),
    }),
  );

  const { dispatcherOptions, delivery, replyOptions } = createMSTeamsReplyDispatcher({
    cfg,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    accountId: route.accountId,
    runtime,
    log,
    app,
    appId,
    conversationRef,
    context,
    replyStyle,
    textLimit,
    onSentMessageIds: (ids) => {
      for (const id of ids) {
        recordMSTeamsSentMessage(conversationId, id);
      }
    },
    tokenProvider,
    sharePointSiteId: cfg.channels?.msteams?.sharePointSiteId,
  });

  const activityClientInfo = activity.entities?.find((entity) => entity.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  const senderTimezone = activityClientInfo?.timezone || conversationRef.timezone;
  const turnConfig =
    senderTimezone && !cfg.agents?.defaults?.userTimezone
      ? {
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: { ...cfg.agents?.defaults, userTimezone: senderTimezone },
          },
        }
      : cfg;
  const employeeContainerDispatch = shouldDispatchToEmployeeContainer({
    cfg,
    isDirectMessage,
    routeAgentId: route.agentId,
  });
  if (employeeContainerDispatch) {
    try {
      const result = await dispatchViaEmployeeContainer({
        cfg: turnConfig,
        routeAgentId: route.agentId,
        routeSessionKey: route.sessionKey,
        message: bodyForAgent,
        messageId: activity.id,
        delivery,
        settleDelivery: dispatcherOptions.onSettled,
        log,
      });
      if (result) {
        log.info("msteams employee container dispatch complete", {
          routeAgentId: route.agentId,
          finalResponses: result.kind === "completed" ? result.finalResponses : 0,
        });
        return result;
      }
    } catch (err) {
      if (isEmployeeContainerAuthEnrollmentTriggerError(err)) {
        log.info("msteams employee container needs auth enrollment; starting device-code login", {
          routeAgentId: route.agentId,
          trigger: formatUnknownError(err),
        });
        const result = await startEmployeeCodexDeviceLogin({
          cfg: turnConfig,
          runtime,
          routeAgentId: route.agentId,
          delivery,
          settleDelivery: dispatcherOptions.onSettled,
          log,
        });
        if (result) {
          log.info("msteams employee container device-code login dispatched", {
            routeAgentId: route.agentId,
            finalResponses: result.kind === "completed" ? result.finalResponses : 0,
          });
          return result;
        }
      }
      log.error("msteams employee container dispatch failed", {
        routeAgentId: route.agentId,
        error: formatUnknownError(err),
      });
      runtime.error(`msteams employee container dispatch failed: ${formatUnknownError(err)}`);
      throw err;
    }
  }
  log.info("dispatching to agent", { sessionKey: route.sessionKey });
  try {
    const turnResult = await core.channel.inbound.run({
      channel: "msteams",
      accountId: route.accountId,
      raw: context,
      adapter: {
        ingest: () => ({
          id: activity.id ?? `${teamsFrom}:${Date.now()}`,
          timestamp: timestamp?.getTime(),
          rawText: rawBody,
          textForAgent: bodyForAgent,
          textForCommands: commandBody,
          raw: activity,
        }),
        resolveTurn: () => ({
          cfg: turnConfig,
          channel: "msteams",
          accountId: route.accountId,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          ctxPayload,
          record: {
            onRecordError: (err) => {
              logVerboseMessage(
                `msteams: failed updating session meta: ${formatUnknownError(err)}`,
              );
            },
          },
          history: {
            isGroup: isRoomish,
            historyKey,
            historyMap: conversationHistories,
            limit: historyLimit,
          },
          dispatcherOptions,
          delivery,
          replyOptions: {
            ...replyOptions,
            ...(facts.turnAdoptionLifecycle
              ? bindIngressLifecycleToReplyOptions(facts.turnAdoptionLifecycle)
              : {}),
          },
        }),
      },
    });
    const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
    const counts = resolveInboundReplyDispatchCounts(dispatchResult);
    log.info("dispatch complete", {
      counts,
    });
    if (hasFinalInboundReplyDispatch(dispatchResult)) {
      logVerboseMessage(
        `msteams: delivered ${counts.final} repl${counts.final === 1 ? "y" : "ies"} to ${teamsTo}`,
      );
    }
    return { kind: "completed", finalResponses: counts.final };
  } catch (err) {
    log.error("dispatch failed", { error: formatUnknownError(err) });
    runtime.error(`msteams dispatch failed: ${formatUnknownError(err)}`);
    if (facts.turnAdoptionLifecycle) {
      throw err;
    }
    try {
      await context.sendActivity("⚠️ Something went wrong. Please try again.");
    } catch {
      // Best effort.
    }
    return { kind: "failed" };
  }
}

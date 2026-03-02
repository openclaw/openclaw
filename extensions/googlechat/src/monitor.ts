import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  GROUP_POLICY_BLOCKED_LABEL,
  createScopedPairingAccess,
  createReplyPrefixOptions,
  readJsonWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveInboundRouteEnvelopeBuilderWithRuntime,
  resolveSingleWebhookTargetAsync,
  resolveWebhookPath,
  resolveWebhookTargets,
  warnMissingProviderGroupPolicyFallbackOnce,
  resolveMentionGatingWithBypass,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk";
import { type ResolvedGoogleChatAccount } from "./accounts.js";
import {
  downloadGoogleChatMedia,
  deleteGoogleChatMessage,
  sendGoogleChatMessage,
  updateGoogleChatMessage,
} from "./api.js";
import { verifyGoogleChatRequest, type GoogleChatAudienceType } from "./auth.js";
import { getGoogleChatRuntime } from "./runtime.js";
import type {
  GoogleChatAnnotation,
  GoogleChatAttachment,
  GoogleChatEvent,
  GoogleChatSpace,
  GoogleChatMessage,
  GoogleChatUser,
} from "./types.js";

export type GoogleChatRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type GoogleChatMonitorOptions = {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  webhookUrl?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type GoogleChatCoreRuntime = ReturnType<typeof getGoogleChatRuntime>;

type WebhookTarget = {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  path: string;
  audienceType?: GoogleChatAudienceType;
  audience?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
};

const webhookTargets = new Map<string, WebhookTarget[]>();
const webhookInFlightLimiter = createWebhookInFlightLimiter();

function logVerbose(core: GoogleChatCoreRuntime, runtime: GoogleChatRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[googlechat] ${message}`);
  }
}

const warnedDeprecatedUsersEmailAllowFrom = new Set<string>();
function warnDeprecatedUsersEmailEntries(
  core: GoogleChatCoreRuntime,
  runtime: GoogleChatRuntimeEnv,
  entries: string[],
) {
  const deprecated = entries.map((v) => String(v).trim()).filter((v) => /^users\/.+@.+/i.test(v));
  if (deprecated.length === 0) {
    return;
  }
  const key = deprecated
    .map((v) => v.toLowerCase())
    .sort()
    .join(",");
  if (warnedDeprecatedUsersEmailAllowFrom.has(key)) {
    return;
  }
  warnedDeprecatedUsersEmailAllowFrom.add(key);
  logVerbose(
    core,
    runtime,
    `Deprecated allowFrom entry detected: "users/<email>" is no longer treated as an email allowlist. Use raw email (alice@example.com) or immutable user id (users/<id>). entries=${deprecated.join(", ")}`,
  );
}

export function registerGoogleChatWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "googlechat",
      source: "googlechat-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleGoogleChatWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  }).unregister;
}

function normalizeAudienceType(value?: string | null): GoogleChatAudienceType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "app-url" || normalized === "app_url" || normalized === "app") {
    return "app-url";
  }
  if (
    normalized === "project-number" ||
    normalized === "project_number" ||
    normalized === "project"
  ) {
    return "project-number";
  }
  return undefined;
}

function extractBearerToken(header: unknown): string {
  const authHeader = Array.isArray(header) ? String(header[0] ?? "") : String(header ?? "");
  return authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice("bearer ".length).trim()
    : "";
}

type ParsedGoogleChatInboundPayload =
  | { ok: true; event: GoogleChatEvent; addOnBearerToken: string }
  | { ok: false };

function parseGoogleChatInboundPayload(
  raw: unknown,
  res: ServerResponse,
): ParsedGoogleChatInboundPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  let eventPayload = raw;
  let addOnBearerToken = "";

  // Transform Google Workspace Add-on format to standard Chat API format.
  const rawObj = raw as {
    commonEventObject?: { hostApp?: string };
    chat?: {
      messagePayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      user?: GoogleChatUser;
      eventTime?: string;
    };
    authorizationEventObject?: { systemIdToken?: string };
  };

  if (rawObj.commonEventObject?.hostApp === "CHAT" && rawObj.chat?.messagePayload) {
    const chat = rawObj.chat;
    const messagePayload = chat.messagePayload;
    eventPayload = {
      type: "MESSAGE",
      space: messagePayload?.space,
      message: messagePayload?.message,
      user: chat.user,
      eventTime: chat.eventTime,
    };
    addOnBearerToken = String(rawObj.authorizationEventObject?.systemIdToken ?? "").trim();
  }

  const event = eventPayload as GoogleChatEvent;
  const eventType = event.type ?? (eventPayload as { eventType?: string }).eventType;
  if (typeof eventType !== "string") {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (!event.space || typeof event.space !== "object" || Array.isArray(event.space)) {
    res.statusCode = 400;
    res.end("invalid payload");
    return { ok: false };
  }

  if (eventType === "MESSAGE") {
    if (!event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
      res.statusCode = 400;
      res.end("invalid payload");
      return { ok: false };
    }
  }

  return { ok: true, event, addOnBearerToken };
}

async function resolveGoogleChatWebhookTargetByBearer(
  targets: readonly WebhookTarget[],
  bearer: string,
) {
  return await resolveSingleWebhookTargetAsync(targets, async (target) => {
    const verification = await verifyGoogleChatRequest({
      bearer,
      audienceType: target.audienceType,
      audience: target.audience,
    });
    return verification.ok;
  });
}

export async function handleGoogleChatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const resolved = resolveWebhookTargets(req, webhookTargets);
  if (!resolved) {
    return false;
  }
  const { path, targets } = resolved;

  const requestLifecycle = beginWebhookRequestPipelineOrReject({
    req,
    res,
    allowMethods: ["POST"],
    requireJsonContentType: true,
    inFlightLimiter: webhookInFlightLimiter,
    inFlightKey: `${path}:${req.socket?.remoteAddress ?? "unknown"}`,
  });
  if (!requestLifecycle.ok) {
    return true;
  }

  try {
    const headerBearer = extractBearerToken(req.headers.authorization);
    let matchedTarget: Awaited<ReturnType<typeof resolveGoogleChatWebhookTargetByBearer>> | null =
      null;
    let parsedEvent: GoogleChatEvent | null = null;
    let addOnBearerToken = "";

    if (headerBearer) {
      matchedTarget = await resolveGoogleChatWebhookTargetByBearer(targets, headerBearer);
      if (matchedTarget.kind === "none") {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
      }
      if (matchedTarget.kind === "ambiguous") {
        res.statusCode = 401;
        res.end("ambiguous webhook target");
        return true;
      }

      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        profile: "post-auth",
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "invalid payload",
      });
      if (!body.ok) {
        return true;
      }

      const parsed = parseGoogleChatInboundPayload(body.value, res);
      if (!parsed.ok) {
        return true;
      }
      parsedEvent = parsed.event;
      addOnBearerToken = parsed.addOnBearerToken;
    } else {
      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        profile: "pre-auth",
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "invalid payload",
      });
      if (!body.ok) {
        return true;
      }

      const parsed = parseGoogleChatInboundPayload(body.value, res);
      if (!parsed.ok) {
        return true;
      }
      parsedEvent = parsed.event;
      addOnBearerToken = parsed.addOnBearerToken;

      if (!addOnBearerToken) {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
      }

      matchedTarget = await resolveGoogleChatWebhookTargetByBearer(targets, addOnBearerToken);
      if (matchedTarget.kind === "none") {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
      }
      if (matchedTarget.kind === "ambiguous") {
        res.statusCode = 401;
        res.end("ambiguous webhook target");
        return true;
      }
    }

    if (!matchedTarget || !parsedEvent) {
      res.statusCode = 401;
      res.end("unauthorized");
      return true;
    }

    const selected = matchedTarget.target;
    selected.statusSink?.({ lastInboundAt: Date.now() });
    processGoogleChatEvent(parsedEvent, selected).catch((err) => {
      selected.runtime.error?.(
        `[${selected.account.accountId}] Google Chat webhook failed: ${String(err)}`,
      );
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
    return true;
  } finally {
    requestLifecycle.release();
  }
}

async function processGoogleChatEvent(event: GoogleChatEvent, target: WebhookTarget) {
  const eventType = event.type ?? (event as { eventType?: string }).eventType;
  if (eventType !== "MESSAGE") {
    return;
  }
  if (!event.message || !event.space) {
    return;
  }

  await processMessageWithPipeline({
    event,
    account: target.account,
    config: target.config,
    runtime: target.runtime,
    core: target.core,
    statusSink: target.statusSink,
    mediaMaxMb: target.mediaMaxMb,
  });
}

function normalizeUserId(raw?: string | null): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^users\//i, "").toLowerCase();
}

function isEmailLike(value: string): boolean {
  // Keep this intentionally loose; allowlists are user-provided config.
  return value.includes("@");
}

export function isSenderAllowed(
  senderId: string,
  senderEmail: string | undefined,
  allowFrom: string[],
  allowNameMatching = false,
) {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeUserId(senderId);
  const normalizedEmail = senderEmail?.trim().toLowerCase() ?? "";
  return allowFrom.some((entry) => {
    const normalized = String(entry).trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    // Accept `googlechat:<id>` but treat `users/...` as an *ID* only (deprecated `users/<email>`).
    const withoutPrefix = normalized.replace(/^(googlechat|google-chat|gchat):/i, "");
    if (withoutPrefix.startsWith("users/")) {
      return normalizeUserId(withoutPrefix) === normalizedSenderId;
    }

    // Raw email allowlist entries are a break-glass override.
    if (allowNameMatching && normalizedEmail && isEmailLike(withoutPrefix)) {
      return withoutPrefix === normalizedEmail;
    }

    return withoutPrefix.replace(/^users\//i, "") === normalizedSenderId;
  });
}

function resolveGroupConfig(params: {
  groupId: string;
  groupName?: string | null;
  groups?: Record<
    string,
    {
      requireMention?: boolean;
      allow?: boolean;
      enabled?: boolean;
      users?: Array<string | number>;
      systemPrompt?: string;
    }
  >;
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false };
  }
  const normalizedName = groupName?.trim().toLowerCase();
  const candidates = [groupId, groupName ?? "", normalizedName ?? ""].filter(Boolean);
  let entry = candidates.map((candidate) => entries[candidate]).find(Boolean);
  if (!entry && normalizedName) {
    entry = entries[normalizedName];
  }
  const fallback = entries["*"];
  return { entry: entry ?? fallback, allowlistConfigured: true, fallback };
}

function extractMentionInfo(annotations: GoogleChatAnnotation[], botUser?: string | null) {
  const mentionAnnotations = annotations.filter((entry) => entry.type === "USER_MENTION");
  const hasAnyMention = mentionAnnotations.length > 0;
  const botTargets = new Set(["users/app", botUser?.trim()].filter(Boolean) as string[]);
  const wasMentioned = mentionAnnotations.some((entry) => {
    const userName = entry.userMention?.user?.name;
    if (!userName) {
      return false;
    }
    if (botTargets.has(userName)) {
      return true;
    }
    return normalizeUserId(userName) === "app";
  });
  return { hasAnyMention, wasMentioned };
}

/**
 * Resolve bot display name with fallback chain:
 * 1. Account config name
 * 2. Agent name from config
 * 3. "OpenClaw" as generic fallback
 */
function resolveBotDisplayName(params: {
  accountName?: string;
  agentId: string;
  config: OpenClawConfig;
}): string {
  const { accountName, agentId, config } = params;
  if (accountName?.trim()) {
    return accountName.trim();
  }
  const agent = config.agents?.list?.find((a) => a.id === agentId);
  if (agent?.name?.trim()) {
    return agent.name.trim();
  }
  return "OpenClaw";
}

async function processMessageWithPipeline(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  mediaMaxMb: number;
}): Promise<void> {
  const { event, account, config, runtime, core, statusSink, mediaMaxMb } = params;
  const pairing = createScopedPairingAccess({
    core,
    channel: "googlechat",
    accountId: account.accountId,
  });
  const space = event.space;
  const message = event.message;
  if (!space || !message) {
    return;
  }

  const spaceId = space.name ?? "";
  if (!spaceId) {
    return;
  }
  const spaceType = (space.type ?? "").toUpperCase();
  const isGroup = spaceType !== "DM";
  const sender = message.sender ?? event.user;
  const senderId = sender?.name ?? "";
  const senderName = sender?.displayName ?? "";
  const senderEmail = sender?.email ?? undefined;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

  const allowBots = account.config.allowBots === true;
  if (!allowBots) {
    if (sender?.type?.toUpperCase() === "BOT") {
      logVerbose(core, runtime, `skip bot-authored message (${senderId || "unknown"})`);
      return;
    }
    if (senderId === "users/app") {
      logVerbose(core, runtime, "skip app-authored message");
      return;
    }
  }

  const messageText = (message.argumentText ?? message.text ?? "").trim();
  const attachments = message.attachment ?? [];
  const hasMedia = attachments.length > 0;
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) {
    return;
  }

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.googlechat !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "googlechat",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.space,
    log: (message) => logVerbose(core, runtime, message),
  });
  const groupConfigResolved = resolveGroupConfig({
    groupId: spaceId,
    groupName: space.displayName ?? null,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
  let effectiveWasMentioned: boolean | undefined;

  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `drop group message (groupPolicy=disabled, space=${spaceId})`);
      return;
    }
    const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
    const groupAllowed = Boolean(groupEntry) || Boolean((account.config.groups ?? {})["*"]);
    if (groupPolicy === "allowlist") {
      if (!groupAllowlistConfigured) {
        logVerbose(
          core,
          runtime,
          `drop group message (groupPolicy=allowlist, no allowlist, space=${spaceId})`,
        );
        return;
      }
      if (!groupAllowed) {
        logVerbose(core, runtime, `drop group message (not allowlisted, space=${spaceId})`);
        return;
      }
    }
    if (groupEntry?.enabled === false || groupEntry?.allow === false) {
      logVerbose(core, runtime, `drop group message (space disabled, space=${spaceId})`);
      return;
    }

    if (groupUsers.length > 0) {
      warnDeprecatedUsersEmailEntries(
        core,
        runtime,
        groupUsers.map((v) => String(v)),
      );
      const ok = isSenderAllowed(
        senderId,
        senderEmail,
        groupUsers.map((v) => String(v)),
        allowNameMatching,
      );
      if (!ok) {
        logVerbose(core, runtime, `drop group message (sender not allowed, ${senderId})`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));
  const normalizedGroupUsers = groupUsers.map((v) => String(v));
  const senderGroupPolicy =
    groupPolicy === "disabled"
      ? "disabled"
      : normalizedGroupUsers.length > 0
        ? "allowlist"
        : "open";
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeAuth)
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];
  const access = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy,
    groupPolicy: senderGroupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: normalizedGroupUsers,
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) =>
      isSenderAllowed(senderId, senderEmail, allowFrom, allowNameMatching),
  });
  const effectiveAllowFrom = access.effectiveAllowFrom;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
  warnDeprecatedUsersEmailEntries(core, runtime, effectiveAllowFrom);
  const commandAllowFrom = isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(
    senderId,
    senderEmail,
    commandAllowFrom,
    allowNameMatching,
  );
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (isGroup) {
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const annotations = message.annotations ?? [];
    const mentionInfo = extractMentionInfo(annotations, account.config.botUser);
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "googlechat",
    });
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention,
      canDetectMention: true,
      wasMentioned: mentionInfo.wasMentioned,
      implicitMention: false,
      hasAnyMention: mentionInfo.hasAnyMention,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
      commandAuthorized: commandAuthorized === true,
    });
    effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (mentionGate.shouldSkip) {
      logVerbose(core, runtime, `drop group message (mention required, space=${spaceId})`);
      return;
    }
  }

  if (isGroup && access.decision !== "allow") {
    logVerbose(
      core,
      runtime,
      `drop group message (sender policy blocked, reason=${access.reason}, space=${spaceId})`,
    );
    return;
  }

  if (!isGroup) {
    if (account.config.dm?.enabled === false) {
      logVerbose(core, runtime, `Blocked Google Chat DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        const { code, created } = await pairing.upsertPairingRequest({
          id: senderId,
          meta: { name: senderName || undefined, email: senderEmail },
        });
        if (created) {
          logVerbose(core, runtime, `googlechat pairing request sender=${senderId}`);
          try {
            await sendGoogleChatMessage({
              account,
              space: spaceId,
              text: core.channel.pairing.buildPairingReply({
                channel: "googlechat",
                idLine: `Your Google Chat user id: ${senderId}`,
                code,
              }),
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            logVerbose(core, runtime, `pairing reply failed for ${senderId}: ${String(err)}`);
          }
        }
      } else {
        logVerbose(
          core,
          runtime,
          `Blocked unauthorized Google Chat sender ${senderId} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `googlechat: drop control command from ${senderId}`);
    return;
  }

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config,
    channel: "googlechat",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? ("group" as const) : ("direct" as const),
      id: spaceId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (attachments.length > 0) {
    const first = attachments[0];
    const attachmentData = await downloadAttachment(first, account, mediaMaxMb, core);
    if (attachmentData) {
      mediaPath = attachmentData.path;
      mediaType = attachmentData.contentType;
    }
  }

  const fromLabel = isGroup
    ? space.displayName || `space:${spaceId}`
    : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: event.eventTime ? Date.parse(event.eventTime) : undefined,
    body: rawBody,
  });

  const groupSystemPrompt = groupConfigResolved.entry?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `googlechat:${senderId}`,
    To: `googlechat:${spaceId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    SenderUsername: senderEmail,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    CommandAuthorized: commandAuthorized,
    Provider: "googlechat",
    Surface: "googlechat",
    MessageSid: message.name,
    MessageSidFull: message.name,
    ReplyToId: message.thread?.name,
    ReplyToIdFull: message.thread?.name,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    GroupSpace: isGroup ? (space.displayName ?? undefined) : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    OriginatingChannel: "googlechat",
    OriginatingTo: `googlechat:${spaceId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`googlechat: failed updating session meta: ${String(err)}`);
    });

  // Typing indicator setup
  // Note: Reaction mode requires user OAuth, not available with service account auth.
  // If reaction is configured, we fall back to message mode with a warning.
  let typingIndicator = account.config.typingIndicator ?? "message";
  if (typingIndicator === "reaction") {
    runtime.error?.(
      `[${account.accountId}] typingIndicator="reaction" requires user OAuth (not supported with service account). Falling back to "message" mode.`,
    );
    typingIndicator = "message";
  }
  let typingMessageName: string | undefined;

  // Start typing indicator (message mode only, reaction mode not supported with app auth)
  if (typingIndicator === "message") {
    try {
      const botName = resolveBotDisplayName({
        accountName: account.config.name,
        agentId: route.agentId,
        config,
      });
      const result = await sendGoogleChatMessage({
        account,
        space: spaceId,
        text: `_${botName} is typing..._`,
        thread: message.thread?.name,
      });
      typingMessageName = result?.messageName;
    } catch (err) {
      runtime.error?.(`Failed sending typing message: ${String(err)}`);
    }
  }

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "googlechat",
    accountId: route.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload) => {
        await deliverGoogleChatReply({
          payload,
          account,
          spaceId,
          runtime,
          core,
          config,
          statusSink,
          typingMessageName,
        });
        // Only use typing message for first delivery
        typingMessageName = undefined;
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

async function downloadAttachment(
  attachment: GoogleChatAttachment,
  account: ResolvedGoogleChatAccount,
  mediaMaxMb: number,
  core: GoogleChatCoreRuntime,
): Promise<{ path: string; contentType?: string } | null> {
  const resourceName = attachment.attachmentDataRef?.resourceName;
  if (!resourceName) {
    return null;
  }
  const maxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const downloaded = await downloadGoogleChatMedia({ account, resourceName, maxBytes });
  const saved = await core.channel.media.saveMediaBuffer(
    downloaded.buffer,
    downloaded.contentType ?? attachment.contentType,
    "inbound",
    maxBytes,
    attachment.contentName,
  );
  return { path: saved.path, contentType: saved.contentType };
}

async function deliverGoogleChatReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  typingMessageName?: string;
}): Promise<void> {
  const { payload, account, spaceId, runtime, core, config, statusSink, typingMessageName } =
    params;
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let suppressCaption = false;
    if (typingMessageName) {
      try {
        await deleteGoogleChatMessage({
          account,
          messageName: typingMessageName,
        });
      } catch (err) {
        runtime.error?.(`Google Chat typing cleanup failed: ${String(err)}`);
        const fallbackText = payload.text?.trim()
          ? payload.text
          : mediaList.length > 1
            ? "Sent attachments."
            : "Sent attachment.";
        try {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: fallbackText,
          });
          suppressCaption = Boolean(payload.text?.trim());
        } catch (updateErr) {
          runtime.error?.(`Google Chat typing update failed: ${String(updateErr)}`);
        }
      }
    }
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first && !suppressCaption ? payload.text : undefined;
      first = false;
      try {
        const loaded = await core.channel.media.fetchRemoteMedia({
          url: mediaUrl,
          maxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
        });
        const upload = await uploadAttachmentForReply({
          account,
          spaceId,
          buffer: loaded.buffer,
          contentType: loaded.contentType,
          filename: loaded.fileName ?? "attachment",
        });
        if (!upload.attachmentUploadToken) {
          throw new Error("missing attachment upload token");
        }
        await sendGoogleChatMessage({
          account,
          space: spaceId,
          text: caption,
          thread: payload.replyToId,
          attachments: [
            { attachmentUploadToken: upload.attachmentUploadToken, contentName: loaded.fileName },
          ],
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Google Chat attachment send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 4000;
    const chunkMode = core.channel.text.resolveChunkMode(config, "googlechat", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        // Edit typing message with first chunk if available
        if (i === 0 && typingMessageName) {
          await updateGoogleChatMessage({
            account,
            messageName: typingMessageName,
            text: chunk,
          });
        } else {
          await sendGoogleChatMessage({
            account,
            space: spaceId,
            text: chunk,
            thread: payload.replyToId,
          });
        }
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Google Chat message send failed: ${String(err)}`);
      }
    }
  }
}

async function uploadAttachmentForReply(params: {
  account: ResolvedGoogleChatAccount;
  spaceId: string;
  buffer: Buffer;
  contentType?: string;
  filename: string;
}) {
  const { account, spaceId, buffer, contentType, filename } = params;
  const { uploadGoogleChatAttachment } = await import("./api.js");
  return await uploadGoogleChatAttachment({
    account,
    space: spaceId,
    filename,
    buffer,
    contentType,
  });
}

export function monitorGoogleChatProvider(options: GoogleChatMonitorOptions): () => void {
  const core = getGoogleChatRuntime();
  const webhookPath = resolveWebhookPath({
    webhookPath: options.webhookPath,
    webhookUrl: options.webhookUrl,
    defaultPath: "/googlechat",
  });
  if (!webhookPath) {
    options.runtime.error?.(`[${options.account.accountId}] invalid webhook path`);
    return () => {};
  }

  const audienceType = normalizeAudienceType(options.account.config.audienceType);
  const audience = options.account.config.audience?.trim();
  const mediaMaxMb = options.account.config.mediaMaxMb ?? 20;

  const unregisterTarget = registerGoogleChatWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    audienceType,
    audience,
    statusSink: options.statusSink,
    mediaMaxMb,
  });

  return () => {
    unregisterTarget();
  };
}

export async function startGoogleChatMonitor(
  params: GoogleChatMonitorOptions,
): Promise<() => void> {
  return monitorGoogleChatProvider(params);
}

export function resolveGoogleChatWebhookPath(params: {
  account: ResolvedGoogleChatAccount;
}): string {
  return (
    resolveWebhookPath({
      webhookPath: params.account.config.webhookPath,
      webhookUrl: params.account.config.webhookUrl,
      defaultPath: "/googlechat",
    }) ?? "/googlechat"
  );
}

export function computeGoogleChatMediaMaxMb(params: { account: ResolvedGoogleChatAccount }) {
  return params.account.config.mediaMaxMb ?? 20;
}

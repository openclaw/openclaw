import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  createReplyPrefixOptions,
  formatPairingApproveHint,
  resolveSenderCommandAuthorization,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { NostrProfile } from "./config-schema.js";
import { NostrConfigSchema } from "./config-schema.js";
import type { MetricEvent, MetricsSnapshot } from "./metrics.js";
import { buildAiInfoFingerprint, type AiInfoContent } from "./nostr-ai-info.js";
import {
  normalizePubkey,
  startNostrBus,
  type NostrBusHandle,
  type NostrInboundMessage,
} from "./nostr-bus.js";
import type { ProfilePublishResult } from "./nostr-profile.js";
import { nostrOnboardingAdapter } from "./onboarding.js";
import { getNostrRuntime } from "./runtime.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
  type ResolvedNostrAccount,
} from "./types.js";

const CHANNEL_ID = "nostr" as const;
const NIP63_RESPONSE_KIND_STATUS = 25800;
const NIP63_RESPONSE_KIND_TOOL = 25804;
const NIP63_RESPONSE_KIND_DELTA = 25801;
const NIP63_RESPONSE_KIND_FINAL = 25803;
const NIP63_RESPONSE_KIND_ERROR = 25805;
const AI_INFO_DEFAULT_PROVIDER = "anthropic";
const AI_INFO_DEFAULT_MODEL = "claude-opus-4-6";
const AI_INFO_ENCRYPTION_SCHEME = "nip44";
const NOSTR_TRACE_JSONL_ENV = "OPENCLAW_NOSTR_TRACE_JSONL";

type ModelSelectionSnapshot = {
  provider: string;
  model: string;
  thinkLevel: string | undefined;
};

export function resolveNostrSessionId(
  senderPubkey: string,
  explicitSessionId: string | undefined,
): string {
  const explicit = explicitSessionId?.trim();
  if (explicit?.length) {
    return explicit;
  }
  return `sender:${senderPubkey.toLowerCase()}`;
}

export function resolveNostrTimestampMs(createdAtSeconds: number): number {
  return createdAtSeconds * 1000;
}

function resolveResponseKindFromDispatcherKind(kind: "tool" | "block" | "final"): number {
  if (kind === "tool") {
    return NIP63_RESPONSE_KIND_TOOL;
  }
  if (kind === "block") {
    return NIP63_RESPONSE_KIND_DELTA;
  }
  return NIP63_RESPONSE_KIND_FINAL;
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function createRunTraceId(runId: string): string {
  return `nostr-${runId.slice(0, 12)}-${Date.now().toString(36)}`;
}

function normalizeToolPhase(raw: string | undefined): "start" | "result" {
  const phase = raw?.trim().toLowerCase();
  return phase === "start" ? "start" : "result";
}

type TraceLoggerLike = {
  warn?: (message: string) => void;
};

type NostrTraceRecorder = {
  enabled: boolean;
  record: (entry: Record<string, unknown>) => void;
};

function createNostrTraceRecorder(accountId: string, logger?: TraceLoggerLike): NostrTraceRecorder {
  const path =
    process.env[NOSTR_TRACE_JSONL_ENV]?.trim() ?? process.env.NOSTR_TRACE_JSONL?.trim() ?? "";
  if (!path) {
    return {
      enabled: false,
      record: () => undefined,
    };
  }

  let initialized = false;
  let warned = false;

  return {
    enabled: true,
    record: (entry) => {
      try {
        if (!initialized) {
          mkdirSync(dirname(path), { recursive: true });
          initialized = true;
        }
        appendFileSync(
          path,
          `${JSON.stringify({
            ts: new Date().toISOString(),
            account_id: accountId,
            ...entry,
          })}\n`,
          "utf8",
        );
      } catch (error) {
        if (warned) {
          return;
        }
        warned = true;
        logger?.warn?.(`failed writing Nostr trace JSONL (${path}): ${String(error)}`);
      }
    },
  };
}

function parseTracePayload(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.trim().length) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function buildStatusPayload(params: {
  state: "thinking" | "tool_use" | "done";
  runId: string;
  sessionId: string;
  traceId: string;
  info?: string;
  progress?: number;
}): Record<string, unknown> {
  const timestampMs = Date.now();
  return {
    ver: 1,
    state: params.state,
    ...(params.info ? { info: params.info } : {}),
    ...(typeof params.progress === "number" ? { progress: params.progress } : {}),
    timestamp: Math.floor(timestampMs / 1000),
    timestamp_ms: timestampMs,
    run_id: params.runId,
    session_id: params.sessionId,
    trace_id: params.traceId,
  };
}

function resolveNostrSessionKey(baseSessionKey: string, sessionId: string): string {
  return `${baseSessionKey}:session:${sessionId}`;
}

function parseConfiguredModelRef(raw: unknown): ModelSelectionSnapshot | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("/")) {
    const [provider, ...rest] = trimmed.split("/");
    const model = rest.join("/").trim();
    if (provider.trim() && model) {
      return {
        provider: provider.trim(),
        model,
        thinkLevel: undefined,
      };
    }
  }
  return {
    provider: AI_INFO_DEFAULT_PROVIDER,
    model: trimmed,
    thinkLevel: undefined,
  };
}

function buildAiInfoContent(params: {
  cfg: unknown;
  selected?: ModelSelectionSnapshot;
}): AiInfoContent {
  const cfg = (params.cfg ?? {}) as {
    agents?: {
      defaults?: {
        model?: string | { primary?: string };
        models?: Record<string, unknown>;
      };
    };
  };

  const configuredModel = (() => {
    const raw = cfg.agents?.defaults?.model;
    if (typeof raw === "string") {
      return parseConfiguredModelRef(raw);
    }
    return parseConfiguredModelRef(raw?.primary);
  })();

  const selected = params.selected ?? configuredModel;
  const defaultModel = selected?.model ?? AI_INFO_DEFAULT_MODEL;

  const supportedModels = new Set<string>();
  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    const parsed = parseConfiguredModelRef(key);
    if (parsed?.model) {
      supportedModels.add(parsed.model);
    }
  }
  supportedModels.add(defaultModel);

  return {
    ver: 1,
    supports_streaming: true,
    supports_nip59: false,
    dvm_compatible: false,
    encryption: [AI_INFO_ENCRYPTION_SCHEME],
    supported_models: [...supportedModels],
    default_model: defaultModel,
    tool_names: [],
    tool_schema_version: 1,
  };
}

function normalizeNostrAllowValue(value: string): string {
  const cleaned = value.replace(/^nostr:/i, "").trim();
  if (!cleaned) {
    return "";
  }
  try {
    return normalizePubkey(cleaned).toLowerCase();
  } catch {
    return cleaned.toLowerCase();
  }
}

function isNostrSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  const normalizedSender = normalizeNostrAllowValue(senderId);
  if (!normalizedSender) {
    return false;
  }
  for (const entry of allowFrom) {
    const cleaned = String(entry).trim();
    if (!cleaned) {
      continue;
    }
    if (cleaned === "*") {
      return true;
    }
    if (normalizeNostrAllowValue(cleaned) === normalizedSender) {
      return true;
    }
  }
  return false;
}

// Store active bus handles per account
const activeBuses = new Map<string, NostrBusHandle>();

// Store metrics snapshots per account (for status reporting)
const metricsSnapshots = new Map<string, MetricsSnapshot>();

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = {
  id: "nostr",
  onboarding: nostrOnboardingAdapter,
  meta: {
    id: "nostr",
    label: "Nostr",
    selectionLabel: "Nostr",
    docsPath: "/channels/nostr",
    docsLabel: "nostr",
    blurb: "Nostr AI agent messages via NIP-63 (NIP-44 encrypted)",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct"], // Messages only for MVP
    media: false, // No media for MVP
  },
  reload: { configPrefixes: ["channels.nostr"] },
  configSchema: buildChannelConfigSchema(NostrConfigSchema),

  config: {
    listAccountIds: (cfg) => listNostrAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNostrAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNostrAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNostrAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          if (entry === "*") {
            return "*";
          }
          try {
            return normalizePubkey(entry);
          } catch {
            return entry; // Keep as-is if normalization fails
          }
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "nostrPubkey",
    normalizeAllowEntry: (entry) => {
      try {
        return normalizePubkey(entry.replace(/^nostr:/i, ""));
      } catch {
        return entry;
      }
    },
    notifyApproval: async ({ id }) => {
      // Get the default account's bus and send approval message
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) {
        await bus.sendDm(id, "Your pairing request has been approved!");
      }
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      const configuredAllowFrom = account.config.allowFrom ?? [];
      const hasWildcardAllowFrom = configuredAllowFrom.some(
        (entry) => String(entry).trim() === "*",
      );
      const hasAllowFrom = configuredAllowFrom.length > 0;
      const inferredPolicy = hasWildcardAllowFrom ? "open" : hasAllowFrom ? "allowlist" : "pairing";

      return {
        policy: account.config.dmPolicy ?? inferredPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.nostr.dmPolicy",
        allowFromPath: "channels.nostr.allowFrom",
        approveHint: formatPairingApproveHint("nostr"),
        normalizeEntry: (raw) => {
          try {
            return normalizePubkey(raw.replace(/^nostr:/i, "").trim());
          } catch {
            return raw.trim();
          }
        },
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      // Strip nostr: prefix if present
      const cleaned = target.replace(/^nostr:/i, "").trim();
      try {
        return normalizePubkey(cleaned);
      } catch {
        return cleaned;
      }
    },
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
      },
      hint: "<npub|hex pubkey|nostr:npub...>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const core = getNostrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Nostr bus not running for account ${aid}`);
      }
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "nostr",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
      const normalizedTo = normalizePubkey(to.replace(/^nostr:/i, "").trim());
      await bus.sendDm(normalizedTo, message);
      return {
        channel: "nostr" as const,
        to: normalizedTo,
        messageId: `nostr-${Date.now()}`,
      };
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      publicKey: snapshot.publicKey ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
      profile: account.profile,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        publicKey: account.publicKey,
      });
      ctx.log?.info(
        `[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`,
      );

      if (!account.configured) {
        throw new Error("Nostr private key not configured");
      }

      const runtime = getNostrRuntime();
      const traceRecorder = createNostrTraceRecorder(account.accountId, ctx.log);
      let lastAiInfoFingerprint: string | null = null;
      let lastSelectedModel: ModelSelectionSnapshot | undefined;

      // Track bus handle for metrics callback
      let busHandle: NostrBusHandle | null = null;
      const publishAiInfoIfNeeded = async (cfg: unknown, reason: string): Promise<void> => {
        if (!busHandle) {
          return;
        }

        const payload = buildAiInfoContent({
          cfg,
          selected: lastSelectedModel,
        });
        const fingerprint = buildAiInfoFingerprint(payload);
        if (fingerprint === lastAiInfoFingerprint) {
          ctx.log?.debug?.(`[${account.accountId}] 31340 unchanged, skipping (${reason})`);
          return;
        }

        try {
          const result = await busHandle.publishAiInfo(payload);
          if (result.successes.length > 0) {
            lastAiInfoFingerprint = fingerprint;
          }
          traceRecorder.record({
            direction: "ai_info",
            reason,
            event_id: result.eventId,
            relays_ok: result.successes.length,
            relays_failed: result.failures.length,
          });
          if (result.failures.length > 0) {
            ctx.log?.warn?.(
              `[${account.accountId}] 31340 partial publish (${reason}): ok=${result.successes.length} failed=${result.failures.length}`,
            );
            return;
          }
          ctx.log?.debug?.(
            `[${account.accountId}] 31340 published (${reason}) event=${result.eventId}`,
          );
        } catch (err) {
          traceRecorder.record({
            direction: "ai_info",
            reason,
            error: String(err),
          });
          ctx.log?.warn?.(
            `[${account.accountId}] 31340 publish failed (${reason}): ${String(err)}`,
          );
        }
      };

      const bus = await startNostrBus({
        accountId: account.accountId,
        privateKey: account.privateKey,
        relays: account.relays,
        onSend: ({
          senderPubkey,
          recipientPubkey,
          senderRole,
          recipientRole,
          responseKind,
          relays,
          eventId,
          decryptedPayload,
        }) => {
          const payloadSuffix = decryptedPayload ? ` payload=${decryptedPayload}` : "";
          const parsedPayload = parseTracePayload(decryptedPayload);
          ctx.log?.debug?.(
            `[${account.accountId}] Nostr outbound send (${responseKind}) event=${eventId} ${senderRole}->${recipientRole}: ${senderPubkey} -> ${recipientPubkey} via relays ${relays.join(", ")}${payloadSuffix}`,
          );
          traceRecorder.record({
            direction: "outbound",
            response_kind: responseKind,
            event_id: eventId,
            sender_pubkey: senderPubkey,
            recipient_pubkey: recipientPubkey,
            relays,
            run_id: typeof parsedPayload?.run_id === "string" ? parsedPayload.run_id : undefined,
            session_id:
              typeof parsedPayload?.session_id === "string" ? parsedPayload.session_id : undefined,
            trace_id:
              typeof parsedPayload?.trace_id === "string" ? parsedPayload.trace_id : undefined,
            payload: parsedPayload ?? undefined,
          });
        },
        onMessage: async (inbound, reply) => {
          const payload: NostrInboundMessage = inbound;
          const config = runtime.config.loadConfig();
          const senderPubkey = payload.senderPubkey.toLowerCase();
          const rawText = payload.text;
          const fallbackSessionId = resolveNostrSessionId(senderPubkey, payload.sessionId);
          traceRecorder.record({
            direction: "inbound",
            event_id: payload.eventId,
            kind: payload.kind,
            sender_pubkey: senderPubkey,
            session_id: fallbackSessionId,
            text_bytes: Buffer.byteLength(rawText, "utf8"),
            text_preview: rawText.slice(0, 160),
          });
          const configAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
          const hasWildcardAllowFrom = configAllowFrom.some((entry) => entry.trim() === "*");
          const inferredPolicy = hasWildcardAllowFrom
            ? "open"
            : configAllowFrom.length > 0
              ? "allowlist"
              : "pairing";
          const dmPolicy = account.config.dmPolicy ?? inferredPolicy;
          const { commandAuthorized, senderAllowedForCommands } =
            await resolveSenderCommandAuthorization({
              cfg: config,
              rawBody: rawText,
              isGroup: false,
              dmPolicy,
              configuredAllowFrom: configAllowFrom,
              senderId: senderPubkey,
              isSenderAllowed: isNostrSenderAllowed,
              readAllowFromStore: () => runtime.channel.pairing.readAllowFromStore(CHANNEL_ID),
              shouldComputeCommandAuthorized: (body, cfg) =>
                runtime.channel.commands.shouldComputeCommandAuthorized(body, cfg),
              resolveCommandAuthorizedFromAuthorizers: (params) =>
                runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
            });
          const dmAllowed = dmPolicy === "open" || senderAllowedForCommands;

          ctx.log?.debug?.(
            `[${account.accountId}] message from ${senderPubkey} (kind ${payload.kind}): ${rawText.slice(0, 50)}...`,
          );

          if (dmPolicy === "disabled") {
            ctx.log?.debug?.(
              `[${account.accountId}] dropped Nostr DM from ${senderPubkey} (dmPolicy=disabled)`,
            );
            return;
          }
          if (!dmAllowed) {
            if (dmPolicy === "pairing") {
              const { code, created } = await runtime.channel.pairing.upsertPairingRequest({
                channel: CHANNEL_ID,
                id: senderPubkey,
                meta: { name: senderPubkey },
              });
              ctx.log?.debug?.(
                `[${account.accountId}] pairing request sender=${senderPubkey} created=${created}`,
              );
              if (created) {
                try {
                  await reply(
                    runtime.channel.pairing.buildPairingReply({
                      channel: CHANNEL_ID,
                      idLine: `Your Nostr pubkey: ${senderPubkey}`,
                      code,
                    }),
                    payload.kind === 25802
                      ? {
                          sessionId: resolveNostrSessionId(senderPubkey, payload.sessionId),
                          inReplyTo: payload.eventId,
                        }
                      : undefined,
                    payload.kind === 4 ? 4 : NIP63_RESPONSE_KIND_FINAL,
                  );
                } catch (err) {
                  ctx.log?.debug?.(
                    `[${account.accountId}] pairing reply failed for ${senderPubkey}: ${String(err)}`,
                  );
                }
              }
            } else {
              ctx.log?.debug?.(
                `[${account.accountId}] dropped Nostr DM from ${senderPubkey} (dmPolicy=${dmPolicy})`,
              );
            }
            return;
          }

          const route = runtime.channel.routing.resolveAgentRoute({
            cfg: config,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            peer: {
              kind: "direct",
              id: senderPubkey,
            },
          });

          const sessionId = resolveNostrSessionId(senderPubkey, payload.sessionId);
          const sessionKey = resolveNostrSessionKey(route.mainSessionKey, sessionId);
          const fromLabel = `Nostr user ${senderPubkey}`;

          const storePath = runtime.channel.session.resolveStorePath(config.session?.store, {
            agentId: route.agentId,
          });
          const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(config);
          const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey,
          });
          const createdAtMs = resolveNostrTimestampMs(payload.createdAt);

          const body = runtime.channel.reply.formatAgentEnvelope({
            channel: "Nostr",
            from: fromLabel,
            body: rawText,
            timestamp: createdAtMs,
            previousTimestamp,
            envelope: envelopeOptions,
          });

          const ctxPayload = runtime.channel.reply.finalizeInboundContext({
            Body: body,
            BodyForAgent: rawText,
            RawBody: rawText,
            CommandBody: rawText,
            From: `nostr:${senderPubkey}`,
            To: `nostr:${senderPubkey}`,
            SessionKey: sessionKey,
            AccountId: route.accountId,
            ChatType: "direct",
            ConversationLabel: fromLabel,
            SenderName: senderPubkey,
            SenderId: senderPubkey,
            Provider: "nostr",
            Surface: "nostr",
            MessageSid: payload.eventId,
            Timestamp: createdAtMs,
            OriginatingChannel: "nostr",
            OriginatingTo: `nostr:${senderPubkey}`,
            CommandAuthorized: commandAuthorized,
          });

          await runtime.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute: {
              sessionKey: route.mainSessionKey,
              channel: CHANNEL_ID,
              to: `nostr:${senderPubkey}`,
              accountId: route.accountId,
            },
            onRecordError: (err) => {
              ctx.log?.error?.(
                `[${account.accountId}] failed updating session meta: ${String(err)}`,
              );
            },
          });

          const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
            cfg: config,
            agentId: route.agentId,
            channel: CHANNEL_ID,
            accountId: route.accountId,
          });
          let runModelSelection: ModelSelectionSnapshot | undefined;
          const onModelSelectedWithAiInfo = (selection: ModelSelectionSnapshot) => {
            runModelSelection = selection;
            lastSelectedModel = selection;
            onModelSelected(selection);
          };
          const traceId = createRunTraceId(payload.eventId);
          let blockSeq = 0;
          const emitStatus = payload.kind === 25802;
          const safeSendStatus = async (
            state: "thinking" | "tool_use" | "done",
            options?: { info?: string; progress?: number },
          ): Promise<void> => {
            if (!emitStatus) {
              return;
            }
            try {
              await reply(
                buildStatusPayload({
                  state,
                  info: options?.info,
                  progress: options?.progress,
                  runId: payload.eventId,
                  sessionId,
                  traceId,
                }),
                {
                  sessionId,
                  inReplyTo: payload.eventId,
                },
                NIP63_RESPONSE_KIND_STATUS,
              );
            } catch (error) {
              ctx.log?.debug?.(
                `[${account.accountId}] Nostr status publish failed (${state}) for ${payload.eventId}: ${String(error)}`,
              );
            }
          };

          try {
            await safeSendStatus("thinking", {
              info: "run_started",
              progress: 0,
            });
            await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg: config,
              dispatcherOptions: {
                ...prefixOptions,
                deliver: async (outbound, info: { kind: "tool" | "block" | "final" }) => {
                  const responseText = (outbound as { text?: string } | undefined)?.text ?? "";
                  const trimmedResponse = responseText.trim();
                  if (!trimmedResponse) {
                    return;
                  }
                  if (info.kind === "final") {
                    await safeSendStatus("done", {
                      info: "run_completed",
                      progress: 100,
                    });
                  }
                  const timestampMs = Date.now();
                  const timestamp = Math.floor(timestampMs / 1000);
                  const normalizedKind = resolveResponseKindFromDispatcherKind(info.kind);
                  const outboundPayload =
                    info.kind === "block"
                      ? {
                          ver: 1,
                          event: "block",
                          phase: "update",
                          text: trimmedResponse,
                          seq: blockSeq++,
                          timestamp,
                          timestamp_ms: timestampMs,
                          run_id: payload.eventId,
                          session_id: sessionId,
                          trace_id: traceId,
                        }
                      : info.kind === "tool"
                        ? {
                            ver: 1,
                            name: "tool",
                            phase: "result",
                            output: { text: trimmedResponse },
                            success: true,
                            timestamp,
                            timestamp_ms: timestampMs,
                            run_id: payload.eventId,
                            session_id: sessionId,
                            trace_id: traceId,
                          }
                        : {
                            ver: 1,
                            text: trimmedResponse,
                            timestamp,
                            timestamp_ms: timestampMs,
                            run_id: payload.eventId,
                            session_id: sessionId,
                            trace_id: traceId,
                          };
                  await reply(
                    outboundPayload,
                    {
                      sessionId,
                      inReplyTo: payload.eventId,
                    },
                    normalizedKind,
                  );
                },
                onSkip: (payload, { kind, reason }) => {
                  ctx.log?.debug?.(
                    `[${account.accountId}] Nostr outbound ${kind} skipped (${reason}) for session ${sessionId} from ${senderPubkey}; payload=${JSON.stringify(payload)}`,
                  );
                },
                onError: (err, info) => {
                  ctx.log?.error?.(
                    `[${account.accountId}] Nostr ${info.kind} reply failed: ${String(err)}`,
                  );
                },
              },
              replyOptions: {
                onModelSelected: onModelSelectedWithAiInfo,
                // NIP-63 clients expect streamed progress events.
                disableBlockStreaming: false,
                onReasoningStream: async (reasoningPayload) => {
                  const reasoningText = (reasoningPayload.text ?? "").trim();
                  if (!reasoningText) {
                    return;
                  }
                  await reply(
                    {
                      ver: 1,
                      event: "thinking",
                      phase: "update",
                      text: reasoningText,
                      timestamp: Math.floor(Date.now() / 1000),
                      timestamp_ms: Date.now(),
                      run_id: payload.eventId,
                      session_id: sessionId,
                      trace_id: traceId,
                    },
                    {
                      sessionId,
                      inReplyTo: payload.eventId,
                    },
                    NIP63_RESPONSE_KIND_DELTA,
                  );
                },
                onToolStart: async ({ name, phase }) => {
                  const normalizedName = typeof name === "string" ? name.trim() : "";
                  if (!normalizedName) {
                    return;
                  }
                  await safeSendStatus("tool_use", {
                    info: normalizedName,
                  });
                  await reply(
                    {
                      ver: 1,
                      name: normalizedName,
                      phase: normalizeToolPhase(phase),
                      timestamp: Math.floor(Date.now() / 1000),
                      timestamp_ms: Date.now(),
                      run_id: payload.eventId,
                      session_id: sessionId,
                      trace_id: traceId,
                    },
                    {
                      sessionId,
                      inReplyTo: payload.eventId,
                    },
                    NIP63_RESPONSE_KIND_TOOL,
                  );
                },
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.log?.error?.(`[${account.accountId}] Nostr run failed: ${message}`);
            traceRecorder.record({
              direction: "run_error",
              event_id: payload.eventId,
              session_id: sessionId,
              trace_id: traceId,
              error: message,
            });
            await reply(
              {
                ver: 1,
                code: "INTERNAL_ERROR",
                message,
                timestamp: Math.floor(Date.now() / 1000),
                timestamp_ms: Date.now(),
                run_id: payload.eventId,
                session_id: sessionId,
                trace_id: traceId,
                details: {
                  run_id: payload.eventId,
                  session_id: sessionId,
                  trace_id: traceId,
                },
              },
              {
                sessionId,
                inReplyTo: payload.eventId,
              },
              NIP63_RESPONSE_KIND_ERROR,
            );
          } finally {
            if (runModelSelection) {
              lastSelectedModel = runModelSelection;
            }
            await publishAiInfoIfNeeded(config, "post-message");
          }
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
        },
        onConnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
        },
        onDisconnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
        },
        onEose: (relays) => {
          ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`);
        },
        onMetric: (event: MetricEvent) => {
          // Log significant metrics at appropriate levels
          if (event.name.startsWith("event.rejected.")) {
            ctx.log?.debug?.(
              `[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`,
            );
          } else if (event.name === "relay.circuit_breaker.open") {
            ctx.log?.warn?.(
              `[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.circuit_breaker.close") {
            ctx.log?.info?.(
              `[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.error") {
            ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
          }
          // Update cached metrics snapshot
          if (busHandle) {
            metricsSnapshots.set(account.accountId, busHandle.getMetrics());
          }
        },
      });

      busHandle = bus;

      // Store the bus handle
      activeBuses.set(account.accountId, bus);
      await publishAiInfoIfNeeded(runtime.config.loadConfig(), "startup");
      ctx.log?.info(
        `[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`,
      );

      let stopped = false;
      const stopBus = (): void => {
        if (stopped) {
          return;
        }
        stopped = true;
        bus.close();
        activeBuses.delete(account.accountId);
        metricsSnapshots.delete(account.accountId);
        ctx.log?.info(`[${account.accountId}] Nostr provider stopped`);
      };

      if (ctx.abortSignal?.aborted) {
        stopBus();
        return;
      }

      await new Promise<void>((resolve) => {
        ctx.abortSignal?.addEventListener(
          "abort",
          () => {
            stopBus();
            resolve();
          },
          { once: true },
        );
      });
    },
  },
};

/**
 * Get metrics snapshot for a Nostr account.
 * Returns undefined if account is not running.
 */
export function getNostrMetrics(
  accountId: string = DEFAULT_ACCOUNT_ID,
): MetricsSnapshot | undefined {
  const bus = activeBuses.get(accountId);
  if (bus) {
    return bus.getMetrics();
  }
  return metricsSnapshots.get(accountId);
}

/**
 * Get all active Nostr bus handles.
 * Useful for debugging and status reporting.
 */
export function getActiveNostrBuses(): Map<string, NostrBusHandle> {
  return new Map(activeBuses);
}

/**
 * Publish a profile (kind:0) for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @param profile - Profile data to publish
 * @returns Publish results with successes and failures
 * @throws Error if account is not running
 */
export async function publishNostrProfile(
  accountId: string = DEFAULT_ACCOUNT_ID,
  profile: NostrProfile,
): Promise<ProfilePublishResult> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${accountId}`);
  }
  return bus.publishProfile(profile);
}

/**
 * Get profile publish state for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @returns Profile publish state or null if account not running
 */
export async function getNostrProfileState(accountId: string = DEFAULT_ACCOUNT_ID): Promise<{
  lastPublishedAt: number | null;
  lastPublishedEventId: string | null;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
} | null> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}

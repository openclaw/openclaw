/**
 * Stimm Voice — OpenClaw plugin entry point.
 *
 * Dual-agent voice sessions: a fast VoiceAgent (Python/LiveKit) handles
 * real-time audio while an OpenClaw Supervisor (TypeScript) provides
 * reasoning, tools, and context via the Stimm data-channel protocol.
 */

import { createHmac, randomBytes, timingSafeEqual, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { Type } from "@sinclair/typebox";
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  WebhookReceiver,
  type VideoGrant,
} from "livekit-server-sdk";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { AgentProcess } from "./src/agent-process.js";
import { registerStimmVoiceCli } from "./src/cli.js";
import { resolveStimmVoiceConfig, type StimmVoiceConfig } from "./src/config.js";
import type { CoreConfig } from "./src/core-bridge.js";
import { startQuickTunnel, type QuickTunnelRuntime } from "./src/quick-tunnel.js";
import { generateStimmResponse, type StimmResponseResult } from "./src/response-generator.js";

// ---------------------------------------------------------------------------
// Tool schema — flat object, no Type.Union (per repo guardrails).
// ---------------------------------------------------------------------------

const ACTIONS = [
  "start_session",
  "end_session",
  "instruct",
  "add_context",
  "set_mode",
  "status",
] as const;

function stringEnum<T extends readonly string[]>(values: T, opts: { description?: string } = {}) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...opts,
  });
}

const StimmVoiceToolSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description: `Action: ${ACTIONS.join(", ")}`,
  }),
  room: Type.Optional(
    Type.String({
      description: "Room name (for end_session, instruct, add_context, set_mode, status)",
    }),
  ),
  channel: Type.Optional(Type.String({ description: "Origin channel for routing (default: web)" })),
  text: Type.Optional(
    Type.String({ description: "Text to instruct the voice agent, or context to add" }),
  ),
  mode: Type.Optional(
    stringEnum(["autonomous", "relay", "hybrid"] as const, { description: "Voice agent mode" }),
  ),
  speak: Type.Optional(
    Type.Boolean({ description: "Whether the voice agent should speak the instruction aloud" }),
  ),
});

type ClaimRecord = {
  claimId: string;
  roomName: string;
  channel: string;
  livekitUrl?: string;
  expiresAt: number;
  disconnectToken?: string;
  disconnectExpiresAt?: number;
  usedAt?: number;
};

type TunnelInfo = {
  gatewayUrl: string;
  livekitUrl: string;
};

type SessionPayload = {
  room: string;
  clientToken: string;
  channel: string;
  createdAt: number;
  disconnectToken?: string;
  livekitUrl?: string;
  claimToken?: string;
  shareUrl?: string;
};

function getGatewayPort(config: CoreConfig): number {
  return (
    (config as Record<string, unknown> & { gateway?: { port?: number } }).gateway?.port ?? 18789
  );
}

function getRequestIp(req: {
  socket?: { remoteAddress?: string | null };
  headers?: Record<string, unknown>;
}): string {
  // Use the socket's remote address for rate limiting — this is the actual
  // connecting IP and cannot be spoofed by the client via headers.
  // X-Forwarded-For is intentionally ignored here to prevent bypass via
  // forged headers when the gateway is not behind a trusted proxy.
  return req.socket?.remoteAddress ?? "unknown";
}

function signClaim(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function verifyClaimSignature(payloadB64: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signClaim(payloadB64, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const stimmVoicePlugin = {
  id: "stimm-voice",
  name: "Stimm Voice",
  description: "Real-time voice conversations powered by Stimm dual-agent architecture",

  register(api: OpenClawPluginApi) {
    const config = resolveStimmVoiceConfig(api.pluginConfig);

    // -- Lazy runtime -------------------------------------------------------
    // Room lifecycle (create, token, delete) is handled here in Node via the
    // LiveKit server SDK. The Python agent (OpenClawSupervisor) connects to
    // each room on its own after being dispatched a job by livekit-agents.

    interface VoiceSession {
      roomName: string;
      clientToken: string;
      createdAt: number;
      originChannel: string;
    }

    let lkRuntime: LiveKitRuntime | null = null;
    let agentProcess: AgentProcess | null = null;
    let tunnelInfo: TunnelInfo | null = null;
    let quickTunnel: QuickTunnelRuntime | null = null;
    // Keep claim signing stable across different OpenClaw processes (CLI vs gateway).
    // If no explicit supervisor secret is configured, fall back to LiveKit API secret.
    const claimSecret = config.access.supervisorSecret || `livekit:${config.livekit.apiSecret}`;
    const claimStore = new Map<string, ClaimRecord>();
    const consumedClaims = new Map<string, number>();
    const claimRateWindowMs = 60_000;
    const claimRateByIp = new Map<string, number[]>();

    const ensureRuntime = async (): Promise<{ lk: LiveKitRuntime }> => {
      if (!config.enabled) {
        throw new Error("[stimm-voice] Plugin is disabled. Set stimm-voice.enabled=true.");
      }
      if (!lkRuntime) {
        lkRuntime = new LiveKitRuntime(config);
      }
      return { lk: lkRuntime };
    };

    const ensureQuickTunnel = async (): Promise<TunnelInfo | null> => {
      if (config.access.mode !== "quick-tunnel") return null;
      if (quickTunnel?.running()) {
        return {
          gatewayUrl: quickTunnel.info.voiceUrl,
          livekitUrl: config.livekit.url,
        };
      }
      const gatewayPort = getGatewayPort(api.config as CoreConfig);
      const started = await startQuickTunnel({
        gatewayPort,
        webPath: config.web.path,
        logger: api.logger,
      });
      if (!started) return null;
      quickTunnel = started;
      return {
        gatewayUrl: started.info.voiceUrl,
        livekitUrl: config.livekit.url,
      };
    };

    const ensureAgentProcessStarted = (): void => {
      if (!config.voiceAgent.spawn.autoSpawn) return;

      if (agentProcess?.running) return;
      if (agentProcess) {
        // Reuse existing process wrapper (restart/backoff state), only re-spawn child.
        agentProcess.start();
        return;
      }

      const pythonPath =
        config.voiceAgent.spawn.pythonPath || AgentProcess.resolveDefaultPythonPath(extensionDir);
      const agentScript =
        config.voiceAgent.spawn.agentScript || AgentProcess.resolveDefaultAgentScript(extensionDir);

      // Forward per-pipeline provider config as STIMM_* env vars.
      const gatewayPort = getGatewayPort(api.config as CoreConfig);
      const env: Record<string, string> = {
        STIMM_AGENT_NAME: "stimm-voice",
        STIMM_PARTICIPANT_IDENTITY: "user",
        STIMM_STT_PROVIDER: config.voiceAgent.stt.provider,
        STIMM_STT_MODEL: config.voiceAgent.stt.model,
        STIMM_TTS_PROVIDER: config.voiceAgent.tts.provider,
        STIMM_TTS_MODEL: config.voiceAgent.tts.model,
        STIMM_TTS_VOICE: config.voiceAgent.tts.voice,
        STIMM_LLM_PROVIDER: config.voiceAgent.llm.provider,
        STIMM_LLM_MODEL: config.voiceAgent.llm.model,
        STIMM_BUFFERING: config.voiceAgent.bufferingLevel,
        STIMM_MODE: config.voiceAgent.mode,
        // Supervisor callback — Python OpenClawSupervisor posts here.
        OPENCLAW_SUPERVISOR_URL: `http://127.0.0.1:${gatewayPort}/stimm/supervisor`,
      };
      // Always pass the secret so the Python agent can authenticate. Falls back to the
      // same derived secret used by the /stimm/supervisor route.
      env.OPENCLAW_SUPERVISOR_SECRET =
        config.access.supervisorSecret || `livekit:${config.livekit.apiSecret}`;
      // Per-pipeline API keys (only set if resolved).
      if (config.voiceAgent.stt.apiKey) env.STIMM_STT_API_KEY = config.voiceAgent.stt.apiKey;
      if (config.voiceAgent.tts.apiKey) env.STIMM_TTS_API_KEY = config.voiceAgent.tts.apiKey;
      if (config.voiceAgent.llm.apiKey) env.STIMM_LLM_API_KEY = config.voiceAgent.llm.apiKey;
      // Language (optional).
      if (config.voiceAgent.stt.language) {
        env.STIMM_STT_LANGUAGE = config.voiceAgent.stt.language;
      }
      if (config.voiceAgent.tts.language) {
        env.STIMM_TTS_LANGUAGE = config.voiceAgent.tts.language;
      }
      // Temperature (optional).
      if (config.voiceAgent.llm.temperature !== undefined) {
        env.STIMM_LLM_TEMPERATURE = config.voiceAgent.llm.temperature.toString();
      }

      agentProcess = new AgentProcess({
        pythonPath,
        agentScript,
        livekitUrl: config.livekit.url,
        livekitApiKey: config.livekit.apiKey,
        livekitApiSecret: config.livekit.apiSecret,
        env,
        maxRestarts: config.voiceAgent.spawn.maxRestarts,
        logger: api.logger,
      });
      agentProcess.start();
    };

    const createClaim = (params: {
      roomName: string;
      channel: string;
    }): {
      token: string;
      record: ClaimRecord;
    } => {
      const now = Date.now();
      const claim: ClaimRecord = {
        claimId: randomHex(6),
        roomName: params.roomName,
        channel: params.channel,
        livekitUrl: tunnelInfo?.livekitUrl ?? config.livekit.url,
        expiresAt: now + config.access.claimTtlSeconds * 1000,
      };
      claimStore.set(claim.claimId, claim);
      const compactPayload = {
        v: 2,
        i: claim.claimId,
        r: claim.roomName,
        e: claim.expiresAt,
        ...(claim.channel !== "web" ? { c: claim.channel } : {}),
      };
      const payloadB64 = deflateRawSync(
        Buffer.from(JSON.stringify(compactPayload), "utf8"),
      ).toString("base64url");
      const signature = signClaim(payloadB64, claimSecret);
      return { token: `${payloadB64}.${signature}`, record: claim };
    };

    const verifyAndConsumeClaim = (token: string): ClaimRecord | null => {
      const [payloadB64, signature] = token.split(".");
      if (!payloadB64 || !signature) return null;
      if (!verifyClaimSignature(payloadB64, signature, claimSecret)) return null;
      let parsed: ClaimRecord;
      try {
        const raw = JSON.parse(
          inflateRawSync(Buffer.from(payloadB64, "base64url")).toString("utf8"),
        ) as
          | {
              claimId?: string;
              roomName?: string;
              channel?: string;
              livekitUrl?: string;
              expiresAt?: number;
              disconnectToken?: string;
              disconnectExpiresAt?: number;
            }
          | { v?: number; i?: string; r?: string; c?: string; e?: number; l?: string };
        if (
          typeof raw === "object" &&
          raw !== null &&
          "i" in raw &&
          typeof raw.i === "string" &&
          typeof raw.r === "string" &&
          typeof raw.e === "number"
        ) {
          parsed = {
            claimId: raw.i,
            roomName: raw.r,
            channel: typeof raw.c === "string" ? raw.c : "web",
            livekitUrl: typeof raw.l === "string" ? raw.l : undefined,
            expiresAt: raw.e,
          };
        } else {
          parsed = raw as ClaimRecord;
        }
      } catch {
        // Backward compatibility: uncompressed payload format.
        try {
          const raw = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as
            | {
                claimId?: string;
                roomName?: string;
                channel?: string;
                livekitUrl?: string;
                expiresAt?: number;
              }
            | { v?: number; i?: string; r?: string; c?: string; e?: number; l?: string };
          if (
            typeof raw === "object" &&
            raw !== null &&
            "i" in raw &&
            typeof raw.i === "string" &&
            typeof raw.r === "string" &&
            typeof raw.e === "number"
          ) {
            parsed = {
              claimId: raw.i,
              roomName: raw.r,
              channel: typeof raw.c === "string" ? raw.c : "web",
              livekitUrl: typeof raw.l === "string" ? raw.l : undefined,
              expiresAt: raw.e,
            };
          } else {
            parsed = raw as ClaimRecord;
          }
        } catch {
          return null;
        }
      }
      if (
        typeof parsed.claimId !== "string" ||
        typeof parsed.roomName !== "string" ||
        typeof parsed.channel !== "string" ||
        typeof parsed.expiresAt !== "number"
      ) {
        return null;
      }
      const now = Date.now();
      if (parsed.expiresAt < now) return null;

      // Cleanup consumed claim markers.
      for (const [claimId, expiry] of consumedClaims.entries()) {
        if (expiry < now) consumedClaims.delete(claimId);
      }

      // If this process has seen this claim already, reject.
      if (consumedClaims.has(parsed.claimId)) return null;

      const stored = claimStore.get(parsed.claimId);
      if (stored) {
        if (stored.usedAt || stored.expiresAt < now) {
          claimStore.delete(parsed.claimId);
          return null;
        }
        stored.usedAt = now;
        claimStore.set(stored.claimId, stored);
        consumedClaims.set(parsed.claimId, stored.expiresAt);
        return stored;
      }

      // Claim not found in local store — may have been created by a sibling
      // process (e.g. CLI voice:start). Accept if the signature is valid, the
      // claim is not expired, and this gateway process has not explicitly
      // consumed or purged it via consumedClaims.
      if (!consumedClaims.has(parsed.claimId)) {
        consumedClaims.set(parsed.claimId, parsed.expiresAt);
        return parsed;
      }
      return null;
    };

    const resolveDisconnectClaim = (
      roomName: string,
      disconnectToken: string,
    ): ClaimRecord | null => {
      const now = Date.now();
      for (const claim of claimStore.values()) {
        if (
          claim.roomName === roomName &&
          claim.disconnectToken === disconnectToken &&
          typeof claim.disconnectExpiresAt === "number" &&
          claim.disconnectExpiresAt >= now
        ) {
          return claim;
        }
      }
      return null;
    };

    // Remove all pending and used claims associated with a room so that stale
    // share links cannot be redeemed after a session is intentionally ended.
    const purgeClaimsForRoom = (roomName: string): void => {
      const now = Date.now();
      for (const [id, claim] of claimStore.entries()) {
        if (claim.roomName === roomName) {
          // Mark in consumedClaims so the stateless fallback in verifyAndConsumeClaim
          // also rejects this claim after the session is ended.
          consumedClaims.set(id, Math.max(claim.expiresAt, now + 60_000));
          claimStore.delete(id);
        }
      }
    };

    const enforceClaimRateLimit = (ip: string): boolean => {
      const now = Date.now();
      const windowStart = now - claimRateWindowMs;
      const existing = claimRateByIp.get(ip) ?? [];
      const recent = existing.filter((ts) => ts >= windowStart);
      if (recent.length >= config.access.claimRateLimitPerMinute) {
        claimRateByIp.set(ip, recent);
        return false;
      }
      recent.push(now);
      claimRateByIp.set(ip, recent);
      return true;
    };

    const isVoiceStartProcess = (): boolean => {
      if (process.title === "openclaw-voice:start") return true;
      return process.argv.some((arg) => arg.includes("voice:start"));
    };

    const maybeShutdownVoiceStartProcess = async (reason: string): Promise<void> => {
      if (!isVoiceStartProcess()) return;
      if (lkRuntime && lkRuntime.listSessions().length > 0) return;

      api.logger.info(
        `[stimm-voice] Last voice session ended (${reason}) — stopping voice:start process.`,
      );

      if (quickTunnel) {
        quickTunnel.stop();
        quickTunnel = null;
      }
      tunnelInfo = null;

      if (agentProcess) {
        agentProcess.stop();
        agentProcess = null;
      }

      if (lkRuntime) {
        await lkRuntime.stopAll();
        lkRuntime = null;
      }

      setTimeout(() => {
        process.exit(0);
      }, 60);
    };

    const createSessionWithAccess = async (params: {
      roomName?: string;
      channel: string;
    }): Promise<SessionPayload> => {
      // ensureRuntime() throws when the plugin is disabled — check it first so
      // ensureAgentProcessStarted() never spawns a background process when disabled.
      const rt = await ensureRuntime();
      ensureAgentProcessStarted();
      const session = await rt.lk.createSession({
        roomName: params.roomName,
        originChannel: params.channel,
        ttlSeconds: config.access.livekitTokenTtlSeconds,
      });

      if (config.access.mode === "quick-tunnel") {
        tunnelInfo = await ensureQuickTunnel();
      }

      const payload = sessionPayload(session, tunnelInfo);
      const now = Date.now();
      if (tunnelInfo?.gatewayUrl) {
        const claim = createClaim({
          roomName: session.roomName,
          channel: params.channel,
        });
        return {
          ...payload,
          claimToken: claim.token,
          shareUrl: `${tunnelInfo.gatewayUrl}?c=${claim.token}`,
        };
      }

      const disconnectRecord: ClaimRecord = {
        claimId: randomBytes(16).toString("hex"),
        roomName: session.roomName,
        channel: params.channel,
        disconnectToken: randomBytes(24).toString("hex"),
        livekitUrl: tunnelInfo?.livekitUrl ?? config.livekit.url,
        expiresAt: now + config.access.claimTtlSeconds * 1000,
        disconnectExpiresAt: now + config.access.livekitTokenTtlSeconds * 1000,
        usedAt: now,
      };
      claimStore.set(disconnectRecord.claimId, disconnectRecord);
      return {
        ...payload,
        disconnectToken: disconnectRecord.disconnectToken,
      };
    };

    // -- Gateway methods ----------------------------------------------------

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    api.registerGatewayMethod(
      "stimm.start",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const session = await createSessionWithAccess({
            roomName: typeof params?.room === "string" ? params.room : undefined,
            channel: typeof params?.channel === "string" ? params.channel : "web",
          });
          respond(true, session);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.end",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          if (!room) {
            respond(false, { error: "room required" });
            return;
          }
          const rt = await ensureRuntime();
          const ok = await rt.lk.endSession(room);
          if (ok) purgeClaimsForRoom(room);
          respond(ok, ok ? { ended: true } : { error: "session not found" });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.instruct",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          const text = typeof params?.text === "string" ? params.text.trim() : "";
          if (!room || !text) {
            respond(false, { error: "room and text required" });
            return;
          }
          const rt = await ensureRuntime();
          if (!rt.lk.getSession(room)) {
            respond(false, { error: "session not found" });
            return;
          }
          // Instructions are now sent via the /stimm/supervisor HTTP endpoint
          // consumed by the Python OpenClawSupervisor directly.
          respond(true, { instructed: true, note: "use /stimm/supervisor for direct injection" });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          if (room) {
            const session = rt.lk.getSession(room);
            respond(true, session ? sessionPayload(session, tunnelInfo) : { found: false });
          } else {
            const sessions = rt.lk.listSessions().map((s) => sessionPayload(s, tunnelInfo));
            respond(true, {
              sessions,
              agent: agentProcess
                ? { running: agentProcess.running, pid: agentProcess.pid }
                : { running: false, pid: null },
            });
          }
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "stimm.mode",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const room = typeof params?.room === "string" ? params.room.trim() : "";
          const mode = typeof params?.mode === "string" ? params.mode.trim() : "";
          if (!room || !mode) {
            respond(false, { error: "room and mode required" });
            return;
          }
          if (!["autonomous", "relay", "hybrid"].includes(mode)) {
            respond(false, { error: `Invalid mode: ${mode}` });
            return;
          }
          // Mode is now managed by the Python OpenClawSupervisor.
          respond(true, { mode, note: "mode changes are applied on the next supervisor tick" });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // -- Tool ---------------------------------------------------------------

    api.registerTool({
      name: "stimm_voice",
      label: "Stimm Voice",
      description:
        "Start, control, and end real-time voice sessions. " +
        "Uses Stimm dual-agent architecture: a fast VoiceAgent handles audio " +
        "while OpenClaw provides reasoning and tools.",
      parameters: StimmVoiceToolSchema,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const json = (payload: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();
          const action = typeof params?.action === "string" ? params.action : "";

          switch (action) {
            case "start_session": {
              const session = await createSessionWithAccess({
                roomName: typeof params.room === "string" ? params.room : undefined,
                channel: typeof params.channel === "string" ? params.channel : "web",
              });
              return json(session);
            }

            case "end_session": {
              const room = String(params.room || "").trim();
              if (!room) throw new Error("room required");
              const ok = await rt.lk.endSession(room);
              if (!ok) throw new Error("session not found");
              purgeClaimsForRoom(room);
              return json({ ended: true, room });
            }

            case "instruct": {
              const room = String(params.room || "").trim();
              const text = String(params.text || "").trim();
              if (!room || !text) throw new Error("room and text required");
              if (!rt.lk.getSession(room)) throw new Error("session not found");
              // Instructions are injected by the Python OpenClawSupervisor via
              // the /stimm/supervisor HTTP endpoint automatically.
              return json({
                instructed: true,
                room,
                note: "use /stimm/supervisor for direct injection",
              });
            }

            case "add_context": {
              const room = String(params.room || "").trim();
              const text = String(params.text || "").trim();
              if (!room || !text) throw new Error("room and text required");
              if (!rt.lk.getSession(room)) throw new Error("session not found");
              return json({
                context_added: true,
                room,
                note: "context is managed by the Python supervisor",
              });
            }

            case "set_mode": {
              const room = String(params.room || "").trim();
              const mode = String(params.mode || "").trim();
              if (!room || !mode) throw new Error("room and mode required");
              if (!["autonomous", "relay", "hybrid"].includes(mode)) {
                throw new Error(`Invalid mode: ${mode}`);
              }
              if (!rt.lk.getSession(room)) throw new Error("session not found");
              return json({
                mode,
                room,
                note: "mode changes are applied on the next supervisor tick",
              });
            }

            case "status": {
              const room = typeof params.room === "string" ? params.room.trim() : "";
              if (room) {
                const session = rt.lk.getSession(room);
                return json(session ? sessionPayload(session, tunnelInfo) : { found: false });
              }
              return json({
                sessions: rt.lk.listSessions().map((s) => sessionPayload(s, tunnelInfo)),
                agent: agentProcess
                  ? { running: agentProcess.running, pid: agentProcess.pid }
                  : { running: false, pid: null },
              });
            }

            default:
              throw new Error(`Unknown action: ${action}`);
          }
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // -- CLI ----------------------------------------------------------------

    const extensionDir = resolve(dirname(api.source));

    api.registerCli(
      ({ program }) =>
        registerStimmVoiceCli({
          program,
          config,
          ensureRuntime: async () => {
            const rt = await ensureRuntime();
            const roomManager = {
              createSession: async (opts: { roomName?: string; originChannel: string }) => {
                const payload = await createSessionWithAccess({
                  roomName: opts.roomName,
                  channel: opts.originChannel,
                });
                return {
                  roomName: payload.room,
                  clientToken: payload.clientToken,
                  createdAt: payload.createdAt,
                  originChannel: payload.channel,
                  supervisor: { connected: Boolean(agentProcess?.running) },
                  shareUrl: payload.shareUrl,
                  claimToken: payload.claimToken,
                };
              },
              endSession: async (room: string) => {
                const ok = await rt.lk.endSession(room);
                if (ok) purgeClaimsForRoom(room);
                return ok;
              },
              listRoomParticipants: (room: string) => rt.lk.listRoomParticipants(room),
              listSessions: () =>
                rt.lk.listSessions().map((s) => ({
                  roomName: s.roomName,
                  clientToken: s.clientToken,
                  createdAt: s.createdAt,
                  originChannel: s.originChannel,
                  supervisor: { connected: Boolean(agentProcess?.running) },
                })),
            };
            return { roomManager };
          },
          logger: api.logger,
          extensionDir,
        }),
      { commands: ["voice"] },
    );

    // -- Service lifecycle --------------------------------------------------

    api.registerService({
      id: "stimm-voice",
      start: async () => {
        if (!config.enabled) return;
        api.logger.info("[stimm-voice] Service started.");
        ensureAgentProcessStarted();

        // Start the quick tunnel lazily (only when a session is created).
      },
      stop: async () => {
        // Clean up quick tunnel.
        if (quickTunnel) {
          quickTunnel.stop();
          quickTunnel = null;
        }
        tunnelInfo = null;

        // Stop the Python agent first.
        if (agentProcess) {
          agentProcess.stop();
          agentProcess = null;
        }

        if (lkRuntime) {
          await lkRuntime.stopAll();
          lkRuntime = null;
          api.logger.info("[stimm-voice] Service stopped — all sessions ended.");
        }
      },
    });

    // -- HTTP route (supervisor callback — called by Python OpenClawSupervisor) -

    api.registerHttpRoute({
      path: "/stimm/supervisor",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        {
          // Always enforce auth — fall back to derived secret when no explicit one is configured,
          // matching the claimSecret derivation above.
          const provided = req.headers["x-stimm-supervisor-secret"];
          const effectiveSecret =
            config.access.supervisorSecret || `livekit:${config.livekit.apiSecret}`;
          const expected = Buffer.from(effectiveSecret, "utf8");
          const actual = Buffer.from(typeof provided === "string" ? provided : "", "utf8");
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
          }
        }
        try {
          const coreConfig = api.config as CoreConfig;
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            roomName: string;
            channel: string;
            history: string;
            systemPrompt?: string;
          };

          if (!body.roomName || !body.history) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "roomName and history required" }));
            return;
          }

          const result = await generateStimmResponse({
            coreConfig,
            roomName: body.roomName,
            channel: body.channel ?? "web",
            text: body.history,
            extraSystemPrompt:
              typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
          });

          if (result.error) {
            api.logger.error(`[stimm-voice] Agent error: ${result.error}`);
          }

          const supervisorText = normalizeSupervisorResponseText(result);
          const supervisorDecision = safeParseSupervisorDecision(supervisorText);
          const preview = truncateSupervisorLogText(
            supervisorDecision?.text ?? (typeof result.text === "string" ? result.text : ""),
            220,
          );

          api.logger.info(
            `[stimm-voice:supervisor] room=${body.roomName} channel=${body.channel ?? "web"} ` +
              `structured_json=${supervisorDecision ? "yes" : "no"} ` +
              `action=${supervisorDecision?.action ?? "n/a"} ` +
              `reason=${supervisorDecision?.reason ?? "n/a"} ` +
              `text_preview="${preview || ""}"`,
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: supervisorText, error: result.error }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    });

    // -- HTTP route (LiveKit webhook — room/participant lifecycle events) ------
    //
    // Configure LiveKit server to POST to <gateway-url>/stimm/livekit-webhook.
    // Events handled:
    //   • participant_left  (identity="user") → end session immediately
    //   • room_finished     (all participants gone) → clean up session map
    //
    // If LiveKit HMAC auth is enabled (it is by default), the signature is
    // verified using the API key/secret already configured in this plugin.

    api.registerHttpRoute({
      path: "/stimm/livekit-webhook",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks).toString("utf8");

          // Verify LiveKit HMAC signature — always required.
          // If LiveKit is not configured to sign webhooks, reject early rather
          // than accepting unsigned payloads (prevents unauthenticated DoS).
          const authHeader = req.headers["authorization"] ?? req.headers["Authorization"];
          if (!authHeader) {
            api.logger.warn(
              "[stimm-voice] Webhook rejected: missing Authorization header. " +
                "Configure LiveKit webhook signing with the same API key/secret.",
            );
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing_authorization" }));
            return;
          }
          const receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);
          const event = await receiver.receive(
            body,
            typeof authHeader === "string" ? authHeader : undefined,
          );

          const roomName = event.room?.name;
          api.logger.debug?.(
            `[stimm-voice] Webhook event=${event.event} room=${roomName ?? "(none)"}`,
          );

          if (roomName && lkRuntime) {
            if (event.event === "participant_left" && event.participant?.identity === "user") {
              // User disconnected — tear down the room immediately.
              api.logger.info(`[stimm-voice] User left room "${roomName}" — ending session.`);
              await lkRuntime.endSession(roomName);
              purgeClaimsForRoom(roomName);
              await maybeShutdownVoiceStartProcess("webhook participant_left");
            } else if (event.event === "room_finished") {
              // All participants gone (Python agent also done) — clean up map.
              api.logger.info(`[stimm-voice] Room "${roomName}" finished — cleaning up session.`);
              await lkRuntime.endSession(roomName);
              purgeClaimsForRoom(roomName);
              await maybeShutdownVoiceStartProcess("webhook room_finished");
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          api.logger.warn(
            `[stimm-voice] Webhook error: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Return 400 so LiveKit logs the failure, but don't crash.
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      },
    });

    // -- HTTP route (web voice endpoint) ------------------------------------

    if (config.web.enabled) {
      const claimPath = `${config.web.path.replace(/\/+$/, "")}/claim`;
      const endPath = `${config.web.path.replace(/\/+$/, "")}/end`;

      api.registerHttpRoute({
        path: claimPath,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          const ip = getRequestIp(req);
          if (!enforceClaimRateLimit(ip)) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "rate_limited" }));
            return;
          }
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const body = JSON.parse(Buffer.concat(chunks).toString()) as { claim?: string };
            const claim = typeof body.claim === "string" ? body.claim.trim() : "";
            const record = claim ? verifyAndConsumeClaim(claim) : null;
            if (!record) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_or_expired_claim" }));
              return;
            }

            const rt = await ensureRuntime();
            const clientToken = await rt.lk.issueJoinToken(record.roomName, {
              identity: "user",
              ttlSeconds: config.access.livekitTokenTtlSeconds,
            });

            const now = Date.now();
            const disconnectToken = randomBytes(24).toString("hex");
            const disconnectExpiresAt = now + config.access.livekitTokenTtlSeconds * 1000;
            claimStore.set(record.claimId, {
              ...record,
              disconnectToken,
              disconnectExpiresAt,
              usedAt: now,
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                room: record.roomName,
                clientToken,
                channel: record.channel,
                disconnectToken,
                livekitUrl: record.livekitUrl ?? config.livekit.url,
              }),
            );
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      });

      api.registerHttpRoute({
        path: endPath,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            res.writeHead(405);
            res.end();
            return;
          }
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              room?: string;
              disconnectToken?: string;
            };
            const room = typeof body.room === "string" ? body.room.trim() : "";
            const disconnectToken =
              typeof body.disconnectToken === "string" ? body.disconnectToken.trim() : "";
            if (!room || !disconnectToken) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "room and disconnectToken required" }));
              return;
            }

            const claim = resolveDisconnectClaim(room, disconnectToken);
            if (!claim) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_or_expired_disconnect_token" }));
              return;
            }

            const rt = await ensureRuntime();
            const ended = await rt.lk.endSession(room);
            claimStore.delete(claim.claimId);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ended: true, room, deletedRoom: ended }));
            await maybeShutdownVoiceStartProcess("web end route");
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        },
      });

      api.registerHttpRoute({
        path: config.web.path,
        handler: async (req, res) => {
          if (req.method === "POST") {
            // Direct session creation is disabled by default for public safety.
            if (!config.access.allowDirectWebSessionCreate) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: "direct_web_session_create_disabled",
                  hint: `Use a claim link and POST ${claimPath} instead.`,
                }),
              );
              return;
            }
            try {
              const session = await createSessionWithAccess({
                channel: "web",
              });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(session));
            } catch (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
            }
          } else {
            // GET — serve the voice web UI.
            try {
              const htmlPath = resolve(extensionDir, "src", "web", "voice.html");
              const html = readFileSync(htmlPath, "utf-8");
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
              res.end(html);
            } catch {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  plugin: "stimm-voice",
                  status: config.enabled ? "enabled" : "disabled",
                  hint: `Use a claim link and POST ${claimPath} to exchange claim for session token.`,
                }),
              );
            }
          }
        },
      });
    }
  },
};

export default stimmVoicePlugin;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Thin LiveKit room lifecycle manager — creates rooms, generates tokens,
 * tracks active sessions. Supervisor logic lives in the Python agent.
 */
export class LiveKitRuntime {
  private sessions = new Map<string, VoiceSessionInternal>();
  private roomService: RoomServiceClient;
  private dispatchService: AgentDispatchClient;
  private config: StimmVoiceConfig;
  private static readonly AGENT_NAME = "stimm-voice";

  constructor(config: StimmVoiceConfig) {
    this.config = config;
    const httpUrl = config.livekit.url.replace("ws://", "http://").replace("wss://", "https://");
    this.roomService = new RoomServiceClient(
      httpUrl,
      config.livekit.apiKey,
      config.livekit.apiSecret,
    );
    this.dispatchService = new AgentDispatchClient(
      httpUrl,
      config.livekit.apiKey,
      config.livekit.apiSecret,
    );
  }

  async createSession(opts: {
    roomName?: string;
    originChannel?: string;
    ttlSeconds?: number;
  }): Promise<VoiceSessionInternal> {
    const roomName = opts.roomName ?? `stimm-${randomHex(8)}`;
    // emptyTimeout: auto-delete the room on the LiveKit side once all
    // participants have left. Matches the token TTL so the room is never
    // abandoned longer than a token would be valid.
    const emptyTimeout = opts.ttlSeconds ?? 600;
    await this.roomService.createRoom({ name: roomName, emptyTimeout });
    await this.dispatchService.createDispatch(roomName, LiveKitRuntime.AGENT_NAME, {
      metadata: JSON.stringify({
        source: "openclaw-stimm-voice",
        originChannel: opts.originChannel ?? "web",
      }),
    });

    const clientToken = await this.generateToken({
      identity: "user",
      roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: opts.ttlSeconds,
    });

    const session: VoiceSessionInternal = {
      roomName,
      clientToken,
      createdAt: Date.now(),
      originChannel: opts.originChannel ?? "web",
    };
    this.sessions.set(roomName, session);
    return session;
  }

  async endSession(roomName: string): Promise<boolean> {
    if (!this.sessions.has(roomName)) return false;
    this.sessions.delete(roomName);
    try {
      await this.roomService.deleteRoom(roomName);
    } catch {
      // Room may already be gone.
    }
    return true;
  }

  /**
   * Lists participants in the room with their identity and kind.
   * kind values: 0=STANDARD (human), 1=INGRESS, 2=EGRESS, 3=SIP, 4=AGENT
   * Returns an empty array when the room is gone or on error.
   */
  async listRoomParticipants(
    roomName: string,
  ): Promise<Array<{ identity: string; kind: number; state: number }>> {
    try {
      const participants = await this.roomService.listParticipants(roomName);
      return participants.map((p) => ({
        identity: p.identity,
        kind: p.kind as number,
        state: p.state as number,
      }));
    } catch {
      return [];
    }
  }

  getSession(roomName: string): VoiceSessionInternal | undefined {
    return this.sessions.get(roomName);
  }

  listSessions(): VoiceSessionInternal[] {
    return [...this.sessions.values()];
  }

  async issueJoinToken(
    roomName: string,
    opts: {
      ttlSeconds?: number;
      identity?: string;
    } = {},
  ): Promise<string> {
    return await this.generateToken({
      identity: opts.identity ?? "user",
      roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: opts.ttlSeconds,
    });
  }

  async issueClientToken(
    roomName: string,
    opts: {
      ttlSeconds?: number;
      identity?: string;
    } = {},
  ): Promise<string> {
    if (!this.sessions.has(roomName)) {
      throw new Error("session not found");
    }
    return await this.issueJoinToken(roomName, opts);
  }

  async stopAll(): Promise<void> {
    const rooms = [...this.sessions.keys()];
    await Promise.allSettled(rooms.map((r) => this.endSession(r)));
  }

  private async generateToken(opts: {
    identity: string;
    roomName: string;
    canPublish?: boolean;
    canSubscribe?: boolean;
    canPublishData?: boolean;
    ttlSeconds?: number;
  }): Promise<string> {
    const token = new AccessToken(this.config.livekit.apiKey, this.config.livekit.apiSecret, {
      identity: opts.identity,
      ttl: opts.ttlSeconds ?? 3600,
    });
    const grant: VideoGrant = {
      roomJoin: true,
      room: opts.roomName,
      canPublish: opts.canPublish ?? true,
      canSubscribe: opts.canSubscribe ?? true,
      canPublishData: opts.canPublishData ?? true,
    };
    token.addGrant(grant);
    return await token.toJwt();
  }
}

interface VoiceSessionInternal {
  roomName: string;
  clientToken: string;
  createdAt: number;
  originChannel: string;
}

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  webcrypto.getRandomValues(array);
  return [...array].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeSupervisorResponseText(result: StimmResponseResult): string {
  const raw = typeof result.text === "string" ? result.text.trim() : "";

  // If the upstream model already returned structured JSON text, preserve it.
  if (result.decision && raw.startsWith("{") && raw.endsWith("}")) {
    return raw;
  }

  // Non-empty unstructured text should still be actionable for Stimm.
  if (raw.length > 0) {
    return JSON.stringify({
      action: "TRIGGER",
      text: raw,
      reason: result.decision?.reason ?? "openclaw_non_json_fallback",
    });
  }

  return JSON.stringify({
    action: "NO_ACTION",
    text: "",
    reason: result.decision?.reason ?? result.error ?? "empty_response",
  });
}

type NormalizedSupervisorDecision = {
  action: "TRIGGER" | "NO_ACTION";
  text: string;
  reason: string;
};

function safeParseSupervisorDecision(raw: string): NormalizedSupervisorDecision | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      action?: unknown;
      text?: unknown;
      reason?: unknown;
    };
    if (parsed.action !== "TRIGGER" && parsed.action !== "NO_ACTION") {
      return null;
    }
    return {
      action: parsed.action,
      text: typeof parsed.text === "string" ? parsed.text : "",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}

function truncateSupervisorLogText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

/** Serialize a VoiceSession for gateway/tool responses. */
function sessionPayload(session: VoiceSessionInternal, tunnel?: TunnelInfo | null): SessionPayload {
  return {
    room: session.roomName,
    clientToken: session.clientToken,
    channel: session.originChannel,
    createdAt: session.createdAt,
    // Pass the public LiveKit URL so the web UI uses the tunnel instead of guessing.
    ...(tunnel?.livekitUrl ? { livekitUrl: tunnel.livekitUrl } : {}),
  };
}

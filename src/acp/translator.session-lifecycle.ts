import { randomUUID } from "node:crypto";
import type {
  AuthenticateRequest,
  AuthenticateResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionInfo,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentOperationAgentId,
  resolveConfiguredAgentId,
} from "../agents/agent-scope-config.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "../gateway/client.js";
import type { SessionsListResult } from "../gateway/session-utils.js";
import type { FixedWindowRateLimiter } from "../infra/fixed-window-rate-limit.js";
import { toAgentStoreSessionKey } from "../routing/session-key.js";
import type { AcpEventLedgerReplay } from "./event-ledger.js";
import { parseSessionMeta, resolveAcpSessionKey } from "./session-mapper.js";
import type { SessionSnapshot } from "./translator.presentation.js";
import { extractReplayChunks, type GatewayTranscriptMessage } from "./translator.replay.js";
import {
  ACP_LIST_SESSIONS_MAX_FETCH_LIMIT,
  assertAbsoluteCwd,
  decodeListSessionsCursor,
  encodeListSessionsCursor,
  resolveListSessionsPageSize,
} from "./translator.session-list.js";
import type { AcpTranslatorSessionState } from "./translator.session-state.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000_000;

function hasExplicitSessionRouting(
  meta: ReturnType<typeof parseSessionMeta>,
  opts: AcpServerOptions,
): boolean {
  return Boolean(
    meta.sessionKey || meta.sessionLabel || opts.defaultSessionKey || opts.defaultSessionLabel,
  );
}

export class AcpTranslatorSessionLifecycle {
  constructor(
    private readonly gateway: GatewayClient,
    private readonly opts: AcpServerOptions,
    private readonly config: OpenClawConfig,
    private readonly sessionStore: AcpSessionStore,
    private readonly sessionUpdates: AcpTranslatorSessionUpdates,
    private readonly sessionState: AcpTranslatorSessionState,
    private readonly sessionCreateRateLimiter: FixedWindowRateLimiter,
    private readonly cancelSessionWork: (session: {
      sessionId: string;
      sessionKey: string;
      activeRunId: string | null;
    }) => Promise<void>,
    private readonly log: (msg: string) => void,
  ) {}

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params["_meta"]);
    const generatedFallbackKey = `acp-bridge:${sessionId}`;
    const fallbackKey = hasExplicitSessionRouting(meta, this.opts)
      ? generatedFallbackKey
      : this.resolveGeneratedBridgeSessionKey(generatedFallbackKey);
    const sessionKey = await this.resolveSessionKeyFromMeta({ meta, fallbackKey });

    const session = this.sessionStore.createSession({
      sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    await this.sessionUpdates.startLedgerSession(session, { complete: true, reset: true });
    this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
    const sessionSnapshot = await this.sessionState.getSnapshot(session.sessionKey);
    const presentation = await this.publishSessionSnapshot(session, sessionSnapshot, true);
    return { sessionId: session.sessionId, ...presentation };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers);
    if (!this.sessionStore.hasSession(params.sessionId)) {
      this.enforceSessionCreateRateLimit("loadSession");
    }

    const meta = parseSessionMeta(params["_meta"]);
    const hasExplicitRouting = hasExplicitSessionRouting(meta, this.opts);
    const exactLedgerReplay: AcpEventLedgerReplay = hasExplicitRouting
      ? { complete: false, events: [] }
      : await this.sessionUpdates.readLedgerReplayBySessionId(params.sessionId);
    const listedLedgerReplay: AcpEventLedgerReplay =
      !hasExplicitRouting && !exactLedgerReplay.complete
        ? await this.sessionUpdates.readLedgerReplayBySessionKey(params.sessionId)
        : { complete: false, events: [] };
    const routedLedgerReplay = exactLedgerReplay.complete ? exactLedgerReplay : listedLedgerReplay;
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey: routedLedgerReplay.sessionKey ?? params.sessionId,
    });
    const ledgerReplay =
      exactLedgerReplay.complete && exactLedgerReplay.sessionKey === sessionKey
        ? exactLedgerReplay
        : listedLedgerReplay.complete && listedLedgerReplay.sessionKey === sessionKey
          ? listedLedgerReplay
          : await this.sessionUpdates.readLedgerReplay({
              sessionId: params.sessionId,
              sessionKey,
            });

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      ...(ledgerReplay.sessionId ? { ledgerSessionId: ledgerReplay.sessionId } : {}),
      cwd: params.cwd,
    });
    await this.sessionUpdates.startLedgerSession(session, { complete: ledgerReplay.complete });
    this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
    const [sessionSnapshot, transcript] = await Promise.all([
      this.sessionState.getSnapshot(session.sessionKey),
      ledgerReplay.complete
        ? Promise.resolve([])
        : this.getSessionTranscript(session.sessionKey).catch((err: unknown) => {
            this.log(`session transcript fallback for ${session.sessionKey}: ${String(err)}`);
            return [];
          }),
    ]);
    const replaySessionId = session.sessionId;
    if (ledgerReplay.complete) {
      for (const event of ledgerReplay.events) {
        await this.sessionUpdates.emit({
          sessionId: replaySessionId,
          update: event.update,
          record: false,
        });
      }
    } else {
      for (const message of transcript) {
        for (const chunk of extractReplayChunks(message)) {
          await this.sessionUpdates.emit({
            sessionId: replaySessionId,
            update: {
              sessionUpdate: chunk.sessionUpdate,
              content: { type: "text", text: chunk.text },
            },
          });
        }
      }
    }
    return await this.publishSessionSnapshot(session, sessionSnapshot, false);
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const requestedCwd = normalizeOptionalString(params.cwd);
    if (requestedCwd) {
      assertAbsoluteCwd(requestedCwd, "session/list");
    }
    const fallbackCwd = requestedCwd ?? process.cwd();
    const rawCursor = params.cursor;
    const cursor = decodeListSessionsCursor(rawCursor);
    if (rawCursor && cursor.cwd !== requestedCwd) {
      throw new Error("ACP session list cursor does not match the cwd filter.");
    }

    const pageSize = resolveListSessionsPageSize(params["_meta"]);
    const start = cursor.offset;
    const end = start + pageSize;
    let fetchLimit = end + 1;
    let rows: SessionInfo[] = [];

    while (true) {
      const result = await this.gateway.request<SessionsListResult>("sessions.list", {
        limit: fetchLimit,
        includeDerivedTitles: true,
      });
      rows = result.sessions
        .filter((session) => {
          if (!requestedCwd) {
            return true;
          }
          return (
            (normalizeOptionalString(session.spawnedCwd) ??
              normalizeOptionalString(session.spawnedWorkspaceDir)) === requestedCwd
          );
        })
        .map((session) => this.sessionState.mapGatewaySession(session, fallbackCwd));
      if (
        rows.length > end ||
        result.hasMore !== true ||
        fetchLimit >= ACP_LIST_SESSIONS_MAX_FETCH_LIMIT
      ) {
        break;
      }
      fetchLimit = Math.min(fetchLimit * 2, ACP_LIST_SESSIONS_MAX_FETCH_LIMIT);
    }

    const page = rows.slice(start, end);
    const hasMore = rows.length > end;
    return {
      sessions: page,
      nextCursor: hasMore
        ? encodeListSessionsCursor({
            offset: end,
            ...(requestedCwd ? { cwd: requestedCwd } : {}),
          })
        : null,
    };
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    this.assertSupportedSessionSetup(params.mcpServers ?? []);
    assertAbsoluteCwd(params.cwd, "session/resume");

    const existingSession = this.sessionStore.getSession(params.sessionId);
    if (!existingSession) {
      this.enforceSessionCreateRateLimit("resumeSession");
    }

    const meta = parseSessionMeta(params["_meta"]);
    const fallbackKey = existingSession?.sessionKey ?? params.sessionId;
    const sessionKey = await this.resolveSessionKeyFromMeta({
      meta,
      fallbackKey,
    });

    const shouldRequireGatewaySession =
      !existingSession || sessionKey !== existingSession.sessionKey;
    const sessionSnapshot = shouldRequireGatewaySession
      ? await this.sessionState.getExistingSnapshot(sessionKey)
      : await this.sessionState.getSnapshot(sessionKey);

    const session = this.sessionStore.createSession({
      sessionId: params.sessionId,
      sessionKey,
      cwd: params.cwd,
    });
    await this.sessionUpdates.startLedgerSession(session, { complete: false });
    this.log(`resumeSession: ${session.sessionId} -> ${session.sessionKey}`);
    return await this.publishSessionSnapshot(session, sessionSnapshot, false);
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.requireSession(params.sessionId);
    await this.cancelSessionWork(session);
    this.sessionStore.deleteSession(params.sessionId);
    this.log(`closeSession: ${params.sessionId}`);
    return {};
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    if (!params.modeId) {
      return {};
    }
    try {
      await this.gateway.request("sessions.patch", {
        key: session.sessionKey,
        thinkingLevel: params.modeId,
      });
      this.log(`setSessionMode: ${session.sessionId} -> ${params.modeId}`);
      const sessionSnapshot = await this.sessionState.getSnapshot(session.sessionKey, {
        thinkingLevel: params.modeId,
      });
      await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
        includeControls: true,
        record: true,
      });
    } catch (err) {
      this.log(`setSessionMode error: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    const sessionPatch = this.sessionState.resolveConfigPatch(params.configId, params.value);

    try {
      if (sessionPatch.patch) {
        await this.gateway.request("sessions.patch", {
          key: session.sessionKey,
          ...sessionPatch.patch,
        });
      }
      this.log(
        `setSessionConfigOption: ${session.sessionId} -> ${params.configId}=${params.value}`,
      );
      const sessionSnapshot = await this.sessionState.getSnapshot(
        session.sessionKey,
        sessionPatch.overrides,
      );
      await this.sessionState.sendSnapshotUpdate(session, sessionSnapshot, {
        includeControls: true,
        record: true,
      });
      return {
        configOptions: sessionSnapshot.configOptions,
      };
    } catch (err) {
      this.log(`setSessionConfigOption error: ${String(err)}`);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private resolveGeneratedBridgeSessionKey(sessionKey: string): string {
    // Remote Gateway targets own session-owner resolution: a local roster that
    // cannot name an owner must not invent one. Scope the key only when the
    // caller explicitly selected an agent; otherwise keep the bare bridge key so
    // the Gateway resolves its own configured or sole agent, which may not
    // exist in the client's roster (`--agent` is normalized before this point).
    if (this.opts.skipAgentOwnerRosterValidation) {
      if (!this.opts.agentId) {
        return sessionKey;
      }
      return toAgentStoreSessionKey({
        agentId: this.opts.agentId,
        requestKey: sessionKey,
      });
    }
    // Keep fixed-store keys unqualified so Gateway preserves their persisted
    // owner, including refusal for a retired owner instead of a system fallback.
    if (
      !this.opts.agentId &&
      resolvePersistedSessionStoreOwnerForKey(this.config, sessionKey).kind !== "none"
    ) {
      return sessionKey;
    }
    const agentId = resolveAgentOperationAgentId(this.config, this.opts.agentId, {
      surface: "ACP bridge session",
      hint: "Pass --agent <id>, set agents.defaults.systemAgent.agentId, or provide an agent-owned session key or label.",
    });
    // Local bridges validate the owner early against the configured roster.
    return toAgentStoreSessionKey({
      agentId: resolveConfiguredAgentId(this.config, agentId),
      requestKey: sessionKey,
    });
  }

  private async publishSessionSnapshot(
    session: Parameters<AcpTranslatorSessionState["sendSnapshotUpdate"]>[0],
    snapshot: SessionSnapshot,
    record: boolean,
  ): Promise<LoadSessionResponse> {
    await this.sessionState.sendSnapshotUpdate(session, snapshot, {
      includeControls: false,
      record,
    });
    await this.sessionUpdates.sendAvailableCommands(session, { record });
    const { configOptions, modes } = snapshot;
    return { configOptions, modes };
  }

  private requireSession(sessionId: string) {
    const session = this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  private async resolveSessionKeyFromMeta(params: {
    meta: ReturnType<typeof parseSessionMeta>;
    fallbackKey: string;
  }): Promise<string> {
    const sessionKey = await resolveAcpSessionKey({
      meta: params.meta,
      fallbackKey: params.fallbackKey,
      gateway: this.gateway,
      opts: this.opts,
    });
    if (params.meta.resetSession ?? this.opts.resetSession ?? false) {
      await this.gateway.request("sessions.reset", { key: sessionKey });
    }
    return sessionKey;
  }

  private async getSessionTranscript(sessionKey: string): Promise<GatewayTranscriptMessage[]> {
    const result = await this.gateway.request("sessions.get", {
      key: sessionKey,
      limit: ACP_LOAD_SESSION_REPLAY_LIMIT,
    });
    if (!Array.isArray(result.messages)) {
      return [];
    }
    return result.messages as GatewayTranscriptMessage[];
  }

  private assertSupportedSessionSetup(mcpServers: ReadonlyArray<unknown>): void {
    if (mcpServers.length === 0) {
      return;
    }
    throw new Error(
      "ACP bridge mode does not support per-session MCP servers. Configure MCP on the OpenClaw gateway or agent instead.",
    );
  }

  private enforceSessionCreateRateLimit(
    method: "newSession" | "loadSession" | "resumeSession",
  ): void {
    const budget = this.sessionCreateRateLimiter.consume();
    if (budget.allowed) {
      return;
    }
    throw new Error(
      `ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1_000)}s.`,
    );
  }
}

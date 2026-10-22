import { randomUUID } from "node:crypto";
import path from "node:path";
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
import { readMetadataNumber } from "@openclaw/acp-core/meta";
import type { AcpSessionStore } from "@openclaw/acp-core/session";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayClient } from "../gateway/client.js";
import type { SessionsListResult } from "../gateway/session-utils.js";
import type { FixedWindowRateLimiter } from "../infra/fixed-window-rate-limit.js";
import type { AcpEventLedgerReplay } from "./event-ledger.js";
import { parseSessionMeta } from "./session-mapper.js";
import type { SessionSnapshot } from "./translator.presentation.js";
import { extractReplayChunks, type GatewayTranscriptMessage } from "./translator.replay.js";
import type { AcpTranslatorSessionState } from "./translator.session-state.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000_000;
const ACP_LIST_SESSIONS_MAX_PAGE_SIZE = 100;
const ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET = 10_000;

/** Maximum rows fetched to satisfy ACP session-list pagination plus next-page detection. */
const ACP_LIST_SESSIONS_MAX_FETCH_LIMIT =
  ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET + ACP_LIST_SESSIONS_MAX_PAGE_SIZE + 1;

type ListSessionsCursor = {
  offset: number;
  cwd?: string;
};

function encodeListSessionsCursor(cursor: ListSessionsCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeListSessionsCursor(value: string | null | undefined): ListSessionsCursor {
  if (value === null || value === undefined) {
    return { offset: 0 };
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new Error("non-canonical base64url");
    }
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid ACP session list cursor.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid ACP session list cursor.");
  }
  if (parsed.v !== 1) {
    throw new Error("Unsupported ACP session list cursor.");
  }
  if (
    typeof parsed.offset !== "number" ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0 ||
    parsed.offset > ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET
  ) {
    throw new Error("Invalid ACP session list cursor offset.");
  }
  const cwd = normalizeOptionalString(parsed.cwd);
  const cursor = {
    offset: parsed.offset,
    ...(cwd ? { cwd } : {}),
  };
  if (encodeListSessionsCursor(cursor) !== value) {
    throw new Error("Invalid ACP session list cursor.");
  }
  return cursor;
}

function assertAbsoluteCwd(cwd: string, method: string): void {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`ACP ${method} requires an absolute cwd.`);
  }
}

export class AcpTranslatorSessionLifecycle {
  constructor(
    private readonly gateway: GatewayClient,
    private readonly opts: AcpServerOptions,
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
    assertAbsoluteCwd(params.cwd, "session/new");
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = randomUUID();
    const meta = parseSessionMeta(params["_meta"]);
    const fallbackKey = `acp-bridge:${sessionId}`;
    const hasExplicitRouting = Boolean(
      meta.sessionKey ||
      meta.sessionLabel ||
      this.opts.defaultSessionKey ||
      this.opts.defaultSessionLabel,
    );
    const sessionKey = hasExplicitRouting
      ? await this.resolveSessionKeyFromMeta({ meta, fallbackKey })
      : fallbackKey;
    if (!hasExplicitRouting) {
      // Gateway owns execution cwd and its authorization. Adopted sessions keep
      // their existing directory; a fresh key needs no reset before creation.
      await this.gateway.request("sessions.create", { key: sessionKey, cwd: params.cwd });
    }

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
    const hasExplicitRouting = Boolean(
      meta.sessionKey ||
      meta.sessionLabel ||
      this.opts.defaultSessionKey ||
      this.opts.defaultSessionLabel,
    );
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

    const requestedPageSize = readMetadataNumber(params["_meta"], ["limit", "pageSize"]);
    const pageSize = Math.min(
      ACP_LIST_SESSIONS_MAX_PAGE_SIZE,
      Math.max(1, Math.floor(requestedPageSize ?? ACP_LIST_SESSIONS_MAX_PAGE_SIZE)),
    );
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
    // A per-session key outranks the server's default label.
    const requestedLabel =
      params.meta.sessionLabel ??
      (params.meta.sessionKey ? undefined : this.opts.defaultSessionLabel);
    const requestedKey = params.meta.sessionKey ?? this.opts.defaultSessionKey;
    const requireExisting =
      params.meta.requireExisting ?? this.opts.requireExistingSession ?? false;
    let sessionKey = requestedKey || params.fallbackKey;
    if (requestedLabel || (requestedKey && requireExisting)) {
      const resolved = await this.gateway.request<{ ok: true; key: string }>(
        "sessions.resolve",
        requestedLabel ? { label: requestedLabel } : { key: requestedKey },
      );
      if (!resolved?.key) {
        throw new Error(
          requestedLabel
            ? `Unable to resolve session label: ${requestedLabel}`
            : `Session key not found: ${requestedKey}`,
        );
      }
      sessionKey = resolved.key;
    }
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

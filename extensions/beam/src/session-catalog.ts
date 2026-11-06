import { createHash } from "node:crypto";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { isControlUiCatalogShareId } from "openclaw/plugin-sdk/session-catalog-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BeamStore } from "./store.js";
import { BEAM_HOST_ID, BEAM_SESSION_SHARE_ROUTE, type BeamStoredSession } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function boundedLimit(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, value ?? DEFAULT_LIMIT));
}

function cursorOffset(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

type TranscriptCursor = { revision: string; end: number };

export class BeamTranscriptCursorError extends Error {
  readonly kind: "invalid" | "stale";

  constructor(kind: "invalid" | "stale") {
    super(`${kind} Beam transcript cursor`);
    this.kind = kind;
  }
}

function transcriptRevision(session: BeamStoredSession): string {
  return createHash("sha256").update(JSON.stringify(session.items)).digest("base64url");
}

function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeTranscriptCursor(value: string): TranscriptCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      isRecord(parsed) &&
      typeof parsed.revision === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(parsed.revision) &&
      typeof parsed.end === "number" &&
      Number.isSafeInteger(parsed.end) &&
      parsed.end >= 0
    ) {
      return { revision: parsed.revision, end: parsed.end };
    }
  } catch {
    // Reject malformed cursors below.
  }
  throw new BeamTranscriptCursorError("invalid");
}

function readBeamSession(
  session: BeamStoredSession,
  params: Parameters<SessionCatalogProvider["read"]>[0],
) {
  const cursor = params.cursor === undefined ? undefined : decodeTranscriptCursor(params.cursor);
  const end = Math.min(session.items.length, cursor?.end ?? session.items.length);
  const start = Math.max(0, end - boundedLimit(params.limit));
  let nextCursor: string | undefined;
  if (cursor || start > 0) {
    const revision = transcriptRevision(session);
    if (cursor && cursor.revision !== revision) {
      throw new BeamTranscriptCursorError("stale");
    }
    if (start > 0) {
      nextCursor = encodeTranscriptCursor({ revision, end: start });
    }
  }
  return {
    hostId: BEAM_HOST_ID,
    label: session.title,
    threadId: session.beamId,
    // Project only the selected page; keep chronological source indices in IDs
    // while exposing newest-first items on the catalog wire.
    items: session.items
      .slice(start, end)
      .map((item, index) => ({
        id: `${session.beamId}:${start + index}`,
        type: item.type,
        text: item.text,
        timestamp: session.updatedAt,
        sender:
          item.type === "userMessage" && session.uploaderProfileId
            ? { identity: { type: "profile" as const, id: session.uploaderProfileId } }
            : undefined,
      }))
      .toReversed(),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function createBeamSessionCatalog(store: BeamStore): SessionCatalogProvider {
  async function requireSession(hostId: string, threadId: string) {
    if (hostId !== BEAM_HOST_ID) {
      throw new Error(`unknown Beam host: ${hostId}`);
    }
    const session = await store.get(threadId);
    if (!session) {
      throw new Error(`unknown Beam session: ${threadId}`);
    }
    return session;
  }

  return {
    id: "beam",
    label: "Beam",
    audience: "gateway-operators",
    shareRoute: BEAM_SESSION_SHARE_ROUTE,
    supportsProcessHomeIsolation: true,
    async list(params) {
      // Normalize comparison text only; uploaded titles and stored identities stay original.
      const search = params.search?.trim().toLowerCase().normalize("NFC");
      const shareId =
        search && isControlUiCatalogShareId(BEAM_SESSION_SHARE_ROUTE, search) ? search : undefined;
      const sessions = (await store.list(shareId))
        .filter(
          (session) =>
            !search ||
            (shareId
              ? session.beamId.startsWith(shareId)
              : `${session.title}\n${session.source}`
                  .toLowerCase()
                  .normalize("NFC")
                  .includes(search)),
        )
        .toSorted(
          (left, right) =>
            right.receivedAt - left.receivedAt || left.beamId.localeCompare(right.beamId),
        );
      const offset = cursorOffset(params.cursors?.[BEAM_HOST_ID]);
      const limit = boundedLimit(params.limitPerHost);
      const page = sessions.slice(offset, offset + limit);
      return [
        {
          hostId: BEAM_HOST_ID,
          label: "Beamed sessions",
          kind: "gateway",
          connected: true,
          sessions: page.map((session) => ({
            threadId: session.beamId,
            name: session.title,
            status: session.completed ? "completed" : "live",
            createdAt: session.createdAt,
            updatedAt: session.receivedAt,
            recencyAt: session.receivedAt,
            source: session.source,
            archived: false,
            canContinue: Boolean(session.handoffId),
            ...(!session.handoffId
              ? {
                  continuationUnavailableReasonCode: "source-handoff-required" as const,
                  continuationUnavailableReason:
                    "This Beam is a read-only snapshot. Its authenticated original publisher must run beam handoff before you can continue here.",
                }
              : {}),
            ...(session.continuation?.ready || session.continuation?.creating
              ? { sessionKey: session.continuation.sessionKey }
              : {}),
            canArchive: true,
          })),
          ...(offset + page.length < sessions.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
        },
      ];
    },
    async read(params) {
      return readBeamSession(await requireSession(params.hostId, params.threadId), params);
    },
    async resolveGatewayConversation(params) {
      const session = await requireSession(params.hostId, params.threadId);
      if (!session.continuation?.ready && !session.continuation?.creating) {
        return undefined;
      }
      if (!params.assertCurrent) {
        throw new Error("Beam resolution requires current request authority");
      }
      // An existing binding acquires a keyed read guard without reserving or writing state.
      const guarded = await store.reserveContinuation(
        session,
        session.continuation.agentId,
        params.assertCurrent,
      );
      return {
        ...session.continuation,
        assertCurrent: guarded.assertCurrent,
        release: guarded.release,
      };
    },
    async archive(params) {
      if (params.hostId !== BEAM_HOST_ID) {
        throw new Error(`unknown Beam host: ${params.hostId}`);
      }
      if (!(await store.delete(params.threadId))) {
        throw new Error(`unknown Beam session: ${params.threadId}`);
      }
      return { ok: true };
    },
    async copyToGatewaySession(params) {
      const session = await requireSession(params.hostId, params.threadId);
      if (!params.agentId || !params.assertCurrent) {
        throw new Error("Beam continuation requires a destination and current request authority");
      }
      const reserved = await store.reserveContinuation(
        session,
        params.agentId,
        params.assertCurrent,
      );
      const binding = reserved.session.continuation!;
      return {
        continuation: {
          ...binding,
          reservedNow: reserved.reservedNow,
          assertCurrent: reserved.assertCurrent,
          release: reserved.release,
          complete: reserved.complete,
          beginCreate: reserved.beginCreate,
          rollback: reserved.rollback,
          read: async (readParams) => {
            reserved.assertCurrent();
            return readBeamSession(reserved.session, readParams);
          },
        },
        displayName: reserved.session.title,
        ...(reserved.session.sourceModel
          ? {
              preferredModel: `${reserved.session.sourceModel.provider}/${reserved.session.sourceModel.model}`,
            }
          : {}),
      };
    },
  };
}

import type {
  SessionCatalogProvider,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import type { BeamStore } from "./store.js";
import { BEAM_HOST_ID, type BeamStoredSession } from "./types.js";

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

function searchableText(session: BeamStoredSession): string {
  return `${session.title}\n${session.source}`.toLowerCase();
}

function transcriptItems(session: BeamStoredSession): SessionCatalogTranscriptItem[] {
  return session.items.map((item, index) => ({
    id: `${session.beamId}:${index}`,
    type: item.type,
    text: item.text,
    timestamp: session.updatedAt,
    ...(session.truncated ? { truncated: true } : {}),
  }));
}

export function createBeamSessionCatalog(store: BeamStore): SessionCatalogProvider {
  return {
    id: "beam",
    label: "Beam",
    async list(params) {
      const search = params.search?.trim().toLowerCase();
      const sessions = (await store.list())
        .filter((session) => !search || searchableText(session).includes(search))
        .toSorted((left, right) => right.receivedAt - left.receivedAt);
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
            canContinue: false,
            canArchive: false,
          })),
          ...(offset + page.length < sessions.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
        },
      ];
    },
    async read(params) {
      if (params.hostId !== BEAM_HOST_ID) {
        throw new Error(`unknown Beam host: ${params.hostId}`);
      }
      const session = await store.get(params.threadId);
      if (!session) {
        throw new Error(`unknown Beam session: ${params.threadId}`);
      }
      const allItems = transcriptItems(session);
      const offset = cursorOffset(params.cursor);
      const limit = boundedLimit(params.limit);
      const items = allItems.slice(offset, offset + limit);
      return {
        hostId: BEAM_HOST_ID,
        label: session.title,
        threadId: session.beamId,
        items,
        ...(offset + items.length < allItems.length
          ? { nextCursor: String(offset + items.length) }
          : {}),
      };
    },
  };
}

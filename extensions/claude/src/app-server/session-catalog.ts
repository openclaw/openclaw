/**
 * Claude session catalog — list/read/rename/archive over the bridge's
 * thread/list, thread/read, thread/name/set, thread/archive, and
 * thread/unarchive RPCs (added in @zeroaltitude/openclaw-claude-bridge 0.4.0).
 *
 * Unlike Codex Supervisor's session catalog, which opens its own dedicated
 * stdio connection because it is a separate plugin from the main `codex`
 * harness, this reuses the SAME shared bridge client extensions/claude
 * already spawns for live turns (getSharedClaudeAppServerClient) — it's the
 * same plugin, and these are quick metadata calls, not turns, so there's no
 * real contention concern that would justify a second subprocess.
 */

import {
  ClaudeAppServerRpcError,
  getSharedClaudeAppServerClient,
  type ClaudeAppServerClient,
  type ClaudeAppServerStartOptions,
} from "./client.js";
import { resolveManagedClaudeBridgeStartOptions } from "./managed-binary.js";

const THREAD_NOT_FOUND_RPC_CODE = -32004;

export type ClaudeSessionCatalogSession = {
  threadId: string;
  sessionId?: string;
  name?: string | null;
  cwd?: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
  source?: string;
  modelProvider?: string;
  preview?: string;
  archived: boolean;
};

export type ClaudeSessionCatalogPage = {
  sessions: ClaudeSessionCatalogSession[];
  nextCursor?: string | null;
};

export type ClaudeSessionCatalogQuery = {
  cursor?: string | null;
  limit?: number;
  archived?: boolean;
  searchTerm?: string;
};

export class ClaudeSessionNotFoundError extends Error {}

type ThreadWireShape = {
  id: string;
  sessionId?: string;
  name?: string | null;
  cwd?: string;
  status?: { type?: string };
  createdAt?: number;
  updatedAt?: number;
  source?: unknown;
  modelProvider?: string;
  preview?: string;
  archived?: boolean;
  turns?: unknown[];
};

function mapThread(thread: ThreadWireShape): ClaudeSessionCatalogSession {
  return {
    threadId: thread.id,
    sessionId: thread.sessionId,
    name: thread.name ?? null,
    cwd: thread.cwd,
    status: thread.status?.type ?? "idle",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    source: typeof thread.source === "string" ? thread.source : undefined,
    modelProvider: thread.modelProvider,
    preview: thread.preview,
    archived: Boolean(thread.archived),
  };
}

/**
 * Resolves the same shared client extensions/claude uses for live turns.
 * Deliberately minimal spawn options — catalog reads are pure metadata
 * operations on already-persisted state; they don't need an API key, a
 * resolved model, or any of the turn-scoped exec-policy/sandbox plumbing
 * runAttempt() assembles for an actual turn.
 */
export async function getCatalogClient(
  overrides: Partial<ClaudeAppServerStartOptions> = {},
): Promise<ClaudeAppServerClient> {
  const startOptions = await resolveManagedClaudeBridgeStartOptions({
    commandSource: "managed",
    ...overrides,
  });
  const client = getSharedClaudeAppServerClient(startOptions);
  await client.start();
  return client;
}

export async function listClaudeSessions(
  client: ClaudeAppServerClient,
  query: ClaudeSessionCatalogQuery,
): Promise<ClaudeSessionCatalogPage> {
  const response = await client.request<{ data: ThreadWireShape[]; nextCursor?: string | null }>(
    "thread/list",
    {
      cursor: query.cursor ?? null,
      limit: query.limit ?? 50,
      archived: query.archived === true,
      ...(query.searchTerm ? { searchTerm: query.searchTerm } : {}),
    },
  );
  return {
    sessions: response.data.map(mapThread),
    nextCursor: response.nextCursor ?? null,
  };
}

export type ClaudeSessionTranscriptItem = {
  id: string;
  type: string;
  name?: string | null;
  text?: string;
};

export type ClaudeSessionReadResult = {
  session: ClaudeSessionCatalogSession;
  items: ClaudeSessionTranscriptItem[];
};

export async function readClaudeSession(
  client: ClaudeAppServerClient,
  threadId: string,
): Promise<ClaudeSessionReadResult> {
  const response = await wrapNotFound(
    client.request<{ thread: ThreadWireShape }>("thread/read", { threadId, includeTurns: true }),
  );
  const turn = Array.isArray(response.thread.turns) ? response.thread.turns[0] : undefined;
  const items = isRecordWithItems(turn) ? turn.items : [];
  return {
    session: mapThread(response.thread),
    items: items.map((item) => ({
      id: item.id,
      type: item.type,
      name: item.name ?? null,
      text: item.text,
    })),
  };
}

export async function renameClaudeSession(
  client: ClaudeAppServerClient,
  threadId: string,
  name: string,
): Promise<void> {
  await wrapNotFound(client.request("thread/name/set", { threadId, name }));
}

export async function archiveClaudeSession(
  client: ClaudeAppServerClient,
  threadId: string,
): Promise<void> {
  await wrapNotFound(client.request("thread/archive", { threadId }));
}

export async function unarchiveClaudeSession(
  client: ClaudeAppServerClient,
  threadId: string,
): Promise<ClaudeSessionCatalogSession> {
  const response = await wrapNotFound(
    client.request<{ thread: ThreadWireShape }>("thread/unarchive", { threadId }),
  );
  return mapThread(response.thread);
}

async function wrapNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ClaudeAppServerRpcError && err.code === THREAD_NOT_FOUND_RPC_CODE) {
      throw new ClaudeSessionNotFoundError(err.message);
    }
    throw err;
  }
}

function isRecordWithItems(
  value: unknown,
): value is { items: Array<{ id: string; type: string; name?: string | null; text?: string }> } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

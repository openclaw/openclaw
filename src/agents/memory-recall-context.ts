import { appUserIdFromSessionKey } from "./app-profile-context.js";
import { isAppUserSession, resolveAppUserId } from "./app-user-workspace.js";
import { searchMemoryFacts } from "./graphiti-recall-client.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

/**
 * Deterministic durable-memory recall injection for app-user sessions.
 *
 * Problem (report 4A): durable facts ARE saved to Graphiti (verified), but recall
 * is discretionary — the agent must call `search_memory_facts`, and under the slim
 * app prompt it often doesn't at the start of a new chat, so a returning user is
 * treated as a stranger. Mirroring the proven `app_profile` bootstrap, this module
 * fetches the user's top facts server-side and injects them as a synthetic
 * `MEMORY_RECALL.md` context file EVERY turn — so recall no longer depends on the
 * model remembering to search.
 *
 * App-sessions only; Telegram / no-appUserId / errors are no-ops (FAIL OPEN — a
 * missed recall must never block or slow a turn beyond the timebox).
 *
 * NO cross-turn cache (codex review P2): immediate cross-chat recall right after a
 * memory write matters more than saving one Graphiti call; a TTL cache could serve
 * stale "you have no memories" to a brand-new chat. Add caching later only with
 * explicit invalidation on `add_memory` success.
 */

/** Synthetic context-file name shown to the model as `## MEMORY_RECALL.md`. Deliberately NOT
 *  `MEMORY.md` (that name is excluded from app prompts) — and injected post-shaping anyway. */
export const MEMORY_RECALL_CONTEXT_NAME = "MEMORY_RECALL.md";

/** Hard byte cap for the injected block (defense-in-depth; facts are short). */
export const MEMORY_RECALL_MAX_BYTES = 2 * 1024;
export const MEMORY_RECALL_MAX_FACTS = 8;
export const MEMORY_RECALL_TIMEOUT_MS = 2500;

/** What to recall: durable, identity-shaping facts (not transient chatter). */
export const MEMORY_RECALL_QUERY =
  "user's goals, plans, preferences, important personal facts, and current focus";

/**
 * Derive the Graphiti group id for an app user. MUST stay byte-identical to the
 * `life-memory-scope` hook (`"app_" + sanitize(appUserId)`, sanitize lowercases and
 * maps every non `[A-Za-z0-9_]` char to `_`) so this client reads the SAME scope the
 * agent's own tool calls write. `appUserId` is already lowercased by the resolvers,
 * so the replace just collapses `-` → `_`.
 */
export function appGroupIdFromUserId(appUserId: string): string {
  return "app_" + appUserId.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Bound `content` to {@link MEMORY_RECALL_MAX_BYTES} on a UTF-8 boundary (drops a split trailing char). */
export function clampMemoryRecall(content: string, maxBytes = MEMORY_RECALL_MAX_BYTES): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  let s = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
  if (s.endsWith("�")) {
    s = s.slice(0, -1);
  }
  return s;
}

/** Pure: build the synthetic `MEMORY_RECALL.md` file from fact strings, or null when there are none. */
export function buildMemoryRecallContextFile(facts: string[]): WorkspaceBootstrapFile | null {
  const cleaned = facts.map((f) => f.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return null;
  }
  const body =
    "Durable facts already known about this user (from long-term memory). " +
    "Lean on these first; call search_memory_facts only when you need more.\n\n" +
    cleaned.map((f) => `- ${f}`).join("\n");
  return {
    name: MEMORY_RECALL_CONTEXT_NAME,
    path: MEMORY_RECALL_CONTEXT_NAME,
    content: clampMemoryRecall(body),
    missing: false,
  } as unknown as WorkspaceBootstrapFile;
}

/** Injectable seam for tests; defaults to the real Graphiti client. */
export type FactSearcher = typeof searchMemoryFacts;

/**
 * Append the per-user `MEMORY_RECALL.md` context file for an app-user session with a
 * resolvable `appUserId` and at least one durable fact. No-op (returns `files`
 * unchanged) for Telegram / no-appUserId sessions, an empty graph, or ANY error
 * (fail open). `sessionKey` MUST be the real session key.
 */
export async function appendMemoryRecallBootstrapFile(
  files: WorkspaceBootstrapFile[],
  params: { sessionKey?: string; searchFacts?: FactSearcher },
): Promise<WorkspaceBootstrapFile[]> {
  if (!isAppUserSession(params.sessionKey)) {
    return files;
  }
  const appUserId =
    resolveAppUserId(params.sessionKey) ?? appUserIdFromSessionKey(params.sessionKey);
  if (!appUserId) {
    return files;
  }
  const search = params.searchFacts ?? searchMemoryFacts;
  try {
    const facts = await search({
      groupId: appGroupIdFromUserId(appUserId),
      query: MEMORY_RECALL_QUERY,
      maxFacts: MEMORY_RECALL_MAX_FACTS,
      timeoutMs: MEMORY_RECALL_TIMEOUT_MS,
    });
    const contextFile = buildMemoryRecallContextFile(facts);
    return contextFile ? [...files, contextFile] : files;
  } catch {
    return files; // fail open — never block the turn on recall
  }
}

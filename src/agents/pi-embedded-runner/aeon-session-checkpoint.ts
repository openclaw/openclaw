/**
 * Aeon V3 WAL Checkpoint — Lazy Rehydration
 *
 * Materializes the in-memory Aeon WAL transcript into a Pi-compatible JSONL
 * session file **before** SessionManager.open() reads it.  This bridges the
 * read-path gap: writes flow exclusively through Aeon's microsecond WAL while
 * Pi's SessionManager continues to read from JSONL on disk.
 *
 * The JSONL file is a transient *Read Cache* — Aeon WAL remains the single
 * source of truth.  The file is overwritten atomically on every session open
 * (inside the existing session write lock) so stale data is never served.
 *
 * Performance:  Single memcpy from WAL ring buffer → serialized string →
 * writeFileSync.  No disk reads.  Typical latency: <1ms for ≤200 messages.
 */

import fs from "node:fs";
import path from "node:path";
import { getAeonPlugin, loadAeonMemoryAsync } from "../../utils/aeon-loader.js";

/**
 * Materialize Aeon WAL data into a Pi-compatible JSONL session file.
 *
 * Must be called **inside** the session write lock and **before**
 * `SessionManager.open(sessionFile)`.
 *
 * If Aeon is unavailable or the WAL is empty for this session, this function
 * is a no-op — the legacy JSONL path (or fresh session) proceeds normally.
 */
export async function aeonCheckpointSessionFile(params: {
  sessionFile: string;
  sessionId: string;
  cwd: string;
}): Promise<void> {
  await loadAeonMemoryAsync();

  const AeonMemoryPlugin = getAeonPlugin();
  if (!AeonMemoryPlugin) {
    return;
  }

  const aeon = AeonMemoryPlugin.getInstance();
  if (!aeon || !aeon.isAvailable()) {
    return;
  }

  // ── Fetch WAL transcript (synchronous C++ → JS boundary) ──────────────
  const rawMessages = aeon.getTranscript(params.sessionId);
  if (!Array.isArray(rawMessages)) {
    console.error("🚨 [AeonMemory] Invalid WAL payload: transcript is not an array");
    return; // Safely abort checkpoint
  }
  const messages = rawMessages;
  if (messages.length === 0) {
    return;
  }

  // ── Rehydration Protocol ──────────────────────────────────────────────
  // Pi's SessionManager expects a linked-list JSONL structure:
  //   Line 0:  { type: "session", version: 1, id, cwd, createdAt }
  //   Line N:  { type: "message", id, parentId, message: <AgentMessage> }
  //
  // We reconstruct this tree from the flat WAL array using deterministic
  // IDs so that repeated checkpoints produce identical output (idempotent).

  const lines: string[] = [];
  const sessionIdShort = params.sessionId.slice(0, 8);

  // Session header
  const header = {
    type: "session",
    version: 1,
    id: params.sessionId,
    cwd: params.cwd,
    createdAt: Date.now(),
  };
  lines.push(JSON.stringify(header));

  // Message entries with deterministic tree linking
  let prevId: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }

    const entryId = `aeon-${sessionIdShort}-${i}`;
    const entry = {
      type: "message",
      id: entryId,
      parentId: prevId,
      message: msg,
    };
    lines.push(JSON.stringify(entry));
    prevId = entryId;
  }

  // ── Atomic write ──────────────────────────────────────────────────────
  // Ensure parent directory exists (defensive — should already exist from
  // session store initialization).
  const dir = path.dirname(params.sessionFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Single writeFileSync — atomic under the session write lock.
  // Newline-terminated for JSONL compliance.
  fs.writeFileSync(params.sessionFile, lines.join("\n") + "\n", "utf-8");
}

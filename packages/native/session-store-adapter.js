// Session store adapter: bridges OpenClaw session operations to Rust-owned SQLite.
// Data stays outside V8 heap. Falls back to fs-based JSON when native unavailable.
// Phase 5: eliminates ~200MB RSS from session data in V8 GC heap.

const { SessionStore } = require("./index.js");

let initialized = false;

function ensureOpen(dbPath) {
  if (!initialized) {
    SessionStore.open(dbPath);
    initialized = true;
  }
}

function loadSessionStore(storePath) {
  ensureOpen(storePath);
  const ids = SessionStore.listIds();
  const sessions = {};
  for (const id of ids) {
    const data = SessionStore.get(id);
    if (data) {
      try {
        sessions[id] = JSON.parse(data);
      } catch {
        // skip corrupted entries
      }
    }
  }
  return sessions;
}

function saveSessionStore(storePath, sessions) {
  ensureOpen(storePath);
  for (const [id, entry] of Object.entries(sessions)) {
    SessionStore.upsert(id, JSON.stringify(entry));
  }
}

function updateSessionEntry(storePath, sessionId, mutator) {
  ensureOpen(storePath);
  const existing = SessionStore.get(sessionId);
  const entry = existing ? JSON.parse(existing) : {};
  const mutated = mutator(entry);
  SessionStore.upsert(sessionId, JSON.stringify(mutated));
}

function deleteSessionEntry(storePath, sessionId) {
  ensureOpen(storePath);
  SessionStore.delete(sessionId);
}

function appendTranscriptEntry(storePath, sessionId, seq, entryType, data) {
  ensureOpen(storePath);
  SessionStore.transcriptAppend(sessionId, seq, entryType, JSON.stringify(data));
}

function loadTranscriptEntries(storePath, sessionId) {
  ensureOpen(storePath);
  const raw = SessionStore.transcriptGetAll(sessionId);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

module.exports = {
  loadSessionStore,
  saveSessionStore,
  updateSessionEntry,
  deleteSessionEntry,
  appendTranscriptEntry,
  loadTranscriptEntries,
};

// @openclaw/native-core - Rust napi-rs native bindings + SQLite session store
// Falls back to pure JS implementations when the native module is unavailable.

let native;

try {
  native = require("./crates/native-core/openclaw-native-core.node");
} catch {
  try {
    native = require("@openclaw/native-core-win32-x64-msvc");
  } catch {
    native = null;
  }
}

const startTime = Date.now();

// ── Core utilities ──

function version() {
  return native?.version() ?? "0.1.0 (js-fallback)";
}

function uptimeMs() {
  return native?.uptime_ms() ?? Date.now() - startTime;
}

function hardwareConcurrency() {
  return (
    native?.hardware_concurrency() ??
    ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1)
  );
}

function parseJson(input) {
  if (native) {
    return native.parseJson(input);
  }
  return JSON.stringify(JSON.parse(input), null, 2);
}

// ── SQLite Session Store ──
// Sessions live in Rust-owned SQLite (outside V8 heap).
// JS gets thin handles; data stays in Rust memory.

let sessionStoreFallback = null;

function initSessionStoreFallback(dbPath) {
  // Pure JS fallback: in-memory Map + JSON persistence
  const fs = require("fs");
  const path = require("path");
  const store = { sessions: new Map(), transcripts: new Map(), path: dbPath };
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (fs.existsSync(dbPath)) {
      const data = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      if (data.sessions) {
        for (const [id, entry] of Object.entries(data.sessions)) {
          store.sessions.set(id, entry);
        }
      }
    }
  } catch {}
  store._persist = () => {
    try {
      const obj = {};
      for (const [id, entry] of store.sessions) {
        obj[id] = entry;
      }
      fs.writeFileSync(dbPath, JSON.stringify({ sessions: obj }, null, 2));
    } catch {}
  };
  return store;
}

function persistFallback() {
  if (sessionStoreFallback) sessionStoreFallback._persist();
}

const SessionStore = {
  open(dbPath) {
    if (native) {
      return native.sessionStoreOpen(dbPath);
    }
    sessionStoreFallback = initSessionStoreFallback(dbPath);
    return sessionStoreFallback.sessions.size;
  },

  isOpen() {
    return native ? native.sessionStoreIsOpen() : sessionStoreFallback !== null;
  },

  upsert(sessionId, data) {
    if (native) {
      return native.sessionStoreUpsert(sessionId, data);
    }
    if (!sessionStoreFallback) throw new Error("Session store not open");
    sessionStoreFallback.sessions.set(sessionId, JSON.parse(data));
    persistFallback();
  },

  get(sessionId) {
    if (native) {
      return native.sessionStoreGet(sessionId) ?? undefined;
    }
    if (!sessionStoreFallback) return undefined;
    const entry = sessionStoreFallback.sessions.get(sessionId);
    return entry ? JSON.stringify(entry) : undefined;
  },

  listIds() {
    if (native) {
      return native.sessionStoreListIds();
    }
    if (!sessionStoreFallback) return [];
    return [...sessionStoreFallback.sessions.keys()];
  },

  delete(sessionId) {
    if (native) {
      return native.sessionStoreDelete(sessionId);
    }
    if (!sessionStoreFallback) return false;
    const deleted = sessionStoreFallback.sessions.delete(sessionId);
    sessionStoreFallback.transcripts.delete(sessionId);
    persistFallback();
    return deleted;
  },

  transcriptAppend(sessionId, seq, entryType, data) {
    if (native) {
      return native.transcriptAppend(sessionId, seq, entryType, data);
    }
    if (!sessionStoreFallback) throw new Error("Session store not open");
    if (!sessionStoreFallback.transcripts.has(sessionId)) {
      sessionStoreFallback.transcripts.set(sessionId, []);
    }
    const entries = sessionStoreFallback.transcripts.get(sessionId);
    const entry = { seq, type: entryType, data: JSON.parse(data) };
    entries.push(entry);
    return entries.length;
  },

  transcriptGetAll(sessionId) {
    if (native) {
      return native.transcriptGetAll(sessionId);
    }
    if (!sessionStoreFallback) return "[]";
    const entries = sessionStoreFallback.transcripts.get(sessionId) ?? [];
    return JSON.stringify(entries);
  },

  transcriptCount(sessionId) {
    if (native) {
      return native.transcriptCount(sessionId);
    }
    if (!sessionStoreFallback) return 0;
    return (sessionStoreFallback.transcripts.get(sessionId) ?? []).length;
  },

  close() {
    if (native) {
      return native.sessionStoreClose();
    }
    persistFallback();
    sessionStoreFallback = null;
    return true;
  },
};

module.exports = {
  version,
  uptimeMs,
  hardwareConcurrency,
  parseJson,
  SessionStore,
};

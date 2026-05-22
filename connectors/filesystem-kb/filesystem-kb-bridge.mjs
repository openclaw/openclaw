#!/usr/bin/env node
/**
 * Watch local folders and emit kb.folder_sync when content changes (mtime/size).
 * Playbook `kb_folder_sync_on_event` ingests via ingest_folder + memory flush.
 *
 * Env:
 *   CLAWORKS_KB_WATCH_DIRS — comma-separated paths
 *   CLAWORKS_KB_WATCH_INTERVAL_MS — default 300000 (5m)
 *   CLAWORKS_KB_NAMESPACE — default work
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { createNdjsonBridge } from "../_shared/ndjson-stdio.mjs";

const bridge = createNdjsonBridge();
const ALLOWED = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".yaml", ".yml"]);
const state = {
  timer: null,
  snapshot: new Map(),
  dirs: [],
  intervalMs: 300_000,
  namespace: "work",
};

function listFiles(dir, recursive, out = []) {
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory() && recursive) {
          listFiles(full, true, out);
        } else if (st.isFile() && ALLOWED.has(extname(name).toLowerCase())) {
          out.push({ path: full, mtime: st.mtimeMs, size: st.size });
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return out;
}

function fingerprint(files) {
  const payload = files
    .map((f) => `${f.path}:${f.mtime}:${f.size}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function scanAndEmit(force = false) {
  const all = [];
  for (const dir of state.dirs) {
    listFiles(dir, true, all);
  }
  const hash = fingerprint(all);
  if (!force && hash === state.snapshot.get("__global__")) {
    return { changed: false, files: all.length };
  }
  state.snapshot.set("__global__", hash);
  for (const dir of state.dirs) {
    bridge.emitEvent({
      event_type: "kb.folder_sync",
      source: `connector://filesystem-kb`,
      payload: {
        folder_path: dir,
        namespace: state.namespace,
        file_count: all.filter((f) => f.path.startsWith(dir)).length,
      },
    });
  }
  return { changed: true, files: all.length };
}

bridge.onReady({ connector: "filesystem-kb" });

bridge.listen(async (msg) => {
  if (msg.method === "start") {
    const dirsRaw = String(msg.params?.dirs ?? process.env.CLAWORKS_KB_WATCH_DIRS ?? "").trim();
    state.dirs = dirsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (state.dirs.length === 0) {
      bridge.result(msg.id, false, undefined, "CLAWORKS_KB_WATCH_DIRS is required");
      return;
    }
    state.intervalMs = Number(
      msg.params?.interval_ms ?? process.env.CLAWORKS_KB_WATCH_INTERVAL_MS ?? 300_000,
    );
    state.namespace = String(msg.params?.namespace ?? process.env.CLAWORKS_KB_NAMESPACE ?? "work");
    if (state.timer) {
      clearInterval(state.timer);
    }
    const first = scanAndEmit(true);
    state.timer = setInterval(
      () => {
        try {
          scanAndEmit(false);
        } catch (err) {
          bridge.log(`scan failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
        }
      },
      Math.max(60_000, state.intervalMs),
    );
    bridge.result(msg.id, true, {
      started: true,
      dirs: state.dirs,
      interval_ms: state.intervalMs,
      initial: first,
    });
    return;
  }

  if (msg.method === "stop") {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    bridge.result(msg.id, true, { stopped: true });
    return;
  }

  if (msg.method === "scan_once") {
    bridge.result(msg.id, true, scanAndEmit(true));
    return;
  }

  bridge.result(msg.id, false, undefined, `unknown method: ${msg.method}`);
});

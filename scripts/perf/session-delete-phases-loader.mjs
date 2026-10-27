// Diagnostic-only phase/fsync attribution for session-delete-measure.ts. Never delays syscalls.
import fs from "node:fs";
import { registerHooks } from "node:module";
import { isMainThread, threadId } from "node:worker_threads";
import { parse } from "acorn";

const output = process.env.OPENCLAW_DELETE_PHASE_OUTPUT;
if (output) {
  const files = new Map();
  const open = fs.openSync;
  const close = fs.closeSync;
  const sync = fs.fsyncSync;
  fs.openSync = function (file, ...args) {
    const fd = open.call(this, file, ...args);
    files.set(fd, String(file));
    return fd;
  };
  fs.closeSync = function (fd, ...args) {
    files.delete(fd);
    return close.call(this, fd, ...args);
  };
  fs.fsyncSync = function (fd, ...args) {
    const started = performance.now();
    try {
      return sync.call(this, fd, ...args);
    } finally {
      const file = files.get(fd);
      if (file) {
        const row = {
          threadId,
          kind: file.endsWith("jsonl-stage") ? "stage" : "other",
          ms: performance.now() - started,
        };
        fs.appendFileSync(`${output}/fsync-${threadId}.jsonl`, `${JSON.stringify(row)}\n`);
      }
    }
  };
}
if (isMainThread && output) {
  const names = new Set([
    "deleteGatewaySessionInScope",
    "prepareSessionLifecycleDrain",
    "cleanupSessionBeforeMutation",
    "ensureSessionRuntimeCleanup",
    "runPluginHostCleanup",
    "closeAcpRuntimeForSession",
    "closeChildAcpRuntimesForParent",
    "listAcpSessionEntries",
    "resetSessionAgentHarnesses",
    "deleteSqliteSessionEntryLifecycleInternal",
    "materializeSessionStateDeletePlans",
    "runSessionDeletionPlanning",
    "runSqliteSessionReclamation",
    "publishSessionStateArchives",
    "handleSessionStateSessionDeleted",
    "removeSessionWorktree",
    "emitSessionUnboundLifecycleEvent",
  ]);
  let rows = [];
  const installed = new Set();
  const key = Symbol.for("openclaw.benchmark.deletePhases");
  globalThis[key] = async (name, run) => {
    const started = performance.now();
    try {
      return await run();
    } finally {
      rows.push({ name, ms: performance.now() - started });
    }
  };
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (!url.includes("/dist/") || loaded.source == null) {
        return loaded;
      }
      let source =
        typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
      if (![...names].some((name) => source.includes(`function ${name}(`))) {
        return loaded;
      }
      const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
      const edits = [];
      function visit(node) {
        if (!node || typeof node !== "object") {
          return;
        }
        if (node.type === "FunctionDeclaration" && node.async && names.has(node.id?.name)) {
          installed.add(node.id.name);
          edits.push(
            [
              node.body.start + 1,
              `return await globalThis[Symbol.for("openclaw.benchmark.deletePhases")](${JSON.stringify(node.id.name)},async()=>{`,
            ],
            [node.body.end - 1, "});"],
          );
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            value.forEach(visit);
          } else if (value && typeof value === "object") {
            visit(value);
          }
        }
      }
      visit(ast);
      for (const [at, text] of edits.toSorted((a, b) => b[0] - a[0])) {
        source = source.slice(0, at) + text + source.slice(at);
      }
      return { ...loaded, source };
    },
  });
  process.on("message", (message) => {
    if (message?.channel !== "delete-phase") {
      return;
    }
    if (message.action === "reset") {
      rows = [];
    }
    if (message.action === "snapshot") {
      process.send?.({ channel: "delete-phase", rows, installed: [...installed] });
    }
  });
}

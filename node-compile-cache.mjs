import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import * as module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED === "gateway") {
  // Node has already started uncached. Restore worker caching after the respawn.
  delete process.env.NODE_DISABLE_COMPILE_CACHE;
  delete process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED;
}

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_FILES = 4096;
const MAX_VISITS = 16384;
const MAINTENANCE_BUDGET_MS = 30_000;
const BUILD_MARKER_RE = /^(?:[a-f0-9]{16}|\d+-\d+|no-package-json|build-[A-Za-z0-9._-]+)$/;
const sanitize = (value) => {
  const segment = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return segment && segment !== "." && segment !== ".." ? segment : "unknown";
};

function isCurrentCompileCache(directory, env) {
  const current = module.getCompileCacheDir?.();
  const desired = path.resolve(directory);
  return (
    current &&
    (path.resolve(current) === desired ||
      (env.NODE_COMPILE_CACHE &&
        path.resolve(env.NODE_COMPILE_CACHE) === desired &&
        path.dirname(path.resolve(current)) === desired))
  );
}

export function resolveOpenClawCompileCacheRespawnEnv({
  directory,
  env = process.env,
  foregroundGateway = false,
}) {
  // Keep a caller-owned cache when Node permissions can forbid process replacement.
  if (
    process.permission ||
    env.NODE_DISABLE_COMPILE_CACHE !== undefined ||
    (env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED === "1" && !foregroundGateway) ||
    !directory ||
    !module.getCompileCacheDir?.()
  ) {
    return undefined;
  }
  if (foregroundGateway && isMainThread) {
    return {
      ...env,
      NODE_COMPILE_CACHE: directory,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "gateway",
    };
  }
  if (isCurrentCompileCache(directory, env)) {
    return undefined;
  }
  return {
    ...env,
    NODE_COMPILE_CACHE: directory,
    OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
  };
}

export function enableOpenClawCompileCache({
  directory,
  env = process.env,
  foregroundGateway = false,
}) {
  if (!directory || env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return;
  }
  const owner = (globalThis[Symbol.for("openclaw.nodeCompileCacheBase")] ??= {});
  if (foregroundGateway && isMainThread) {
    // Main-thread synchronous cache flushes stall the event loop; workers keep
    // this cache base and flush on their own threads at their existing boundaries.
    owner.baseDirectory ??= path.resolve(directory);
    void maintainOpenClawCompileCache(directory);
    return;
  }
  try {
    const result = module.enableCompileCache(directory);
    if (
      result.status === module.constants.compileCacheStatus.ENABLED ||
      (result.status === module.constants.compileCacheStatus.ALREADY_ENABLED &&
        isCurrentCompileCache(directory, env))
    ) {
      owner.baseDirectory ??= path.resolve(directory);
      void maintainOpenClawCompileCache(directory);
      return;
    }
    if (result.status === module.constants.compileCacheStatus.ALREADY_ENABLED) {
      return;
    }
  } catch {
    // Disposable bytecode must never prevent startup.
  }
  if (!owner.unavailableReported) {
    owner.unavailableReported = true;
    process.stderr.write("[openclaw] Compile cache unavailable; continuing without it.\n");
  }
}

// Node owns pending bytecode per isolate. Drain it after module loading instead
// of leaving the whole graph for native worker/process teardown.
export function scheduleOpenClawCompileCacheFlush() {
  if (!module.getCompileCacheDir?.()) {
    return;
  }
  const owner = (globalThis[Symbol.for("openclaw.nodeCompileCacheBase")] ??= {});
  if (owner.flush) {
    return;
  }
  owner.flush = setImmediate(() => {
    owner.flush = undefined;
    try {
      module.flushCompileCache();
    } catch {
      // Disposable bytecode must never fail startup or a completed worker task.
    }
  });
  owner.flush.unref();
}

export function resolveOpenClawCompileCacheDirectory({
  installRoot,
  env = process.env,
  foregroundGateway = false,
  prewarm = false,
}) {
  if (env.NODE_DISABLE_COMPILE_CACHE !== undefined) {
    return undefined;
  }
  // Cold cache persistence runs after output on Node and Bun. Pay that cost only
  // for a long-lived Gateway, explicit prewarming, or a caller-requested cache.
  if (!prewarm && !foregroundGateway && env.NODE_COMPILE_CACHE === undefined) {
    return undefined;
  }
  const packagePath = path.join(installRoot, "package.json");
  let version = "unknown";
  let marker = "no-package-json";
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8"));
    version = typeof parsed.version === "string" ? sanitize(parsed.version) : version;
    const stat = statSync(packagePath);
    marker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  } catch {
    // Keep cache activation best-effort for incomplete installations.
  }
  try {
    const build = JSON.parse(
      readFileSync(path.join(installRoot, "dist", "build-info.json"), "utf8"),
    );
    if (typeof build.buildId === "string" && build.buildId.trim()) {
      marker = createHash("sha256").update(build.buildId).digest("hex").slice(0, 16);
    }
  } catch {
    // Older packages use the installation metadata above.
  }
  let base = path.resolve(env.NODE_COMPILE_CACHE || path.join(os.tmpdir(), "node-compile-cache"));
  // Workers inherit the qualified base. Repeated CLI descendants must not nest
  // another OpenClaw namespace; also collapse namespaces left by older launchers.
  while (
    path.basename(path.dirname(path.dirname(base))) === "openclaw" &&
    BUILD_MARKER_RE.test(path.basename(base))
  ) {
    base = path.dirname(path.dirname(path.dirname(base)));
  }
  return resolveSafeNodeCompileCacheDirectory(path.join(base, "openclaw", version, marker));
}

export function resolveSafeNodeCompileCacheDirectory(directory) {
  // Node can hang at 240/245 characters (and 283 for other path structures):
  // https://github.com/nodejs/node/issues/66438. Leave room for Node's cache leaf.
  if (process.platform === "win32" && path.resolve(directory).length > 200) {
    process.stderr.write(
      "[openclaw] Compile cache disabled: Windows cache path exceeds 200 characters.\n",
    );
    return undefined;
  }
  return directory;
}

async function maintainOpenClawCompileCache(directory) {
  // A detached process cannot inherit Node permission grants or revocations.
  if (process.permission) {
    return;
  }
  const owner = (globalThis[Symbol.for("openclaw.nodeCompileCacheBase")] ??= {});
  const scheduled = (owner.maintenance ??= new Set());
  if (scheduled.has(directory)) {
    return;
  }
  scheduled.add(directory);
  try {
    const previous = await fs.lstat(path.dirname(path.dirname(directory))).catch(() => undefined);
    if (previous && Date.now() - previous.mtimeMs < MAINTENANCE_INTERVAL_MS) {
      return;
    }
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--maintain", directory],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // Do not replay application preloads or write maintenance's own bytecode.
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => !/^(NODE_OPTIONS|BUN_OPTIONS)$/i.test(name),
            ),
          ),
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1",
        },
      },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // Disposable bytecode must never prevent startup or command completion.
  }
}

async function maintain(directory) {
  const root = path.dirname(path.dirname(directory));
  const version = path.basename(path.dirname(directory));
  if (
    path.basename(root) !== "openclaw" ||
    sanitize(version) !== version ||
    !BUILD_MARKER_RE.test(path.basename(directory))
  ) {
    return;
  }
  const now = Date.now();
  const previous = await fs.lstat(root).catch(() => undefined);
  for (const target of [root, path.dirname(directory), directory]) {
    const stat = target === root ? previous : await fs.lstat(target).catch(() => undefined);
    if (stat && !stat.isDirectory()) {
      return;
    }
  }
  if (previous && now - previous.mtimeMs < MAINTENANCE_INTERVAL_MS) {
    return;
  }
  await fs.mkdir(root, { recursive: true });
  // Keep the lock outside the namespace: acquiring it must not claim completion.
  const lock = `${root}.maintenance`;
  const held = await fs.lstat(lock).catch(() => undefined);
  if (held && now - held.mtimeMs > 5 * 60 * 1000) {
    await fs.rmdir(lock).catch(() => {});
  }
  if (
    !(await fs.mkdir(lock).then(
      () => true,
      () => false,
    ))
  ) {
    return;
  }
  const files = [];
  let bytes = 0;
  let visits = 0;
  let completed = false;
  async function prune() {
    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    while (files.length) {
      if (Date.now() - now > MAINTENANCE_BUDGET_MS) {
        return false;
      }
      const oldest = files[files.length - 1];
      if (bytes <= MAX_BYTES && files.length <= MAX_FILES && now - oldest.mtimeMs <= MAX_AGE_MS) {
        break;
      }
      await fs.unlink(oldest.file).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      bytes -= oldest.size;
      files.pop();
    }
    return true;
  }
  async function visit(dir) {
    for await (const entry of await fs.opendir(dir)) {
      if (++visits > MAX_VISITS || Date.now() - now > MAINTENANCE_BUDGET_MS) {
        return false;
      }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await visit(file))) {
          return false;
        }
      } else if (entry.isFile()) {
        const stat = await fs.lstat(file).catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
        if (!stat) {
          continue;
        }
        bytes += stat.size;
        files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        // Bound retained metadata as well as bytes so tiny files cannot starve
        // later entries on the next bounded pass. Evict oldest observed files.
        if (files.length % 256 === 0 && !(await prune())) {
          return false;
        }
      }
    }
    return true;
  }
  // Keep recent releases together so preparing a candidate cannot evict
  // the serving release (or vice versa). Bound the entire owned namespace.
  try {
    // Another process may have finished between our first read and lock acquisition.
    if (now - (await fs.lstat(root)).mtimeMs < MAINTENANCE_INTERVAL_MS) {
      completed = true;
      return;
    }
    const walked = await visit(root);
    if ((await prune()) && walked) {
      const finished = new Date();
      await fs.utimes(root, finished, finished);
      completed = true;
    }
  } finally {
    // Removing a legacy file directly under the namespace also changes mtime.
    if (!completed) {
      await fs
        .utimes(root, previous?.atime ?? new Date(0), previous?.mtime ?? new Date(0))
        .catch(() => {});
    }
    await fs.rmdir(lock);
  }
}

if (
  process.argv[2] === "--maintain" &&
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[3]
) {
  void maintain(process.argv[3]).catch(() => {
    // Disposable bytecode cleanup is best-effort in the detached process too.
  });
}

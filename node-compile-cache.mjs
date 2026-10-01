import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isMainThread, Worker, workerData } from "node:worker_threads";

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const BUILD_MARKER_RE = /^(?:\d+-\d+|no-package-json|build-[A-Za-z0-9._-]+)$/;
const sanitize = (value) => {
  const segment = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return segment && segment !== "." && segment !== ".." ? segment : "unknown";
};

export function resolveOpenClawCompileCacheDirectory({ installRoot, env = process.env }) {
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
      marker = `build-${sanitize(build.buildId).slice(0, 96)}`;
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
  return path.join(base, "openclaw", version, marker);
}

export async function maintainOpenClawCompileCache(directory) {
  // Node permission grants and later revocations do not extend to workers.
  if (process.permission) {
    return undefined;
  }
  const owner = (globalThis[Symbol.for("openclaw.nodeCompileCacheBase")] ??= {});
  const pending = (owner.maintenance ??= new Map());
  if (pending.has(directory)) {
    return pending.get(directory);
  }
  const task = new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { openclawCompileCacheDirectory: directory },
      // Maintenance must not replay CLI entry preloads or application loaders.
      execArgv: [],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !/^(NODE_OPTIONS|BUN_OPTIONS)$/i.test(name)),
      ),
    });
    worker.on("error", () => {});
    worker.once("exit", () => resolve());
    // Callers can await completed cleanup, but unawaited cache work must not
    // extend a command's lifetime. A Promise alone does not keep Node alive.
    worker.unref();
  })
    .catch(() => {
      // Disposable bytecode must never prevent startup or command completion.
    })
    .finally(() => pending.delete(directory));
  pending.set(directory, task);
  return task;
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
  await fs.mkdir(directory, { recursive: true });
  let retired = false;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const versionRoot = path.join(root, entry.name);
    for (const build of await fs.readdir(versionRoot, { withFileTypes: true })) {
      const candidate = path.join(versionRoot, build.name);
      if (build.isDirectory() && candidate !== directory) {
        await fs.rm(candidate, { recursive: true, force: true });
        retired = true;
      }
    }
    if (versionRoot !== path.dirname(directory)) {
      await fs.rmdir(versionRoot).catch(() => {});
    }
  }
  if (!retired && previous && now - previous.mtimeMs < MAINTENANCE_INTERVAL_MS) {
    return;
  }
  // Claim the interval before walking: later CLIs should not repeat a large
  // scan while it is running. Interrupted maintenance can retry next hour.
  await fs.utimes(root, new Date(now), new Date(now));
  const files = [];
  let bytes = 0;
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile()) {
        const stat = await fs.lstat(file);
        bytes += stat.size;
        files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await visit(directory);
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const file of files) {
    if (bytes > MAX_BYTES || now - file.mtimeMs > MAX_AGE_MS) {
      await fs.unlink(file.file);
      bytes -= file.size;
    }
  }
}

if (!isMainThread && typeof workerData?.openclawCompileCacheDirectory === "string") {
  void maintain(workerData.openclawCompileCacheDirectory).catch(() => {
    // Disposable bytecode cleanup is best-effort inside the worker too.
  });
}

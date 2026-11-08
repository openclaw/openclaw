#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  chmodSync,
  chownSync,
  fchownSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  watch,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const shaPattern = /^[a-f\d]{40}$/;
const operationalReserveBytes = 16 * 1024 ** 3;
const [command, ...args] = process.argv.slice(2);
const suspensionContractPath = "/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs";
const suspensionContractSha256 = "dfdf7487710647a5ea5a7ae4f2edb06812b2b251cb2ec4880d791ad650a5e456";
let suspensionContract;

function reject(message) {
  throw new Error(message);
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) reject(`${label} is invalid`);
  return parsed;
}

function rootGroup() {
  return integer(process.env.OPENCLAW_TEAM_ROOT_GID ?? "0", "root group");
}

function exactDirectory(pathname, uid, label, { privateOnly = false, group = rootGroup() } = {}) {
  const entry = lstatSync(pathname);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.uid !== uid ||
    entry.gid !== group
  ) {
    reject(`${label} is not an exact owner-safe directory`);
  }
  if ((entry.mode & 0o022) !== 0 || (privateOnly && (entry.mode & 0o077) !== 0)) {
    reject(`${label} is writable or exposes private deployment metadata`);
  }
  return entry;
}

function assertUnpopulatedCgroup(directory, label, category = label) {
  const fields = new Map();
  const eventsPath = join(directory, "cgroup.events");
  const metadata = lstatSync(eventsPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) reject(`${category} cgroup state is unsafe`);
  const contents = readFileSync(eventsPath, "utf8");
  if (contents.length > 256) reject(`${category} cgroup state is oversized`);
  for (const line of contents.trim().split("\n")) {
    const match = /^(populated|frozen) ([01])$/.exec(line);
    if (!match || fields.has(match[1])) reject(`${category} cgroup state is ambiguous`);
    fields.set(match[1], match[2]);
  }
  if (!fields.has("populated")) reject(`${category} cgroup population is unknown`);
  if (fields.get("populated") !== "0") reject(`${label} work has not settled`);
}

function assertUserManagerStopped(boundary, rawUid) {
  if (!isAbsolute(boundary) || resolve(boundary) !== boundary)
    reject("user manager cgroup boundary is not canonical");
  const uid = integer(rawUid, "runtime owner");
  const owner = integer(process.env.OPENCLAW_TEAM_ROOT_UID ?? "0", "root owner");
  const expected = { LoadState: "loaded", ActiveState: "inactive", SubState: "dead",
    MainPID: "0", ControlPID: "0", Job: "", ControlGroup: "" };
  const group = `user.slice/user-${uid}.slice/user@${uid}.service`;
  const fields = new Map();
  for (const line of readFileSync(0, "utf8").replace(/\n$/, "").split("\n")) {
    const split = line.indexOf("="), key = line.slice(0, split), value = line.slice(split + 1);
    if (split < 0 || !Object.hasOwn(expected, key) || fields.has(key)) reject("user manager state is ambiguous");
    fields.set(key, value);
  }
  if (fields.size !== Object.keys(expected).length || [...fields].some(([key, value]) =>
    value !== expected[key] && !(key === "Job" && value === "0") && !(key === "ControlGroup" && value === `/${group}`)))
    reject("user manager is not positively stopped");
  // systemd delegates the manager cgroup to the runtime account. Its ancestors
  // stay root-owned; the kernel population bit includes any surviving children.
  const parts = ["sys", "fs", "cgroup", "user.slice", `user-${uid}.slice`, `user@${uid}.service`];
  let directory = boundary;
  for (const [index, part] of parts.entries()) {
    directory = join(directory, part);
    try {
      const entry = lstatSync(directory);
      exactDirectory(directory, index === parts.length - 1 && entry.uid === uid ? uid : owner,
        "user manager cgroup", { group: index === parts.length - 1 ? entry.gid : rootGroup() });
    } catch (error) {
      if (error.code === "ENOENT" && index >= 3) return "USER_MANAGER_STOPPED";
      throw error;
    }
  }
  assertUnpopulatedCgroup(directory, "user manager");
  return "USER_MANAGER_STOPPED";
}

function assertMaintenanceIdle(boundary) {
  if (!isAbsolute(boundary) || resolve(boundary) !== boundary)
    reject("maintenance cgroup boundary is not canonical");
  const owner = integer(process.env.OPENCLAW_TEAM_ROOT_UID ?? "0", "root owner");
  for (const name of ["sys", "sys/fs", "sys/fs/cgroup", "sys/fs/cgroup/system.slice"])
    exactDirectory(join(boundary, name), owner, "maintenance cgroup ancestor");
  for (const [unit, label] of [
    ["openclaw-disk-maintenance.service", "disk maintenance storage"],
    ["openclaw-hourly-health-check.service", "health-check"],
  ]) {
    const directory = join(boundary, "sys/fs/cgroup/system.slice", unit);
    try {
      exactDirectory(directory, owner, "maintenance cgroup");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // Recursive kernel population remains authoritative after EX acquisition,
    // when no new maintenance writer can get the shared deployment lock.
    assertUnpopulatedCgroup(directory, label, "maintenance");
  }

  return "MAINTENANCE_IDLE";
}

function identity(pathname) {
  const entry = lstatSync(pathname);
  if (!entry.isFile() || entry.isSymbolicLink()) reject(`protected path is unsafe: ${pathname}`);
  return { path: pathname, device: entry.dev, inode: entry.ino };
}

function jsonFile(pathname) {
  const entry = lstatSync(pathname);
  if (!entry.isFile() || entry.isSymbolicLink()) reject(`unsafe JSON file: ${pathname}`);
  return JSON.parse(readFileSync(pathname, "utf8"));
}

function jsonArgument(value) {
  return JSON.parse(value === "@stdin" ? readFileSync(0, "utf8") : value);
}

function cpuDegradedOption(requiredArgs) {
  if (args.length === requiredArgs) return false;
  if (args.length === requiredArgs + 1 && args[requiredArgs] === "--allow-cpu-degraded")
    return true;
  reject("invalid performance waiver argument");
}

function snapshotCpuWaived(snapshot, allowCpuDegraded, label, deploymentAcceptance = false) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    (snapshot.partial !== undefined && snapshot.partial !== false) ||
    (snapshot.warnings !== undefined &&
      (!Array.isArray(snapshot.warnings) || snapshot.warnings.length !== 0))
  )
    reject(`Gateway ${label} snapshot is partial or malformed`);
  const eventLoop = snapshot.eventLoop;
  if (
    !eventLoop ||
    typeof eventLoop !== "object" ||
    Array.isArray(eventLoop) ||
    typeof eventLoop.degraded !== "boolean"
  )
    reject(`Gateway ${label} event-loop evidence is malformed`);
  const { degraded, reasons } = eventLoop;
  if (
    (degraded || reasons !== undefined) &&
    (!Array.isArray(reasons) ||
      new Set(reasons).size !== reasons.length ||
      reasons.some(
        (reason) => !["cpu", "event_loop_utilization", "event_loop_delay"].includes(reason),
      ) ||
      degraded !== reasons.length > 0)
  )
    reject(`Gateway ${label} degradation reasons are malformed or contradictory`);
  for (const field of [
    "intervalMs",
    "delayP99Ms",
    "delayMaxMs",
    "utilization",
    "cpuCoreRatio",
    "degradedSinceMs",
  ]) {
    const value = eventLoop[field];
    if (!degraded && value === undefined) continue;
    if (field === "degradedSinceMs" && !degraded) {
      if (value === null) continue;
      reject(`Gateway ${label} nondegraded timestamp is contradictory`);
    }
    if (!Number.isFinite(value) || value < 0 ||
        (field === "intervalMs" && value === 0) || (field === "utilization" && value > 1))
      reject(`Gateway ${label} event-loop metric ${field} is malformed`);
  }
  if (!degraded) return false;
  // Native CPU/utilization warnings describe load, not lost admission. Deployment
  // can progress with bounded delay; profiling still requires an undegraded sample.
  if (deploymentAcceptance && !reasons.includes("event_loop_delay") &&
      Number.isFinite(eventLoop.delayP99Ms) && eventLoop.delayP99Ms < 1000 &&
      Number.isFinite(eventLoop.delayMaxMs) && eventLoop.delayMaxMs < 1000) {
    return false;
  }
  // Native reasons own threshold policy. Never rewrite evidence or infer reasons from metrics.
  if (!allowCpuDegraded) reject(`Gateway ${label} snapshot is degraded`);
  return true;
}

function gatewayStartupPending(startup, startupCode, readiness, readinessCode) {
  if (!Number.isFinite(startup.uptimeMs) || startup.uptimeMs < 0) {
    reject("Gateway startupz proof is malformed");
  }
  if (readiness.agentDatabases !== undefined && !Array.isArray(readiness.agentDatabases)) {
    reject("Gateway agent admission is malformed");
  }
  if (readiness.stateDatabase !== undefined || readiness.agentDatabases?.some(
    value => value?.code !== "agent-database-inspection-pending")) {
    reject("Gateway database admission failed");
  }
  const agentId = operatorProfile().modelAgent;
  const refusal = readiness.agentDatabases?.find(value => value?.agentId === agentId);
  if (startupCode === "503" && startup.ok === false && startup.status === "starting") {
    if (typeof startup.pendingReason !== "string" || !startup.pendingReason) {
      reject("Gateway startupz recovery reason is malformed");
    }
    // Other agents may still inspect in the background after the marker's agent
    // and critical initial startup are admitted by native readyz.
    return startup.pendingReason !== "agent-database-inspection" ||
      readinessCode !== "200" || readiness.ready !== true || Boolean(refusal);
  }
  if (startupCode !== "200" || startup.ok !== true || startup.status !== "started") {
    reject("Gateway startupz is not started");
  }
  return Boolean(refusal);
}

const appServerPolicyFields = ["mode", "approvalPolicy", "approvalsReviewer", "sandbox", "defaultWorkspaceDir"];

function operatorProfile() {
  const raw = process.env.OPENCLAW_TEAM_OPERATOR_PROFILE;
  if (!raw) reject("OPENCLAW_TEAM_OPERATOR_PROFILE is required");
  const profile = JSON.parse(raw);
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    reject("operator profile is malformed");
  const { channels, policy: expected, modelAgent } = profile;
  if (!Array.isArray(channels) || channels.length === 0 || channels.some(pair =>
    !Array.isArray(pair) || pair.length !== 2 || pair.some(value =>
      typeof value !== "string" || !value.trim() || value.trim() !== value)) ||
    new Set(channels.map(pair => JSON.stringify(pair))).size !== channels.length)
    reject("operator profile channels are malformed");
  if (!expected || typeof modelAgent !== "string" || !modelAgent.trim() || modelAgent.trim() !== modelAgent ||
    !expected.appServer || appServerPolicyFields.some(key => typeof expected.appServer[key] !== "string") ||
    typeof expected.mode !== "string" || expected.updateAuto !== false ||
    ["workspaceOnly", "clickclackCommandMenu"].some(key => typeof expected[key] !== "boolean"))
    reject("operator profile policy is malformed");
  return profile;
}

function verifyChannelAccounts(payload) {
  if (
    !payload.channelAccounts ||
    typeof payload.channelAccounts !== "object" ||
    Array.isArray(payload.channelAccounts)
  )
    reject("channel accounts are malformed");
  const { channels } = operatorProfile();
  for (const [name, accountId] of channels) {
    const accounts = payload.channelAccounts[name];
    if (!Array.isArray(accounts) || accounts.some((account) => !account ||
        typeof account !== "object" || Array.isArray(account) || typeof account.accountId !== "string"))
      reject(`${name} account structure is malformed`);
    const matches = accounts.filter((account) => account.accountId === accountId);
    if (
      matches.length !== 1 ||
      ["configured", "enabled", "restartPending"].some((field) =>
        matches[0][field] !== undefined && typeof matches[0][field] !== "boolean") ||
      (matches[0].lastError !== undefined && matches[0].lastError !== null &&
        typeof matches[0].lastError !== "string") ||
      matches[0].configured === false ||
      matches[0].enabled === false ||
      matches[0].running !== true ||
      matches[0].connected !== true ||
      matches[0].lifecycle !== "ready" ||
      matches[0].restartPending === true ||
      matches[0].lastError
    )
      reject(`${name}/${accountId} is not exactly ready`);
  }
}

function suspensionObject(value, fields, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.includes(field)) ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    reject(`${label} is malformed or has unexpected fields`);
  }
}

function suspensionToken(value, label) {
  if (typeof value !== "string" || !value || value.length > 128 || /\s/.test(value)) {
    reject(`${label} is invalid`);
  }
  return value;
}

function suspensionWriteCustody(response) {
  // Older residents omit custody; that is unknown, not evidence of no writes.
  if (!Object.hasOwn(response, "writeCustody")) return "unknown";
  if (response.writeCustody.some((row) => !Number.isSafeInteger(row.count)))
    reject("Gateway suspension write custody count is invalid");
  const held = response.writeCustody.some((row) => row.count > 0);
  if (held && response.status === "ready") reject("Gateway suspension ready result retains write custody");
  return held ? "held" : "clear";
}

function suspensionBlockers(response, label, custody) {
  if (!Number.isSafeInteger(response.activeCount) || response.activeCount < 0) {
    reject(`${label} active work count is invalid`);
  }
  if (response.blockers.some((blocker) => !Number.isSafeInteger(blocker.count)))
    reject(`${label} blocker count is invalid`);
  // Drain-ready settles writers; admitted non-writing work may still be active.
  // Legacy responses without custody retain the original idle requirement.
  if (response.status === "ready" &&
      ((custody !== "clear" && (response.activeCount !== 0 || response.blockers.length)) ||
       response.blockers.some(({ kind }) => kind === "terminal-persistence"))) {
    reject(`${label} still has active work or blockers`);
  }
  if (
    response.status === "draining" &&
    (response.activeCount === 0 || (response.blockers.length === 0 && custody !== "held"))
  ) {
    reject(`${label} draining progress is inconsistent`);
  }

  const counts = new Map();
  for (const { kind, count } of response.blockers) {
    const total = (counts.get(kind) ?? 0) + count;
    if (!Number.isSafeInteger(total)) reject(`${label} blocker category count is invalid`);
    counts.set(kind, total);
  }
  return (
    [...counts.keys()].sort()
      .map((kind) => `${kind}:${counts.get(kind)}`)
      .join(",") || "none"
  );
}

function suspensionRetryDelay(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    reject("Gateway suspension retry delay is invalid");
  }
  return value;
}

function safeRelative(root, pathname) {
  const result = relative(root, pathname);
  if (result === ".." || result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    reject(`path escapes release root: ${pathname}`);
  }
  return result;
}

function auditTree(root, uid, sealed) {
  const rootReal = realpathSync(root);
  const stack = [rootReal];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name);
      const metadata = lstatSync(pathname);
      if (
        sealed &&
        (metadata.uid !== uid ||
          metadata.gid !== rootGroup() ||
          (!metadata.isSymbolicLink() && (metadata.mode & 0o222) !== 0))
      ) {
        reject(`published release has unsafe ownership or permissions: ${pathname}`);
      }
      if (metadata.isSymbolicLink()) {
        const target = readlinkSync(pathname);
        if (isAbsolute(target)) reject(`absolute release symlink is forbidden: ${pathname}`);
        const resolved = realpathSync(pathname);
        safeRelative(rootReal, resolved);
      } else if (metadata.isDirectory()) {
        stack.push(pathname);
      } else if (!metadata.isFile()) {
        reject(`unsupported release entry: ${pathname}`);
      }
    }
  }
}

function validateRelease(root, expected, owner, sealed, requireManifest = true) {
  if (!shaPattern.test(expected)) reject("release SHA is not exact");
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) reject("release root is unsafe");
  if (
    sealed &&
    (metadata.uid !== owner || metadata.gid !== rootGroup() || (metadata.mode & 0o777) !== 0o555)
  ) {
    reject("published release root is not sealed");
  }
  const gitDirectory = lstatSync(join(root, ".git"));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) {
    reject("release uses a linked Git worktree");
  }
  if (existsSync(join(root, ".git", "objects", "info", "alternates"))) {
    reject("release depends on alternate Git objects");
  }
  if (readFileSync(join(root, ".git", "HEAD"), "utf8").trim() !== expected) {
    reject("standalone release Git HEAD drifted from its exact frozen SHA");
  }
  for (const pathname of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    if (!statSync(join(root, pathname)).isFile())
      reject(`release package closure is incomplete: ${pathname}`);
  }
  if (!statSync(join(root, "node_modules")).isDirectory()) {
    reject("release dependency closure is missing");
  }
  for (const name of [".buildstamp", ".runtime-postbuildstamp"]) {
    if (jsonFile(join(root, "dist", name)).head !== expected) reject(`${name} SHA drifted`);
  }
  const build = jsonFile(join(root, "dist", "build-info.json"));
  if (
    build.commit !== expected ||
    typeof build.buildId !== "string" ||
    build.buildId.length < 1 ||
    build.buildId.length > 128 ||
    build.buildId.trim() !== build.buildId
  ) {
    reject("release build identity is invalid");
  }
  const executable = statSync(join(root, "dist", "index.js"));
  if (!executable.isFile()) reject("release Gateway entrypoint is absent");
  const controlRoot = join(root, "dist", "control-ui");
  const html = readFileSync(join(controlRoot, "index.html"), "utf8");
  const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)]
    .map((match) => match[1])
    .filter((value) => /^(?:\.\/|\/)?assets\//u.test(value));
  if (references.length === 0) reject("Control UI has no startup assets");
  for (const asset of references) {
    const pathname = resolve(controlRoot, asset.replace(/^(?:\.\/|\/)/u, ""));
    safeRelative(controlRoot, pathname);
    if (!statSync(pathname).isFile()) reject(`Control UI asset is absent: ${asset}`);
  }
  const schemas = jsonFile(join(root, "package.json"))?.openclaw?.schemaVersions;
  for (const key of ["state", "agent"]) {
    if (!Number.isSafeInteger(schemas?.[key]) || schemas[key] < 0) {
      reject(`release ${key} schema declaration is invalid`);
    }
  }
  auditTree(root, owner, sealed);
  const uiDigest = createHash("sha256").update(html).digest("hex");
  const buildCacheInputsPath = join(root, "dist", "build-cache-inputs.json");
  const buildCacheInputs = existsSync(buildCacheInputsPath) ? jsonFile(buildCacheInputsPath) : undefined;
  if (buildCacheInputs && (buildCacheInputs.version !== 1 ||
      !buildCacheInputs.steps || typeof buildCacheInputs.steps !== "object" ||
      Array.isArray(buildCacheInputs.steps) ||
      Object.entries(buildCacheInputs.steps).some(([label, hash]) =>
        !label || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))) {
    reject("release build cache input hashes are invalid");
  }
  if (requireManifest) {
    const manifest = jsonFile(join(root, "deployment.json"));
    if (
      manifest.version !== 1 ||
      manifest.sourceSha !== expected ||
      manifest.buildId !== build.buildId ||
      manifest.controlUiSha256 !== uiDigest ||
      manifest.origin !== "https://github.com/openclaw/openclaw.git" ||
      manifest.schemaVersions?.state !== schemas.state ||
      manifest.schemaVersions?.agent !== schemas.agent ||
      !isDeepStrictEqual(manifest.buildCacheInputs, buildCacheInputs)
    ) {
      reject("deployment manifest does not match the exact sealed candidate");
    }
  }
  return {
    sha: expected,
    buildId: build.buildId,
    controlUiSha256: uiDigest,
    schemaVersions: schemas,
    ...(buildCacheInputs ? { buildCacheInputs } : {}),
  };
}

function validateFrozenRelease(root, target, manifestHash, owner) {
  if (!/^[a-f\d]{64}$/.test(manifestHash)) reject("frozen manifest SHA-256 is invalid");
  const before = lstatSync(root);
  if (!before.isDirectory() || before.isSymbolicLink()) reject("frozen release root is unsafe");
  const manifestPath = join(root, "deployment.json");
  const manifest = migrationFile(manifestPath, owner, { privateOnly: false, mode: 0o444, limit: 64 * 1024 });
  if (manifest.descriptor.sha256 !== manifestHash) reject("frozen manifest bytes changed");
  const value = migrationJson(manifest.bytes);
  if (value.sourceSha !== target || value.frozenOriginMain !== target)
    reject("frozen manifest does not bind the original exact main selection");
  const release = validateRelease(root, target, owner, true);
  const checked = migrationFile(manifestPath, owner, { privateOnly: false, mode: 0o444, limit: 64 * 1024 });
  const after = lstatSync(root);
  if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino ||
      after.uid !== owner || after.gid !== rootGroup() || (after.mode & 0o7777) !== 0o555 ||
      !isDeepStrictEqual(checked.descriptor, manifest.descriptor))
    reject("frozen release identity changed during validation");
  return { release, manifest: manifest.descriptor, root: { path: root, device: before.dev, inode: before.ino } };
}

function syncPath(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function releaseFootprint(root) {
  // Keep the large metadata walk outside V8: its optimized lstatSync loop has crashed.
  // Count every hardlink and sparse file's copy cost, rather than du's shared blocks.
  const result = spawnSync("python3", ["-c", `
import os, stat, sys
pending = [sys.argv[1]]
device = os.lstat(pending[0]).st_dev
size = entries = 0
while pending:
    path = pending.pop()
    entry = os.lstat(path)
    if entry.st_dev != device:
        sys.exit("release capacity inventory crosses filesystems")
    size += max(entry.st_size, entry.st_blocks * 512)
    entries += 1
    if stat.S_ISDIR(entry.st_mode):
        with os.scandir(path) as children:
            pending.extend(child.path for child in children)
    elif not (stat.S_ISREG(entry.st_mode) or stat.S_ISLNK(entry.st_mode)):
        sys.exit("release capacity inventory contains an unsupported entry")
print(size, entries)
`, root], { encoding: "utf8" });
  if (result.status !== 0) {
    reject(`cannot measure release capacity: ${result.error?.message ?? result.stderr.trim()}`);
  }
  const [bytes, entries] = result.stdout.trim().split(/\s+/).map(value => integer(value, "release footprint"));
  return { bytes, entries };
}

function releaseCapacity(phase, reference, mirror, buildHome, servingRoot, runtimeHome) {
  if (!["fetch", "build", "stage", "activate"].includes(phase)) reject("invalid release capacity phase");
  const empty = { bytes: 0, entries: 0 };
  const footprint = phase === "activate" ? empty : releaseFootprint(phase === "fetch" ? mirror : reference);
  if (phase === "build") {
    const git = releaseFootprint(mirror);
    footprint.bytes = Math.max(footprint.bytes, git.bytes);
    footprint.entries = Math.max(footprint.entries, git.entries);
  }
  const demands = [[servingRoot, empty], [runtimeHome, empty]];
  if (phase === "fetch") demands.push([mirror, footprint]);
  if (phase !== "activate") {
    demands.push([join(servingRoot, "staging"), phase === "fetch" ? empty : footprint]);
    // Budget full copy costs conservatively, including growth of the retained package store.
    // A shared filesystem owes their sum, not three independent free-space checks.
    const buildDemand = phase === "build" ? footprint : empty;
    demands.push([join(buildHome, "work"), buildDemand], [join(buildHome, "cache"), buildDemand]);
  }
  const devices = new Map();
  for (const [pathname, demand] of demands) {
    const entry = lstatSync(pathname);
    if (!entry.isDirectory() || entry.isSymbolicLink()) reject("release capacity root is unsafe");
    let device = devices.get(entry.dev);
    if (!device) {
      const disk = statfsSync(pathname);
      // Leave room for incumbent SQLite/WAL writes, logs, and transient build growth.
      device = { path: pathname, disk, bytes: operationalReserveBytes, entries: 16_384 };
      devices.set(entry.dev, device);
    }
    // Include destination allocation rounding even when the baseline is sparse or hardlinked.
    device.bytes += demand.bytes + demand.entries * device.disk.bsize;
    device.entries += demand.entries;
  }
  return [...devices.values()].map(({ path, disk, bytes, entries }) => {
    const available = disk.bavail * disk.bsize;
    if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(bytes))
      reject("release capacity cannot establish filesystem headroom");
    if (available < bytes)
      reject(`insufficient disk space for release ${phase} at ${path}: available=${available} required=${bytes}; reclaim owner-managed caches or releases before retrying`);
    if (disk.files > 0 && disk.ffree < entries)
      reject(`insufficient inodes for release ${phase} at ${path}: available=${disk.ffree} required=${entries}; reclaim owner-managed caches or releases before retrying`);
    return { path, availableBytes: available, requiredBytes: bytes, availableInodes: disk.ffree, requiredInodes: entries };
  });
}

async function sealTree(root) {
  const pending = [root];
  const files = [], directories = [];
  let bytes = 0;
  while (pending.length) {
    const pathname = pending.pop();
    const metadata = lstatSync(pathname);
    if (metadata.isSymbolicLink()) {
      continue;
    }
    if (metadata.isDirectory()) {
      directories.push(pathname);
      for (const name of readdirSync(pathname)) {
        pending.push(join(pathname, name));
      }
    } else if (!metadata.isFile()) {
      reject(`cannot seal unsupported release entry: ${pathname}`);
    } else {
      files.push(pathname);
      bytes += metadata.size;
    }
    chmodSync(pathname, metadata.isDirectory() || (metadata.mode & 0o111) !== 0 ? 0o555 : 0o444);
  }
  // Budget our tree at 100 entries/s and 8 MiB/s, never the filesystem's dirty data.
  const budgetMs = 120_000 + (files.length + directories.length) * 10 + bytes / 8192;
  const timeout = setTimeout(() => {
    process.stderr.write("openclaw-team-release: sealed release durability deadline exceeded\n");
    process.exit(124);
  }, budgetMs);
  const persist = async (paths) => {
    let next = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (next < paths.length) {
        const descriptor = await open(paths[next++], constants.O_RDONLY);
        try {
          await descriptor.sync();
        } finally {
          await descriptor.close();
        }
      }
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  };
  try {
    await persist(files);
    // Persist symlinks and directory entries without following links outside the tree.
    await persist(directories);
  } finally {
    clearTimeout(timeout);
  }
}

function makeDirectoriesOwnerWritable(root) {
  const metadata = lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeDirectoriesOwnerWritable(join(root, entry.name));
    }
  }
}

function atomicJson(pathname, value, { noReplace = false, mode = 0o600, group } = {}) {
  const temporary = `${pathname}.next.${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    if (group !== undefined) fchownSync(descriptor, -1, group);
    if (mode !== 0o600) fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (noReplace) {
    // link(2) publishes the fsynced bytes without ever replacing an existing journal.
    linkSync(temporary, pathname);
    unlinkSync(temporary);
  } else {
    renameSync(temporary, pathname);
  }
  syncPath(dirname(pathname));
}

const gatewayRuntimeDropInName = "50-openclaw-gateway-runtime.conf";

function runtimeDropInPath() {
  return join(process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/", "etc/systemd/system/openclaw-gateway.service.d", gatewayRuntimeDropInName);
}

function runtimeLiteral(pathname) {
  if (typeof pathname !== "string" || !/^\/[a-zA-Z0-9_./+-]+$/.test(pathname) || resolve(pathname) !== pathname)
    reject("Gateway runtime requires a canonical absolute path without shell or systemd expansions");
  return pathname;
}

function runtimeBinary(pathname, expectedHash, hash = true) {
  runtimeLiteral(pathname);
  const resolved = realpathSync(pathname), owner = migrationOwner();
  const boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
  // The fixture namespace can contain binaries; system-owned Node can live outside it.
  for (const directory of new Set([dirname(pathname), dirname(resolved)])) {
    const stop = directory === boundary || directory.startsWith(boundary + "/") ? boundary : "/";
    migrationAncestors(directory, owner, stop);
  }
  const link = lstatSync(pathname);
  if (link.uid !== owner || link.gid !== rootGroup()) reject("runtime binary link has an unsafe owner");
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.uid !== owner || entry.gid !== rootGroup() || (entry.mode & 0o022) ||
        !(entry.mode & 0o111))
      reject("Gateway runtime binary is not a protected executable");
    const stamp = stat => ({ device: stat.dev, inode: stat.ino, size: stat.size, mode: stat.mode,
      uid: stat.uid, gid: stat.gid, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    let sha256 = expectedHash;
    if (hash) {
      const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
      let count;
      while ((count = readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
      sha256 = digest.digest("hex");
      if (expectedHash && sha256 !== expectedHash) reject("Gateway runtime binary SHA-256 changed");
    }
    if (!isDeepStrictEqual(stamp(entry), stamp(fstatSync(fd))) || realpathSync(pathname) !== resolved ||
        !isDeepStrictEqual(stamp(entry), stamp(statSync(resolved)))) reject("Gateway runtime binary changed while inspected");
    return { path: resolved, ...stamp(entry), sha256 };
  } finally { closeSync(fd); }
}

function runtimeBody(root, selection) {
  runtimeLiteral(root); runtimeLiteral(selection.executable);
  if (!["node", "bun"].includes(selection.kind) || !/^[a-f\d]{64}$/.test(selection.binary?.sha256))
    reject("Gateway runtime selection is malformed");
  return `# OpenClaw Team Gateway runtime: ${selection.kind}\n# SHA-256: ${selection.binary.sha256}\n[Service]\nExecStart=\nExecStart=${selection.executable} ${root}/current/dist/index.js gateway --port ${integer(process.env.OPENCLAW_TEAM_GATEWAY_PORT ?? "18789", "Gateway port")}\n`;
}

function runtimeCurrent(root, hash = true) {
  const pathname = runtimeDropInPath();
  if (!lstatSync(pathname, { throwIfNoEntry: false }))
    return { kind: "node", executable: "/usr/bin/node", binary: null, dropIn: null };
  migrationAncestors(dirname(pathname), migrationOwner(), process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
  const file = migrationFile(pathname, migrationOwner(), { privateOnly: false, mode: 0o644, limit: 8192 });
  const body = file.bytes.toString("utf8");
  const match = /^# OpenClaw Team Gateway runtime: (node|bun)\n# SHA-256: ([a-f\d]{64})\n\[Service\]\nExecStart=\nExecStart=(\S+) /.exec(body);
  if (!match) reject("Gateway runtime override is not owner-generated");
  const selection = { kind: match[1], executable: match[3], binary: runtimeBinary(match[3], match[2], hash), dropIn: file.descriptor };
  if (body !== runtimeBody(root, selection)) reject("Gateway runtime override contains unrelated service changes");
  return selection;
}

function runtimeCheck(root, expected) {
  const current = runtimeCurrent(root, false);
  if (!current.binary && expected.binary)
    current.binary = runtimeBinary(current.executable, expected.binary.sha256, false);
  if (!isDeepStrictEqual(current, expected)) reject("selected Gateway runtime changed during the operation");
  return current;
}

function runtimeSame(left, right) {
  return left.kind === right.kind && left.executable === right.executable &&
    isDeepStrictEqual(left.binary, right.binary);
}

function runtimeJournalCheck(record, root, expected) {
  if (expected && (!isDeepStrictEqual(record.gatewayRuntime, expected.gatewayRuntime) ||
      !isDeepStrictEqual(record.runtimeChange, expected.runtimeChange))) reject("journal runtime binding changed");
  const current = runtimeCurrent(root, false);
  if (!current.binary && record.gatewayRuntime?.binary)
    current.binary = runtimeBinary(current.executable, record.gatewayRuntime.binary.sha256, false);
  if (!record.gatewayRuntime) {
    if (current.dropIn) reject("legacy journal does not authorize a managed Gateway runtime");
    return "original";
  }
  // A restore recreates the original override inode; bytes and executable identity must still match.
  const original = runtimeSame(current, record.gatewayRuntime);
  const selected = record.runtimeChange && runtimeSame(current, record.runtimeChange);
  if (!original && !selected) reject("Gateway runtime matches neither journal selection");
  if (!record.runtimeChange && !isDeepStrictEqual(current, record.gatewayRuntime))
    reject("Gateway runtime definition changed since journal admission");
  return original ? "original" : "selected";
}

function runtimePublish(root, selection, remove = false) {
  const pathname = runtimeDropInPath(), parent = dirname(pathname);
  migrationAncestors(parent, migrationOwner(), process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
  if (remove) {
    unlinkSync(pathname); syncPath(parent); return;
  }
  const temporary = `${pathname}.next.${randomUUID()}`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  try {
    fchmodSync(fd, 0o644); fchownSync(fd, migrationOwner(), rootGroup());
    writeFileSync(fd, runtimeBody(root, selection)); fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, pathname); syncPath(parent);
}

function runtimeProcessExecutable(root, selection) {
  const pathname = join(root, "journal/activation.json");
  if (!existsSync(pathname)) return selection.binary?.path;
  const record = ownedJournalRecord(pathname);
  if (record.kind === "retained-repair") {
    // This slot now belongs to the v2 repair owner, not the v1 runtime-switch
    // owner. Validate its full capsule, held lock and durable transition chain.
    const file = migrationFile(pathname, migrationOwner(), { mode: 0o600, limit: migrationJournalLimit });
    const context = retainedRepairLifecycleContext(root, { journal: file.descriptor });
    if (!isDeepStrictEqual(selection, context.snapshot.runtime))
      reject("selected Gateway runtime differs from retained repair admission");
    // Default Node has no binary descriptor. The admitted live process still
    // pins an exact executable, which both the repair successor and this probe
    // must retain. A v2 journal never borrows v1 runtimeChange as permission.
    return context.snapshot.process.executable;
  }
  const legacy = validJournal(record);
  runtimeJournalCheck(legacy, root);
  return selection.binary?.path ?? (legacy.runtimeChange ? realpathSync(selection.executable) : undefined);
}

function runtimeOperation(action, root, values) {
  const arity = { current: 0, capture: 0, profile: 0, check: 1, process: 3, same: 1, target: 3, probe: 1,
    changing: 0, position: 0, apply: 0, restore: 0, "reload-check": 0 };
  if (!Object.hasOwn(arity, action) || values.length !== arity[action]) reject("invalid Gateway runtime operation arguments");
  if (action === "current") return runtimeCurrent(root);
  if (action === "capture") {
    const selection = runtimeCurrent(root);
    // Explicit switches also bind the default Node binary so a package update
    // cannot disguise an old running executable as the requested no-op or rollback target.
    selection.binary ??= runtimeBinary(selection.executable);
    return selection;
  }
  if (action === "profile") {
    const selection = runtimeCurrent(root, false);
    if (selection.kind !== "node" || realpathSync(selection.executable) !== realpathSync(process.execPath))
      reject("Node profiling requires the Gateway to use the deployment Node executable");
    return "NODE_PROFILE_RUNTIME";
  }
  if (action === "check") return runtimeCheck(root, jsonArgument(values[0]));
  if (action === "process") {
    const selection = runtimeCheck(root, jsonArgument(values[0]));
    const executable = runtimeProcessExecutable(root, selection);
    if (executable && realpathSync(join(values[1], String(integer(values[2], "Gateway PID")), "exe")) !== executable)
      reject("Gateway process is not using the selected executable");
    return "RUNTIME_PROCESS_BOUND";
  }
  if (action === "same") {
    const target = jsonArgument(values[0]), current = runtimeCurrent(root);
    if (!current.binary) current.binary = runtimeBinary(current.executable, undefined, false);
    return current.kind === target.kind && current.binary.path === target.binary.path &&
      isDeepStrictEqual({ ...current.binary, sha256: target.binary.sha256 }, target.binary) ? "SAME" : "DIFFERENT";
  }
  if (action === "target") {
    const [kind, executable, sha256] = values;
    if (!["node", "bun"].includes(kind) || !/^[a-f\d]{64}$/.test(sha256)) reject("runtime target requires node|bun, executable, and SHA-256");
    migrationAncestors(dirname(runtimeDropInPath()), migrationOwner(), process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
    const binary = runtimeBinary(executable, sha256);
    return { kind, executable: binary.path, binary, dropIn: null };
  }
  if (action === "probe") {
    const target = jsonArgument(values[0]), result = jsonArgument("@stdin");
    if (!isDeepStrictEqual(runtimeBinary(target.executable, target.binary.sha256, false), target.binary)) reject("runtime probe executable changed");
    const version = target.kind === "bun" ? result.bun : result.node;
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
    if (!match || !/^3\.\d+\.\d+$/.test(result.sqlite ?? "") ||
        (target.kind === "bun" ? Number(match[1]) < 1 || (Number(match[1]) === 1 &&
          (Number(match[2]) < 4 || (Number(match[2]) === 4 && Number(match[3]) < 3))) :
          result.bun !== undefined || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 15))) reject("Gateway runtime capability probe failed");
    return "RUNTIME_PROBED";
  }
  const pathname = join(root, "journal/activation.json"), record = ownedJournal(pathname);
  const position = runtimeJournalCheck(record, root);
  if (action === "changing") return record.runtimeChange ? "yes" : "no";
  if (action === "reload-check") {
    if (!record.runtimeChange) reject("runtime reload requires its activation journal");
    const loaded = new TextDecoder("utf-8", { fatal: true }).decode(migrationReadBytes(0, 16384)).trim();
    const matches = executable => loaded.startsWith(`{ path=${executable} ; `) &&
      loaded.includes(`argv[]=${executable} ${root}/current/dist/index.js gateway --port ${integer(process.env.OPENCLAW_TEAM_GATEWAY_PORT ?? "18789", "Gateway port")} ;`);
    if (matches(runtimeCurrent(root, false).executable)) return "CACHED";
    if (matches(record.gatewayRuntime.executable) || matches(record.runtimeChange.executable)) return "RELOAD";
    reject("loaded Gateway command matches neither journal runtime; reload refused");
  }
  if (action === "position") return position;
  if (action === "apply" || action === "restore") {
    if (!record.runtimeChange || record.topology !== "system" || record.predecessor.sha !== record.candidate.sha)
      reject("runtime write requires a same-release runtime transaction");
    if (action === "apply" && !["B_PREVIOUS_PUBLISHED", "C_CURRENT_SELECTED"].includes(record.phase))
      reject("runtime publication is outside its selected activation phase");
    const desired = action === "apply" ? "selected" : "original";
    if (position !== desired) {
      const selection = action === "apply" ? record.runtimeChange : record.gatewayRuntime;
      if (selection.binary && !isDeepStrictEqual(runtimeBinary(selection.executable, selection.binary.sha256, false), selection.binary))
        reject("runtime restore or activation executable changed");
      runtimePublish(root, selection, action === "restore" && !selection.dropIn);
    }
    return runtimeCurrent(root);
  }
  reject("unknown Gateway runtime operation");
}

const workerConfigPhases = new Set(["CONFIG_PREPARED", "CONFIG_WRITING", "CONFIG_RESTORING", "CONFIG_RESTORED", "CONFIG_VERIFIED"]);
const workerSetupMarker = "# OPENCLAW_TEAM_ARTIFACT_SETUP_V1";

function validWorkerConfigJournal(record) {
  if (record?.version !== 1 || record.kind !== "worker-bootstrap" || !workerConfigPhases.has(record.phase) ||
      !shaPattern.test(record.predecessor?.sha) || record.candidate?.sha !== record.predecessor.sha ||
      !Number.isSafeInteger(record.process?.pid) || record.process.pid < 1 || !/^[1-9]\d*$/.test(record.process.generation) ||
      typeof record.process.instance !== "string" || !record.process.instance || !Array.isArray(record.protectedPaths) ||
      record.protectedPaths.length !== 2 || !record.request || !record.witness ||
      typeof record.suspension?.id !== "string" || !record.suspension.id || !Number.isSafeInteger(record.suspension.expiresAtMs) ||
      !["ready", "draining"].includes(record.suspension.status) || record.suspension.terminalPolicy !== "preserve")
    reject("worker config journal is malformed or ambiguous");
  if (Object.hasOwn(record, "liveCancellation") && (record.liveCancellation !== true || record.phase !== "CONFIG_RESTORED"))
    reject("worker config live cancellation is outside its restored phase");
  validMigrationDescriptor(record.witness, "path", "worker config original witness");
  return record;
}

function workerConfigPointers(root) {
  return ["current", "previous"].map(name => {
    const pathname = join(root, name), entry = lstatSync(pathname, { throwIfNoEntry: false });
    if (!entry && name === "previous") return null;
    if (!entry?.isSymbolicLink() || dirname(realpathSync(pathname)) !== join(root, "releases"))
      reject("worker config serving pointer is unsafe");
    return { path: pathname, device: entry.dev, inode: entry.ino, target: readlinkSync(pathname) };
  });
}

function workerConfigLoad(root, token) {
  const { owner } = migrationNamespace(root);
  if (!/^config-worker-[a-f\d-]{36}$/.test(token?.stage ?? "") || !/^[a-f\d]{64}$/.test(token?.requestHash ?? ""))
    reject("worker config request binding is invalid");
  const stage = join(root, "staging", token.stage), entry = lstatSync(stage);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== owner || entry.gid !== rootGroup() || (entry.mode & 0o7777) !== 0o700 ||
      entry.dev !== token.device || entry.ino !== token.inode) reject("worker config staging identity changed");
  exactDirectory(join(stage, "private"), owner, "worker config private evidence", { privateOnly: true });
  const requestFile = migrationFile(join(stage, "private/request.json"), owner, { mode: 0o600 });
  if (requestFile.descriptor.sha256 !== token.requestHash) reject("worker config request changed");
  const request = migrationJson(requestFile.bytes);
  if (request.version !== 1 || request.stage !== token.stage) reject("worker config request owner changed");
  const original = migrationFile(join(stage, "private/original-config"), owner, { mode: 0o600 });
  if (!isDeepStrictEqual(original.descriptor, request.backup)) reject("worker config original backup changed");
  const replacement = migrationFile(join(stage, "private/replacement.json"), owner, { mode: 0o600 });
  if (!isDeepStrictEqual(replacement.descriptor, request.replacement)) reject("worker config reviewed replacement changed");
  const script = migrationJson(replacement.bytes);
  if (typeof script !== "string") reject("worker config replacement is not a script string");
  return { owner, stage, request, before: migrationJson(original.bytes), replacement: script };
}

function workerConfigCurrent(context) {
  const expected = context.request.config;
  if (realpathSync(expected.path) !== expected.path) reject("worker config destination is no longer canonical");
  const file = migrationFile(expected.path, expected.uid, { mode: expected.mode, group: expected.gid });
  if (file.descriptor.device !== expected.device) reject("worker config changed filesystem");
  return file;
}

function workerConfigCommon(root, context) {
  if (!isDeepStrictEqual(workerConfigPointers(root), context.request.pointers) ||
      !isDeepStrictEqual(identity(context.request.database.path), context.request.database))
    reject("worker config pointer or database identity changed");
}

function workerConfigExpected(context, restoring = false) {
  const expected = structuredClone(context.before);
  if (!restoring) expected.cloudWorkers.profiles.aws.settings.setup = context.replacement;
  expected.meta = { ...expected.meta, lastTouchedVersion: context.request.versionStamp,
    migrations: { ...expected.meta?.migrations, modelPolicyAllowlist: true } };
  return expected;
}

function workerConfigPrepare(root, values) {
  const [config, database, sha, configHash, oldHash, rawUid, rawGid] = values;
  const { owner } = migrationNamespace(root), runtimeUid = integer(rawUid, "worker config runtime UID"), runtimeGid = integer(rawGid, "worker config runtime GID");
  if (!shaPattern.test(sha) || !/^[a-f\d]{64}$/.test(configHash) || !/^[a-f\d]{64}$/.test(oldHash))
    reject("worker config expected hash is invalid");
  const script = new TextDecoder("utf-8", { fatal: true }).decode(migrationReadBytes(0, 32768));
  if (realpathSync(config) !== config) reject("worker config destination must be canonical");
  const original = migrationFile(config, runtimeUid, { mode: 0o600, group: runtimeGid });
  const before = migrationJson(original.bytes), profile = before.cloudWorkers?.profiles?.aws, setup = profile?.settings?.setup;
  if (original.descriptor.sha256 !== configHash || typeof setup !== "string" || Buffer.byteLength(setup) > 32768 ||
      createHash("sha256").update(setup).digest("hex") !== oldHash) reject("worker config or old setup hash changed");
  if (profile.provider !== "crabbox" || profile.settings.binary !== "/home/openclaw/.openclaw/bin/crabbox-artifact" ||
      setup.split("\n", 1)[0] !== workerSetupMarker || !script.trim() || script.split("\n", 1)[0] === workerSetupMarker ||
      JSON.stringify(before).includes('"$include"')) reject("worker config requires the exact single-file legacy AWS profile");
  if (!before.meta?.migrations?.modelPolicyAllowlist && !before.agents?.defaults?.modelPolicy &&
      Object.keys(before.agents?.defaults?.models ?? {}).length) reject("worker config refuses unrelated legacy model-policy migration");
  const release = realpathSync(join(root, "current"));
  if (release !== join(root, "releases", sha)) reject("worker config serving SHA changed");
  const versionStamp = jsonFile(join(release, "package.json")).version;
  if (typeof versionStamp !== "string" || !versionStamp) reject("worker config source version is missing");
  exactDirectory(join(root, "staging"), owner, "worker config staging parent");
  const stageName = `config-worker-${randomUUID()}`, stage = join(root, "staging", stageName);
  mkdirSync(stage, { mode: 0o700 });
  mkdirSync(join(stage, "private"), { mode: 0o700 });
  migrationWriteExclusive(join(stage, "private/original-config"), original.bytes, 0o600);
  migrationWriteExclusive(join(stage, "private/replacement.json"), Buffer.from(JSON.stringify(script) + "\n"), 0o600);
  const request = { version: 1, stage: stageName, sha, versionStamp,
    config: { ...original.descriptor, uid: runtimeUid, gid: runtimeGid, mode: 0o600 },
    database: identity(database), pointers: workerConfigPointers(root),
    backup: migrationFile(join(stage, "private/original-config"), owner, { mode: 0o600 }).descriptor,
    replacement: migrationFile(join(stage, "private/replacement.json"), owner, { mode: 0o600 }).descriptor };
  if (!isDeepStrictEqual(migrationFile(config, runtimeUid, { mode: 0o600, group: runtimeGid }).descriptor, original.descriptor))
    reject("worker config changed during preparation");
  atomicJson(join(stage, "private/request.json"), request, { noReplace: true });
  syncPath(stage); syncPath(dirname(stage));
  const entry = lstatSync(stage);
  return { stage: stageName, device: entry.dev, inode: entry.ino,
    requestHash: migrationFile(join(stage, "private/request.json"), owner, { mode: 0o600 }).descriptor.sha256 };
}

function workerConfigCommand(action, root, values) {
  const prepared = ["begin", "log-path", "expected-value", "replacement-value", "check-prepared"].includes(action);
  if (values.length !== (action === "prepare" ? 7 : prepared ? 1 : 0)) reject("invalid worker config operation arguments");
  if (action === "prepare") return JSON.stringify(workerConfigPrepare(root, values));
  const { owner, pathname } = migrationNamespace(root);
  if (action === "pending") {
    if (!lstatSync(pathname, { throwIfNoEntry: false })) return "none";
    const record = ownedJournal(pathname);
    return record.kind === "worker-bootstrap" ? record.phase : "none";
  }
  const record = prepared ? null : validWorkerConfigJournal(ownedJournal(pathname));
  const token = prepared ? jsonArgument(values[0]) : record.request;
  const context = workerConfigLoad(root, token);
  workerConfigCommon(root, context);
  if (action === "replacement-value") return JSON.stringify(context.replacement);
  if (action === "log-path") return join(context.stage, "private/native-config");
  if (action === "expected-value") return JSON.stringify(context.before.cloudWorkers.profiles.aws.settings.setup);
  if (action === "check-prepared" || action === "begin") {
    const current = workerConfigCurrent(context);
    if (current.descriptor.sha256 !== context.request.config.sha256 || current.descriptor.inode !== context.request.config.inode)
      reject("worker config changed since operator admission");
    if (action === "check-prepared") return "BOUND";
    if (lstatSync(pathname, { throwIfNoEntry: false })) reject("worker config refuses an existing activation journal");
    const input = migrationJson(migrationReadBytes(0, migrationJsonLimit));
    sessionWitnessTuples(input.witness);
    const witnessPath = join(context.stage, "private/witness.json");
    migrationWriteExclusive(witnessPath, Buffer.from(JSON.stringify(input.witness) + "\n"), 0o600);
    const next = validWorkerConfigJournal({ version: 1, kind: "worker-bootstrap", phase: "CONFIG_PREPARED",
      predecessor: { sha: context.request.sha }, candidate: { sha: context.request.sha },
      process: input.process, suspension: input.suspension, request: token,
      protectedPaths: [identity(context.request.config.path), context.request.database],
      witness: migrationFile(witnessPath, owner, { mode: 0o600 }).descriptor,
      gatewayRuntime: runtimeCurrent(root) });
    atomicJson(pathname, next, { noReplace: true });
    return "PREPARED";
  }
  if (record.witness.path !== join(context.stage, "private/witness.json")) reject("worker config witness escaped its owned evidence directory");
  const witness = migrationFile(record.witness.path, owner, { mode: 0o600 });
  if (!isDeepStrictEqual(witness.descriptor, record.witness)) reject("worker config original session witness changed");
  sessionWitnessTuples(migrationJson(witness.bytes));
  if (action === "witness") return witness.bytes.toString("utf8");
  const current = workerConfigCurrent(context);
  const original = current.descriptor.sha256 === context.request.config.sha256;
  const intended = isDeepStrictEqual(migrationJson(current.bytes), workerConfigExpected(context));
  const restored = isDeepStrictEqual(migrationJson(current.bytes), workerConfigExpected(context, true));
  const save = next => { atomicJson(pathname, validWorkerConfigJournal(next)); return next.phase; };
  if (action === "check") {
    if (["CONFIG_VERIFIED", "CONFIG_RESTORED"].includes(record.phase)) {
      if (!isDeepStrictEqual(current.descriptor, record.currentConfig)) reject("accepted worker config identity or bytes changed");
    } else if (record.phase === "CONFIG_PREPARED") {
      if (!original || current.descriptor.inode !== context.request.config.inode) reject("worker config changed before stop");
    } else if (!original && !intended && !(record.phase === "CONFIG_RESTORING" && restored))
      reject("worker config has unknown drift; original backup will not overwrite it");
    return "BOUND";
  }
  if (action === "live-cancellation") return record.liveCancellation === true ? "yes" : "no";
  if (action === "cancel") {
    if (!(record.phase === "CONFIG_PREPARED" || (record.phase === "CONFIG_RESTORED" && record.liveCancellation === true)) ||
        !original || current.descriptor.inode !== context.request.config.inode)
      reject("worker config cancellation requires the untouched original config");
    return save({ ...record, phase: "CONFIG_RESTORED", currentConfig: current.descriptor, liveCancellation: true });
  }
  if (action === "cancellation-result") {
    if (record.phase !== "CONFIG_RESTORED" || record.liveCancellation !== true || !original ||
        current.descriptor.inode !== context.request.config.inode || !isDeepStrictEqual(current.descriptor, record.currentConfig))
      reject("worker config cancellation result lost its original config binding");
    const response = migrationJson(migrationReadBytes(0, 4096));
    suspensionObject(response, ["ok", "status", "resumed"], "worker cancellation resume result");
    if (response.ok !== true || response.status !== "running" || typeof response.resumed !== "boolean")
      reject("worker config cancellation did not observe a running unsuspended Gateway");
    return response.resumed ? "RESUMED" : "ALREADY_RUNNING";
  }
  if (action === "revoke") {
    if (record.phase !== "CONFIG_PREPARED" || !original || current.descriptor.inode !== context.request.config.inode)
      reject("worker config start fence requires the original prepared config");
    const permit = migrationPermit(root);
    if (permit) { unlinkSync(permit.path); syncPath(dirname(permit.path)); }
    return "FENCED";
  }
  if (action === "writing") {
    if (record.phase !== "CONFIG_PREPARED" || !original || current.descriptor.inode !== context.request.config.inode || migrationPermit(root))
      reject("worker config write requires its original config and absent start permit");
    return save({ ...record, phase: "CONFIG_WRITING" });
  }
  if (action === "accept") {
    if (record.phase !== "CONFIG_WRITING" || !intended || current.descriptor.inode === context.request.config.inode || migrationPermit(root))
      reject("worker config native result includes unexpected changes or lacks its start fence");
    return save({ ...record, phase: "CONFIG_VERIFIED", currentConfig: current.descriptor,
      protectedPaths: [identity(context.request.config.path), context.request.database] });
  }
  if (action === "restore") {
    if (!["CONFIG_PREPARED", "CONFIG_WRITING", "CONFIG_RESTORING"].includes(record.phase) || migrationPermit(root))
      reject("worker config restore is allowed only before acceptance under its start fence");
    if (original || (record.phase === "CONFIG_RESTORING" && restored)) {
      return save({ ...record, phase: "CONFIG_RESTORED", currentConfig: current.descriptor,
        protectedPaths: [identity(context.request.config.path), context.request.database] });
    }
    if (!intended) reject("worker config has unknown drift; backup will not overwrite it");
    // The owner must invoke the public conditional writer; root never renames config over another writer.
    return save({ ...record, phase: "CONFIG_RESTORING" });
  }
  if (action === "permit" || action === "finish") {
    if (!["CONFIG_VERIFIED", "CONFIG_RESTORED"].includes(record.phase) || !isDeepStrictEqual(current.descriptor, record.currentConfig))
      reject("worker config acceptance is not bound to the verified file");
    if (action === "permit") { migrationPublishPermit(root); return "PERMITTED"; }
    if (!migrationPermit(root)) reject("worker config cannot finish with its start fence retained");
    unlinkSync(pathname); syncPath(dirname(pathname));
    return record.phase === "CONFIG_VERIFIED" ? "APPLIED" : "RESTORED";
  }
  reject("unknown worker config owner operation");
}

const hostHandoffPhases = new Set(["SOURCE_PREPARED", "SOURCE_STOPPED", "SOURCE_EXPORTED", "TARGET_IMPORTED", "TARGET_DOCTOR_VERIFIED", "TARGET_READY", "TARGET_VERIFYING"]);
const hostHandoffScheduleNames = ["openclaw-hourly-health-check.timer", "openclaw-disk-maintenance.timer"];
function hostMachineId() {
  const value = readFileSync(join(process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/", "etc/machine-id"), "utf8").trim();
  if (!/^[a-f\d]{32}$/.test(value)) reject("host machine identity is unavailable");
  return value;
}
function validHostHandoff(record) {
  if (record?.version !== 1 || record.kind !== "host-handoff" || !hostHandoffPhases.has(record.phase) ||
      !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(record.id) || record.stage !== `${record.phase.startsWith("SOURCE_") ? "handoff" : "handoff-target"}-${record.id}` ||
      !/^[a-f\d]{32}$/.test(record.machineId) || !/^[a-f\d]{32}$/.test(record.peerMachineId) || record.machineId === record.peerMachineId ||
      !shaPattern.test(record.targetSha) || !shaPattern.test(record.predecessor?.sha) || !shaPattern.test(record.candidate?.sha) ||
      typeof record.configPath !== "string" || typeof record.databasePath !== "string")
    reject("host handoff journal is malformed");
  if (record.phase.startsWith("SOURCE_") && (!Number.isSafeInteger(record.process?.pid) || record.process.pid < 1 ||
      !/^[1-9]\d*$/.test(record.process.generation) || typeof record.process.instance !== "string" || !record.process.instance ||
      typeof record.suspension?.id !== "string" || !Number.isSafeInteger(record.suspension.expiresAtMs) ||
      !["ready", "draining"].includes(record.suspension.status) || record.suspension.terminalPolicy !== "preserve"))
    reject("host handoff source process or suspension binding is invalid");
  if (!record.schedules || Object.keys(record.schedules).length !== 2 ||
      hostHandoffScheduleNames.some(name => {
        const value = record.schedules[name];
        return !value || !["enabled", "disabled"].includes(value.UnitFileState) || !["active", "inactive"].includes(value.ActiveState) ||
          ["SubState", "LastTriggerUSec", "NextElapseUSecRealtime"].some(field => typeof value[field] !== "string");
      })) reject("handoff lacks its original source maintenance timer states");
  return record;
}
function hostHandoffArtifacts(root, record) {
  const owner = migrationOwner(), stage = join(root, "journal", record.stage);
  exactDirectory(stage, owner, "handoff stage", { privateOnly: true });
  if (record.configBackup) {
    const actual = migrationFile(record.configBackup.path, owner, { mode: 0o600 });
    if (!isDeepStrictEqual(actual.descriptor, record.configBackup)) reject("handoff original config backup changed");
  }
  if (record.witness) {
    const actual = migrationFile(record.witness.path, owner, { mode: 0o600 });
    if (!isDeepStrictEqual(actual.descriptor, record.witness)) reject("handoff session witness changed");
    sessionWitnessTuples(migrationJson(actual.bytes));
  }
  if (record.sourceManifest && !isDeepStrictEqual(migrationHashFile(record.sourceManifest.path), record.sourceManifest))
    reject("original source handoff manifest changed after import");
  if (record.importedWitness && !isDeepStrictEqual(migrationFile(record.importedWitness.path, owner, { mode: 0o600 }).descriptor, record.importedWitness))
    reject("original target import witness changed");
  return stage;
}
function hostHandoffLoad(root) {
  const { owner, pathname } = migrationNamespace(root);
  const file = migrationFile(pathname, owner, { mode: 0o600, limit: migrationJournalLimit });
  const record = validHostHandoff(migrationJson(file.bytes));
  if (record.machineId !== hostMachineId()) reject("handoff journal belongs to another host");
  hostHandoffArtifacts(root, record);
  return { record, descriptor: file.descriptor };
}
function hostHandoffSave(root, observed, record) {
  const current = hostHandoffLoad(root);
  if (!isDeepStrictEqual(current, observed)) reject("handoff journal changed during owner operation");
  validHostHandoff(record);
  atomicJson(join(root, "journal/activation.json"), record);
  return record;
}
function hostHandoffCompletion(bytes, record) {
  const { completedAt, ...original } = migrationJson(bytes);
  if (!Number.isSafeInteger(completedAt) || !isDeepStrictEqual(original, record)) reject("handoff completion receipt changed");
}
function hostHandoffSourceInputs(root, record) {
  if (!record.phase.startsWith("SOURCE_") || record.machineId !== hostMachineId() ||
      realpathSync(join(root, "current")) !== join(root, "releases", record.predecessor.sha) ||
      !isDeepStrictEqual(workerConfigPointers(root), record.pointers) ||
      !isDeepStrictEqual(migrationHashFile(record.configPath), record.config) ||
      !isDeepStrictEqual(policy(record.configPath), record.policy)) reject("source handoff inputs or pointers changed");
  const info = validateRelease(join(root, "releases", record.predecessor.sha), record.predecessor.sha, migrationOwner(), true);
  if (!isDeepStrictEqual(info, record.predecessor)) reject("source handoff release changed");
}
function hostHandoffSourceStopped(root, expected, allowPrepared = false, gatewayOnly = false) {
  const { record } = hostHandoffLoad(root);
  if (!isDeepStrictEqual(record, expected) || !["SOURCE_STOPPED", "SOURCE_EXPORTED", ...(allowPrepared ? ["SOURCE_PREPARED"] : [])].includes(record.phase) || migrationPermit(root))
    reject("source handoff requires its stopped journal and absent native start permit");
  hostHandoffSourceInputs(root, record);
  const procRoot = process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc";
  const processDirectory = join(procRoot, String(record.process.pid));
  try {
    const stat = readFileSync(join(processDirectory, "stat"), "utf8"), boundary = stat.lastIndexOf(") ");
    const generation = stat.slice(boundary + 2).trim().split(/\s+/)[19];
    if (boundary < 0 || !/^[1-9]\d*$/.test(generation)) reject("source Gateway process generation is unavailable");
    if (generation === record.process.generation) reject("source Gateway process still exists");
  } catch (error) { if (error.code !== "ENOENT" || existsSync(processDirectory)) throw error; }
  if (gatewayOnly) return;
  const release = join(root, "releases", record.predecessor.sha), schemas = record.predecessor.schemaVersions;
  const inventory = migrationInventory(record.configPath, record.databasePath, release, { from: schemas, to: schemas });
  assertDatabaseWritersStopped(new Set([record.configPath, ...inventory.stores.flatMap(store =>
    [store.path, store.path + "-wal", store.path + "-shm", store.path + "-journal"])]), procRoot);
  migrationVerifyWitness(inventory, release, migrationJson(migrationFile(record.witness.path, migrationOwner(), { mode: 0o600 }).bytes));
  return inventory;
}

function hostHandoffTargetInventory(root, record, release = record.candidate) {
  if (!record.phase.startsWith("TARGET_") || record.machineId !== hostMachineId()) reject("not this host's target handoff");
  const directory = join(root, "releases", release.sha), schemas = release.schemaVersions;
  if (!isDeepStrictEqual(validateRelease(directory, release.sha, migrationOwner(), true), release)) reject("target handoff release changed");
  const inventory = migrationInventory(record.configPath, record.databasePath, directory, { from: schemas, to: schemas });
  assertDatabaseWritersStopped(new Set([record.configPath, ...inventory.stores.flatMap(store =>
    [store.path, store.path + "-wal", store.path + "-shm", store.path + "-journal"])]), process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc");
  return inventory;
}
function hostHandoffTargetSelection(root, record, allowPrefix) {
  if (!record.phase.startsWith("TARGET_") || migrationPermit(root))
    reject("target release selection requires its imported journal and absent start permit");
  for (const release of [record.predecessor, record.candidate]) {
    if (!isDeepStrictEqual(validateRelease(join(root, "releases", release.sha), release.sha, migrationOwner(), true), release))
      reject("target selection sealed release identity changed");
  }
  const current = Boolean(lstatSync(join(root, "current"), { throwIfNoEntry: false }));
  const previous = Boolean(lstatSync(join(root, "previous"), { throwIfNoEntry: false }));
  if ((current && !previous) || ((!current || !previous) && (!allowPrefix || record.phase !== "TARGET_IMPORTED")))
    reject("target release selection is not a valid imported publication prefix");
  migrationPointers(root, migrationOwner(), {
    current: current ? record.candidate.sha : null,
    previous: previous ? record.predecessor.sha : null,
  });
  if (!current || !previous) {
    const schemas = record.predecessor.schemaVersions, profile = { from: schemas, to: schemas };
    const inventory = hostHandoffTargetInventory(root, record, record.predecessor);
    migrationSameInventory(record.inventory, inventory, profile);
    migrationVerifyWitness(inventory, join(root, "releases", record.predecessor.sha),
      migrationJson(migrationFile(record.witness.path, migrationOwner(), { mode: 0o600 }).bytes));
  }
}
function hostHandoffExpectedConfig(root, record, expectedHash) {
  const actual = migrationHashFile(record.configPath);
  if (!/^[a-f\d]{64}$/.test(expectedHash) || actual.sha256 !== expectedHash) reject("target config differs from its approved native result");
  const source = migrationJson(migrationFile(record.configBackup.path, migrationOwner(), { mode: 0o600 }).bytes);
  const { handoff } = operatorProfile();
  if (!handoff || [handoff.provider, handoff.sourceBaseUrl, handoff.targetBaseUrl].some(value =>
    typeof value !== "string" || !value.trim() || value.trim() !== value))
    reject("operator profile handoff is malformed");
  if (typeof source.worktreeRoot !== "string" || source.models?.providers?.[handoff.provider]?.baseUrl !== handoff.sourceBaseUrl)
    reject("source config does not match the approved host handoff changes");
  const expected = structuredClone(source); delete expected.worktreeRoot;
  expected.models.providers[handoff.provider].baseUrl = handoff.targetBaseUrl;
  const normalize = config => {
    if (config.meta) {
      delete config.meta.lastTouchedVersion; delete config.meta.lastTouchedAt;
      if (Object.keys(config.meta).length === 0) delete config.meta;
    }
    return config;
  };
  if (!isDeepStrictEqual(normalize(expected), normalize(jsonFile(record.configPath))))
    reject("target config has changes beyond native metadata, worktreeRoot removal, and the approved provider endpoint");
  if (!isDeepStrictEqual(policy(record.configPath), record.policy)) reject("Team policy changed during handoff");
  databaseRead(record.databasePath, db => {
    const rows = db.prepare("SELECT status,report_json FROM migration_runs WHERE id LIKE 'worktree-root-relocation:%'").all();
    if (!rows.length || rows.some(row => row.status !== "completed")) reject("native worktree relocation has an unfinished startup fence");
    if (!rows.some(row => {
      const report = JSON.parse(row.report_json);
      return report.kind === "worktree-root-relocation" && report.fromRoot === source.worktreeRoot &&
        report.toRoot === join(dirname(record.configPath), "worktrees");
    })) reject("target has no completed native worktree relocation for the original root");
  });
  return actual;
}
async function hostHandoffCommand(action, root, args) {
  const { owner, pathname, directory } = migrationNamespace(root);
  if (action === "status") {
    if (!lstatSync(pathname, { throwIfNoEntry: false })) return "none";
    const record = ownedJournal(pathname);
    return record.kind === "host-handoff" ? hostHandoffLoad(root).record.phase : "other";
  }
  if (action === "source-begin") {
    if (args.length !== 5 || lstatSync(pathname, { throwIfNoEntry: false })) reject("source handoff begin requires no prior journal");
    const [peerMachineId, targetSha, configPath, databasePath, raw] = args, input = jsonArgument(raw);
    if (!/^[a-f\d]{32}$/.test(peerMachineId) || peerMachineId === hostMachineId() || !shaPattern.test(targetSha)) reject("handoff target identity is invalid");
    const release = realpathSync(join(root, "current")), info = validateRelease(release, basename(release), owner, true);
    if (!isDeepStrictEqual(info, input.source)) reject("handoff source release differs from admission");
    if (!migrationPermit(root)) reject("source handoff requires the original native start permit");
    const gatewayRuntime = runtimeCurrent(root);
    const schemas = info.schemaVersions, inventory = migrationInventory(configPath, databasePath, release, { from: schemas, to: schemas });
    const id = randomUUID(), stage = `handoff-${id}`, stagePath = join(directory, stage);
    mkdirSync(stagePath, { mode: 0o700 }); syncPath(directory);
    const configBackup = join(stagePath, "original-config.json"), witness = join(stagePath, "original-witness.json");
    migrationWriteExclusive(configBackup, readFileSync(configPath), 0o600);
    atomicJson(witness, migrationCaptureWitness(inventory, release), { noReplace: true });
    const record = validHostHandoff({ version: 1, kind: "host-handoff", phase: "SOURCE_PREPARED", id, stage,
      machineId: hostMachineId(), peerMachineId, targetSha, predecessor: info, candidate: info, gatewayRuntime,
      configPath, databasePath, config: migrationHashFile(configPath), policy: policy(configPath), pointers: workerConfigPointers(root),
      process: input.process, suspension: input.suspension, configBackup: migrationFile(configBackup, owner, { mode: 0o600 }).descriptor,
      schedules: input.schedules,
      witness: migrationFile(witness, owner, { mode: 0o600 }).descriptor });
    if (record.config.sha256 !== record.configBackup.sha256) reject("source config changed during handoff admission");
    atomicJson(pathname, record, { noReplace: true });
    return record.id;
  }
  if (action === "target-import") {
    if (args.length !== 2 || migrationPermit(root)) reject("target import requires an absent start permit");
    if (lstatSync(pathname, { throwIfNoEntry: false })) {
      const existing = hostHandoffLoad(root).record;
      if (!existing.phase.startsWith("TARGET_") || existing.sourceManifest.path !== args[0] || existing.sourceManifest.sha256 !== args[1])
        reject("another handoff already owns the target");
      return existing.id;
    }
    for (const name of ["current", "previous"]) if (lstatSync(join(root, name), { throwIfNoEntry: false }))
      reject("target import requires an unselected serving namespace");
    const [manifestPath, manifestHash] = args, input = migrationFile(manifestPath, owner, { mode: 0o600 });
    if (!/^[a-f\d]{64}$/.test(manifestHash) || input.descriptor.sha256 !== manifestHash) reject("source export digest changed");
    const manifest = migrationJson(input.bytes), handoff = manifest.handoff;
    if (manifest.kind !== "team-state-handoff" || manifest.consistency !== "quiesced-source" ||
        handoff?.targetMachineId !== hostMachineId() || handoff.sourceMachineId === hostMachineId())
      reject("source export does not authorize this target host");
    const sourcePath = join(root, "releases", manifest.release.sha), candidatePath = join(root, "releases", handoff.targetSha);
    const source = validateRelease(sourcePath, manifest.release.sha, owner, true), candidate = validateRelease(candidatePath, handoff.targetSha, owner, true);
    const gatewayRuntime = runtimeCurrent(root);
    const id = randomUUID();
    const record = validHostHandoff({ version: 1, kind: "host-handoff", phase: "TARGET_IMPORTED", id, sourceHandoffId: handoff.id,
      stage: `handoff-target-${id}`, machineId: hostMachineId(), peerMachineId: handoff.sourceMachineId,
      targetSha: handoff.targetSha, predecessor: source, candidate, gatewayRuntime, schedules: handoff.schedules, configPath: manifest.inventory.config.path,
      databasePath: join(manifest.inventory.stateRoot, "state/openclaw.sqlite"), sourceManifest: migrationHashFile(manifestPath) });
    const inventory = hostHandoffTargetInventory(root, record, source);
    verifyHandoffSnapshot(manifestPath, sourcePath, candidatePath, manifestHash, true);
    const stage = join(directory, record.stage); mkdirSync(stage, { mode: 0o700 }); syncPath(directory);
    const configBackup = join(stage, "original-config.json"), witness = join(stage, "imported-witness.json");
    migrationWriteExclusive(configBackup, readFileSync(record.configPath), 0o600);
    atomicJson(witness, migrationCaptureWitness(inventory, sourcePath), { noReplace: true });
    Object.assign(record, { inventory, policy: policy(record.configPath),
      configBackup: migrationFile(configBackup, owner, { mode: 0o600 }).descriptor,
      witness: migrationFile(witness, owner, { mode: 0o600 }).descriptor });
    atomicJson(pathname, record, { noReplace: true }); return record.id;
  }
  const observed = hostHandoffLoad(root), record = observed.record;
  if (action === "target-selection") {
    if (args.length !== 1 || !["prefix", "complete"].includes(args[0])) reject("invalid target selection proof");
    hostHandoffTargetSelection(root, record, args[0] === "prefix");
    return "TARGET_SELECTION_VERIFIED";
  }
  if (action === "source-check") {
    const [sha, pid, generation, peer, target] = args;
    if (args.length !== 5 || record.predecessor.sha !== sha || record.process.pid !== Number(pid) ||
        record.process.generation !== generation || record.peerMachineId !== peer || record.targetSha !== target)
      reject("source handoff retry differs from its original admission");
    hostHandoffSourceInputs(root, record); return record.phase;
  }
  if (action === "source-revoke") {
    if (record.phase !== "SOURCE_PREPARED") reject("source permit revocation has no prepared handoff");
    hostHandoffSourceInputs(root, record);
    const permit = migrationPermit(root);
    if (permit) { unlinkSync(permit.path); syncPath(dirname(permit.path)); }
    return "FENCED";
  }
  if (action === "source-suspension") {
    const admission = jsonArgument(args[0]);
    if (record.phase !== "SOURCE_PREPARED" || !isDeepStrictEqual(admission.process, record.process))
      reject("source handoff suspension belongs to another process");
    const updated = validHostHandoff({ ...record, suspension: admission.suspension });
    hostHandoffSourceInputs(root, record); hostHandoffSave(root, observed, updated); return "ADMITTED";
  }
  if (action === "source-stopped") {
    if (!["SOURCE_PREPARED", "SOURCE_STOPPED"].includes(record.phase) || migrationPermit(root)) reject("source stop requires a fenced handoff");
    const stopped = { ...record, phase: "SOURCE_STOPPED" };
    hostHandoffSourceStopped(root, record, true, true);
    if (record.phase !== stopped.phase) hostHandoffSave(root, observed, stopped);
    return stopped.phase;
  }
  if (action === "source-export") {
    hostHandoffSourceStopped(root, record);
    if (record.phase === "SOURCE_EXPORTED") {
      const actual = migrationHashFile(record.export.manifest);
      if (actual.sha256 !== record.export.manifestSha256) reject("original handoff export changed");
      return record.export;
    }
    const exported = await snapshotForHandoff(root, join(root, "releases", record.predecessor.sha), record.configPath, record.databasePath, record);
    hostHandoffSourceStopped(root, record);
    hostHandoffSave(root, observed, { ...record, phase: "SOURCE_EXPORTED", export: exported });
    return exported;
  }
  if (action === "target-doctor") {
    if (!["TARGET_IMPORTED", "TARGET_DOCTOR_VERIFIED"].includes(record.phase) || migrationPermit(root))
      reject("target Doctor acceptance requires its imported state and absent permit");
    hostHandoffTargetSelection(root, record, false);
    if (record.phase === "TARGET_DOCTOR_VERIFIED") return record.phase;
    const sourcePath = join(root, "releases", record.predecessor.sha), candidatePath = join(root, "releases", record.candidate.sha);
    const inventory = hostHandoffTargetInventory(root, record);
    const profile = { from: record.predecessor.schemaVersions, to: record.candidate.schemaVersions };
    const current = { ...inventory, ...migrationProfileBinding(profile) };
    migrationSameInventory({ ...record.inventory, ...migrationProfileBinding(profile) }, current, profile, true);
    verifyHandoffSnapshot(record.sourceManifest.path, sourcePath, candidatePath, record.sourceManifest.sha256);
    const witness = join(hostHandoffArtifacts(root, record), `post-doctor-witness-${randomUUID()}.json`);
    atomicJson(witness, migrationCaptureWitness(inventory, candidatePath), { noReplace: true });
    hostHandoffSave(root, observed, { ...record, phase: "TARGET_DOCTOR_VERIFIED", inventory,
      importedWitness: record.witness, witness: migrationFile(witness, owner, { mode: 0o600 }).descriptor });
    return "TARGET_DOCTOR_VERIFIED";
  }
  if (action === "target-ready") {
    if (!["TARGET_DOCTOR_VERIFIED", "TARGET_READY"].includes(record.phase) || migrationPermit(root))
      reject("target activation requires verified Doctor and an absent start permit");
    const config = hostHandoffExpectedConfig(root, record, args[0]), inventory = hostHandoffTargetInventory(root, record);
    const schemas = record.candidate.schemaVersions, profile = { from: schemas, to: schemas };
    migrationSameInventory({ ...record.inventory, config }, inventory, profile, true);
    migrationVerifyWitness(inventory, join(root, "releases", record.candidate.sha), migrationJson(migrationFile(record.witness.path, owner, { mode: 0o600 }).bytes));
    if (record.phase === "TARGET_DOCTOR_VERIFIED") hostHandoffSave(root, observed, { ...record, phase: "TARGET_READY", acceptedConfig: config });
    else if (!isDeepStrictEqual(record.acceptedConfig, config)) reject("accepted target config changed");
    return "TARGET_READY";
  }
  if (action === "target-permit") {
    if (!["TARGET_READY", "TARGET_VERIFYING"].includes(record.phase) ||
        !isDeepStrictEqual(migrationHashFile(record.configPath), record.acceptedConfig) ||
        realpathSync(join(root, "current")) !== join(root, "releases", record.targetSha) ||
        realpathSync(join(root, "previous")) !== join(root, "releases", record.predecessor.sha))
      reject("target start permit requires exact verified config and selected releases");
    if (!migrationPermit(root)) {
      const inventory = hostHandoffTargetInventory(root, record), schemas = record.candidate.schemaVersions;
      migrationSameInventory({ ...record.inventory, config: record.acceptedConfig }, inventory, { from: schemas, to: schemas }, true);
      migrationVerifyWitness(inventory, join(root, "releases", record.candidate.sha), migrationJson(migrationFile(record.witness.path, owner, { mode: 0o600 }).bytes));
    }
    if (record.phase === "TARGET_READY") hostHandoffSave(root, observed, { ...record, phase: "TARGET_VERIFYING" });
    migrationPublishPermit(root); return "PERMITTED";
  }
  if (action === "target-witness") {
    if (!record.phase.startsWith("TARGET_")) reject("not a target handoff");
    return JSON.stringify(migrationJson(migrationFile(record.witness.path, owner, { mode: 0o600 }).bytes));
  }
  if (action === "target-finish") {
    if (record.phase !== "TARGET_VERIFYING" || !migrationPermit(root) ||
        !isDeepStrictEqual(migrationHashFile(record.configPath), record.acceptedConfig) ||
        realpathSync(join(root, "current")) !== join(root, "releases", record.targetSha))
      reject("target handoff has not reached verified activation");
    const retained = join(hostHandoffArtifacts(root, record), "completed.json");
    if (!lstatSync(retained, { throwIfNoEntry: false })) atomicJson(retained, { ...record, completedAt: Date.now() }, { noReplace: true });
    else hostHandoffCompletion(migrationFile(retained, owner, { mode: 0o600 }).bytes, record);
    if (!isDeepStrictEqual(hostHandoffLoad(root), observed)) reject("target handoff changed before retirement");
    unlinkSync(pathname); syncPath(directory); return "TARGET_ACTIVE";
  }
  reject("unknown host handoff owner operation");
}

function validJournal(record) {
  if (record?.kind === "host-handoff") return validHostHandoff(record);
  if (record?.kind === "worker-bootstrap" || String(record?.phase).startsWith("CONFIG_")) return validWorkerConfigJournal(record);
  if (record?.agentMigration || record?.configMigration || record?.offlineDoctor)
    reject("legacy migration journal requires its retained controller recovery closure");
  const phases = new Set([
    "A_PREPARED",
    "B_PREVIOUS_PUBLISHED",
    "C_CURRENT_SELECTED",
    "MIGRATION_SWITCHING",
    "D_VERIFYING",
    "ROLLBACK_FAILED",
  ]);
  if (
    record?.version !== 1 ||
    !phases.has(record.phase) ||
    !["system", "migration-user"].includes(record.topology) ||
    !shaPattern.test(record.predecessor?.sha) ||
    !shaPattern.test(record.candidate?.sha) ||
    !Number.isSafeInteger(record.process?.pid) ||
    record.process.pid < 1 ||
    typeof record.process.generation !== "string" ||
    !record.process.generation ||
    typeof record.process.instance !== "string" ||
    !record.process.instance ||
    typeof record.pointerTopology?.current?.present !== "boolean" ||
    typeof record.pointerTopology?.previous?.present !== "boolean" ||
    !["enabled", "disabled"].includes(record.services?.system?.unitFileState) ||
    !["enabled", "disabled"].includes(record.services?.user?.unitFileState) ||
    !["active", "inactive"].includes(record.services?.system?.activeState) ||
    !["active", "inactive"].includes(record.services?.user?.activeState) ||
    (typeof record.suspension?.id !== "string" ||
        !record.suspension.id ||
        !Number.isSafeInteger(record.suspension.expiresAtMs) ||
        record.suspension.terminalPolicy !== "preserve" ||
        // Existing durable journals predate the recorded runtime phase.
        (record.suspension.status !== undefined &&
          !["ready", "draining"].includes(record.suspension.status))) ||
    !Array.isArray(record.protectedPaths) ||
    record.protectedPaths.length !== 2
  ) {
    reject("activation journal is malformed or ambiguous");
  }
  if (
    record.services.system.activeState === "active" &&
    record.services.user.activeState === "active"
  ) {
    reject("activation journal records simultaneous Gateway owners");
  }
  if (record.phase === "MIGRATION_SWITCHING" && record.topology !== "migration-user") {
    reject("migration switching journal has an unexpected predecessor topology");
  }
  for (const entry of record.protectedPaths) {
    if (
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.device) ||
      !Number.isSafeInteger(entry.inode) ||
      entry.inode < 1
    ) {
      reject("activation journal protected-path evidence is malformed");
    }
  }
  for (const pointer of [record.pointerTopology.current, record.pointerTopology.previous]) {
    if (pointer.present && !shaPattern.test(pointer.sha))
      reject("activation journal pointer identity is invalid");
    if (!pointer.present && pointer.sha !== null)
      reject("absent journal pointer unexpectedly has a target");
  }
  if (record.nativeUpdate) {
    suspensionObject(record.nativeUpdate, ["backupRoot"], "native update");
    if (record.topology !== "system" || !isAbsolute(record.nativeUpdate.backupRoot) ||
        resolve(record.nativeUpdate.backupRoot) !== record.nativeUpdate.backupRoot ||
        basename(record.nativeUpdate.backupRoot) !== "native" ||
        !basename(dirname(record.nativeUpdate.backupRoot)).startsWith(`update-${record.candidate.sha}-`) ||
        !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
          basename(dirname(record.nativeUpdate.backupRoot)).slice(`update-${record.candidate.sha}-`.length)) ||
        basename(dirname(dirname(record.nativeUpdate.backupRoot))) !== ".openclaw-update")
      reject("native update backup location is invalid");
  }
  if (Object.hasOwn(record, "originalWitness")) {
    validMigrationDescriptor(record.originalWitness, "name", "original session witness");
    if (record.topology !== "system" ||
        !record.originalWitness.name.startsWith("original-") ||
        !migrationArtifactNamePattern.test(record.originalWitness.name))
      reject("original session witness is not an ordinary system activation artifact");
  }
  if (record.gatewayRuntime) {
    if (record.topology !== "system" || !["node", "bun"].includes(record.gatewayRuntime.kind)) reject("journal runtime scope is invalid");
    runtimeLiteral(record.gatewayRuntime.executable);
  }
  if (record.runtimeChange) {
    if (!record.gatewayRuntime || record.predecessor.sha !== record.candidate.sha ||
        !["node", "bun"].includes(record.runtimeChange.kind) || !/^[a-f\d]{64}$/.test(record.runtimeChange.binary?.sha256))
      reject("runtime change is not a pinned same-release activation");
    runtimeLiteral(record.runtimeChange.executable);
  }
  return record;
}

const migrationArtifactNamePattern = /^[a-z]+-[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.json$/;
const migrationJsonLimit = 64 * 1024 * 1024;
const migrationJournalLimit = 1024 * 1024;
// Only canonical retained evidence carries large witnesses. Control journals,
// lifecycle receipts and adoption artifacts retain the ordinary 1 MiB bound.
const retainedSnapshotLimit = migrationJsonLimit + migrationJournalLimit;
function retainedArtifactLimit(pathname) {
  const name = basename(pathname);
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  if (new RegExp("^original-" + uuid + "\\.json$").test(name) ||
      new RegExp("^repair-" + uuid + "\\.(build-witness|current-witness|transaction-floor|stopped-floor)\\.json$").test(name))
    return migrationJsonLimit;
  if (new RegExp("^repair-" + uuid + "\\.(build-intent|intent|prepared)\\.json$").test(name))
    return retainedSnapshotLimit;
  return migrationJournalLimit;
}
function retainedSnapshotBudget(snapshot) {
  const { currentWitness, ...metadata } = snapshot;
  if (Buffer.byteLength(JSON.stringify(currentWitness) + "\n") > migrationJsonLimit)
    reject("retained transcript witness exceeds its bounded evidence budget");
  if (Buffer.byteLength(JSON.stringify(metadata) + "\n") > migrationJournalLimit / 2)
    reject("retained preparation metadata exceeds its bounded capsule budget");
}
function retainedPreparationArgument(value) {
  if (value === "@stdin") return migrationJson(migrationReadBytes(0, retainedSnapshotLimit));
  if (typeof value !== "string" || Buffer.byteLength(value) > retainedSnapshotLimit)
    reject("retained preparation input exceeds its bounded evidence budget");
  return JSON.parse(value);
}
const migrationGuardName = "zz-openclaw-agent-schema-migration.conf";
const migrationPermitName = "gateway-start-permit";
const migrationPermitBody = Buffer.from('{"version":1,"purpose":"gateway-start-permit"}\n');
function migrationGuardBody(root) {
  if (/[\r\n%]/.test(root)) reject("migration root is not a literal systemd path");
  return `[Unit]\nConditionPathExists=${join(root, "journal", migrationPermitName)}\n`;
}

function migrationKind(before, after) {
  for (const info of [before, after]) {
    if (!shaPattern.test(info?.sha)) reject("migration release SHA is not exact");
    for (const field of ["state", "agent"])
      if (!Number.isSafeInteger(info?.schemaVersions?.[field]) || info.schemaVersions[field] < 0)
        reject("migration release schema declaration is invalid");
  }
  return isDeepStrictEqual(before.schemaVersions, after.schemaVersions) ? "none" : "native-update";
}

function migrationProfileBinding(profile) {
  return { schemaProfile: { from: profile.from, to: profile.to } };
}

function migrationCheckProfileBinding(value, profile) {
  if (!isDeepStrictEqual(value.schemaProfile, migrationProfileBinding(profile).schemaProfile))
    reject("migration evidence lost its exact shared and agent schema profile");
}

function validMigrationDescriptor(value, key, label) {
  suspensionObject(value, [key, "device", "inode", "sha256"], label);
  if (
    typeof value[key] !== "string" ||
    !Number.isSafeInteger(value.device) || value.device < 0 ||
    !Number.isSafeInteger(value.inode) || value.inode < 1 ||
    typeof value.sha256 !== "string" || !/^[a-f\d]{64}$/.test(value.sha256)
  ) reject(`${label} identity is invalid`);
}

function migrationOwner() {
  return integer(process.env.OPENCLAW_TEAM_ROOT_UID ?? "0", "migration owner");
}

function migrationAncestors(directory, owner, boundary = "/") {
  if (!isAbsolute(directory) || resolve(directory) !== directory ||
      !isAbsolute(boundary) || resolve(boundary) !== boundary)
    reject("migration ancestor paths must be canonical absolute paths");
  safeRelative(boundary, directory);
  for (let current = directory; ; current = dirname(current)) {
    exactDirectory(current, owner, "migration ancestor");
    if (current === boundary) break;
    if (current === "/") reject("migration ancestor boundary is not an ancestor");
  }
}

function migrationNamespace(root) {
  const owner = migrationOwner();
  migrationAncestors(root, owner, process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
  const directory = join(root, "journal");
  const metadata = exactDirectory(directory, owner, "migration journal directory", { privateOnly: true });
  if (metadata.dev !== lstatSync(root).dev) reject("migration journal crosses filesystems");
  return { owner, directory, pathname: join(directory, "activation.json") };
}

function migrationJson(bytes) {
  // Fatal UTF-8 decoding and whole-input parsing reject truncated/invalid evidence.
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function migrationReadBytes(fd, limit) {
  const chunks = [];
  let size = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - size));
    const count = readSync(fd, chunk, 0, chunk.length, null);
    if (!count) break;
    size += count;
    if (size > limit) reject("migration JSON exceeds its bounded byte budget");
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, size);
}

function migrationArgument(value) {
  if (typeof value !== "string" || value === "@stdin" || Buffer.byteLength(value) > migrationJournalLimit)
    reject("migration argument must be bounded inline JSON");
  return JSON.parse(value);
}

function migrationFile(pathname, owner, { privateOnly = true, mode, group = rootGroup(), limit = migrationJsonLimit } = {}) {
  const before = identity(pathname);
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.uid !== owner || entry.gid !== group || entry.nlink !== 1 ||
        entry.dev !== before.device || entry.ino !== before.inode ||
        (entry.mode & 0o022) !== 0 || (privateOnly && (entry.mode & 0o077) !== 0) ||
        (mode !== undefined && (entry.mode & 0o7777) !== mode) || entry.size > limit)
      reject("migration evidence is not an exact owner-safe regular file");
    const bytes = migrationReadBytes(fd, limit);
    const after = fstatSync(fd);
    if (bytes.length !== entry.size || after.size !== entry.size ||
        after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs ||
        !isDeepStrictEqual(identity(pathname), before))
      reject("migration evidence changed while being read");
    return { bytes, descriptor: { ...before, sha256: createHash("sha256").update(bytes).digest("hex") } };
  } finally {
    closeSync(fd);
  }
}

function migrationWriteExclusive(pathname, bytes, mode) {
  const temporary = `${pathname}.next.${randomUUID()}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // A complete fsynced inode becomes visible once, without clobbering another owner or partial file.
  linkSync(temporary, pathname);
  unlinkSync(temporary);
  syncPath(dirname(pathname));
}

function migrationRecoverPublications(root) {
  const { owner, pathname: journal } = migrationNamespace(root);
  const boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
  const guard = join(boundary, "etc/systemd/system/openclaw-gateway.service.d", migrationGuardName);
  const targets = [
    { path: journal, mode: 0o600, validate(bytes) {
      const record = validJournal(migrationJson(bytes));
      if (record.kind === "host-handoff") {
        if (!["SOURCE_PREPARED", "TARGET_IMPORTED"].includes(record.phase)) reject("interrupted handoff journal has an unexpected phase");
        hostHandoffArtifacts(root, record);
        return;
      }
      if (record.kind === "worker-bootstrap") {
        if (record.phase !== "CONFIG_PREPARED") reject("interrupted worker config publication has an unexpected phase");
        const context = workerConfigLoad(root, record.request);
        workerConfigCommon(root, context);
        if (workerConfigCurrent(context).descriptor.sha256 !== context.request.config.sha256)
          reject("worker config changed during initial journal publication");
        return;
      }
      reject("unrecognized interrupted journal publication");
    } },
    { path: join(root, "journal", migrationPermitName), mode: 0o600, validate(bytes) {
      if (!bytes.equals(migrationPermitBody)) reject("interrupted permit body is not canonical");
    } },
    { path: guard, mode: 0o644, validate(bytes) {
      if (!bytes.equals(Buffer.from(migrationGuardBody(root)))) reject("interrupted native condition body is not canonical");
    } },
  ];
  settleFixedPublications(targets, owner, boundary);
  if (lstatSync(journal, { throwIfNoEntry: false }) && ownedJournal(journal).kind === "host-handoff") {
    const { record } = hostHandoffLoad(root);
    if (record.phase === "TARGET_VERIFYING") settleFixedPublications([{
      path: join(root, "journal", record.stage, "completed.json"), mode: 0o600,
      validate: bytes => hostHandoffCompletion(bytes, record),
    }], owner, boundary);
  }
  return "PUBLICATIONS_SETTLED";
}

function settleFixedPublications(targets, owner, boundary) {
  for (const target of targets) {
    const entry = lstatSync(target.path, { throwIfNoEntry: false });
    if (!entry || entry.nlink === 1) continue;
    const limit = target.limit ?? migrationJournalLimit;
    migrationAncestors(dirname(target.path), owner, boundary);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== owner || entry.gid !== rootGroup() ||
        entry.nlink !== 2 || (entry.mode & 0o7777) !== target.mode || entry.size > limit)
      reject("interrupted fixed publication has ambiguous links or ownership");
    const same = current => current.isFile() && !current.isSymbolicLink() && current.dev === entry.dev && current.ino === entry.ino &&
      current.nlink === 2 && current.size === entry.size && current.mode === entry.mode && current.uid === owner && current.gid === rootGroup() &&
      current.mtimeMs === entry.mtimeMs && current.ctimeMs === entry.ctimeMs;
    const fd = openSync(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(fstatSync(fd))) reject("fixed publication changed before inspection");
      const bytes = migrationReadBytes(fd, limit);
      if (bytes.length !== entry.size) reject("fixed publication bytes are incomplete");
      target.validate(bytes);
      if (!same(fstatSync(fd))) reject("fixed publication changed during validation");
    } finally { closeSync(fd); }
    const prefix = `${target.path.split("/").at(-1)}.next.`;
    const aliases = readdirSync(dirname(target.path)).filter(name => name.startsWith(prefix) &&
      /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(name.slice(prefix.length)))
      .map(name => join(dirname(target.path), name)).filter(pathname => same(lstatSync(pathname)));
    if (aliases.length !== 1 || !same(lstatSync(target.path)) || !same(lstatSync(aliases[0])))
      reject("fixed publication has no exact owner-generated temporary alias");
    // The canonical name already exists. Under the owner's EX lock, finish only its exact
    // same-inode publication alias; never mint a permit, adopt an orphan or weaken nlink checks.
    unlinkSync(aliases[0]); syncPath(dirname(target.path));
    const settled = lstatSync(target.path);
    if (settled.dev !== entry.dev || settled.ino !== entry.ino || settled.nlink !== 1 || !settled.isFile())
      reject("fixed publication identity changed while settling its temporary alias");
  }
}

function migrationPointers(root, owner, expected) {
  exactDirectory(join(root, "releases"), owner, "migration releases");
  for (const name of ["current", "previous"]) {
    const pathname = join(root, name);
    const entry = lstatSync(pathname, { throwIfNoEntry: false });
    if (!entry) {
      if (expected[name] !== null) reject(`migration ${name} pointer is missing`);
      continue;
    }
    if (!entry.isSymbolicLink() || entry.uid !== owner || entry.gid !== rootGroup() ||
        expected[name] === null || realpathSync(pathname) !== join(root, "releases", expected[name]))
      reject(`migration ${name} pointer identity changed`);
  }
}

function migrationPermit(root) {
  const { owner, directory } = migrationNamespace(root);
  const pathname = join(directory, migrationPermitName);
  if (!lstatSync(pathname, { throwIfNoEntry: false })) return null;
  const file = migrationFile(pathname, owner, { mode: 0o600, limit: 4096 });
  if (!file.bytes.equals(migrationPermitBody)) reject("Gateway start permit is not the owner's exact artifact");
  return file.descriptor;
}

function migrationPublishPermit(root) {
  const { directory } = migrationNamespace(root);
  if (!migrationPermit(root))
    atomicJson(join(directory, migrationPermitName), { version: 1, purpose: "gateway-start-permit" }, { noReplace: true });
  return migrationPermit(root);
}

function migrationGuardInstall(fragment, root, rawUid, boundary) {
  const owner = integer(rawUid, "guard root owner");
  if (fragment !== join(boundary, "etc/systemd/system/openclaw-gateway.service"))
    reject("migration guard requires the persistent /etc system Gateway service fragment");
  migrationAncestors(dirname(fragment), owner, boundary);
  migrationFile(fragment, owner, { privateOnly: false, limit: migrationJournalLimit });
  const directory = `${fragment}.d`;
  if (!lstatSync(directory, { throwIfNoEntry: false })) {
    mkdirSync(directory, { mode: 0o755 }); chmodSync(directory, 0o755);
    syncPath(directory); syncPath(dirname(directory));
  }
  exactDirectory(directory, owner, "migration guard drop-in directory");
  const pathname = join(directory, migrationGuardName);
  const installed = lstatSync(pathname, { throwIfNoEntry: false });
  const { pathname: journal } = migrationNamespace(root);
  const phase = lstatSync(journal, { throwIfNoEntry: false }) ? ownedJournal(journal).phase : "none";
  if (!installed) {
    // Bootstrap is the only no-journal permit mint. A missing permit on resume is never initialization.
    if (phase !== "none" || lstatSync(journal, { throwIfNoEntry: false }))
      reject("cannot bootstrap a native guard with any pending activation journal");
    migrationPublishPermit(root);
    migrationWriteExclusive(pathname, Buffer.from(migrationGuardBody(root)), 0o644);
  }
  const file = migrationFile(pathname, owner, { privateOnly: false, mode: 0o644, limit: migrationJournalLimit });
  if (!file.bytes.equals(Buffer.from(migrationGuardBody(root)))) reject("existing migration guard body differs");
  if (phase === "none" && !migrationPermit(root))
    reject("installed migration guard has no permit; refusing to infer a fresh install");
  return file.descriptor;
}

function migrationVerifyConditions(conditions, executable, root) {
  if (conditions?.type !== "a(sbbsi)" || !Array.isArray(conditions.data))
    reject("typed systemd Conditions are required; display text is not proof");
  const permit = join(root, "journal", migrationPermitName);
  const matches = conditions.data.filter(row => Array.isArray(row) && row.length === 5 &&
    row[0] === "ConditionPathExists" && row[1] === false && row[2] === false && row[3] === permit && Number.isInteger(row[4]));
  if (matches.length !== 1) reject("effective positive ordinary Gateway permit condition is missing or ambiguous");
  if (executable?.type !== "a(sasasttttuii)" || !Array.isArray(executable.data) || executable.data.length !== 0)
    reject("agent migration requires no executable ExecCondition under runtime-controlled environment");
}

function migrationGuardVerify(descriptor, conditions, executable, root) {
  validMigrationDescriptor(descriptor, "path", "migration guard");
  const directory = dirname(descriptor.path), boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
  if (descriptor.path !== join(boundary, "etc/systemd/system/openclaw-gateway.service.d", migrationGuardName))
    reject("migration guard path is not the persistent canonical drop-in");
  const owner = migrationOwner(); migrationAncestors(directory, owner, boundary);
  migrationFile(directory.slice(0, -2), owner, { privateOnly: false, limit: migrationJournalLimit });
  const file = migrationFile(descriptor.path, owner, { privateOnly: false, mode: 0o644, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(file.descriptor, descriptor) || !file.bytes.equals(Buffer.from(migrationGuardBody(root))))
    reject("migration guard descriptor or body changed");
  migrationVerifyConditions(conditions, executable, root);
  migrationPermit(root); // If present, it must be root-private and exact; absence may be the durable fence.
  return "OK";
}

function migrationHashFile(pathname) {
  const before = lstatSync(pathname);
  if (!before.isFile() || before.isSymbolicLink()) reject("migration input is not a regular file");
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    if (opened.dev !== before.dev || opened.ino !== before.ino) reject("migration file replaced at open");
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    const after = fstatSync(fd), current = lstatSync(pathname);
    if ([after, current].some(entry => entry.dev !== before.dev || entry.ino !== before.ino ||
        entry.size !== before.size || entry.mtimeMs !== before.mtimeMs || entry.ctimeMs !== before.ctimeMs))
      reject("migration file changed during hashing");
    return { ...identity(pathname), size: before.size, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}

function migrationOpenDatabase(pathname, release, readOnly = true) {
  const original = identity(pathname);
  const database = new DatabaseSync(pathname, { readOnly, allowExtension: true, timeout: 30_000 });
  try {
    // The sealed candidate owns the exact native extension ABI, including vector shadow tables.
    createRequire(join(release, "package.json"))("sqlite-vec").load(database);
    if (!database.prepare("SELECT vec_version() AS version").get().version) reject("SQLite vector extension unavailable");
    database.enableLoadExtension(false);
    // Full checks revisit pages; keep their cache on this short-lived read-only handle.
    if (readOnly) database.exec("PRAGMA cache_size=-65536;");
    database.exec(`PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=30000; ${readOnly ? "PRAGMA query_only=ON; BEGIN;" : ""}`);
    database.prepare("PRAGMA schema_version").get();
    return { database, close() {
      try { if (readOnly) database.exec("ROLLBACK"); } finally { database.close(); }
      if (!isDeepStrictEqual(identity(pathname), original)) reject("migration database identity changed");
    } };
  } catch (error) { database.close(); throw error; }
}

function migrationDatabaseRead(pathname, release, inspect) {
  const opened = migrationOpenDatabase(pathname, release);
  try { return inspect(opened.database); } finally { opened.close(); }
}

function migrationDatabaseBytes(inventory, release) {
  // Main-file sizes omit committed WAL pages that every copied snapshot must include.
  return inventory.stores.reduce((total, store) => total + migrationDatabaseRead(store.path, release, database =>
    database.prepare("PRAGMA page_count").get().page_count * database.prepare("PRAGMA page_size").get().page_size), 0);
}

function migrationStateContentVersion(database, published) {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='config_machine_state'").get())
    return published;
  const row = database.prepare("SELECT value_json FROM config_machine_state WHERE state_key='state.schema.contentVersion'").get();
  if (!row) return published;
  let content;
  try { content = JSON.parse(row.value_json); }
  catch { reject("shared schema content version is invalid"); }
  if (!Number.isSafeInteger(content) || content < 0) reject("shared schema content version is invalid");
  return Math.max(published, content);
}

function migrationSchema(database, owner, versions) {
  const version = database.prepare("PRAGMA user_version").get().user_version;
  const contentVersion = owner === null ? migrationStateContentVersion(database, version) : version;
  const metadata = database.prepare("SELECT role,schema_version,agent_id FROM schema_meta WHERE meta_key='primary'").get();
  if (!versions.includes(version) || !versions.includes(contentVersion) || metadata?.schema_version !== version ||
      metadata.role !== (owner === null ? "global" : "agent") || metadata.agent_id !== owner)
    reject("physical schema, content version, schema_meta, or database owner disagrees");
  return { version, metadata: { ...metadata } };
}

function migrationIntegrity(database) {
  const rows = database.prepare("PRAGMA integrity_check").all();
  if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok" || database.prepare("PRAGMA foreign_key_check").all().length)
    reject("migration database failed full integrity or foreign-key verification");
}

function migrationInventory(configPath, databasePath, release, profile, final = false) {
  const schemas = final ? profile.to : profile.from;
  if (!isDeepStrictEqual(jsonFile(join(release, "package.json")).openclaw.schemaVersions, profile.to))
    reject("migration inventory candidate schema tuple changed");
  const stateRoot = realpathSync(dirname(configPath));
  if (databasePath !== join(stateRoot, "state", "openclaw.sqlite") || realpathSync(configPath) !== configPath)
    reject("agent migration requires the canonical Team config and shared-state layout");
  const config = jsonFile(configPath);
  // Host handoff keeps its existing canonical-store export contract.
  if (config.session?.store != null || JSON.stringify(config).includes('"$include"'))
    reject("host handoff requires canonical session stores and config paths");
  const stores = new Map();
  function add(pathname, owner, source) {
    if (typeof pathname !== "string" || !pathname || (owner !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(owner)))
      reject("migration store locator or owner is malformed");
    pathname = isAbsolute(pathname) ? resolve(pathname) : resolve(stateRoot, pathname);
    safeRelative(stateRoot, pathname);
    const canonical = realpathSync(pathname); safeRelative(stateRoot, canonical);
    const entry = identity(canonical), key = `${entry.device}:${entry.inode}`;
    const existing = stores.get(key);
    if (existing && existing.agentId !== owner) reject("physical database has conflicting owners");
    const store = existing ?? { ...entry, agentId: owner, aliases: [] };
    const alias = { path: pathname, owner, source };
    if (!store.aliases.some(value => isDeepStrictEqual(value, alias))) store.aliases.push(alias);
    stores.set(key, store);
    if (stores.size > 257) reject("migration store inventory exceeds its bounded budget");
  }
  add(databasePath, null, "shared");
  const registry = databaseRead(databasePath, database => database.prepare(
    "SELECT agent_id,path,schema_version FROM agent_databases ORDER BY agent_id,path").all().map(row => ({ ...row })));
  if (registry.length > 256) reject("migration registry exceeds its bounded budget");
  for (const row of registry) {
    add(row.path, row.agent_id, "registry");
  }
  const entries = config.agents?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) reject("configured agent inventory is missing");
  const configured = new Set(Object.keys(entries));
  for (const id of [config.acp?.defaultAgent, ...(config.acp?.allowedAgents ?? [])])
    if (id !== undefined && id !== "*") configured.add(id);
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.runtime?.type === "acp") configured.add(entry.runtime.acp?.agent ?? id);
    if (entry.agentDir && entry.agentDir !== join(stateRoot, "agents", id, "agent"))
      reject("host handoff requires canonical agent directories");
  }
  for (const owner of configured) add(join(stateRoot, "agents", owner, "agent", "openclaw-agent.sqlite"), owner, "configured");
  const agents = join(stateRoot, "agents");
  for (const entry of readdirSync(agents, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) reject("migration canonical agent directory is a symlink");
    if (!entry.isDirectory()) continue;
    const pathname = join(agents, entry.name, "agent", "openclaw-agent.sqlite");
    if (lstatSync(pathname, { throwIfNoEntry: false })) add(pathname, entry.name, "disk");
  }
  const result = [...stores.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const store of result) {
    Object.assign(store, migrationDatabaseRead(store.path, release, database => {
      const schema = migrationSchema(database, store.agentId, [store.agentId === null ? schemas.state : schemas.agent]);
      return schema;
    }));
    store.aliases.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return { version: 1, ...migrationProfileBinding(profile),
    stateRoot, config: migrationHashFile(configPath), stores: result, registry };
}

function migrationSameInventory(before, after, profile, final = false) {
  migrationCheckProfileBinding(before, profile); migrationCheckProfileBinding(after, profile);
  const sourceSchemas = profile.from;
  const expectedConfig = before.config;
  if (!isDeepStrictEqual(expectedConfig, after.config) || before.stateRoot !== after.stateRoot || before.stores.length !== after.stores.length)
    reject("migration config or complete physical inventory changed");
  for (const old of before.stores) {
    if (old.version !== (old.agentId === null ? sourceSchemas.state : sourceSchemas.agent))
      reject("original inventory does not match the source schema tuple");
    const current = after.stores.find(value => value.path === old.path);
    if (!current || current.device !== old.device || current.inode !== old.inode || current.agentId !== old.agentId ||
        !old.aliases.every(alias => current.aliases.some(value => isDeepStrictEqual(value, alias))))
      reject("migration physical database or registered locator disappeared or changed");
    const schemas = final ? profile.to : sourceSchemas;
    if (current.version !== (current.agentId === null ? schemas.state : schemas.agent)) reject("migration left mixed physical schemas");
  }
  for (const old of before.registry) {
    const current = after.registry.find(value => value.agent_id === old.agent_id && value.path === old.path);
    if (!current) reject("host handoff registry identity changed");
  }
  // Every registered locator must still resolve to its physical owner.
  for (const row of after.registry) {
    const pathname = isAbsolute(row.path) ? resolve(row.path) : resolve(after.stateRoot, row.path);
    const store = after.stores.find(value => value.agentId === row.agent_id && value.aliases.some(alias => alias.path === pathname));
    if (!store || (final && store.version !== profile.to.agent)) reject("registry locator has no verified physical owner");
  }
  if (final && after.stores.some(store => store.agentId !== null &&
      !after.registry.some(row => row.agent_id === store.agentId && store.aliases.some(alias =>
        alias.path === (isAbsolute(row.path) ? resolve(row.path) : resolve(after.stateRoot, row.path))))))
    reject("migrated physical agent database is missing its registry owner");
}

function migrationSqlName(name) { return `"${name.replaceAll('"', '""')}"`; }
function migrationRowsDigest(database, query, project = row => row) {
  const statement = database.prepare(query); statement.setReadBigInts(true); statement.setReturnArrays(true);
  const hash = createHash("sha256"); let count = 0;
  for (const row of statement.iterate()) {
    const encoded = JSON.stringify(project(row).map(value => value instanceof Uint8Array ? ["blob", Buffer.from(value).toString("base64")]
      : typeof value === "bigint" ? ["integer", String(value)] : [typeof value, value]));
    hash.update(`${Buffer.byteLength(encoded)}:`); hash.update(encoded); count++;
  }
  return { count, sha256: hash.digest("hex") };
}

function migrationTableDigests(database) {
  const result = {};
  for (const { name, sql } of database.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all()) {
    if (/^CREATE VIRTUAL TABLE/i.test(sql ?? "")) continue; // Their ordinary shadow tables are hashed below.
    const columns = database.prepare(`PRAGMA table_info(${migrationSqlName(name)})`).all().map(row => row.name);
    if (!columns.length) reject("migration cannot read an ordinary table");
    const fields = columns.map(migrationSqlName).join(",");
    result[name] = { columns, ...migrationRowsDigest(database, `SELECT ${fields} FROM ${migrationSqlName(name)} ORDER BY ${fields}`) };
  }
  return result;
}

function migrationCaptureWitness(inventory, release) {
  const witness = [];
  for (const store of inventory.stores.filter(value => value.agentId !== null))
    migrationDatabaseRead(store.path, release, database => {
      for (const row of database.prepare(`SELECT n.session_key,n.current_session_id,w.session_key AS window_key,t.generation
        FROM session_nodes n LEFT JOIN session_windows w ON w.session_id=n.current_session_id
        LEFT JOIN transcript_rewrite_watermarks t ON t.session_id=w.session_id`).all())
        witness.push(JSON.stringify([store.agentId, store.path, store.device, store.inode,
          row.session_key, row.current_session_id, row.window_key, row.generation]));
    });
  return witness.sort();
}

function migrationVerifyWitness(inventory, release, witness) {
  const warnings = sessionPreservationWarnings();
  if (!Array.isArray(witness)) reject("original migration witness is malformed");
  const pending = new Map();
  for (const [ordinal, encoded] of witness.entries()) {
    const row = JSON.parse(encoded);
    if (!Array.isArray(row) || row.length !== 8 || [0, 1, 4, 5].some(index => typeof row[index] !== "string") ||
        [2, 3].some(index => !Number.isSafeInteger(row[index])) || [6, 7].some(index => row[index] !== null && typeof row[index] !== "string"))
      reject("original migration witness entry is malformed");
    const key = JSON.stringify(row.slice(0, 4));
    const rows = pending.get(key) ?? []; rows.push({ tuple: row, ordinal }); pending.set(key, rows);
  }
  for (const store of inventory.stores.filter(value => value.agentId !== null)) {
    const key = JSON.stringify([store.agentId, store.path, store.device, store.inode]), rows = pending.get(key);
    if (!rows) continue;
    migrationDatabaseRead(store.path, release, database => {
      const keys = new Set(database.prepare("SELECT session_key FROM session_nodes").all().map(row => row.session_key));
      for (const { tuple, ordinal } of rows) {
        const [sessionKey, sessionId, windowKey, generation] = tuple.slice(4);
        if (keys.has(sessionKey)) continue;
        const failure = transcriptPreservationFailure(database, sessionKey, sessionId, windowKey, generation);
        if (failure) warnings.record(tuple, ordinal, failure);
      }
    });
    pending.delete(key);
  }
  if (pending.size) reject("original migration session database identity is missing");
  warnings.finish();
}

async function migrationSnapshot(store, release, target) {
  if (lstatSync(target, { throwIfNoEntry: false })) reject("original backup already exists; refusing overwrite or reconstruction");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const source = migrationOpenDatabase(store.path, release);
  let tables, sourceJournalMode;
  try {
    sourceJournalMode = source.database.prepare("PRAGMA journal_mode").get().journal_mode;
    if (!["wal", "delete"].includes(sourceJournalMode)) reject("source persistent journal mode is not qualified");
    migrationSchema(source.database, store.agentId, [store.version]); migrationIntegrity(source.database);
    tables = migrationTableDigests(source.database);
    // Native backup includes the committed WAL snapshot. Never checkpoint/VACUUM/sanitize the source.
    await backup(source.database, target);
  } finally { source.close(); }
  chmodSync(target, 0o600);
  const destination = migrationOpenDatabase(target, release, false);
  try {
    destination.database.exec("PRAGMA journal_mode=DELETE");
    migrationSchema(destination.database, store.agentId, [store.version]); migrationIntegrity(destination.database);
    if (!isDeepStrictEqual(migrationTableDigests(destination.database), tables)) reject("lossless backup logical readback differs");
  } finally { destination.close(); }
  syncPath(target); syncPath(dirname(target));
  return { source: store.path, sourceJournalMode, file: migrationHashFile(target), tables };
}

async function snapshotForHandoff(root, release, configPath, databasePath, handoff) {
  const { owner, directory } = migrationNamespace(root);
  hostHandoffSourceStopped(root, handoff);
  const info = validateRelease(release, basename(release), owner, true);
  if (realpathSync(join(root, "current")) !== release) reject("handoff source is not the current sealed release");
  const stage = join(directory, handoff.stage, `export-${randomUUID()}`);
  if (lstatSync(stage, { throwIfNoEntry: false })) reject("handoff snapshot already exists; preserve it and use a fresh label");
  const profile = { from: info.schemaVersions, to: info.schemaVersions };
  const inventory = migrationInventory(configPath, databasePath, release, profile);
  const disk = statfsSync(directory);
  if (disk.bavail * disk.bsize < migrationDatabaseBytes(inventory, release) + inventory.config.size + migrationJsonLimit + operationalReserveBytes)
    reject("handoff snapshots lack destination capacity with the operational reserve retained");
  mkdirSync(stage, { mode: 0o700 }); syncPath(directory);
  const configCopy = join(stage, "openclaw.json");
  copyFileSync(configPath, configCopy, constants.COPYFILE_EXCL); chmodSync(configCopy, 0o600); syncPath(configCopy);
  const copiedConfig = migrationHashFile(configCopy);
  if (copiedConfig.sha256 !== inventory.config.sha256 || copiedConfig.size !== inventory.config.size)
    reject("configuration changed while capturing handoff inputs");
  const startedAt = Date.now(), backups = [];
  for (const [index, store] of inventory.stores.entries()) {
    process.stderr.write(`HANDOFF_SNAPSHOT_STORE index=${index + 1} count=${inventory.stores.length}\n`);
    backups.push(await migrationSnapshot(store, release, join(stage, "snapshots", `${index}.sqlite`)));
  }
  migrationSameInventory(inventory, migrationInventory(configPath, databasePath, release, profile), profile);
  if (realpathSync(join(root, "current")) !== release)
    reject("handoff source changed during snapshot capture");
  hostHandoffSourceStopped(root, handoff);
  const manifest = join(stage, "manifest.json");
  atomicJson(manifest, { version: 1, kind: "team-state-handoff",
    consistency: "quiesced-source",
    handoff: { id: handoff.id, sourceMachineId: handoff.machineId, targetMachineId: handoff.peerMachineId,
      targetSha: handoff.targetSha, process: handoff.process, schedules: handoff.schedules },
    release: info, inventory, configCopy: copiedConfig, backups, startedAt, finishedAt: Date.now() }, { noReplace: true });
  return { manifest, manifestSha256: migrationHashFile(manifest).sha256, stores: backups.length,
    consistency: "quiesced-source", sourceWritersStopped: true };
}

function verifyHandoffSnapshot(manifestPath, sourceRelease, candidateRelease, expectedManifestHash, beforeDoctor = false) {
  const owner = migrationOwner(), saved = migrationFile(manifestPath, owner, { mode: 0o600 });
  if (!/^[a-f\d]{64}$/.test(expectedManifestHash) || saved.descriptor.sha256 !== expectedManifestHash)
    reject("handoff manifest differs from its captured source digest");
  const manifest = migrationJson(saved.bytes);
  if (manifest?.version !== 1 || manifest.kind !== "team-state-handoff" ||
      manifest.consistency !== "quiesced-source" || !Array.isArray(manifest.backups))
    reject("handoff snapshot manifest is invalid");
  const source = validateRelease(sourceRelease, basename(sourceRelease), owner, true);
  const candidate = validateRelease(candidateRelease, basename(candidateRelease), owner, true);
  if (!isDeepStrictEqual(source, manifest.release)) reject("handoff source release differs from the snapshot");
  const profile = { from: source.schemaVersions, to: candidate.schemaVersions };
  const original = manifest.inventory;
  migrationCheckProfileBinding(original, { from: source.schemaVersions, to: source.schemaVersions });
  const copied = descriptor => {
    if (typeof descriptor?.path !== "string") reject("handoff artifact path is missing");
    safeRelative(dirname(manifestPath), descriptor.path);
    const actual = migrationHashFile(descriptor.path);
    if (actual.sha256 !== descriptor.sha256 || actual.size !== descriptor.size)
      reject("copied handoff artifact bytes differ from the source snapshot");
    return actual;
  };
  const configCopy = copied(manifest.configCopy), config = migrationHashFile(original.config.path);
  if (configCopy.sha256 !== original.config.sha256 || configCopy.size !== original.config.size ||
      config.sha256 !== configCopy.sha256 || config.size !== configCopy.size)
    reject("handoff config differs; verify Doctor before relocation and endpoint changes");
  const backups = manifest.backups.map(value => ({ ...value, file: copied(value.file) }));
  if (backups.length !== original.stores.length || new Set(backups.map(value => value.source)).size !== backups.length)
    reject("handoff snapshot has an incomplete or repeated database inventory");
  const current = migrationInventory(config.path, join(original.stateRoot, "state/openclaw.sqlite"), candidateRelease, profile, !beforeDoctor);
  const stores = original.stores.map(store => {
    const target = current.stores.find(value => value.path === store.path && value.agentId === store.agentId);
    const snapshot = backups.find(value => value.source === store.path);
    if (!target || !snapshot) reject("handoff target lost an original database owner");
    return { ...store, device: target.device, inode: target.inode };
  });
  // Only physical copy identity changes. Original artifacts and their ownership/schema evidence stay immutable.
  const projected = { ...original, ...migrationProfileBinding(profile), config, stores };
  migrationSameInventory(projected, current, profile, !beforeDoctor);
  const backupInventory = { ...original, stores: original.stores.map(store => {
    const snapshot = backups.find(value => value.source === store.path);
    return { ...store, path: snapshot.file.path, device: snapshot.file.device, inode: snapshot.file.inode };
  }) };
  const witness = migrationCaptureWitness(backupInventory, sourceRelease).map(encoded => {
    const tuple = JSON.parse(encoded), snapshot = backups.find(value => value.file.path === tuple[1]);
    const target = stores.find(value => value.path === snapshot.source && value.agentId === tuple[0]);
    return JSON.stringify([tuple[0], target.path, target.device, target.inode, ...tuple.slice(4)]);
  });
  // Verify the imported copy before Doctor owns schema metadata and migration effects.
  // Later verification retains the original session witness and native schema ownership checks.
  if (beforeDoctor) {
    for (const store of current.stores) {
      const snapshot = backups.find(value => value.source === store.path);
      if (!isDeepStrictEqual(migrationDatabaseRead(store.path, candidateRelease, migrationTableDigests), snapshot.tables))
        reject("handoff copy differs from its source snapshot");
    }
  }
  migrationVerifyWitness(current, candidateRelease, witness);
  migrationSameInventory(projected, migrationInventory(config.path,
    join(original.stateRoot, "state/openclaw.sqlite"), candidateRelease, profile, !beforeDoctor), profile, !beforeDoctor);
  if (!isDeepStrictEqual(migrationFile(manifestPath, owner, { mode: 0o600 }).descriptor, saved.descriptor))
    reject("handoff snapshot manifest changed during verification");
  return { status: "HANDOFF_COPY_VERIFIED", source: source.sha, candidate: candidate.sha,
    stores: stores.length, sourceSessionWitnesses: witness.length, sourceWritersStopped: true };
}

function assertDatabaseWritersStopped(targets, procRoot) {
  const identities = new Set([...targets].flatMap(pathname => {
    const entry = lstatSync(pathname, { throwIfNoEntry: false }); return entry ? [`${entry.dev}:${entry.ino}`] : [];
  }));
  for (const pid of readdirSync(procRoot).filter(name => /^[1-9]\d*$/.test(name) && Number(name) !== process.pid)) {
    const processRoot = join(procRoot, pid);
    try {
      for (const fd of readdirSync(join(processRoot, "fd"))) {
        let entry;
        try { entry = statSync(join(processRoot, "fd", fd)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!identities.has(`${entry.dev}:${entry.ino}`)) continue;
        const info = readFileSync(join(processRoot, "fdinfo", fd), "utf8"), flags = /^flags:\s*([0-7]+)$/m.exec(info)?.[1];
        if (!flags || (Number.parseInt(flags, 8) & 3) !== 0) reject("an external process retains a writable migration database descriptor");
      }
      const maps = readFileSync(join(processRoot, "maps"), "utf8");
      for (const line of maps.split("\n")) {
        const match = /^\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
        if (match && match[1].includes("w") && targets.has(match[2].replace(/ \(deleted\)$/, "")))
          reject("an external process retains a writable migration database mapping");
      }
    } catch (error) { if (error.code === "ENOENT" && !existsSync(processRoot)) continue; throw error; }
  }
}

function migrationNativeConfigAudit(root, record, previous, config, runtimeUid, startup) {
  const entry = lstatSync(config.path), release = join(root, "releases", record.candidate.sha);
  return migrationDatabaseRead(record.protectedPaths[1].path, release, database => {
    const rows = database.prepare("SELECT event_key,payload_json FROM diagnostic_events WHERE scope='config-audit' ORDER BY sequence DESC LIMIT 50000").all();
    const chain = [], fail = () => reject("reviewed config lacks a native runtime-owner atomic replacement audit");
    const createdAt = Date.parse(record.createdAt);
    let timestamp = createdAt, cursor = { Dev: String(previous.device), Ino: String(previous.inode) }, last;
    if (!Number.isFinite(createdAt)) fail();
    // Sequence is the native writer's order. Sorting timestamps would hide reordered links.
    for (const row of rows.reverse()) {
      const value = JSON.parse(row.payload_json), time = Date.parse(value.ts);
      if (value.configPath !== config.path || (!chain.length && time < createdAt)) continue;
      if (value.event === "config.observe" && value.source === "config-io" &&
          value.phase === "read" && value.restoredFromBackup === false) continue;
      if (chain.length >= (startup ? 1 : 64) || !Number.isFinite(time) || time < timestamp || time > Date.now() ||
          value.event !== "config.write" || value.source !== "config-io" || value.result !== "rename" ||
          value.existsBefore !== true || !row.event_key.startsWith(`${value.ts}:config.write:`) ||
          !Number.isSafeInteger(value.pid) || value.pid < 1 || value.cwd !== release ||
          !Array.isArray(value.argv) || ![join(root, "current/dist/index.js"), join(release, "dist/index.js")].includes(value.argv[1]) ||
          !isDeepStrictEqual(value.argv.slice(2), ["gateway", "--port", process.env.OPENCLAW_TEAM_GATEWAY_PORT ?? "18789"]) ||
          (startup && (value.pid !== startup.pid || time < startup.startedAt || time > startup.startedAt + 600_000)) ||
          Object.entries(cursor).some(([key, expected]) => value["previous" + key] !== expected) ||
          value.nextDev !== cursor.Dev || value.nextIno === cursor.Ino) fail();
      for (const prefix of ["previous", "next"]) {
        if (!/^[a-f\d]{64}$/.test(value[prefix + "Hash"]) || !/^[1-9]\d*$/.test(value[prefix + "Ino"]) ||
            !Number.isSafeInteger(value[prefix + "Bytes"]) || value[prefix + "Bytes"] < 0 ||
            value[prefix + "Mode"] !== 0o600 || value[prefix + "Nlink"] !== 1 ||
            value[prefix + "Uid"] !== runtimeUid || value[prefix + "Gid"] !== entry.gid) fail();
      }
      cursor = { Dev: value.nextDev, Ino: value.nextIno, Hash: value.nextHash, Bytes: value.nextBytes };
      timestamp = time; last = value;
      // Bind every link without retaining the native writer's argv or config values.
      chain.push({ key: row.event_key, sha256: createHash("sha256").update(row.payload_json).digest("hex") });
    }
    if (!last || cursor.Dev !== String(config.device) || cursor.Ino !== String(config.inode) ||
        cursor.Hash !== config.sha256 || cursor.Bytes !== config.size ||
        last.previousHash !== previous.sha256 || last.previousBytes !== previous.size) fail();
    return chain.length === 1 ? chain[0] : { chain };
  });
}

function selectedConfigProcess(root, record, binding) {
  if (!Number.isSafeInteger(binding?.pid) || binding.pid < 1 || !/^[1-9]\d*$/.test(binding.generation))
    reject("selected config requires an exact candidate process generation");
  const proc = process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc", directory = join(proc, String(binding.pid));
  const stat = readFileSync(join(directory, "stat"), "utf8"), boundary = stat.lastIndexOf(") ");
  const fields = stat.slice(boundary + 2).trim().split(/\s+/);
  if (boundary < 0 || fields[19] !== binding.generation || ["Z", "X", "x", "T", "t"].includes(fields[0]) ||
      realpathSync(join(directory, "cwd")) !== join(root, "releases", record.candidate.sha))
    reject("selected config candidate process generation changed");
  migrationPointers(root, migrationOwner(), { current: record.candidate.sha, previous: record.predecessor.sha });
  return { pid: binding.pid, generation: binding.generation };
}

function configReplacement(root, record, runtimeUid, startup) {
  const path = record.protectedPaths[0].path, entry = lstatSync(path);
  const current = migrationFile(path, runtimeUid, { mode: 0o600, group: entry.gid });
  const backup = migrationFile(`${path}.bak`, runtimeUid, { mode: 0o600, group: entry.gid });
  const config = { ...current.descriptor, size: current.bytes.length };
  if (config.device !== record.protectedPaths[0].device || config.inode === record.protectedPaths[0].inode ||
      backup.descriptor.device !== config.device || backup.descriptor.inode === config.inode)
    reject("config replacement requires a same-filesystem atomic rename and separate backup");
  const previous = { ...record.protectedPaths[0], sha256: backup.descriptor.sha256, size: backup.bytes.length };
  const audit = migrationNativeConfigAudit(root, record, previous, config, runtimeUid, startup);
  return { current, backup, config, previous, audit, gid: entry.gid };
}

function startupConfigAdditions(before, after) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  let count = 0;
  const added = (value, path) => {
    if (object(value)) {
      if (!Object.keys(value).length) reject("startup config adds an empty object");
      for (const [key, child] of Object.entries(value)) added(child, [...path, key]);
      return;
    }
    const metadata = path.length >= 3 && path[0] === "meta" && path[1] === "migrations";
    const account = path.length >= 5 && path[0] === "channels" && path[2] === "accounts" &&
      object(before.channels?.[path[1]]?.accounts) && Object.hasOwn(before.channels[path[1]].accounts, path[3]) &&
      object(before.channels[path[1]].accounts[path[3]]);
    if (Array.isArray(value) || !(metadata || account)) reject("startup config adds a key outside migration metadata or an existing channel account");
    count++;
  };
  const compare = (old, next, path) => {
    if (isDeepStrictEqual(old, next)) return;
    if (!object(old) || !object(next)) reject("startup config changed an existing value");
    for (const key of Object.keys(old)) {
      if (!Object.hasOwn(next, key)) reject("startup config removed a key");
      compare(old[key], next[key], [...path, key]);
    }
    for (const key of Object.keys(next)) if (!Object.hasOwn(old, key)) added(next[key], [...path, key]);
  };
  compare(before, after, []);
  if (!count) reject("startup config has no qualified additive migration");
  return count;
}

function candidateConfigSnapshot(pathname, root, expectedPaths, binding, runtimeUid, expectedPolicy) {
  const namespace = migrationNamespace(root), record = ownedJournal(pathname);
  if (pathname !== namespace.pathname || record.phase !== "D_VERIFYING" || record.topology !== "system" ||
      record.runtimeChange || !record.originalWitness ||
      record.candidate.sha === record.predecessor.sha ||
      (!record.nativeUpdate && !isDeepStrictEqual(record.predecessor.schemaVersions, record.candidate.schemaVersions)) ||
      !isDeepStrictEqual(record.protectedPaths, expectedPaths))
    reject("startup config acceptance requires the bound ordinary candidate verification journal");
  originalWitness(pathname, record);
  if (!isDeepStrictEqual(identity(record.protectedPaths[1].path), record.protectedPaths[1]))
    reject("startup config acceptance refuses a replaced store");
  const candidateProcess = selectedConfigProcess(root, record, binding);
  const proc = process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc";
  const boot = /^btime (\d+)$/m.exec(readFileSync(join(proc, "stat"), "utf8"));
  const clock = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 5000 });
  const ticks = Number(clock.stdout?.trim());
  if (!boot || clock.status !== 0 || !Number.isSafeInteger(ticks) || ticks <= 0)
    reject("startup config cannot bind the process start time");
  const startedAt = Number(boot[1]) * 1000 + Number(binding.generation) * 1000 / ticks;
  if (!Number.isFinite(startedAt) || startedAt < Date.parse(record.createdAt) - 1000 ||
      !Number.isFinite(Date.parse(record.createdAt))) reject("startup config process predates activation");
  const replacement = configReplacement(root, record, runtimeUid, { ...candidateProcess, startedAt });
  const keys = startupConfigAdditions(migrationJson(replacement.backup.bytes), migrationJson(replacement.current.bytes));
  if (!isDeepStrictEqual(policy(replacement.backup.descriptor.path), expectedPolicy) ||
      !isDeepStrictEqual(policy(replacement.config.path), expectedPolicy)) reject("startup config policy changed");
  const journal = migrationFile(pathname, namespace.owner, { mode: 0o600, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(migrationJson(journal.bytes), record)) reject("startup config journal changed");
  if (!isDeepStrictEqual(identity(record.protectedPaths[1].path), record.protectedPaths[1]) ||
      !isDeepStrictEqual(migrationFile(replacement.config.path, runtimeUid, { mode: 0o600, group: replacement.gid }).descriptor,
        replacement.current.descriptor) ||
      !isDeepStrictEqual(migrationFile(replacement.backup.descriptor.path, runtimeUid, { mode: 0o600, group: replacement.gid }).descriptor,
        replacement.backup.descriptor)) reject("startup config or store changed during audit verification");
  selectedConfigProcess(root, record, binding);
  return { version: 1, kind: "candidate-startup-config", original: { record, identity: journal.descriptor },
    config: replacement.config, backup: replacement.backup.descriptor, previous: replacement.previous,
    audit: replacement.audit, process: candidateProcess, runtimeUid, runtimeGid: replacement.gid, startedAt, keys };
}

function candidateConfigAccept(pathname, root, expectedPaths, binding, runtimeUid, expectedPolicy) {
  const snapshot = () => candidateConfigSnapshot(pathname, root, expectedPaths, binding, runtimeUid, expectedPolicy);
  const receipt = snapshot();
  // Keep the original journal and acceptance evidence even if publication is interrupted.
  migrationWriteExclusive(join(dirname(pathname), `config-startup-${randomUUID()}.json`), Buffer.from(`${JSON.stringify(receipt)}\n`), 0o600);
  if (!isDeepStrictEqual(snapshot(), receipt)) reject("startup config acceptance changed before publication");
  const record = structuredClone(receipt.original.record);
  record.protectedPaths[0] = { path: receipt.config.path, device: receipt.config.device, inode: receipt.config.inode };
  validJournal(record);
  atomicJson(pathname, record);
  if (!isDeepStrictEqual(ownedJournal(pathname), record)) reject("startup config journal publication changed");
  return `CONFIG_MIGRATION_ACCEPTED keys=${receipt.keys} source=candidate-startup`;
}

function policy(pathname) {
  const config = jsonFile(pathname);
  const server = config.plugins?.entries?.codex?.config?.appServer;
  const { policy: expected, modelAgent } = operatorProfile();
  if (
    config.update?.auto?.enabled !== expected.updateAuto ||
    config.channels?.clickclack?.commandMenu !== expected.clickclackCommandMenu ||
    config.tools?.exec?.mode !== expected.mode ||
    appServerPolicyFields.some(key => server?.[key] !== expected.appServer[key]) ||
    config.tools?.fs?.workspaceOnly !== expected.workspaceOnly
  ) {
    reject("configured deployment policy is invalid");
  }
  const modelValue = config.agents?.entries?.[modelAgent]?.model ?? config.agents?.defaults?.model;
  const model = typeof modelValue === "string" ? modelValue : modelValue?.primary;
  if (typeof model !== "string" || !model.includes("/") || model.trim() !== model) {
    reject("configured deployment model is invalid");
  }
  const fallbacks = typeof modelValue === "object" ? modelValue?.fallbacks ?? [] : [];
  if (!Array.isArray(fallbacks) || fallbacks.some(value =>
    typeof value !== "string" || !value.includes("/") || value.trim() !== value)) {
    reject("configured deployment model fallbacks are invalid");
  }
  return {
    mode: config.tools.exec.mode,
    appServer: server,
    workspaceOnly: config.tools.fs.workspaceOnly,
    updateAuto: config.update.auto.enabled,
    clickclackCommandMenu: config.channels?.clickclack?.commandMenu,
    model,
    fallbacks,
  };
}

function databaseRead(pathname, callback) {
  const database = new DatabaseSync(pathname, { readOnly: true, timeout: 1000 });
  try {
    database.exec(
      "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN",
    );
    // Window identity, rewrite generation and retention evidence share one read snapshot.
    try {
      return callback(database);
    } finally {
      database.exec("ROLLBACK");
    }
  } finally {
    database.close();
  }
}

function verifyStateCompatibility(databasePath, existing, candidate, inspectAgent, captured = [], beforeAgentRead, inspectRetiredAgents) {
  const stateRoot = dirname(dirname(databasePath));
  const agents = new Map();
  let retiredAgents;
  const recordAgent = (pathname, agentId) => {
    // Discovery sources must agree; canonical layout cannot erase a conflicting registration.
    if (agents.has(pathname) && agents.get(pathname) !== agentId)
      reject("agent database ownership sources disagree");
    agents.set(pathname, agentId);
  };
  const live = databaseRead(databasePath, (database) => {
    const observed = database.prepare("PRAGMA user_version").get().user_version;
    const registry = database
      .prepare("SELECT type FROM sqlite_master WHERE name = ?")
      .get("agent_databases");
    if (registry && registry.type !== "table") reject("agent database registry is malformed");
    if (registry) {
      const columns = new Set(
        database
          .prepare("PRAGMA table_info(agent_databases)")
          .all()
          .map((row) => row.name),
      );
      for (const column of ["agent_id", "path"]) {
        if (!columns.has(column)) reject(`agent database registry is missing ${column}`);
      }
      const rows = database
        .prepare("SELECT agent_id, path FROM agent_databases LIMIT 257")
        .all();
      if (rows.length > 256)
        reject("agent database registry exceeds the bounded compatibility budget");
      for (const row of rows) {
        if (
          typeof row.agent_id !== "string" ||
          !row.agent_id ||
          typeof row.path !== "string" ||
          !row.path
        ) {
          reject("registered agent database identity is invalid");
        }
        const pathname = isAbsolute(row.path) ? resolve(row.path) : resolve(stateRoot, row.path);
        if (!isAbsolute(row.path))
          safeRelative(realpathSync(stateRoot), realpathSync(dirname(pathname)));
        recordAgent(pathname, row.agent_id);
      }
    }
    retiredAgents = inspectRetiredAgents?.(database);
    return observed;
  });
  // Package versions are reader ceilings; a failed boot need not have advanced live state.
  if (!Number.isSafeInteger(live) || live > candidate.state || live > existing.state) {
    reject("live state schema is incompatible with candidate or rollback predecessor");
  }

  const canonicalAgents = join(stateRoot, "agents");
  if (existsSync(canonicalAgents)) {
    for (const directory of readdirSync(canonicalAgents, { withFileTypes: true })) {
      if (directory.isSymbolicLink()) reject("canonical agent directory is a symlink");
      if (!directory.isDirectory()) continue;
      const pathname = join(canonicalAgents, directory.name, "agent", "openclaw-agent.sqlite");
      if (existsSync(pathname)) recordAgent(pathname, directory.name);
      if (agents.size > 256)
        reject("canonical agent databases exceed the bounded compatibility budget");
    }
  }

  // Registration may retire while its captured history remains. The original witness
  // still owns that obligation; inspect its exact store through the same verifier.
  const historical = new Map();
  for (const tuple of captured) {
    const [agentId, pathname] = tuple;
    if (agents.has(pathname)) { recordAgent(pathname, agentId); continue; }
    historical.set(pathname, tuple);
    recordAgent(pathname, agentId);
    if (agents.size > 256) reject("captured agent databases exceed the bounded compatibility budget");
  }
  for (const pathname of retiredAgents ?? []) agents.delete(pathname);
  const stateOwner = lstatSync(stateRoot);
  function historicalIdentity(pathname) {
    const [, , device, inode] = historical.get(pathname);
    if (!isAbsolute(pathname) || resolve(pathname) !== pathname)
      reject("captured session database path is not canonical");
    const entry = lstatSync(pathname, { throwIfNoEntry: false });
    if (!entry?.isFile() || entry.isSymbolicLink() || entry.dev !== device || entry.ino !== inode ||
        entry.uid !== stateOwner.uid || entry.gid !== stateOwner.gid || (entry.mode & 0o022) !== 0)
      reject("a captured session database identity is missing or changed");
    if (realpathSync(pathname) !== pathname) reject("captured session database path is not canonical");
    return entry;
  }
  for (const [pathname, agentId] of agents) {
    beforeAgentRead?.(pathname);
    const capturedEntry = historical.has(pathname) ? historicalIdentity(pathname) : undefined;
    const entry = capturedEntry ?? lstatSync(pathname);
    if (!entry.isFile() || entry.isSymbolicLink())
      reject(`registered agent database is unsafe: ${agentId}`);
    // The held descriptor brackets identity checks, not an atomic SQLite pathname open.
    // Read-only SQLite may still coordinate through SHM; this proves retained data, not zero writes.
    const fd = capturedEntry ? openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) : undefined;
    try {
      if (fd !== undefined) {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino)
          reject("captured database changed before opening");
      }
      databaseRead(pathname, (database) => {
        const version = database.prepare("PRAGMA user_version").get().user_version;
        if (version !== Math.min(existing.agent, candidate.agent)) {
          reject(`live agent database schema is incompatible: ${agentId}`);
        }
        const metadata = database
          .prepare("SELECT type FROM sqlite_master WHERE name = ?")
          .get("schema_meta");
        if (!metadata && capturedEntry) reject("captured database requires exact physical ownership metadata");
        if (metadata) {
          if (metadata.type !== "table") reject(`agent schema metadata is malformed: ${agentId}`);
          const record = database
            .prepare("SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = ?")
            .get("primary");
          if (
            record?.role !== "agent" ||
            record.agent_id !== agentId ||
            record.schema_version !== version
          ) {
            reject(`agent database ownership metadata drifted: ${agentId}`);
          }
        }
        inspectAgent?.(database, agentId, pathname, entry);
      });
      const after = capturedEntry ? historicalIdentity(pathname) : lstatSync(pathname);
      if (after.dev !== entry.dev || after.ino !== entry.ino) {
        reject(`agent database identity changed during admission: ${agentId}`);
      }
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return { live, current: existing, target: candidate, agentDatabases: agents.size };
}

function sessionWitnessTuples(saved) {
  if (!Array.isArray(saved)) reject("session preservation witness is malformed");
  return saved.map(value => {
    if (typeof value !== "string") reject("session preservation witness is malformed");
    const tuple = JSON.parse(value);
    if (!Array.isArray(tuple) || tuple.length !== 8 ||
        [0, 1, 4, 5].some(index => typeof tuple[index] !== "string") ||
        [2, 3].some(index => !Number.isSafeInteger(tuple[index]) || tuple[index] < 0) ||
        [6, 7].some(index => tuple[index] !== null && typeof tuple[index] !== "string"))
      reject("session preservation witness is malformed");
    return tuple;
  });
}

function nativeUpdateReceipt(record, required = false) {
  if (!record.nativeUpdate) {
    if (required) reject("activation journal has no native update owner");
    return null;
  }
  const root = record.nativeUpdate.backupRoot;
  const receiptPath = `${root}.receipt.json`;
  const entry = lstatSync(receiptPath, { throwIfNoEntry: false });
  if (!entry) {
    if (required) reject("native update has not published its receipt");
    return null;
  }
  if (realpathSync(dirname(root)) !== dirname(root))
    reject("native update receipt directory is not canonical");
  const configOwner = lstatSync(record.protectedPaths[0].path);
  if (entry.uid !== configOwner.uid || entry.gid !== configOwner.gid)
    reject("native update receipt is not owned by the runtime config owner");
  const receipt = migrationJson(migrationFile(receiptPath, entry.uid, { mode: 0o600, group: entry.gid }).bytes);
  if (receipt.schemaVersion !== 1 || !["migrated", "restored"].includes(receipt.status) ||
      receipt.configPath !== record.protectedPaths[0].path ||
      receipt.stateDir !== dirname(dirname(record.protectedPaths[1].path)) ||
      !Array.isArray(receipt.databases) || !receipt.databases.includes(record.protectedPaths[1].path)) {
    if (!required && ["backed-up", "failed", "restoring-config"].includes(receipt.status)) return null;
    reject("native update receipt has no completed migration or restoration");
  }
  const identities = new Map();
  for (const path of receipt.databases) {
    const value = receipt.databaseIdentities?.[path];
    if (!value) continue; // Originally absent stores may still be absent after restoration.
    if (!isAbsolute(path) || resolve(path) !== path || !Number.isSafeInteger(value.dev) || !Number.isSafeInteger(value.ino))
      reject("native database receipt identity is invalid");
    const recorded = { path, device: value.dev, inode: value.ino };
    if (required && !isDeepStrictEqual(identity(path), recorded))
      reject("native database identity changed after the owner completed");
    identities.set(path, recorded);
  }
  const config = receipt.configIdentity;
  if (config?.path !== receipt.configPath || !Number.isSafeInteger(config.dev) || !Number.isSafeInteger(config.ino))
    reject("native config receipt identity is invalid");
  const recorded = { path: config.path, device: config.dev, inode: config.ino };
  if (required && !isDeepStrictEqual(identity(config.path), recorded))
    reject("native config identity changed after the owner completed");
  identities.set(config.path, recorded);
  return { status: receipt.status, identities };
}

function journalNativePermit(pathname, expected, action) {
  const record = ownedJournal(pathname), root = dirname(dirname(pathname));
  if (!record.nativeUpdate || !isDeepStrictEqual(record, expected))
    reject("native permit requires its unchanged activation journal");
  const namespace = migrationNamespace(root);
  if (pathname !== namespace.pathname || !["revoke", "publish"].includes(action))
    reject("native permit operation is invalid");
  if (action === "revoke") {
    const permit = migrationPermit(root);
    if (permit) { unlinkSync(permit.path); syncPath(namespace.directory); }
    return "FENCED";
  }
  const hasReceipt = Boolean(lstatSync(`${record.nativeUpdate.backupRoot}.receipt.json`, { throwIfNoEntry: false }));
  const receipt = hasReceipt ? nativeUpdateReceipt(record, true) : null;
  const selected = receipt?.status === "migrated" ? record.candidate.sha : record.predecessor.sha;
  const current = join(root, "current"), entry = lstatSync(current);
  if (!entry.isSymbolicLink() || entry.uid !== namespace.owner || entry.gid !== rootGroup() ||
      realpathSync(current) !== join(root, "releases", selected))
    reject("native permit does not select its completed migration or restored predecessor");
  if (!receipt && record.protectedPaths.some(previous => !isDeepStrictEqual(identity(previous.path), previous)))
    reject("native update without a receipt changed protected state");
  migrationPublishPermit(root);
  return "PERMITTED";
}

function journalNativeState(pathname, expected, config, database) {
  const record = ownedJournal(pathname);
  if (!isDeepStrictEqual(record, expected) || config !== record.protectedPaths[0].path || database !== record.protectedPaths[1].path)
    reject("native update journal binding changed");
  const { identities } = nativeUpdateReceipt(record, true);
  record.protectedPaths = record.protectedPaths.map(previous => {
    const current = identities.get(previous.path);
    if (!current) reject("native update omitted a protected path");
    return current;
  });
  validJournal(record);
  atomicJson(pathname, record);
  return record;
}

function originalWitness(pathname, record, expected, archivedSource) {
  if (expected && (Object.hasOwn(record, "originalWitness") !== Object.hasOwn(expected, "originalWitness") ||
      !isDeepStrictEqual(record.originalWitness, expected.originalWitness)))
    reject("original session witness binding changed; activation evidence retained");
  if (record.gatewayRuntime || record.runtimeChange) runtimeJournalCheck(record, dirname(dirname(pathname)), expected);
  if (!Object.hasOwn(record, "originalWitness")) return undefined;
  const namespace = migrationNamespace(dirname(dirname(pathname)));
  if (pathname !== namespace.pathname) reject("original session witness journal path is not canonical");
  const journal = migrationFile(archivedSource?.path ?? pathname, namespace.owner, { mode: 0o600, limit: migrationJournalLimit });
  if ((archivedSource && !isDeepStrictEqual(journal.descriptor, archivedSource)) || !isDeepStrictEqual(migrationJson(journal.bytes), record)) reject("original session witness journal changed before reading");
  const { name, ...descriptor } = record.originalWitness;
  const file = migrationFile(join(namespace.directory, name), namespace.owner, { mode: 0o600 });
  if (!isDeepStrictEqual(file.descriptor, { path: join(namespace.directory, name), ...descriptor }))
    reject("original session witness artifact changed; activation evidence retained");
  sessionWitnessTuples(migrationJson(file.bytes));
  const after = migrationFile(archivedSource?.path ?? pathname, namespace.owner, { mode: 0o600, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(after.descriptor, journal.descriptor)) reject("original session witness journal changed while reading");
  const nativeReceipt = nativeUpdateReceipt(record);
  if (!nativeReceipt) return file.bytes;
  // Native restore can atomically replace the file; the original session IDs remain the witness.
  return Buffer.from(JSON.stringify(sessionWitnessTuples(migrationJson(file.bytes)).map(tuple => {
    const current = nativeReceipt.identities.get(tuple[1]);
    if (!current) reject("native update omitted an original session store");
    return JSON.stringify([tuple[0], tuple[1], current.device, current.inode, ...tuple.slice(4)]);
  })));
}

function retainedCronBaseKey(sessionKey, windowKey) {
  for (const key of [sessionKey, windowKey]) {
    const base = /^(agent:[^:]+:cron:[^:]+):run:[^:]+$/.exec(key)?.[1];
    if (base && [sessionKey, windowKey].every(value => value === key || value === base))
      return base;
  }
}

function sessionEntryReferencesWindow(row, sessionId, cronBaseKey) {
  if (row.current_session_id === sessionId) return true;
  try {
    const entry = JSON.parse(row.entry_json);
    if (
      !entry ||
      Array.isArray(entry) ||
      entry.sessionId !== row.current_session_id ||
      !Number.isFinite(entry.updatedAt) ||
      entry.updatedAt !== row.updated_at ||
      (entry.usageFamilySessionIds !== undefined && !Array.isArray(entry.usageFamilySessionIds)) ||
      (entry.compactionCheckpoints !== undefined && !Array.isArray(entry.compactionCheckpoints))
    )
      return false;
    // General rehoming requires the canonical references.ts closure.
    const references = [
      entry.sessionId,
      entry.previousSessionId,
      ...(entry.usageFamilySessionIds ?? []),
    ];
    for (const checkpoint of entry.compactionCheckpoints ?? [])
      references.push(
        checkpoint.sessionId,
        checkpoint.preCompaction.sessionId,
        checkpoint.postCompaction.sessionId,
      );
    // Cron cleanup transfers the exact run window to its base; forceNew drops old refs,
    // while canonical history retains the window under that same physical owner.
    return references.some((value) => typeof value === "string" && value.trim() === sessionId) ||
      (cronBaseKey !== undefined && row.session_key === cronBaseKey);
  } catch {
    return false;
  }
}

function intentionallyEphemeralInternalSession(agentId, sessionKey, sessionId, windowKey, entryJson) {
  if (windowKey !== sessionKey) return false;
  const match = /^agent:([^:]+):internal-session-effects:([^:]+)$/u.exec(sessionKey);
  if (!match || match[1] !== agentId || !sessionId.startsWith("internal-session-effects-"))
    return false;
  const keySuffix = match[2];
  const sessionSuffix = sessionId.slice("internal-session-effects-".length);
  if (!/^[A-Za-z0-9._-]{1,48}-[a-f0-9]{16}$/u.test(sessionSuffix)) return false;
  const identityMatches = keySuffix === sessionSuffix ||
    keySuffix === `incognito-${sessionSuffix}` ||
    keySuffix === `legacy-${sessionSuffix}`;
  if (!identityMatches) return false;
  try {
    const entry = JSON.parse(entryJson);
    return entry && !Array.isArray(entry) &&
      entry.sessionId === sessionId &&
      entry.createdVia === "internal" &&
      entry.createdActor?.type === "system" &&
      entry.delivery?.kind === "internal";
  } catch {
    return false;
  }
}

function transcriptPreservationFailure(database, sessionKey, sessionId, windowKey, generation) {
  // Required storage shape must remain valid even when historical identity is incomplete.
  const liveStatement = database
    .prepare(`SELECT n.session_key, n.current_session_id, n.entry_json, n.updated_at
    FROM session_windows w
    JOIN transcript_rewrite_watermarks t ON t.session_id = w.session_id
    JOIN session_nodes n ON n.session_key = w.session_key
    WHERE w.session_id = ? AND t.generation = ?`);
  if (!sessionId || !windowKey || !generation)
    return { live: "not-inspected", archive: "not-inspected" };
  const cronBaseKey = retainedCronBaseKey(sessionKey, windowKey);
  const live = liveStatement.get(sessionId, generation);
  if (live && sessionEntryReferencesWindow(live, sessionId, cronBaseKey)) return undefined;
  const rejected = archive => ({
    live: live ? "owner-reference-rejected" : "exact-owner-generation-missing",
    archive,
  });
  const archives = database
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_archives'",
    )
    .get();
  if (!archives) return rejected("table-missing");
  // A pending file export is valid: SQLite owns the exact immutable generation and encoded hash.
  const archive = database
    .prepare(`SELECT archive_blob, archive_sha256, encoding
    FROM session_transcript_archives
    WHERE session_id = ? AND generation = ? AND session_key IN (?, ?)`)
    .get(sessionId, generation, windowKey, cronBaseKey ?? windowKey);
  if (!archive) return rejected("exact-tuple-missing");
  if (!(archive.archive_blob instanceof Uint8Array)) return rejected("invalid-blob");
  if (archive.archive_blob.byteLength === 0) return rejected("empty-blob");
  if (!["identity", "zstd"].includes(archive.encoding)) return rejected("unsupported-encoding");
  if (createHash("sha256").update(archive.archive_blob).digest("hex") !== archive.archive_sha256)
    return rejected("encoded-hash-mismatch");
  return undefined;
}

function sessionPreservationWarnings() {
  const diagnostics = [];
  const reasonCounts = new Map();
  let count = 0;
  return {
    record(tuple, ordinal, failure) {
      count += 1;
      const reason = !tuple[5] ? "missing-session-id" : !tuple[6] ? "missing-window-key" :
        !tuple[7] ? "missing-generation" : `${failure.live}/${failure.archive}`;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      // History may retire during an update. Keep diagnostics bounded and private,
      // while database access, schema and identity failures still abort verification.
      if (diagnostics.length >= 8) return;
      const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const field = value => value === null ? "null" : value ? "present" : "empty";
      diagnostics.push({
        version: 1, ordinal, tupleSha256: digest(tuple), databaseIdentitySha256: digest(tuple.slice(0, 4)),
        captured: { sessionId: field(tuple[5]), windowKey: field(tuple[6]), generation: field(tuple[7]) },
        ...failure,
      });
    },
    finish() {
      if (count) {
        const reasons = Object.fromEntries([...reasonCounts].sort(([left], [right]) => left.localeCompare(right)));
        process.stderr.write(`WARNING HISTORY_PRESERVATION_GAPS count=${count} shown=${diagnostics.length} historical-bytes=unverified continuation=allowed reasonCounts=${JSON.stringify(reasons)}\n`);
        for (const diagnostic of diagnostics)
          process.stderr.write(`HISTORY_PRESERVATION_GAP diagnostic=${JSON.stringify(diagnostic)}\n`);
      }
      return count;
    },
  };
}

function suspensionStatus(response, expectedId, expectedExpiry) {
  suspensionToken(expectedId, "expected suspension identity");
  if (!["ready", "draining"].includes(response?.status)) {
    reject("Gateway suspension is running, conflicting, recovering, or malformed");
  }
  const draining = response.status === "draining";
  if (!suspensionContract.validateGatewaySuspendStatusResult(response))
    reject("Gateway suspension status result is malformed");
  const custody = suspensionWriteCustody(response);
  if (
    !Number.isSafeInteger(response.expiresAtMs) ||
    response.expiresAtMs !== expectedExpiry ||
    response.expiresAtMs <= Date.now() + 5_000
  ) {
    reject("Gateway suspension status lease expired or its identity/expiry changed");
  }
  const blockers = draining
    ? suspensionBlockers(response, "Gateway suspension status result", custody)
    : "none";
  const retryAfterMs = draining ? suspensionRetryDelay(response.retryAfterMs) : 0;
  const terminalBlocked =
    draining &&
    response.blockers.some((blocker) =>
      ["terminal-session", "terminal-persistence"].includes(blocker.kind),
    )
      ? 1
      : 0;
  return `${response.status.toUpperCase()} ${response.expiresAtMs} ${draining ? response.activeCount : 0} ${retryAfterMs} ${terminalBlocked} ${blockers} ${custody}`;
}

function ownedJournalRecord(pathname) {
  const entry = lstatSync(pathname);
  const owner = integer(process.env.OPENCLAW_TEAM_ROOT_UID ?? "0", "journal owner");
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.uid !== owner ||
    entry.gid !== rootGroup() ||
    (entry.mode & 0o077) !== 0
  ) {
    reject("activation journal is not root-owned and private");
  }
  return jsonFile(pathname);
}
function ownedJournal(pathname) {
  const record = validJournal(ownedJournalRecord(pathname));
  runtimeJournalCheck(record, dirname(dirname(pathname)));
  return record;
}

// Retained repair PREPARATION ONLY. This core deliberately owns no lifecycle,
// activation-slot transition, adoption, or release-build command. A capsule is
// not permission to stop/start, select C, retire A/B, or restore any database.
function retainedRepairLock() {
  const pathname = process.env.OPENCLAW_TEAM_LOCK_FILE ?? "/run/openclaw-release-deploy.lock";
  migrationAncestors(
    dirname(pathname),
    migrationOwner(),
    process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/",
  );
  const held = fstatSync(9),
    named = lstatSync(pathname);
  if (
    !held.isFile() ||
    !named.isFile() ||
    named.isSymbolicLink() ||
    held.nlink !== 1 ||
    held.uid !== migrationOwner() ||
    held.gid !== rootGroup() ||
    held.mode & 0o022 ||
    held.dev !== named.dev ||
    held.ino !== named.ino ||
    !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(
      readFileSync("/proc/self/fdinfo/9", "utf8"),
    )
  )
    reject("retained preparation requires the exact existing exclusive deployment lock");
  return { path: pathname, device: held.dev, inode: held.ino };
}

function retainedRepairInput(request, building = false) {
  suspensionObject(
    request,
    ["version", "operation", "source", "target", "process", ...(Object.hasOwn(request, "configSha256") ? ["configSha256"] : [])],
    "retained preparation request",
  );
  if (
    request.version !== 1 ||
    (Object.hasOwn(request, "configSha256") && !/^[a-f0-9]{64}$/.test(request.configSha256)) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.operation)
  )
    reject("retained preparation request version or operation is invalid");
  validMigrationDescriptor(request.source, "path", "retained source journal");
  suspensionObject(
    request.target,
    building ? ["sha"] : ["sha", "manifestSha256"],
    "retained target",
  );
  suspensionObject(request.process, ["pid", "generation"], "retained process");
  if (
    !shaPattern.test(request.target.sha) ||
    (!building && !/^[a-f0-9]{64}$/.test(request.target.manifestSha256))
  )
    reject("retained preparation target is invalid");
  return request;
}

function retainedRepairTranscriptPreservationFailure(database, sessionKey, sessionId, windowKey, generation) {
  // Reset preserves canonical history even after the current entry drops its
  // direct previous-session reference. Rewrites still require the exact token.
  if (sessionId && windowKey && generation && database.prepare(`
    SELECT 1 FROM session_windows w
    JOIN session_nodes n ON n.session_key = w.session_key
    JOIN transcript_rewrite_watermarks t ON t.session_id = w.session_id
    WHERE w.session_id = ? AND w.session_key = ? AND t.generation = ?
  `).get(sessionId, windowKey, generation)) return undefined;
  if (generation !== null || !sessionId || !windowKey)
    return transcriptPreservationFailure(database, sessionKey, sessionId, windowKey, generation);
  // Metadata-only creation has no rewrite token. Retain the original window;
  // a later first append may materialize its real generation.
  const live = database.prepare(`
    SELECT t.generation FROM session_windows w
    JOIN session_nodes n ON n.session_key = ?
    JOIN session_nodes owner ON owner.session_key = w.session_key
    LEFT JOIN transcript_rewrite_watermarks t ON t.session_id = w.session_id
    WHERE w.session_id = ? AND w.session_key = ?
  `).get(sessionKey, sessionId, windowKey);
  if (live?.generation)
    return retainedRepairTranscriptPreservationFailure(database, sessionKey, sessionId, windowKey, live.generation);
  // Absence is valid only while the retained window is provably empty across
  // every canonical transcript tier. Never ignore unwatermarked content.
  if (live?.generation === null && !database.prepare(`
    SELECT 1 FROM transcript_events WHERE session_id = ?
    UNION ALL SELECT 1 FROM session_transcript_cold_archives WHERE session_id = ?
    UNION ALL SELECT 1 FROM session_transcript_cold_archive_chunks WHERE session_id = ?
    UNION ALL SELECT 1 FROM session_transcript_archives WHERE session_id = ? LIMIT 1
  `).get(sessionId, sessionId, sessionId, sessionId)) return undefined;
  return transcriptPreservationFailure(database, sessionKey, sessionId, windowKey, generation);
}

function retainedRepairWitness(record, saved, rewriteEvidence) {
  const schemas = record.candidate.schemaVersions, databasePath = record.protectedPaths[1].path;
  const accepted = rewriteEvidence?.accepted && new Set(rewriteEvidence.accepted);
  const pending = new Map();
  for (const tuple of sessionWitnessTuples(saved ?? [])) {
    const key = JSON.stringify(tuple.slice(0, 4));
    const values = pending.get(key) ?? [];
    values.push(tuple);
    pending.set(key, values);
  }
  const captured = [];
  verifyStateCompatibility(
    databasePath,
    schemas,
    schemas,
    (database, agentId, pathname, entry) => {
      const id = [agentId, realpathSync(pathname), entry.dev, entry.ino],
        key = JSON.stringify(id);
      for (const tuple of pending.get(key) ?? []) {
        if (!retainedRepairTranscriptPreservationFailure(database, ...tuple.slice(4))) continue;
        // Physical identity is already bound by pending's key. Only a selected
        // candidate, or its sealed accepted generation, can explain this rewrite.
        const live = rewriteEvidence && tuple[7] && database.prepare(`
          SELECT t.*, n.current_session_id, owner.current_session_id AS owner_session_id FROM session_windows w
          LEFT JOIN session_nodes n ON n.session_key = ?
          JOIN session_nodes owner ON owner.session_key = w.session_key
          JOIN transcript_rewrite_watermarks t ON t.session_id = w.session_id
          WHERE w.session_id = ? AND w.session_key = ?
        `).get(tuple[4], tuple[5], tuple[6]);
        if (live?.generation && Number.isSafeInteger(live.updated_at) &&
            live.updated_at > Date.parse(record.createdAt) && live.updated_at <= Date.now() &&
            ((rewriteEvidence.selectedCandidate && live.current_session_id === tuple[5] && live.owner_session_id === tuple[5]) ||
              accepted?.has(JSON.stringify([...tuple.slice(0, 7), live.generation])))) continue;
        reject("retained preparation requires strict original and current transcript continuity");
      }
      pending.delete(key);
      for (const row of database
        .prepare(
          "SELECT n.session_key, n.current_session_id, n.entry_json, w.session_key AS window_key, t.generation " +
            "FROM session_nodes n LEFT JOIN session_windows w ON w.session_id=n.current_session_id " +
            "LEFT JOIN transcript_rewrite_watermarks t ON t.session_id=w.session_id",
        )
        .all()) {
        if (
          intentionallyEphemeralInternalSession(
            agentId,
            row.session_key,
            row.current_session_id,
            row.window_key,
            row.entry_json,
          )
        )
          continue;
        if (
          retainedRepairTranscriptPreservationFailure(
            database,
            row.session_key,
            row.current_session_id,
            row.window_key,
            row.generation,
          )
        )
          reject("retained preparation refuses an incomplete current transcript witness");
        captured.push(
          JSON.stringify([
            ...id,
            row.session_key,
            row.current_session_id,
            row.window_key,
            row.generation,
          ]),
        );
      }
    },
    [...pending.values()].map((values) => values[0]),
    undefined,
    (database) => {
      const retired = new Set();
      if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_deletion_journal'").get())
        return retired;
      const deletion = database.prepare(`SELECT operation_id, phase, database_paths_json,
        created_at, cleanup_completed, delete_files FROM agent_deletion_journal WHERE agent_id = ?`);
      for (const [key, tuples] of pending) {
        const [agentId, pathname, device, inode] = tuples[0], row = deletion.get(agentId);
        // Completion is the native purge owner's receipt. Pending intent, an old
        // incarnation, or a path not owned by that deletion cannot explain loss.
        if (!row?.operation_id || row.cleanup_completed !== 1 || ![0, 1].includes(row.delete_files) ||
            (row.phase !== null && row.phase !== "retiring") ||
            !(row.created_at >= Date.parse(record.createdAt) && row.created_at <= Date.now())) continue;
        const paths = JSON.parse(row.database_paths_json);
        if (!Array.isArray(paths) || !paths.includes(pathname)) continue;
        const entry = lstatSync(pathname, { throwIfNoEntry: false });
        if (entry ? !entry.isFile() || entry.dev !== device || entry.ino !== inode
          : row.delete_files !== 1) continue;
        retired.add(pathname);
        pending.delete(key);
      }
      return retired;
    },
  );
  if (pending.size) reject("retained preparation lost a witnessed physical database");
  if (Buffer.byteLength(JSON.stringify(captured) + "\n") > migrationJsonLimit)
    reject("retained transcript witness exceeds its bounded evidence budget");
  return captured.sort();
}

function retainedRepairClosure() {
  const library = fileURLToPath(import.meta.url),
    directory = dirname(library);
  const executable =
    process.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE ?? "/usr/local/sbin/openclaw-release-deploy";
  const paths = [
    executable,
    library,
    join(directory, "gateway-suspension-contract.mjs"),
    join(directory, "startup-profile.mjs"),
  ];
  return paths.map((pathname, index) => {
    migrationAncestors(
      dirname(pathname),
      migrationOwner(),
      process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/",
    );
    return migrationFile(pathname, migrationOwner(), {
      privateOnly: false,
      mode: index ? 0o644 : 0o755,
    }).descriptor;
  });
}

function retainedRepairSnapshot(root, rawRequest, expected, building = false, archivedSource) {
  const request = retainedRepairInput(rawRequest, building),
    namespace = migrationNamespace(root);
  const lock = retainedRepairLock();
  if (request.source.path !== namespace.pathname)
    reject("retained preparation journal path is not canonical");
  const source = migrationFile(archivedSource?.path ?? namespace.pathname, namespace.owner, {
    mode: 0o600,
    limit: migrationJournalLimit,
  });
  if (
    archivedSource
      ? !isDeepStrictEqual(source.descriptor, archivedSource) ||
        source.descriptor.sha256 !== request.source.sha256
      : !isDeepStrictEqual(source.descriptor, request.source)
  )
    reject("retained preparation source journal changed");
  const record = validJournal(migrationJson(source.bytes));
  // Property presence, not truthiness: null cannot disguise a different recovery owner.
  const allowed = [
    "version",
    "phase",
    "topology",
    "predecessor",
    "candidate",
    "process",
    "pointerTopology",
    "services",
    "suspension",
    "protectedPaths",
    "originalWitness",
    "gatewayRuntime",
    "createdAt",
  ];
  if (
    record.phase !== "ROLLBACK_FAILED" ||
    record.topology !== "system" ||
    !record.originalWitness ||
    record.predecessor.sha === record.candidate.sha ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    (record.createdAt !== undefined &&
      (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)))) ||
    !isDeepStrictEqual(record.predecessor.schemaVersions, record.candidate.schemaVersions)
  )
    reject(
      "retained preparation requires the exact non-native same-schema failed system activation",
    );
  const retainedSource = archivedSource
    ? { file: archivedSource, record, identity: (({ sha256, ...value }) => value)(request.source) }
    : undefined;
  const current = selectedConfigProcess(root, record, request.process);
  const proc = process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc";
  const evidence = recoveryEvidence(
    namespace.pathname,
    root,
    undefined,
    "selected",
    request.configSha256 === undefined ? undefined : {
      config: { path: record.protectedPaths[0].path, sha256: request.configSha256 },
      journalSha256: request.source.sha256, databasePath: record.protectedPaths[1].path,
      runtimeUid: statSync(join(proc, String(current.pid))).uid, process: current,
    },
    retainedSource,
  );
  const boot = readFileSync(join(proc, "sys/kernel/random/boot_id"), "utf8").trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot))
    reject("retained preparation boot identity is invalid");
  const processIdentity = {
    ...current,
    boot,
    executable: realpathSync(join(proc, String(current.pid), "exe")),
  };
  if (request.target.sha === record.predecessor.sha || request.target.sha === record.candidate.sha)
    reject("retained preparation requires one distinct repair target");
  const target = building
    ? { sha: request.target.sha }
    : validateFrozenRelease(
        join(root, "releases", request.target.sha),
        request.target.sha,
        request.target.manifestSha256,
        namespace.owner,
      );
  if (
    !building &&
    !isDeepStrictEqual(target.release.schemaVersions, record.candidate.schemaVersions)
  )
    reject("retained preparation forbids a target schema change");
  const original = originalWitness(namespace.pathname, record, undefined, archivedSource);
  const { name, ...originalDescriptor } = record.originalWitness;
  const witnessPath = join(namespace.directory, name);
  const originalWitnessDescriptor = { path: witnessPath, ...originalDescriptor };
  const currentWitness = retainedRepairWitness(record, migrationJson(original), { selectedCandidate: current });
  // A retry verifies the captured floor, not equality with an empty/new baseline.
  if (expected)
    retainedRepairWitness(record, expected.currentWitness);
  const configPath = record.protectedPaths[0].path,
    configOwner = lstatSync(configPath);
  const config = migrationFile(configPath, configOwner.uid, {
    mode: 0o600,
    group: configOwner.gid,
  }).descriptor;
  const snapshot = {
    version: 2,
    kind: building ? "retained-repair-build" : "retained-repair-preparation",
    phase: building ? "BUILD_PREPARED" : "PREPARED",
    request,
    evidence,
    originalWitness: originalWitnessDescriptor,
    currentWitness: expected?.currentWitness ?? currentWitness,
    process: processIdentity,
    lock,
    config,
    policy: policy(configPath),
    profile: operatorProfile(),
    runtime: runtimeCurrent(root, false),
    closure: retainedRepairClosure(),
    ...(retainedRepairAdoptionSnapshot(root) ? { adoption:retainedRepairAdoptionSnapshot(root) } : {}),
    target,
  };
  // Whole-input binding is private evidence, never an authorization certificate.
  retainedSnapshotBudget(snapshot);
  if (expected && !isDeepStrictEqual(snapshot, expected))
    reject("retained preparation binding changed");
  selectedConfigProcess(root, record, request.process);
  if (
    !isDeepStrictEqual(
      migrationFile(archivedSource?.path ?? namespace.pathname, namespace.owner, {
        mode: 0o600,
        limit: migrationJournalLimit,
      }).descriptor,
      source.descriptor,
    ) ||
    !isDeepStrictEqual(
      migrationFile(witnessPath, namespace.owner, { mode: 0o600 }).descriptor,
      originalWitnessDescriptor,
    ) ||
    !isDeepStrictEqual(retainedRepairLock(), lock)
  )
    reject("retained preparation changed during observation");
  return { snapshot, source: source.bytes };
}

function retainedRepairFile(pathname, bytes) {
  retainedRepairLock();
  const limit = retainedArtifactLimit(pathname);
  if (bytes.length > limit)
    reject("retained preparation artifact exceeds its durable publication budget");
  settleFixedPublications(
    [
      {
        path: pathname,
        mode: 0o600,
        limit,
        validate(current) {
          if (!current.equals(bytes))
            reject("retained preparation interrupted publication has different evidence");
        },
      },
    ],
    migrationOwner(),
    process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/",
  );
  const current = lstatSync(pathname, { throwIfNoEntry: false });
  if (!current) migrationWriteExclusive(pathname, bytes, 0o600);
  const file = migrationFile(pathname, migrationOwner(), { mode: 0o600, limit });
  if (!file.bytes.equals(bytes))
    reject("retained preparation artifact already has different evidence");
  // A crash after link but before directory fsync resumes the same immutable bytes.
  syncPath(pathname);
  syncPath(dirname(pathname));
  return file.descriptor;
}

function retainedRepairPreparation(action, root, input) {
  if (action === "snapshot") return retainedRepairSnapshot(root, input).snapshot;
  if (!["seal", "check"].includes(action))
    reject("retained preparation does not implement activation or recovery");
  suspensionObject(
    input,
    [
      "version",
      "kind",
      "phase",
      "request",
      "evidence",
      "originalWitness",
      "currentWitness",
      "process",
      "lock",
      "config",
      "policy",
      "profile",
      "runtime",
      "closure",
      "target",
      ...(Object.hasOwn(input, "adoption") ? ["adoption"] : []),
    ],
    "retained preparation snapshot",
  );
  if (
    input.version !== 2 ||
    input.kind !== "retained-repair-preparation" ||
    input.phase !== "PREPARED"
  )
    reject("retained preparation snapshot version or phase is invalid");
  retainedRepairInput(input.request);
  const namespace = migrationNamespace(root),
    prefix = join(namespace.directory, `repair-${input.request.operation}`);
  const intentPath = `${prefix}.intent.json`,
    originalPath = `${prefix}.original.json`,
    witnessPath = `${prefix}.current-witness.json`,
    capsulePath = `${prefix}.prepared.json`;
  const intentBytes = Buffer.from(JSON.stringify(input) + "\n");
  retainedSnapshotBudget(input);
  // Revalidate before settling even an interrupted publication alias.
  retainedRepairSnapshot(root, input.request, input);
  const existing = lstatSync(intentPath, { throwIfNoEntry: false });
  if (existing) {
    if (action === "seal") retainedRepairFile(intentPath, intentBytes);
    if (!migrationFile(intentPath, namespace.owner, { mode: 0o600, limit: retainedSnapshotLimit }).bytes.equals(intentBytes))
      reject("retained preparation operation is already bound to different evidence");
  } else {
    if (action !== "seal") reject("retained preparation has no durable intent");
    // Never let caller-edited input delete B-era history from the first floor.
    const fresh = retainedRepairSnapshot(root, input.request);
    if (!isDeepStrictEqual(fresh.snapshot, input))
      reject("retained preparation requires a fresh complete witness before intent");
    retainedRepairFile(intentPath, intentBytes);
  }
  const observed = retainedRepairSnapshot(root, input.request, input);
  const originalBytes = observed.source,
    witnessBytes = Buffer.from(JSON.stringify(input.currentWitness) + "\n");
  if (action === "seal") {
    retainedRepairFile(originalPath, originalBytes);
    retainedRepairSnapshot(root, input.request, input);
    retainedRepairFile(witnessPath, witnessBytes);
    retainedRepairSnapshot(root, input.request, input);
  }
  const original = migrationFile(originalPath, namespace.owner, {
    mode: 0o600,
    limit: migrationJournalLimit,
  });
  const witness = migrationFile(witnessPath, namespace.owner, { mode: 0o600 });
  if (!original.bytes.equals(originalBytes) || !witness.bytes.equals(witnessBytes))
    reject("retained preparation archived evidence changed");
  const intent = migrationFile(intentPath, namespace.owner, { mode: 0o600, limit: retainedSnapshotLimit });
  if (!intent.bytes.equals(intentBytes)) reject("retained preparation intent changed");
  const capsule = {
    ...input,
    archives: {
      intent: intent.descriptor,
      original: original.descriptor,
      currentWitness: witness.descriptor,
    },
  };
  const bytes = Buffer.from(JSON.stringify(capsule) + "\n");
  if (action === "seal") retainedRepairFile(capsulePath, bytes);
  const sealed = migrationFile(capsulePath, namespace.owner, { mode: 0o600, limit: retainedSnapshotLimit });
  if (!sealed.bytes.equals(bytes)) reject("retained preparation capsule changed");
  // PREPARED is a durability promise even for a direct check after failed seal.
  // All artifacts already exist and match; never create evidence on this path.
  if (action === "check") {
    for (const pathname of [intentPath, originalPath, witnessPath, capsulePath]) syncPath(pathname);
    syncPath(namespace.directory);
  }
  retainedRepairSnapshot(root, input.request, input);
  // The canonical legacy journal is intentionally NEVER written or retired here.
  return { phase: "PREPARED", capsule: sealed.descriptor, archives: capsule.archives };
}

function auditBuild(
  base,
  rawRootUid,
  rawDeployUid,
  rawDeployGid,
  runtimeHome,
  rawFileOwner = rawDeployUid,
) {
  const rootUid = integer(rawRootUid, "build root owner");
  const deployUid = integer(rawDeployUid, "build account");
  const deployGid = integer(rawDeployGid, "build account group");
  const fileOwner = integer(rawFileOwner, "build directory owner");
  const baseEntry = lstatSync(base);
  if (
    !baseEntry.isDirectory() ||
    baseEntry.isSymbolicLink() ||
    baseEntry.uid !== rootUid ||
    baseEntry.gid !== deployGid ||
    (baseEntry.mode & 0o777) !== 0o750
  ) {
    reject("isolated build root is not root-owned and deploy-group-private");
  }
  if (deployUid === rootUid) reject("build account cannot be root");
  const runtimeRelative = relative(resolve(runtimeHome), realpathSync(base));
  if (runtimeRelative === "" || (!runtimeRelative.startsWith("../") && runtimeRelative !== "..")) {
    reject("isolated build root is inside the runtime account home");
  }
  for (const name of ["home", "cache", "config", "pnpm", "work", "mirror"]) {
    const entry = lstatSync(join(base, name));
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.uid !== fileOwner ||
      entry.gid !== deployGid ||
      (entry.mode & 0o777) !== 0o700
    ) {
      reject(`isolated build account directory is unsafe: ${name}`);
    }
  }
  const mirror = lstatSync(join(base, "mirror", "mirror.git"));
  if (!mirror.isDirectory() || mirror.isSymbolicLink() || mirror.uid !== fileOwner) {
    reject("isolated official mirror is not owned by the build account");
  }
  return "BUILD_OWNER_SAFE";
}

// Build and metadata transition owners grant no Gateway lifecycle authority.
function retainedRepairPaths(root, operation) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operation))
    reject("retained repair operation is invalid");
  const namespace = migrationNamespace(root);
  return { ...namespace, prefix: join(namespace.directory, `repair-${operation}`) };
}
function retainedRepairRead(pathname, validate = () => {}) {
  const limit = retainedArtifactLimit(pathname);
  settleFixedPublications(
    [{ path: pathname, mode: 0o600, validate, limit }],
    migrationOwner(),
    process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/",
  );
  const file = migrationFile(pathname, migrationOwner(), {
    mode: 0o600,
    limit,
  });
  validate(file.bytes);
  // Reads that promise a completed phase must finish an interrupted publication,
  // including the final nlink=1 but not-yet-durable directory entry.
  syncPath(pathname);
  syncPath(dirname(pathname));
  const checked = migrationFile(pathname, migrationOwner(), {
    mode: 0o600,
    limit,
  });
  if (!isDeepStrictEqual(checked.descriptor, file.descriptor))
    reject("retained repair artifact changed during durability verification");
  return checked;
}
function retainedRepairBoundFile(descriptor) {
  validMigrationDescriptor(descriptor, "path", "retained repair artifact");
  const file = retainedRepairRead(descriptor.path);
  if (!isDeepStrictEqual(file.descriptor, descriptor)) reject("retained repair artifact changed");
  return file;
}
function retainedRepairBuildSnapshot(root, operation, archivedSource) {
  const paths = retainedRepairPaths(root, operation),
    pathname = `${paths.prefix}.build-intent.json`;
  const file = retainedRepairRead(pathname, (bytes) => {
    const value = migrationJson(bytes);
    if (
      value.kind !== "retained-repair-build" ||
      value.phase !== "BUILD_PREPARED" ||
      value.request?.operation !== operation
    )
      reject("retained build intent is invalid");
    retainedRepairSnapshot(root, value.request, value, true, archivedSource);
  });
  return { paths, file, snapshot: migrationJson(file.bytes) };
}
function retainedRepairGit(snapshot, captured) {
  const home = process.env.OPENCLAW_TEAM_BUILD_HOME ?? "/var/lib/openclaw-team-deploy";
  const mirror = join(home, "mirror/mirror.git");
  const accountId = (flag) => {
    const result = spawnSync("/usr/bin/id", [flag, "openclaw-deploy"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0) reject("retained repair build account is unavailable");
    return result.stdout.trim();
  };
  const deployUid = integer(
    process.env.OPENCLAW_TEAM_DEPLOY_UID ?? accountId("-u"),
    "build account",
  );
  const deployGid = integer(
    process.env.OPENCLAW_TEAM_DEPLOY_GID ?? accountId("-g"),
    "build account group",
  );
  const fileUid = integer(
    process.env.OPENCLAW_TEAM_DEPLOY_FILE_UID ?? String(deployUid),
    "build directory owner",
  );
  auditBuild(
    home,
    migrationOwner(),
    deployUid,
    deployGid,
    process.env.OPENCLAW_TEAM_RUNTIME_HOME ?? "/home/openclaw",
    fileUid,
  );
  const mirrorStat = lstatSync(mirror);
  const mirrorIdentity = { path: mirror, device: mirrorStat.dev, inode: mirrorStat.ino };
  const invoke = (...args) => {
    const result = spawnSync(
      process.env.OPENCLAW_TEAM_RUNUSER ?? "/usr/sbin/runuser",
      [
        "-u",
        "openclaw-deploy",
        "--",
        "env",
        "-i",
        `HOME=${join(home, "home")}`,
        "PATH=/usr/bin:/bin",
        "GIT_CONFIG_NOSYSTEM=1",
        "GIT_CONFIG_GLOBAL=/dev/null",
        "GIT_NO_REPLACE_OBJECTS=1",
        "GIT_GRAFT_FILE=/dev/null",
        "GIT_TERMINAL_PROMPT=0",
        "git",
        "-C",
        mirror,
        ...args,
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 },
    );
    if (result.status !== 0) reject("retained repair official ancestry observation failed");
    return result.stdout.trim();
  };
  const origin = invoke("remote", "get-url", "origin");
  if (origin !== "https://github.com/openclaw/openclaw.git")
    reject("retained repair mirror origin is not official");
  const currentMain = invoke("rev-parse", "--verify", "refs/remotes/origin/main^{commit}");
  const target = snapshot.request.target.sha,
    predecessor = snapshot.evidence.record.candidate.sha;
  if (!shaPattern.test(currentMain) || (!captured && currentMain !== target))
    reject("retained repair target is not the exact freshly frozen official main");
  invoke("merge-base", "--is-ancestor", predecessor, target);
  invoke("merge-base", "--is-ancestor", target, currentMain);
  const value = {
    version: 1,
    origin,
    mirror: mirrorIdentity,
    frozenMain: target,
    predecessor,
    target,
  };
  if (
    lstatSync(mirror).dev !== mirrorIdentity.device ||
    lstatSync(mirror).ino !== mirrorIdentity.inode ||
    invoke("remote", "get-url", "origin") !== origin ||
    invoke("rev-parse", "--verify", "refs/remotes/origin/main^{commit}") !== currentMain ||
    (captured && !isDeepStrictEqual(value, captured))
  )
    reject("retained repair official mirror changed during observation");
  return value;
}
function retainedRepairBuild(action, root, input) {
  retainedRepairLock();
  if (action === "request") {
    suspensionObject(
      input,
      ["operation", "target", "current", "pid", "generation", "journalSha256", ...(Object.hasOwn(input, "configSha256") ? ["configSha256"] : [])],
      "retained build binding",
    );
    const paths = retainedRepairPaths(root, input.operation);
    const source = migrationFile(paths.pathname, paths.owner, {
      mode: 0o600,
      limit: migrationJournalLimit,
    });
    if (
      source.descriptor.sha256 !== input.journalSha256 ||
      migrationJson(source.bytes).candidate?.sha !== input.current
    )
      reject("retained build incident binding changed");
    return retainedRepairInput(
      {
        version: 1,
        operation: input.operation,
        source: source.descriptor,
        target: { sha: input.target },
        process: { pid: input.pid, generation: input.generation },
        ...(Object.hasOwn(input, "configSha256") ? { configSha256: input.configSha256 } : {}),
      },
      true,
    );
  }
  if (action === "begin") {
    retainedRepairInput(input, true);
    const paths = retainedRepairPaths(root, input.operation),
      pathname = `${paths.prefix}.build-intent.json`;
    let snapshot;
    if (lstatSync(pathname, { throwIfNoEntry: false })) {
      snapshot = retainedRepairBuildSnapshot(root, input.operation).snapshot;
      if (!isDeepStrictEqual(snapshot.request, input))
        reject("retained build operation has different input");
    } else snapshot = retainedRepairSnapshot(root, input, undefined, true).snapshot;
    const bytes = Buffer.from(JSON.stringify(snapshot) + "\n");
    const intent = retainedRepairFile(pathname, bytes);
    const checked = retainedRepairSnapshot(root, input, snapshot, true);
    retainedRepairFile(`${paths.prefix}.build-original.json`, checked.source);
    retainedRepairFile(
      `${paths.prefix}.build-witness.json`,
      Buffer.from(JSON.stringify(snapshot.currentWitness) + "\n"),
    );
    retainedRepairSnapshot(root, input, snapshot, true);
    return { phase: "BUILD_PREPARED", intent };
  }
  if (!["check", "origin", "finish"].includes(action)) reject("unknown retained build operation");
  suspensionObject(input, ["operation"], "retained build operation");
  const { paths, file, snapshot } = retainedRepairBuildSnapshot(root, input.operation);
  const original = retainedRepairRead(`${paths.prefix}.build-original.json`, (bytes) => {
    if (createHash("sha256").update(bytes).digest("hex") !== snapshot.request.source.sha256)
      reject("retained build source archive changed");
  });
  const witness = retainedRepairRead(`${paths.prefix}.build-witness.json`, (bytes) => {
    if (!isDeepStrictEqual(migrationJson(bytes), snapshot.currentWitness))
      reject("retained build floor changed");
  });
  if (action === "check") return { phase: "BUILD_PREPARED", intent: file.descriptor };
  const originPath = `${paths.prefix}.origin.json`;
  let origin;
  if (lstatSync(originPath, { throwIfNoEntry: false })) {
    origin = migrationJson(
      retainedRepairRead(originPath, (bytes) => retainedRepairGit(snapshot, migrationJson(bytes)))
        .bytes,
    );
  } else {
    if (action !== "origin") reject("retained build has no official origin observation");
    origin = retainedRepairGit(snapshot);
  }
  retainedRepairFile(originPath, Buffer.from(JSON.stringify(origin) + "\n"));
  retainedRepairSnapshot(root, snapshot.request, snapshot, true);
  if (action === "origin") return { phase: "ORIGIN_FROZEN", origin };
  const targetPath = join(root, "releases", origin.target);
  const manifest = migrationFile(join(targetPath, "deployment.json"), paths.owner, {
    privateOnly: false,
    mode: 0o444,
  });
  const request = {
    ...snapshot.request,
    target: { sha: origin.target, manifestSha256: manifest.descriptor.sha256 },
  };
  const existing = `${paths.prefix}.intent.json`;
  const prepared = lstatSync(existing, { throwIfNoEntry: false })
    ? migrationJson(
        retainedRepairRead(existing, (bytes) =>
          retainedRepairSnapshot(root, request, migrationJson(bytes)),
        ).bytes,
      )
    : retainedRepairSnapshot(root, request).snapshot;
  const capsule = retainedRepairPreparation("seal", root, prepared);
  retainedRepairSnapshot(root, snapshot.request, snapshot, true);
  retainedRepairGit(snapshot, origin);
  const receipt = {
    version: 1,
    kind: "retained-repair-build-completed",
    phase: "BUILD_COMPLETED",
    operation: input.operation,
    intent: file.descriptor,
    original: original.descriptor,
    witness: witness.descriptor,
    origin: retainedRepairRead(originPath).descriptor,
    preparation: capsule.capsule,
  };
  const completed = retainedRepairFile(
    `${paths.prefix}.build-completed.json`,
    Buffer.from(JSON.stringify(receipt) + "\n"),
  );
  return { phase: receipt.phase, completed, preparation: capsule.capsule };
}
function retainedRepairCompleted(root, descriptor, activeRecord) {
  const receiptFile = retainedRepairBoundFile(descriptor),
    receipt = migrationJson(receiptFile.bytes);
  suspensionObject(
    receipt,
    [
      "version",
      "kind",
      "phase",
      "operation",
      "intent",
      "original",
      "witness",
      "origin",
      "preparation",
    ],
    "retained build receipt",
  );
  const paths = retainedRepairPaths(root, receipt.operation);
  if (
    receipt.version !== 1 ||
    receipt.kind !== "retained-repair-build-completed" ||
    receipt.phase !== "BUILD_COMPLETED" ||
    descriptor.path !== `${paths.prefix}.build-completed.json` ||
    receipt.intent.path !== `${paths.prefix}.build-intent.json` ||
    receipt.original.path !== `${paths.prefix}.build-original.json` ||
    receipt.witness.path !== `${paths.prefix}.build-witness.json` ||
    receipt.origin.path !== `${paths.prefix}.origin.json` ||
    receipt.preparation.path !== `${paths.prefix}.prepared.json`
  )
    reject("retained build receipt namespace is invalid");
  const original = retainedRepairBoundFile(receipt.original);
  const build = migrationJson(retainedRepairBoundFile(receipt.intent).bytes);
  if (
    build.request?.operation !== receipt.operation ||
    original.descriptor.sha256 !== build.request.source.sha256 ||
    !isDeepStrictEqual(
      migrationJson(retainedRepairBoundFile(receipt.witness).bytes),
      build.currentWitness,
    )
  )
    reject("retained build source binding changed");
  const capsule = migrationJson(retainedRepairBoundFile(receipt.preparation).bytes);
  const { archives, ...snapshot } = capsule;
  if (
    snapshot.request?.operation !== receipt.operation ||
    snapshot.request.target.sha !== build.request.target.sha ||
    !isDeepStrictEqual(snapshot.request.source, build.request.source) ||
    !isDeepStrictEqual(snapshot.request.process, build.request.process)
  )
    reject("retained build capsule belongs to another operation");
  for (const [name, expectedPath] of [
    ["intent", `${paths.prefix}.intent.json`],
    ["original", `${paths.prefix}.original.json`],
    ["currentWitness", `${paths.prefix}.current-witness.json`],
  ]) {
    if (archives?.[name]?.path !== expectedPath)
      reject("retained preparation archive namespace changed");
    retainedRepairBoundFile(archives[name]);
  }
  if (
    !retainedRepairBoundFile(archives.original).bytes.equals(original.bytes) ||
    !isDeepStrictEqual(migrationJson(retainedRepairBoundFile(archives.intent).bytes), snapshot) ||
    !isDeepStrictEqual(
      migrationJson(retainedRepairBoundFile(archives.currentWitness).bytes),
      snapshot.currentWitness,
    )
  )
    reject("retained preparation archive contents changed");
  if (activeRecord?.lifecycle) {
    retainedRepairStatic(root, snapshot, build, activeRecord);
  } else {
    retainedRepairSnapshot(root, build.request, build, true, receipt.original);
    retainedRepairSnapshot(root, snapshot.request, snapshot, false, receipt.original);
  }
  retainedRepairGit(build, migrationJson(retainedRepairBoundFile(receipt.origin).bytes));
  return { paths, receipt, snapshot, descriptor: receiptFile.descriptor };
}
// One canonical journal; each state adds one immutable, typed owner receipt.
const retainedRepairPhases = [
  "REPAIR_PREPARED", "REPAIR_EVIDENCE_VERIFIED", "REPAIR_BOUND",
  "REPAIR_SUSPENDED", "REPAIR_STOP_INTENT", "REPAIR_STOPPED",
  "REPAIR_SELECT_INTENT", "REPAIR_SELECTED", "REPAIR_START_INTENT",
  "REPAIR_STARTED", "REPAIR_VERIFIED", "REPAIR_COMPLETED",
];
const retainedRepairEvents = [
  "bound", "suspension", "stopIntent", "stopped", "selectIntent",
  "selected", "startIntent", "started", "verified", "completed",
];
function validRetainedRepairJournal(value) {
  const fields = ["version", "kind", "phase", "operation", "sequence", "build", "floor"];
  if (value?.sequence >= 2 || value?.phase === "REPAIR_FAILED") fields.push("lifecycle");
  suspensionObject(value, fields, "retained repair journal");
  if (value.version !== 2 || value.kind !== "retained-repair" ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      (value.phase === "REPAIR_FAILED" ? value.sequence < 1 : retainedRepairPhases[value.sequence] !== value.phase))
    reject("retained repair journal phase or sequence is invalid");
  validMigrationDescriptor(value.build, "path", "retained repair build");
  validMigrationDescriptor(value.floor, "path", "retained repair floor");
  if (value.lifecycle) {
    const failed = value.phase === "REPAIR_FAILED";
    const eventCount = failed ? Math.max(0, value.sequence - 2) : value.sequence - 1;
    if (eventCount < 0 || eventCount > retainedRepairEvents.length) reject("invalid repair event count");
    const keys = retainedRepairEvents.slice(0, eventCount);
    if (failed) keys.push("failed");
    suspensionObject(value.lifecycle, keys, "retained repair lifecycle");
    for (const key of keys) {
      if (!value.lifecycle[key] || typeof value.lifecycle[key] !== "object" || Array.isArray(value.lifecycle[key]))
        reject("retained repair event must be an owner receipt");
    }
  }
  return value;
}
function retainedRepairStatic(root, snapshot, build, record) {
  const legacy = snapshot.evidence.record;
  const owner = migrationOwner();
  if (!isDeepStrictEqual(retainedRepairLock(), snapshot.lock)) reject("repair lock identity changed");
  // The prepared config descriptor below owns its bytes and replacement inode.
  for (const descriptor of legacy.protectedPaths.slice(1))
    if (!isDeepStrictEqual(identity(descriptor.path), descriptor)) reject("repair protected inode changed");
  const configEntry = lstatSync(snapshot.config.path);
  if (!isDeepStrictEqual(migrationFile(snapshot.config.path, configEntry.uid,
      { mode: 0o600, group: configEntry.gid }).descriptor, snapshot.config) ||
      !isDeepStrictEqual(policy(snapshot.config.path), snapshot.policy) ||
      !isDeepStrictEqual(operatorProfile(), snapshot.profile) ||
      !isDeepStrictEqual(runtimeCurrent(root, false), snapshot.runtime) ||
      !isDeepStrictEqual(retainedRepairClosure(), snapshot.closure) ||
      !isDeepStrictEqual(retainedRepairAdoptionSnapshot(root), snapshot.adoption))
    reject("repair configuration, policy, profile, runtime or controller closure changed");
  for (const release of [legacy.predecessor, legacy.candidate])
    if (!isDeepStrictEqual(validateRelease(join(root, "releases", release.sha), release.sha, owner, true), release))
      reject("repair retained release identity changed");
  if (!isDeepStrictEqual(validateFrozenRelease(join(root, "releases", snapshot.request.target.sha),
      snapshot.request.target.sha, snapshot.request.target.manifestSha256, owner), snapshot.target))
    reject("repair frozen target changed");
  retainedRepairWitness(legacy, migrationJson(retainedRepairBoundFile(snapshot.originalWitness).bytes),
    { accepted: build.currentWitness });
  for (const floor of [build.currentWitness, snapshot.currentWitness])
    retainedRepairWitness(legacy, floor);
  if (record.lifecycle?.stopped) {
    const stopped = record.lifecycle.stopped;
    const floor = migrationJson(retainedRepairBoundFile(stopped.floor).bytes);
    retainedRepairWitness(legacy, floor);
  }
}
function retainedRepairTransactionEvidence(context, record) {
  const { paths, snapshot } = context;
  if (record.operation !== context.receipt.operation ||
      record.floor.path !== `${paths.prefix}.transaction-floor.json`)
    reject("retained repair journal operation changed");
  const floor = migrationJson(retainedRepairBoundFile(record.floor).bytes), legacy = snapshot.evidence.record;
  retainedRepairWitness(legacy, floor);
  for (const [name, value] of Object.entries(record.lifecycle ?? {})) {
    const saved = migrationJson(retainedRepairRead(`${paths.prefix}.lifecycle-${name}.json`).bytes);
    if (!isDeepStrictEqual(saved, value)) reject("repair lifecycle receipt differs from canonical state");
  }
  let previous;
  for (let sequence = 0; sequence <= record.sequence; sequence++) {
    const transition = migrationJson(retainedRepairRead(`${paths.prefix}.transition-${sequence}.json`).bytes);
    suspensionObject(transition, ["version", "expected", "next"], "retained repair transition");
    validMigrationDescriptor(transition.expected, "path", "retained transition source");
    if (transition.version !== 1 || transition.expected.path !== paths.pathname ||
        transition.next.sequence !== sequence) reject("retained repair transition chain is invalid");
    if (sequence === 0) {
      if (!isDeepStrictEqual(transition.expected, snapshot.request.source))
        reject("retained repair original transition changed");
    } else {
      const next = validRetainedRepairJournal(transition.next);
      const failure = next.phase === "REPAIR_FAILED";
      const key = failure ? "failed" : retainedRepairEvents[sequence - 2];
      const expectedNext = { ...previous, phase: next.phase, sequence };
      if (sequence >= 2 || failure) expectedNext.lifecycle = { ...previous.lifecycle, [key]: next.lifecycle?.[key] };
      if (previous.phase === "REPAIR_FAILED" || previous.phase === "REPAIR_COMPLETED" ||
          !isDeepStrictEqual(next, expectedNext) ||
          transition.expected.sha256 !== createHash("sha256").update(JSON.stringify(previous) + "\n").digest("hex"))
        reject("retained repair phase chain changed");
    }
    previous = validRetainedRepairJournal(transition.next);
  }
  if (!isDeepStrictEqual(previous, record)) reject("retained repair active slot differs from durable transition");
}
function retainedRepairTransaction(action, root, input) {
  const lock = retainedRepairLock();
  if (action === "begin") {
    const context = retainedRepairCompleted(root, input),
      { paths, receipt, snapshot } = context;
    const source = migrationFile(paths.pathname, paths.owner, {
      mode: 0o600,
      limit: migrationJournalLimit,
    });
    const canonical = migrationJson(source.bytes),
      transitionPath = `${paths.prefix}.transition-0.json`;
    if (canonical.kind === "retained-repair") {
      const record = validRetainedRepairJournal(canonical);
      if (
        !isDeepStrictEqual(record.build, input) ||
        record.operation !== receipt.operation ||
        record.sequence !== 0
      )
        reject("retained repair begin refuses another transaction or phase");
      const transition = migrationJson(retainedRepairRead(transitionPath).bytes);
      if (
        !isDeepStrictEqual(transition.next, record) ||
        !isDeepStrictEqual(transition.expected, snapshot.request.source)
      )
        reject("retained repair transition receipt changed");
      retainedRepairTransactionEvidence(context, record);
      syncPath(paths.pathname);
      syncPath(paths.directory);
      return { record, journal: source.descriptor };
    }
    if (!isDeepStrictEqual(source.descriptor, snapshot.request.source))
      reject("retained repair source slot changed before transition");
    retainedRepairSnapshot(root, snapshot.request, snapshot);
    const floorPath = `${paths.prefix}.transaction-floor.json`;
    const floor = lstatSync(floorPath, { throwIfNoEntry: false })
      ? migrationJson(
          retainedRepairRead(floorPath, (bytes) => {
            retainedRepairWitness(canonical, migrationJson(bytes));
          }).bytes,
        )
      : retainedRepairWitness(canonical, snapshot.currentWitness);
    const floorDescriptor = retainedRepairFile(
      `${paths.prefix}.transaction-floor.json`,
      Buffer.from(JSON.stringify(floor) + "\n"),
    );
    const next = validRetainedRepairJournal({
      version: 2,
      kind: "retained-repair",
      phase: "REPAIR_PREPARED",
      operation: receipt.operation,
      sequence: 0,
      build: input,
      floor: floorDescriptor,
    });
    return retainedRepairTransition(root, paths, source.descriptor, next, lock);
  }
  if (!["check", "verify", "resume"].includes(action))
    reject("retained repair transaction does not own lifecycle actions");
  validMigrationDescriptor(input, "path", "expected retained repair journal");
  const namespace = migrationNamespace(root);
  if (input.path !== namespace.pathname) reject("retained repair journal path is not canonical");
  const file = migrationFile(input.path, namespace.owner, {
    mode: 0o600,
    limit: migrationJournalLimit,
  });
  const record = validRetainedRepairJournal(migrationJson(file.bytes));
  if (!isDeepStrictEqual(file.descriptor, input)) {
    if (action !== "resume") reject("retained repair expected journal bytes or inode changed");
    const paths = retainedRepairPaths(root, record.operation);
    const transition = migrationJson(
      retainedRepairRead(`${paths.prefix}.transition-${record.sequence}.json`).bytes,
    );
    if (
      !isDeepStrictEqual(transition.expected, input) ||
      !isDeepStrictEqual(transition.next, record)
    )
      reject("retained repair resume does not match its exact durable transition");
  }
  const context = retainedRepairCompleted(root, record.build, record),
    { paths, snapshot } = context;
  retainedRepairTransactionEvidence(context, record);
  if (action !== "verify") {
    syncPath(input.path);
    syncPath(paths.directory);
    if (
      !isDeepStrictEqual(
        migrationFile(input.path, namespace.owner, { mode: 0o600 }).descriptor,
        file.descriptor,
      )
    )
      reject("retained repair changed during resume");
    return { record, journal: file.descriptor };
  }
  if (record.phase !== "REPAIR_PREPARED")
    reject("retained repair verify requires exact prepared phase");
  const next = validRetainedRepairJournal({
    ...record,
    phase: "REPAIR_EVIDENCE_VERIFIED",
    sequence: 1,
  });
  return retainedRepairTransition(root, paths, input, next, lock);
}
function retainedRepairTransition(root, paths, expected, next, lock) {
  const transition = { version: 1, expected, next },
    pathname = `${paths.prefix}.transition-${next.sequence}.json`;
  retainedRepairFile(pathname, Buffer.from(JSON.stringify(transition) + "\n"));
  const context = retainedRepairCompleted(root, next.build, next);
  retainedRepairTransactionEvidence(context, next);
  const current = migrationFile(paths.pathname, paths.owner, {
    mode: 0o600,
    limit: migrationJournalLimit,
  });
  if (!isDeepStrictEqual(current.descriptor, expected))
    reject("retained repair slot changed at exact-phase transition");
  if (!isDeepStrictEqual(retainedRepairLock(), lock))
    reject("retained repair lock changed at transition");
  atomicJson(paths.pathname, next);
  const observed = migrationFile(paths.pathname, paths.owner, {
    mode: 0o600,
    limit: migrationJournalLimit,
  });
  if (!isDeepStrictEqual(migrationJson(observed.bytes), next))
    reject("retained repair slot changed after transition");
  return { record: next, journal: observed.descriptor };
}

function retainedRepairEntry(action, root, operation, hash) {
  if (!["begin", "resume"].includes(action) || !/^[a-f0-9]{64}$/.test(hash)) reject("invalid repair entry");
  retainedRepairLock();
  const paths = retainedRepairPaths(root, operation);
  const path = action === "begin" ? `${paths.prefix}.build-completed.json` : paths.pathname;
  const file = retainedRepairRead(path);
  if (file.descriptor.sha256 !== hash) reject("repair entry requires the exact expected receipt bytes");
  if (action === "resume" && migrationJson(file.bytes).operation !== operation) reject("repair entry belongs to another operation");
  return retainedRepairTransaction(action, root, file.descriptor);
}

function retainedRepairRetire(root, operation, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) reject("repair retirement requires the completed journal SHA256");
  const paths = retainedRepairPaths(root, operation), lock = retainedRepairLock();
  const archive = join(paths.directory, `retired-repair-${operation}`);
  const archivedJournal = join(archive, "activation.json"), intentPath = join(archive, "intent.json");
  const moved = lstatSync(archivedJournal, { throwIfNoEntry: false });
  if (moved && lstatSync(paths.pathname, { throwIfNoEntry: false }))
    reject("repair retirement refuses a new canonical journal");
  const source = retainedRepairRead(moved ? archivedJournal : paths.pathname);
  const record = validRetainedRepairJournal(migrationJson(source.bytes));
  if (record.operation !== operation || record.phase !== "REPAIR_COMPLETED" || source.descriptor.sha256 !== hash)
    reject("repair retirement requires the exact completed operation and journal");
  let intent;
  if (moved) {
    intent = migrationJson(retainedRepairRead(intentPath).bytes);
    if (intent.version !== 1 || intent.kind !== "retained-repair-retirement" || intent.operation !== operation ||
        !isDeepStrictEqual(source.descriptor, { ...intent.journal, path: archivedJournal }))
      reject("repair retirement archive differs from its intent");
  } else {
    const context = retainedRepairLifecycleContext(root, { journal: source.descriptor });
    const acceptance = record.lifecycle.verified.acceptance;
    if (!isDeepStrictEqual(record.lifecycle.completed.acceptance, acceptance) ||
        acceptance.path !== `${paths.prefix}.acceptance-receipt.json`)
      reject("repair retirement acceptance differs from completed activation");
    // Verification already owns semantic acceptance. Consume its immutable receipt,
    // without dispatching another marker or reinterpreting mutable session history.
    retainedRepairBoundFile(acceptance);
    const owner = retainedRepairNative(root, context, "live-c");
    const target = context.snapshot.request.target.sha, pointers = record.lifecycle.selected;
    if (pointers.current.sha !== target || owner.process.release !== join(root, "releases", target))
      reject("repair retirement target differs from accepted activation");
    if (!lstatSync(archive, { throwIfNoEntry: false })) {
      mkdirSync(archive, { mode: 0o700 }); syncPath(paths.directory);
    }
    exactDirectory(archive, paths.owner, "repair retirement archive", { privateOnly: true });
    // Preserve absolute-path/inode bindings in existing receipts. Archive copies
    // are a closed evidence bundle; original immutable artifacts remain retained.
    const artifacts = readdirSync(paths.directory).filter(name => name.startsWith(basename(paths.prefix) + ".")).sort().map(name => {
      const file = retainedRepairRead(join(paths.directory, name));
      return { source: file.descriptor, archived: retainedRepairFile(join(archive, name), file.bytes) };
    });
    const entry = lstatSync(archive);
    intent = { version: 1, kind: "retained-repair-retirement", operation, journal: source.descriptor,
      target, owner, pointers, acceptance, lock, archive: { path: archive, device: entry.dev, inode: entry.ino }, artifacts };
    retainedRepairFile(intentPath, Buffer.from(JSON.stringify(intent) + "\n"));
  }
  const entry = exactDirectory(archive, paths.owner, "repair retirement archive", { privateOnly: true });
  if (!isDeepStrictEqual(intent.archive, { path: archive, device: entry.dev, inode: entry.ino }) ||
      !isDeepStrictEqual(intent.lock, lock)) reject("repair retirement archive or lock identity changed");
  retainedRepairBoundFile(intent.acceptance);
  for (const artifact of intent.artifacts) retainedRepairBoundFile(artifact.archived);
  const { bootId, cgroup, ...binding } = intent.owner.process;
  if (!isDeepStrictEqual(retainedRepairObserveLive(root, binding), intent.owner))
    reject("repair retirement accepted native generation changed");
  for (const name of ["current", "previous"])
    if (!isDeepStrictEqual(retainedRepairPointer(root, name), intent.pointers[name]))
      reject("repair retirement accepted pointers changed");
  if (!isDeepStrictEqual(retainedRepairLock(), intent.lock)) reject("repair retirement lock identity changed");
  if (!moved) {
    if (!isDeepStrictEqual(retainedRepairRead(paths.pathname).descriptor, intent.journal))
      reject("repair retirement journal changed before archival");
    renameSync(paths.pathname, archivedJournal);
  }
  // Slot release is the sole rename, after the whole bundle and intent are durable.
  // Replay after that rename finishes both directory fsyncs and publishes the receipt.
  syncPath(archive); syncPath(paths.directory);
  const receipt = { ...intent, archivedJournal: { ...intent.journal, path: archivedJournal } };
  retainedRepairFile(join(archive, "retirement.json"), Buffer.from(JSON.stringify(receipt) + "\n"));
  return receipt;
}

function retainedRepairEvent(context, name, create, validate) {
  const pathname = `${context.paths.prefix}.lifecycle-${name}.json`;
  if (lstatSync(pathname, { throwIfNoEntry: false })) {
    const file = retainedRepairRead(pathname);
    const value = migrationJson(file.bytes);
    validate(value);
    return value;
  }
  const value = create();
  validate(value);
  retainedRepairFile(pathname, Buffer.from(JSON.stringify(value) + "\n"));
  return value;
}
function retainedRepairPointer(root, name) {
  const path = join(root, name), entry = lstatSync(path);
  if (!entry.isSymbolicLink() || entry.uid !== migrationOwner() || entry.gid !== rootGroup())
    reject("repair pointer is not owner-safe");
  const target = realpathSync(path), sha = relative(join(root, "releases"), target);
  if (!shaPattern.test(sha)) reject("repair pointer escapes release namespace");
  return { path, sha, device: entry.dev, inode: entry.ino };
}
function retainedRepairSelectPointer(root, context, name, sha, before) {
  const path = join(root, name), target = join(root, "releases", sha);
  const temporary = join(root, `.retained-${context.receipt.operation}-${name}.next`);
  const intentPath = `${context.paths.prefix}.pointer-${name}.json`;
  let intent;
  if (lstatSync(intentPath, { throwIfNoEntry: false })) {
    intent = migrationJson(retainedRepairRead(intentPath).bytes);
    suspensionObject(intent, ["before", "next", "temporary"], "repair pointer intent");
    if (!isDeepStrictEqual(intent.before, before) || intent.next.path !== path ||
        intent.next.sha !== sha || intent.temporary !== temporary) reject("repair pointer intent changed");
  } else {
    if (!isDeepStrictEqual(retainedRepairPointer(root, name), before)) reject("repair pointer changed before intent");
    if (!lstatSync(temporary, { throwIfNoEntry: false })) {
      symlinkSync(target, temporary);
      syncPath(root);
    }
    const entry = lstatSync(temporary);
    if (!entry.isSymbolicLink() || entry.uid !== migrationOwner() || entry.gid !== rootGroup() ||
        readlinkSync(temporary) !== target) reject("repair pending pointer is unsafe");
    intent = { before, next: { path, sha, device: entry.dev, inode: entry.ino }, temporary };
    retainedRepairFile(intentPath, Buffer.from(JSON.stringify(intent) + "\n"));
  }
  const observed = retainedRepairPointer(root, name);
  if (isDeepStrictEqual(observed, intent.next)) {
    if (lstatSync(temporary, { throwIfNoEntry: false })) reject("repair pointer has unexpected publication alias");
  } else {
    if (!isDeepStrictEqual(observed, before)) reject("repair pointer has a third identity");
    const pending = lstatSync(temporary);
    if (!pending.isSymbolicLink() || pending.uid !== migrationOwner() || pending.gid !== rootGroup() ||
        pending.dev !== intent.next.device || pending.ino !== intent.next.inode ||
        readlinkSync(temporary) !== target) reject("repair pending pointer changed");
    renameSync(temporary, path);
  }
  syncPath(root);
  if (!isDeepStrictEqual(retainedRepairPointer(root, name), intent.next)) reject("repair pointer changed at publication");
  return intent.next;
}
function retainedRepairLifecycleContext(root, input) {
  validMigrationDescriptor(input.journal, "path", "repair lifecycle journal");
  const checked = retainedRepairTransaction("check", root, input.journal);
  const context = retainedRepairCompleted(root, checked.record.build, checked.record);
  return { ...context, ...checked };
}
function retainedRepairLifecycleCommit(root, context, key, value) {
  const sequence = context.record.sequence + 1;
  const phase = key === "failed" ? "REPAIR_FAILED" : retainedRepairPhases[sequence];
  if (key !== "failed" && retainedRepairEvents[sequence - 2] !== key) reject("repair lifecycle action is out of phase");
  const next = validRetainedRepairJournal({ ...context.record, sequence, phase,
    lifecycle: { ...context.record.lifecycle, [key]: value } });
  return retainedRepairTransition(root, context.paths, context.journal, next, retainedRepairLock());
}
function retainedRepairRequirePhase(context, phase) {
  if (context.record.phase !== phase) reject(`repair requires exact ${phase} phase`);
}
function retainedRepairReady(response, bound) {
  const now = Date.now();
  if (response.status !== "ready" || suspensionWriteCustody(response) !== "clear" ||
      response.expiresAtMs <= now + 5000 || now >= bound.drain.deadlineMs)
    reject("repair requires fresh ready suspension with explicit clear write custody");
}
function retainedRepairLeaseStatus(response, suspensionId, bound, expected) {
  // Status has no suspensionId/activeCount/blockers in its closed READY schema.
  // Bind the queried ID separately; never manufacture a PREPARE-shaped result.
  if (!suspensionContract.validateGatewaySuspendStatusResult(response))
    reject("repair suspension status result is malformed");
  suspensionToken(suspensionId, "repair status lease");
  retainedRepairReady(response, bound);
  if (suspensionId !== expected.id || response.expiresAtMs !== expected.expiresAtMs)
    reject("repair suspension identity or deadline changed");
  return expected;
}
function retainedRepairLease(response, bound, expected, statusResponse) {
  if (!suspensionContract.validateGatewaySuspendPrepareResult(response) ||
      !["ready", "draining"].includes(response.status))
    reject("repair suspension prepare result is malformed");
  suspensionBlockers(response, "repair suspension prepare result", suspensionWriteCustody(response));
  suspensionToken(response.suspensionId, "repair lease");
  const value = { id: response.suspensionId, expiresAtMs: response.expiresAtMs, terminalPolicy: "preserve",
    status: "ready", requestId: bound.drain.requestId };
  if (expected && !isDeepStrictEqual(value, expected)) reject("repair suspension identity or deadline changed");
  // A drain may become READY only through a real STATUS response for that same
  // acquisition. Keep the original PREPARE identity/expiry and fixed deadline.
  if (statusResponse !== undefined) retainedRepairLeaseStatus(statusResponse, value.id, bound, value);
  else retainedRepairReady(response, bound);
  return value;
}
function retainedRepairFloor(context) {
  const legacy = context.snapshot.evidence.record;
  const path = `${context.paths.prefix}.stopped-floor.json`;
  const previous = migrationJson(retainedRepairBoundFile(context.record.floor).bytes);
  const value = lstatSync(path, { throwIfNoEntry: false })
    ? migrationJson(retainedRepairRead(path).bytes)
    : retainedRepairWitness(legacy, previous);
  retainedRepairWitness(legacy, value);
  return retainedRepairFile(path, Buffer.from(JSON.stringify(value) + "\n"));
}
function retainedRepairWriters(context) {
  const legacy = context.snapshot.evidence.record;
  const witness = retainedRepairWitness(legacy,
    migrationJson(retainedRepairBoundFile(context.record.floor).bytes));
  const stores = new Set([legacy.protectedPaths[1].path, ...sessionWitnessTuples(witness).map(tuple => tuple[1])]);
  assertDatabaseWritersStopped(new Set([legacy.protectedPaths[0].path,
    ...[...stores].flatMap(path => [path, `${path}-wal`, `${path}-shm`])]),
    process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc");
}
function retainedRepairLifecycle(action, root, input) {
  const allowed = { inspect: ["journal"], bind: ["journal", "instance"], suspend: ["journal", "response"],
    "stop-intent": ["journal", "response", "suspensionId"], stopped: ["journal"], "select-intent": ["journal"],
    select: ["journal"], "start-intent": ["journal", "verificationSeconds"],
    "start-dispatch": ["journal"], started: ["journal", "instance"], verify: ["journal", "acceptance"],
    complete: ["journal"], fail: ["journal", "code"], "observe-failure": ["journal", "code"] };
  if (!allowed[action]) reject("unknown retained repair lifecycle action");
  if (action === "suspend" && input && Object.hasOwn(input, "statusResponse")) allowed.suspend.push("statusResponse");
  suspensionObject(input, allowed[action], "repair lifecycle request");
  if (action === "fail" || action === "observe-failure") {
    const paths = migrationNamespace(root);
    const source = migrationFile(paths.pathname, paths.owner, { mode: 0o600, limit: migrationJournalLimit });
    const record = validRetainedRepairJournal(migrationJson(source.bytes));
    if (!isDeepStrictEqual(source.descriptor, input.journal) || !Number.isSafeInteger(input.code) || input.code < 1 || input.code > 255)
      reject("repair failure receipt requires the exact current journal and exit code");
    const prefix = retainedRepairPaths(root, record.operation).prefix;
    const observation = retainedRepairFile(`${prefix}.failure-observed-${record.sequence}.json`,
      Buffer.from(JSON.stringify({ journal: input.journal, exitCode: input.code }) + String.fromCharCode(10)));
    // A transport/owner-process failure is evidence, not authority to consume the
    // canonical phase. Exact resume must still reconcile the existing intent/job.
    if (action === "observe-failure") return { journal: source.descriptor, observation, phase: record.phase };
  }
  const context = retainedRepairLifecycleContext(root, input), { record, paths, snapshot } = context;
  if (action === "inspect") {
    const { sha256, ...configIdentity } = snapshot.config;
    return { ...context, protectedPaths: [configIdentity, ...snapshot.evidence.record.protectedPaths.slice(1)] };
  }
  if (["REPAIR_FAILED", "REPAIR_COMPLETED"].includes(record.phase)) reject("repair is terminal and cannot be retried");
  const observedB = () => retainedRepairNative(root, context, "live-b");
  const stopped = () => { const value = retainedRepairNative(root, context, "stopped"); retainedRepairWriters(context); return value; };
  const event = (name, create, validate = () => {}) => retainedRepairEvent(context, name, create, validate);
  const commit = (name, value) => retainedRepairLifecycleCommit(root, context, name, value);
  if (action === "bind") {
    retainedRepairRequirePhase(context, "REPAIR_EVIDENCE_VERIFIED");
    suspensionToken(input.instance, "repair native process instance");
    const owner = observedB();
    const value = event("bound", () => ({ owner: { ...owner, instance: input.instance },
      drain: { requestId: `retained-repair-${record.operation}`, deadlineMs: Date.now() + 30000 },
      guard: retainedRepairGuardInstall(root, context) }), value => {
      if (!isDeepStrictEqual(value.owner, { ...owner, instance: input.instance }) ||
          value.drain.requestId !== `retained-repair-${record.operation}` ||
          !Number.isSafeInteger(value.drain.deadlineMs) || value.drain.deadlineMs <= Date.now())
        reject("repair original owner or fixed drain deadline changed");
      retainedRepairGuardVerify(root, context, value.guard);
    });
    return commit("bound", value);
  }
  if (action === "suspend") {
    retainedRepairRequirePhase(context, "REPAIR_BOUND"); observedB();
    const lease = retainedRepairLease(input.response, record.lifecycle.bound, undefined, input.statusResponse);
    const value = event("suspension", () => lease, value => retainedRepairLease(input.response, record.lifecycle.bound, value, input.statusResponse));
    return commit("suspension", value);
  }
  if (action === "stop-intent") {
    retainedRepairRequirePhase(context, "REPAIR_SUSPENDED"); observedB();
    retainedRepairLeaseStatus(input.response, input.suspensionId, record.lifecycle.bound, record.lifecycle.suspension);
    const value = event("stopIntent", () => ({ owner: record.lifecycle.bound.owner, lease: record.lifecycle.suspension }), value => {
      if (!isDeepStrictEqual(value, { owner: record.lifecycle.bound.owner, lease: record.lifecycle.suspension }))
        reject("repair stop intent changed");
    });
    return commit("stopIntent", value);
  }
  if (action === "stopped") {
    retainedRepairRequirePhase(context, "REPAIR_STOP_INTENT");
    const native = stopped();
    const value = event("stopped", () => ({ native, floor: retainedRepairFloor(context) }), value => {
      if (!isDeepStrictEqual(value.native, native)) reject("repair stopped custody changed");
      retainedRepairBoundFile(value.floor);
    });
    stopped();
    retainedRepairFile(`${paths.prefix}.stopped.json`, Buffer.from(JSON.stringify(value) + String.fromCharCode(10)));
    return commit("stopped", value);
  }
  if (action === "select-intent") {
    retainedRepairRequirePhase(context, "REPAIR_STOPPED"); stopped();
    const before = { current: retainedRepairPointer(root, "current"), previous: retainedRepairPointer(root, "previous") };
    if (before.current.sha !== snapshot.evidence.record.candidate.sha || before.previous.sha !== snapshot.evidence.record.predecessor.sha)
      reject("repair lost original selected topology");
    return commit("selectIntent", event("selectIntent", () => ({ before, target: snapshot.request.target.sha }), value => {
      if (!isDeepStrictEqual(value, { before, target: snapshot.request.target.sha })) reject("repair selection intent changed");
    }));
  }
  if (action === "select") {
    retainedRepairRequirePhase(context, "REPAIR_SELECT_INTENT"); stopped();
    const intent = record.lifecycle.selectIntent;
    const previous = retainedRepairSelectPointer(root, context, "previous", snapshot.evidence.record.candidate.sha, intent.before.previous);
    const current = retainedRepairSelectPointer(root, context, "current", snapshot.request.target.sha, intent.before.current);
    const value = event("selected", () => ({ current, previous }), value => {
      if (!isDeepStrictEqual(value, { current, previous })) reject("repair selected pointer identities changed");
    });
    stopped();
    return commit("selected", value);
  }
  if (action === "start-intent") {
    retainedRepairRequirePhase(context, "REPAIR_SELECTED"); stopped();
    const seconds = integer(input.verificationSeconds, "repair verification budget");
    if (seconds < 1 || seconds > 3600) reject("repair verification budget is outside bounds");
    return commit("startIntent", event("startIntent", () => {
      const stopped = retainedRepairRead(`${paths.prefix}.stopped.json`).descriptor;
      const permit = migrationPermit(root);
      if (!permit) reject("repair requires the exact existing native migration start permit");
      const target = { release: join(root,"releases",snapshot.request.target.sha), runtime: snapshot.process.executable };
      const capability = retainedRepairFile(`${paths.prefix}.start-capability.json`, Buffer.from(JSON.stringify(
        retainedRepairStartCapability(root,record.operation,{sequence:record.sequence+1,build:record.build,floor:record.floor,stopped,target,permit})
      ) + String.fromCharCode(10)));
      return { selected:record.lifecycle.selected, deadlineMs:Date.now()+seconds*1000,
        guard:record.lifecycle.bound.guard, predecessor:record.lifecycle.bound.owner, capability, stopped,target,permit };
    }, value => {
      if (!isDeepStrictEqual(value.selected,record.lifecycle.selected) ||
          !isDeepStrictEqual(value.guard,record.lifecycle.bound.guard) ||
          !isDeepStrictEqual(value.predecessor,record.lifecycle.bound.owner) ||
          !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs<=Date.now()) reject("repair start intent changed or expired");
      const expected = retainedRepairStartCapability(root,record.operation,{sequence:record.sequence+1,build:record.build,floor:record.floor,
        stopped:value.stopped,target:value.target,permit:value.permit});
      if (!isDeepStrictEqual(migrationJson(retainedRepairBoundFile(value.capability).bytes),expected) ||
          !isDeepStrictEqual(value.permit,migrationPermit(root)) || value.target.release !== join(root,"releases",snapshot.request.target.sha) ||
          value.target.runtime !== snapshot.process.executable) reject("repair start capability changed");
    }));
  }
  if (action === "start-dispatch") {
    retainedRepairRequirePhase(context, "REPAIR_START_INTENT");
    if (Date.now() >= record.lifecycle.startIntent.deadlineMs) reject("repair start deadline expired");
    stopped();
    const path = `${paths.prefix}.start-dispatch.json`;
    if (lstatSync(path, { throwIfNoEntry: false })) reject("repair start dispatch already issued; reconcile native job/claim, never reissue");
    retainedRepairFile(path, Buffer.from(JSON.stringify({ journal: context.journal, intent: record.lifecycle.startIntent }) + "\n"));
    return { phase: "DISPATCH_ONCE", journal: context.journal };
  }
  if (action === "started") {
    retainedRepairRequirePhase(context, "REPAIR_START_INTENT");
    suspensionToken(input.instance, "repair successor instance");
    const owner = retainedRepairNative(root, context, "live-c");
    const claim = retainedRepairStartClaimVerify(root, context);
    const value = event("started", () => ({ ...owner, instance: input.instance, claim }), value => {
      if (!isDeepStrictEqual(value, { ...owner, instance: input.instance, claim })) reject("repair successor changed");
    });
    return commit("started", value);
  }
  if (action === "verify") {
    retainedRepairRequirePhase(context, "REPAIR_STARTED");
    retainedRepairNative(root, context, "live-c");
    const acceptance = retainedRepairAcceptanceReceipt(root, context, input.acceptance);
    return commit("verified", event("verified", () => ({ acceptance }), value => {
      if (!isDeepStrictEqual(value, { acceptance })) reject("repair acceptance changed");
    }));
  }
  if (action === "complete") {
    retainedRepairRequirePhase(context, "REPAIR_VERIFIED");
    if (!lstatSync(record.lifecycle.bound.guard.descriptor.path, { throwIfNoEntry: false })) {
      retainedRepairGuardRemovalEvidence(root, context);
      syncPath(dirname(record.lifecycle.bound.guard.descriptor.path));
      repairSystemctl(["daemon-reload"]);
    }
    retainedRepairNative(root, context, "live-c");
    const value = event("completed", () => ({ operation: record.operation, build: record.build,
      acceptance: record.lifecycle.verified.acceptance, completedAtMs: Date.now(), retainedOriginal: context.receipt.original }), value => {
      if (value.operation !== record.operation || !isDeepStrictEqual(value.build, record.build) ||
          !isDeepStrictEqual(value.acceptance, record.lifecycle.verified.acceptance) ||
          !isDeepStrictEqual(value.retainedOriginal, context.receipt.original)) reject("repair completion receipt changed");
    });
    retainedRepairGuardRemove(root, context);
    return commit("completed", value);
  }
  if (action === "fail") {
    if (record.phase === "REPAIR_VERIFIED" &&
        lstatSync(`${paths.prefix}.guard-removal-intent.json`, { throwIfNoEntry: false }))
      reject("repair completion removal is in progress; retain VERIFIED for exact resume");
    if (!Number.isSafeInteger(input.code) || input.code < 1 || input.code > 255) reject("repair failure code is invalid");
    const value = event("failed", () => ({ from: record.phase, exitCode: input.code, failedAtMs: Date.now(),
      original: context.receipt.original, build: record.build }), value => {
      if (value.from !== record.phase || value.exitCode !== input.code ||
          !isDeepStrictEqual(value.original, context.receipt.original) || !isDeepStrictEqual(value.build, record.build)) reject("repair failure receipt changed");
    });
    return commit("failed", value);
  }
}

function recoveryEvidence(pathname, root, expected, position = "observed", configRequest, retainedSource) {
  if (!["observed", "restored", "selected"].includes(position))
    reject("unknown recovery pointer view");
  const restored = position === "restored",
    selected = position === "selected";
  const record = retainedSource ? validJournal(retainedSource.record) : ownedJournal(pathname);
  if (retainedSource) runtimeJournalCheck(record, root);
  if (
    selected &&
    (record.phase !== "ROLLBACK_FAILED" ||
      record.topology !== "system" ||
      (record.candidate.sha === record.predecessor.sha && !record.runtimeChange))
  )
    reject("selected recovery requires a distinct failed system activation");
  const releases = [record.predecessor, record.candidate].map(({ sha }) => {
    const entry = lstatSync(join(root, "releases", sha));
    return { sha, device: entry.dev, inode: entry.ino };
  });
  const originalBytes = originalWitness(pathname, record, expected?.record, retainedSource?.file);
  const snapshot = { record, identity: retainedSource?.identity ?? identity(pathname), releases };
  const reconciliation = expected?.configReconciliation ?? configRequest;
  if (reconciliation) {
    // An operator may accept one reviewed config replacement on an exact live release.
    // The historical journal stays intact; the new bytes and inode bind this recovery only.
    if (!(restored || selected) || !["ROLLBACK_FAILED", "C_CURRENT_SELECTED"].includes(record.phase) || record.topology !== "system" ||
        record.candidate.sha === record.predecessor.sha || !record.originalWitness ||
        !/^[a-f0-9]{64}$/.test(reconciliation.journalSha256) ||
        !/^[a-f0-9]{64}$/.test(reconciliation.config?.sha256) ||
        reconciliation.config.path !== record.protectedPaths[0].path ||
        reconciliation.databasePath !== record.protectedPaths[1].path ||
        reconciliation.config.path === record.protectedPaths[1].path)
      reject("config reconciliation requires an exact reviewed restored-system rollback or prepared predecessor");
    if (selected && (reconciliation.startStopped || record.runtimeChange ||
        !isDeepStrictEqual(record.predecessor.schemaVersions, record.candidate.schemaVersions)))
      reject("selected config reconciliation requires a live same-schema candidate");
    if (record.phase === "C_CURRENT_SELECTED" && (reconciliation.startStopped === true || record.runtimeChange ||
        !isDeepStrictEqual(record.predecessor.schemaVersions, record.candidate.schemaVersions)))
      reject("prepared config reconciliation requires a live same-schema predecessor without a runtime change");
    const owner = integer(process.env.OPENCLAW_TEAM_ROOT_UID ?? "0", "journal owner");
    const journal = migrationFile(retainedSource?.file.path ?? pathname, owner, { mode: 0o600 });
    if (journal.descriptor.sha256 !== reconciliation.journalSha256 ||
        !isDeepStrictEqual(migrationJson(journal.bytes), record))
      reject("config reconciliation journal bytes changed");
    const entry = lstatSync(reconciliation.config.path);
    const runtimeOwner = integer(reconciliation.runtimeUid, "reconciliation runtime owner");
    if (![owner, runtimeOwner].includes(entry.uid)) reject("reconciled config owner is unsafe");
    const config = migrationFile(reconciliation.config.path, entry.uid, { mode: 0o600, group: entry.gid });
    if (config.descriptor.device !== record.protectedPaths[0].device ||
        config.descriptor.inode === record.protectedPaths[0].inode)
      reject("config reconciliation requires an atomic replacement on the original filesystem");
    if (config.descriptor.sha256 !== reconciliation.config.sha256)
      reject("reviewed reconciliation config bytes changed");
    snapshot.configReconciliation = { journalSha256: journal.descriptor.sha256, databasePath: reconciliation.databasePath, runtimeUid: runtimeOwner,
      config: { ...config.descriptor, uid: entry.uid, gid: entry.gid } };
    if (selected) {
      if (!isDeepStrictEqual(identity(record.protectedPaths[1].path), record.protectedPaths[1]))
        reject("selected config reconciliation refuses a replaced store");
      snapshot.configReconciliation.process = selectedConfigProcess(root, record, reconciliation.process);
      const replacement = configReplacement(root, record, runtimeOwner);
      snapshot.configReconciliation.replacement = { previous: replacement.previous,
        config: replacement.config, backup: replacement.backup.descriptor, audit: replacement.audit };
      if (replacement.config.sha256 !== reconciliation.config.sha256)
        reject("reviewed reconciliation config bytes changed during audit");
    }
    if (reconciliation.startStopped !== undefined && typeof reconciliation.startStopped !== "boolean")
      reject("stopped recovery intent is malformed");
    if (reconciliation.startStopped) {
      const schemas = record.predecessor.schemaVersions;
      const stores = [identity(reconciliation.databasePath)];
      const compatibility = verifyStateCompatibility(reconciliation.databasePath, schemas, record.candidate.schemaVersions,
        (database, _agentId, path) => {
          if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_meta'").get())
            reject("stopped recovery requires exact agent ownership metadata");
          stores.push(identity(path));
        }, sessionWitnessTuples(migrationJson(originalBytes)));
      const metadata = databaseRead(reconciliation.databasePath, database =>
        database.prepare("SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = ?").get("primary"));
      if (compatibility.live !== schemas.state || metadata?.role !== "global" ||
          metadata.schema_version !== schemas.state || metadata.agent_id !== null)
        reject("stopped recovery requires exact live shared schema and ownership metadata");
      snapshot.configReconciliation.startStopped = true;
      snapshot.configReconciliation.stores = stores.sort((a, b) => a.path.localeCompare(b.path));
    }
  }

  if (
    !["A_PREPARED", "B_PREVIOUS_PUBLISHED", "C_CURRENT_SELECTED", "MIGRATION_SWITCHING"].includes(
      record.phase,
    ) &&
    !((restored || selected || record.runtimeChange) && record.phase === "ROLLBACK_FAILED" && record.topology === "system")
  )
    reject("journal phase cannot recover an untouched predecessor");
  if (record.phase === "MIGRATION_SWITCHING" && record.predecessor.sha !== record.candidate.sha)
    reject("migration recovery does not select the sealed predecessor baseline");
  suspensionToken(record.suspension.id, "journal suspension identity");
  if (record.suspension.expiresAtMs <= 0) reject("journal suspension expiry is invalid");
  const original = record.pointerTopology;
  if (
    (original.current.present && original.current.sha !== record.predecessor.sha) ||
    (record.topology === "system" && !original.current.present)
  )
    reject("journal predecessor pointer is inconsistent");
  const system = record.services.system,
    user = record.services.user;
  if (
    record.topology === "system"
      ? system.activeState !== "active" ||
        system.unitFileState !== "enabled" ||
        user.activeState !== "inactive" ||
        user.unitFileState !== "disabled"
      : system.activeState !== "inactive" ||
        system.unitFileState !== "disabled" ||
        user.activeState !== "active"
  )
    reject("journal predecessor service topology is inconsistent");
  const owner = integer(process.env.OPENCLAW_TEAM_ROOT_UID ?? "0", "journal owner");
  // Full immutable-tree validation once; subsequent checks retain the exact
  // published inodes under the canonical deployment lock.
  if (!expected) {
    for (const release of [record.predecessor, record.candidate]) {
      const actual = validateRelease(join(root, "releases", release.sha), release.sha, owner, true);
      if (JSON.stringify(actual) !== JSON.stringify(release))
        reject("journal release identity changed");
    }
  }
  for (const protectedPath of record.protectedPaths) {
    if (snapshot.configReconciliation && protectedPath.path === snapshot.configReconciliation.config.path) continue;
    if (JSON.stringify(identity(protectedPath.path)) !== JSON.stringify(protectedPath))
      reject("recovery protected path identity changed");
  }
  const pointers = {};
  if (selected || reconciliation) snapshot.selectedPointers = {};
  for (const name of ["current", "previous"]) {
    const path = join(root, name);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) {
      pointers[name] = null;
      continue;
    }
    if (!entry.isSymbolicLink() || entry.uid !== owner || entry.gid !== rootGroup())
      reject("recovery pointer ownership is unsafe");
    const target = realpathSync(path);
    const sha = relative(join(root, "releases"), target);
    if (!shaPattern.test(sha)) reject("recovery pointer escapes sealed releases");
    if (!expected) validateRelease(target, sha, owner, true);
    pointers[name] = sha;
    if (selected || reconciliation) snapshot.selectedPointers[name] = { sha, device: entry.dev, inode: entry.ino };
  }
  const oldCurrent = original.current.sha,
    oldPrevious = original.previous.sha;
  if (selected) {
    if (pointers.current !== record.candidate.sha || pointers.previous !== (record.runtimeChange ? oldPrevious : record.predecessor.sha))
      reject("recovery did not retain exact selected candidate topology");
  } else if (restored) {
    if (pointers.current !== oldCurrent || pointers.previous !== oldPrevious)
      reject("recovery did not restore exact pointer topology");
  } else if (
    ![oldPrevious, record.predecessor.sha].includes(pointers.previous) ||
    (pointers.current !== oldCurrent &&
      (record.phase === "A_PREPARED" ||
        pointers.current !== record.candidate.sha ||
        pointers.previous !== record.predecessor.sha))
  )
    reject("journal phase and pointers disagree during recovery");
  // Selected recovery and explicit reconciliation bind pointer inodes as well as targets.
  if (expected && JSON.stringify(snapshot) !== JSON.stringify(expected))
    reject("recovery journal or pointer identity changed; evidence retained");
  if (snapshot.configReconciliation) {
    // Native config writers use a separate lock. Refresh both bindings after the
    // database scans, before callers can retire the journal from stale evidence.
    const { uid, gid, ...descriptor } = snapshot.configReconciliation.config;
    const config = migrationFile(descriptor.path, uid, { mode: 0o600, group: gid });
    if (!isDeepStrictEqual(config.descriptor, descriptor))
      reject("reconciled config changed during recovery validation; evidence retained");
    const journal = migrationFile(retainedSource?.file.path ?? pathname, owner, { mode: 0o600 });
    if (!isDeepStrictEqual(journal.descriptor, retainedSource?.file ??
        { ...snapshot.identity, sha256: snapshot.configReconciliation.journalSha256 }))
      reject("reconciliation journal changed during recovery validation; evidence retained");
    if (selected) selectedConfigProcess(root, record, snapshot.configReconciliation.process);
  }
  return snapshot;
}

const stopStartRelations = ["RequiredBy", "RequisiteOf", "PartOf", "ConsistsOf", "BindsTo", "BoundBy",
  "PropagatesStopTo", "StopPropagatedFrom", "Upholds", "UpheldBy"];

function assertStopStartContract(properties) {
  assert.equal(properties.KillSignal, 15);
  assert.equal(properties.RestartKillSignal, 15);
  assert.equal(properties.FileDescriptorStoreMax, 0);
  assert.equal(properties.NFileDescriptorStore, 0);
  assert.deepEqual(properties.RuntimeDirectory, []);
  for (const name of stopStartRelations) assert.deepEqual(properties[name], []);
}

function recoveryStart(action, pathname, root, expected, procRoot) {
  const snapshot = recoveryEvidence(pathname, root, expected, "restored");
  const config = snapshot.configReconciliation;
  if (config?.startStopped !== true) reject("stopped start requires explicit reconciliation evidence");
  const namespace = migrationNamespace(root);
  const intent = join(namespace.directory, `recovery-start-${config.journalSha256}.json`);
  if (action === "writers") {
    const targets = new Set([config.config.path, ...config.stores.flatMap(store => [store.path, `${store.path}-wal`, `${store.path}-shm`])]);
    assertDatabaseWritersStopped(targets, procRoot);
    recoveryEvidence(pathname, root, expected, "restored");
    return "WRITERS_STOPPED";
  }
  const record = { version: 1, kind: "stopped-predecessor-start", evidence: snapshot };
  if (lstatSync(intent, { throwIfNoEntry: false })) {
    settleFixedPublications([{ path: intent, mode: 0o600, validate(bytes) {
      if (!isDeepStrictEqual(migrationJson(bytes), record)) reject("interrupted stopped start receipt binding changed");
    } }], namespace.owner, process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
    const file = migrationFile(intent, namespace.owner, { mode: 0o600 });
    if (!isDeepStrictEqual(migrationJson(file.bytes), record)) reject("stopped start receipt binding changed");
    if (action === "intent") reject("stopped predecessor start already issued; verify the current owner instead of starting again");
    return "ISSUED";
  }
  if (action === "status") return "UNUSED";
  if (action !== "intent") reject("unknown stopped recovery action");
  // Publish once before handing a start to systemd. A crash or uncertain result
  // consumes this attempt; future recovery can verify, but cannot start it again.
  migrationWriteExclusive(intent, Buffer.from(JSON.stringify(record) + "\n"), 0o600);
  if (!isDeepStrictEqual(migrationJson(migrationFile(intent, namespace.owner, { mode: 0o600 }).bytes), record))
    reject("stopped start intent publication changed");
  return "ISSUED";
}

async function startupProfileCommand(command, input) {
  const mono = () => Number(process.hrtime.bigint() / 1000n);
  let deadlineMicros;
  const remaining = (limit) => {
    if (deadlineMicros === undefined) return limit;
    const value = Math.floor((deadlineMicros - mono()) / 1000);
    assert(value > 0, "profiling owner deadline expired");
    return Math.min(limit, value);
  };
  const unitName = "openclaw-gateway.service";
  const namespace = "/var/lib/openclaw-team-diagnostics";
  const dropDirectory = `/run/systemd/system/${unitName}.d`;
  const operationPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const processFields = (pid) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
  const generation = (pid) => processFields(pid)[19];
  const running = (pid, start) => {
    try {
      const fields = processFields(pid);
      return fields[19] === start && !["Z", "X", "x"].includes(fields[0]);
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const fileIdentity = (s) => ({
    dev: s.dev,
    ino: s.ino,
    size: s.size,
    uid: s.uid,
    gid: s.gid,
    mode: s.mode,
  });
  function safeDirectory(directory, uid = 0, group = 0) {
    assert.equal(realpathSync(directory), directory);
    return exactDirectory(directory, uid, "profiling directory", { group });
  }
  function readFile(file, uid = 0, limit = 65536) {
    const stat = lstatSync(file);
    const value = migrationFile(file, uid, {
      privateOnly: false,
      group: stat.gid,
      mode: stat.mode & 0o7777,
      limit,
    });
    const { path: ignoredPath, ...descriptor } = value.descriptor;
    return {
      bytes: value.bytes,
      metadata: { ...descriptor, uid: stat.uid, gid: stat.gid, mode: stat.mode },
      sha256: value.descriptor.sha256,
    };
  }
  function atomicFile(file, bytes, mode = 0o600, group = 0) {
    migrationWriteExclusive(file, bytes, mode);
    if (group !== 0) chownSync(file, 0, group);
  }
  function readJson(file) {
    return JSON.parse(readFile(file).bytes);
  }
  function writeJson(file, value, mode = 0o600, group = 0) {
    atomicJson(file, value, { mode, group });
  }
  function operationDirectory(operation) {
    assert(operationPattern.test(operation));
    safeDirectory(namespace);
    const directory = join(namespace, operation);
    safeDirectory(directory, 0, lstatSync(directory).gid);
    return directory;
  }
  function systemProperty(name, iface = "Service") {
    const response = spawnSync(
      "/usr/bin/busctl",
      [
        "--system",
        "--json=short",
        "get-property",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice",
        `org.freedesktop.systemd1.${iface}`,
        name,
      ],
      { encoding: "utf8", timeout: remaining(15000), maxBuffer: 1024 * 1024 },
    );
    assert.equal(response.status, 0, `cannot read profiling prerequisite ${name}`);
    return JSON.parse(response.stdout).data;
  }
  function initialEnvironment(pid) {
    const bytes = readFileSync(`/proc/${pid}/environ`);
    assert(bytes.length <= 1024 * 1024);
    return new Map(
      bytes
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((value) => {
          const split = value.indexOf("=");
          assert(split > 0);
          return [value.slice(0, split), value.slice(split + 1)];
        }),
    );
  }
  function environmentSnapshot(expectedOptions, runtimeUid) {
    const environment = systemProperty("Environment");
    const options = environment.filter((value) => value.startsWith("NODE_OPTIONS="));
    assert(
      options.length === (expectedOptions ? 1 : 0) &&
        (!expectedOptions || options[0] === `NODE_OPTIONS=${expectedOptions}`),
      "unexpected NODE_OPTIONS prerequisite",
    );
    assert.deepEqual(systemProperty("PassEnvironment"), []);
    assert.deepEqual(systemProperty("UnsetEnvironment"), []);
    const files = systemProperty("EnvironmentFiles").map(([file, optional]) => {
      assert.equal(optional, false);
      const uid = lstatSync(file).uid;
      assert(uid === 0 || uid === runtimeUid);
      const value = readFile(file, uid, 1024 * 1024);
      // EnvironmentFiles override Environment. Refuse any mention instead of parsing secrets.
      assert(
        !value.bytes.includes(Buffer.from("NODE_OPTIONS")),
        "an environment file mentions NODE_OPTIONS",
      );
      return { file, metadata: value.metadata, sha256: value.sha256 };
    });
    return {
      runtimeUid,
      environment: environment
        .filter((value) => !value.startsWith("NODE_OPTIONS="))
        .map((value) => digest(value))
        .sort(),
      files,
      command: systemProperty("ExecStart"),
      cwd: systemProperty("WorkingDirectory"),
      type: systemProperty("Type"),
      user: systemProperty("User"),
      group: systemProperty("Group"),
      killMode: systemProperty("KillMode"),
      conditions: systemProperty("Conditions", "Unit"),
      execCondition: systemProperty("ExecCondition"),
    };
  }
  function sameEnvironment(before, options, after = environmentSnapshot(options, before.runtimeUid)) {
    // ExecStart includes observed timestamps and PID, which change at the owned restart.
    const commandShape = (records) => records.map((record) => record.slice(0, 3));
    const configuration = (snapshot) => ({
      ...snapshot,
      command: commandShape(snapshot.command),
      // systemd evaluates the fifth field at start; the preceding four define the condition.
      conditions: snapshot.conditions.map((condition) => condition.slice(0, 4)),
    });
    assert.deepEqual(configuration(after), configuration(before));
    return after;
  }
  function processBinding(intent, pid, start) {
    assert.equal(systemProperty("MainPID"), pid);
    assert.equal(generation(pid), start);
    const environment = initialEnvironment(pid);
    assert.equal(
      environment.get("INVOCATION_ID"),
      Buffer.from(systemProperty("InvocationID", "Unit")).toString("hex"),
    );
    assert.equal(environment.get("SYSTEMD_EXEC_PID"), String(pid));
    assert.equal(statSync(`/proc/${pid}`).uid, intent.uid);
    assert.equal(readFileSync(`/proc/${pid}/cgroup`, "utf8"), `0::${intent.cgroup}\n`);
    assert.equal(realpathSync(`/proc/${pid}/exe`), realpathSync(process.execPath));
    // process.title overwrites Linux cmdline; systemd owns the launched argv.
    // The preload also validates its intact process.argv at capture admission.
    assert.equal(systemProperty("MainPID"), pid);
    assert.equal(generation(pid), start);
    return {
      operation: intent.operation,
      pid,
      start,
      invocationId: environment.get("INVOCATION_ID"),
    };
  }
  function dropBody(operation) {
    return `[Service]\nEnvironment="NODE_OPTIONS=--import=${join(namespace, operation, "bootstrap.mjs")}"\n`;
  }
  function dropPaths(operation) {
    return {
      drop: join(dropDirectory, `zz-team-cpu-profile-${operation}.conf`),
      pending: join(dropDirectory, `.team-cpu-profile-${operation}.pending`),
    };
  }
  function assertProfileMutationLock() {
    const lock = "/run/openclaw-release-deploy.lock";
    safeDirectory(dirname(lock));
    const held = fstatSync(9), named = lstatSync(lock);
    assert(held.isFile() && named.isFile() && !named.isSymbolicLink() && held.uid === 0 && held.gid === 0 &&
      held.nlink === 1 && !(held.mode & 0o022) && held.dev === named.dev && held.ino === named.ino);
    const info = readFileSync("/proc/self/fdinfo/9", "utf8");
    assert(/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(info));
    const flags = /^flags:\s+([0-7]+)$/m.exec(info);
    assert(flags && (Number.parseInt(flags[1], 8) & 0o2000000), "profiling lock must be close-on-exec");
    for (const descriptor of readdirSync("/proc/self/fd")) {
      if (!/^\d+$/.test(descriptor) || descriptor === "9") continue;
      let entry;
      try { entry = fstatSync(Number(descriptor)); }
      catch (error) { if (error.code === "EBADF") continue; throw error; }
      assert(entry.dev !== held.dev || entry.ino !== held.ino, "profiling lock has an unexpected descriptor alias");
    }
  }
  function removeEnablement(directory, record) {
    let changed = false;
    for (const file of Object.values(dropPaths(record.operation))) {
      if (!existsSync(file)) continue;
      const current = readFile(file);
      assert.deepEqual(current.metadata, record.drop.metadata);
      assert.equal(current.sha256, record.drop.sha256);
      unlinkSync(file);
      changed = true;
    }
    return changed;
  }
  function revokeSteady(directory, record) {
    const request = join(directory, "steady-request.json");
    if (existsSync(request)) {
      assert.deepEqual(readJson(request), record.steadyRequest);
      unlinkSync(request);
      syncPath(directory);
    }
    if (!existsSync(join(directory, "steady-revoked.json")))
      writeJson(join(directory, "steady-revoked.json"), { operation: record.operation, revokedMicros: mono() });
  }
  function absent(path) {
    assert(!lstatSync(path, { throwIfNoEntry: false }), "profiling operation still has an owned effect");
  }
  function operationPaths(operation) {
    assert(operationPattern.test(operation));
    migrationAncestors(dirname(namespace), 0);
    migrationAncestors(dirname(dropDirectory), 0);
    if (lstatSync(namespace, { throwIfNoEntry: false })) safeDirectory(namespace);
    if (lstatSync(dropDirectory, { throwIfNoEntry: false })) safeDirectory(dropDirectory);
    return { directory: join(namespace, operation), unpublished: join(namespace, `.pending-${operation}`),
      ...dropPaths(operation) };
  }
  function armRecord(directory, record) {
    assert(operationPattern.test(record.operation));
    assert.equal(record.intent.operation, record.operation);
    assert.equal(record.intent.mode, "steady");
    assert(shaPattern.test(record.releaseIdentity.sha));
    assert.equal(record.intent.release, join(dirname(record.journal), "releases", record.releaseIdentity.sha));
    assert.equal(migrationNamespace(dirname(record.journal)).directory, record.journal);
    safeDirectory(record.journal);
    assert.deepEqual(readJson(join(directory, "intent.json")), record.intent);
    assert.equal(readFile(join(directory, "bootstrap.mjs")).sha256, record.assetSha256);
    assert.equal(readFile(join(dirname(fileURLToPath(import.meta.url)), "startup-profile.mjs")).sha256, record.assetSha256);
    assert.equal(readFile(fileURLToPath(import.meta.url), 0, 1024 * 1024).sha256, record.librarySha256);
    assert.equal(readFile(process.execPath, 0, 256 * 1024 * 1024).sha256, record.nodeSha256);
    assert.equal(process.version, record.intent.nodeVersion);
    assert.equal(record.drop.sha256, digest(dropBody(record.operation)));
  }
  function unusedArm(directory, record) {
    assert(!record.steadyRequest, "capture owner must close a requested steady capture");
    absent(join(directory, "steady-request.json"));
    for (const name of ["capture-claim.json", "capture-started.json", "capture-result.json", "capture-error.json"])
      absent(join(directory, "spool", name));
  }
  function registeredArm(directory, record) {
    armRecord(directory, record);
    unusedArm(directory, record);
    absent(join(directory, "steady-revoked.json"));
    const paths = operationPaths(record.operation);
    for (const path of [paths.unpublished, paths.drop, paths.pending]) absent(path);
    assert.equal(record.intent.bootId, bootId());
    assert(record.binding && running(record.binding.pid, record.binding.start));
    assert.deepEqual(processBinding(record.intent, record.binding.pid, record.binding.start), record.binding);
    assert.equal(realpathSync(join(dirname(record.journal), "current")), record.intent.release);
    assert.equal(realpathSync(`/proc/${record.binding.pid}/cwd`), record.intent.release);
    assert.equal(initialEnvironment(record.binding.pid).get("NODE_OPTIONS"), `--import=${join(directory, "bootstrap.mjs")}`);
    assert.deepEqual(JSON.parse(readFile(join(directory, "spool", "registration-ready.json"), record.intent.uid).bytes),
      { ...record.binding, armedUntilMicros: record.intent.armedUntilMicros });
    assert(mono() + 95_000_000 < record.intent.armedUntilMicros);
    sameEnvironment(record.before);
    assert.equal(systemProperty("ControlPID"), 0);
    assert.equal(systemProperty("Job", "Unit")[0], 0);
    assert(running(record.intent.owner.pid, record.intent.owner.start));
  }
  function retainDependency(directory, record) {
    let retained = false;
    if (record.intent.bootId === bootId()) {
      const dependency = record.retentionBinding ?? record.binding;
      if (dependency) {
        try { retained = generation(dependency.pid) === dependency.start; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!retained) {
        const pid = systemProperty("MainPID");
        if (pid) {
          const start = generation(pid);
          if (initialEnvironment(pid).get("NODE_OPTIONS") === `--import=${join(directory, "bootstrap.mjs")}`) {
            // A replacement may retain the bootstrap without this operation's capture authority.
            record.retentionBinding = processBinding(record.intent, pid, start);
            writeJson(join(directory, "record.json"), record);
            retained = true;
          } else if (!dependency)
            retained = !(pid === record.predecessor.pid && start === record.predecessor.start);
        } else retained = !dependency;
      }
    }
    return retained;
  }
  function closeContext(input) {
    const paths = operationPaths(input.operation);
    const published = lstatSync(paths.directory, { throwIfNoEntry: false });
    let record;
    if (published) {
      operationDirectory(input.operation);
      record = readJson(join(paths.directory, "record.json"));
      assert.equal(record.operation, input.operation);
      armRecord(paths.directory, record);
    }
    if (input.inspection) {
      const { inspection, ...request } = input;
      assert.equal(input.mode, "steady");
      assert.equal(inspection.requestSha256, digest(JSON.stringify(request)));
      assert.equal(migrationNamespace(dirname(input.journal)).directory, input.journal);
      safeDirectory(input.journal);
      assert.equal(inspection.bootId, bootId());
      assert.equal(inspection.librarySha256, readFile(fileURLToPath(import.meta.url), 0, 1024 * 1024).sha256);
      assert.equal(inspection.assetSha256, readFile(join(dirname(fileURLToPath(import.meta.url)), "startup-profile.mjs")).sha256);
      assert.equal(inspection.nodeSha256, readFile(process.execPath, 0, 256 * 1024 * 1024).sha256);
      if (record) {
        assert.deepEqual(record.before, inspection.before);
        assert.deepEqual(record.releaseIdentity, input.releaseIdentity);
        assert.deepEqual(record.predecessor, input.predecessor);
        assert.equal(record.journal, input.journal);
        assert.equal(record.assetSha256, inspection.assetSha256);
        assert.equal(record.librarySha256, inspection.librarySha256);
        assert.equal(record.nodeSha256, inspection.nodeSha256);
        assert.equal(record.activation.sha256, inspection.selectedActivationSha256);
        assert.deepEqual(record.intent.owner, input.owner);
      }
    } else {
      assert.deepEqual(Object.keys(input), ["operation"]);
      assert(record, "unpublished arm closure requires the successful inspection");
    }
    const before = record?.before ?? input.inspection.before;
    const journal = record?.journal ?? input.journal;
    return { ...paths, record, before, journal };
  }
  function closeReceiptPath(context, operation, create = false) {
    const archive = join(context.journal, `profile-${operation}`);
    if (create && !existsSync(archive)) {
      mkdirSync(archive, { mode: 0o700 });
      syncPath(context.journal);
    }
    safeDirectory(archive);
    return join(archive, "arm-close.json");
  }
  function verifyClosed(input) {
    const { request, receipt } = input;
    const context = closeContext(request);
    assert.equal(receipt.operation, request.operation);
    assert.equal(receipt.outcome, "closed");
    assert.equal(receipt.requestSha256, digest(JSON.stringify(request)));
    assert.deepEqual(readJson(closeReceiptPath(context, request.operation)), receipt);
    for (const path of [context.unpublished, context.drop, context.pending]) absent(path);
    if (context.record) {
      unusedArm(context.directory, context.record);
      absent(join(context.directory, "admission.json"));
      assert.equal(readJson(join(context.directory, "steady-revoked.json")).operation, request.operation);
      assert.equal(context.record.arm?.state, "closed");
    } else absent(context.directory);
    sameEnvironment(context.before);
    return receipt;
  }
  function closeArm(input) {
    assertProfileMutationLock();
    const context = closeContext(input);
    const { directory, unpublished, record, before } = context;
    const receiptPath = closeReceiptPath(context, input.operation, true);
    if (lstatSync(receiptPath, { throwIfNoEntry: false }))
      return verifyClosed({ request: input, receipt: readJson(receiptPath) });
    let reloadNeeded = false;
    if (record) {
      absent(unpublished);
      unusedArm(directory, record);
      // Establish revocation durably before removing admission or cached enablement.
      revokeSteady(directory, record);
      const admission = join(directory, "admission.json");
      if (lstatSync(admission, { throwIfNoEntry: false })) {
        assert.deepEqual(readJson(admission), record.binding);
        unlinkSync(admission);
        syncPath(directory);
      }
      reloadNeeded = removeEnablement(directory, record);
      if (reloadNeeded) syncPath(dropDirectory);
    } else {
      absent(context.drop);
      sameEnvironment(before);
      if (lstatSync(unpublished, { throwIfNoEntry: false })) {
        const metadata = lstatSync(unpublished);
        assert([0, input.gid].includes(metadata.gid));
        safeDirectory(unpublished, 0, metadata.gid);
        for (const name of readdirSync(unpublished)) {
          const path = join(unpublished, name), entry = lstatSync(path);
          if (name === "spool") {
            assert(entry.isDirectory() && !entry.isSymbolicLink() && [0, input.uid].includes(entry.uid) &&
              [0, input.gid].includes(entry.gid) && !(entry.mode & 0o077));
            assert.deepEqual(readdirSync(path), []);
          } else {
            assert(/^(bootstrap\.mjs|intent\.json|record\.json)(\.next\.[a-f0-9-]{36})?$/.test(name));
            assert(entry.isFile() && !entry.isSymbolicLink() && entry.uid === 0 &&
              [0, input.gid].includes(entry.gid) && !(entry.mode & 0o022) && entry.size <= 65536);
          }
        }
        const bootstrap = join(unpublished, "bootstrap.mjs");
        if (lstatSync(bootstrap, { throwIfNoEntry: false }))
          assert.equal(digest(readFileSync(bootstrap)), input.inspection.assetSha256);
        const intentPath = join(unpublished, "intent.json");
        let intent;
        if (lstatSync(intentPath, { throwIfNoEntry: false })) {
          intent = readJson(intentPath);
          assert.equal(intent.operation, input.operation);
          assert.equal(intent.mode, "steady");
          assert.equal(intent.bootId, input.inspection.bootId);
          assert.equal(intent.release, input.release);
          assert.deepEqual(intent.owner, input.owner);
          assert.equal(intent.uid, input.uid);
          assert.equal(intent.gid, input.gid);
        }
        const pendingRecord = join(unpublished, "record.json");
        if (lstatSync(pendingRecord, { throwIfNoEntry: false })) {
          const value = readJson(pendingRecord);
          assert.equal(value.operation, input.operation);
          assert.deepEqual(value.intent, intent);
          assert.deepEqual(value.before, before);
          assert.deepEqual(value.releaseIdentity, input.releaseIdentity);
          assert.equal(value.assetSha256, input.inspection.assetSha256);
          assert.equal(value.librarySha256, input.inspection.librarySha256);
          assert.equal(value.nodeSha256, input.inspection.nodeSha256);
          assert.equal(value.activation.sha256, input.inspection.selectedActivationSha256);
          assert.equal(value.drop.sha256, digest(dropBody(input.operation)));
        }
        if (lstatSync(context.pending, { throwIfNoEntry: false })) {
          assert.equal(readFile(context.pending).sha256, digest(dropBody(input.operation)));
          unlinkSync(context.pending);
          syncPath(dropDirectory);
        }
        rmSync(unpublished, { recursive: true });
        syncPath(namespace);
      } else absent(context.pending);
    }
    if (systemProperty("Environment").includes(`NODE_OPTIONS=--import=${join(directory, "bootstrap.mjs")}`) || reloadNeeded) {
      const reload = spawnSync("/usr/bin/busctl", ["--system", "call", "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Reload"],
      { encoding: "utf8", timeout: remaining(15000), maxBuffer: 65536 });
      assert.equal(reload.status, 0, "cannot reload closed profiling enablement");
    }
    sameEnvironment(before);
    if (record) {
      retainDependency(directory, record);
      record.arm = { state: "closed" };
      writeJson(join(directory, "record.json"), record);
    }
    const receipt = { operation: input.operation, outcome: "closed", requestSha256: digest(JSON.stringify(input)),
      atMonotonicMicros: mono() };
    atomicJson(receiptPath, receipt, { noReplace: true });
    return verifyClosed({ request: input, receipt });
  }
  function steadyResult(directory, record, result, uid) {
    const read = (name) => JSON.parse(readFile(join(directory, name), uid).bytes);
    const request = record.steadyRequest;
    assert.equal(result.mode, "steady");
    assert.deepEqual(result.request, request);
    assert.deepEqual(read("capture-claim.json"), { ...record.binding, nonce: request.nonce });
    const started = read("capture-started.json");
    assert.deepEqual(started, { request, recordingStartedMicros: result.recordingStartedMicros, pid: record.binding.pid });
    assert(request.issuedMicros <= result.recordingStartedMicros && result.recordingStartedMicros < request.admitBeforeMicros);
    const events = readFile(join(directory, "capture-events.jsonl"), uid).bytes.toString().trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.event), [
      "capture.start", "capture.stop-requested", "capture.stopped", "capture.stringify", "capture.complete", "capture.cleanup",
    ]);
    assert(events.every(event => event.pid === record.binding.pid));
    assert.equal(events.at(-1).listenerUrl, null);
    assert.equal(events[0].recordingStartedMicros, result.recordingStartedMicros);
    assert.equal(events[1].stopRequestedMicros, result.stopRequestedMicros);
    assert.equal(events[2].stoppedMicros, result.stoppedMicros);
    assert.deepEqual(events[4].profile, result.profile);
    const clocks = [request.issuedMicros, result.startRequestedMicros, result.recordingStartedMicros,
      events[0].atMonotonicMicros, result.stopRequestedMicros, events[1].atMonotonicMicros,
      result.stoppedMicros, ...events.slice(2).map(event => event.atMonotonicMicros), result.completedMicros];
    assert(clocks.every((clock, index) => Number.isSafeInteger(clock) && (index === 0 || clock >= clocks[index - 1])));
    const elapsedMs = (result.stopRequestedMicros - result.recordingStartedMicros) / 1000;
    assert.equal(result.actualStopAtMs, elapsedMs);
    if (result.stopReason === "duration") assert(elapsedMs >= result.durationMs);
    return { stopReason: result.stopReason, stopDelayMs: Math.max(0, elapsedMs - result.durationMs),
      deadlineExceeded: result.completedMicros > request.deadlineMicros,
      authorityAtCompletion: result.authorityAtCompletion === true };
  }
  async function archiveSpool(directory, record, label) {
    // Seal a completed snapshot once. A later completion or terminal exit gets a
    // separate snapshot, preserving the original incomplete diagnostic receipt.
    if (
      record.archiveReceipt &&
      (["complete", "collected"].includes(record.archiveReceipt.outcome) ||
        (label !== "owner-retirement" &&
          !existsSync(join(directory, "spool", "capture-result.json"))))
    )
      return record.archiveReceipt;
    const archive = join(record.journal, `profile-${record.operation}`);
    if (!existsSync(archive)) mkdirSync(archive, { mode: 0o700 });
    safeDirectory(archive);
    const destination = join(archive, `${mono()}-${label}`);
    mkdirSync(destination, { mode: 0o700 });
    const { archiveReceipt: previousReceipt, ...control } = record;
    writeJson(join(destination, "control.json"), control);
    const files = {};
    let failure, timing, steady;
    for (const name of [
      "admission-events.jsonl",
      "bootstrap-claim.json",
      "capture-claim.json",
      "capture-events.jsonl",
      "capture.cpuprofile",
      "capture-result.json",
      "capture-error.json",
      ...(record.intent.mode === "steady" ? ["registration-ready.json", "capture-started.json"] : []),
    ]) {
      if (label === "steady-collection") remaining(1);
      const source = join(directory, "spool", name);
      if (!existsSync(source)) continue;
      try {
        const value = readFile(
          source,
          record.intent.uid,
          name === "capture.cpuprofile" ? 64 * 1024 * 1024 : 65536,
        );
        atomicFile(join(destination, name), value.bytes);
        files[name] = { sha256: value.sha256, bytes: value.bytes.length };
      } catch {
        failure = "artifact-read-refused";
      }
    }
    let profile;
    if (!failure && files["capture-result.json"] && files["capture.cpuprofile"]) {
      try {
        const result = readJson(join(destination, "capture-result.json"));
        const { profileFacts } = await import("./startup-profile.mjs");
        profile = profileFacts(
          readFile(join(destination, "capture.cpuprofile"), 0, 64 * 1024 * 1024).bytes.toString(),
        );
        assert.deepEqual(profile, result.profile);
        assert.equal(result.pid, record.binding?.pid);
        assert.equal(result.version, record.intent.nodeVersion);
        assert.equal(result.listenerUrl, null);
        assert.equal(result.durationMs, 30000);
        assert.equal(result.sampleInterval, 5);
        if (record.intent.mode === "steady") steady = steadyResult(destination, record, result, 0);
        timing = {
          profileStartMs: result.profileStartMs,
          stopMs: result.stopMs,
          stringifyMs: result.stringifyMs,
          captureStartGapMs:
            record.processStartedMonotonicMicros === undefined
              ? null
              : (result.recordingStartedMicros - record.processStartedMonotonicMicros) / 1000,
        };
      } catch {
        failure = "profile-validation-refused";
      }
    }
    if (label === "steady-collection") remaining(1);
    const receipt = {
      operation: record.operation,
      release: record.releaseIdentity,
      binding: record.binding ?? null,
      label,
      files,
      profile: profile ?? null,
      timing: timing ?? null,
      outcome: record.intent.mode === "steady"
        ? (record.steadyRequest ? (profile && !failure ? "collected" : "incomplete") : "not-captured")
        : failure ?? (profile ? "complete" : "incomplete"),
      ...(record.intent.mode === "steady" ? { mode: "steady", dataComplete: !!profile && !failure,
        steady: steady ?? null, failure: failure ?? null } : {}),
      atMonotonicMicros: mono(),
    };
    writeJson(join(destination, "receipt.json"), receipt);
    record.archiveReceipt = receipt;
    writeJson(join(directory, "record.json"), record);
    return receipt;
  }
  async function captureSteady(input) {
    assert.equal(process.getuid(), 0);
    assert.equal(process.platform, "linux");
    assert.deepEqual(Object.keys(input).sort(), ["operation", "pid", "root", "sha", "start"]);
    assert(shaPattern.test(input.sha) && Number.isSafeInteger(input.pid) && input.pid > 0 && /^[1-9][0-9]*$/.test(input.start));
    let directory, record, issued = false, revoked = false, receipt, interrupted = false, wake;
    const interrupt = () => { interrupted = true; wake?.(); };
    const lock = process.env.OPENCLAW_TEAM_LOCK_FILE ?? "/run/openclaw-release-deploy.lock";
    safeDirectory(dirname(lock));
    const held = fstatSync(9), named = lstatSync(lock);
    assert(held.isFile() && named.isFile() && !named.isSymbolicLink() && held.uid === 0 && held.gid === 0 &&
      held.nlink === 1 && !(held.mode & 0o022) && held.dev === named.dev && held.ino === named.ino);
    // fdinfo selects this open file description, unlike /proc/locks' historical locking PID.
    const checkLock = () => {
      assert.deepEqual(fileIdentity(fstatSync(9)), fileIdentity(lstatSync(lock)));
      assert(/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(readFileSync("/proc/self/fdinfo/9", "utf8")));
    };
    const checkTime = () => { assert(!interrupted); remaining(1); checkLock(); };
    process.on("SIGTERM", interrupt);
    process.on("SIGINT", interrupt);
    const waitFor = (name, until) => new Promise((resolveWait) => {
      const spool = join(directory, "spool");
      let observer, timer;
      const done = (found = false) => { observer?.close(); clearTimeout(timer); wake = undefined; resolveWait(found); };
      const inspect = () => {
        if (interrupted || mono() >= until) { done(); return; }
        if (existsSync(join(spool, name))) done(true);
        else if (existsSync(join(spool, "capture-error.json"))) done();
      };
      try {
        observer = watch(spool, inspect);
        observer.once("error", () => done());
        timer = setTimeout(done, Math.max(0, (until - mono()) / 1000));
        wake = () => done();
        inspect();
      } catch { done(); }
    });
    try {
      // One bounded preflight, followed by one absolute capture/closeout budget.
      deadlineMicros = mono() + 30_000_000;
      checkTime();
      const namespace = migrationNamespace(input.root);
      directory = operationDirectory(input.operation);
      record = readJson(join(directory, "record.json"));
      assert.equal(record.operation, input.operation);
      assert.equal(record.intent.mode, "steady");
      assert.equal(record.journal, namespace.directory);
      assert.equal(record.releaseIdentity.sha, input.sha);
      if (record.binding) {
        assert.equal(record.binding.pid, input.pid);
        assert.equal(record.binding.start, input.start);
      }
      if (record.arm?.state === "closed") {
        process.exitCode = 1;
        return { operation: input.operation, outcome: "skipped-spent" };
      }
      if (record.arm?.state !== "terminal-eligible") {
        const closure = closeArm({ operation: input.operation });
        process.exitCode = 1;
        return { ...closure, outcome: "skipped-nonterminal", closure };
      }
      assert(/^[a-f0-9]{64}$/.test(record.arm.readinessSha256) && /^[a-f0-9]{64}$/.test(record.arm.channelsSha256));
      assert(!lstatSync(namespace.pathname, { throwIfNoEntry: false }));
      assert(!record.steadyRequest && !existsSync(join(directory, "steady-request.json")) &&
        !existsSync(join(directory, "steady-revoked.json")));
      assert.equal(record.intent.bootId, bootId());
      const release = join(input.root, "releases", input.sha);
      assert.equal(realpathSync(join(input.root, "current")), release);
      assert.equal(record.intent.release, release);
      assert.equal(record.releaseIdentity.sha, input.sha);
      const validation = spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url),
        "validate-release", release, input.sha, "0", "sealed"], {
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("OPENCLAW_TEAM_"))), PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
        encoding: "utf8", timeout: remaining(30000), killSignal: "SIGKILL", maxBuffer: 65536,
      });
      assert.equal(validation.status, 0);
      assert.deepEqual(JSON.parse(validation.stdout), record.releaseIdentity);
      assert.equal(readFile(fileURLToPath(import.meta.url), 0, 1024 * 1024).sha256, record.librarySha256);
      assert.equal(readFile(join(dirname(fileURLToPath(import.meta.url)), "startup-profile.mjs")).sha256, record.assetSha256);
      assert.equal(readFile(join(directory, "bootstrap.mjs")).sha256, record.assetSha256);
      assert.equal(readFile(process.execPath, 0, 256 * 1024 * 1024).sha256, record.nodeSha256);
      assert.equal(process.version, record.intent.nodeVersion);
      checkTime();
      sameEnvironment(record.before);
      if (record.before.conditions.some(condition => condition[0] === "ConditionPathExists" &&
          condition[3] === join(namespace.directory, migrationPermitName))) assert(migrationPermit(input.root));
      assert.equal(systemProperty("ControlPID"), 0);
      assert.equal(systemProperty("Job", "Unit")[0], 0);
      assert.deepEqual(processBinding(record.intent, input.pid, input.start), record.binding);
      assert(running(input.pid, input.start));
      assert.equal(realpathSync(`/proc/${input.pid}/cwd`), release);
      assert.equal(initialEnvironment(input.pid).get("NODE_OPTIONS"), `--import=${join(directory, "bootstrap.mjs")}`);
      assert.deepEqual(JSON.parse(readFile(join(directory, "spool", "registration-ready.json"), record.intent.uid).bytes),
        { ...record.binding, armedUntilMicros: record.intent.armedUntilMicros });
      for (const name of ["capture-claim.json", "capture-started.json", "capture-result.json", "capture-error.json"])
        assert(!existsSync(join(directory, "spool", name)));
      // Deployment may accept recognized load; this separate capture always requires strict readiness.
      for (const endpoint of ["startupz", "readyz"]) {
        const response = spawnSync(process.env.OPENCLAW_TEAM_CURL ?? "/usr/bin/curl", [
          "--disable", "--noproxy", "*", "--fail", "--silent", "--max-time", String(remaining(5000) / 1000),
          `http://127.0.0.1:18789/${endpoint}`,
        ], { encoding: "utf8", timeout: remaining(5000), killSignal: "SIGKILL", maxBuffer: 65536 });
        assert.equal(response.status, 0);
        const value = JSON.parse(response.stdout);
        if (endpoint === "startupz") assert(value.ok === true && value.status === "started");
        else {
          assert(value.ready === true && Array.isArray(value.failing) && value.failing.length === 0 &&
            Number.isFinite(value.uptimeMs) && value.uptimeMs >= 0);
          if (snapshotCpuWaived(value, true, "readiness")) {
            const closure = closeArm({ operation: input.operation });
            process.exitCode = 1;
            return { ...closure, outcome: "skipped-load", closure };
          }
        }
      }
      checkTime();
      assert(!lstatSync(namespace.pathname, { throwIfNoEntry: false }));
      assert.equal(realpathSync(join(input.root, "current")), release);
      assert.deepEqual(processBinding(record.intent, input.pid, input.start), record.binding);
      assert.equal(systemProperty("ControlPID"), 0);
      assert.equal(systemProperty("Job", "Unit")[0], 0);
      checkTime();
      const issuedMicros = mono();
      const request = { operation: record.operation, nonce: randomUUID(), owner: { pid: process.pid, start: generation(process.pid) },
        bootId: bootId(), binding: record.binding, issuedMicros, admitBeforeMicros: issuedMicros + 5_000_000,
        deadlineMicros: issuedMicros + 60_000_000 };
      assert(request.deadlineMicros <= record.intent.armedUntilMicros);
      deadlineMicros = request.deadlineMicros;
      record.steadyRequest = request;
      writeJson(join(directory, "record.json"), record);
      issued = true;
      writeJson(join(directory, "steady-request.json"), request, 0o440, record.intent.gid);
      assert(await waitFor("capture-started.json", request.admitBeforeMicros), "steady capture did not acknowledge admission");
      checkTime();
      const started = JSON.parse(readFile(join(directory, "spool", "capture-started.json"), record.intent.uid).bytes);
      assert.deepEqual(started.request, request);
      assert.equal(started.pid, input.pid);
      assert(issuedMicros <= started.recordingStartedMicros && started.recordingStartedMicros < request.admitBeforeMicros);
      process.stdout.write(`${JSON.stringify({ phase: "steady-capture-started", operation: record.operation, binding: record.binding,
        nonce: request.nonce, recordingStartedMicros: started.recordingStartedMicros })}\n`);
      assert(await waitFor("capture-result.json", deadlineMicros), "steady capture did not complete before closeout");
      checkTime();
    } catch (error) {
      if (!issued) throw error;
      record.steadyOutcome = { outcome: "incomplete", reason: interrupted ? "owner-interrupted" : "refused-or-deadline",
        atMonotonicMicros: mono() };
    } finally {
      try {
        if (issued) {
          // Revocation is cleanup, not another deadline-renewing operation. Always precedes unlock.
          revokeSteady(directory, record);
          revoked = true;
          writeJson(join(directory, "record.json"), record);
          if (mono() < deadlineMicros) {
            try { receipt = await archiveSpool(directory, record, "steady-collection"); }
            catch { record.steadyOutcome = { outcome: "incomplete", reason: "collection-refused", atMonotonicMicros: mono() }; }
          } else record.steadyOutcome ??= { outcome: "incomplete", reason: "closeout-deadline", atMonotonicMicros: mono() };
          record.steadyOutcome ??= {
            outcome: receipt?.dataComplete && receipt.steady?.stopReason === "duration" &&
              receipt.steady.authorityAtCompletion && !receipt.steady.deadlineExceeded ? "complete" : "incomplete",
            atMonotonicMicros: mono(),
          };
          writeJson(join(directory, "record.json"), record);
          // Collection describes bytes; only this owner can confirm timely closeout.
          // A slow final publication can downgrade success, never renew its deadline.
          if (record.steadyOutcome.outcome === "complete" && (interrupted || mono() >= deadlineMicros)) {
            record.steadyOutcome = { outcome: "incomplete", reason: "closeout-deadline", atMonotonicMicros: mono() };
            writeJson(join(directory, "record.json"), record);
          }
        }
      } finally {
        process.removeListener("SIGTERM", interrupt);
        process.removeListener("SIGINT", interrupt);
        // On revocation failure, retain the lock until process death invalidates the permit.
        if (!issued || revoked) closeSync(9);
      }
    }
    if (record.steadyOutcome?.outcome !== "complete") process.exitCode = 1;
    return { ...(receipt ?? { operation: record.operation, archiveDeferred: true }),
      ...record.steadyOutcome };
  }
  async function ownerCommand(command, input) {
    assert.equal(process.getuid(), 0);
    assert.equal(process.platform, "linux");
    if (["prepare", "admit", "disarm", "cleanup", "retire", "collect", "strict-observation", "terminalize-arm"].includes(command))
      assertProfileMutationLock();
    if (command === "capture-steady") return captureSteady(input);
    if (command === "no-effects") {
      assert.deepEqual(Object.keys(input), ["operation"]);
      for (const path of Object.values(operationPaths(input.operation))) absent(path);
      return { operation: input.operation, outcome: "skipped-no-effect" };
    }
    if (command === "close-arm") return closeArm(input);
    if (command === "verify-closed") return verifyClosed(input);
    if (command === "cleanup" || command === "retire") {
      if (!existsSync(namespace)) return { reload: false, operations: [] };
      safeDirectory(namespace);
      const operations = [];
      let reload = false;
      for (const operation of readdirSync(namespace)) {
        if (operation.startsWith(".pending-")) {
          const id = operation.slice(".pending-".length);
          assert(operationPattern.test(id));
          const directory = join(namespace, operation);
          safeDirectory(directory, 0, lstatSync(directory).gid);
          const paths = dropPaths(id);
          assert(!existsSync(paths.drop));
          if (existsSync(paths.pending)) {
            assert.equal(readFile(paths.pending).sha256, digest(dropBody(id)));
            unlinkSync(paths.pending);
          }
          rmSync(directory, { recursive: true });
          operations.push({ operation: id, unpublished: true });
          continue;
        }
        const directory = operationDirectory(operation),
          record = readJson(join(directory, "record.json"));
        assert.equal(record.operation, operation);
        if (command === "cleanup") {
          if (record.intent.mode === "steady" && input.retainArm !== record.operation) revokeSteady(directory, record);
          const removed = removeEnablement(directory, record);
          // A killed owner can unlink the file before systemd reloads its cached environment.
          reload =
            removed ||
            systemProperty("Environment").includes(
              `NODE_OPTIONS=--import=${join(directory, "bootstrap.mjs")}`,
            ) ||
            reload;
          rmSync(join(directory, "admission.json"), { force: true });
          operations.push({ operation });
          continue;
        }
        sameEnvironment(record.before);
        const retained = retainDependency(directory, record);
        if (retained && record.intent.mode === "steady" && record.binding &&
            running(record.binding.pid, record.binding.start) && !record.steadyRequest &&
            !existsSync(join(directory, "steady-revoked.json")) && mono() < record.intent.armedUntilMicros) {
          operations.push({ operation, retained, outcome: "armed" });
          continue;
        }
        const receipt = await archiveSpool(
          directory,
          record,
          retained ? "owner-cleanup" : "owner-retirement",
        );
        if (!retained) rmSync(directory, { recursive: true });
        operations.push({ operation, retained, outcome: receipt.outcome });
      }
      return { reload, operations };
    }
    if (command === "inspect" || command === "prepare") {
      assert(input.mode === undefined || input.mode === "steady");
      assert(operationPattern.test(input.operation));
      const executablePath = realpathSync(process.execPath);
      migrationAncestors(dirname(executablePath), 0);
      const nodeSha256 = readFile(executablePath, 0, 256 * 1024 * 1024).sha256;
      const activation = validJournal(readJson(input.activation));
      assert.equal(activation.phase, command === "inspect" ? "B_PREVIOUS_PUBLISHED" : "C_CURRENT_SELECTED");
      assert.equal(activation.topology, "system");
      assert.deepEqual(activation.candidate, input.releaseIdentity);
      assert.equal(activation.process.pid, input.predecessor.pid);
      assert.equal(activation.process.generation, input.predecessor.start);
      assert.equal(realpathSync(join(dirname(input.journal), "current")), command === "inspect"
        ? join(dirname(input.release), activation.predecessor.sha) : input.release);
      assert.equal(realpathSync(join(dirname(input.journal), "previous")),
        join(dirname(input.release), activation.predecessor.sha));
      migrationAncestors(dirname(namespace), 0);
      const namespaceEntry = lstatSync(namespace, { throwIfNoEntry: false });
      if (namespaceEntry) assert.equal(safeDirectory(namespace).mode & 0o777, 0o755);
      const journalNamespace = migrationNamespace(dirname(input.journal));
      assert.equal(journalNamespace.directory, input.journal);
      assert.equal(journalNamespace.pathname, input.activation);
      safeDirectory(input.release);
      assert.match(input.releaseIdentity.sha, /^[a-f0-9]{40}$/);
      assert.equal(basename(input.release), input.releaseIdentity.sha);
      assert.equal(statSync(input.release).mode & 0o777, 0o555);
      assert(
        Number.isSafeInteger(input.uid) &&
          input.uid > 0 &&
          Number.isSafeInteger(input.gid) &&
          input.gid > 0,
      );
      const observed = environmentSnapshot(undefined, input.uid);
      assert.equal(observed.type, "simple");
      assert.equal(observed.killMode, "control-group");
      assert.deepEqual(observed.execCondition, []);
      assert.equal(observed.command.length, 1);
      const [executable, argv, ignoreFailure] = observed.command[0];
      assert.equal(ignoreFailure, false);
      assert.equal(realpathSync(executable), realpathSync(process.execPath));
      assert.equal(argv.length, 5);
      assert.equal(realpathSync(argv[0]), realpathSync(process.execPath));
      assert.equal(argv[1], resolve(input.release, "../..", "current/dist/index.js"));
      assert.deepEqual(argv.slice(2), ["gateway", "--port", "18789"]);
      // Explicit stop/start must retain restart's signal and FD-store semantics.
      assertStopStartContract(Object.fromEntries([
        ...["KillSignal", "RestartKillSignal", "FileDescriptorStoreMax", "NFileDescriptorStore", "RuntimeDirectory"]
          .map(name => [name, systemProperty(name)]),
        ...stopStartRelations.map(name => [name, systemProperty(name, "Unit")]),
      ]));
      assert(running(input.owner.pid, input.owner.start));
      const asset = readFile(join(dirname(fileURLToPath(import.meta.url)), "startup-profile.mjs"));
      const { inspection: ignoredInspection, ...request } = input;
      const inspected = {
        requestSha256: digest(JSON.stringify(request)),
        bootId: bootId(), nodeSha256, assetSha256: asset.sha256,
        librarySha256: readFile(fileURLToPath(import.meta.url), 0, 1024 * 1024).sha256,
        // Only the owner's B -> C selection may change between live inspection and stopped preparation.
        activationSha256: digest(JSON.stringify({ ...activation, phase: "B_PREVIOUS_PUBLISHED" })),
        selectedActivationSha256: digest(JSON.stringify({ ...activation, phase: "C_CURRENT_SELECTED" })),
      };
      const capacity = statfsSync(namespaceEntry ? namespace : dirname(namespace));
      assert(capacity.bavail * capacity.bsize >= 64 * 1024 * 1024);
      assert(!existsSync(join(namespace, input.operation)));
      if (command === "inspect") {
        assert.equal(input.inspection, undefined);
        assert.equal(initialEnvironment(input.predecessor.pid).has("NODE_OPTIONS"), false);
        assert.equal(realpathSync(`/proc/${input.predecessor.pid}/exe`), executablePath);
        assert.equal(generation(input.predecessor.pid), input.predecessor.start);
        return { ...input, inspection: { ...inspected, before: observed } };
      }
      const { before, ...expectedInspection } = input.inspection;
      assert.deepEqual(inspected, expectedInspection);
      sameEnvironment(before, undefined, observed);
      assert(!running(input.predecessor.pid, input.predecessor.start));
      assert.equal(systemProperty("MainPID"), 0);
      assert.equal(systemProperty("ControlPID"), 0);
      assert.equal(systemProperty("Job", "Unit")[0], 0);
      assert(["inactive", "failed"].includes(systemProperty("ActiveState", "Unit")));
      if (!existsSync(namespace)) {
        mkdirSync(namespace, { mode: 0o755 });
        chmodSync(namespace, 0o755);
      }
      assert.equal(safeDirectory(namespace).mode & 0o777, 0o755);
      const directory = join(namespace, `.pending-${input.operation}`),
        published = join(namespace, input.operation);
      assert(!existsSync(published));
      mkdirSync(directory, { mode: 0o700 });
      atomicFile(join(directory, "bootstrap.mjs"), asset.bytes, 0o440, input.gid);
      mkdirSync(join(directory, "spool"), { mode: 0o700 });
      chownSync(join(directory, "spool"), input.uid, input.gid);
      chmodSync(join(directory, "spool"), 0o700);
      const entry = join(input.release, "dist/index.js");
      // Inspect the live predecessor before stop, then revalidate stable bindings.
      // Mint the single admission window only after that stop job has completed.
      const preparedMicros = mono();
      const intent = {
        operation: input.operation,
        ...(input.mode === "steady" ? { mode: "steady", armedUntilMicros: preparedMicros + 900_000_000 } : {}),
        bootId: bootId(),
        owner: input.owner,
        uid: input.uid,
        gid: input.gid,
        node: fileIdentity(statSync(process.execPath)),
        nodeVersion: process.version,
        release: input.release,
        entry,
        entryMetadata: fileIdentity(statSync(entry)),
        cgroup: `/system.slice/${unitName}`,
        expiresMicros: preparedMicros + 120000000,
      };
      writeJson(join(directory, "intent.json"), intent, 0o440, input.gid);
      if (!existsSync(dropDirectory)) mkdirSync(dropDirectory, { mode: 0o755 });
      safeDirectory(dropDirectory);
      const paths = dropPaths(input.operation);
      assert(!existsSync(paths.drop) && !existsSync(paths.pending));
      const fd = openSync(paths.pending, "wx", 0o644);
      try {
        writeFileSync(fd, dropBody(input.operation));
        fchmodSync(fd, 0o644);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const record = {
        operation: input.operation,
        ...(input.mode === "steady" ? { arm: { state: "pending" } } : {}),
        intent,
        releaseIdentity: input.releaseIdentity,
        journal: input.journal,
        predecessor: input.predecessor,
        before,
        drop: readFile(paths.pending),
        assetSha256: asset.sha256,
        ...(input.mode === "steady" ? { librarySha256: readFile(fileURLToPath(import.meta.url), 0, 1024 * 1024).sha256 } : {}),
        nodeSha256,
        activation: { path: input.activation, sha256: digest(JSON.stringify(activation)) },
      };
      delete record.drop.bytes;
      writeJson(join(directory, "record.json"), record);
      chownSync(directory, 0, input.gid);
      chmodSync(directory, 0o750);
      // The runtime path becomes visible only after the complete owner record is durable.
      assert(running(input.owner.pid, input.owner.start));
      renameSync(directory, published);
      syncPath(namespace);
      assert(running(input.owner.pid, input.owner.start));
      renameSync(paths.pending, paths.drop);
      syncPath(dropDirectory);
      return { operation: input.operation, reload: true };
    }
    const directory = operationDirectory(input.operation),
      record = readJson(join(directory, "record.json"));
    assert.equal(record.operation, input.operation);
    if (command === "strict-observation") {
      assert.equal(record.arm?.state, "pending");
      const readinessWaived = snapshotCpuWaived(input.readiness, true, "readiness", true);
      const channelsWaived = snapshotCpuWaived(input.channels, true, "channels", true);
      assert(input.readiness.ready === true && Array.isArray(input.readiness.failing) &&
        input.readiness.failing.length === 0 && Number.isFinite(input.readiness.uptimeMs) && input.readiness.uptimeMs >= 0);
      verifyChannelAccounts(input.channels);
      assert.equal(input.convergenceState, readinessWaived || channelsWaived ? "READY_CPU_DEGRADED_OPERATOR_WAIVED" : "READY");
      assert.equal(input.channelState, channelsWaived ? "CHANNELS_CPU_DEGRADED_OPERATOR_WAIVED" : "CHANNELS_OK");
      if (input.readiness.eventLoop.degraded || input.channels.eventLoop.degraded) return { operation: record.operation, outcome: "ineligible-load" };
      registeredArm(directory, record);
      record.arm = { state: "strict-observed", readinessSha256: digest(JSON.stringify(input.readiness)),
        channelsSha256: digest(JSON.stringify(input.channels)) };
      writeJson(join(directory, "record.json"), record);
      return { operation: record.operation, outcome: "strict-observed" };
    }
    if (command === "terminalize-arm") {
      assert.deepEqual(Object.keys(input), ["operation"]);
      assert.equal(record.arm?.state, "strict-observed");
      assert(/^[a-f0-9]{64}$/.test(record.arm.readinessSha256) && /^[a-f0-9]{64}$/.test(record.arm.channelsSha256));
      absent(migrationNamespace(dirname(record.journal)).pathname);
      registeredArm(directory, record);
      record.arm.state = "terminal-eligible";
      writeJson(join(directory, "record.json"), record);
      return { operation: record.operation, outcome: "terminal-eligible", binding: record.binding,
        armedUntilMicros: record.intent.armedUntilMicros };
    }
    if (command === "registered") {
      assert.equal(record.intent.mode, "steady");
      assert.deepEqual(JSON.parse(readFile(join(directory, "spool", "registration-ready.json"), record.intent.uid).bytes),
        { ...record.binding, armedUntilMicros: record.intent.armedUntilMicros });
      assert(mono() < record.intent.armedUntilMicros);
      return { operation: record.operation, binding: record.binding, mode: "steady", armedUntilMicros: record.intent.armedUntilMicros };
    }
    if (command === "verify-environment") {
      sameEnvironment(
        record.before,
        input.armed ? `--import=${join(directory, "bootstrap.mjs")}` : undefined,
      );
      return { verified: true };
    }
    if (command === "admit") {
      assert.deepEqual(readJson(join(directory, "intent.json")), record.intent);
      assert.equal(readFile(join(directory, "bootstrap.mjs")).sha256, record.assetSha256);
      assert.equal(
        digest(JSON.stringify(readJson(record.activation.path))),
        record.activation.sha256,
      );
      assert.equal(record.intent.bootId, bootId());
      assert(mono() < record.intent.expiresMicros);
      assert.equal(generation(record.intent.owner.pid), record.intent.owner.start);
      const environment = sameEnvironment(
        record.before,
        `--import=${join(directory, "bootstrap.mjs")}`,
      );
      assert(environment.conditions.every((condition) => condition[4] > 0));
      assert.equal(realpathSync(`/proc/${input.pid}/cwd`), record.intent.release);
      const binding = processBinding(record.intent, input.pid, input.start);
      assert.match(binding.invocationId, /^[a-f0-9]{32}$/);
      assert.equal(
        initialEnvironment(input.pid).get("NODE_OPTIONS"),
        `--import=${join(directory, "bootstrap.mjs")}`,
      );
      record.binding = binding;
      record.processStartedMonotonicMicros = systemProperty("ExecMainStartTimestampMonotonic");
      record.admittedMonotonicMicros = mono();
      assert(
        Number.isSafeInteger(record.processStartedMonotonicMicros) &&
          record.processStartedMonotonicMicros > 0 &&
          record.processStartedMonotonicMicros <= record.admittedMonotonicMicros,
      );
      assert.equal(systemProperty("MainPID"), input.pid);
      assert.equal(generation(input.pid), input.start);
      writeJson(join(directory, "record.json"), record);
      writeJson(join(directory, "admission.json"), binding, 0o440, record.intent.gid);
      return { admitted: true, binding };
    }
    if (command === "disarm") return { reload: removeEnablement(directory, record) };
    if (command === "collect") {
      assert.notEqual(record.intent.mode, "steady", "deferred capture requires its canonical capture owner");
      if (input.wait)
        await new Promise((resolve) => {
          const spool = join(directory, "spool");
          let watcher, timer;
          const stop = () => {
            watcher?.close();
            clearTimeout(timer);
            resolve();
          };
          const inspect = () => {
            if (
              existsSync(join(spool, "capture-result.json")) ||
              existsSync(join(spool, "capture-error.json"))
            )
              stop();
          };
          watcher = watch(spool, inspect);
          watcher.once("error", stop);
          timer = setTimeout(stop, 35000);
          inspect();
        });
      rmSync(join(directory, "admission.json"), { force: true });
      const receipt = await archiveSpool(directory, record, "owner-collection");
      if (receipt.outcome !== "complete")
        process.stderr.write(
          "STARTUP_PROFILE_INCOMPLETE phase=collection deployment-outcome=separate\n",
        );
      return receipt;
    }
    throw new Error("unknown profiling owner command");
  }
  return ownerCommand(command, input);
}

const repairNativeUnit = "openclaw-gateway.service";
const repairNativeGroup = "/system.slice/openclaw-gateway.service";
const repairNativeLibrary = "/usr/local/lib/openclaw-team/release-lib.mjs";
const repairNativeNode = "/usr/bin/node";
const repairGuardPrefix = "zzzz-openclaw-retained-repair-";
const repairUnsetEnvironment = ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT"];
const repairNativeProperties = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlPID",
  "Job", "UnitFileState", "ExecMainPID", "InvocationID", "ExecMainStartTimestampMonotonic", "ControlGroup"];

function repairNativeRoots() {
  const boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
  const proc = process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc";
  for (const pathname of [boundary, proc]) {
    if (!isAbsolute(pathname) || resolve(pathname) !== pathname || realpathSync(pathname) !== pathname ||
        !lstatSync(pathname).isDirectory()) reject("repair native observation root is not canonical");
  }
  return { boundary, proc };
}
function repairNativeRun(executable, argv) {
  // Test overrides select external executables only; never permit a shell/eval string.
  runtimeLiteral(executable);
  const result = spawnSync(executable, argv, { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", SYSTEMD_COLORS: "0", SYSTEMD_PAGER: "cat" } });
  if (result.error || result.signal || result.status !== 0) reject("repair native command did not produce a complete observation");
  return result.stdout;
}
function repairSystemctl(argv) {
  return repairNativeRun(process.env.OPENCLAW_TEAM_SYSTEMCTL ?? "/usr/bin/systemctl", argv);
}
function repairNativeShow(unit, extra = []) {
  const names = [...repairNativeProperties, ...extra];
  const raw = repairSystemctl(["show", unit, ...names.map(name => "--property=" + name)]);
  const fields = {};
  for (const line of raw.replace(/\n$/, "").split("\n")) {
    const split = line.indexOf("="), name = line.slice(0, split);
    if (split < 1 || !names.includes(name) || Object.hasOwn(fields, name)) reject("repair native properties are ambiguous");
    fields[name] = line.slice(split + 1);
  }
  if (Object.keys(fields).length !== names.length || fields.Id !== unit || fields.LoadState !== "loaded")
    reject("repair native properties are incomplete or not loaded");
  return fields;
}
function repairNativeBusProperty(name) {
  const executable = process.env.OPENCLAW_TEAM_BUSCTL ?? "/usr/bin/busctl";
  const unit = migrationJson(Buffer.from(repairNativeRun(executable, ["--system", "--json=short", "call",
    "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", "s", repairNativeUnit])));
  if (unit?.type !== "o" || !Array.isArray(unit.data) || unit.data.length !== 1 ||
      !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(unit.data[0])) reject("repair native unit path is not typed");
  return migrationJson(Buffer.from(repairNativeRun(executable, ["--system", "--json=short", "get-property",
    "org.freedesktop.systemd1", unit.data[0], "org.freedesktop.systemd1.Service", name])));
}
function repairNativeNoJobs(uid) {
  // A dead manager cannot have user jobs; its recursive cgroup population is checked below.
  const raw = repairSystemctl(["list-jobs", "--no-legend", "--no-pager", "--plain"]);
  for (const line of raw.split("\n").filter(line => line.trim())) {
    const words = line.trim().split(/\s+/);
    if (words.length !== 4 || !/^[1-9]\d*$/.test(words[0])) reject("repair system job list is ambiguous");
    if (words[1] === repairNativeUnit || words[1] === "user@" + uid + ".service" ||
        words[1] === "user-runtime-dir@" + uid + ".service") reject("repair has a competing owner or queued job");
  }
}
function repairNativeManagerStopped(uid, boundary) {
  const managerState = repairNativeShow("user@" + uid + ".service");
  if (managerState.ActiveState === "active" && managerState.SubState === "running") {
    // Other user services (notably containers) are not Gateway owners. Observe only
    // the disabled user Gateway and its jobs; a missing bus is not proof of absence.
    const user = (args) => repairNativeRun("/usr/sbin/runuser", ["-u", "openclaw", "--",
      "/usr/bin/env", "XDG_RUNTIME_DIR=/run/user/" + uid,
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + uid + "/bus",
      process.env.OPENCLAW_TEAM_SYSTEMCTL ?? "/usr/bin/systemctl", "--user", ...args]);
    if (statSync("/run/user/" + uid).uid !== uid) reject("repair user runtime ownership changed");
    const names = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlPID", "Job", "UnitFileState", "ControlGroup"];
    const lines = user(["show", repairNativeUnit, ...names.map(name => "--property=" + name)]).trim().split(String.fromCharCode(10));
    const fields = {};
    for (const line of lines) {
      const i = line.indexOf("="), key = line.slice(0, i);
      if (i < 1 || !names.includes(key) || Object.hasOwn(fields, key)) reject("repair user Gateway properties are ambiguous");
      fields[key] = line.slice(i + 1);
    }
    if (Object.keys(fields).length !== names.length || fields.Id !== repairNativeUnit || fields.LoadState !== "loaded" ||
        fields.ActiveState !== "inactive" || fields.SubState !== "dead" || fields.MainPID !== "0" || fields.ControlPID !== "0" ||
        !["", "0"].includes(fields.Job) || fields.UnitFileState !== "disabled" || fields.ControlGroup !== "")
      reject("repair user Gateway is not positively disabled and stopped");
    for (const line of user(["list-jobs", "--no-legend", "--no-pager", "--plain"]).split(String.fromCharCode(10)).filter(line => line.trim())) {
      const words = line.trim().split(/\s+/);
      if (words.length !== 4 || !/^[1-9]\d*$/.test(words[0])) reject("repair user job list is ambiguous");
      if (words[1] === repairNativeUnit) reject("repair has a competing user Gateway job");
    }
    return fields;
  }
  const unit = "user@" + uid + ".service", manager = repairNativeShow(unit);
  if (manager.ActiveState !== "inactive" || manager.SubState !== "dead" || manager.MainPID !== "0" ||
      manager.ControlPID !== "0" || !["", "0"].includes(manager.Job)) reject("repair user manager is not positively stopped");
  const group = "/user.slice/user-" + uid + ".slice/user@" + uid + ".service";
  if (!["", group].includes(manager.ControlGroup)) reject("repair user manager cgroup changed");
  const croot = join(boundary, "sys/fs/cgroup");
  migrationAncestors(croot, migrationOwner(), boundary);
  let current = croot;
  for (const [index, part] of group.slice(1).split("/").entries()) {
    current = join(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (!entry) return manager;
    exactDirectory(current, index === 2 && entry.uid === uid ? uid : migrationOwner(), "repair user cgroup",
      { group: index === 2 ? entry.gid : rootGroup() });
  }
  assertUnpopulatedCgroup(current, "repair user manager");
  return manager;
}
function repairNativeStoppedGroup(boundary) {
  const root = join(boundary, "sys/fs/cgroup");
  migrationAncestors(root, migrationOwner(), boundary);
  let current = root;
  for (const part of repairNativeGroup.slice(1).split("/")) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })) return;
    exactDirectory(current, migrationOwner(), "repair system cgroup");
  }
  assertUnpopulatedCgroup(current, "repair system Gateway");
}
function repairNativeListeners(port, pid = null) {
  const raw = repairNativeRun(process.env.OPENCLAW_TEAM_SS ?? "/usr/bin/ss", ["-H", "-ltnp", "sport = :" + port]);
  const lines = raw.split("\n").filter(line => line.trim()), families = new Set();
  if (pid === null) {
    if (lines.length) reject("repair stopped custody still has a listener");
    return [];
  }
  if (!lines.length || lines.length > 2) reject("repair Gateway does not have exact loopback listeners");
  const listeners = lines.map(line => {
    const columns = line.trim().split(/\s+/);
    const match = /^(127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(columns[3] ?? "");
    const pids = [...line.matchAll(/pid=([0-9]+)/g)].map(match => Number(match[1]));
    if (columns[0] !== "LISTEN" || !match || Number(match[2]) !== port || families.has(match[1]) ||
        pids.length !== 1 || pids[0] !== pid) reject("repair listener is wildcard, duplicated, hidden, or owned by another process");
    families.add(match[1]);
    return { address: match[1], port, pid };
  });
  return listeners.sort((a, b) => a.address.localeCompare(b.address));
}
function repairNativeBinding(root, binding) {
  suspensionObject(binding, ["pid", "generation", "release", "runtime", "uid", "port"], "repair process binding");
  if (!Number.isSafeInteger(binding.pid) || binding.pid < 1 || !/^[1-9]\d*$/.test(binding.generation) ||
      !Number.isSafeInteger(binding.uid) || binding.uid < 0 || !Number.isSafeInteger(binding.port) ||
      binding.port < 1 || binding.port > 65535) reject("repair process binding is invalid");
  runtimeLiteral(binding.runtime);
  if (!shaPattern.test(basename(binding.release)) || binding.release !== join(root, "releases", basename(binding.release)) ||
      realpathSync(binding.release) !== binding.release) reject("repair process release is not canonical");
  return binding;
}
function repairNativeProcess(root, binding) {
  repairNativeBinding(root, binding);
  const { proc } = repairNativeRoots(), directory = join(proc, String(binding.pid));
  const stat = readFileSync(join(directory, "stat"), "utf8"), separator = stat.lastIndexOf(") ");
  const fields = stat.slice(separator + 2).trim().split(/\s+/);
  if (!stat.startsWith(binding.pid + " (") || separator < 0 || fields[19] !== binding.generation ||
      ["Z", "X", "x", "T", "t"].includes(fields[0]) || statSync(directory).uid !== binding.uid ||
      realpathSync(join(directory, "cwd")) !== binding.release ||
      realpathSync(join(directory, "exe")) !== realpathSync(binding.runtime) ||
      readFileSync(join(directory, "cgroup"), "utf8") !== "0::" + repairNativeGroup + "\n")
    reject("repair process generation, owner, runtime, release, or cgroup changed");
  // process.title rewrites Linux cmdline; systemd retains the launched command.
  const command = repairNativeBusProperty("ExecStart"), row = command?.data?.[0], argv = row?.[1];
  if (command?.type !== "a(sasbttttuii)" || command.data.length !== 1 ||
      !Array.isArray(row) || row.length !== 10 || row[2] !== false || !Array.isArray(argv) || argv.length !== 5 ||
      realpathSync(row[0]) !== realpathSync(binding.runtime) || realpathSync(argv[0]) !== realpathSync(binding.runtime) ||
      ![join(root, "current/dist/index.js"), join(binding.release, "dist/index.js")].includes(argv[1]) ||
      argv[2] !== "gateway" || argv[3] !== "--port" || argv[4] !== String(binding.port)) reject("repair native launch command changed");
  const bootId = readFileSync(join(proc, "sys/kernel/random/boot_id"), "utf8").trim();
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(bootId)) reject("repair boot identity is unavailable");
  return { ...binding, bootId, cgroup: repairNativeGroup };
}
function retainedRepairObserveLive(root, binding) {
  migrationNamespace(root);
  repairNativeBinding(root, binding);
  const { boundary } = repairNativeRoots();
  const capture = () => {
    const unit = repairNativeShow(repairNativeUnit), manager = repairNativeManagerStopped(binding.uid, boundary);
    if (unit.ActiveState !== "active" || unit.SubState !== "running" || unit.MainPID !== String(binding.pid) ||
        unit.ExecMainPID !== String(binding.pid) || unit.ControlPID !== "0" || !["", "0"].includes(unit.Job) ||
        unit.UnitFileState !== "enabled" || unit.ControlGroup !== repairNativeGroup ||
        !/^[a-f0-9]{32}$/.test(unit.InvocationID) || !/^[1-9]\d*$/.test(unit.ExecMainStartTimestampMonotonic))
      reject("repair system Gateway is not the exclusive live owner");
    repairNativeNoJobs(binding.uid);
    return { process: repairNativeProcess(root, binding), invocationId: unit.InvocationID,
      startedAtMonotonic: unit.ExecMainStartTimestampMonotonic, unit, userManager: manager,
      listeners: repairNativeListeners(binding.port, binding.pid) };
  };
  const before = capture(), after = capture();
  if (!isDeepStrictEqual(before, after)) reject("repair live custody changed during native observation");
  return before;
}
function retainedRepairObserveStopped(root, owner, targets) {
  const { bootId: expectedBootId, cgroup: expectedCgroup, ...binding } = owner.process;
  repairNativeBinding(root, binding);
  if (expectedCgroup !== repairNativeGroup) reject("repair stopped cgroup binding changed");
  if (!/^[a-f0-9]{32}$/.test(owner.invocationId) || !/^[1-9]\d*$/.test(owner.startedAtMonotonic))
    reject("repair stopped custody lacks the exact previous native owner");
  if (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length)
    reject("repair stopped custody requires the complete unique writer target list");
  for (const path of targets) { runtimeLiteral(path); }
  const { proc, boundary } = repairNativeRoots();
  const capture = () => {
    if (lstatSync(join(proc, String(owner.process.pid)), { throwIfNoEntry: false })) reject("repair old PID is not absent");
    const bootId = readFileSync(join(proc, "sys/kernel/random/boot_id"), "utf8").trim();
    if (bootId !== owner.process.bootId) reject("repair host rebooted since native owner observation");
    const unit = repairNativeShow(repairNativeUnit), manager = repairNativeManagerStopped(owner.process.uid, boundary);
    if (!((unit.ActiveState === "inactive" && unit.SubState === "dead") ||
        (unit.ActiveState === "failed" && unit.SubState === "failed")) || unit.MainPID !== "0" ||
        unit.ControlPID !== "0" || !["", "0"].includes(unit.Job) || unit.UnitFileState !== "enabled" ||
        unit.ExecMainPID !== String(owner.process.pid) || unit.InvocationID !== owner.invocationId ||
        unit.ExecMainStartTimestampMonotonic !== owner.startedAtMonotonic || !["", repairNativeGroup].includes(unit.ControlGroup))
      reject("repair system owner, control, history, or job has not settled");
    repairNativeNoJobs(owner.process.uid);
    repairNativeStoppedGroup(boundary);
    repairNativeListeners(owner.process.port);
    assertDatabaseWritersStopped(new Set(targets), proc);
    return { unit, userManager: manager, bootId, oldPid: owner.process.pid, uid: owner.process.uid, port: owner.process.port, targets: [...targets] };
  };
  const before = capture(), after = capture();
  if (!isDeepStrictEqual(before, after)) reject("repair stopped custody changed during native observation");
  return before;
}
function repairNativeCanonical(root, operation, phases) {
  const paths = retainedRepairPaths(root, operation);
  const file = migrationFile(paths.pathname, paths.owner, { mode: 0o600, limit: migrationJournalLimit });
  const record = validRetainedRepairJournal(migrationJson(file.bytes)); // parent's canonical typed validator
  if (record.operation !== operation || record.version !== 2 || record.kind !== "retained-repair" ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 0 || !phases.includes(record.phase) ||
      !record.lifecycle || typeof record.lifecycle !== "object" || Array.isArray(record.lifecycle))
    reject("repair native helper refuses this canonical operation or phase");
  return { paths, file, record };
}
function repairNativeGuardPath(root, operation) {
  retainedRepairPaths(root, operation);
  return join(repairNativeRoots().boundary, "etc/systemd/system", repairNativeUnit + ".d", repairGuardPrefix + operation + ".conf");
}
function repairNativeGuardBody(root, operation) {
  retainedRepairPaths(root, operation); runtimeLiteral(root);
  return "[Service]\nRestart=no\nUnsetEnvironment=" + repairUnsetEnvironment.join(" ") + "\nExecCondition=+" +
    repairNativeNode + " " + repairNativeLibrary + " retained-repair-start-claim " + root + " " + operation + "\n";
}
function repairNativeConfig(root, operation) {
  const { boundary } = repairNativeRoots(), owner = migrationOwner();
  const unit = repairNativeShow(repairNativeUnit, ["FragmentPath", "DropInPaths"]);
  const fragment = join(boundary, "etc/systemd/system", repairNativeUnit);
  if (unit.FragmentPath !== fragment) reject("repair requires the persistent canonical service fragment");
  migrationAncestors(dirname(fragment), owner, boundary);
  const base = migrationFile(fragment, owner, { privateOnly: false, limit: migrationJournalLimit }).descriptor;
  const guard = repairNativeGuardPath(root, operation), directory = dirname(guard);
  if (!lstatSync(directory, { throwIfNoEntry: false })) return { base, dropIns: [] };
  exactDirectory(directory, owner, "repair drop-in directory");
  const dropIns = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".conf")) continue;
    if (name.startsWith(repairGuardPrefix) && join(directory, name) !== guard) reject("repair refuses another operation's guard");
    if (join(directory, name) === guard) continue;
    dropIns.push(migrationFile(join(directory, name), owner, { privateOnly: false, limit: migrationJournalLimit }).descriptor);
  }
  // Refuse inherited/vendor/runtime drop-ins we cannot preserve through this fixed namespace.
  const expected = new Set([...dropIns.map(file => file.path), guard]);
  const effective = unit.DropInPaths === "" ? [] : unit.DropInPaths.split(" ");
  // systemctl set-property persists resource policy in system.control, outside
  // the handwritten drop-in directory. Preserve those root-owned inputs too.
  const propertyDirectory = join(boundary, "etc/systemd/system.control", repairNativeUnit + ".d");
  for (const path of effective.filter(path => !expected.has(path))) {
    if (dirname(path) !== propertyDirectory || !basename(path).endsWith(".conf"))
      reject("repair has an unowned drop-in configuration");
    migrationAncestors(propertyDirectory, owner, boundary);
    dropIns.push(migrationFile(path, owner, { privateOnly: false, limit: migrationJournalLimit }).descriptor);
  }
  if (dropIns.some(file => !effective.includes(file.path)))
    reject("repair has a stale drop-in configuration");
  return { base, dropIns };
}
function repairNativeGuardFile(root, operation, descriptor) {
  const path = repairNativeGuardPath(root, operation);
  migrationAncestors(dirname(path), migrationOwner(), repairNativeRoots().boundary);
  if (descriptor.path !== path) reject("repair guard escaped the fixed operation namespace");
  validMigrationDescriptor(descriptor, "path", "repair guard");
  const file = migrationFile(path, migrationOwner(), { privateOnly: false, mode: 0o644, limit: 8192 });
  if (!isDeepStrictEqual(file.descriptor, descriptor) || !file.bytes.equals(Buffer.from(repairNativeGuardBody(root, operation))))
    reject("repair guard was replaced or changed");
  return file;
}
function retainedRepairVerifyGuard(root, operation, guard) {
  suspensionObject(guard, ["descriptor", "baseline"], "repair guard receipt");
  repairNativeGuardFile(root, operation, guard.descriptor);
  if (!isDeepStrictEqual(repairNativeConfig(root, operation), guard.baseline)) reject("repair unrelated configuration changed");
  const unit = repairNativeShow(repairNativeUnit, ["Restart", "DropInPaths"]);
  if (unit.Restart !== "no" || !unit.DropInPaths.split(" ").includes(guard.descriptor.path)) reject("repair guard is not effective");
  const exec = repairNativeBusProperty("ExecConditionEx"), unset = repairNativeBusProperty("UnsetEnvironment");
  const argv = [repairNativeNode, repairNativeLibrary, "retained-repair-start-claim", root, operation];
  const row = exec?.data?.[0];
  if (exec?.type !== "a(sasasttttuii)" || exec.data.length !== 1 || !Array.isArray(row) || row.length !== 10 ||
      row[0] !== repairNativeNode || !isDeepStrictEqual(row[1], argv) || !isDeepStrictEqual(row[2], ["privileged"]) ||
      unset?.type !== "as" || !Array.isArray(unset.data) || repairUnsetEnvironment.some(name => !unset.data.includes(name)))
    reject("repair native executable condition or environment fence is not exact");
  return "REPAIR_GUARD_VERIFIED";
}
function retainedRepairStartCapability(root, operation, intent) {
  suspensionObject(intent, ["sequence", "build", "floor", "stopped", "target", "permit"], "repair capability intent");
  const { sequence, build, floor, stopped, target, permit } = intent;
  validMigrationDescriptor(build, "path", "repair capability build");
  validMigrationDescriptor(floor, "path", "repair capability floor");
  // Pure constructor. The parent validates its next START_INTENT and publishes these
  // bytes via retainedRepairFile under EX custody; this is not an authority Boolean.
  const paths = retainedRepairPaths(root, operation);
  if (!Number.isSafeInteger(sequence) || sequence < 1) reject("repair capability sequence is invalid");
  validMigrationDescriptor(stopped, "path", "repair stopped evidence");
  validMigrationDescriptor(permit, "path", "repair migration permit");
  if (stopped.path !== paths.prefix + ".stopped.json" || permit.path !== join(paths.directory, migrationPermitName))
    reject("repair capability evidence escaped its fixed namespace");
  suspensionObject(target, ["release", "runtime"], "repair start target");
  runtimeLiteral(target.runtime);
  if (target.release !== join(root, "releases", basename(target.release)) || !shaPattern.test(basename(target.release)))
    reject("repair capability target is not a fixed release");
  return { version: 1, kind: "retained-repair-start-capability", operation, sequence, build, floor, stopped, target, permit };
}
function repairNativeBoundArtifact(descriptor) {
  validMigrationDescriptor(descriptor, "path", "repair bound artifact");
  const file = migrationFile(descriptor.path, migrationOwner(), { mode: 0o600, limit: retainedArtifactLimit(descriptor.path) });
  if (!isDeepStrictEqual(file.descriptor, descriptor)) reject("repair bound artifact changed");
  return file;
}
function repairNativeClaimStopped(stoppedFile) {
  // Parent stopped capsule stores this helper's result at .native alongside its
  // current SQLite schema/history proof. We only recheck native custody here.
  const native = migrationJson(stoppedFile.bytes).native;
  if (!native || !Number.isSafeInteger(native.oldPid) || native.oldPid < 1 ||
      !Number.isSafeInteger(native.uid) || native.uid < 0 || !Number.isSafeInteger(native.port) ||
      native.port < 1 || native.port > 65535 || !Array.isArray(native.targets) || !native.targets.length ||
      new Set(native.targets).size !== native.targets.length) reject("repair stopped capsule lacks exact native custody");
  const { proc, boundary } = repairNativeRoots();
  if (lstatSync(join(proc, String(native.oldPid)), { throwIfNoEntry: false }) ||
      readFileSync(join(proc, "sys/kernel/random/boot_id"), "utf8").trim() !== native.bootId)
    reject("repair stopped custody lost its absent predecessor or boot identity");
  for (const path of native.targets) runtimeLiteral(path);
  repairNativeManagerStopped(native.uid, boundary);
  repairNativeListeners(native.port);
  assertDatabaseWritersStopped(new Set(native.targets), proc);
}
function repairNativeClaimCore(root, operation) {
  // Private durability core; only retainedRepairStartClaim is exposed by the dispatcher.
  // Deliberately no FD9 requirement: systemd's root ExecCondition has no parent FD.
  const { paths, file, record } = repairNativeCanonical(root, operation, ["REPAIR_START_INTENT"]);
  const start = record.lifecycle.startIntent;
  if (!Number.isSafeInteger(start.deadlineMs) || Date.now() >= start.deadlineMs) reject("repair original start deadline expired");
  retainedRepairClaimEvidence(root,record);
  suspensionObject(start, ["selected","deadlineMs","guard","predecessor","capability", "stopped", "target", "permit"], "repair canonical start intent");
  validMigrationDescriptor(start.capability, "path", "repair one-shot capability");
  if (start.capability.path !== paths.prefix + ".start-capability.json") reject("repair capability escaped operation namespace");
  const expected = retainedRepairStartCapability(root, operation, { sequence: record.sequence, build: record.build, floor: record.floor,
    stopped: start.stopped, target: start.target, permit: start.permit });
  for (const descriptor of [record.build, record.floor, start.stopped, start.capability]) repairNativeBoundArtifact(descriptor);
  if (!isDeepStrictEqual(migrationJson(repairNativeBoundArtifact(start.capability).bytes), expected) ||
      !isDeepStrictEqual(migrationPermit(root), start.permit)) reject("repair exact capability or permit does not match canonical START_INTENT");
  if (realpathSync(join(root, "current")) !== start.target.release) reject("repair start target is not selected");
  retainedRepairVerifyGuard(root, operation, record.lifecycle.bound.guard);
  repairNativeClaimStopped(repairNativeBoundArtifact(start.stopped));
  const receipt = { version: 1, kind: "retained-repair-start-claim", operation, intent: file.descriptor,
    capability: start.capability, permit: start.permit };
  const claimPath = paths.prefix + ".start-claim.json";
  // Create the final name FIRST. Any surviving partial claim consumes the
  // attempt. No service fork is permitted before both fsyncs succeed. Never
  // settle/adopt/delete an interrupted claim.
  const fd = openSync(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify(receipt) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncPath(paths.directory);
  if (!isDeepStrictEqual(migrationFile(paths.pathname, paths.owner, { mode: 0o600 }).descriptor, file.descriptor))
    reject("repair canonical START_INTENT changed while claiming; attempt remains consumed");
  for (const descriptor of [start.stopped, start.capability]) repairNativeBoundArtifact(descriptor);
  if (!isDeepStrictEqual(migrationPermit(root), start.permit)) reject("repair permit changed while claiming; attempt remains consumed");
  repairNativeGuardFile(root, operation, record.lifecycle.bound.guard.descriptor);
  if (Date.now() >= start.deadlineMs) reject("repair start deadline expired while claiming; attempt consumed");
  retainedRepairClaimEvidence(root,record);
  repairNativeClaimStopped(repairNativeBoundArtifact(start.stopped));
  return { claim: migrationFile(claimPath, paths.owner, { mode: 0o600 }).descriptor, receipt };
}
function retainedRepairStartClaim(root, operation) {
  if (process.getuid() !== 0 || process.geteuid() !== 0 || process.ppid !== 1 ||
      fileURLToPath(import.meta.url) !== repairNativeLibrary || realpathSync(process.execPath) !== realpathSync(repairNativeNode))
    reject("repair claim is only executable by the installed root systemd condition");
  if (repairUnsetEnvironment.some(name => process.env[name] !== undefined)) reject("repair condition inherited a code-loading environment");
  // Never allow service Environment/EnvironmentFile values to redirect privileged IO.
  for (const name of Object.keys(process.env)) if (name.startsWith("OPENCLAW_TEAM_")) delete process.env[name];
  const unit = repairNativeShow(repairNativeUnit);
  if (unit.ActiveState !== "activating" || unit.SubState !== "condition" || unit.MainPID !== "0" ||
      unit.ControlPID !== String(process.pid) || unit.ControlGroup !== repairNativeGroup ||
      !/^[a-f0-9]{32}$/.test(unit.InvocationID) || process.env.INVOCATION_ID !== unit.InvocationID ||
      readFileSync("/proc/self/cgroup", "utf8") !== "0::" + repairNativeGroup + "\n")
    reject("repair claim is not this service's native condition process");
  return repairNativeClaimCore(root, operation);
}
function retainedRepairRemoveGuard(root, operation) {
  retainedRepairLock();
  const { file, record, paths } = repairNativeCanonical(root, operation, ["REPAIR_VERIFIED"]);
  const guard = record.lifecycle.bound.guard, start = record.lifecycle.startIntent;
  retainedRepairVerifyGuard(root, operation, guard);
  const claim = migrationJson(migrationFile(paths.prefix + ".start-claim.json", paths.owner, { mode: 0o600 }).bytes);
  if (claim.kind !== "retained-repair-start-claim" || claim.operation !== operation ||
      !isDeepStrictEqual(claim.capability, start.capability) || !isDeepStrictEqual(claim.permit, start.permit))
    reject("repair accepted completion has no exact consumed start claim");
  // Parent canonical validation is responsible for its typed acceptance proofs.
  // Never remove permit/capability/claim or unrelated fragment/drop-ins.
  if (!isDeepStrictEqual(repairNativeCanonical(root, operation, ["REPAIR_VERIFIED"]).file.descriptor, file.descriptor))
    reject("repair accepted journal changed before guard removal");
  repairNativeGuardFile(root, operation, guard.descriptor);
  unlinkSync(guard.descriptor.path); syncPath(dirname(guard.descriptor.path));
  if (!isDeepStrictEqual(repairNativeConfig(root, operation), guard.baseline)) reject("repair configuration changed while removing exact guard");
  return "REPAIR_GUARD_REMOVED_RELOAD_REQUIRED";
}

function retainedRepairTargets(context) {
  const legacy = context.snapshot.evidence.record;
  const witness = retainedRepairWitness(legacy,
    migrationJson(retainedRepairBoundFile(context.record.floor).bytes));
  return [...new Set([legacy.protectedPaths[0].path, legacy.protectedPaths[1].path,
    ...sessionWitnessTuples(witness).map(tuple => tuple[1])].flatMap((path, index) => index === 0 ? [path] : [path, `${path}-wal`, `${path}-shm`]))].sort();
}
function retainedRepairAdoptionSnapshot(root) {
  const paths=retainedAdoptionLocations(root);
  if(!lstatSync(paths.gate,{throwIfNoEntry:false})) return undefined;
  const gate=retainedAdoptionGate(paths);
  const context=retainedAdoptionCompletion(root,{operation:gate.value.operation,intentSha256:gate.value.intent.sha256});
  return { operation:gate.value.operation, intent:context.file.descriptor, complete:context.complete.descriptor, closure:context.value.closure };
}
function retainedRepairClaimEvidence(root, record) {
  const completed=migrationJson(repairNativeBoundArtifact(record.build).bytes);
  const capsule=migrationJson(repairNativeBoundArtifact(completed.preparation).bytes);
  const {archives,...snapshot}=capsule;
  if(snapshot.request.operation!==record.operation) reject("repair claim capsule belongs to another operation");
  if(!isDeepStrictEqual(retainedRepairClosure(),snapshot.closure)) reject("repair claim controller closure changed");
  const config=lstatSync(snapshot.config.path);
  if(!isDeepStrictEqual(migrationFile(snapshot.config.path,config.uid,{mode:0o600,group:config.gid}).descriptor,snapshot.config))
    reject("repair claim config changed");
  for(const path of snapshot.evidence.record.protectedPaths.slice(1))
    if(!isDeepStrictEqual(identity(path.path),path)) reject("repair claim protected store changed");
  if(!isDeepStrictEqual(validateFrozenRelease(join(root,"releases",snapshot.request.target.sha),snapshot.request.target.sha,
      snapshot.request.target.manifestSha256,migrationOwner()),snapshot.target)) reject("repair claim target changed");
  const legacy=snapshot.evidence.record;
  for(const floor of [snapshot.currentWitness,migrationJson(repairNativeBoundArtifact(record.floor).bytes),
      migrationJson(repairNativeBoundArtifact(record.lifecycle.startIntent.stopped).bytes).floor]) {
    const value=Array.isArray(floor)?floor:migrationJson(repairNativeBoundArtifact(floor).bytes);
    retainedRepairWitness(legacy,value);
  }
  if(!isDeepStrictEqual(runtimeCurrent(root,false),snapshot.runtime)) reject("repair claim runtime changed");
}

function retainedRepairNative(root, context, kind) {
  const { snapshot, record } = context;
  const bound = record.lifecycle?.bound?.owner;
  if (kind === "stopped") {
    if (!bound) reject("repair stopped custody has no original native owner");
    retainedRepairGuardVerify(root, context, record.lifecycle.bound.guard);
    return retainedRepairObserveStopped(root, bound, retainedRepairTargets(context));
  }
  const selected = kind === "live-c";
  if (!selected && kind !== "live-b") reject("unknown repair native observation");
  let pid = snapshot.process.pid, generation = snapshot.process.generation;
  if (selected) {
    const unit = repairNativeShow(repairNativeUnit);
    pid = integer(unit.MainPID, "repair successor pid");
    const stat = readFileSync(join(repairNativeRoots().proc, String(pid), "stat"), "utf8");
    generation = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    if (pid === snapshot.process.pid) reject("repair successor reused the original PID");
  }
  const binding = { pid, generation, release: join(root, "releases", selected ? snapshot.request.target.sha : snapshot.evidence.record.candidate.sha),
    runtime: snapshot.process.executable, uid: bound?.process.uid ?? statSync(join(repairNativeRoots().proc, String(pid))).uid,
    port: integer(process.env.OPENCLAW_TEAM_GATEWAY_PORT ?? "18789", "repair Gateway port") };
  const observed = retainedRepairObserveLive(root, binding);
  const expected = selected ? record.lifecycle?.started : bound;
  if (expected) {
    const { instance, claim, ...native } = expected;
    if (!isDeepStrictEqual(native, observed)) reject("repair native generation or owner changed");
  }
  if (selected && (observed.process.bootId !== bound.process.bootId || observed.invocationId === bound.invocationId))
    reject("repair successor is not one new native invocation on the original boot");
  if (bound) retainedRepairGuardVerify(root, context, record.lifecycle.bound.guard);
  return observed;
}
function retainedRepairGuardInstall(root, context) {
  const operation = context.record.operation, path = repairNativeGuardPath(root, operation);
  const intentPath = `${context.paths.prefix}.guard-intent.json`;
  let intent;
  if (lstatSync(intentPath, { throwIfNoEntry: false })) {
    intent = migrationJson(retainedRepairRead(intentPath).bytes);
    if (!isDeepStrictEqual(intent.journal, context.journal) || intent.path !== path ||
        intent.body !== repairNativeGuardBody(root, operation)) reject("repair guard intent changed");
  } else {
    if (lstatSync(path, { throwIfNoEntry: false })) reject("unowned repair guard already exists");
    const exec = repairNativeBusProperty("ExecConditionEx");
    if (exec?.type !== "a(sasasttttuii)" || !Array.isArray(exec.data) || exec.data.length) reject("repair refuses existing executable conditions");
    intent = { journal: context.journal, path, body: repairNativeGuardBody(root, operation), baseline: repairNativeConfig(root, operation) };
    retainedRepairFile(intentPath, Buffer.from(JSON.stringify(intent) + "\n"));
  }
  if (!lstatSync(dirname(path), { throwIfNoEntry: false })) {
    mkdirSync(dirname(path), { mode: 0o755 }); chmodSync(dirname(path), 0o755); syncPath(dirname(dirname(path)));
  }
  if (!lstatSync(path, { throwIfNoEntry: false })) migrationWriteExclusive(path, Buffer.from(intent.body), 0o644);
  settleFixedPublications([{path, mode:0o644, validate(bytes) { if (!bytes.equals(Buffer.from(intent.body))) reject("repair guard publication changed"); }}],
    migrationOwner(), process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
  const guard = { descriptor: migrationFile(path, migrationOwner(), {privateOnly:false,mode:0o644}).descriptor, baseline:intent.baseline };
  syncPath(path); syncPath(dirname(path));
  repairSystemctl(["daemon-reload"]);
  retainedRepairVerifyGuard(root, operation, guard);
  return guard;
}
function retainedRepairGuardRemovalEvidence(root, context) {
  const { record, paths } = context, guard = record.lifecycle?.bound?.guard;
  if (!["REPAIR_VERIFIED", "REPAIR_COMPLETED"].includes(record.phase) || !guard)
    reject("repair guard absent before durable verified completion");
  const intent = migrationJson(retainedRepairRead(`${paths.prefix}.guard-removal-intent.json`).bytes);
  const expected = record.phase === "REPAIR_VERIFIED" ? context.journal :
    migrationJson(retainedRepairRead(`${paths.prefix}.transition-11.json`).bytes).expected;
  if (!isDeepStrictEqual(intent, { journal: expected, guard })) reject("repair guard removal intent changed");
  const completed = migrationJson(retainedRepairRead(`${paths.prefix}.lifecycle-completed.json`).bytes);
  if (completed.operation !== record.operation || !isDeepStrictEqual(completed.build, record.build) ||
      !isDeepStrictEqual(completed.acceptance, record.lifecycle.verified.acceptance) ||
      !isDeepStrictEqual(completed.retainedOriginal, context.receipt.original) ||
      !Number.isSafeInteger(completed.completedAtMs) || completed.completedAtMs < 1)
    reject("repair completion evidence changed before guard removal");
  if (!isDeepStrictEqual(repairNativeConfig(root, record.operation), guard.baseline))
    reject("repair removed-guard configuration baseline changed");
  return completed;
}
function retainedRepairGuardVerify(root, context, guard) {
  if (lstatSync(guard.descriptor.path, { throwIfNoEntry: false }))
    return retainedRepairVerifyGuard(root, context.record.operation, guard);
  retainedRepairGuardRemovalEvidence(root, context);
  if (repairNativeShow(repairNativeUnit, ["DropInPaths"]).DropInPaths.split(" ").includes(guard.descriptor.path))
    reject("repair removed guard is still effective");
  const exec = repairNativeBusProperty("ExecConditionEx");
  if (exec?.type !== "a(sasasttttuii)" || !Array.isArray(exec.data) || exec.data.length)
    reject("repair removed guard still has an executable condition");
  return "REPAIR_VERIFIED_GUARD_REMOVED";
}
function retainedRepairStartClaimVerify(root, context) {
  const start = context.record.lifecycle.startIntent;
  const file = retainedRepairRead(`${context.paths.prefix}.start-claim.json`), receipt = migrationJson(file.bytes);
  suspensionObject(receipt,["version","kind","operation","intent","capability","permit"],"repair start claim");
  if (receipt.version !== 1 || receipt.kind !== "retained-repair-start-claim" || receipt.operation !== context.record.operation ||
      !isDeepStrictEqual(receipt.capability,start.capability) || !isDeepStrictEqual(receipt.permit,start.permit)) reject("repair one-start claim changed");
  const expected = context.record.sequence === 8 ? context.journal : migrationJson(retainedRepairRead(`${context.paths.prefix}.transition-9.json`).bytes).expected;
  if (!isDeepStrictEqual(receipt.intent,expected)) reject("repair start claim belongs to another canonical intent");
  return file.descriptor;
}
function retainedRepairGuardRemove(root, context) {
  const guard = context.record.lifecycle.bound.guard, operation = context.record.operation;
  const path = `${context.paths.prefix}.guard-removal-intent.json`;
  retainedRepairFile(path,Buffer.from(JSON.stringify({journal:context.journal,guard})+"\n"));
  if (lstatSync(guard.descriptor.path,{throwIfNoEntry:false})) retainedRepairRemoveGuard(root,operation);
  else if (!isDeepStrictEqual(repairNativeConfig(root,operation),guard.baseline)) reject("repair guard removal baseline changed");
  repairSystemctl(["daemon-reload"]);
  if (repairNativeShow(repairNativeUnit,["DropInPaths"]).DropInPaths.split(" ").includes(guard.descriptor.path)) reject("repair guard remains effective after removal");
}

// Bootstrap only managed absolute canonical entrypoints, in this visible PID namespace.
// Trusted root must not launch aliases/copied code, hide argv, import the old library,
// or leave detached controller descendants/jobs. This is reader retirement only;
// native writer/job/profile settlement remains a separate lifecycle requirement.
const retainedBootstrapProtocol = "retained-controller-fail-closed-bridge-v1";
function retainedBootstrapPaths(paths) {
  return { ...paths, prefix: paths.prefix + ".bootstrap", gate: join(paths.directory, "controller-bootstrap.json") };
}
function retainedBootstrapBytes(index) {
  const message = "CONTROLLER_BOOTSTRAP_FENCED: canonical controller adoption is incomplete";
  return Buffer.from(index === 0
    ? "#!/usr/bin/env bash\nprintf '%s\\n' '" + message + "' >&2\nexit 75\n"
    : "#!/usr/bin/env node\nthrow new Error(" + JSON.stringify(message) + ");\n");
}
function retainedBootstrapGate(paths, expected) {
  const file = retainedAdoptionChecked(paths.gate);
  const value = migrationJson(file.bytes);
  suspensionObject(value, ["version", "kind", "protocol", "operation", "intent"], "controller bootstrap gate");
  if (value.version !== 1 || value.kind !== "retained-controller-bootstrap-gate" ||
      value.protocol !== retainedBootstrapProtocol || value.operation !== expected.operation ||
      !isDeepStrictEqual(value.intent, expected.intent)) reject("controller bootstrap gate changed");
  retainedAdoptionChecked(value.intent.path, value.intent);
  return file;
}
function retainedBootstrapLoad(root, operation, request) {
  const paths = retainedBootstrapPaths(retainedAdoptionLocations(root, operation));
  const file = retainedAdoptionChecked(paths.prefix + ".intent.json");
  const intent = migrationJson(file.bytes);
  suspensionObject(intent, ["version", "kind", "protocol", "request", "lock", "original", "backups", "replacements", "bridges"], "controller bootstrap intent");
  if (intent.version !== 1 || intent.kind !== "retained-controller-bootstrap" || intent.protocol !== retainedBootstrapProtocol ||
      intent.request.operation !== operation || (request && !isDeepStrictEqual(intent.request, request)))
    reject("controller bootstrap request changed");
  retainedAdoptionRequest(root, intent.request);
  if (!isDeepStrictEqual(intent.lock, retainedRepairLock())) reject("controller bootstrap lock inode changed");
  retainedBootstrapGate(paths, { operation, intent: file.descriptor });
  if (intent.original.path !== paths.prefix + ".original.json") reject("controller bootstrap original path changed");
  const original = retainedAdoptionChecked(intent.original.path, intent.original);
  if (original.descriptor.sha256 !== intent.request.source.sha256) reject("controller bootstrap original bytes changed");
  if (!Array.isArray(intent.backups) || intent.backups.length !== 4 || !Array.isArray(intent.replacements) || intent.replacements.length !== 4 ||
      !Array.isArray(intent.bridges) || intent.bridges.length !== 2) reject("controller bootstrap closure is incomplete");
  const backups = [], replacements = [], bridges = [];
  for (let index = 0; index < 4; index++) {
    if (intent.backups[index].path !== paths.prefix + ".backup-" + index ||
        intent.replacements[index].path !== paths.prefix + ".replacement-" + index + (index === 1 ? ".mjs" : "")) reject("controller bootstrap archive path changed");
    const old = retainedAdoptionChecked(intent.backups[index].path, intent.backups[index]);
    const next = retainedAdoptionChecked(intent.replacements[index].path, intent.replacements[index]);
    if (old.descriptor.sha256 !== intent.request.oldClosure[index].sha256 || next.descriptor.sha256 !== intent.request.replacement[index].sha256)
      reject("controller bootstrap archive differs from approved closure");
    backups.push(old); replacements.push(next);
    if (index < 2) {
      if (intent.bridges[index].path !== paths.prefix + ".bridge-" + index) reject("controller bootstrap bridge path changed");
      const bridge = retainedAdoptionChecked(intent.bridges[index].path, intent.bridges[index]);
      if (!bridge.bytes.equals(retainedBootstrapBytes(index))) reject("controller bootstrap bridge code changed");
      bridges.push(bridge);
    }
  }
  retainedAdoptionProtocolCheck(replacements);
  return { paths, file, intent, original, backups, replacements, bridges };
}
function retainedBootstrapFence(context, current = true) {
  const { paths, intent } = context;
  const closure = intent.request.oldClosure.slice();
  for (let index = 0; index < 2; index++) {
    const file = retainedAdoptionChecked(paths.prefix + ".step-" + index + ".json");
    const step = migrationJson(file.bytes);
    suspensionObject(step, ["version", "operation", "index", "from", "to", "stage", "backup"], "controller bootstrap bridge step");
    for (const value of [step.from, step.to, step.stage, step.backup]) validMigrationDescriptor(value, "path", "controller bootstrap step file");
    if (step.version !== 1 || step.operation !== intent.request.operation || step.index !== index ||
        !isDeepStrictEqual(step.from, retainedAdoptionFrom(context, index)) || !isDeepStrictEqual(step.backup, intent.backups[index]) ||
        step.stage.path !== paths.destinations[index] + ".adoption-" + intent.request.operation + ".next" ||
        !isDeepStrictEqual(step.to, { ...step.stage, path: paths.destinations[index] }) ||
        step.to.sha256 !== context.bridges[index].descriptor.sha256) reject("controller bootstrap bridge step changed");
    if (current) {
      const observed = migrationFile(paths.destinations[index], paths.owner, { privateOnly: false, mode: index === 0 ? 0o755 : 0o644, limit: migrationJournalLimit });
      if (!isDeepStrictEqual(observed.descriptor, step.to) || lstatSync(step.stage.path, { throwIfNoEntry: false }))
        reject("controller bootstrap bridge is not durably installed");
      syncPath(paths.destinations[index]); syncPath(dirname(paths.destinations[index]));
    }
    closure[index] = step.to;
  }
  if (current) for (let index = 2; index < 4; index++) {
    const observed = migrationFile(paths.destinations[index], paths.owner, { privateOnly: false, mode: 0o644, limit: migrationJournalLimit });
    if (!isDeepStrictEqual(observed.descriptor, closure[index])) reject("controller bootstrap helper changed");
  }
  return closure;
}
function retainedBootstrapReaders(paths) {
  // A stable fail-closed bridge closes entry BEFORE the census. This census is
  // not a substitute for that persistent exclusion, and never kills readers.
  if (process.getuid?.() !== paths.owner || process.geteuid?.() !== paths.owner)
    reject("controller bootstrap requires the canonical root owner");
  if (Number(statfsSync("/proc").type) !== 0x9fa0 || realpathSync("/proc/self") !== "/proc/" + process.pid ||
      readlinkSync("/proc/self/ns/pid") !== readlinkSync("/proc/1/ns/pid"))
    reject("controller bootstrap cannot prove its complete proc namespace");
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(bootId)) reject("controller bootstrap boot identity is invalid");
  const readers = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(name) || Number(name) === process.pid) continue;
    let fd;
    try {
      fd = openSync("/proc/" + name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const base = "/proc/self/fd/" + fd;
      const stat = readFileSync(base + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!stat.startsWith(name + " (") || fields.length < 20 || !/^[0-9]+$/.test(fields[19]))
        reject("controller bootstrap process identity is malformed");
      if (["Z", "X"].includes(fields[0])) continue;
      const args = readFileSync(base + "/cmdline");
      if (args.length > 1024 * 1024) reject("controller bootstrap process command is oversized");
      const after = readFileSync(base + "/stat", "utf8");
      const afterFields = after.slice(after.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!after.startsWith(name + " (") || afterFields[19] !== fields[19])
        reject("controller bootstrap process identity changed");
      if (["Z", "X"].includes(afterFields[0])) continue;
      // Empty cmdline is safe only for kernel threads, never an unobservable user reader.
      if (!args.length && (BigInt(fields[6]) & 0x200000n) === 0n)
        reject("controller bootstrap process command is unobservable: " + name);
      const argv = args.toString("utf8").split("\0");
      if (paths.destinations.slice(0, 2).some(path => argv.includes(path))) {
        const startTicks = fields[19];
        if (!/^[0-9]+$/.test(startTicks ?? "")) reject("controller bootstrap reader generation is ambiguous");
        readers.push({ pid: Number(name), startTicks });
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  if (readers.length) reject("controller bootstrap old managed readers remain: " + JSON.stringify(readers));
  return { protocol: retainedBootstrapProtocol, bootId, pidNamespace: readlinkSync("/proc/self/ns/pid"), readers: [] };
}
function retainedBootstrapClosed(context, requireCurrent = false) {
  const closure = retainedBootstrapFence(context, requireCurrent);
  const file = retainedAdoptionChecked(context.paths.prefix + ".closed.json");
  const value = migrationJson(file.bytes);
  suspensionObject(value, ["version", "kind", "intent", "closure", "census"], "controller bootstrap closed receipt");
  if (value.version !== 1 || value.kind !== "retained-controller-bootstrap-closed" ||
      !isDeepStrictEqual(value.intent, context.file.descriptor) || !isDeepStrictEqual(value.closure, closure))
    reject("controller bootstrap closed receipt changed");
  suspensionObject(value.census, ["protocol", "bootId", "pidNamespace", "readers"], "controller bootstrap census");
  if (value.census.protocol !== retainedBootstrapProtocol || !/^[a-f0-9-]{36}$/.test(value.census.bootId) ||
      !/^pid:\[[0-9]+\]$/.test(value.census.pidNamespace) || !Array.isArray(value.census.readers) || value.census.readers.length)
    reject("controller bootstrap census is not closed");
  if (requireCurrent) retainedBootstrapReaders(context.paths);
  return { ...context, closed: file, closure };
}
function retainedBootstrap(root, input) {
  const lock = retainedRepairLock(), ordinary = retainedAdoptionRequest(root, input), paths = retainedBootstrapPaths(ordinary);
  let context;
  if (lstatSync(paths.gate, { throwIfNoEntry: false })) {
    context = retainedBootstrapLoad(root, input.operation, input);
    retainedAdoptionRunner(input, undefined, context.intent.replacements[1]);
    retainedAdoptionLegacy(paths, input.source);
  } else {
    if (lstatSync(ordinary.gate, { throwIfNoEntry: false })) reject("controller adoption already owns this incident");
    retainedAdoptionRunner(input);
    const source = retainedAdoptionLegacy(paths, input.source), old = retainedAdoptionReadClosure(paths);
    if (!isDeepStrictEqual(old.map(file => file.descriptor), input.oldClosure)) reject("controller bootstrap old closure changed");
    try { retainedAdoptionProtocolCheck(old); reject("controller bootstrap is unnecessary for a gate-aware incumbent"); }
    catch (error) { if (!String(error.message).includes("lacks the audited FD9")) throw error; }
    const replacements = input.replacement.map((descriptor, index) => {
      migrationAncestors(dirname(descriptor.path), paths.owner, process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
      const file = migrationFile(descriptor.path, paths.owner, { privateOnly: false, mode: index ? 0o644 : 0o755, limit: migrationJournalLimit });
      if (!isDeepStrictEqual(file.descriptor, descriptor)) reject("controller bootstrap replacement changed");
      return file;
    });
    retainedAdoptionProtocolCheck(replacements);
    const original = retainedRepairFile(paths.prefix + ".original.json", source.bytes);
    const backups = old.map((file, index) => retainedRepairFile(paths.prefix + ".backup-" + index, file.bytes));
    const saved = replacements.map((file, index) => retainedRepairFile(paths.prefix + ".replacement-" + index + (index === 1 ? ".mjs" : ""), file.bytes));
    const bridges = [0, 1].map(index => retainedRepairFile(paths.prefix + ".bridge-" + index, retainedBootstrapBytes(index)));
    const intent = { version: 1, kind: "retained-controller-bootstrap", protocol: retainedBootstrapProtocol, request: input,
      lock, original, backups, replacements: saved, bridges };
    const descriptor = retainedAdoptionJSON(paths.prefix + ".intent.json", intent);
    retainedAdoptionLegacy(paths, input.source);
    if (!isDeepStrictEqual(retainedAdoptionReadClosure(paths).map(file => file.descriptor), input.oldClosure))
      reject("controller bootstrap old closure changed before gate publication");
    retainedAdoptionJSON(paths.gate, { version: 1, kind: "retained-controller-bootstrap-gate", protocol: retainedBootstrapProtocol,
      operation: input.operation, intent: descriptor });
    context = retainedBootstrapLoad(root, input.operation, input);
  }
  // Library first: old shell remains a v1 reader but every new library call is
  // already fail-closed. The canonical journal is still exact old v1 throughout.
  const bridgeContext = { ...context, replacements: context.bridges };
  retainedAdoptionStep(bridgeContext, 1); retainedAdoptionStep(bridgeContext, 0);
  const closure = retainedBootstrapFence(context);
  const census = retainedBootstrapReaders(paths);
  retainedAdoptionLegacy(paths, input.source);
  if (!lstatSync(paths.prefix + ".closed.json", { throwIfNoEntry: false }))
    retainedAdoptionJSON(paths.prefix + ".closed.json", { version: 1, kind: "retained-controller-bootstrap-closed", intent: context.file.descriptor, closure, census });
  const closed = retainedBootstrapClosed(context, true);
  return { operation: input.operation, bootstrap: closed.closed.descriptor };
}
function retainedAdoptionFrom(context, index) {
  return context.bootstrap ? context.bootstrap.closure[index] : context.intent.request.oldClosure[index];
}

// Whole-closure metadata adoption ONLY. No lifecycle or incident waiver.
const retainedAdoptionProtocol = "retained-controller-fd9-gate-v1";
function retainedAdoptionLocations(root, operation) {
  const namespace = migrationNamespace(root);
  if (operation !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operation))
    reject("controller adoption operation is invalid");
  const executable = process.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE ?? "/usr/local/sbin/openclaw-release-deploy";
  const library = process.env.OPENCLAW_TEAM_RELEASE_LIB ?? "/usr/local/lib/openclaw-team/release-lib.mjs";
  const destinations = [executable, library, join(dirname(library), "gateway-suspension-contract.mjs"), join(dirname(library), "startup-profile.mjs")];
  if (basename(executable) !== "openclaw-release-deploy" || basename(library) !== "release-lib.mjs" || new Set(destinations).size !== 4)
    reject("controller adoption requires the canonical four-file closure");
  for (const path of destinations) migrationAncestors(dirname(path), namespace.owner, process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
  return { ...namespace, destinations, gate: join(namespace.directory, "controller-adoption.json"),
    prefix: operation ? join(namespace.directory, "repair-" + operation + ".adoption") : undefined };
}
function retainedAdoptionReadClosure(paths) {
  return paths.destinations.map((path, index) => migrationFile(path, paths.owner, {
    privateOnly: false, mode: index === 0 ? 0o755 : 0o644, limit: migrationJournalLimit,
  }));
}
function retainedAdoptionLegacy(paths, expected) {
  validMigrationDescriptor(expected, "path", "controller adoption original journal");
  if (expected.path !== paths.pathname) reject("controller adoption source journal is not canonical");
  const file = migrationFile(paths.pathname, paths.owner, { mode: 0o600, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(file.descriptor, expected)) reject("controller adoption source journal changed");
  const record = validJournal(migrationJson(file.bytes));
  const allowed = ["version", "phase", "topology", "predecessor", "candidate", "process", "pointerTopology", "services", "suspension", "protectedPaths", "originalWitness", "gatewayRuntime", "createdAt"];
  if (record.version !== 1 || record.phase !== "ROLLBACK_FAILED" || record.topology !== "system" ||
      !record.originalWitness || record.predecessor.sha === record.candidate.sha ||
      [record.predecessor, record.candidate].some(info => ["state", "agent"].some(key =>
        !Number.isSafeInteger(info.schemaVersions?.[key]) || info.schemaVersions[key] < 0)) ||
      !isDeepStrictEqual(record.predecessor.schemaVersions, record.candidate.schemaVersions) ||
      Object.keys(record).some(key => !allowed.includes(key)))
    reject("controller adoption requires the exact retained legacy failed system incident");
  return file;
}
function retainedAdoptionProtocolCheck(files) {
  // Protocol literals identify separately audited code, not authority to trust arbitrary code.
  // The operator's exact old/new hashes remain mandatory; both hooks have executable tests.
  if (!files[0].bytes.includes(Buffer.from("OPENCLAW_CONTROLLER_FD9_GATE_V1")) ||
      !files[0].bytes.includes(Buffer.from("controller-adoption-gate")) ||
      !files[1].bytes.includes(Buffer.from('const retainedAdoptionProtocol = "retained-controller-fd9-gate-v1";')) ||
      !files[1].bytes.includes(Buffer.from("retainedAdoptionEntryGuard(command, args);")))
    reject("incumbent or replacement lacks the audited FD9 entrypoint gate; adoption refused");
}
// A completed incident may be archived before a controller successor is needed.
// This is evidence for the same retired source, not permission to retire another
// journal or to interrupt the incumbent. Every publication rechecks live custody.
function retainedAdoptionSource(paths, request) {
  if (!request.retirement) return retainedAdoptionLegacy(paths, request.source);
  validMigrationDescriptor(request.retirement, "path", "accepted retirement completion");
  const completionFile = retainedAdoptionChecked(request.retirement.path, request.retirement);
  const completion = migrationJson(completionFile.bytes);
  const retired = completion.request;
  if (completion.version !== 1 || completion.kind !== "operator-accepted-incident-retirement" ||
      completion.disposition !== "operator-accepted-with-history-continuity-unverified" ||
      completion.canonicalAcceptance !== "not claimed" || retired?.version !== 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(retired.operation) ||
      retired.source?.path !== paths.pathname || retired.machineId !== hostMachineId())
    reject("controller adoption accepted retirement differs from the incumbent");
  if (!isDeepStrictEqual(retired.closure, request.oldClosure)) {
    // Later successors retain the same retirement evidence through the existing
    // immutable completed-adoption chain, never by rewriting the retired receipt.
    const root = dirname(paths.directory), gate = retainedAdoptionGate(paths);
    let completed;
    if (gate.value.operation === request.operation) {
      const context = retainedAdoptionLoad(root, { operation: request.operation, intentSha256: gate.value.intent.sha256 });
      if (!context.intent.predecessor) reject("retired successor lost its completed predecessor");
      completed = retainedAdoptionPredecessor(root, paths, context.intent.predecessor, request);
    } else {
      completed = retainedAdoptionCompletion(root, { operation: gate.value.operation, intentSha256: gate.value.intent.sha256 });
      if (!isDeepStrictEqual(completed.value.closure, request.oldClosure))
        reject("retired successor incumbent closure changed");
    }
    while (true) {
      if (!isDeepStrictEqual(completed.intent.request.retirement, request.retirement) ||
          !isDeepStrictEqual(completed.intent.request.source, request.source))
        reject("retired successor changed its accepted source");
      if (isDeepStrictEqual(completed.intent.request.oldClosure, retired.closure)) break;
      if (!completed.intent.predecessor) reject("retired successor lacks its original closure");
      completed = retainedAdoptionPredecessor(root, completed.paths, completed.intent.predecessor, completed.intent.request);
    }
  }
  const prefix = join(paths.directory, "repair-" + retired.operation + ".operator-accepted");
  if (request.retirement.path !== prefix + ".complete.json" ||
      !isDeepStrictEqual(completion.archived, { ...retired.source, path: prefix + ".journal.json" }) ||
      !retainedAdoptionChecked(prefix + ".intent.json").bytes.equals(completionFile.bytes))
    reject("controller adoption retirement artifacts are not the exact completed owner");
  if (lstatSync(paths.pathname, { throwIfNoEntry: false }))
    reject("controller adoption requires the retired canonical journal slot to remain absent");
  const record = validRetainedRepairJournal(migrationJson(retainedAdoptionChecked(completion.archived.path, completion.archived).bytes));
  if (record.operation !== retired.operation || record.phase !== "REPAIR_STARTED" || record.sequence !== 9)
    reject("controller adoption retired incident phase changed");
  const build = migrationJson(retainedRepairBoundFile(record.build).bytes);
  const original = retainedRepairBoundFile(build.original);
  if (build.kind !== "retained-repair-build-completed" || build.phase !== "BUILD_COMPLETED" ||
      build.operation !== record.operation || request.source.path !== paths.pathname ||
      original.descriptor.sha256 !== request.source.sha256)
    reject("controller adoption retirement lost its original source");
  // Preserve the original legacy source bytes in the new intent without restoring
  // them into the canonical journal slot.
  const legacy = validJournal(migrationJson(original.bytes));
  if (legacy.version !== 1 || legacy.phase !== "ROLLBACK_FAILED" || legacy.topology !== "system")
    reject("controller adoption retired source is not the original failed incident");
  const acceptance = migrationJson(retainedRepairBoundFile(retired.receipt).bytes);
  if (acceptance.kind !== "operator-approved-restart-restored" || acceptance.result !== "complete" ||
      acceptance.operation !== record.operation || !isDeepStrictEqual(acceptance.journal, retired.source) ||
      acceptance.canonicalAcceptance !== "not claimed" || !acceptance.historyContinuity ||
      acceptance.restart !== "always" || !isDeepStrictEqual(acceptance.guard, record.lifecycle.bound.guard))
    reject("controller adoption accepted disposition changed");
  const proof = migrationFile(acceptance.functionalProof.path, paths.owner, { privateOnly: false, mode: 0o644, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(proof.descriptor, acceptance.functionalProof)) reject("controller adoption accepted proof changed");
  const guard = record.lifecycle.bound.guard;
  if (!isDeepStrictEqual(migrationFile(acceptance.archive, paths.owner, { privateOnly: false, mode: 0o644, limit: 8192 }).descriptor,
      { ...guard.descriptor, path: acceptance.archive }) || lstatSync(guard.descriptor.path, { throwIfNoEntry: false }))
    reject("controller adoption retired guard changed");
  const started = record.lifecycle.started, { bootId, cgroup, ...binding } = started.process;
  const live = retainedRepairObserveLive(dirname(paths.directory), binding);
  const unit = repairNativeShow(repairNativeUnit, ["Restart", "NRestarts"]);
  const conditions = repairNativeBusProperty("ExecConditionEx");
  const configEntry = lstatSync(retired.config.path);
  const config = migrationFile(retired.config.path, configEntry.uid, { mode: 0o600, group: configEntry.gid });
  if (acceptance.pid !== binding.pid || acceptance.invocation !== started.invocationId || acceptance.nRestarts !== 0 ||
      live.process.bootId !== bootId || live.process.cgroup !== cgroup || live.invocationId !== started.invocationId ||
      live.startedAtMonotonic !== started.startedAtMonotonic || unit.Restart !== "always" || unit.NRestarts !== "0" ||
      conditions?.type !== "a(sasasttttuii)" || !Array.isArray(conditions.data) || conditions.data.length ||
      !isDeepStrictEqual(config.descriptor, retired.config) ||
      !isDeepStrictEqual(repairNativeConfig(dirname(paths.directory), retired.operation), guard.baseline))
    reject("controller adoption retired incident incumbent changed");
  for (const name of ["current", "previous"])
    if (!isDeepStrictEqual(retainedRepairPointer(dirname(paths.directory), name), record.lifecycle.selected[name]))
      reject("controller adoption retired incident pointers changed");
  return original;
}

function retainedAdoptionRequest(root, input, historical = false) {
  suspensionObject(input, ["version", "operation", "source", "oldClosure", "replacement", ...(historical ? ["historical"] : Object.hasOwn(input, "retirement") ? ["retirement"] : [])], "controller adoption request");
  if (input.version !== 1 || !Array.isArray(input.oldClosure) || input.oldClosure.length !== 4 ||
      !Array.isArray(input.replacement) || input.replacement.length !== 4)
    reject("controller adoption request must bind all four old and approved new files");
  const paths = retainedAdoptionLocations(root, input.operation);
  if (historical) {
    suspensionObject(input.historical, ["gate", "complete"], "controller adoption historical approval");
    for (const descriptor of Object.values(input.historical)) validMigrationDescriptor(descriptor, "path", "historical adoption artifact");
    if (input.historical.gate.path !== paths.gate) reject("controller adoption historical gate is not canonical");
  }
  for (let index = 0; index < 4; index++) {
    validMigrationDescriptor(input.oldClosure[index], "path", "old controller file");
    validMigrationDescriptor(input.replacement[index], "path", "approved controller file");
    if (!isAbsolute(input.replacement[index].path) || resolve(input.replacement[index].path) !== input.replacement[index].path ||
        input.oldClosure[index].path !== paths.destinations[index] ||
        paths.destinations.includes(input.replacement[index].path) ||
        basename(input.replacement[index].path) !== basename(paths.destinations[index]))
      reject("controller adoption closure paths are not exact");
  }
  if (new Set(input.replacement.map(file => file.path)).size !== 4)
    reject("controller adoption replacement paths are duplicated");
  return paths;
}
function retainedAdoptionJSON(path, value) {
  return retainedRepairFile(path, Buffer.from(JSON.stringify(value) + "\n"));
}
function retainedAdoptionChecked(path, expected) {
  const file = retainedRepairRead(path);
  if (expected && !isDeepStrictEqual(file.descriptor, expected)) reject("controller adoption durable artifact changed");
  return file;
}
function retainedAdoptionRunner(request, completedClosure, archived) {
  const path = fileURLToPath(import.meta.url);
  const archive = (Array.isArray(archived) ? archived : [archived]).find(value => value?.path === path);
  const fromArchive = archive !== undefined;
  const file = migrationFile(path, migrationOwner(), { privateOnly: !fromArchive ? false : true, mode: fromArchive ? 0o600 : 0o644, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(file.descriptor, request.replacement[1]) &&
      !(completedClosure && completedClosure[1].sha256 === request.replacement[1].sha256 &&
        isDeepStrictEqual(file.descriptor, completedClosure[1])))
    if (!(fromArchive && archive.sha256 === request.replacement[1].sha256 && isDeepStrictEqual(file.descriptor, archive)))
      reject("controller adoption must run the exact approved replacement library");
}
function retainedAdoptionLoad(root, input) {
  suspensionObject(input, ["operation", "intentSha256"], "controller adoption binding");
  if (!/^[a-f0-9]{64}$/.test(input.intentSha256)) reject("controller adoption intent hash is invalid");
  const paths = retainedAdoptionLocations(root, input.operation);
  const file = retainedAdoptionChecked(paths.prefix + ".intent.json");
  if (file.descriptor.sha256 !== input.intentSha256) reject("controller adoption intent hash changed");
  const intent = migrationJson(file.bytes);
  suspensionObject(intent, ["version", "kind", "protocol", "request", "lock", "metadata", "original", "backups", "replacements", ...(Object.hasOwn(intent, "bootstrap") ? ["bootstrap"] : []), ...(Object.hasOwn(intent, "predecessor") ? ["predecessor"] : [])], "controller adoption intent");
  if (intent.version !== 1 || intent.kind !== "retained-controller-adoption" || intent.protocol !== retainedAdoptionProtocol || intent.request.operation !== input.operation)
    reject("controller adoption intent has the wrong owner");
  retainedAdoptionRequest(root, intent.request, Object.hasOwn(intent.request, "historical"));
  if (!isDeepStrictEqual(intent.lock, retainedRepairLock())) reject("controller adoption lock inode changed");
  if (!isDeepStrictEqual(intent.metadata, paths.destinations.map((path, index) => ({
    path, mode: index === 0 ? 0o755 : 0o644, uid: paths.owner, gid: rootGroup(),
  })))) reject("controller adoption ownership or mode policy changed");
  if (!Array.isArray(intent.backups) || intent.backups.length !== 4 || !Array.isArray(intent.replacements) || intent.replacements.length !== 4)
    reject("controller adoption intent lost its complete private closure");
  if (intent.original.path !== paths.prefix + ".original.json") reject("controller adoption original archive is not canonical");
  const original = retainedAdoptionChecked(intent.original.path, intent.original);
  if (original.descriptor.sha256 !== intent.request.source.sha256) reject("controller adoption original archive differs");
  const backups = [], replacements = [];
  for (let index = 0; index < 4; index++) {
    if (intent.backups[index].path !== paths.prefix + ".backup-" + index || intent.replacements[index].path !== paths.prefix + ".replacement-" + index)
      reject("controller adoption private backup path is not canonical");
    backups.push(retainedAdoptionChecked(intent.backups[index].path, intent.backups[index]));
    replacements.push(retainedAdoptionChecked(intent.replacements[index].path, intent.replacements[index]));
    if (backups[index].descriptor.sha256 !== intent.request.oldClosure[index].sha256 ||
        replacements[index].descriptor.sha256 !== intent.request.replacement[index].sha256)
      reject("controller adoption private closure bytes differ from approval");
  }
  let bootstrap;
  if (Object.hasOwn(intent, "bootstrap")) {
    bootstrap = retainedBootstrapClosed(retainedBootstrapLoad(root, input.operation, intent.request));
    if (!isDeepStrictEqual(bootstrap.closed.descriptor, intent.bootstrap) ||
        bootstrap.original.descriptor.sha256 !== original.descriptor.sha256)
      reject("controller adoption bootstrap predecessor changed");
  } else retainedAdoptionProtocolCheck(backups);
  if (Object.hasOwn(intent, "predecessor")) {
    if (bootstrap) reject("controller adoption cannot have both bootstrap and completed predecessors");
    retainedAdoptionPredecessor(root, paths, intent.predecessor, intent.request);
  } else if (intent.request.historical) reject("historical adoption lost its completed predecessor");
  retainedAdoptionProtocolCheck(replacements);
  return { paths, file, intent, original, backups, replacements, bootstrap };
}
function retainedAdoptionGate(paths, expectedIntent, pathname = paths.gate) {
  const file = retainedAdoptionChecked(pathname);
  const value = migrationJson(file.bytes);
  suspensionObject(value, ["version", "kind", "protocol", "operation", "intent"], "controller adoption gate");
  if (value.version !== 1 || value.kind !== "retained-controller-adoption-gate" || value.protocol !== retainedAdoptionProtocol)
    reject("controller adoption gate is not the canonical owner");
  const expectedPath = retainedAdoptionLocations(dirname(paths.directory), value.operation).prefix + ".intent.json";
  if (value.intent.path !== expectedPath || (expectedIntent && !isDeepStrictEqual(value.intent, expectedIntent)))
    reject("controller adoption gate points to a different intent");
  retainedAdoptionChecked(value.intent.path, value.intent);
  return { file, value };
}
function retainedAdoptionSourceMatches(paths, previousSource, request) {
  if (isDeepStrictEqual(previousSource, request.source)) return true;
  const file = retainedAdoptionChecked(paths.prefix + ".retired-prestart.json");
  const value = migrationJson(file.bytes);
  if (value.version !== 1 || value.kind !== "retained-repair-prestart-retirement" ||
      !isDeepStrictEqual(value.previousSource, previousSource) ||
      !isDeepStrictEqual(value.restored, request.source) ||
      !isDeepStrictEqual({ ...value.request, source: request.source }, request) ||
      value.restored.sha256 !== previousSource.sha256 || value.restored.path !== previousSource.path)
    reject("controller adoption source lacks its exact prestart retirement");
  const archived = migrationJson(retainedAdoptionChecked(value.archived.path, value.archived).bytes);
  validRetainedRepairJournal(archived);
  if (archived.sequence > 1 || archived.lifecycle || !["REPAIR_PREPARED", "REPAIR_EVIDENCE_VERIFIED"].includes(archived.phase))
    reject("controller adoption retirement contains lifecycle effects");
  if (retainedAdoptionChecked(value.original.path, value.original).descriptor.sha256 !== previousSource.sha256)
    reject("controller adoption retirement original changed");
  return true;
}
function retainedAdoptionRetirePrestart(root, request, inspectOnly = false) {
  const paths = retainedAdoptionRequest(root, request), lock = retainedRepairLock();
  retainedAdoptionRunner(request);
  const gate = retainedAdoptionGate(paths);
  const previous = retainedAdoptionCompletion(root, { operation: gate.value.operation, intentSha256: gate.value.intent.sha256 });
  if (!isDeepStrictEqual(previous.value.closure, request.oldClosure)) reject("prestart retirement incumbent changed");
  for (let index = 0; index < 4; index++) {
    const approved = request.replacement[index];
    const file = migrationFile(approved.path, paths.owner, { privateOnly: false, mode: index ? 0o644 : 0o755, limit: migrationJournalLimit });
    if (!isDeepStrictEqual(file.descriptor, approved)) reject("prestart retirement replacement changed");
  }
  const receiptPath = paths.prefix + ".retired-prestart.json";
  if (lstatSync(receiptPath, { throwIfNoEntry: false })) {
    const receipt = migrationJson(retainedAdoptionChecked(receiptPath).bytes);
    if (!isDeepStrictEqual(receipt.request, request)) reject("prestart retirement retry changed request");
    const current = retainedRepairRead(paths.pathname);
    if (isDeepStrictEqual(current.descriptor, receipt.restored)) return receipt;
    if (!isDeepStrictEqual(current.descriptor, request.source)) reject("prestart retirement current source changed");
  }
  // Validate the immutable old snapshot through its installed incumbent.
  const inspection = spawnSync(repairNativeNode, [request.oldClosure[1].path,
    "retained-repair-lifecycle", "inspect", root, "@stdin"], {
    input: JSON.stringify({ journal: request.source }), encoding: "utf8", timeout: 60000,
    maxBuffer: migrationJsonLimit, stdio: ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9],
  });
  if (inspection.error || inspection.signal || inspection.status !== 0) reject("incumbent prestart inspection failed");
  const context = migrationJson(Buffer.from(inspection.stdout)), checked = context;
  if (checked.record.sequence > 1 || checked.record.lifecycle || !["REPAIR_PREPARED", "REPAIR_EVIDENCE_VERIFIED"].includes(checked.record.phase))
    reject("only an unbound prestart repair can be retired");
  if (!isDeepStrictEqual(context.snapshot.request.source, previous.intent.request.source)) reject("prestart original owner differs");
  const prefix = context.paths.prefix;
  if (readdirSync(context.paths.directory).some(name => name.startsWith(basename(prefix) + ".") &&
      /\.(?:lifecycle-|guard-|pointer-|start-)/.test(name))) reject("prestart repair already published a lifecycle intent");
  if (lstatSync(repairNativeGuardPath(root, checked.record.operation), { throwIfNoEntry: false })) reject("prestart repair has a native guard");
  const owner = retainedRepairNative(root, { ...context, ...checked }, "live-b");
  const original = retainedRepairBoundFile(context.receipt.original);
  if (inspectOnly) return { journal: checked.journal, phase: checked.record.phase, owner, original: original.descriptor, serviceConfig: repairNativeConfig(root, checked.record.operation) };
  const current = retainedRepairRead(paths.pathname);
  if (!isDeepStrictEqual(current.descriptor, request.source)) reject("prestart journal changed");
  const archived = retainedRepairFile(paths.prefix + ".retired-journal.json", current.bytes);
  const stage = retainedAdoptionStage(paths.prefix + ".restore.next", original.bytes, 0o600);
  const restored = { ...stage, path: paths.pathname };
  const receipt = { version: 1, kind: "retained-repair-prestart-retirement", request,
    previousSource: previous.intent.request.source, archived, original: original.descriptor, restored };
  retainedAdoptionJSON(receiptPath, receipt);
  if (!isDeepStrictEqual(retainedRepairNative(root, { ...context, ...checked }, "live-b"), owner) ||
      !isDeepStrictEqual(retainedRepairRead(paths.pathname).descriptor, request.source) ||
      !isDeepStrictEqual(retainedRepairLock(), lock)) reject("prestart owner changed before retirement");
  renameSync(stage.path, paths.pathname); syncPath(paths.directory);
  if (!isDeepStrictEqual(retainedRepairRead(paths.pathname).descriptor, restored)) reject("prestart restoration changed");
  return receipt;
}
function retainedAdoptionPredecessor(root, paths, predecessor, request) {
  suspensionObject(predecessor, ["gate", "archive", "complete"], "controller adoption predecessor");
  for (const descriptor of Object.values(predecessor)) validMigrationDescriptor(descriptor, "path", "controller adoption predecessor artifact");
  if (predecessor.gate.path !== paths.gate || predecessor.archive.path !== paths.prefix + ".predecessor-gate.json" ||
      predecessor.archive.sha256 !== predecessor.gate.sha256)
    reject("controller adoption predecessor gate archive differs");
  retainedAdoptionChecked(predecessor.archive.path, predecessor.archive);
  const gate = retainedAdoptionGate(paths, undefined, predecessor.archive.path);
  if (gate.value.operation === request.operation) reject("controller adoption cannot succeed itself");
  // Historical completion verifies every immutable intent, backup and step, but
  // never grants current admission or claims that its retired files remain installed.
  const completed = retainedAdoptionCompletion(root, { operation: gate.value.operation, intentSha256: gate.value.intent.sha256 }, false);
  if (!isDeepStrictEqual(completed.complete.descriptor, predecessor.complete) ||
      (request.historical ? !isDeepStrictEqual(request.historical, { gate: predecessor.gate, complete: predecessor.complete }) ||
        isDeepStrictEqual(completed.intent.request.source, request.source) :
        !retainedAdoptionSourceMatches(paths, completed.intent.request.source, request) ||
        !isDeepStrictEqual(completed.value.closure, request.oldClosure)))
    reject("controller adoption completed predecessor differs from the approved incumbent");
  return completed;
}
function retainedAdoptionPrepare(root, input, historical = false) {
  const lock = retainedRepairLock();
  const paths = retainedAdoptionRequest(root, input, historical);
  const gate = lstatSync(paths.gate, { throwIfNoEntry: false }) ? retainedAdoptionGate(paths) : undefined;
  if (gate?.value.operation === input.operation) {
    const binding = { operation: input.operation, intentSha256: gate.value.intent.sha256 };
    const context = retainedAdoptionLoad(root, binding);
    if (!isDeepStrictEqual(context.intent.request, input)) reject("controller adoption replay changed its request");
    retainedAdoptionRunner(input, retainedAdoptionReadClosure(paths).map(file => file.descriptor),
      [context.intent.replacements[1], context.bootstrap?.intent.replacements[1]]);
    retainedAdoptionSource(paths, input);
    return binding;
  }
  // Historical completion proves immutable history only. Current source and
  // installed files are independently approved and checked below.
  const previous = gate ? retainedAdoptionCompletion(root, { operation: gate.value.operation, intentSha256: gate.value.intent.sha256 }, !historical) : undefined;
  if (historical && (!previous || !isDeepStrictEqual(input.historical, { gate: gate.file.descriptor, complete: previous.complete.descriptor }) ||
      isDeepStrictEqual(previous.intent.request.source, input.source)))
    reject("historical adoption requires the exact completed gate of a different incident");
  if (input.retirement && !previous) reject("retired incident adoption requires a completed predecessor");
  const bootstrapGate = retainedBootstrapPaths(paths).gate;
  let bootstrap;
  if (!previous && lstatSync(bootstrapGate, { throwIfNoEntry: false }))
    bootstrap = retainedBootstrapClosed(retainedBootstrapLoad(root, input.operation, input), true);
  retainedAdoptionRunner(input, undefined, bootstrap?.intent.replacements[1]);
  const source = retainedAdoptionSource(paths, input);
  if (previous && !historical && !retainedAdoptionSourceMatches(paths, previous.intent.request.source, input))
    reject("controller adoption predecessor source changed");
  const old = bootstrap ? bootstrap.backups : retainedAdoptionReadClosure(paths);
  if (!bootstrap && !isDeepStrictEqual(old.map(file => file.descriptor), input.oldClosure)) reject("controller adoption old closure changed");
  const replacements = bootstrap ? bootstrap.replacements : input.replacement.map((descriptor, index) => {
    migrationAncestors(dirname(descriptor.path), paths.owner, process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
    const file = migrationFile(descriptor.path, paths.owner, { privateOnly: false, mode: index === 0 ? 0o755 : 0o644, limit: migrationJournalLimit });
    if (!isDeepStrictEqual(file.descriptor, descriptor)) reject("controller adoption approved replacement changed");
    return file;
  });
  if (!bootstrap) retainedAdoptionProtocolCheck(old);
  retainedAdoptionProtocolCheck(replacements);
  retainedAdoptionJSON(paths.prefix + ".request.json", input);
  const original = retainedRepairFile(paths.prefix + ".original.json", source.bytes);
  const backups = old.map((file, index) => retainedRepairFile(paths.prefix + ".backup-" + index, file.bytes));
  const savedReplacements = replacements.map((file, index) => retainedRepairFile(paths.prefix + ".replacement-" + index, file.bytes));
  const predecessor = previous ? { gate: gate.file.descriptor,
    archive: retainedRepairFile(paths.prefix + ".predecessor-gate.json", gate.file.bytes), complete: previous.complete.descriptor } : undefined;
  const metadata = paths.destinations.map((path, index) => ({ path, mode: index === 0 ? 0o755 : 0o644, uid: paths.owner, gid: rootGroup() }));
  const intent = { version: 1, kind: "retained-controller-adoption", protocol: retainedAdoptionProtocol, request: input, lock, metadata, original, backups, replacements: savedReplacements, ...(bootstrap ? { bootstrap: bootstrap.closed.descriptor } : {}), ...(predecessor ? { predecessor } : {}) };
  const descriptor = retainedAdoptionJSON(paths.prefix + ".intent.json", intent);
  retainedAdoptionSource(paths, input);
  if (bootstrap) retainedBootstrapClosed(bootstrap, true);
  else if (!isDeepStrictEqual(retainedAdoptionReadClosure(paths).map(file => file.descriptor), input.oldClosure))
    reject("controller adoption old closure changed before gate publication");
  const nextGate = { version: 1, kind: "retained-controller-adoption-gate", protocol: retainedAdoptionProtocol, operation: input.operation, intent: descriptor };
  if (predecessor) {
    const stage = retainedAdoptionStage(paths.prefix + ".gate.next", Buffer.from(JSON.stringify(nextGate) + "\n"), 0o600);
    retainedAdoptionPredecessor(root, paths, predecessor, input);
    if (!isDeepStrictEqual(retainedAdoptionGate(paths).file.descriptor, predecessor.gate))
      reject("controller adoption predecessor gate changed before handoff");
    // EX FD9 serializes the one owner transfer. Preserve the prior gate above;
    // rename leaves either its completed owner or this prepared owner, never no gate.
    renameSync(stage.path, paths.gate); syncPath(dirname(paths.gate));
  } else retainedAdoptionJSON(paths.gate, nextGate);
  retainedAdoptionGate(paths, descriptor);
  return { operation: input.operation, intentSha256: descriptor.sha256 };
}
function retainedAdoptionStage(path, bytes, mode) {
  const owner = migrationOwner(), boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
  settleFixedPublications([{ path, mode, validate(actual) {
    if (!actual.equals(bytes)) reject("controller adoption interrupted staging bytes differ");
  } }], owner, boundary);
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    const temporary = path + ".next." + randomUUID();
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      fchownSync(fd, owner, rootGroup()); fchmodSync(fd, mode);
      writeFileSync(fd, bytes); fsyncSync(fd);
    } finally { closeSync(fd); }
    linkSync(temporary, path); unlinkSync(temporary); syncPath(dirname(path));
  }
  const file = migrationFile(path, owner, { privateOnly: false, mode, limit: migrationJournalLimit });
  if (!file.bytes.equals(bytes)) reject("controller adoption staging conflicts with approved bytes");
  syncPath(path); syncPath(dirname(path));
  return file.descriptor;
}
function retainedAdoptionStep(context, index) {
  const { paths, intent, replacements } = context;
  const path = paths.destinations[index], mode = index === 0 ? 0o755 : 0o644;
  const stepPath = paths.prefix + ".step-" + index + ".json";
  const stagePath = path + ".adoption-" + intent.request.operation + ".next";
  let step;
  if (lstatSync(stepPath, { throwIfNoEntry: false })) step = migrationJson(retainedAdoptionChecked(stepPath).bytes);
  else {
    const current = migrationFile(path, paths.owner, { privateOnly: false, mode, limit: migrationJournalLimit });
    if (!isDeepStrictEqual(current.descriptor, retainedAdoptionFrom(context, index))) reject("controller adoption has no intent for changed destination");
    const stage = retainedAdoptionStage(stagePath, replacements[index].bytes, mode);
    step = { version: 1, operation: intent.request.operation, index, from: current.descriptor,
      to: { ...stage, path }, stage, backup: intent.backups[index] };
    retainedAdoptionJSON(stepPath, step);
  }
  suspensionObject(step, ["version", "operation", "index", "from", "to", "stage", "backup"], "controller replacement intent");
  for (const value of [step.from, step.to, step.stage, step.backup]) validMigrationDescriptor(value, "path", "controller replacement file");
  if (step.version !== 1 || step.operation !== intent.request.operation || step.index !== index ||
      !isDeepStrictEqual(step.from, retainedAdoptionFrom(context, index)) || !isDeepStrictEqual(step.backup, intent.backups[index]) ||
      step.stage.path !== stagePath || step.to.path !== path || step.stage.sha256 !== replacements[index].descriptor.sha256 ||
      !isDeepStrictEqual(step.to, { ...step.stage, path })) reject("controller adoption replacement intent differs");
  let current = migrationFile(path, paths.owner, { privateOnly: false, mode, limit: migrationJournalLimit });
  if (isDeepStrictEqual(current.descriptor, step.from)) {
    const stage = migrationFile(stagePath, paths.owner, { privateOnly: false, mode, limit: migrationJournalLimit });
    if (!isDeepStrictEqual(stage.descriptor, step.stage)) reject("controller adoption exact staged inode changed");
    retainedAdoptionSource(paths, intent.request);
    renameSync(stagePath, path);
    syncPath(dirname(path));
    current = migrationFile(path, paths.owner, { privateOnly: false, mode, limit: migrationJournalLimit });
  }
  if (!isDeepStrictEqual(current.descriptor, step.to) || lstatSync(stagePath, { throwIfNoEntry: false }))
    reject("controller adoption destination is neither its exact old nor new inode");
  syncPath(path); syncPath(dirname(path));
  return current.descriptor;
}
function retainedAdoptionApply(root, binding) {
  retainedRepairLock();
  const context = retainedAdoptionLoad(root, binding);
  retainedAdoptionGate(context.paths, context.file.descriptor);
  retainedAdoptionSource(context.paths, context.intent.request);
  const observed = retainedAdoptionReadClosure(context.paths).map(file => file.descriptor);
  retainedAdoptionRunner(context.intent.request, observed, [context.intent.replacements[1], context.bootstrap?.intent.replacements[1]]);
  if (context.bootstrap) retainedBootstrapReaders(context.paths);
  const closure = context.paths.destinations.map((_, index) => retainedAdoptionStep(context, index));
  retainedAdoptionSource(context.paths, context.intent.request);
  retainedAdoptionProtocolCheck(retainedAdoptionReadClosure(context.paths));
  const complete = { version: 1, kind: "retained-controller-adoption-complete", operation: binding.operation,
    intent: context.file.descriptor, source: context.intent.request.source, closure };
  retainedAdoptionJSON(context.paths.prefix + ".complete.json", complete);
  return retainedAdoptionContext(root, binding);
}
function retainedAdoptionCompletion(root, binding, current = true) {
  const context = retainedAdoptionLoad(root, binding);
  if (current) retainedAdoptionGate(context.paths, context.file.descriptor);
  const file = retainedAdoptionChecked(context.paths.prefix + ".complete.json");
  const value = migrationJson(file.bytes);
  suspensionObject(value, ["version", "kind", "operation", "intent", "source", "closure"], "controller adoption completion");
  if (value.version !== 1 || value.kind !== "retained-controller-adoption-complete" || value.operation !== binding.operation ||
      !isDeepStrictEqual(value.intent, context.file.descriptor) || !isDeepStrictEqual(value.source, context.intent.request.source) ||
      !Array.isArray(value.closure) || value.closure.length !== 4 ||
      (current && !isDeepStrictEqual(retainedAdoptionReadClosure(context.paths).map(file => file.descriptor), value.closure)))
    reject("controller adoption completion does not match the complete installed closure");
  for (let index = 0; index < 4; index++) {
    const step = migrationJson(retainedAdoptionChecked(context.paths.prefix + ".step-" + index + ".json").bytes);
    if (step.version !== 1 || step.operation !== binding.operation || step.index !== index ||
        !isDeepStrictEqual(step.from, retainedAdoptionFrom(context, index)) ||
        !isDeepStrictEqual(step.backup, context.intent.backups[index]) ||
        step.stage?.path !== context.paths.destinations[index] + ".adoption-" + binding.operation + ".next" ||
        !isDeepStrictEqual(step.to, { ...step.stage, path: context.paths.destinations[index] }) ||
        step.to.sha256 !== context.intent.request.replacement[index].sha256 ||
        !isDeepStrictEqual(step.to, value.closure[index])) reject("controller adoption completion lost a replacement intent");
  }
  return { ...context, complete: file, value };
}
function retainedAdoptionContext(root, binding) {
  retainedRepairLock();
  const context = retainedAdoptionCompletion(root, binding);
  retainedAdoptionSource(context.paths, context.intent.request);
  return { version: 1, kind: "retained-controller-adoption-context", operation: binding.operation,
    source: context.intent.request.source, adoption: { intent: context.file.descriptor, complete: context.complete.descriptor },
    closure: context.value.closure };
}
function retainedAdoptionEntryGuard(entryCommand, entryArgs) {
  // The installed systemd condition is the sole no-FD9 entry; it has its own PID1/root/cgroup gate.
  if (entryCommand === "retained-repair-start-claim") return;
  // Unconditional: no ordinary read or mutation dispatch may outrun the exclusive owner lock.
  retainedRepairLock();
  if (entryCommand === "retained-controller-adoption") return;
  const root = process.env.OPENCLAW_TEAM_RELEASE_ROOT ?? "/opt/openclaw-team";
  const namespace = migrationNamespace(root);
  if (!lstatSync(join(namespace.directory, "controller-adoption.json"), { throwIfNoEntry: false })) {
    if (lstatSync(join(namespace.directory, "controller-bootstrap.json"), { throwIfNoEntry: false }))
      reject("controller bootstrap is incomplete; only its exact adoption owner may run");
    if (readdirSync(namespace.directory).some(name => /^repair-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.adoption\./.test(name)))
      reject("controller adoption artifacts exist without their fixed gate");
    return;
  }
  const paths = retainedAdoptionLocations(root);
  const gate = retainedAdoptionGate(paths);
  const binding = { operation: gate.value.operation, intentSha256: gate.value.intent.sha256 };
  const completed = retainedAdoptionCompletion(root, binding);
  const library = migrationFile(fileURLToPath(import.meta.url), paths.owner, { privateOnly: false, mode: 0o644, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(library.descriptor, completed.value.closure[1])) reject("old controller library is excluded after adoption");
  if (entryCommand === "controller-adoption-gate") {
    if (entryArgs.length !== 4 || entryArgs[0] !== root || entryArgs[1] !== paths.destinations[0] ||
        integer(entryArgs[2], "executing script device") !== completed.value.closure[0].device ||
        integer(entryArgs[3], "executing script inode") !== completed.value.closure[0].inode)
      reject("old controller executable is excluded after adoption");
  }
}
function retainedControllerAdoption(action, root, input) {
  switch (action) {
    case "inspect-prestart": return retainedAdoptionRetirePrestart(root, input, true);
    case "retire-prestart": return retainedAdoptionRetirePrestart(root, input);
    case "bootstrap": return retainedBootstrap(root, input);
    case "prepare": return retainedAdoptionPrepare(root, input);
    case "historical-successor": return retainedAdoptionPrepare(root, input, true);
    case "apply": return retainedAdoptionApply(root, input);
    case "context": return retainedAdoptionContext(root, input);
    default: reject("controller adoption only implements bootstrap, prepare, historical-successor, apply and context");
  }
}

// Strict acceptance consumes the canonical lifecycle owner and its retained evidence.
// It does not grant independent lifecycle, project-mutation, or restart authority.
function retainedRepairAcceptanceContext(root, input) {
  validMigrationDescriptor(input, "path", "retained acceptance journal");
  const checked = retainedRepairLifecycle("inspect", root, { journal: input });
  if (!isDeepStrictEqual(checked.journal, input)) reject("acceptance requires the exact current journal descriptor");
  const { record, snapshot } = checked;
  if (!["REPAIR_STARTED", "REPAIR_VERIFIED"].includes(record.phase)) reject("retained acceptance requires STARTED or VERIFIED");
  retainedRepairNative(root, checked, "live-c");
  const started = record.lifecycle.started;
  const c = {
    operation: record.operation,
    phase: record.phase === "REPAIR_STARTED" ? "STARTED" : "VERIFIED",
    target: { sha: snapshot.request.target.sha, release: join(root, "releases", snapshot.request.target.sha), manifestSha256: snapshot.request.target.manifestSha256 },
    process: { pid: started.process.pid, generation: String(started.process.generation), instance: started.instance },
    // The bound drain event has an immutable 30s deadline. Its creation time is a
    // conservative operation lower bound; only startIntent.deadlineMs limits verification.
    startedAtMs: record.lifecycle.bound.drain.deadlineMs - 30000,
    deadlineMs: record.lifecycle.startIntent.deadlineMs,
    configPath: snapshot.config.path,
    stateDatabase: snapshot.evidence.record.protectedPaths[1].path,
    witness: record.lifecycle.stopped.floor,
  };
  suspensionObject(c, ["operation", "phase", "target", "process", "startedAtMs", "deadlineMs", "configPath", "stateDatabase", "witness"], "retained lifecycle acceptance context");
  if (!["STARTED", "VERIFIED"].includes(c.phase)) reject("retained acceptance requires STARTED or VERIFIED");
  suspensionObject(c.target, ["sha", "release", "manifestSha256"], "retained acceptance target");
  suspensionObject(c.process, ["pid", "generation", "instance"], "retained acceptance generation");
  if (!shaPattern.test(c.target.sha) || c.target.release !== join(root, "releases", c.target.sha) ||
      !/^[a-f0-9]{64}$/.test(c.target.manifestSha256) || !Number.isSafeInteger(c.process.pid) || c.process.pid <= 0 ||
      typeof c.process.generation !== "string" || !/^[0-9]+$/.test(c.process.generation) ||
      typeof c.process.instance !== "string" || !c.process.instance ||
      !Number.isSafeInteger(c.startedAtMs) || !Number.isSafeInteger(c.deadlineMs) || c.startedAtMs <= 0 ||
      c.deadlineMs <= c.startedAtMs || c.deadlineMs - c.startedAtMs > 86400000)
    reject("retained acceptance target, generation, or absolute deadline is invalid");
  for (const path of [c.configPath, c.stateDatabase]) {
    if (typeof path !== "string" || !isAbsolute(path) || realpathSync(path) !== path) reject("acceptance state path is not canonical");
  }
  validMigrationDescriptor(c.witness, "path", "retained acceptance witness");
  const paths = retainedRepairPaths(root, c.operation);
  const manifest = migrationFile(join(c.target.release, "deployment.json"), migrationOwner(), { privateOnly: false });
  if (manifest.descriptor.sha256 !== c.target.manifestSha256) reject("acceptance target manifest changed");
  // The lifecycle owner validates its sealed release and actual selected/live generation.
  retainedRepairBoundFile(c.witness);
  return { ...c, journal: input, paths };
}
function retainedRepairAcceptanceScope(c) {
  const { phase, journal, paths, ...scope } = c;
  return scope;
}
function retainedRepairAcceptancePublication(path, validate) {
  // Unlike permits, these typed acceptance artifacts may recover their sole
  // pre-link inode: no model dispatch can precede successful fixed publication.
  retainedRepairLock();
  const owner = migrationOwner(), boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
  migrationAncestors(dirname(path), owner, boundary);
  settleFixedPublications([{ path, mode: 0o600, validate }], owner, boundary);
  const prefix = basename(path) + ".next.";
  const orphans = readdirSync(dirname(path)).filter(name => name.startsWith(prefix) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name.slice(prefix.length)));
  if (!orphans.length) return;
  if (orphans.length !== 1 || lstatSync(path, { throwIfNoEntry: false }))
    reject("retained acceptance publication has ambiguous pending inodes");
  const pendingPath = join(dirname(path), orphans[0]);
  const pending = migrationFile(pendingPath, owner, { mode: 0o600, limit: migrationJournalLimit });
  validate(pending.bytes);
  syncPath(pendingPath);
  // Only this exact operation's validated, owner-safe inode becomes authoritative.
  linkSync(pendingPath, path);
  unlinkSync(pendingPath);
  syncPath(dirname(path));
  const published = migrationFile(path, owner, { mode: 0o600, limit: migrationJournalLimit });
  if (published.descriptor.device !== pending.descriptor.device || published.descriptor.inode !== pending.descriptor.inode ||
      published.descriptor.sha256 !== pending.descriptor.sha256) reject("retained acceptance pending publication changed");
}
function retainedRepairAcceptanceBudget(c) {
  const remainingSeconds = Math.floor((c.deadlineMs - Date.now()) / 1000);
  if (remainingSeconds <= 0) reject("retained acceptance absolute deadline expired");
  return remainingSeconds;
}
function retainedRepairAcceptanceModelPolicy(c) {
  const raw = policy(c.configPath);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import {pathToFileURL} from "node:url"; const [release,raw]=process.argv.slice(1), p=JSON.parse(raw); const {splitTrailingAuthProfile}=await import(pathToFileURL(release+"/dist/plugin-sdk/model-ref-parse.js").href); process.stdout.write(JSON.stringify({model:splitTrailingAuthProfile(p.model).model,fallbacks:p.fallbacks.map(x=>splitTrailingAuthProfile(x).model)}));',
    c.target.release, JSON.stringify(raw)], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) reject("native model-ref policy parser failed");
  return JSON.parse(result.stdout);
}
function retainedRepairAcceptanceApprovals(c, sessionId) {
  const count = databaseRead(c.stateDatabase, db => db.prepare(
    "SELECT COUNT(*) AS count FROM operator_approvals WHERE source_session_id = ?").get(sessionId)?.count);
  if (count !== 0) reject("retained marker session created an approval");
}
function retainedRepairAcceptanceProject(c) {
  // Original failing incident request, not project discovery or a profile override.
  // The exact deployed C is separately owned by the sealed release/lifecycle.
  const projectId = "openclaw";
  const databaseIdentity = identity(c.stateDatabase);
  const row = databaseRead(c.stateDatabase, db => {
    if (db.prepare("SELECT type FROM sqlite_schema WHERE name='projects'").get()?.type !== "table")
      reject("native project registry is absent");
    const rows = db.prepare("SELECT id,repo_root,source,origin_url FROM projects WHERE id=?").all(projectId);
    if (rows.length !== 1 || rows[0].id !== projectId || !["registered", "cloned"].includes(rows[0].source))
      reject("exact registered repair project is absent or changed");
    return rows[0];
  });
  const repoRoot = row.repo_root;
  if (typeof repoRoot !== "string" || !isAbsolute(repoRoot) || realpathSync(repoRoot) !== repoRoot)
    reject("registered repair project root changed");
  const entry = lstatSync(repoRoot);
  if (!entry.isDirectory() || entry.isSymbolicLink()) reject("repair project root is not a directory");
  if (!isDeepStrictEqual(identity(c.stateDatabase), databaseIdentity)) reject("project registry database identity changed");
  return { id: projectId, repoRoot, source: row.source, originUrl: row.origin_url ?? null,
    device: entry.dev, inode: entry.ino, database: databaseIdentity };
}
function retainedRepairAcceptanceCheckout(proof, record) {
  suspensionObject(proof, ["method", "params", "response"], "retained project checkout proof");
  const params = JSON.parse(record.checkoutPayload);
  if (proof.method !== "projects.checkoutOptions" || !isDeepStrictEqual(proof.params, params))
    reject("retained project checkout request changed");
  suspensionObject(proof.response, ["current", "worktree"], "native project checkout options");
  if (typeof proof.response.current !== "boolean" || typeof proof.response.worktree !== "boolean" || !proof.response.current)
    reject("registered project's current checkout is unavailable");
}
function retainedRepairAcceptanceSession(c, record, required = false) {
  const modelAgent = operatorProfile().modelAgent;
  const row = databaseRead(c.stateDatabase, db => {
    const rows = db.prepare("SELECT path FROM agent_databases WHERE agent_id=?").all(modelAgent);
    if (rows.length !== 1) reject("model agent database owner is ambiguous");
    return rows[0];
  });
  const stateRoot = dirname(dirname(c.stateDatabase));
  const database = isAbsolute(row.path) ? row.path : resolve(stateRoot, row.path);
  if (realpathSync(database) !== database) reject("model agent database is not canonical");
  const databaseIdentity = identity(database);
  const result = databaseRead(database, db => {
    const rows = db.prepare("SELECT current_session_id,entry_json FROM session_nodes WHERE session_key=?").all(record.sessionKey);
    if (!rows.length && !required) return null;
    if (rows.length !== 1) reject("retained marker session is missing or ambiguous");
    const r = rows[0], entry = JSON.parse(r.entry_json);
    if (typeof r.current_session_id !== "string" || !r.current_session_id || entry.sessionId !== r.current_session_id ||
        entry.projectId !== record.project.id || entry.spawnedCwd !== record.project.repoRoot ||
        entry.sessionRoot !== record.project.repoRoot || (entry.spawnedWorkspaceDir !== undefined && entry.spawnedWorkspaceDir !== record.project.repoRoot) || entry.worktree !== undefined || entry.repositoryWorkspaceId !== undefined ||
        entry.deviceFolder !== undefined) reject("native marker session is not bound to exact registered project checkout");
    return { sessionId: r.current_session_id, sessionKey: record.sessionKey, database: databaseIdentity };
  });
  if (!isDeepStrictEqual(identity(database), databaseIdentity)) reject("model agent database changed during session proof");
  return result;
}
function retainedRepairAcceptanceRead(c) {
  const prepared = retainedRepairRead(`${c.paths.prefix}.acceptance.json`);
  const record = migrationJson(prepared.bytes);
  suspensionObject(record, ["version", "kind", "scope", "sourceJournal", "profile", "policy", "project", "marker", "sessionKey", "creationPayload", "checkoutPayload"], "retained acceptance record");
  if (record.version !== 1 || record.kind !== "retained-repair-acceptance" ||
      !isDeepStrictEqual(record.scope, retainedRepairAcceptanceScope(c)) ||
      !isDeepStrictEqual(record.profile, operatorProfile()) || !isDeepStrictEqual(record.policy, policy(c.configPath)) ||
      !isDeepStrictEqual(record.project, retainedRepairAcceptanceProject(c))) reject("retained acceptance scope, policy, or checkout changed");
  validMigrationDescriptor(record.sourceJournal, "path", "acceptance source journal");
  if (record.sourceJournal.path !== c.journal.path) reject("acceptance source journal namespace changed");
  const agentId = operatorProfile().modelAgent;
  const marker = `TEAM_REPAIR_${c.operation}`;
  const sessionKey = `agent:${agentId}:explicit:team-repair-${c.operation}`;
  const expectedCreation = { key: sessionKey, agentId, projectId: record.project.id, idempotencyKey: `team-repair-session-${c.operation}` };
  if (record.marker !== marker || record.sessionKey !== sessionKey || record.creationPayload !== JSON.stringify(expectedCreation) ||
      record.checkoutPayload !== JSON.stringify({ projectId: "openclaw", agentId: "roboclaw" }))
    reject("retained marker or native session creation payload changed");
  return { prepared: prepared.descriptor, record };
}
function retainedRepairAcceptanceDispatch(c, record, create = false) {
  const path = `${c.paths.prefix}.acceptance-dispatch.json`;
  const session = retainedRepairAcceptanceSession(c, record, existsSync(path));
  if (!session) return null;
  // Reuse a fully fsynced pending inode too: do not mint another idempotency key
  // after a crash between the exclusive write and fixed-name publication.
  retainedRepairAcceptancePublication(path, bytes => {
    const saved = migrationJson(bytes);
    if (saved?.version !== 1 || saved.kind !== "retained-repair-dispatch" || !isDeepStrictEqual(saved.session, session))
      reject("pending retained dispatch belongs to another session");
  });
  let file;
  if (create && !existsSync(path)) {
    const remaining = retainedRepairAcceptanceBudget(c);
    const payload = JSON.stringify({ agentId: operatorProfile().modelAgent, sessionId: session.sessionId,
      sessionKey: record.sessionKey, expectedExistingSessionId: session.sessionId, deliver: false,
      cwd: record.project.repoRoot,
      message: `Output only this exact string, byte-for-byte, with no prefix or suffix: ${record.marker}`,
      timeout: remaining, idempotencyKey: randomUUID() });
    retainedRepairFile(path, Buffer.from(JSON.stringify({ version: 1, kind: "retained-repair-dispatch", session, payload }) + "\n"));
  }
  file = retainedRepairRead(path);
  const dispatch = migrationJson(file.bytes);
  suspensionObject(dispatch, ["version", "kind", "session", "payload"], "retained acceptance dispatch");
  if (dispatch.version !== 1 || dispatch.kind !== "retained-repair-dispatch" || !isDeepStrictEqual(dispatch.session, session) ||
      typeof dispatch.payload !== "string") reject("retained acceptance session changed");
  const payload = JSON.parse(dispatch.payload);
  suspensionObject(payload, ["agentId", "sessionId", "sessionKey", "expectedExistingSessionId", "deliver", "cwd", "message", "timeout", "idempotencyKey"], "retained marker payload");
  if (payload.agentId !== operatorProfile().modelAgent || payload.sessionId !== session.sessionId ||
      payload.sessionKey !== record.sessionKey || payload.expectedExistingSessionId !== session.sessionId || payload.deliver !== false ||
      payload.cwd !== record.project.repoRoot || payload.message !== `Output only this exact string, byte-for-byte, with no prefix or suffix: ${record.marker}` ||
      !Number.isSafeInteger(payload.timeout) || payload.timeout <= 0 || payload.timeout * 1000 > c.deadlineMs - c.startedAtMs ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(payload.idempotencyKey))
    reject("retained marker dispatch binding changed");
  return { ...dispatch, descriptor: file.descriptor };
}
function retainedRepairAcceptanceTerminal(reply, dispatch, record, markerPolicy) {
  const p = JSON.parse(dispatch.payload), receipt = reply.terminalReceipt;
  if (reply.runId !== p.idempotencyKey || reply.status !== "ok" || reply.error || reply.pendingError === true ||
      reply.stopReason !== "stop" || reply.terminalReply?.disposition !== "visible" || reply.terminalReply.text !== record.marker ||
      !Number.isFinite(reply.endedAt) || receipt?.runId !== p.idempotencyKey || receipt.sessionId !== p.sessionId ||
      typeof receipt.turnId !== "string" || !receipt.turnId.trim() || receipt.terminalDisposition !== "visible" ||
      receipt.requested?.provider + "/" + receipt.requested?.model !== markerPolicy.model ||
      ![markerPolicy.model, ...markerPolicy.fallbacks].includes(receipt.effective?.provider + "/" + receipt.effective?.model))
    reject("retained marker lacks an exact terminal model/session/marker receipt");
}
function retainedRepairAcceptance(action, root, input) {
  if (!["prepare", "check", "receipt"].includes(action)) reject("unknown retained acceptance action");
  const lock = retainedRepairLock(), c = retainedRepairAcceptanceContext(root, input);
  const path = `${c.paths.prefix}.acceptance.json`;
  if (action === "prepare" && !existsSync(path)) {
    if (c.phase !== "STARTED") reject("cannot prepare acceptance after lifecycle verification");
    retainedRepairAcceptanceBudget(c);
    const project = retainedRepairAcceptanceProject(c), agentId = operatorProfile().modelAgent;
    const sessionKey = `agent:${agentId}:explicit:team-repair-${c.operation}`;
    const record = { version: 1, kind: "retained-repair-acceptance", scope: retainedRepairAcceptanceScope(c),
      sourceJournal: input, profile: operatorProfile(), policy: policy(c.configPath), project,
      marker: `TEAM_REPAIR_${c.operation}`, sessionKey,
      creationPayload: JSON.stringify({ key: sessionKey, agentId, projectId: project.id, idempotencyKey: `team-repair-session-${c.operation}` }),
      checkoutPayload: JSON.stringify({ projectId: "openclaw", agentId: "roboclaw" }) };
    if (retainedRepairAcceptanceSession(c, record)) reject("fresh retained marker session already exists");
    retainedRepairFile(path, Buffer.from(JSON.stringify(record) + "\n"));
  }
  const { prepared, record } = retainedRepairAcceptanceRead(c);
  // An existing verified receipt is readable after expiry; never starts a new run.
  const receiptPath = `${c.paths.prefix}.acceptance-receipt.json`;
  retainedRepairAcceptancePublication(receiptPath, bytes => {
    const saved = migrationJson(bytes);
    if (saved?.version !== 1 || saved.kind !== "retained-repair-acceptance-receipt" ||
        !isDeepStrictEqual(saved.prepared, prepared) || !isDeepStrictEqual(saved.scope, record.scope))
      reject("pending retained receipt belongs to another acceptance");
  });
  const priorReceipt = existsSync(receiptPath) ? retainedRepairRead(receiptPath) : null;
  const remainingSeconds = priorReceipt ? Math.max(0, Math.floor((c.deadlineMs - Date.now()) / 1000)) : retainedRepairAcceptanceBudget(c);
  const dispatch = retainedRepairAcceptanceDispatch(c, record, action === "prepare");
  if (action === "receipt" && !priorReceipt) {
    if (!dispatch || c.phase !== "STARTED") reject("terminal receipt requires exact STARTED dispatch");
    const proof = JSON.parse(process.env.OPENCLAW_TEAM_REPAIR_ACCEPTANCE_PROOF ?? "null");
    suspensionObject(proof, ["reply", "markerPolicy", "channels", "process", "checkout"], "retained terminal proof");
    retainedRepairAcceptanceCheckout(proof.checkout, record);
    suspensionObject(proof.markerPolicy, ["model", "fallbacks"], "retained terminal model policy");
    // markerPolicy is normalized by the native model-ref parser in verify_marker.
    if (typeof proof.markerPolicy.model !== "string" || !Array.isArray(proof.markerPolicy.fallbacks) ||
        proof.markerPolicy.fallbacks.some(value => typeof value !== "string")) reject("retained marker policy is invalid");
    if (!isDeepStrictEqual(proof.markerPolicy, retainedRepairAcceptanceModelPolicy(c))) reject("retained receipt model policy changed");
    retainedRepairAcceptanceApprovals(c, dispatch.session.sessionId);
    retainedRepairAcceptanceTerminal(proof.reply, dispatch, record, proof.markerPolicy);
    snapshotCpuWaived(proof.channels, false, "retained repair channels", true);
    verifyChannelAccounts(proof.channels);
    if (proof.process.pid !== c.process.pid || proof.process.processInstanceId !== c.process.instance) reject("retained receipt process generation changed");
    retainedRepairAcceptanceBudget(c);
    const value = { version: 1, kind: "retained-repair-acceptance-receipt", acceptedAtMs: Date.now(),
      prepared, dispatch: dispatch.descriptor, scope: record.scope, project: record.project, proof };
    retainedRepairFile(receiptPath, Buffer.from(JSON.stringify(value) + "\n"));
  }
  const receiptFile = existsSync(receiptPath) ? retainedRepairRead(receiptPath) : null;
  if (receiptFile) {
    const r = migrationJson(receiptFile.bytes);
    suspensionObject(r, ["version", "kind", "acceptedAtMs", "prepared", "dispatch", "scope", "project", "proof"], "retained terminal receipt");
    if (!dispatch || r.version !== 1 || r.kind !== "retained-repair-acceptance-receipt" ||
        !Number.isSafeInteger(r.acceptedAtMs) || r.acceptedAtMs < c.startedAtMs || r.acceptedAtMs > c.deadlineMs ||
        !isDeepStrictEqual(r.prepared, prepared) || !isDeepStrictEqual(r.dispatch, dispatch.descriptor) ||
        !isDeepStrictEqual(r.scope, record.scope) || !isDeepStrictEqual(r.project, record.project)) reject("retained receipt binding changed");
    retainedRepairAcceptanceCheckout(r.proof.checkout, record);
    if (!isDeepStrictEqual(r.proof.markerPolicy, retainedRepairAcceptanceModelPolicy(c))) reject("retained receipt model policy changed");
    retainedRepairAcceptanceApprovals(c, dispatch.session.sessionId);
    retainedRepairAcceptanceTerminal(r.proof.reply, dispatch, record, r.proof.markerPolicy);
    snapshotCpuWaived(r.proof.channels, false, "retained receipt channels", true);
    verifyChannelAccounts(r.proof.channels);
    if (r.proof.process.pid !== c.process.pid || r.proof.process.processInstanceId !== c.process.instance) reject("retained receipt process changed");
  }
  if (!isDeepStrictEqual(retainedRepairLock(), lock)) reject("acceptance lock changed");
  // Revalidate current journal and lifecycle evidence after publishing any private artifacts.
  retainedRepairAcceptanceContext(root, input);
  return { kind: "retained-repair-acceptance", status: receiptFile ? "VERIFIED" : dispatch ? "READY" : "PREPARED",
    journal: input, prepared, receipt: receiptFile?.descriptor ?? null, scope: record.scope,
    remainingSeconds, marker: record.marker, sessionKey: record.sessionKey,
    creationPayload: record.creationPayload, checkoutPayload: record.checkoutPayload, payload: dispatch?.payload ?? null, session: dispatch?.session ?? null,
    witness: migrationJson(retainedRepairBoundFile(c.witness).bytes) };
}

// Parent lifecycle verify consumes this exact private receipt descriptor.
function retainedRepairAcceptanceReceipt(root, context, descriptor) {
  validMigrationDescriptor(descriptor, "path", "retained terminal acceptance receipt");
  const result = retainedRepairAcceptance("check", root, context.journal);
  if (result.status !== "VERIFIED" || !isDeepStrictEqual(result.receipt, descriptor))
    reject("repair lifecycle requires the exact durable strict acceptance receipt");
  return result.receipt;
}

try {
  retainedAdoptionEntryGuard(command, args);
  if (["suspension-prepare", "suspension-status", "suspension-recovery-status", "suspension-running", "retained-repair-lifecycle"].includes(command)) {
    // Import the reviewed public protocol closure, never a mutable installed package.
    // Loading these verified bytes also avoids rereading a replaced module path.
    const bytes = readFileSync(suspensionContractPath);
    if (createHash("sha256").update(bytes).digest("hex") !== suspensionContractSha256)
      reject("Gateway suspension contract artifact hash changed");
    suspensionContract = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
  }
  let result;
  switch (command) {
    case "retained-controller-adoption":
      if (args.length !== 3) reject("usage: retained-controller-adoption prepare|historical-successor|apply|context ROOT INPUT");
      result = JSON.stringify(retainedControllerAdoption(args[0], args[1], jsonArgument(args[2])));
      break;
    case "controller-adoption-gate":
      if (args.length !== 4) reject("usage: controller-adoption-gate ROOT SCRIPT DEVICE INODE");
      result = "CONTROLLER_CLOSURE_READY";
      break;
    case "gateway-runtime":
      result = runtimeOperation(args[0], args[1], args.slice(2));
      if (typeof result !== "string") result = JSON.stringify(result);
      break;
    case "host-handoff":
      result = await hostHandoffCommand(args[0], args[1], args.slice(2));
      if (typeof result !== "string") result = JSON.stringify(result);
      break;
    case "worker-config":
      result = workerConfigCommand(args[0], args[1], args.slice(2));
      break;
    case "steady-profile": {
      if (args.length !== 5) reject("usage: steady-profile OPERATION ROOT SHA PID START");
      result = JSON.stringify(await startupProfileCommand("capture-steady", {
        operation: args[0], root: args[1], sha: args[2], pid: integer(args[3], "capture PID"), start: args[4],
      }));
      break;
    }
    case "startup-profile": {
      try { result = JSON.stringify(await startupProfileCommand(args[0], jsonArgument("@stdin"))); }
      catch (error) {
        let location = "";
        try {
          const stack = error?.stack;
          if (typeof stack === "string") {
            for (const frame of stack.split("\n").slice(1)) {
              const match = /^\s+at (?:.* \()?(.+):([1-9]\d*):([1-9]\d*)\)?$/.exec(frame);
              if (match?.[1] === import.meta.url) {
                location = ` at release-lib.mjs:${match[2]}:${match[3]}`;
                break;
              }
            }
          }
        } catch { /* Stack access must not expose a second private error. */ }
        reject(`startup profiling owner refused during ${args[0]}${location}; verify unit, runtime, artifact and process prerequisites`);
      }
      break;
    }

    case "migration-publication-recover":
      if (args.length !== 1) reject("usage: migration-publication-recover ROOT");
      result = migrationRecoverPublications(args[0]);
      break;
    case "migration-unit-path": {
      const value = migrationArgument(args[0]);
      if (value?.type !== "o" || !Array.isArray(value.data) || value.data.length !== 1 ||
          typeof value.data[0] !== "string" || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(value.data[0]))
        reject("systemd GetUnit did not return one typed unit object path");
      result = value.data[0];
      break;
    }
    case "migration-guard-descriptor": {
      const root = args[0], boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
      const pathname = join(boundary, "etc/systemd/system/openclaw-gateway.service.d", migrationGuardName);
      migrationAncestors(dirname(pathname), migrationOwner(), boundary);
      const file = migrationFile(pathname, migrationOwner(), { privateOnly: false, mode: 0o644 });
      if (!file.bytes.equals(Buffer.from(migrationGuardBody(root)))) reject("native migration condition asset changed");
      result = JSON.stringify(file.descriptor);
      break;
    }
    case "migration-permit-present":
      if (!migrationPermit(args[0])) reject("native Gateway start permit is missing; never remint it on resume");
      result = "PERMITTED";
      break;
    case "migration-permit-absent":
      if (migrationPermit(args[0])) reject("Gateway start permit still permits a reader");
      result = "FENCED";
      break;
    case "migration-kind":
      if (args.length !== 2) reject("usage: migration-kind BEFORE_INFO_JSON AFTER_INFO_JSON");
      result = migrationKind(migrationArgument(args[0]), migrationArgument(args[1]));
      break;
    case "migration-guard-install":
      if (args.length !== 4) reject("usage: migration-guard-install FRAGMENT_PATH ROOT ROOT_UID ANCESTOR_BOUNDARY");
      result = JSON.stringify(migrationGuardInstall(...args));
      break;
    case "migration-guard-verify":
      if (args.length !== 4) reject("usage: migration-guard-verify GUARD_DESCRIPTOR_JSON CONDITIONS_JSON EXEC_CONDITION_EX_JSON ROOT");
      result = migrationGuardVerify(migrationArgument(args[0]), migrationArgument(args[1]), migrationArgument(args[2]), args[3]);
      break;
    case "user-manager-stopped":
      if (args.length !== 2) reject("usage: user-manager-stopped ANCESTOR_BOUNDARY RUNTIME_UID");
      result = assertUserManagerStopped(...args);
      break;
    case "maintenance-idle":
      if (args.length !== 1) reject("usage: maintenance-idle ANCESTOR_BOUNDARY");
      result = assertMaintenanceIdle(args[0]);
      break;
    case "audit-root": {
      const [root, rawUid, runtimeUid, deployUid, stopAt = "/"] = args;
      const owner = integer(rawUid, "root owner");
      const runtimeOwner = integer(runtimeUid, "runtime owner");
      const deployOwner = integer(deployUid, "deploy owner");
      if (runtimeOwner === owner || deployOwner === owner || runtimeOwner === deployOwner) {
        reject("runtime/build account cannot own the release namespace");
      }
      let ancestor = resolve(root);
      const boundary = resolve(stopAt);
      while (true) {
        exactDirectory(ancestor, owner, `release ancestor ${ancestor}`);
        if (ancestor === boundary || ancestor === "/") break;
        ancestor = dirname(ancestor);
      }
      exactDirectory(join(root, "releases"), owner, "release directory");
      for (const name of ["staging", "journal", "pins", "failed", "quarantine"]) {
        exactDirectory(join(root, name), owner, name, { privateOnly: true });
      }
      const rootDevice = lstatSync(root).dev;
      for (const name of ["releases", "staging", "journal", "pins", "failed", "quarantine"]) {
        if (lstatSync(join(root, name)).dev !== rootDevice) reject(`${name} crosses filesystems`);
      }
      for (const name of ["current", "previous"]) {
        const pathname = join(root, name);
        if (!existsSync(pathname)) continue;
        const entry = lstatSync(pathname);
        if (!entry.isSymbolicLink() || entry.uid !== owner || entry.gid !== rootGroup()) {
          reject(`${name} pointer is replaceable`);
        }
        const target = realpathSync(pathname);
        if (
          dirname(target) !== join(root, "releases") ||
          !shaPattern.test(target.split("/").at(-1))
        ) {
          reject(`${name} pointer escapes the authoritative namespace`);
        }
      }
      result = "OWNER_SAFE";
      break;
    }
    case "audit-build":
      result = auditBuild(...args);
      break;
    case "validate-frozen-release": {
      if (args.length !== 4) reject("usage: validate-frozen-release RELEASE TARGET_SHA MANIFEST_SHA ROOT_UID");
      result = JSON.stringify(validateFrozenRelease(args[0], args[1], args[2], integer(args[3], "release owner")));
      break;
    }
    case "validate-release": {
      const [root, expected, rawUid, mode = "sealed"] = args;
      result = JSON.stringify(
        validateRelease(
          root,
          expected,
          integer(rawUid, "release owner"),
          mode === "sealed",
          mode !== "candidate",
        ),
      );
      break;
    }
    case "release-capacity":
      if (args.length !== 6) reject("usage: release-capacity fetch|build|stage|activate REFERENCE MIRROR BUILD_HOME SERVING_ROOT RUNTIME_HOME");
      result = JSON.stringify({ phase: args[0], filesystems: releaseCapacity(...args) });
      break;
    case "manifest": {
      const [root, expected, rawUid, frozenMain] = args;
      const release = validateRelease(
        root,
        expected,
        integer(rawUid, "release owner"),
        false,
        false,
      );
      atomicJson(join(root, "deployment.json"), {
        version: 1,
        sourceSha: expected,
        frozenOriginMain: frozenMain,
        origin: "https://github.com/openclaw/openclaw.git",
        buildId: release.buildId,
        controlUiSha256: release.controlUiSha256,
        schemaVersions: release.schemaVersions,
        ...(release.buildCacheInputs ? { buildCacheInputs: release.buildCacheInputs } : {}),
        createdAt: new Date().toISOString(),
      });
      result = JSON.stringify(release);
      break;
    }
    case "fingerprint":
      result = JSON.stringify(args.map(identity));
      break;
    case "policy":
      result = JSON.stringify(policy(args[0]));
      break;
    case "scheduler": {
      const status = jsonArgument(args[0]);
      const campaign = status.campaign ?? status.schedule?.campaign ?? null;
      if (campaign !== null || status.schedule?.autoEnabled !== false) {
        reject("built-in update campaign or automatic scheduler is active");
      }
      result = "SCHEDULER_OK";
      break;
    }
    case "approvals": {
      const [databasePath, session] = args;
      if (!session) reject("approval proof requires an exact session");
      result = String(
        databaseRead(databasePath, (database) => {
          const row = database
            .prepare("SELECT COUNT(*) AS count FROM operator_approvals WHERE source_session_id = ?")
            .get(session);
          if (!Number.isSafeInteger(row?.count)) reject("session approval count is malformed");
          return row.count;
        }),
      );
      break;
    }
    case "compatibility":
    case "session-preservation-witness":
    case "session-preservation-verify": {
      const [current, target, databasePath] = args;
      const existing = jsonFile(join(current, "package.json")).openclaw.schemaVersions;
      const candidate = jsonFile(join(target, "package.json")).openclaw.schemaVersions;
      const warnings = sessionPreservationWarnings();
      const witness = [];
      const pending = new Map();
      if (command === "session-preservation-verify") {
        for (const [ordinal, tuple] of sessionWitnessTuples(jsonArgument("@stdin")).entries()) {
          const identity = JSON.stringify(tuple.slice(0, 4));
          const sessions = pending.get(identity) ?? [];
          sessions.push({ tuple, ordinal });
          pending.set(identity, sessions);
        }
      }
      const inspectAgent = (database, agentId, pathname, entry) => {
        const identity = [agentId, realpathSync(pathname), entry.dev, entry.ino];
        if (command === "session-preservation-witness") {
          for (const row of database
            .prepare(`SELECT n.session_key, n.current_session_id, n.entry_json,
            w.session_key AS window_key, t.generation
            FROM session_nodes n LEFT JOIN session_windows w ON w.session_id = n.current_session_id
            LEFT JOIN transcript_rewrite_watermarks t ON t.session_id = w.session_id`)
            .all()) {
            // Core hard-deletes these hidden, suppressed-effect rows after their owning run
            // settles. Their visible parent/child sessions remain independently captured.
            if (intentionallyEphemeralInternalSession(
              agentId,
              row.session_key,
              row.current_session_id,
              row.window_key,
              row.entry_json,
            )) continue;
            witness.push(
              JSON.stringify([
                ...identity,
                row.session_key,
                row.current_session_id,
                row.window_key,
                row.generation,
              ]),
            );
          }
          return;
        }
        const key = JSON.stringify(identity);
        const expected = pending.get(key);
        if (!expected) return;
        for (const { tuple, ordinal } of expected) {
          const [sessionKey, sessionId, windowKey, generation] = tuple.slice(4);
          const failure = transcriptPreservationFailure(database, sessionKey, sessionId, windowKey, generation);
          if (failure) warnings.record(tuple, ordinal, failure);
        }
        pending.delete(key);
      };
      const state = verifyStateCompatibility(
        databasePath,
        existing,
        candidate,
        command === "compatibility" ? undefined : inspectAgent,
        [...pending.values()].map(sessions => sessions[0].tuple),
      );
      if (command === "compatibility") result = JSON.stringify(state);
      else if (command === "session-preservation-witness") result = JSON.stringify(witness.sort());
      else {
        if (pending.size) reject("a captured session database identity is missing or changed");
        const gaps = warnings.finish();
        result = gaps ? `SESSIONS_HISTORY_WARNING count=${gaps}` : "SESSIONS_PRESERVED";
      }
      break;
    }
    case "stopped-current-state": {
      if (args.length !== 6 || !["stopped", "live"].includes(args[4]))
        reject("usage: stopped-current-state RELEASE CONFIG DATABASE PROC_ROOT stopped|live RUNTIME_UID");
      const [release, config, database, procRoot, phase, rawRuntimeUid] = args;
      const owners = new Set([migrationOwner(), integer(rawRuntimeUid, "runtime state owner")]);
      const boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
      const checkPath = (pathname, optional = false) => {
        if (!isAbsolute(boundary) || resolve(boundary) !== boundary ||
            !isAbsolute(pathname) || resolve(pathname) !== pathname)
          reject("stopped current state paths must be canonical absolute paths");
        safeRelative(boundary, pathname);
        const entry = lstatSync(pathname, { throwIfNoEntry: false });
        if (!entry && optional) return;
        if (!entry?.isFile() || entry.nlink !== 1 || !owners.has(entry.uid) || (entry.mode & 0o022) !== 0 ||
            realpathSync(pathname) !== pathname)
          reject("stopped current state file ownership, links, permissions or path is unsafe");
        for (let parent = dirname(pathname); ; parent = dirname(parent)) {
          const directory = lstatSync(parent);
          if (!directory.isDirectory() || !owners.has(directory.uid) || (directory.mode & 0o022) !== 0)
            reject("stopped current state ancestor ownership or permissions is unsafe");
          if (parent === boundary) break;
          if (parent === "/") reject("stopped current state boundary is not an ancestor");
        }
      };
      const checkDatabase = pathname => {
        checkPath(pathname);
        for (const suffix of ["-wal", "-shm", "-journal"]) checkPath(pathname + suffix, true);
      };
      const schema = jsonFile(join(release, "package.json")).openclaw.schemaVersions;
      const databases = new Set([database]);
      checkPath(config); checkDatabase(database);
      verifyStateCompatibility(database, schema, schema, (_db, _agent, pathname) => databases.add(pathname), [], checkDatabase);
      const targets = new Set([config, ...[...databases].flatMap(pathname => [pathname, `${pathname}-wal`, `${pathname}-shm`, `${pathname}-journal`])]);
      if (phase === "stopped") assertDatabaseWritersStopped(targets, procRoot);
      checkPath(config);
      for (const pathname of databases) checkDatabase(pathname);
      result = JSON.stringify([config, ...databases].sort().map(pathname => {
        const entry = lstatSync(pathname);
        return { ...identity(pathname), uid: entry.uid, gid: entry.gid, mode: entry.mode, links: entry.nlink };
      }));
      break;
    }
    case "gateway-status": {
      if (args.length !== 2) reject("invalid gateway status proof arguments");
      const report = jsonArgument(args[0]);
      if (report?.rpc?.ok !== true) reject("Gateway status RPC is not ready");
      if (report.rpc?.server?.buildId !== args[1]) reject("Gateway status build does not match");
      if (!Array.isArray(report.pluginVersionDrift?.drifts) || report.pluginVersionDrift.drifts.length !== 0)
        reject("Gateway status plugin drift is present or malformed");
      break;
    }
    case "channels": {
      const allowCpuDegraded = cpuDegradedOption(1);
      const payload = jsonArgument(args[0]);
      const waived = snapshotCpuWaived(payload, allowCpuDegraded, "channels", true);
      verifyChannelAccounts(payload);
      result = waived ? "CHANNELS_CPU_DEGRADED_OPERATOR_WAIVED" : "CHANNELS_OK";
      break;
    }
    case "marker-readiness": {
      const [rawStartup, startupCode, rawReadiness, readinessCode] = args;
      if (args.length !== 4) {
        reject("invalid marker readiness arguments");
      }
      const startup = JSON.parse(rawStartup), readiness = JSON.parse(rawReadiness);
      if (gatewayStartupPending(startup, startupCode, readiness, readinessCode)) {
        result = "RECOVERING";
        break;
      }
      if (!Array.isArray(readiness.failing) ||
          readiness.failing.some(value => typeof value !== "string" || !value) ||
          !Number.isFinite(readiness.uptimeMs) || readiness.uptimeMs < 0) {
        reject("Gateway marker readyz is malformed");
      }
      // Convergence is a snapshot, not a promise that channel readiness stays
      // green. Wait for native readiness again within the same startup deadline.
      if (readinessCode === "503" && readiness.ready === false && readiness.failing.length) {
        result = "RECOVERING";
        break;
      }
      if (readinessCode !== "200" || readiness.ready !== true || readiness.failing.length) {
        reject("Gateway marker readyz is inconsistent");
      }
      // CPU/utilization alone can reflect useful startup work. Native delay evidence
      // and a bounded system.info response determine whether dispatch may proceed.
      if (readiness.eventLoop === undefined) {
        result = "RECOVERING";
        break;
      }
      const delayPending = snapshotCpuWaived(readiness, true, "marker readiness", true);
      const loop = readiness.eventLoop;
      result = delayPending || loop.delayP99Ms === undefined || loop.delayMaxMs === undefined
        ? "RECOVERING" : "READY";
      break;
    }
    case "probes": {
      const allowCpuDegraded = cpuDegradedOption(7);
      const [
        rawHealth,
        healthCode,
        rawStartup,
        startupCode,
        rawReadiness,
        readinessCode,
        rawChannels,
      ] = args;
      const health = JSON.parse(rawHealth);
      const startup = JSON.parse(rawStartup);
      const readiness = JSON.parse(rawReadiness);
      const channels = jsonArgument(rawChannels);
      if (healthCode !== "200" || health.ok !== true || health.status !== "live") {
        reject("Gateway healthz proof is malformed or unhealthy");
      }
      if (gatewayStartupPending(startup, startupCode, readiness, readinessCode)) {
        result = "RECOVERING";
        break;
      }
      const readinessWaived = snapshotCpuWaived(readiness, allowCpuDegraded, "readiness", true);
      const channelsWaived = snapshotCpuWaived(channels, allowCpuDegraded, "channels", true);
      if (!Array.isArray(readiness.failing) || !Number.isFinite(readiness.uptimeMs) || readiness.uptimeMs < 0) {
        reject("Gateway readiness identity is malformed");
      }
      if (readinessCode === "503" && readiness.ready === false) {
        if (readiness.failing.length === 0) reject("Gateway recovery has no failing channels");
        for (const channel of readiness.failing) {
          const accounts = channels.channelAccounts?.[channel];
          if (
            !Array.isArray(accounts) ||
            !accounts.some(
              (account) =>
                account.configured !== false &&
                account.enabled !== false &&
                (["starting", "recovering"].includes(account.lifecycle) ||
                  account.restartPending === true),
            )
          ) {
            reject("Gateway readiness recovery is terminal or inconsistent");
          }
        }
        result = "RECOVERING";
        break;
      }
      if (readinessCode !== "200" || readiness.ready !== true || readiness.failing.length !== 0) {
        reject("Gateway readyz is not ready");
      }
      verifyChannelAccounts(channels);
      result = readinessWaived || channelsWaived ? "READY_CPU_DEGRADED_OPERATOR_WAIVED" : "READY";
      break;
    }
    case "suspension-poll-failure":
    case "suspension-prepare-failure": {
      if (args.length !== 2 || args[0] !== "@stdin") reject("invalid suspension failure diagnostic arguments");
      const exit = integer(args[1], "suspension failure exit");
      if (exit < 1 || exit > 255) reject("invalid suspension failure exit");
      // Child stdout may include private config or auth text. Parse a bounded input
      // and emit only fixed categories, never error messages or arbitrary fields.
      const bytes = Buffer.alloc(16 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(0, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      let payload;
      if (length < bytes.length) {
        try { payload = JSON.parse(bytes.toString("utf8", 0, length)); } catch {}
      }
      if (command === "suspension-poll-failure") {
        // Protocol/authentication refusals remain fatal even when the subprocess
        // deadline fired. Only transport uncertainty permits another read.
        const error = payload?.ok === false ? payload.error : undefined;
        const transport = error?.type === "gateway_transport_error" &&
          typeof error.message === "string" &&
          typeof payload.gateway?.url === "string" && typeof payload.gateway?.urlSource === "string" &&
          (error.code === undefined || Number.isSafeInteger(error.code)) &&
          (error.reason === undefined || typeof error.reason === "string") &&
          (error.timeoutMs === undefined || (Number.isSafeInteger(error.timeoutMs) && error.timeoutMs > 0));
        const transient = (exit === 1 || exit === 124) && transport && (error.kind === "timeout" ||
          (error.kind === "closed" && [undefined, 1006, 1012].includes(error.code)));
        result = transient || (exit === 124 && length === 0) ? "retry" : "fatal";
        break;
      }
      result = "unclassified";
      if (exit === 124) result = "timeout-exit";
      else if (exit === 137) result = "killed-exit";
      else if (payload?.ok === false) {
        switch (payload.error?.type) {
          case "gateway_credentials_required": result = "gateway-credentials"; break;
          case "gateway_transport_error": result = "gateway-transport"; break;
          case "gateway_request_error":
            result = "gateway-request";
            if (payload.error.code === "UNAVAILABLE") {
              if (payload.error.details?.reason === "gateway-suspension-conflict") result = "gateway-conflict";
              else if (payload.error.details?.reason === "scheduler-resume-failed") result = "scheduler-recovery";
            }
            break;
        }
      }
      break;
    }
    case "suspension-prepare-params":
      result = JSON.stringify({
        requestId: suspensionToken(args[0], "suspension request identity"),
        terminalPolicy: "preserve",
        drain: true,
      });
      break;
    case "suspension-lease-params":
      result = JSON.stringify({
        suspensionId: suspensionToken(args[0], "suspension lease identity"),
      });
      break;
    case "suspension-process-instance": {
      const response = jsonArgument(args[0]);
      if (response?.pid !== integer(args[1], "suspension process PID") || response.pid < 1)
        reject("Gateway suspension process identity changed");
      result = suspensionToken(response.processInstanceId, "Gateway process instance");
      break;
    }
    case "suspension-handoff-params": {
      const pid = integer(args[1], "handoff process PID");
      if (pid < 1) reject("handoff process PID is invalid");
      result = JSON.stringify({
        suspensionId: suspensionToken(args[0], "suspension lease identity"),
        target: { pid, processInstanceId: suspensionToken(args[2], "handoff process instance") },
        commit: true,
      });
      break;
    }
    case "suspension-handoff": {
      const response = jsonArgument(args[0]);
      suspensionObject(response, ["status", "suspensionId", "expiresAtMs"], "Gateway handoff result");
      if (
        response.status !== "committed" ||
        response.suspensionId !== suspensionToken(args[1], "expected handoff suspension") ||
        !Number.isSafeInteger(response.expiresAtMs) ||
        response.expiresAtMs !== integer(args[2], "expected handoff expiry")
      )
        reject("Gateway handoff did not commit the exact suspension");
      result = "COMMITTED";
      break;
    }
    case "suspension-offer": {
      const response = jsonArgument(args[0]);
      if (!["ready", "draining"].includes(response?.status)) {
        reject("suspension response did not offer an owned lease");
      }
      const suspensionId = suspensionToken(response.suspensionId, "offered suspension identity");
      const expiresAtMs = Number.isSafeInteger(response.expiresAtMs) ? response.expiresAtMs : 0;
      result = `${suspensionId} ${expiresAtMs}`;
      break;
    }
    case "suspension-prepare": {
      const response = jsonArgument(args[0]);
      if (!suspensionContract.validateGatewaySuspendPrepareResult(response))
        reject("Gateway suspension prepare result is malformed");
      if (response?.status === "busy") {
        const custody = suspensionWriteCustody(response);
        suspensionRetryDelay(response.retryAfterMs);
        const blockers = suspensionBlockers(response, "Gateway suspension busy result", custody);
        result = `BUSY - 0 ${response.activeCount} ${response.retryAfterMs} 0 ${blockers} ${custody}`;
        break;
      }
      if (!["ready", "draining"].includes(response?.status)) {
        reject("terminal-preserving drain lease is unsupported or malformed");
      }
      const draining = response.status === "draining";
      const custody = suspensionWriteCustody(response);
      suspensionToken(response.suspensionId, "prepared suspension identity");
      if (
        !Number.isSafeInteger(response.expiresAtMs) ||
        response.expiresAtMs <= Date.now() + 5_000
      ) {
        reject("terminal-preserving drain lease is expired or has insufficient headroom");
      }
      const blockers = suspensionBlockers(response, "Gateway suspension prepare result", custody);
      const retryAfterMs = draining ? suspensionRetryDelay(response.retryAfterMs) : 0;
      const terminalBlocked = response.blockers.some((blocker) =>
        ["terminal-session", "terminal-persistence"].includes(blocker.kind),
      )
        ? 1
        : 0;
      result = `${response.status.toUpperCase()} ${response.suspensionId} ${response.expiresAtMs} ${response.activeCount} ${retryAfterMs} ${terminalBlocked} ${blockers} ${custody}`;
      break;
    }
    case "suspension-status": {
      result = suspensionStatus(
        jsonArgument(args[0]),
        args[1],
        integer(args[2], "expected suspension expiry"),
      );
      break;
    }
    case "suspension-running": {
      const response = jsonArgument(args[0]);
      if (!suspensionContract.validateGatewaySuspendStatusResult(response))
        reject("Gateway suspension status result is malformed");
      if (response.status !== "running") reject("Gateway is not running without a suspension");
      result = "RUNNING";
      break;
    }
    case "suspension-recovery-status": {
      const response = jsonArgument(args[0]);
      const { record } = jsonArgument(args[1]);
      validJournal(record);

      if (response?.status === "running") {
        if (!suspensionContract.validateGatewaySuspendStatusResult(response))
          reject("Gateway suspension status result is malformed");
        if (record.suspension.expiresAtMs <= 0 || record.suspension.expiresAtMs > Date.now())
          reject("journal suspension has not expired; running status is ambiguous");
        result = "ALREADY_RESUMED";
      } else {
        suspensionStatus(response, record.suspension.id, record.suspension.expiresAtMs);
        // Late writes may move READY back to DRAINING without releasing admission.
        // Recovery resumes the same valid lease; it does not authorize interruption.
        result = "ACTIVE";
      }
      break;
    }
    case "suspension-resume": {
      const response = jsonArgument(args[0]);
      suspensionObject(response, ["ok", "status", "resumed"], "Gateway suspension resume result");
      if (response.ok !== true || response.status !== "running" || response.resumed !== true) {
        reject("Gateway did not resume the exact owned suspension");
      }
      result = "RESUMED";
      break;
    }
    case "suspension-now":
      result = String(Date.now());
      break;
    case "gateway-stop-start-contract": {
      const numeric = ["KillSignal", "RestartKillSignal", "FileDescriptorStoreMax", "NFileDescriptorStore"];
      const lists = ["RuntimeDirectory", ...stopStartRelations];
      const properties = {};
      for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator), value = line.slice(separator + 1);
        if (separator < 1 || Object.hasOwn(properties, key) || ![...numeric, ...lists].includes(key))
          reject("stop/start service properties are ambiguous");
        if (numeric.includes(key)) {
          if (!/^\d+$/.test(value)) reject("stop/start service numeric property is invalid");
          properties[key] = Number(value);
        } else properties[key] = value.trim() ? value.trim().split(/\s+/) : [];
      }
      assertStopStartContract(properties);
      result = "STOP_START_EQUIVALENT";
      break;
    }
    case "candidate-config-accept":
      result = candidateConfigAccept(args[0], args[1], jsonArgument(args[2]),
        { pid: integer(args[3], "candidate PID"), generation: args[4] }, integer(args[5], "config runtime owner"), jsonArgument(args[6]));
      break;
    case "retained-repair-acceptance":
      if (args.length !== 3) reject("usage: retained-repair-acceptance prepare|check|receipt ROOT JOURNAL_DESCRIPTOR");
      result = JSON.stringify(retainedRepairAcceptance(args[0], args[1], jsonArgument(args[2])));
      break;
    case "retained-repair-build":
      if (args.length !== 3) reject("usage: retained-repair-build request|begin|check|origin|finish ROOT INPUT");
      result = JSON.stringify(retainedRepairBuild(args[0], args[1], jsonArgument(args[2])));
      break;
    case "retained-repair-start-claim":
      if (args.length !== 2) reject("usage: retained-repair-start-claim ROOT OPERATION");
      result = JSON.stringify(retainedRepairStartClaim(...args));
      break;
    case "retained-repair-entry":
      if (args.length !== 4) reject("usage: retained-repair-entry begin|resume ROOT OPERATION HASH");
      result = JSON.stringify(retainedRepairEntry(...args));
      break;
    case "retained-repair-retire":
      if (args.length !== 3) reject("usage: retained-repair-retire ROOT OPERATION COMPLETED_JOURNAL_SHA256");
      result = JSON.stringify(retainedRepairRetire(...args));
      break;
    case "retained-repair-lifecycle":
      if (args.length !== 3) reject("usage: retained-repair-lifecycle ACTION ROOT INPUT");
      result = JSON.stringify(retainedRepairLifecycle(args[0], args[1], jsonArgument(args[2])));
      break;
    case "retained-repair-transaction":
      if (args.length !== 3) reject("usage: retained-repair-transaction begin|check|verify|resume ROOT INPUT");
      result = JSON.stringify(retainedRepairTransaction(args[0], args[1], jsonArgument(args[2])));
      break;
    case "retained-repair-preparation":
      if (args.length !== 3) reject("usage: retained-repair-preparation snapshot|seal|check ROOT INPUT");
      result = JSON.stringify(retainedRepairPreparation(args[0], args[1], retainedPreparationArgument(args[2])));
      break;
    case "recovery-snapshot":

      result = recoveryEvidence(args[0], args[1], undefined, args[3], args[4] ? jsonArgument(args[4]) : undefined);
      if (JSON.stringify(result.record) !== JSON.stringify(jsonArgument(args[2])))
        reject("recovery journal changed before classification");
      result = JSON.stringify(result);
      break;
    case "recovery-process": {
      const response = jsonArgument(args[0]);
      const { record } = jsonArgument(args[1]);

      if (
        response.pid !== record.process.pid ||
        response.processInstanceId !== record.process.instance
      )
        reject("recovery predecessor process instance changed");
      result = "OK";
      break;
    }
    case "recovery-check":
    case "recovery-finish": {

      const evidence = recoveryEvidence(args[0], args[2], jsonArgument(args[1]), args[3]);
      if (command === "recovery-finish") {
        if (!["restored", "selected"].includes(args[3]))
          reject("recovery cleanup requires a terminal pointer view");
        if (args[3] === "selected" && evidence.configReconciliation) {
          const receipt = { version: 1, kind: "selected-candidate-config-reconciliation", evidence };
          const path = join(dirname(args[0]), `config-reconciliation-${evidence.configReconciliation.journalSha256}.json`);
          if (existsSync(path)) {
            if (!isDeepStrictEqual(migrationJson(migrationFile(path, migrationOwner(), { mode: 0o600 }).bytes), receipt))
              reject("selected config reconciliation receipt changed");
          } else migrationWriteExclusive(path, Buffer.from(`${JSON.stringify(receipt)}\n`), 0o600);
          recoveryEvidence(args[0], args[2], evidence, args[3]);
        }
        unlinkSync(args[0]);
        syncPath(dirname(args[0]));
      }
      result = "OK";
      break;
    }
    case "recovery-start-status":
    case "recovery-start-intent":
    case "recovery-start-writers":
      result = recoveryStart(command.slice("recovery-start-".length), args[0], args[2], jsonArgument(args[1]), args[3]);
      break;
    case "journal-native-permit":
      if (args.length !== 3) reject("usage: journal-native-permit JOURNAL EXPECTED revoke|publish");
      result = journalNativePermit(args[0], jsonArgument(args[1]), args[2]);
      break;
    case "journal-native-state":
      if (args.length !== 4) reject("usage: journal-native-state JOURNAL EXPECTED CONFIG DATABASE");
      result = JSON.stringify(journalNativeState(args[0], jsonArgument(args[1]), args[2], args[3]));
      break;
    case "journal-original-witness": {
      const record = ownedJournal(args[0]);
      const bytes = originalWitness(args[0], record, validJournal(jsonArgument(args[1])));
      if (bytes) process.stdout.write(bytes);
      break;
    }
    case "journal-create": {
      const [
        pathname,
        predecessor,
        candidate,
        topology,
        pid,
        generation,
        instance,
        fingerprints,
        currentSha,
        previousSha,
        systemUnitFileState,
        systemActiveState,
        userUnitFileState,
        userActiveState,
        suspensionId,
        suspensionExpiresAt,
        suspensionState,
        witnessInput,
        runtimeTarget,
        nativeBackupRoot,
      ] = args;
      if (lstatSync(pathname, { throwIfNoEntry: false })) {

        reject("activation journal already exists; evidence retained");
      }
      const gatewayRuntime = topology === "system" ? runtimeCurrent(dirname(dirname(pathname))) : null;
      if (runtimeTarget && !gatewayRuntime.binary) gatewayRuntime.binary = runtimeBinary(gatewayRuntime.executable);
      const record = validJournal({
        version: 1,
        phase: "A_PREPARED",
        predecessor: JSON.parse(predecessor),
        candidate: JSON.parse(candidate),
        topology,
        process: { pid: integer(pid, "process PID"), generation, instance },
        pointerTopology: {
          current: {
            present: currentSha !== "absent",
            sha: currentSha === "absent" ? null : currentSha,
          },
          previous: {
            present: previousSha !== "absent",
            sha: previousSha === "absent" ? null : previousSha,
          },
        },
        services: {
          system: { unitFileState: systemUnitFileState, activeState: systemActiveState },
          user: { unitFileState: userUnitFileState, activeState: userActiveState },
        },
        suspension: {
          id: suspensionId,
          expiresAtMs: integer(suspensionExpiresAt, "suspension expiry"),
          terminalPolicy: "preserve",
          status: suspensionState.toLowerCase(),
        },
        protectedPaths: JSON.parse(fingerprints),
        createdAt: new Date().toISOString(),
        ...(gatewayRuntime ? { gatewayRuntime } : {}),
        ...(runtimeTarget ? { runtimeChange: jsonArgument(runtimeTarget) } : {}),
        ...(nativeBackupRoot ? { nativeUpdate: { backupRoot: nativeBackupRoot } } : {}),
      });
      if (topology === "system") {
        if (witnessInput !== "@stdin") reject("ordinary activation requires the original session witness on stdin");
        const namespace = migrationNamespace(dirname(dirname(pathname)));
        if (pathname !== namespace.pathname) reject("original session witness journal path is not canonical");
        const bytes = migrationReadBytes(0, migrationJsonLimit);
        sessionWitnessTuples(migrationJson(bytes));
        const name = `original-${randomUUID()}.json`, artifact = join(namespace.directory, name);
        // Publish and read back the complete original bytes before A_PREPARED or either pointer.
        migrationWriteExclusive(artifact, bytes, 0o600);
        const file = migrationFile(artifact, namespace.owner, { mode: 0o600 });
        if (!file.bytes.equals(bytes)) reject("original session witness publication changed");
        const { path: _, ...descriptor } = file.descriptor;
        record.originalWitness = { name, ...descriptor };
        validJournal(record);
      } else if (witnessInput !== undefined) reject("user-unit migration does not accept an ordinary witness artifact");
      if (lstatSync(pathname, { throwIfNoEntry: false })) reject("activation journal appeared during witness publication; evidence retained");
      atomicJson(pathname, record);
      result = record.phase;
      break;
    }
    case "journal-phase": {
      const [pathname, phase, expected] = args;
      const record = ownedJournal(pathname);
      originalWitness(pathname, record, expected ? validJournal(jsonArgument(expected)) : undefined);
      record.phase = phase;
      validJournal(record);
      atomicJson(pathname, record);
      result = phase;
      break;
    }
    case "journal-read":
      result = JSON.stringify(ownedJournal(args[0]));
      break;
    case "journal-field": {
      const [pathname, field] = args;
      let value = ownedJournal(pathname);
      for (const part of field.split(".")) value = value?.[part];
      if (value === undefined) reject(`journal field is absent: ${field}`);
      result = typeof value === "object" ? JSON.stringify(value) : String(value);
      break;
    }
    case "stat-identity": {
      const entry = lstatSync(args[0]);
      result = `${entry.dev} ${entry.ino}`;
      break;
    }
    case "clean-candidate": {
      const [pathname, parent, rawUid, rawGid, rawDev, rawInode] = args;
      const expectedDevice = integer(rawDev, "candidate device");
      const expectedInode = integer(rawInode, "candidate inode");
      const basename = pathname.split("/").at(-1);
      const entry = lstatSync(pathname);
      if (
        !/^[a-f\d]{40}\.\d+$/u.test(basename) ||
        dirname(pathname) !== parent ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.uid !== integer(rawUid, "candidate owner") ||
        entry.gid !== integer(rawGid, "candidate group") ||
        entry.dev !== expectedDevice ||
        entry.ino !== expectedInode
      ) {
        reject("candidate cleanup refused an unknown, replaced, or unowned directory");
      }
      const quarantine = join(parent, `.cleanup-${basename}.${expectedDevice}.${expectedInode}`);
      if (existsSync(quarantine)) reject("candidate cleanup quarantine already exists");
      if (process.platform === "darwin" && process.getuid?.() !== 0) {
        makeDirectoriesOwnerWritable(pathname);
      }
      renameSync(pathname, quarantine);
      const moved = lstatSync(quarantine);
      if (moved.dev !== expectedDevice || moved.ino !== expectedInode) {
        reject("candidate cleanup detected replacement after quarantine");
      }
      rmSync(quarantine, { recursive: true, force: false, maxRetries: 0 });
      syncPath(parent);
      result = "CANDIDATE_CLEANED";
      break;
    }
    case "sync-directory":
      syncPath(args[0]);
      break;
    case "seal-tree":
      await sealTree(args[0]);
      break;
    case "list-releases": {
      const root = args[0];
      result = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && shaPattern.test(entry.name))
        .map((entry) => ({
          pathname: join(root, entry.name),
          modified: lstatSync(join(root, entry.name)).mtimeMs,
        }))
        .sort(
          (first, second) =>
            second.modified - first.modified || first.pathname.localeCompare(second.pathname),
        )
        .map((entry) => entry.pathname)
        .join("\n");
      break;
    }
    case "quarantine": {
      const [pathname, quarantine, rawUid, rawDev, rawInode] = args;
      const owner = integer(rawUid, "release owner");
      const expectedDevice = integer(rawDev, "release device");
      const expectedInode = integer(rawInode, "release inode");
      const entry = lstatSync(pathname);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.uid !== owner ||
        entry.gid !== rootGroup() ||
        (entry.mode & 0o777) !== 0o555 ||
        entry.dev !== expectedDevice ||
        entry.ino !== expectedInode ||
        statSync(dirname(pathname)).dev !== statSync(dirname(quarantine)).dev ||
        existsSync(quarantine)
      ) {
        reject("release replacement or cross-device quarantine refused");
      }
      if (process.platform === "darwin" && process.getuid?.() !== 0) chmodSync(pathname, 0o755);
      renameSync(pathname, quarantine);
      if (process.platform === "darwin" && process.getuid?.() !== 0) chmodSync(quarantine, 0o555);
      const moved = lstatSync(quarantine);
      if (moved.dev !== expectedDevice || moved.ino !== expectedInode) {
        reject("quarantined release identity changed");
      }
      syncPath(dirname(pathname));
      syncPath(dirname(quarantine));
      result = "QUARANTINED";
      break;
    }
    case "prune-quarantine": {
      const [pathname, root, rawUid, rawDev, rawInode] = args;
      const owner = integer(rawUid, "release owner");
      const expectedDevice = integer(rawDev, "quarantine device");
      const expectedInode = integer(rawInode, "quarantine inode");
      const entry = lstatSync(pathname);
      const basename = pathname.split("/").at(-1);
      const prefix = basename.split(".")[0];
      if (
        !shaPattern.test(prefix) ||
        basename !== `${prefix}.${expectedDevice}.${expectedInode}` ||
        dirname(pathname) !== join(root, "quarantine") ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.uid !== owner ||
        entry.gid !== rootGroup() ||
        entry.dev !== expectedDevice ||
        entry.ino !== expectedInode ||
        (entry.mode & 0o777) !== 0o555
      ) {
        reject("quarantine deletion refused a replaced or unowned release");
      }
      if (process.platform !== "linux" || process.getuid?.() !== 0) {
        result = "RETAIN_NON_LINUX_ROOT_PROOF";
        break;
      }
      rmSync(pathname, { recursive: true, force: false, maxRetries: 0 });
      syncPath(dirname(pathname));
      result = "PRUNED";
      break;
    }
    case "unlink-exact": {
      const [pathname, rawUid] = args;
      const entry = lstatSync(pathname);
      if (
        !entry.isFile() ||
        entry.uid !== integer(rawUid, "journal owner") ||
        entry.gid !== rootGroup()
      ) {
        reject("journal was replaced or is not owned");
      }
      const record = ownedJournal(pathname);

      if (Object.hasOwn(record, "originalWitness") && !args[2]) reject("original witness retirement requires its admitted binding");
      originalWitness(pathname, record, args[2] ? validJournal(jsonArgument(args[2])) : undefined);
      unlinkSync(pathname);
      syncPath(dirname(pathname));
      break;
    }
    case "unlink-pointer": {
      const [pathname, root, rawUid] = args;
      const entry = lstatSync(pathname);
      if (
        !entry.isSymbolicLink() ||
        entry.uid !== integer(rawUid, "pointer owner") ||
        entry.gid !== rootGroup() ||
        dirname(pathname) !== root
      ) {
        reject("pointer removal refused an unsafe or replaced link");
      }
      const target = realpathSync(pathname);
      if (
        dirname(target) !== join(root, "releases") ||
        !shaPattern.test(target.split("/").at(-1))
      ) {
        reject("pointer removal refused an escaped release target");
      }
      unlinkSync(pathname);
      syncPath(root);
      break;
    }
    default:
      reject(`unknown release proof command: ${command}`);
  }
  if (result !== undefined) process.stdout.write(`${result}\n`);
} catch (error) {
  // JSON parser excerpts can contain credentials or private session text.
  const message = error instanceof SyntaxError ? "malformed private release proof input" : error.message;
  process.stderr.write(`openclaw-team-release: ${message}\n`);
  process.exitCode = 2;
}

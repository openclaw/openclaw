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

function snapshotCpuWaived(snapshot, allowCpuDegraded, label) {
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
  // Native reasons own threshold policy. Never rewrite evidence or infer reasons from metrics.
  if (!allowCpuDegraded) reject(`Gateway ${label} snapshot is degraded`);
  return true;
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
  if (response.status === "ready" && (response.activeCount !== 0 || response.blockers.length)) {
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
  if (requireManifest) {
    const manifest = jsonFile(join(root, "deployment.json"));
    if (
      manifest.version !== 1 ||
      manifest.sourceSha !== expected ||
      manifest.buildId !== build.buildId ||
      manifest.controlUiSha256 !== uiDigest ||
      manifest.origin !== "https://github.com/openclaw/openclaw.git" ||
      manifest.schemaVersions?.state !== schemas.state ||
      manifest.schemaVersions?.agent !== schemas.agent
    ) {
      reject("deployment manifest does not match the exact sealed candidate");
    }
  }
  return {
    sha: expected,
    buildId: build.buildId,
    controlUiSha256: uiDigest,
    schemaVersions: schemas,
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
  const footprint = { bytes: 0, entries: 0 };
  const pending = [root];
  const device = lstatSync(root).dev;
  while (pending.length) {
    const pathname = pending.pop(), entry = lstatSync(pathname);
    if (entry.dev !== device) reject("release capacity inventory crosses filesystems");
    footprint.bytes += Math.max(entry.size, entry.blocks * 512);
    footprint.entries++;
    if (entry.isDirectory()) {
      for (const name of readdirSync(pathname)) pending.push(join(pathname, name));
    } else if (!entry.isFile() && !entry.isSymbolicLink()) {
      reject("release capacity inventory contains an unsupported entry");
    }
  }
  return footprint;
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
    // Budget all planned copy costs conservatively, even though cache cleanup precedes staging.
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

function sealTree(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const pathname = join(root, entry.name);
    const metadata = lstatSync(pathname);
    if (metadata.isSymbolicLink()) continue;
    if (metadata.isDirectory()) {
      sealTree(pathname);
      continue;
    }
    if (!metadata.isFile()) reject(`cannot seal unsupported release entry: ${pathname}`);
    chmodSync(pathname, (metadata.mode & 0o111) !== 0 ? 0o555 : 0o444);
    syncPath(pathname);
  }
  // Publishing a directory name cannot make its unsynced descendants durable.
  chmodSync(root, 0o555);
  syncPath(root);
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
    const journal = join(root, "journal/activation.json");
    const bound = selection.binary || (existsSync(journal) && ownedJournal(journal).runtimeChange);
    if (bound && realpathSync(join(values[1], String(integer(values[2], "Gateway PID")), "exe")) !==
        (selection.binary?.path ?? realpathSync(selection.executable)))
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
        (target.kind === "bun" ? Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4) :
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
    migrationProfile(source, candidate);
    const gatewayRuntime = runtimeCurrent(root);
    const id = randomUUID();
    const record = validHostHandoff({ version: 1, kind: "host-handoff", phase: "TARGET_IMPORTED", id, sourceHandoffId: handoff.id,
      stage: `handoff-target-${id}`, machineId: hostMachineId(), peerMachineId: handoff.sourceMachineId,
      targetSha: handoff.targetSha, predecessor: source, candidate, gatewayRuntime, schedules: handoff.schedules, configPath: manifest.inventory.config.path,
      databasePath: join(manifest.inventory.stateRoot, "state/openclaw.sqlite"), sourceManifest: migrationHashFile(manifestPath) });
    const inventory = hostHandoffTargetInventory(root, record, source);
    verifyRehearsalSnapshot(manifestPath, sourcePath, sourcePath, manifestHash, true);
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
    const exported = await snapshotForRehearsal(root, join(root, "releases", record.predecessor.sha), record.configPath, record.databasePath, record.id, record);
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
    const profile = migrationProfile(record.predecessor, record.candidate) ?? { from: record.predecessor.schemaVersions, to: record.candidate.schemaVersions };
    const current = { ...inventory, ...migrationProfileBinding(profile) };
    migrationSameInventory({ ...record.inventory, ...migrationProfileBinding(profile) }, current, profile, true);
    verifyRehearsalSnapshot(record.sourceManifest.path, sourcePath, candidatePath, record.sourceManifest.sha256, true);
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
  const rehearsal = record?.phase === "AGENT_REHEARSAL";
  const phases = new Set([
    "AGENT_REHEARSAL",
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
    (rehearsal
      ? record.suspension !== null
      : typeof record.suspension?.id !== "string" ||
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
  if (rehearsal || Object.hasOwn(record, "agentMigration") || Object.hasOwn(record, "configMigration") || Object.hasOwn(record, "offlineDoctor") ||
      record.predecessor.schemaVersions?.agent !== record.candidate.schemaVersions?.agent ||
      record.predecessor.schemaVersions?.state !== record.candidate.schemaVersions?.state) validAgentMigration(record);
  if (Object.hasOwn(record, "originalWitness")) {
    validMigrationDescriptor(record.originalWitness, "name", "original session witness");
    if (record.topology !== "system" || rehearsal || Object.hasOwn(record, "agentMigration") ||
        Object.hasOwn(record, "configMigration") ||
        !record.originalWitness.name.startsWith("original-") ||
        !migrationArtifactNamePattern.test(record.originalWitness.name))
      reject("original session witness is not an ordinary system activation artifact");
  }
  if (record.gatewayRuntime) {
    if (record.topology !== "system" || !["node", "bun"].includes(record.gatewayRuntime.kind)) reject("journal runtime scope is invalid");
    runtimeLiteral(record.gatewayRuntime.executable);
  }
  if (record.runtimeChange) {
    if (!record.gatewayRuntime || record.predecessor.sha !== record.candidate.sha || record.agentMigration || record.configMigration ||
        !["node", "bun"].includes(record.runtimeChange.kind) || !/^[a-f\d]{64}$/.test(record.runtimeChange.binary?.sha256))
      reject("runtime change is not a pinned same-release activation");
    runtimeLiteral(record.runtimeChange.executable);
  }
  return record;
}

const migrationArtifactPhases = Object.freeze({
  preflight: "rehearsal",
  inventory: "prepared",
  witness: "prepared",
  backups: "prepared",
  config: "doctor-started",
  ready: "doctor-started",
  precapture: "prepared",
  nocow: "doctor-started",
  doctor: "doctor-started",
  rebinding: "doctor-started",
  failure: "doctor-started",
  reconciliation: "stores-verified",
});
const migrationOuterPhases = Object.freeze({
  rehearsal: ["AGENT_REHEARSAL"],
  prepared: ["A_PREPARED", "B_PREVIOUS_PUBLISHED", "C_CURRENT_SELECTED", "ROLLBACK_FAILED"],
  "doctor-started": ["C_CURRENT_SELECTED", "ROLLBACK_FAILED"],
  "stores-verified": ["D_VERIFYING", "ROLLBACK_FAILED"],
  "recovering-predecessor": ["ROLLBACK_FAILED"],
});
const migrationStagePattern = /^(?:agent17-18|agent18-19|agent19-20|agent20-21|agent21-22|agent22-23|agent23-24|agent24-25|state14-15|state15-16|state16-17|state17-18|state18-19|state19-20|config-codex-turn-idle|offline-doctor)-[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const migrationArtifactNamePattern = /^[a-z]+-[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.json$/;
const migrationJsonLimit = 64 * 1024 * 1024;
const migrationJournalLimit = 1024 * 1024;
const migrationGuardName = "zz-openclaw-agent-schema-migration.conf";
const migrationPermitName = "gateway-start-permit";
const migrationPermitBody = Buffer.from('{"version":1,"purpose":"gateway-start-permit"}\n');
function migrationGuardBody(root) {
  if (/[\r\n%]/.test(root)) reject("migration root is not a literal systemd path");
  return `[Unit]\nConditionPathExists=${join(root, "journal", migrationPermitName)}\n`;
}

function migrationProfile(before, after, configMigration, offlineDoctor) {
  for (const info of [before, after]) {
    if (!shaPattern.test(info?.sha)) reject("migration release SHA is not exact");
    for (const field of ["state", "agent"]) {
      if (!Number.isSafeInteger(info?.schemaVersions?.[field]) || info.schemaVersions[field] < 0)
        reject("migration release schema declaration is invalid");
    }
  }
  const from = before.schemaVersions, to = after.schemaVersions;
  if (offlineDoctor !== undefined) {
    if (offlineDoctor !== true || configMigration !== undefined || before.sha === after.sha)
      reject("offline Doctor requires explicit intent and a distinct candidate");
    if (isDeepStrictEqual(from, to))
      return { kind: "offline-doctor", stagePrefix: "offline-doctor", role: "state", from, to, offline: true, nocow: true, nativeDoctor: true };
    return { ...migrationProfile(before, after), nocow: true };
  }
  if (configMigration !== undefined) {
    suspensionObject(configMigration, ["kind"], "config migration");
    if (configMigration.kind !== "config-codex-turn-idle" || before.sha === after.sha ||
        from.state !== 15 || from.agent !== 19 || !isDeepStrictEqual(from, to))
      reject("unsupported config migration or schema tuple");
    return { kind: configMigration.kind, stagePrefix: configMigration.kind, role: "state", from, to, config: true };
  }
  // Either database role can strand the predecessor after Doctor commits.
  // Only an unchanged pair may use activation without the migration fence.
  if (from.agent === to.agent && from.state === to.state) return null;
  const participants = from.agent === 17 && to.agent === 18 && from.state === to.state;
  const creators = from.state === 13 && from.agent === 18 && to.state === 14 && to.agent === 19;
  const bindings = from.state === 14 && from.agent === 19 && to.state === 15 && to.agent === 19;
  const authorityMigration = from.agent === 23 && to.agent === 23 &&
    ((from.state === 17 && to.state === 18) || (from.state === 18 && to.state === 19));
  const state20 = from.state === 19 && to.state === 20 && from.agent === 24 && to.agent === 24;
  const nativeStateDoctor = authorityMigration || state20 || (from.agent === 19 && to.agent === 19 &&
    ((from.state === 15 && to.state === 16) || (from.state === 16 && to.state === 17)));
  const coldTranscripts = authorityMigration || state20 ||
    (from.state === 19 && to.state === 19 && from.agent === 23 && to.agent === 24) ||
    (from.state === 20 && to.state === 20 && from.agent === 24 && to.agent === 25) ||
    (from.state === 17 && to.state === 17 &&
    [19, 20, 21, 22].includes(from.agent) && to.agent === from.agent + 1);
  if (before.sha === after.sha || !(participants || creators || bindings || nativeStateDoctor || coldTranscripts))
    reject("unsupported shared or agent schema crossing");
  const role = bindings || nativeStateDoctor ? "state" : "agent";
  return { kind: `${role}-${from[role]}-${to[role]}`, stagePrefix: `${role}${from[role]}-${to[role]}`,
    role, from, to, participants, creators, bindings, nativeDoctor: nativeStateDoctor || coldTranscripts, coldTranscripts, authorityMigration,
    originalColdRequired: authorityMigration || state20 };
}

function migrationColdExtractionDisabled(config) {
  const enabled = config.session?.maintenance?.coldStorage?.enabled;
  if (enabled !== undefined && enabled !== false)
    reject("agent schema migration requires cold transcript extraction disabled; cold payload backups are not qualified");
}

function migrationKind(before, after, config) {
  const profile = migrationProfile(before, after);
  if (profile?.coldTranscripts && config !== undefined) migrationColdExtractionDisabled(config);
  return profile?.kind ?? "none";
}

const retiredConfigKeys = ["turnCompletionIdleTimeoutMs", "turnAssistantCompletionIdleTimeoutMs", "postToolRawAssistantCompletionIdleTimeoutMs"];
const retiredConfigPrefix = "plugins.entries.codex.config.appServer.";

function configRepairKeys(config) {
  const server = config?.plugins?.entries?.codex?.config?.appServer;
  return server && typeof server === "object" && !Array.isArray(server)
    ? retiredConfigKeys.filter(key => Object.hasOwn(server, key)) : [];
}

function configRepairDelta(before, after, metadata = false) {
  const expected = structuredClone(before), actual = structuredClone(after);
  const keys = configRepairKeys(before);
  if (!keys.length || JSON.stringify(before).includes('"$include"')) reject("config repair requires single-file retired keys");
  // This is a verifier only. Repaired bytes always come from the candidate's native writer.
  for (const key of keys) delete expected.plugins.entries.codex.config.appServer[key];
  if (metadata) {
    if (typeof actual.meta?.lastTouchedVersion !== "string" || !actual.meta.lastTouchedVersion)
      reject("native config result has no version stamp");
    for (const value of [expected, actual]) {
      if (!value.meta) continue;
      delete value.meta.lastTouchedVersion;
      if (value.meta.migrations) {
        const marker = value.meta.migrations.modelPolicyAllowlist;
        if (marker !== undefined && marker !== true) reject("native model-policy marker is unqualified");
        delete value.meta.migrations.modelPolicyAllowlist;
        if (!Object.keys(value.meta.migrations).length) delete value.meta.migrations;
      }
      if (!Object.keys(value.meta).length) delete value.meta;
    }
    // Stamping a marker over a still-implicit legacy restriction changes its meaning.
    if (!before.meta?.migrations?.modelPolicyAllowlist && after.meta?.migrations?.modelPolicyAllowlist &&
        before.agents?.defaults?.models && Object.keys(before.agents.defaults.models).length &&
        !before.agents.defaults.modelPolicy)
      reject("config repair cannot materialize or widen legacy model policy");
  }
  if (!isDeepStrictEqual(expected, actual)) reject("native config repair includes an unrelated semantic change");
  return keys;
}

async function configRepairSymbol(release, prefix, name) {
  const candidates = readdirSync(join(release, "dist")).filter(file => file.startsWith(`${prefix}-`) && file.endsWith(".js"));
  const found = [];
  for (const file of candidates) {
    const source = readFileSync(join(release, "dist", file), "utf8");
    if (!source.includes(`function ${name}(`)) continue;
    const exported = [...source.matchAll(/export \{([^}]+)\}/g)].flatMap(match => match[1].split(",").map(value => value.trim()));
    const entry = exported.find(value => value === name || value.startsWith(`${name} as `));
    if (entry) found.push({ file, exportName: entry.split(" as ").at(-1) });
  }
  if (found.length !== 1) reject(`sealed candidate has no unambiguous native ${name} export`);
  const selected = found[0], module = await import(pathToFileURL(join(release, "dist", selected.file)).href);
  if (typeof module[selected.exportName] !== "function") reject("candidate native repair export changed");
  return module[selected.exportName];
}

function configRepairInputClosure(inputs, configPath, release) {
  if (!Array.isArray(inputs)) reject("native config repair has no owner input closure");
  const sources = new Map(inputs);
  if (sources.size !== inputs.length) reject("native config input closure repeats a path");
  const used = new Set();
  const mutable = configRepairBackupPaths(configPath);
  const verify = () => migrationVerifyInputBytes(inputs.filter(([path]) => !mutable.includes(path)), true);
  const requireInput = pathname => {
    if (typeof pathname !== "string" || !isAbsolute(pathname) || resolve(pathname) !== pathname)
      reject("native metadata input locator is not canonical");
    if (pathname.startsWith(release + "/")) { safeRelative(release, realpathSync(pathname)); return; }
    if (!sources.has(pathname)) reject("native metadata input is outside the owner closure");
    used.add(pathname);
    const entry = sources.get(pathname);
    if (entry?.entries) for (const name of entry.entries) requireInput(join(pathname, name));
  };
  verify();
  const binding = () => createHash("sha256").update(JSON.stringify([...used].sort().map(path => {
    const value = sources.get(path);
    return [path, value === null ? null : value.entries ?? { size: value.size, sha256: value.sha256 }];
  }))).digest("hex");
  return { verify, requireInput, sources, binding };
}

async function configRepairNative(release, action, original, inputs) {
  if (!["plan", "commit", "verify"].includes(action)) reject("unknown native config repair action");
  const configPath = process.env.OPENCLAW_CONFIG_PATH, stateRoot = process.env.OPENCLAW_STATE_DIR;
  if (!configPath || !stateRoot || configPath !== join(stateRoot, "openclaw.json") ||
      realpathSync(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "/absent") !== join(realpathSync(release), "dist/extensions"))
    reject("native repair is not bound to its canonical config and candidate plugins");
  const keyPath = join(stateRoot, "config-journal-fingerprint.key"), keyStat = lstatSync(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.size !== 32 || keyStat.nlink !== 1 ||
      (keyStat.mode & 0o7777) !== 0o600 || keyStat.uid !== process.getuid())
    reject("fingerprint key creation or permission repair is outside the admitted closure");
  const key = migrationHashFile(keyPath);
  const closure = configRepairInputClosure(inputs, configPath, release);
  const assertKey = () => {
    const entry = lstatSync(keyPath);
    if (!isDeepStrictEqual(key, migrationHashFile(keyPath)) || entry.nlink !== 1 ||
        (entry.mode & 0o7777) !== 0o600 || entry.uid !== keyStat.uid || entry.gid !== keyStat.gid)
      reject("native repair changed fingerprint key identity, bytes or permissions");
  };
  const api = await import(pathToFileURL(join(release, "dist/config/config.js")).href);
  const planner = await configRepairSymbol(release, "automatic-startup-config-repair", "planAutomaticConfigRepair");
  const committer = await configRepairSymbol(release, "automatic-startup-config-repair", "commitAutomaticConfigRepair");
  const matcher = await configRepairSymbol(release, "automatic-startup-config-repair", "isStartupConfigRepairResult");
  const stamp = await configRepairSymbol(release, "io.types", "stampConfigWriteMetadata");
  const handler = await configRepairSymbol(release, "runtime-snapshot", "getRuntimeConfigSnapshotRefreshHandler");
  const managed = await configRepairSymbol(release, "runtime-snapshot", "hasManagedRuntimeConfigWriteOwner");
  const loadMetadata = await configRepairSymbol(release, "io.plugin-metadata", "resolveConfigWidePluginMetadataSnapshot");
  const completeMetadata = await configRepairSymbol(release, "plugin-metadata-snapshot", "completePluginMetadataSnapshot");
  const createScope = await configRepairSymbol(release, "plugin-metadata-snapshot-scope", "createDoctorPluginMetadataSnapshotScope");
  const currentMetadata = await configRepairSymbol(release, "current-plugin-metadata-snapshot", "getCurrentPluginMetadataSnapshot");
  const withMetadata = await configRepairSymbol(release, "current-plugin-metadata-snapshot", "withPluginMetadataSnapshotScope");
  const doctorArtifact = await configRepairSymbol(release, "installed-plugin-index", "resolvePluginDoctorContractArtifactPath");
  const workspaceDirs = await configRepairSymbol(release, "workspace-dirs", "listAgentWorkspaceDirs");
  const channelRoot = await configRepairSymbol(release, "bundled-root", "resolveBundledChannelRootScope");
  const publicArtifact = await configRepairSymbol(release, "public-surface-runtime", "resolveBundledPluginPublicSurfacePath");
  const channelMetadataKey = await configRepairSymbol(release, "config-metadata", "isChannelConfigMetadataKey");
  const assertStandalone = () => {
    if (handler() !== null || managed(configPath) || api.getRuntimeConfigSnapshot() || api.getRuntimeConfigSourceSnapshot())
      reject("native repair has an unqualified runtime or SecretRef preflight callback");
  };
  assertStandalone();
  // Data bootstrap only. A full invalid snapshot can import Doctor modules while collecting issues.
  const bootstrap = await api.readConfigFileSnapshot({ pluginValidation: "core-only", observe: false, recoverSuspicious: false });
  assertStandalone();
  if (!bootstrap.exists || typeof bootstrap.raw !== "string" || bootstrap.includedPaths?.length ||
      !bootstrap.valid || JSON.stringify(bootstrap.parsed).includes('"$include"'))
    reject("native config bootstrap is malformed, included or has unsupported core drift");
  const metadataConfig = bootstrap.sourceConfig;
  if (original && bootstrap.raw !== original.snapshot?.raw)
    configRepairDelta(original.snapshot?.sourceConfig, metadataConfig, true);
  for (const path of [join(stateRoot, ".env"), join(stateRoot, "extensions"), ...(metadataConfig.plugins?.load?.paths ?? []),
    ...workspaceDirs(metadataConfig, process.env).map(dir => join(dir, ".openclaw/extensions"))]) closure.requireInput(path);
  const metadata = completeMetadata({ snapshot: loadMetadata({ config: metadataConfig, env: process.env, allowCurrent: false }),
    config: metadataConfig, env: process.env });
  assertStandalone();
  const candidatePath = pathname => {
    if (typeof pathname !== "string" || !pathname.startsWith(release + "/"))
      reject(`executable Doctor artifact or Codex owner escapes the sealed candidate: ${pathname}`);
    safeRelative(release, realpathSync(pathname));
  };
  const admit = snapshot => {
    closure.verify();
    const plugins = snapshot?.manifestRegistry?.plugins;
    if (!Array.isArray(plugins) || snapshot.pluginIds !== undefined || !plugins.some(plugin => plugin.id === "codex"))
      reject("native complete Codex metadata owner is missing");
    if (snapshot.manifestRegistry.diagnostics.some(item => item.level === "error"))
      reject("native config-wide plugin metadata has ambiguous or invalid owners");
    for (const plugin of [...plugins, ...(snapshot.bundledManifestRegistry?.plugins ?? [])]) {
      for (const path of migrationPluginLocators(plugin)) {
        closure.requireInput(path);
        if (plugin.id === "codex" || plugin.origin === "bundled") candidatePath(path);
      }
      if (!plugin.rootDir.startsWith(release + "/") && !closure.sources.get(plugin.rootDir)?.entries)
        reject("external metadata root lacks captured directory membership");
      // Match the native declaration gate. Absence still permits inferred legacy artifacts.
      if (plugin.doctorContract && plugin.doctorContract.configRepair !== true) continue;
      const artifact = doctorArtifact(plugin.rootDir);
      if (artifact) candidatePath(artifact);
    }
    for (const index of [snapshot.index, snapshot.registryIndex]) {
      for (const plugin of index.plugins) for (const path of migrationPluginLocators(plugin)) closure.requireInput(path);
      for (const record of Object.values(index.installRecords))
        for (const path of [record.sourcePath, record.installPath].filter(Boolean)) closure.requireInput(path);
    }
    const root = channelRoot(process.env);
    if (root.packageRoot !== release || root.pluginsDir !== join(release, "dist/extensions"))
      reject("bundled channel Doctor loader has a foreign root");
    for (const channel of Object.keys(metadataConfig.channels ?? {}).filter(id => !channelMetadataKey(id)))
      for (const artifactBasename of ["doctor-contract-api.js", "config-doctor-api.js"]) {
        const artifact = publicArtifact({ rootDir: root.packageRoot, bundledPluginsDir: root.pluginsDir,
          bundledPluginsDirMode: "explicit", dirName: channel, artifactBasename, env: process.env });
        if (artifact) candidatePath(artifact);
      }
  };
  const scope = createScope({ baseSnapshot: metadata, env: process.env });
  assertStandalone();
  // Admit the effective Doctor scope, including its native config-wide rebase, before any hook.
  const run = callback => scope.run({ config: metadataConfig, workspaceDir: metadata.workspaceDir }, () => {
    const effective = currentMetadata({ config: metadataConfig, env: process.env, allowWorkspaceScopedSnapshot: true });
    assertStandalone();
    admit(effective);
    assertStandalone();
    if (original && original.metadataInputs !== closure.binding()) reject("native metadata inputs drifted since rehearsal");
    return withMetadata(effective, () => {
      // Scope preparation must not install a callback that the full read could reach before refusal.
      assertStandalone();
      return callback();
    }, { config: metadataConfig, env: process.env });
  });
  const current = await run(() => api.readConfigFileSnapshot({ observe: false, recoverSuspicious: false }));
  assertStandalone();
  if (current.raw !== bootstrap.raw || !isDeepStrictEqual(current.sourceConfig, metadataConfig))
    reject("native config changed after metadata bootstrap");
  if (original?.expectedConfig && !isDeepStrictEqual(migrationHashFile(configPath), original.expectedConfig))
    reject("native config input dev/inode/hash changed before commit");
  const before = original?.snapshot ?? current;
  if (current.raw === before.raw && (!isDeepStrictEqual(current.parsed, before.parsed) ||
      !isDeepStrictEqual(current.sourceConfig, before.sourceConfig)))
    reject("native original snapshot differs from the actual config");
  if (before.path !== configPath || before.valid || !before.exists || typeof before.raw !== "string" || before.includedPaths?.length)
    reject("original native repair snapshot is invalid");
  const plan = run(() => planner(before));
  assertStandalone();
  if (!plan) reject("candidate native planner refused automatic config repair");
  configRepairDelta(before.sourceConfig, plan.config);
  configRepairDelta(before.sourceConfig, stamp(plan.config, undefined, undefined, before.parsed), true);
  if (original && !isDeepStrictEqual(plan.config, original.plan)) reject("native config plan drifted since rehearsal");
  if (action === "plan") {
    assertKey();
    return { snapshot: before, plan: plan.config, metadataInputs: closure.binding() };
  }
  assertStandalone();
  if (action === "commit" && current.raw === before.raw) {
    if (original?.expectedConfig && !isDeepStrictEqual(migrationHashFile(configPath), original.expectedConfig))
      reject("native config input changed while planning");
    await run(() => committer(plan, before));
    assertStandalone();
  } else if (!run(() => matcher(before, current))) {
    reject("config repair recovery is neither original nor canonical");
  }
  const after = await run(() => api.readConfigFileSnapshot({ observe: false, recoverSuspicious: false }));
  assertStandalone();
  if (!run(() => matcher(before, after))) reject("native writer result failed the canonical matcher");
  configRepairDelta(before.parsed, after.parsed, true);
  assertKey();
  assertStandalone();
  const fingerprint = await configRepairSymbol(release, "io.audit", "fingerprintConfigSnapshotAuthoredConfig");
  const result = { canonical: true, config: migrationHashFile(configPath), snapshotAudit: {
    configPath, rawHash: migrationHashFile(configPath).sha256,
    fingerprintedAuthoredConfig: fingerprint(after.parsed),
  } };
  assertStandalone();
  assertKey();
  return result;
}

function migrationRecordProfile(record) {
  const profile = migrationProfile(record.predecessor, record.candidate, record.configMigration, record.offlineDoctor);
  if (!profile) reject("migration requires a qualified schema crossing");
  return profile;
}

function migrationProfileBinding(profile) {
  // Only existing 17-to-18 journals retain their original artifact shape.
  // Every newer crossing binds both roles, including an unchanged agent schema.
  return profile.participants ? {} : { schemaProfile: { from: profile.from, to: profile.to } };
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

function validAgentMigration(record) {
  const migration = record.agentMigration;
  const profile = migrationRecordProfile(record);
  suspensionObject(migration, ["version", "from", "to", "phase", "stage", "artifacts"], "agent migration");
  if (
    migration.version !== 1 || migration.from !== profile.from[profile.role] || migration.to !== profile.to[profile.role] ||
    !Object.hasOwn(migrationOuterPhases, migration.phase) ||
    !migrationOuterPhases[migration.phase].includes(record.phase) ||
    typeof migration.stage !== "string" || !migrationStagePattern.test(migration.stage) ||
    !migration.stage.startsWith(`${profile.stagePrefix}-`) ||
    record.topology !== "system" || record.predecessor.sha === record.candidate.sha ||
    record.pointerTopology.current.present !== true ||
    record.pointerTopology.current.sha !== record.predecessor.sha ||
    record.services.system.unitFileState !== "enabled" || record.services.system.activeState !== "active" ||
    record.services.user.unitFileState !== "disabled" || record.services.user.activeState !== "inactive"
  ) reject("agent migration phase, release edge, or system topology is invalid");
  const artifacts = migration.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts))
    reject("agent migration artifacts are malformed");
  for (const [kind, descriptor] of Object.entries(artifacts)) {
    if (!Object.hasOwn(migrationArtifactPhases, kind)) reject("unknown agent migration artifact");
    if (["precapture", "nocow", "doctor", "rebinding", "failure"].includes(kind) && !profile.nocow) reject("offline Doctor artifact on another operation");
    if (kind === "config" && !profile.config) reject("schema journal cannot carry config replacement authority");
    if (kind === "reconciliation" && (profile.config || profile.offline || migration.phase !== "stores-verified" || record.phase !== "D_VERIFYING"))
      reject("live config reconciliation requires a verified schema-crossing candidate");
    validMigrationDescriptor(descriptor, "name", "agent migration artifact");
    if (!descriptor.name.startsWith(`${kind}-`) || !migrationArtifactNamePattern.test(descriptor.name))
      reject("agent migration artifact name is not a canonical exclusive attempt");
  }
  const phase = migration.phase;
  if (phase === "recovering-predecessor" && (!profile.offline || !artifacts.rebinding)) reject("unqualified offline recovery phase");
  if (
    (phase === "rehearsal" && Object.keys(artifacts).some((kind) => kind !== "preflight")) ||
    (phase === "prepared" && Object.hasOwn(artifacts, "ready")) ||
    (phase !== "rehearsal" && !Object.hasOwn(artifacts, "preflight")) ||
    (["doctor-started", "stores-verified", "recovering-predecessor"].includes(phase) &&
      ["inventory", "witness", "backups"].some((kind) => !Object.hasOwn(artifacts, kind))) ||
    (["doctor-started", "stores-verified", "recovering-predecessor"].includes(phase) && profile.nocow && !artifacts.precapture && !artifacts.nocow) ||
    (artifacts.doctor && profile.nocow && !artifacts.nocow) ||
    (phase === "stores-verified" && profile.nocow && (!artifacts.nocow || !artifacts.doctor || !artifacts.rebinding)) ||
    (phase === "stores-verified" && (!Object.hasOwn(artifacts, "ready") || (profile.config && !Object.hasOwn(artifacts, "config"))))
  ) reject("agent migration artifact set disagrees with its durable phase");
}

function rejectMigrationFallback(record) {
  if (Object.hasOwn(record, "agentMigration"))
    reject("agent migration requires its bound migration helpers, not ordinary recovery or retirement");
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
      if (record.phase !== "AGENT_REHEARSAL" || Object.keys(record.agentMigration.artifacts).length)
        reject("hard-linked journal is not an interrupted initial rehearsal publication");
      migrationStage(root, record, owner); migrationReleaseProof(root, record, owner);
      migrationPointers(root, owner, { current: record.predecessor.sha, previous: record.pointerTopology.previous.sha });
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
    migrationAncestors(dirname(target.path), owner, boundary);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== owner || entry.gid !== rootGroup() ||
        entry.nlink !== 2 || (entry.mode & 0o7777) !== target.mode || entry.size > migrationJournalLimit)
      reject("interrupted fixed publication has ambiguous links or ownership");
    const same = current => current.isFile() && !current.isSymbolicLink() && current.dev === entry.dev && current.ino === entry.ino &&
      current.nlink === 2 && current.size === entry.size && current.mode === entry.mode && current.uid === owner && current.gid === rootGroup() &&
      current.mtimeMs === entry.mtimeMs && current.ctimeMs === entry.ctimeMs;
    const fd = openSync(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!same(fstatSync(fd))) reject("fixed publication changed before inspection");
      const bytes = migrationReadBytes(fd, migrationJournalLimit);
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

function migrationStage(root, record, owner) {
  const pathname = join(root, "journal", record.agentMigration.stage);
  const entry = exactDirectory(pathname, owner, "agent migration stage", { privateOnly: true });
  if (entry.dev !== lstatSync(join(root, "journal")).dev) reject("agent migration stage crosses filesystems");
  return { path: pathname, device: entry.dev, inode: entry.ino };
}

function migrationArtifactRead(root, record, kind, owner) {
  const descriptor = record.agentMigration.artifacts[kind];
  if (!descriptor) reject(`original migration ${kind} artifact is missing; recapture is forbidden`);
  const pathname = join(root, "journal", record.agentMigration.stage, descriptor.name);
  const file = migrationFile(pathname, owner);
  const actual = { name: descriptor.name, device: file.descriptor.device, inode: file.descriptor.inode, sha256: file.descriptor.sha256 };
  if (!isDeepStrictEqual(actual, descriptor)) reject(`bound migration ${kind} artifact changed`);
  migrationJson(file.bytes);
  return file.bytes;
}

function migrationLoad(pathname, root, expected, abandoning = false) {
  const namespace = migrationNamespace(root);
  if (pathname !== namespace.pathname) reject("migration journal path is not canonical");
  const file = migrationFile(pathname, namespace.owner, { limit: migrationJournalLimit });
  const record = ownedJournal(pathname);
  if (!Object.hasOwn(record, "agentMigration") || !isDeepStrictEqual(record, migrationJson(file.bytes)))
    reject("migration journal is absent or changed during inspection");
  const stage = migrationStage(root, record, namespace.owner);
  if (!abandoning && lstatSync(join(stage.path, `abandon-${record.agentMigration.stage}.json`), { throwIfNoEntry: false }))
    reject("rehearsal abandonment intent is retained; use --recover --abandon-rehearsal with its candidate");
  for (const kind of Object.keys(record.agentMigration.artifacts))
    migrationArtifactRead(root, record, kind, namespace.owner);
  const evidence = { record, identity: { ...file.descriptor, stage } };
  if (!isDeepStrictEqual(stage, migrationStage(root, record, namespace.owner)) ||
      !isDeepStrictEqual(file.descriptor, migrationFile(pathname, namespace.owner, { limit: migrationJournalLimit }).descriptor))
    reject("migration journal or stage changed during inspection");
  // Evidence has no alternate/restored pointer view and binds raw bytes as well as parsed content.
  if (expected !== undefined && !isDeepStrictEqual(evidence, expected))
    reject("migration journal bytes, semantic record, inode, or stage changed");
  return evidence;
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

function migrationReleaseProof(root, record, owner) {
  for (const release of [record.predecessor, record.candidate]) {
    if (!isDeepStrictEqual(validateRelease(join(root, "releases", release.sha), release.sha, owner, true), release))
      reject("migration sealed release identity changed");
  }
  for (const entry of record.protectedPaths) {
    if (!isDeepStrictEqual(identity(entry.path), entry)) reject("migration protected path identity changed");
  }
}

function migrationControllerBinding(rawPid) {
  const pid = integer(rawPid, "migration controller PID"), owner = migrationOwner();
  if (pid < 1 || process.platform !== "linux" || process.getuid() !== owner)
    reject("live migration proof requires its Linux controller");
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), boundary = stat.lastIndexOf(") ");
  const generation = stat.slice(boundary + 2).trim().split(/\s+/)[19];
  if (boundary < 0 || !/^[1-9]\d*$/.test(generation)) reject("migration controller generation is unavailable");
  const pathname = process.env.OPENCLAW_TEAM_LOCK_FILE ?? "/run/openclaw-release-deploy.lock";
  migrationAncestors(dirname(pathname), owner, process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/");
  const entry = lstatSync(pathname), held = fstatSync(9);
  for (const value of [entry, held]) {
    if (!value.isFile() || value.uid !== owner || value.gid !== rootGroup() || value.nlink !== 1 || (value.mode & 0o022))
      reject("live migration proof requires its exact controller lock");
  }
  if (entry.dev !== held.dev || entry.ino !== held.ino) reject("migration controller lock was replaced");
  const heldDescription = fdinfo => {
    const lines = fdinfo.split("\n").filter(line => /^lock:/.test(line));
    if (lines.length !== 1 || !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/.test(lines[0]))
      reject("live migration proof requires the inherited exclusive lock description");
    return lines[0];
  };
  const description = heldDescription(readFileSync("/proc/self/fdinfo/9", "utf8"));
  if (heldDescription(readFileSync(`/proc/${pid}/fdinfo/9`, "utf8")) !== description)
    reject("migration controller no longer holds the inherited lock description");
  return { pid, generation, lock: { path: pathname, device: held.dev, inode: held.ino, description } };
}

function migrationEntryStamp(pathname) {
  const entry = lstatSync(pathname, { bigint: true });
  return { path: pathname, device: String(entry.dev), inode: String(entry.ino), mode: String(entry.mode),
    uid: String(entry.uid), gid: String(entry.gid), links: String(entry.nlink), size: String(entry.size),
    modified: String(entry.mtimeNs), changed: String(entry.ctimeNs) };
}

function migrationSealedReleaseFacts(root, record) {
  return [record.predecessor, record.candidate].map(release => {
    const directory = join(root, "releases", release.sha);
    const paths = ["", ".git", ".git/HEAD", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules",
      "deployment.json", "dist", "dist/index.js", "dist/.buildstamp", "dist/.runtime-postbuildstamp", "dist/build-info.json",
      "dist/control-ui", "dist/control-ui/index.html"];
    return { release, entries: paths.map(name => {
      const pathname = join(directory, name), resolved = realpathSync(pathname);
      safeRelative(directory, resolved);
      return { entry: migrationEntryStamp(pathname), resolved: migrationEntryStamp(resolved) };
    }) };
  });
}

function migrationLiveScope(record, evidence) {
  return { stage: evidence.identity.stage, predecessor: record.predecessor, candidate: record.candidate,
    protectedPaths: record.protectedPaths, preflight: record.agentMigration.artifacts.preflight };
}

function migrationLivePointers(root) {
  return ["current", "previous"].map(name => {
    const pathname = join(root, name), entry = lstatSync(pathname, { throwIfNoEntry: false });
    return entry ? { name, entry: migrationEntryStamp(pathname), target: readlinkSync(pathname) } : { name, absent: true };
  });
}

function migrationLivePreflight(pathname, root, expected, rawPid) {
  const { record } = migrationLoad(pathname, root, expected);
  if (!((record.agentMigration.phase === "rehearsal" && record.phase === "AGENT_REHEARSAL") ||
      (record.agentMigration.phase === "prepared" && record.phase === "A_PREPARED")))
    reject("live migration preparation requires the original running predecessor stage");
  const facts = { controller: migrationControllerBinding(rawPid), scope: migrationLiveScope(record, expected),
    releases: migrationSealedReleaseFacts(root, record), pointers: migrationLivePointers(root) };
  migrationReleaseProof(root, record, migrationOwner());
  migrationLiveCheck(pathname, root, expected, facts, rawPid);
  return facts;
}

function migrationLiveCheck(pathname, root, expected, facts, rawPid) {
  const { record } = migrationLoad(pathname, root, expected);
  suspensionObject(facts, ["controller", "scope", "releases", "pointers"], "prepared migration release facts");
  if (!isDeepStrictEqual(facts.controller, migrationControllerBinding(rawPid)) ||
      !isDeepStrictEqual(facts.scope, migrationLiveScope(record, expected)) ||
      !isDeepStrictEqual(facts.releases, migrationSealedReleaseFacts(root, record)) ||
      !isDeepStrictEqual(facts.pointers, migrationLivePointers(root)))
    reject("prepared migration release facts changed or belong to another controller invocation");
  // The canonical lock excludes release publication. The completed tree audit
  // established a root-owned, non-writable closure; only these same-invocation
  // identities are reused. Journal, pointers, config and headroom stay live reads.
  for (const entry of record.protectedPaths)
    if (!isDeepStrictEqual(identity(entry.path), entry)) reject("migration protected path identity changed");
  migrationPointers(root, migrationOwner(), { current: record.predecessor.sha, previous: record.pointerTopology.previous.sha });
  migrationCheckPreflight(root, record);
  migrationLoad(pathname, root, expected);
  return "LIVE_INPUTS_CURRENT";
}

function configRepairRecoveryCheck(root, record) {
  const profile = migrationRecordProfile(record);
  if (!profile.config) reject("config recovery requires its qualified journal kind");
  for (const release of [record.predecessor, record.candidate]) {
    if (!isDeepStrictEqual(validateRelease(join(root, "releases", release.sha), release.sha, migrationOwner(), true), release))
      reject("config recovery candidate or predecessor drifted");
  }
  if (record.agentMigration.phase !== "doctor-started") {
    migrationReleaseProof(root, record, migrationOwner());
    return;
  }
  const inventory = migrationReadArtifact(root, record, "inventory");
  if (!isDeepStrictEqual(identity(record.protectedPaths[1].path), record.protectedPaths[1])) reject("config recovery database identity drifted");
  const current = migrationHashFile(inventory.config.path);
  const original = isDeepStrictEqual(current, inventory.config);
  const result = inventory.configRepair?.result;
  if (!original && (current.sha256 !== result?.config?.sha256 || current.size !== result.config.size))
    reject("config recovery found neither the bound original nor rehearsed canonical bytes");
  configRepairCheckCopies(inventory);
  if (original) configRepairVerifyOriginalInputs(inventory);
  else configRepairVerifyInputs(inventory, { ...result, config: current });
}

function configRepairApply(pathname, root, expected, procRoot) {
  const { record } = migrationLoad(pathname, root, expected);
  if (record.agentMigration.phase !== "doctor-started" || !migrationRecordProfile(record).config)
    reject("native config commit requires the fenced one-way phase");
  configRepairRecoveryCheck(root, record);
  migrationWritersStopped(pathname, root, expected, procRoot);
  const inventory = migrationReadArtifact(root, record, "inventory"), release = join(root, "releases", record.candidate.sha);
  const preflight = migrationReadArtifact(root, record, "preflight");
  const original = isDeepStrictEqual(migrationHashFile(inventory.config.path), inventory.config);
  if (original) {
    configRepairVerifyOriginalInputs(inventory);
    migrationVerifyPreservation(inventory, migrationReadArtifact(root, record, "backups"), release, migrationRecordProfile(record));
  }
  if (process.platform !== "linux" || process.getuid() !== 0 || inventory.configRepair.uid === 0)
    reject("live native config runner requires the canonical Linux root owner and unprivileged runtime");
  const log = join(expected.identity.stage.path, `config-native-${randomUUID()}`);
  migrationWriteExclusive(`${log}.ring.json`, Buffer.from(JSON.stringify(configRepairVerifyRing(inventory))), 0o600);
  const out = openSync(`${log}.stdout`, "wx", 0o600), err = openSync(`${log}.stderr`, "wx", 0o600);
  let child;
  try {
    const home = dirname(inventory.stateRoot);
    child = spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), "config-repair-native", release,
      original ? "commit" : "verify", "@stdin"], {
      uid: inventory.configRepair.uid, gid: inventory.configRepair.gid, cwd: home,
      env: { HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: inventory.stateRoot, OPENCLAW_CONFIG_PATH: inventory.config.path,
        OPENCLAW_BUNDLED_PLUGINS_DIR: join(release, "dist/extensions"), NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_SUPERVISOR_MODE: "external", OPENCLAW_SERVICE_REPAIR_POLICY: "external", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), PATH: "/usr/bin:/bin", TMPDIR: "/tmp" },
      input: JSON.stringify({ inputs: inventory.inputs,
        original: { ...preflight.configRepair.plan, expectedConfig: migrationHashFile(inventory.config.path) } }),
      stdio: ["pipe", out, err], timeout: 600_000, killSignal: "SIGKILL",
    });
    fsyncSync(out); fsyncSync(err);
  } finally { closeSync(out); closeSync(err); }
  if (child.error || child.status !== 0) reject("native config runner failed; original evidence and fence retained");
  migrationLoad(pathname, root, expected);
  configRepairRecoveryCheck(root, record);
  migrationWritersStopped(pathname, root, expected, procRoot);
  const result = { ...jsonFile(`${log}.stdout`), backupRing: configRepairVerifyRing(inventory) };
  configRepairVerifyInputs(inventory, result);
  // The native matcher has now proved the exact rehearsed bytes. Bind its live inode
  // only in this verification view, never in the immutable original inventory.
  const verification = { ...inventory, configRepair: { ...inventory.configRepair, result } };
  migrationVerifyPreservation(verification, migrationReadArtifact(root, record, "backups"), release, migrationRecordProfile(record));
  if (record.agentMigration.artifacts.config) {
    if (!isDeepStrictEqual(migrationReadArtifact(root, record, "config"), result)) reject("retained canonical config result changed");
    return expected;
  }
  return migrationAttachValue(pathname, root, expected, "config", result);
}

function migrationCreate(root, input) {
  const namespace = migrationNamespace(root);
  if (lstatSync(namespace.pathname, { throwIfNoEntry: false })) reject("activation journal already exists");
  if (!input || typeof input !== "object" || Array.isArray(input) || input.suspension !== null ||
      Object.hasOwn(input, "agentMigration") ||
      (input.phase !== undefined && input.phase !== "AGENT_REHEARSAL"))
    reject("migration creation requires a fresh rehearsal record without suspension authority");
  const profile = migrationRecordProfile(input);
  const record = validJournal({ ...input, phase: "AGENT_REHEARSAL", agentMigration: {
    version: 1, from: profile.from[profile.role], to: profile.to[profile.role], phase: "rehearsal",
    stage: `${profile.stagePrefix}-${randomUUID()}`, artifacts: {},
  } });
  migrationReleaseProof(root, record, namespace.owner);
  migrationPointers(root, namespace.owner, {
    current: record.predecessor.sha, previous: record.pointerTopology.previous.sha,
  });
  const stage = join(namespace.directory, record.agentMigration.stage);
  mkdirSync(stage, { mode: 0o700 });
  chmodSync(stage, 0o700);
  const stageIdentity = migrationStage(root, record, namespace.owner);
  syncPath(stage);
  syncPath(namespace.directory);
  atomicJson(namespace.pathname, record, { noReplace: true });
  const evidence = migrationLoad(namespace.pathname, root);
  if (!isDeepStrictEqual(evidence.identity.stage, stageIdentity) || !isDeepStrictEqual(evidence.record, record))
    reject("new migration journal or stage changed during publication");
  return evidence;
}

function migrationUpdate(pathname, root, expected, record, beforePublication) {
  validJournal(record);
  migrationLoad(pathname, root, expected);
  if (expected.record.agentMigration.phase === "rehearsal" && record.agentMigration.phase === "prepared" &&
      record.suspension.expiresAtMs <= Date.now() + 5_000)
    reject("migration suspension expired before preparation publication");
  beforePublication?.();
  // Only the canonical deployment owner writes these records under its existing exclusive lock.
  atomicJson(pathname, record);
  const evidence = migrationLoad(pathname, root);
  if (!isDeepStrictEqual(evidence.identity.stage, expected.identity.stage) || !isDeepStrictEqual(evidence.record, record))
    reject("migration journal or bound stage changed during publication");
  return evidence;
}

function migrationArtifact(pathname, root, expected, kind) {
  const evidence = migrationLoad(pathname, root, expected);
  const record = evidence.record;
  const migration = record.agentMigration;
  if (!Object.hasOwn(migrationArtifactPhases, kind) || migration.phase !== migrationArtifactPhases[kind] ||
      Object.hasOwn(migration.artifacts, kind))
    reject("migration artifact is unknown, already bound, or not writable in this phase");
  const bytes = migrationReadBytes(0, migrationJsonLimit);
  migrationJson(bytes);
  migrationLoad(pathname, root, expected);
  const name = `${kind}-${randomUUID()}.json`;
  const artifactPath = join(evidence.identity.stage.path, name);
  migrationWriteExclusive(artifactPath, bytes, 0o600);
  const file = migrationFile(artifactPath, migrationOwner());
  if (!file.bytes.equals(bytes)) reject("new migration artifact bytes changed");
  migration.artifacts[kind] = { name, device: file.descriptor.device, inode: file.descriptor.inode, sha256: file.descriptor.sha256 };
  return migrationUpdate(pathname, root, expected, record);
}

function migrationAdvanceActivation(pathname, root, expected, phase) {
  const { record } = migrationLoad(pathname, root, expected);
  const allowedFrom = phase === "B_PREVIOUS_PUBLISHED"
    ? ["A_PREPARED", "B_PREVIOUS_PUBLISHED"]
    : phase === "C_CURRENT_SELECTED" ? ["B_PREVIOUS_PUBLISHED", "C_CURRENT_SELECTED"] : [];
  if (record.agentMigration.phase !== "prepared" || !allowedFrom.includes(record.phase))
    reject("migration activation advance is not prepared, sequential, or forward-only");
  migrationPointers(root, migrationOwner(), {
    current: phase === "B_PREVIOUS_PUBLISHED" ? record.predecessor.sha : record.candidate.sha,
    previous: record.predecessor.sha,
  });
  // The shell publishes pointers; this helper only records their exact observed state.
  if (record.phase === phase) return migrationLoad(pathname, root, expected);
  record.phase = phase;
  return migrationUpdate(pathname, root, expected, record);
}

function migrationTransition(pathname, root, expected, patch, rawControllerPid) {
  const { record } = migrationLoad(pathname, root, expected);
  const phase = record.agentMigration.phase;
  const preparing = patch?.phase === "prepared" && (phase === "rehearsal" || (phase === "prepared" && record.phase === "A_PREPARED"));
  suspensionObject(patch, preparing ? ["phase", "process", "suspension", "releaseProof"] : ["phase"], "migration transition");
  if (preparing) {
    migrationLiveCheck(pathname, root, expected, patch.releaseProof, rawControllerPid);
    if (phase === "prepared" && !isDeepStrictEqual(record.process, patch.process)) reject("prepared migration cannot adopt a replacement predecessor");
    record.process = patch.process;
    record.suspension = patch.suspension;
    record.phase = "A_PREPARED";
    record.agentMigration.phase = "prepared";
    validJournal(record);
    suspensionToken(record.suspension.id, "migration suspension identity");
    if (!Number.isSafeInteger(record.suspension.expiresAtMs) || record.suspension.expiresAtMs <= Date.now() + 5_000 ||
        !["ready", "draining"].includes(record.suspension.status))
      reject("migration preparation requires the owner's fresh genuine suspension");
    migrationPointers(root, migrationOwner(), {
      current: record.predecessor.sha, previous: record.pointerTopology.previous.sha,
    });
  } else if (phase === "prepared" && patch.phase === "doctor-started" && record.phase === "C_CURRENT_SELECTED") {
    record.agentMigration.phase = "doctor-started";
    migrationPointers(root, migrationOwner(), { current: record.candidate.sha, previous: record.predecessor.sha });
  } else if (phase === "doctor-started" && patch.phase === "stores-verified") {
    if (record.offlineDoctor) {
      offlineVerifyBound(root, record);
      record.protectedPaths[1] = identity(record.protectedPaths[1].path);
    }
    if (migrationRecordProfile(record).config) {
      const inventory = migrationReadArtifact(root, record, "inventory"), result = migrationReadArtifact(root, record, "config");
      configRepairVerifyInputs(inventory, result);
      migrationVerifyPreservation({ ...inventory, configRepair: { ...inventory.configRepair, result } },
        migrationReadArtifact(root, record, "backups"), join(root, "releases", record.candidate.sha), migrationRecordProfile(record));
      record.protectedPaths[0] = identity(inventory.config.path);
    }
    record.agentMigration.phase = "stores-verified";
    // The inner proof state and outer boot-eligible phase are one durable publication.
    record.phase = "D_VERIFYING";
    migrationPointers(root, migrationOwner(), { current: record.candidate.sha, previous: record.predecessor.sha });
  } else {
    reject("unsupported migration transition or outer phase");
  }
  return migrationUpdate(pathname, root, expected, record);
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
  const phase = migrationStatus(journal, root);
  if (!installed) {
    // Bootstrap is the only no-journal permit mint. A missing permit on resume is never initialization.
    if (phase !== "none" || lstatSync(journal, { throwIfNoEntry: false }))
      reject("cannot bootstrap a native guard with any pending activation journal");
    migrationPublishPermit(root);
    migrationWriteExclusive(pathname, Buffer.from(migrationGuardBody(root)), 0o644);
  }
  const file = migrationFile(pathname, owner, { privateOnly: false, mode: 0o644, limit: migrationJournalLimit });
  if (!file.bytes.equals(Buffer.from(migrationGuardBody(root)))) reject("existing migration guard body differs");
  if (["none", "rehearsal"].includes(phase) && !migrationPermit(root))
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

function migrationRevokePermit(pathname, root, expected) {
  const { record } = migrationLoad(pathname, root, expected);
  if (!["prepared", "doctor-started"].includes(record.agentMigration.phase))
    reject("permit revocation requires an approved pending live migration");
  const permit = migrationPermit(root);
  if (permit) {
    if (!isDeepStrictEqual(migrationPermit(root), permit)) reject("Gateway permit changed before revocation");
    unlinkSync(permit.path); syncPath(dirname(permit.path));
  }
  migrationLoad(pathname, root, expected);
  return "FENCED";
}

function migrationAllowPermit(pathname, root, expected, procRoot) {
  const { record } = migrationLoad(pathname, root, expected);
  if (record.agentMigration.phase !== "stores-verified" || !["D_VERIFYING", "ROLLBACK_FAILED"].includes(record.phase))
    reject("Gateway permit requires durable verified stores and candidate selection");
  migrationReleaseProof(root, record, migrationOwner());
  migrationPointers(root, migrationOwner(), { current: record.candidate.sha, previous: record.predecessor.sha });
  migrationVerifyReadyStores(root, record, migrationArtifactRead(root, record, "ready", migrationOwner()));
  if (!migrationPermit(root)) {
    // A cold recovery has not admitted readers. Reestablish full preservation now, not just
    // schema/identity facts; post-start retirement deliberately permits legitimate later writes.
    const inventory = migrationReadArtifact(root, record, "inventory"), release = join(root, "releases", record.candidate.sha);
    migrationWritersStopped(pathname, root, expected, procRoot, inventory);
    migrationVerifyPreservation(inventory, migrationReadArtifact(root, record, "backups"), release, migrationRecordProfile(record));
    if (migrationRecordProfile(record).config) configRepairVerifyInputs(inventory, migrationReadArtifact(root, record, "config"));
    else if (!migrationRecordProfile(record).nativeDoctor) migrationVerifyInputBytes(inventory.inputs, true);
    migrationWritersStopped(pathname, root, expected, procRoot, inventory);
  }
  migrationLoad(pathname, root, expected);
  migrationPointers(root, migrationOwner(), { current: record.candidate.sha, previous: record.predecessor.sha });
  syncPath(root); syncPath(dirname(pathname));
  return migrationPublishPermit(root);
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

function migrationLegacyAgentEmpty(stateRoot, release) {
  const directory = join(stateRoot, "agent"), entry = lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory)
    reject("ancient agent root is outside the qualified layout");
  const names = readdirSync(directory);
  if (!names.length) return;
  const databasePath = join(directory, "openclaw-agent.sqlite");
  const allowed = new Set(["openclaw-agent.sqlite", "openclaw-agent.sqlite-wal", "openclaw-agent.sqlite-shm", "openclaw-agent.sqlite-journal"]);
  if (names.some(name => !allowed.has(name))) reject("ancient state/agent has unqualified file payload");
  migrationDatabaseRead(databasePath, release, database => {
    const metadata = database.prepare("SELECT agent_id FROM schema_meta WHERE meta_key='primary'").get();
    if (typeof metadata?.agent_id !== "string" || !metadata.agent_id.trim()) reject("ancient agent ownership is missing");
    migrationSchema(database, metadata.agent_id, [17]);
    // Exact Core inspectLegacyAgentDir predicate: only seeded schema controls are not payload.
    const tables = database.prepare(`SELECT name FROM pragma_table_list WHERE schema='main' AND type IN ('table','virtual')
      AND substr(name,1,7)<>'sqlite_' AND name NOT IN ('schema_meta','session_key_contract','memory_index_state')`).all();
    for (const { name } of tables)
      if (database.prepare(`SELECT 1 FROM ${migrationSqlName(name)} LIMIT 1`).get()) reject("ancient state/agent has unqualified database payload");
  });
}

function migrationSourceSchemas(inventory, profile) {
  const baseline = inventory?.coldBaseline;
  if (baseline === undefined) return profile.from;
  suspensionObject(baseline, ["kind", "schemaVersions"], "cold recovery baseline");
  if (baseline.kind !== "already-target-before-doctor" || !profile.nativeDoctor || profile.originalColdRequired ||
      profile.from.agent !== profile.to.agent || !isDeepStrictEqual(baseline.schemaVersions, profile.to))
    reject("cold recovery baseline is outside the qualified native Doctor edge");
  return baseline.schemaVersions;
}

function migrationColdSchema(release) {
  const name = "session_transcript_cold_archives";
  // The sealed full-source release owns this DDL. Never reproduce its migration against live data.
  const pathname = join(release, "src/state/openclaw-agent-schema.sql"), entry = lstatSync(pathname);
  if (!entry.isFile() || entry.size > 1024 * 1024) reject("candidate cold transcript schema cannot be qualified");
  const source = readFileSync(pathname, "utf8");
  const definitions = [...source.matchAll(/^CREATE TABLE IF NOT EXISTS session_transcript_cold_archives \([\s\S]*?^\) STRICT;/gm)];
  if (definitions.length !== 1)
    reject("candidate cold transcript schema cannot be qualified");
  const expected = new DatabaseSync(":memory:");
  try {
    expected.prepare(definitions[0][0]).run();
    return expected.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name).sql;
  } finally { expected.close(); }
}

function migrationColdTable(database, version, canonicalSchema) {
  const actual = database.prepare("SELECT type,sql FROM sqlite_schema WHERE name='session_transcript_cold_archives'").get();
  if (version === 19) {
    if (actual) reject("agent schema 19 contains an unqualified cold transcript representation");
    return;
  }
  if (actual?.type !== "table" || actual.sql !== canonicalSchema)
    reject("cold transcript table differs from the candidate canonical schema");
  if (database.prepare("SELECT 1 FROM session_transcript_cold_archives LIMIT 1").get())
    reject("cold transcript payloads require separate backup qualification");
}

function migrationInventory(configPath, databasePath, release, profile, final = false, baseline) {
  const schemas = final ? profile.to : migrationSourceSchemas(baseline, profile);
  if (!isDeepStrictEqual(jsonFile(join(release, "package.json")).openclaw.schemaVersions, profile.to))
    reject("migration inventory candidate schema tuple changed");
  const stateRoot = realpathSync(dirname(configPath));
  if (databasePath !== join(stateRoot, "state", "openclaw.sqlite") || realpathSync(configPath) !== configPath)
    reject("agent migration requires the canonical Team config and shared-state layout");
  migrationLegacyAgentEmpty(stateRoot, release);
  const config = jsonFile(configPath);
  if (profile.coldTranscripts) migrationColdExtractionDisabled(config);
  const coldSchema = profile.coldTranscripts ? migrationColdSchema(release) : undefined;
  // Team uses canonical per-agent stores. Do not guess fixed-store or external-owner mappings.
  if (config.session?.store != null || JSON.stringify(config).includes('"$include"'))
    reject("agent migration input closure requires qualification for custom session stores or config includes");
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
    if (!(profile.participants ? [17, 18] : [schemas.agent]).includes(row.schema_version))
      reject("registry metadata is outside the qualified migration edge");
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
      reject("configured noncanonical agent directory requires explicit inventory qualification");
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
      if (profile.coldTranscripts && store.agentId !== null) migrationColdTable(database, schemas.agent, coldSchema);
      return schema;
    }));
    store.aliases.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return { version: 1, ...migrationProfileBinding(profile), ...(baseline?.coldBaseline ? { coldBaseline: baseline.coldBaseline } : {}),
    ...(profile.config ? { configMigration: true } : {}),
    stateRoot, config: migrationHashFile(configPath), stores: result, registry };
}

function migrationSameInventory(before, after, profile, final = false, configResult) {
  migrationCheckProfileBinding(before, profile); migrationCheckProfileBinding(after, profile);
  const sourceSchemas = migrationSourceSchemas(before, profile);
  if (after.coldBaseline !== undefined && !isDeepStrictEqual(after.coldBaseline, before.coldBaseline))
    reject("recorded cold recovery baseline changed");
  const expectedConfig = profile.config && final && configResult?.canonical === true ? configResult.config : before.config;
  if (!isDeepStrictEqual(expectedConfig, after.config) || before.stateRoot !== after.stateRoot || before.stores.length !== after.stores.length)
    reject("migration config or complete physical inventory changed");
  for (const old of before.stores) {
    if (old.version !== (old.agentId === null ? sourceSchemas.state : sourceSchemas.agent))
      reject("original inventory does not match the qualified source schema tuple");
    const current = after.stores.find(value => value.path === old.path);
    if (!current || current.device !== old.device || current.inode !== old.inode || current.agentId !== old.agentId ||
        !old.aliases.every(alias => current.aliases.some(value => isDeepStrictEqual(value, alias))))
      reject("migration physical database or registered locator disappeared or changed");
    const schemas = final ? profile.to : sourceSchemas;
    if (current.version !== (current.agentId === null ? schemas.state : schemas.agent)) reject("migration left mixed physical schemas");
  }
  for (const old of before.registry) {
    const current = after.registry.find(value => value.agent_id === old.agent_id && value.path === old.path);
    if (!current || !(profile.participants ? [old.schema_version, 18] : [final ? profile.to.agent : profile.from.agent]).includes(current.schema_version))
      reject("migration registry identity or qualified historical version changed");
  }
  // Registration is metadata, not physical truth. Only this exact edge admits the historical17 hint.
  for (const row of after.registry) {
    const pathname = isAbsolute(row.path) ? resolve(row.path) : resolve(after.stateRoot, row.path);
    const store = after.stores.find(value => value.agentId === row.agent_id && value.aliases.some(alias => alias.path === pathname));
    if (!store || (final && store.version !== profile.to.agent) ||
        (!profile.participants && row.schema_version !== store.version)) reject("registry locator has no verified physical owner");
  }
  if (final && !profile.participants && after.stores.some(store => store.agentId !== null &&
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

function migrationParticipantProjection(database, version) {
  const table = database.prepare("SELECT type FROM sqlite_schema WHERE name='session_participants'").get();
  // Core's v17 participant owner may be lazy/absent; its supported migration creates an empty18 table.
  if (!table && version === 17) return { count: 0, sha256: createHash("sha256").digest("hex") };
  if (table?.type !== "table") reject("required participant table is absent or has an unsupported type");
  let fields = "session_key,identity_namespace,actor_id,contribution_count,first_prompted_at,last_prompted_at";
  if (version === 17) {
    const columns = database.prepare("PRAGMA table_info(session_participants)").all().map(row => row.name);
    const source = columns.includes("actor_source") ? "actor_source" : "NULL";
    const count = columns.includes("contribution_count") ? "coalesce(contribution_count,1)" : "1";
    const agent = `actor_type='agent' AND ${source}='agent' AND actor_id<>''`;
    const known = `(${agent}) OR (actor_type='human' AND ${source}='channel')`;
    fields = `session_key,CASE WHEN actor_type='human' AND ${source}='profile' AND actor_id<>'' THEN json_object('type','profile') WHEN ${agent} THEN json_object('type','agent') ELSE json_object('type','legacy','actorType',actor_type,'source',${source}) END AS identity_namespace,actor_id,${count} AS contribution_count,CASE WHEN ${known} THEN first_prompted_at ELSE NULL END AS first_prompted_at,CASE WHEN ${known} THEN last_prompted_at ELSE NULL END AS last_prompted_at`;
  }
  return migrationRowsDigest(database, `SELECT * FROM (SELECT ${fields} FROM session_participants) ORDER BY session_key,identity_namespace,actor_id`);
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
  let tables, participants, sourceJournalMode;
  try {
    sourceJournalMode = source.database.prepare("PRAGMA journal_mode").get().journal_mode;
    if (!["wal", "delete"].includes(sourceJournalMode)) reject("source persistent journal mode is not qualified");
    migrationSchema(source.database, store.agentId, [store.version]); migrationIntegrity(source.database);
    tables = migrationTableDigests(source.database);
    if (store.agentId !== null) participants = migrationParticipantProjection(source.database, store.version);
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
  return { source: store.path, sourceJournalMode, file: migrationHashFile(target), tables, ...(participants ? { participants } : {}) };
}

function migrationRehearsalCopy(snapshot, store, release, target) {
  const mode = snapshot.sourceJournalMode;
  if (!["wal", "delete"].includes(mode)) reject("fresh rehearsal copy requires captured source journal mode");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(snapshot.file.path, target, constants.COPYFILE_EXCL); chmodSync(target, 0o600);
  const copy = migrationOpenDatabase(target, release, false);
  try {
    // Immutable backups stay single-file DELETE; only this new execution copy
    // restores its captured persistent mode, never runtime connection tuning.
    if (copy.database.prepare(`PRAGMA journal_mode=${mode}`).get().journal_mode !== mode)
      reject("rehearsal copy could not restore its captured journal mode");
  } finally { copy.close(); }
  migrationDatabaseRead(target, release, database => {
    if (database.prepare("PRAGMA journal_mode").get().journal_mode !== mode)
      reject("rehearsal copy journal mode did not persist");
    migrationSchema(database, store.agentId, [store.version]);
  });
  return identity(target);
}

async function snapshotForRehearsal(root, release, configPath, databasePath, label, handoff) {
  const { owner, directory, pathname } = migrationNamespace(root);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(label) || (!handoff && lstatSync(pathname, { throwIfNoEntry: false })))
    reject("rehearsal snapshot requires a fresh label and no activation journal");
  if (handoff) hostHandoffSourceStopped(root, handoff);
  const info = validateRelease(release, basename(release), owner, true);
  if (realpathSync(join(root, "current")) !== release) reject("rehearsal source is not the current sealed release");
  const stage = handoff ? join(directory, handoff.stage, `export-${randomUUID()}`) : join(directory, `rehearsal-${label}`);
  if (lstatSync(stage, { throwIfNoEntry: false })) reject("rehearsal snapshot already exists; preserve it and use a fresh label");
  const profile = { from: info.schemaVersions, to: info.schemaVersions };
  const inventory = migrationInventory(configPath, databasePath, release, profile);
  const disk = statfsSync(directory);
  if (disk.bavail * disk.bsize < migrationDatabaseBytes(inventory, release) + inventory.config.size + migrationJsonLimit + operationalReserveBytes)
    reject("rehearsal snapshots lack destination capacity with the operational reserve retained");
  mkdirSync(stage, { mode: 0o700 }); syncPath(directory);
  const configCopy = join(stage, "openclaw.json");
  copyFileSync(configPath, configCopy, constants.COPYFILE_EXCL); chmodSync(configCopy, 0o600); syncPath(configCopy);
  const copiedConfig = migrationHashFile(configCopy);
  if (copiedConfig.sha256 !== inventory.config.sha256 || copiedConfig.size !== inventory.config.size)
    reject("configuration changed while capturing rehearsal inputs");
  const startedAt = Date.now(), backups = [];
  for (const [index, store] of inventory.stores.entries()) {
    process.stderr.write(`REHEARSAL_SNAPSHOT_STORE index=${index + 1} count=${inventory.stores.length}\n`);
    backups.push(await migrationSnapshot(store, release, join(stage, "snapshots", `${index}.sqlite`)));
  }
  migrationSameInventory(inventory, migrationInventory(configPath, databasePath, release, profile), profile);
  if ((!handoff && lstatSync(pathname, { throwIfNoEntry: false })) || realpathSync(join(root, "current")) !== release)
    reject("rehearsal source changed during snapshot capture");
  if (handoff) hostHandoffSourceStopped(root, handoff);
  const manifest = join(stage, "manifest.json");
  // Live stores have independent committed snapshots. Only the final stopped export is a handoff.
  atomicJson(manifest, { version: 1, kind: handoff ? "team-state-handoff" : "team-rehearsal-snapshot",
    consistency: handoff ? "quiesced-source" : "per-database-committed",
    ...(handoff ? { handoff: { id: handoff.id, sourceMachineId: handoff.machineId, targetMachineId: handoff.peerMachineId,
      targetSha: handoff.targetSha, process: handoff.process, schedules: handoff.schedules } } : {}),
    release: info, inventory, configCopy: copiedConfig, backups, startedAt, finishedAt: Date.now() }, { noReplace: true });
  return { manifest, manifestSha256: migrationHashFile(manifest).sha256, stores: backups.length,
    consistency: handoff ? "quiesced-source" : "per-database-committed", sourceWritersStopped: Boolean(handoff) };
}

function rehearsalReadOnlySnapshot(paths) {
  if ((statfsSync("/").type >>> 0) !== 0x9123683e)
    reject("rehearsal verification requires a frozen read-only Btrfs root snapshot");
  const query = args => {
    const result = spawnSync("/usr/bin/btrfs", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4096 });
    if (result.error || result.signal || result.status !== 0) reject("cannot verify the read-only rehearsal snapshot");
    return result.stdout.trim();
  };
  if (query(["property", "get", "-ts", "/", "ro"]) !== "ro=true")
    reject("rehearsal verification requires a frozen read-only Btrfs root snapshot");
  // btrfs-progs rootid opens regular files read/write. The native lookup ioctl
  // accepts an O_RDONLY descriptor and identifies file bind mounts precisely.
  const inspected = spawnSync("/usr/bin/python3", ["-c", `
import fcntl, json, os, struct, sys
result = []
for pathname in sys.argv[1:]:
    fd = os.open(pathname, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        # Linux btrfs_ioctl_ino_lookup_args: treeid=0, objectid=256, name[4080].
        lookup = bytearray(4096)
        struct.pack_into("=QQ", lookup, 0, 0, 256)
        fcntl.ioctl(fd, 0xd0009412, lookup, True)
        result.append({"rootId": str(struct.unpack_from("=Q", lookup)[0]), "device": before.st_dev, "inode": before.st_ino})
    finally:
        os.close(fd)
print(json.dumps(result))
`, "/", ...paths], { encoding: "utf8", timeout: 30_000, maxBuffer: migrationJsonLimit });
  if (inspected.error || inspected.signal || inspected.status !== 0) reject("cannot inspect read-only Btrfs file subvolumes");
  const entries = JSON.parse(inspected.stdout), root = entries?.[0];
  if (!Array.isArray(entries) || entries.length !== paths.length + 1 || !/^[1-9]\d*$/.test(root?.rootId) ||
      ["/", ...paths].some((pathname, index) => {
        const current = lstatSync(pathname), entry = entries[index];
        return entry?.rootId !== root.rootId || entry.device !== root.device || current.dev !== entry.device ||
          current.ino !== entry.inode || current.isSymbolicLink();
      }))
    reject("rehearsal target state is outside its frozen root subvolume");
}

function verifyRehearsalSnapshot(manifestPath, sourceRelease, candidateRelease, expectedManifestHash, handoff = false) {
  const owner = migrationOwner(), saved = migrationFile(manifestPath, owner, { mode: 0o600 });
  if (!/^[a-f\d]{64}$/.test(expectedManifestHash) || saved.descriptor.sha256 !== expectedManifestHash)
    reject("rehearsal manifest differs from its captured source digest");
  const manifest = migrationJson(saved.bytes);
  if (manifest?.version !== 1 || manifest.kind !== (handoff ? "team-state-handoff" : "team-rehearsal-snapshot") ||
      manifest.consistency !== (handoff ? "quiesced-source" : "per-database-committed") || !Array.isArray(manifest.backups))
    reject("rehearsal snapshot manifest is invalid");
  const source = validateRelease(sourceRelease, basename(sourceRelease), owner, true);
  const candidate = validateRelease(candidateRelease, basename(candidateRelease), owner, true);
  if (!isDeepStrictEqual(source, manifest.release)) reject("rehearsal source release differs from the snapshot");
  const profile = migrationProfile(source, candidate) ?? { from: source.schemaVersions, to: candidate.schemaVersions };
  const original = manifest.inventory;
  migrationCheckProfileBinding(original, { from: source.schemaVersions, to: source.schemaVersions });
  // The private rehearsal owner freezes this subvolume after Doctor. This protects against
  // ordinary concurrent writers, not a privileged operator deliberately thawing the snapshot.
  if (!handoff) rehearsalReadOnlySnapshot([original.config.path, ...original.stores.map(store => store.path)]);
  const copied = descriptor => {
    if (typeof descriptor?.path !== "string") reject("rehearsal artifact path is missing");
    safeRelative(dirname(manifestPath), descriptor.path);
    const actual = migrationHashFile(descriptor.path);
    if (actual.sha256 !== descriptor.sha256 || actual.size !== descriptor.size)
      reject("copied rehearsal artifact bytes differ from the source snapshot");
    return actual;
  };
  const configCopy = copied(manifest.configCopy), config = migrationHashFile(original.config.path);
  if (configCopy.sha256 !== original.config.sha256 || configCopy.size !== original.config.size ||
      config.sha256 !== configCopy.sha256 || config.size !== configCopy.size)
    reject("rehearsal config differs; verify Doctor before relocation and endpoint changes");
  const backups = manifest.backups.map(value => ({ ...value, file: copied(value.file) }));
  if (backups.length !== original.stores.length || new Set(backups.map(value => value.source)).size !== backups.length)
    reject("rehearsal snapshot has an incomplete or repeated database inventory");
  const current = migrationInventory(config.path, join(original.stateRoot, "state/openclaw.sqlite"), candidateRelease, profile, true);
  const stores = original.stores.map(store => {
    const target = current.stores.find(value => value.path === store.path && value.agentId === store.agentId);
    const snapshot = backups.find(value => value.source === store.path);
    if (!target || !snapshot) reject("rehearsal target lost an original database owner");
    return { ...store, device: target.device, inode: target.inode };
  });
  // Only physical copy identity changes. Original artifacts and their ownership/schema evidence stay immutable.
  const projected = { ...original, ...migrationProfileBinding(profile), config, stores };
  migrationSameInventory(projected, current, profile, true);
  const backupInventory = { ...original, stores: original.stores.map(store => {
    const snapshot = backups.find(value => value.source === store.path);
    return { ...store, path: snapshot.file.path, device: snapshot.file.device, inode: snapshot.file.inode };
  }) };
  const witness = migrationCaptureWitness(backupInventory, sourceRelease).map(encoded => {
    const tuple = JSON.parse(encoded), snapshot = backups.find(value => value.file.path === tuple[1]);
    const target = stores.find(value => value.path === snapshot.source && value.agentId === tuple[0]);
    return JSON.stringify([tuple[0], target.path, target.device, target.inode, ...tuple.slice(4)]);
  });
  migrationVerifyPreservation(projected, backups, candidateRelease, profile);
  migrationVerifyWitness(current, candidateRelease, witness);
  migrationSameInventory(projected, migrationInventory(config.path,
    join(original.stateRoot, "state/openclaw.sqlite"), candidateRelease, profile, true), profile, true);
  if (!isDeepStrictEqual(migrationFile(manifestPath, owner, { mode: 0o600 }).descriptor, saved.descriptor))
    reject("rehearsal snapshot manifest changed during verification");
  return { status: handoff ? "HANDOFF_COPY_VERIFIED" : "REHEARSAL_VERIFIED", source: source.sha, candidate: candidate.sha,
    stores: stores.length, sourceSessionWitnesses: witness.length, sourceWritersStopped: handoff };
}

function migrationRecallPaths(envelope) {
  if (envelope?.version !== 1 || typeof envelope.workspaceDir !== "string" || !isAbsolute(envelope.workspaceDir) ||
      typeof envelope.key !== "string" || typeof envelope.value?.path !== "string" ||
      envelope.workspaceKey !== createHash("sha256").update(resolve(envelope.workspaceDir).replaceAll("\\", "/")).digest("hex"))
    reject("memory recall envelope cannot be qualified");
  const pathname = envelope.value.path.replaceAll("\\", "/").replace(/^\.\//, "");
  const paths = [resolve(envelope.workspaceDir, pathname)];
  if (!pathname.startsWith("memory/")) paths.push(resolve(envelope.workspaceDir, "memory", pathname.split("/").at(-1)));
  return [...new Set(paths)];
}

function migrationCodexOrphan(row, inventory, release) {
  const match = /^(session-key|session):([a-z0-9][a-z0-9_-]{0,63}):(.+)$/.exec(row.entry_key);
  if (!match) return false;
  const value = JSON.parse(row.value_json), stable = match[1] === "session-key";
  const sessionId = typeof value?.sessionId === "string" ? value.sessionId.trim() : "";
  if (value?.version !== 1 || !sessionId || (stable ? !/^[A-Za-z0-9_-]{43}$/.test(match[3]) : sessionId !== match[3])) return false;
  if (value.state === "cleared") {
    if (value.binding !== undefined || (value.retired !== undefined && value.retired !== true)) return false;
  } else if (value.state === "active") {
    const binding = value.binding;
    if (!binding || typeof binding.threadId !== "string" || !binding.threadId.trim() || typeof binding.cwd !== "string" ||
        binding.connectionScope !== undefined || binding.supervisionSourceThreadId !== undefined ||
        binding.pendingSupervisionBranch !== undefined || value.retired !== undefined) return false;
  } else return false;
  if (value.lease !== undefined && (!value.lease || typeof value.lease.token !== "string" || !value.lease.token.trim() ||
      !Number.isFinite(value.lease.expiresAt) || value.lease.expiresAt > Date.now())) return false;
  const stores = inventory.stores.filter(store => store.agentId === match[2]);
  if (stores.length !== 1) return false; // Missing/ambiguous physical owner is not absence evidence.
  return migrationDatabaseRead(stores[0].path, release, database => {
    const rows = database.prepare("SELECT session_key,current_session_id,entry_json,entry_valid,updated_at FROM session_nodes WHERE current_session_id=?").all(sessionId);
    if (rows.length === 0) return true;
    if (rows.length !== 1) return false;
    const owner = rows[0];
    if (owner.entry_valid === -1) return true;
    let entry; try { entry = JSON.parse(owner.entry_json); } catch { return false; }
    if (owner.entry_valid !== 1 || entry?.sessionId !== sessionId || entry.updatedAt !== owner.updated_at) return false;
    return stable && match[3] !== createHash("sha256").update(owner.session_key).digest("base64url");
  });
}

function migrationComparePluginRows(before, after, inventory, release) {
  const read = database => database.prepare("SELECT * FROM plugin_state_entries ORDER BY plugin_id,namespace,entry_key").all();
  const oldRows = read(before), newRows = read(after), key = row => JSON.stringify([row.plugin_id, row.namespace, row.entry_key]);
  if (oldRows.length > 100_000 || newRows.length > 100_000) reject("plugin preservation proof exceeds bounded row budget");
  const remaining = new Map(newRows.map(row => [key(row), row]));
  for (const row of oldRows) {
    const current = remaining.get(key(row)); remaining.delete(key(row));
    if (current && isDeepStrictEqual(row, current)) continue;
    if (!current && row.plugin_id === "codex" && row.namespace === "app-server-thread-bindings" &&
        migrationCodexOrphan(row, inventory, release)) continue;
    // Complete-input Team qualification preserved every memory row byte-for-byte. Future
    // normalization needs new warm proof, never an exemption for days, tags, timestamps or loss.
    reject("unclassified protected plugin or memory state changed");
  }
  if (remaining.size) reject("unclassified new plugin or memory state row");
}

function migrationPluginLocators(plugin) {
  if (typeof plugin.rootDir !== "string" || !isAbsolute(plugin.rootDir) || typeof plugin.manifestPath !== "string" || !plugin.manifestPath)
    reject("installed plugin root or manifest is missing");
  const paths = [plugin.rootDir, plugin.manifestPath, plugin.source, plugin.setupSource].filter(Boolean);
  if (plugin.packageJson) {
    const relativePath = plugin.packageJson.path;
    if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath))
      reject("installed package JSON locator must be plugin-root-relative");
    const pathname = resolve(plugin.rootDir, relativePath);
    safeRelative(resolve(plugin.rootDir), pathname);
    safeRelative(realpathSync(plugin.rootDir), realpathSync(pathname));
    if (!statSync(pathname).isFile()) reject("installed package JSON locator is not a file");
    paths.push(pathname);
  }
  if (paths.some(pathname => typeof pathname !== "string" || !isAbsolute(pathname)))
    reject("installed plugin source locator is not absolute");
  return paths;
}

function migrationCompareSharedTable(name, before, after, inventory, release) {
  const rows = database => database.prepare(`SELECT * FROM ${migrationSqlName(name)}`).all().map(row => ({ ...row }));
  const oldRows = rows(before), newRows = rows(after);
  if (name === "plugin_state_entries") return migrationComparePluginRows(before, after, inventory, release);
  if (name === "agent_database_leases") {
    if (newRows.length !== 0) reject("Doctor left database maintenance leases");
    return; // Both namespace rehearsal and final cold proof have no admitted Gateway writers.
  }
  if (name === "agent_databases") {
    for (const row of [...oldRows, ...newRows])
      if (!isDeepStrictEqual(Object.keys(row).sort(), ["agent_id", "last_seen_at", "path", "schema_version", "size_bytes"]))
        reject("unclassified registry metadata columns");
    return; // Only registration time/size may vary beyond the independently checked physical owner/locator/version.
  }
  if (name === "exec_approvals_config") {
    if (oldRows.length !== newRows.length) reject("exec approval policy row disappeared");
    for (const row of oldRows) {
      const current = newRows.find(value => value.config_key === row.config_key);
      if (!current) reject("exec approval policy identity disappeared");
      const expected = JSON.parse(row.raw_json), actual = JSON.parse(current.raw_json);
      for (const agent of Object.values(expected.agents ?? {})) {
        if (agent.allowlist) agent.allowlist = agent.allowlist.filter(entry => !(entry.source === "allow-always" &&
          typeof entry.pattern === "string" && !entry.pattern.trim().startsWith("=command:") && !entry.pattern.trim().startsWith("=node-command:") &&
          !(typeof entry.argPattern === "string" && entry.argPattern.startsWith("sha256:cwd-argv:v1:"))));
      }
      if (!isDeepStrictEqual(expected, actual)) reject("Doctor changed exec approval authority beyond exact obsolete generated grants");
      const count = Object.values(actual.agents ?? {}).reduce((sum, agent) => sum + (agent.allowlist?.length ?? 0), 0);
      if (current.allowlist_count !== count) reject("Doctor exec approval count disagrees with exact retained grants");
      for (const field of ["raw_json", "allowlist_count", "updated_at_ms"]) { delete row[field]; delete current[field]; }
      if (!isDeepStrictEqual(row, current)) reject("Doctor changed exec approval policy projections");
    }
    return;
  }
  if (name === "config_machine_state") {
    const current = new Map(newRows.map(row => [row.state_key, row]));
    for (const row of oldRows) {
      const next = current.get(row.state_key); current.delete(row.state_key);
      if (!next) reject("Doctor removed machine-owned state");
      if (row.value_json === next.value_json) continue;
      if (row.state_key === "plugins.installedIndex") {
        const old = JSON.parse(row.value_json), value = JSON.parse(next.value_json);
        if (!old.index || !value.index || !isDeepStrictEqual(old.index.installRecords, value.index.installRecords) || !Array.isArray(value.index.plugins))
          reject("Doctor changed plugin install ownership during schema migration");
        for (const plugin of value.index.plugins) {
          const locators = migrationPluginLocators(plugin);
          if (plugin.origin !== "bundled") {
            const original = old.index.plugins?.find(entry => entry.pluginId === plugin.pluginId);
            if (!original || original.origin !== plugin.origin || original.rootDir !== plugin.rootDir)
              reject("Doctor changed an external plugin owner or root");
            continue;
          }
          for (const pathname of locators) safeRelative(release, pathname);
        }
        continue;
      }
      reject("Doctor changed unclassified machine-owned state");
    }
    if (current.size) reject("Doctor added unclassified machine-owned state");
    return;
  }
  if (name === "config_health_entries") {
    if (oldRows.length !== newRows.length) reject("Doctor changed config health ownership");
    for (const row of oldRows) {
      const next = newRows.find(value => value.config_path === row.config_path);
      if (!next || row.last_observed_suspicious_signature !== next.last_observed_suspicious_signature)
        reject("Doctor changed config health suspicion or owner");
      for (const field of ["last_known_good_json", "last_promoted_good_json"]) {
        if (row[field] === next[field]) continue;
        const value = JSON.parse(next[field]);
        if (row.config_path !== inventory.config.path || value?.hash !== inventory.config.sha256 || value.bytes !== inventory.config.size)
          reject("Doctor health fingerprint does not describe the unchanged config");
      }
    }
    return;
  }
  reject(`unclassified shared-state table changed: ${name}`);
}

function migrationCreatorEntry(entry) {
  // Core 036e0d9bf714 owns this historical transformation. Match its explicit
  // seams without granting authority from IDs, participants, routes or sandbox policy.
  const legacy = entry.createdBy;
  const actor = entry.createdActor ?? (legacy && typeof legacy === "object" && !Array.isArray(legacy)
    ? { ...legacy, type: "human", source: "unknown" } : undefined);
  if (actor?.type !== "human") return entry;
  const source = ["profile", "channel", "unknown"].includes(actor.source) ? actor.source
    : ["operator", "run"].includes(entry.createdVia) ? "profile" : entry.createdVia === "channel" ? "channel" : "unknown";
  if (actor === entry.createdActor && source === actor.source && !legacy) return entry;
  const result = { ...entry, createdActor: { ...actor, source } };
  delete result.createdBy;
  return result;
}

function migrationVerifyCreatorTable(name, before, after) {
  const columns = database => database.prepare(`PRAGMA table_info(${migrationSqlName(name)})`).all().map(row => row.name);
  const fields = columns(before);
  if (!isDeepStrictEqual(fields, columns(after))) reject("creator migration changed unrelated table columns");
  const session = name === "session_nodes", json = session ? "entry_json" : "job_json";
  const order = session ? "session_key" : "store_key,job_id";
  const selected = session
    ? "json_extract(entry_json,'$.createdActor.type')='human' OR (json_type(entry_json,'$.createdActor') IS NULL AND json_type(entry_json,'$.createdBy')='object')"
    : "json_extract(job_json,'$.createdActor.type')='human'";
  const predicate = `CASE WHEN json_valid(${json}) THEN (${selected}) ELSE 0 END`;
  const names = fields.map(migrationSqlName).join(",");
  let expected;
  if (session) {
    const jsonIndex = fields.indexOf(json), typeIndex = fields.indexOf("created_actor_type"), idIndex = fields.indexOf("created_actor_id");
    if ([jsonIndex, typeIndex, idIndex].some(index => index < 0)) reject("session creator projections are missing");
    expected = migrationRowsDigest(before, `SELECT ${names},${predicate} FROM ${name} ORDER BY ${order}`, row => {
      if (row.pop()) {
        const entry = migrationCreatorEntry(JSON.parse(row[jsonIndex]));
        row[jsonIndex] = JSON.stringify(entry);
        row[typeIndex] = entry.createdActor?.type ?? null;
        row[idIndex] = entry.createdActor?.id ?? null;
      }
      return row;
    });
  } else {
    // SQLite owns json_set's exact serialization, including untouched numeric JSON.
    const projected = fields.map(field => field === json
      ? `CASE WHEN ${predicate} THEN json_set(${json},'$.createdActor.source','unknown') ELSE ${json} END`
      : migrationSqlName(field)).join(",");
    expected = migrationRowsDigest(before, `SELECT ${projected} FROM ${name} ORDER BY ${order}`);
  }
  if (!isDeepStrictEqual(expected, migrationRowsDigest(after, `SELECT ${names} FROM ${name} ORDER BY ${order}`)))
    reject("creator migration differs from its exact historical namespace projection");
}

function migrationVerifyContextColumn(before, after) {
  const name = "session_transcript_active_events";
  const columns = database => database.prepare(`PRAGMA table_info(${name})`).all().map(row => ({ ...row }));
  const original = columns(before), current = columns(after);
  const added = current.at(-1);
  if (original.some(column => column.name === "context_eligible") ||
      !isDeepStrictEqual(current.slice(0, -1), original) || !isDeepStrictEqual(added,
        { cid: original.length, name: "context_eligible", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 }))
    reject("transcript context migration is not the exact nullable INTEGER addition");
  const sql = database => database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name).sql;
  const expected = new DatabaseSync(":memory:");
  try {
    // SQLite places added columns before table constraints; preserve its exact schema rewrite.
    expected.prepare(sql(before)).run();
    expected.exec(`ALTER TABLE ${name} ADD COLUMN context_eligible INTEGER`);
    if (sql(after) !== sql(expected) ||
        after.prepare(`SELECT 1 FROM ${name} WHERE context_eligible IS NOT NULL LIMIT 1`).get())
      reject("transcript context migration changed constraints or classified historical rows");
  } finally { expected.close(); }
  const fields = original.map(column => migrationSqlName(column.name)).join(",");
  const query = `SELECT ${fields} FROM ${name} ORDER BY ${fields}`;
  if (!isDeepStrictEqual(migrationRowsDigest(before, query), migrationRowsDigest(after, query)))
    reject("transcript context migration changed original event rows");
}

function migrationVerifyContextIndex(database) {
  const index = database.prepare("SELECT tbl_name,sql FROM sqlite_schema WHERE type='index' AND name='idx_agent_transcript_context_pending'").get();
  if (index?.tbl_name !== "session_transcript_active_events" ||
      index.sql.replace(/\s+/gu, " ").trim() !==
        "CREATE INDEX idx_agent_transcript_context_pending ON session_transcript_active_events(session_id) WHERE context_eligible IS NULL")
    reject("transcript context pending index does not match the canonical addition");
}

function migrationVerifyBindingTargets(before, after) {
  const name = "current_conversation_bindings";
  const sql = database => database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name)?.sql;
  const expected = new DatabaseSync(":memory:");
  try {
    // Core 3506cf9d1a6 owns the two DROP COLUMN operations. Replay only their schema
    // effect in memory so additive columns and original constraints remain protected.
    expected.exec(sql(before));
    const original = expected.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
    for (const column of ["target_agent_id", "target_session_id"])
      if (original.includes(column)) expected.exec(`ALTER TABLE ${name} DROP COLUMN ${column}`);
    if (sql(after) !== sql(expected)) reject("binding target migration changed unrelated columns or constraints");
    const fields = original.filter(column => !["target_agent_id", "target_session_id"].includes(column)).map(migrationSqlName).join(",");
    const query = `SELECT ${fields} FROM ${name} ORDER BY ${fields}`;
    if (!isDeepStrictEqual(migrationRowsDigest(before, query), migrationRowsDigest(after, query)))
      reject("binding target migration changed retained record or projection bytes");
  } finally { expected.close(); }
  const index = after.prepare("SELECT tbl_name,sql FROM sqlite_schema WHERE type='index' AND name='idx_current_conversation_bindings_target'").get();
  if (index?.tbl_name !== name || index.sql.replace(/\s+/gu, " ").trim() !==
      "CREATE INDEX idx_current_conversation_bindings_target ON current_conversation_bindings(target_session_key, updated_at DESC, binding_key)")
    reject("binding target migration index is not canonical");
}

function migrationVerifyPreservation(inventory, backups, release, profile) {
  migrationCheckProfileBinding(inventory, profile);
  const sourceSchemas = migrationSourceSchemas(inventory, profile);
  const coldSchema = profile.coldTranscripts ? migrationColdSchema(release) : undefined;
  for (const store of inventory.stores) {
    const snapshot = backups.find(value => value.source === store.path);
    if (!snapshot || !isDeepStrictEqual(migrationHashFile(snapshot.file.path), snapshot.file)) reject("original lossless backup changed");
    const old = migrationOpenDatabase(snapshot.file.path, release), current = migrationOpenDatabase(store.path, release);
    try {
      migrationIntegrity(current.database);
      migrationSchema(old.database, store.agentId, [store.agentId === null ? sourceSchemas.state : sourceSchemas.agent]);
      migrationSchema(current.database, store.agentId, [store.agentId === null ? profile.to.state : profile.to.agent]);
      if (profile.coldTranscripts && store.agentId !== null) {
        migrationColdTable(old.database, sourceSchemas.agent, coldSchema);
        migrationColdTable(current.database, profile.to.agent, coldSchema);
      }
      if (profile.nativeDoctor) {
        // Full Doctor owns shared rewrites and agent repairs across its qualified edges.
        // Keep original proposals; backups, physical owners and session witnesses remain mandatory.
        if (store.agentId === null && snapshot.tables.skill_workshop_proposals) {
          const retained = new Set(current.database.prepare("SELECT proposal_id FROM skill_workshop_proposals").all().map(row => row.proposal_id));
          for (const row of old.database.prepare("SELECT proposal_id FROM skill_workshop_proposals").all())
            if (!retained.has(row.proposal_id)) reject("native Doctor lost an original Workshop proposal");
        }
        continue;
      }
      if (profile.participants && store.agentId !== null && !isDeepStrictEqual(migrationParticipantProjection(current.database, 18), snapshot.participants))
        reject("participant migration differs from its exact historical identity projection");
      const tables = migrationTableDigests(current.database);
      if (profile.config) {
        const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
        if (!isDeepStrictEqual(schema(old.database), schema(current.database))) reject("config repair changed database schema");
        for (const [name, digest] of Object.entries(tables)) {
          if (store.agentId === null && ["config_machine_state", "diagnostic_events"].includes(name) && inventory.configRepair?.result) continue;
          if (!isDeepStrictEqual(digest, snapshot.tables[name])) reject(`config repair changed protected table: ${name}`);
        }
        if (store.agentId === null && inventory.configRepair?.result)
          configRepairVerifyDatabase(old.database, current.database, inventory);
        continue;
      }
      if (profile.bindings && store.agentId === null)
        migrationVerifyBindingTargets(old.database, current.database);
      if (profile.creators && snapshot.tables.session_transcript_active_events)
        migrationVerifyContextIndex(current.database);
      for (const [name, expected] of Object.entries(snapshot.tables)) {
        // ANALYZE owns sqlite_stat1..4; these rebuildable planner statistics are
        // retained in cold backups but can change independently of stored data.
        if (/^sqlite_stat[1-4]$/u.test(name)) continue;
        if (profile.participants && store.agentId !== null && name === "session_participants") continue; // Exact projection checked above.
        if (profile.bindings && store.agentId === null && name === "current_conversation_bindings") continue; // Exact projection checked above.
        if (profile.creators && (store.agentId === null ? name === "cron_jobs" : name === "session_nodes")) {
          migrationVerifyCreatorTable(name, old.database, current.database);
          continue;
        }
        if (isDeepStrictEqual(tables[name], expected)) continue;
        if (!tables[name]) reject(`Doctor removed an original table: ${name}`);
        if (name === "schema_meta") {
          const strip = db => db.prepare("SELECT meta_key,role,agent_id,created_at FROM schema_meta ORDER BY meta_key").all();
          if (!isDeepStrictEqual(strip(old.database), strip(current.database))) reject("Doctor changed schema ownership or creation history");
        } else if (profile.creators && store.agentId !== null && name === "session_transcript_active_events") {
          migrationVerifyContextColumn(old.database, current.database);
        } else if (store.agentId === null) migrationCompareSharedTable(name, old.database, current.database, inventory, release);
        else reject(`Doctor changed protected agent table: ${name}`);
      }
      for (const [name, digest] of Object.entries(tables))
        if (!/^sqlite_stat[1-4]$/u.test(name) && !snapshot.tables[name] && digest.count !== 0) reject(`Doctor added unclassified nonempty table: ${name}`);
    } finally { current.close(); old.close(); }
  }
}

function migrationReadArtifact(root, record, kind) {
  return migrationJson(migrationArtifactRead(root, record, kind, migrationOwner()));
}

function configRepairBackupPaths(configPath) {
  return [configPath, `${configPath}.bak`, ...[1, 2, 3, 4].map(index => `${configPath}.bak.${index}`)];
}

function configRepairCaptureInputs(inventory, inputs) {
  const originals = join(dirname(inputs.copyRoot), "config-originals");
  mkdirSync(originals, { mode: 0o700 });
  const copies = configRepairBackupPaths(inventory.config.path).map((path, index) => {
    const original = inputs.sources.find(([target]) => target === path)?.[1];
    if (original === undefined) reject("config backup chain is outside the captured input closure");
    const copy = join(originals, String(index));
    if (original !== null) {
      copyFileSync(join(inputs.copyRoot, path.slice(1)), copy, constants.COPYFILE_EXCL);
      chmodSync(copy, 0o600); syncPath(copy);
    }
    return { path, original, copy: original === null ? null : migrationHashFile(copy) };
  });
  const entry = lstatSync(inventory.config.path);
  if (entry.nlink !== 1 || (entry.mode & 0o7777) !== 0o600) reject("native config replacement requires a private single-link file");
  syncPath(originals); syncPath(dirname(inputs.copyRoot));
  return { copies, startedAtMs: Date.now(), uid: entry.uid, gid: entry.gid };
}

function configRepairCheckCopies(inventory) {
  for (const value of inventory.configRepair.copies) {
    if (value.copy && !isDeepStrictEqual(migrationHashFile(value.copy.path), value.copy))
      reject("original config or canonical backup-chain copy changed");
  }
}

function configRepairVerifyRing(inventory) {
  configRepairCheckCopies(inventory);
  const repair = inventory.configRepair, paths = configRepairBackupPaths(inventory.config.path).slice(1);
  const token = value => value === null ? null : `${value.size}:${value.sha256}`;
  const observed = paths.map(path => {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) return null;
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || (entry.mode & 0o7777) !== 0o600 ||
        entry.uid !== repair.uid || entry.gid !== repair.gid) reject("native backup rotation has unsafe ownership or links");
    return migrationHashFile(path);
  });
  const target = JSON.stringify(observed.map(token)), initial = repair.copies.slice(1).map(value => token(value.original));
  const primary = token(repair.copies[0].original);
  // Finite native state machine: unlink last, four descending renames, copy primary.
  // Each best-effort operation can fail unchanged. A crash can restart at any boundary.
  // No backwards moves or invented bytes are admitted, even across repeated attempts.
  const queue = [[initial, 0]], seen = new Set();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [slots, step] = queue[cursor], key = JSON.stringify([slots, step]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (JSON.stringify(slots) === target) return observed;
    if (step !== 0) queue.push([slots, 0]);
    if (step === 6) continue;
    queue.push([slots, step + 1]);
    const next = slots.slice();
    if (step === 0) next[4] = null;
    else if (step === 5) next[0] = primary;
    else {
      const from = 4 - step;
      if (next[from] === null) continue;
      next[from + 1] = next[from]; next[from] = null;
    }
    queue.push([next, step + 1]);
  }
  reject("native backup rotation contains unreachable bytes or slot ordering");
}

function configRepairVerifyOriginalInputs(inventory) {
  const ring = configRepairBackupPaths(inventory.config.path).slice(1);
  migrationVerifyInputBytes(inventory.inputs.filter(([path]) => !ring.includes(path)), true);
  return configRepairVerifyRing(inventory);
}

function configRepairVerifyCanonicalResult(inventory, result) {
  configRepairCheckCopies(inventory);
  const primary = lstatSync(inventory.config.path);
  if (primary.uid !== inventory.configRepair.uid || primary.gid !== inventory.configRepair.gid ||
      (primary.mode & 0o7777) !== 0o600 || primary.nlink !== 1 || primary.dev !== inventory.config.device || primary.ino === inventory.config.inode)
    reject("native config replacement has unqualified ownership, mode or atomic identity");
  if (result?.canonical !== true || result.config?.path !== inventory.config.path ||
      result.config.sha256 !== inventory.configRepair.result.config.sha256 ||
      result.config.size !== inventory.configRepair.result.config.size ||
      !isDeepStrictEqual(result.snapshotAudit, inventory.configRepair.result.snapshotAudit) ||
      !isDeepStrictEqual(migrationHashFile(inventory.config.path), result.config))
    reject("config replacement is not the exact rehearsed native result");
  const ring = configRepairVerifyRing(inventory);
  if (result.backupRing && !isDeepStrictEqual(result.backupRing, ring)) reject("recorded native backup ring changed after commit");
}

function configRepairVerifyInputs(inventory, result, originalIdentity = true) {
  configRepairVerifyCanonicalResult(inventory, result);
  const paths = configRepairBackupPaths(inventory.config.path);
  migrationVerifyInputBytes(inventory.inputs.filter(([path]) => !paths.includes(path)), originalIdentity);
}

function configRepairAuditAdmission(database, config) {
  if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='diagnostic_events'").get())
    reject("config repair requires the canonical native diagnostic store");
  for (const [table, columns] of [
    ["config_machine_state", ["state_key", "value_json", "updated_at_ms"]],
    ["diagnostic_events", ["scope", "event_key", "payload_json", "created_at", "sequence"]],
  ]) {
    const actual = database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).sort();
    if (!isDeepStrictEqual(actual, columns.sort())) reject("native metadata table has unclassified columns");
  }
  const snapshots = database.prepare("SELECT * FROM diagnostic_events WHERE scope='config-snapshot'").all();
  if (snapshots.length > 1 || snapshots.some(row => row.event_key !== "latest")) reject("unqualified config snapshot slots");
  if (snapshots.length) {
    const prior = JSON.parse(snapshots[0].payload_json);
    if (prior.configPath !== config.path || prior.rawHash !== config.sha256)
      reject("stale config audit baseline requires separate qualification");
  }
  if (database.prepare("SELECT count(*) AS count FROM diagnostic_events WHERE scope='config-audit'").get().count >= 49_999)
    reject("config audit retention would evict original records");
}

function configRepairVerifyDatabase(old, current, inventory) {
  const repair = inventory.configRepair, observed = migrationHashFile(inventory.config.path);
  const result = { ...repair.result, config: { ...repair.result.config, ...observed } };
  const canonical = observed.sha256 === repair.result.config.sha256 && observed.size === repair.result.config.size;
  if (!canonical && !isDeepStrictEqual(observed, inventory.config)) reject("config effects have no bound original or canonical file");
  const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  if (!isDeepStrictEqual(schema(old), schema(current))) reject("same-schema config repair changed physical schema");
  configRepairAuditAdmission(old, inventory.config);
  const inWindow = value => Number.isSafeInteger(value) && value >= repair.startedAtMs && value <= Date.now();
  const machineOther = db => migrationRowsDigest(db, "SELECT * FROM config_machine_state WHERE state_key!='config.lastTouchedAt' ORDER BY state_key");
  if (!isDeepStrictEqual(machineOther(old), machineOther(current))) reject("config writer changed unrelated machine state");
  const oldTouched = old.prepare("SELECT * FROM config_machine_state WHERE state_key='config.lastTouchedAt'").get();
  const touched = current.prepare("SELECT * FROM config_machine_state WHERE state_key='config.lastTouchedAt'").get();
  const metadataWritten = !isDeepStrictEqual(oldTouched, touched);
  if (metadataWritten && (!touched || !inWindow(touched.updated_at_ms) ||
      typeof JSON.parse(touched.value_json) !== "string" || !inWindow(Date.parse(JSON.parse(touched.value_json)))))
    reject("native lastTouchedAt is not a bound post-commit timestamp");
  const rows = db => db.prepare("SELECT * FROM diagnostic_events ORDER BY scope,event_key").all();
  const originals = rows(old), after = rows(current), keyed = row => `${row.scope}\0${row.event_key}`;
  if (!canonical && (metadataWritten || !isDeepStrictEqual(originals, after)))
    reject("native metadata effects precede the bound config commit");
  const remaining = new Map(after.map(row => [keyed(row), row]));
  let snapshotWritten = false, auditWrites = 0;
  for (const row of originals) {
    const next = remaining.get(keyed(row));
    if (next && row.scope === "config-snapshot" && row.event_key === "latest" && !isDeepStrictEqual(row, next)) continue;
    if (!isDeepStrictEqual(row, next)) reject("native config writer changed or pruned an original audit record");
    remaining.delete(keyed(row));
  }
  for (const row of remaining.values()) {
    if (!inWindow(row.created_at) || !Number.isSafeInteger(row.sequence) || row.sequence < 1)
      reject("native audit record has unbound timestamp or sequence");
    const value = JSON.parse(row.payload_json);
    if (row.scope === "config-snapshot" && row.event_key === "latest") {
      if (!isDeepStrictEqual(value, result.snapshotAudit)) reject("native snapshot differs from the rehearsed keyed fingerprints");
      const original = originals.find(item => item.scope === "config-snapshot");
      if (row.sequence !== (original?.sequence ?? 1)) reject("native snapshot sequence changed");
      snapshotWritten = true;
      continue;
    }
    // The qualified io.runtime wrapper currently drops auditOrigin when forwarding
    // write options. Observe that absence truthfully; never manufacture an origin.
    if (row.scope !== "config-audit" || ++auditWrites > 1 || value.event !== "config.write" || value.source !== "config-io" ||
        value.configPath !== inventory.config.path || value.result !== "rename" ||
        (value.origin !== undefined && value.origin !== "doctor") ||
        value.previousHash !== inventory.config.sha256 || value.nextHash !== result.config.sha256 ||
        value.previousBytes !== inventory.config.size || value.nextBytes !== result.config.size ||
        value.existsBefore !== true || value.hasMetaAfter !== true || value.watchMode !== false ||
        value.watchSession !== null || value.watchCommand !== null ||
        !inWindow(Date.parse(value.ts)) || row.created_at !== Date.parse(value.ts) ||
        !row.event_key.startsWith(`${value.ts}:config.write:`)) reject("unqualified native config audit effect");
    const fields = new Set(["ts", "source", "event", "configPath", "pid", "ppid", "cwd", "argv", "execArgv", "watchMode", "watchSession", "watchCommand",
      "existsBefore", "previousHash", "nextHash", "previousBytes", "nextBytes", "changedPathCount", "changedPaths", "origin", "hasMetaBefore", "hasMetaAfter",
      "gatewayModeBefore", "gatewayModeAfter", "suspicious", "result",
      ...["previous", "next"].flatMap(prefix => ["Dev", "Ino", "Mode", "Nlink", "Uid", "Gid"].map(field => prefix + field))]);
    if (Object.keys(value).some(key => !fields.has(key)) || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
        !Number.isSafeInteger(value.ppid) || value.ppid < 1 || !Array.isArray(value.argv) || !Array.isArray(value.execArgv) ||
        typeof value.cwd !== "string" || !Array.isArray(value.suspicious) ||
        value.suspicious.some(reason => reason !== "missing-meta-before-write")) reject("native audit has unqualified fields");
    const sequence = Math.max(0, ...originals.filter(item => item.scope === "config-audit").map(item => item.sequence));
    if (row.sequence !== sequence + 1 || !/:[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(row.event_key))
      reject("native audit sequence or identity changed");
    const allowedPaths = new Set([...retiredConfigKeys.map(key => retiredConfigPrefix + key), "plugins.installs"]);
    if (!Array.isArray(value.changedPaths) || value.changedPathCount !== value.changedPaths.length ||
        value.changedPaths.some(path => !allowedPaths.has(path))) reject("native audit reports an unrelated config change");
    for (const [prefix, descriptor] of [["previous", inventory.config], ["next", result.config]]) {
      if (value[`${prefix}Dev`] !== String(descriptor.device) || value[`${prefix}Ino`] !== String(descriptor.inode) ||
          value[`${prefix}Mode`] !== 0o600 || value[`${prefix}Nlink`] !== 1 ||
          value[`${prefix}Uid`] !== repair.uid || value[`${prefix}Gid`] !== repair.gid)
        reject("native audit is not bound to the original and canonical config inodes");
    }
  }
  return { metadataWritten, snapshotWritten, auditWrites };
}

function configRepairEffects(inventory, backups, release) {
  const shared = inventory.stores.find(store => store.agentId === null);
  const original = backups.find(snapshot => snapshot.source === shared.path);
  return migrationDatabaseRead(original.file.path, release, before => migrationDatabaseRead(shared.path, release, after => ({
    ...configRepairVerifyDatabase(before, after, inventory),
    machineState: migrationRowsDigest(after, "SELECT * FROM config_machine_state ORDER BY state_key"),
    diagnosticEvents: migrationRowsDigest(after, "SELECT * FROM diagnostic_events ORDER BY scope,event_key"),
  })));
}

function configRepairPreflightBinding(preflight, config) {
  if (preflight.kind === "operator-waived" || preflight.configRepair?.result?.canonical !== true ||
      !isDeepStrictEqual(preflight.config, config) ||
      createHash("sha256").update(preflight.configRepair?.plan?.snapshot?.raw ?? "").digest("hex") !== config.sha256)
    reject("config repair preflight lacks its exact original native plan and canonical rehearsal result");
}

function migrationAttachValue(pathname, root, expected, kind, value) {
  const { record } = migrationLoad(pathname, root, expected);
  if (record.agentMigration.phase !== migrationArtifactPhases[kind] || record.agentMigration.artifacts[kind])
    reject("migration proof artifact cannot be replaced in this phase");
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > migrationJsonLimit) reject("migration proof exceeds artifact byte budget");
  // An unreferenced crash orphan is never evidence and cannot obstruct a later unique attempt.
  const name = `${kind}-${randomUUID()}.json`, target = join(expected.identity.stage.path, name);
  migrationWriteExclusive(target, bytes, 0o600);
  const descriptor = migrationFile(target, migrationOwner()).descriptor;
  record.agentMigration.artifacts[kind] = { name, device: descriptor.device, inode: descriptor.inode, sha256: descriptor.sha256 };
  return migrationUpdate(pathname, root, expected, record);
}

const migrationInputBatchCount = 64;
const migrationInputBatchBytes = 128 * 1024;

function migrationInputIdentity(reader) {
  return Number.isSafeInteger(reader.readerUid) && reader.readerUid > 0 &&
    Number.isSafeInteger(reader.readerGid) && reader.readerGid >= 0;
}

function migrationInputInline(reader) {
  // libuv's same-identity nonroot spawn cannot clear supplementary groups either.
  return migrationInputIdentity(reader) && process.getuid() === reader.readerUid && process.geteuid() === reader.readerUid &&
    process.getgid() === reader.readerGid && process.getegid() === reader.readerGid;
}

function migrationReadRuntimeInput(pathname, expected, output, buffer = Buffer.allocUnsafe(1024 * 1024)) {
  if (!migrationInputInline(expected)) reject("runtime input bytes must be read without root privileges");
  if (realpathSync(pathname) !== pathname) reject("runtime input symlink is outside the qualified closure");
  // A FIFO substituted after binding must reach fstat rejection without blocking open.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(pathname, flags), hash = createHash("sha256");
  try {
    const same = entry => entry.isFile() && entry.dev === expected.device && entry.ino === expected.inode &&
      entry.size === expected.size && entry.mtimeMs === expected.mtimeMs && entry.ctimeMs === expected.ctimeMs;
    if (!same(fstatSync(fd))) reject("runtime input changed before unprivileged open");
    let bytes = 0;
    while (bytes < expected.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, expected.size - bytes), null);
      if (!count) reject("runtime input changed during unprivileged read");
      bytes += count;
      hash.update(buffer.subarray(0, count));
      if (output !== undefined) {
        let offset = 0;
        while (offset < count) {
          const written = writeSync(output, buffer, offset, count - offset);
          if (!written) reject("runtime input copy made no progress");
          offset += written;
        }
      }
    }
    if (bytes !== expected.size || !same(fstatSync(fd)) || !same(lstatSync(pathname)) || realpathSync(pathname) !== pathname)
      reject("runtime input changed during unprivileged read");
    if (output !== undefined) fsyncSync(output);
    return { path: pathname, device: expected.device, inode: expected.inode, size: expected.size,
      sha256: hash.digest("hex"), readerUid: expected.readerUid, readerGid: expected.readerGid };
  } finally { closeSync(fd); }
}

function migrationReadRuntimeBatch(requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > migrationInputBatchCount ||
      Buffer.byteLength(JSON.stringify(requests)) > migrationInputBatchBytes) reject("runtime input batch exceeds request budget");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let outputIndex = 3;
  return requests.map(({ path, expected, output }) => {
    if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || !expected ||
        !migrationInputInline(expected) || ["device", "inode", "size", "mtimeMs", "ctimeMs"].some(key => !Number.isFinite(expected[key])))
      reject("runtime input batch binding is invalid");
    if (output !== undefined) {
      if (output.fd !== outputIndex++) reject("runtime input output slot is invalid");
      const entry = fstatSync(output.fd);
      if (!entry.isFile() || entry.dev !== output.device || entry.ino !== output.inode || entry.uid !== output.uid ||
          entry.gid !== output.gid || entry.nlink !== 1 || entry.size !== 0 || (entry.mode & 0o7777) !== 0o600)
        reject("runtime input output descriptor changed");
    }
    return migrationReadRuntimeInput(path, expected, output?.fd, buffer);
  });
}

function migrationRuntimeInputs(requests) {
  if (requests.length > 100_000) reject("runtime input operation exceeds entry budget");
  const groups = new Map(), results = new Array(requests.length), buffer = Buffer.allocUnsafe(1024 * 1024);
  for (const [index, request] of requests.entries()) {
    const { path, reader } = request, entry = request.entry ?? lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || !migrationInputIdentity(reader)) reject("runtime input or unprivileged reader is invalid");
    const expected = { ...reader, device: entry.dev, inode: entry.ino, size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs };
    const key = `${reader.readerUid}:${reader.readerGid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...request, entry, expected, index });
  }
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.length;) {
      const batch = [], outputs = [], wire = [];
      let requestBytes = 2;
      try {
        while (offset < group.length && batch.length < migrationInputBatchCount) {
          const item = group[offset], request = { path: item.path, expected: item.expected };
          // Reserve space for the output descriptor before opening any private destination.
          const cost = Buffer.byteLength(JSON.stringify(request)) + 256;
          if (cost + 2 > migrationInputBatchBytes) reject("runtime input binding exceeds request budget");
          if (requestBytes + cost > migrationInputBatchBytes) break;
          requestBytes += cost;
          if (item.target !== undefined) {
            const fd = openSync(item.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            outputs.push(fd);
            const entry = fstatSync(fd);
            request.output = { fd: outputs.length + 2, device: entry.dev, inode: entry.ino, uid: entry.uid, gid: entry.gid };
          }
          batch.push(item); wire.push(request); offset++;
        }
        let observed;
        if (migrationInputInline(batch[0].reader)) {
          let outputIndex = 0;
          observed = batch.map(item => migrationReadRuntimeInput(item.path, item.expected,
            item.target === undefined ? undefined : outputs[outputIndex++], buffer));
        } else {
          const input = JSON.stringify(wire);
          if (Buffer.byteLength(input) > migrationInputBatchBytes) reject("runtime input batch exceeds request budget");
          // Node startup covers the shell lock FD9; Node-opened FDs are CLOEXEC. Only these
          // write-only destinations are remapped. A mapped slot may have the same number as FD9.
          const child = spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), "migration-input-batch"], {
            uid: batch[0].reader.readerUid, gid: batch[0].reader.readerGid, env: { PATH: "/usr/bin:/bin" }, input,
            stdio: ["pipe", "pipe", "pipe", ...outputs], encoding: "utf8", timeout: 30_000, maxBuffer: migrationInputBatchBytes,
          });
          if (child.error || child.status !== 0) reject("unprivileged runtime input batch failed");
          observed = JSON.parse(child.stdout);
        }
        if (!Array.isArray(observed) || observed.length !== batch.length) reject("runtime input batch response count changed");
        for (const [index, item] of batch.entries()) {
          const result = observed[index], expected = item.expected;
          if (!result || !/^[a-f\d]{64}$/.test(result.sha256) || !isDeepStrictEqual({ ...result, sha256: null },
              { path: item.path, device: expected.device, inode: expected.inode, size: expected.size, sha256: null,
                readerUid: expected.readerUid, readerGid: expected.readerGid })) reject("runtime input batch response binding changed");
        }
        let outputIndex = 0;
        for (const [index, item] of batch.entries()) {
          const result = observed[index];
          if (item.target !== undefined) {
            fchmodSync(outputs[outputIndex++], item.entry.mode & 0o777);
            const copied = migrationHashFile(item.target);
            if (copied.sha256 !== result.sha256 || copied.size !== result.size) reject("runtime input copy readback changed");
          }
          results[item.index] = result;
        }
      } finally { for (const fd of outputs) closeSync(fd); }
    }
  }
  return results;
}

function migrationCopyInputs(inventory, release, runtimeHome, directory) {
  const stateRoot = inventory.stateRoot, config = jsonFile(inventory.config.path), paths = new Set(), requiredPaths = new Set();
  const stateOwner = lstatSync(stateRoot), reader = { readerUid: stateOwner.uid, readerGid: stateOwner.gid };
  if (reader.readerUid === 0) reject("runtime state does not have an unprivileged input owner");
  const sources = new Map(), seen = new Set(), boundReleases = new Set([release]), files = [], directories = [];
  const managedBase = "/var/lib/openclaw-team-local-artifacts", managedRoots = new Set(), runtimeRoots = new Set(), archiveInputs = new Set();
  const under = (root, pathname) => pathname === root || pathname.startsWith(root + "/");
  function pluginRoot(pathname) {
    if (typeof pathname !== "string") return;
    const managed = pathname.startsWith(managedBase + "/");
    if (!managed && !under(runtimeHome, pathname)) return;
    if (!managed) {
      const entry = lstatSync(pathname, { throwIfNoEntry: false });
      if (!entry?.isDirectory()) return;
      const manifest = lstatSync(join(pathname, "openclaw.plugin.json"), { throwIfNoEntry: false });
      if (!manifest) return; // A recorded source directory is not necessarily the installed package.
      if (!isAbsolute(pathname) || resolve(pathname) !== pathname || realpathSync(pathname) !== pathname ||
          !manifest.isFile() || manifest.isSymbolicLink()) reject("runtime plugin root is not canonical");
      for (let parent = pathname; ; parent = dirname(parent)) {
        exactDirectory(parent, reader.readerUid, "runtime plugin ancestor", { group: reader.readerGid });
        if (parent === runtimeHome) break;
      }
      runtimeRoots.add(pathname); paths.add(pathname);
      return;
    }
    if (!isAbsolute(pathname) || resolve(pathname) !== pathname || realpathSync(pathname) !== pathname)
      reject("managed plugin root is not canonical");
    const entry = lstatSync(pathname);
    if (!entry.isDirectory()) return; // File locators need a separately declared plugin root.
    if (relative(managedBase, pathname).split("/").length < 2)
      reject("managed plugin locator selects an artifact namespace rather than a package");
    for (let parent = pathname; ; parent = dirname(parent)) {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== migrationOwner() || (stat.mode & 0o022))
        reject("managed plugin ancestor is writable by another owner or is not canonical");
      if (parent === "/") break;
    }
    const manifest = lstatSync(join(pathname, "openclaw.plugin.json"));
    if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.uid !== migrationOwner() || (manifest.mode & 0o022))
      reject("managed plugin root lacks its owner-safe manifest");
    managedRoots.add(pathname); paths.add(pathname);
  }
  function installInputs(record) {
    for (const key of ["sourcePath", "installPath"]) if (record?.[key]) {
      const pathname = record[key]; paths.add(pathname); pluginRoot(pathname);
      // Discovery observes archive-origin existence even when installPath owns runtime
      // loading. Preserve the named file, never its unrelated external parent tree.
      if (key === "sourcePath" && record.source === "archive") {
        if (typeof pathname !== "string" || !isAbsolute(pathname) || resolve(pathname) !== pathname)
          reject("archive origin path is not canonical");
        if (!under(runtimeHome, pathname)) {
          if (realpathSync(dirname(pathname)) !== dirname(pathname)) reject("archive origin parent is not canonical");
          archiveInputs.add(pathname);
        }
      }
    }
  }
  let bytes = 0, entries = 0;
  const copyRoot = join(directory, "rootfs"), map = pathname => join(copyRoot, pathname.slice(1));
  mkdirSync(map(runtimeHome), { recursive: true, mode: 0o700 });
  const databases = new Set(inventory.stores.flatMap(store => store.aliases.map(alias => alias.path).concat(store.path)));
  function copy(pathname, required = false) {
    pathname = resolve(pathname);
    if (seen.has(pathname)) return;
    seen.add(pathname);
    if (!archiveInputs.has(pathname) && pathname.startsWith(dirname(release) + "/")) {
      const sha = relative(dirname(release), pathname).split("/")[0];
      if (!shaPattern.test(sha)) reject("plugin input escapes exact sealed releases");
      const root = join(dirname(release), sha);
      if (!boundReleases.has(root)) { validateRelease(root, sha, migrationOwner(), true); boundReleases.add(root); }
      safeRelative(root, realpathSync(pathname));
      return;
    }
    const managed = [...managedRoots].find(root => under(root, pathname));
    const plugin = managed ?? [...runtimeRoots].find(root => under(root, pathname)), archive = archiveInputs.has(pathname);
    if (!managed && !archive) safeRelative(runtimeHome, pathname);
    const entry = lstatSync(pathname, { throwIfNoEntry: false });
    if (!entry) { if (required) reject("required Doctor input is missing"); sources.set(pathname, null); return; }
    if (archive) {
      const runtimeOwned = entry.uid === reader.readerUid && entry.gid === reader.readerGid;
      const controllerOwned = entry.uid === migrationOwner() && entry.gid === rootGroup();
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || (!runtimeOwned && !controllerOwned) ||
          (entry.mode & 0o022)) reject("archive origin is not an owner-safe regular file");
    }
    if (plugin && entry.isSymbolicLink()) {
      const pointer = join(dirname(dirname(release)), "current"), target = readlinkSync(pathname);
      const uid = managed ? migrationOwner() : reader.readerUid;
      const gid = managed ? rootGroup() : reader.readerGid;
      if (pathname !== join(plugin, "node_modules/openclaw") || entry.uid !== uid || (!managed && entry.gid !== gid))
        reject("plugin symlink is outside the qualified SDK closure");
      const parent = lstatSync(dirname(pathname));
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o022))
        reject("plugin SDK parent is not owner-safe");
      const resolved = realpathSync(pathname), sha = basename(resolved);
      const current = target === pointer ? lstatSync(pointer) : null;
      if (dirname(resolved) !== dirname(release) || !shaPattern.test(sha) ||
          (current ? !current.isSymbolicLink() || current.uid !== migrationOwner() : target !== resolved))
        reject("plugin SDK target is not an exact sealed release binding");
      validateRelease(resolved, sha, migrationOwner(), true); boundReleases.add(resolved);
      const sealed = lstatSync(resolved), copyTarget = current ? release : resolved;
      const copied = map(pathname); mkdirSync(dirname(copied), { recursive: true, mode: 0o700 });
      // A current-pointer link follows candidate selection; a directly pinned host link
      // retains its exact SDK. Native Doctor alone owns any registered-package relink.
      symlinkSync(copyTarget, copied);
      sources.set(pathname, { path: pathname, device: entry.dev, inode: entry.ino, ...reader,
        sdkLink: { target, resolved, copyTarget,
          ...(!managed || !current ? { owner: { uid: entry.uid, gid: entry.gid } } : {}),
          ...(current ? { pointerDevice: current.dev, pointerInode: current.ino } :
            { releaseDevice: sealed.dev, releaseInode: sealed.ino, releaseUid: sealed.uid, releaseGid: sealed.gid }) } });
      return;
    }
    if (managed && (entry.uid !== migrationOwner() || (entry.mode & 0o022)))
      reject("managed plugin input is writable by another owner");
    // This qualified closure has no other runtime symlinks. Never reproduce one in root's output tree:
    // a later descendant write could otherwise escape private staging through its absolute target.
    if (entry.isSymbolicLink() || realpathSync(pathname) !== pathname)
      reject("runtime Doctor input symlinks require separate closure qualification");
    if (++entries > 100_000) reject("Doctor input closure exceeds bounded entry budget");
    if (databases.has(pathname) || ["-wal", "-shm"].some(suffix => pathname.endsWith(suffix) && databases.has(pathname.slice(0, -suffix.length)))) return;
    const target = map(pathname); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (entry.isDirectory()) {
      const names = readdirSync(pathname).sort();
      const captured = { path: pathname, device: entry.dev, inode: entry.ino, ...reader, entries: names,
        ...(plugin ? { managed: { uid: entry.uid, gid: entry.gid, mode: entry.mode & 0o7777 } } : {}) };
      directories.push(captured);
      if (inventory.configMigration || plugin) sources.set(pathname, captured);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const name of names) copy(join(pathname, name), true);
      return;
    }
    if (!entry.isFile() || /\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/.test(pathname))
      reject("Doctor input contains an unclassified database or special file");
    bytes += entry.size;
    if (bytes > 2 * 1024 ** 3 || entry.size > 256 * 1024 ** 2) reject("Doctor named input closure exceeds copy budget");
    sources.set(pathname, null); // Preserve traversal order while source reads are batched.
    files.push({ path: pathname, reader, target, entry, managed: Boolean(plugin), archive });
  }
  paths.add(inventory.config.path);
  if (inventory.configMigration) {
    for (const path of configRepairBackupPaths(inventory.config.path)) paths.add(path);
    for (const name of readdirSync(dirname(inventory.config.path)))
      if (/^openclaw\.json\.bak\.[0-9]+$/.test(name)) paths.add(join(dirname(inventory.config.path), name));
    requiredPaths.add(join(stateRoot, "config-journal-fingerprint.key"));
  }
  for (const name of [".env", "credentials", "skills", "extensions", "git", "npm", "exec-approvals.json", "exec-approvals.json.doctor-importing"])
    paths.add(join(stateRoot, name));
  // Systemd owns Gateway EnvironmentFiles; these are not runtime Doctor inputs.
  for (const provider of Object.values(config.secrets?.providers ?? {})) {
    if (provider.source !== "file") continue;
    if (typeof provider.path !== "string" || !isAbsolute(provider.path)) reject("configured secret file path requires qualification");
    requiredPaths.add(provider.path);
  }
  for (const pathname of requiredPaths) paths.add(pathname);
  let workspaces;
  if (inventory.configMigration) {
    // Enumerate with the candidate's roster policy, without importing candidate code into root's owner process.
    const child = spawnSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), "migration-workspaces", release], {
      uid: reader.readerUid, gid: reader.readerGid, cwd: runtimeHome, input: JSON.stringify(config),
      env: { HOME: runtimeHome, OPENCLAW_HOME: runtimeHome, OPENCLAW_STATE_DIR: stateRoot,
        OPENCLAW_CONFIG_PATH: inventory.config.path, OPENCLAW_BUNDLED_PLUGINS_DIR: join(release, "dist/extensions"),
        NODE_DISABLE_COMPILE_CACHE: "1", PATH: "/usr/bin:/bin" },
      timeout: 30_000, killSignal: "SIGKILL", maxBuffer: migrationJsonLimit,
    });
    if (child.error || child.status !== 0) reject("candidate native workspace enumeration failed");
    const resolved = migrationJson(child.stdout);
    if (!Array.isArray(resolved)) reject("candidate native workspace enumeration is invalid");
    workspaces = new Set(resolved);
  } else {
    // Retain the authored-workspace closure of the older 17/18/19 Doctor-CLI-qualified crossings.
    // Requiring the new private workspace export for those tuples needs separate qualification.
    workspaces = new Set([config.agents?.defaults?.workspace ?? join(stateRoot, "workspace")]);
    for (const entry of Object.values(config.agents.entries)) if (entry.workspace) workspaces.add(entry.workspace);
  }
  const agentDirs = new Set([join(stateRoot, "agents", "main", "agent")]);
  for (const entry of readdirSync(join(stateRoot, "agents"), { withFileTypes: true }))
    if (entry.isDirectory()) agentDirs.add(join(stateRoot, "agents", entry.name, "agent"));
  for (const store of inventory.stores.filter(value => value.agentId !== null)) {
    paths.add(join(stateRoot, "agents", store.agentId, "sessions"));
    agentDirs.add(join(stateRoot, "agents", store.agentId, "agent"));
  }
  for (const id of Object.keys(config.agents.entries)) agentDirs.add(join(stateRoot, "agents", id, "agent"));
  const inherited = config.agents?.defaults?.authInheritance?.agentId;
  if (inherited) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(inherited)) reject("inherited auth owner is outside the qualified agent layout");
    agentDirs.add(join(stateRoot, "agents", inherited, "agent"));
  }
  function requireAbsent(pathname) {
    // Config-only repair never runs legacy auth/catalog migrations; retain their bytes instead.
    if (!inventory.configMigration && lstatSync(pathname, { throwIfNoEntry: false })) reject("legacy Doctor input needs separate preservation qualification");
    paths.add(pathname);
  }
  const legacyAgent = join(stateRoot, "agent");
  requireAbsent(join(stateRoot, "sessions"));
  for (const directory of new Set([stateRoot, legacyAgent, ...agentDirs])) {
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory))
      reject("named agent input directory is outside the qualified symlink-free layout");
    for (const name of ["auth-profiles.json", "auth-state.json", "auth.json"]) requireAbsent(join(directory, name));
    if (existsSync(directory)) for (const name of readdirSync(directory))
      if (name.startsWith("auth-profiles.json.migrated-")) requireAbsent(join(directory, name));
  }
  for (const directory of agentDirs) {
    // Doctor reads these names, not native Codex history/thread databases, old DB backups or lock files.
    paths.add(join(directory, "models.json"));
    paths.add(join(directory, "codex-home", "config.toml"));
    const plugins = join(directory, "plugins"), pluginRoot = lstatSync(plugins, { throwIfNoEntry: false });
    if (!pluginRoot) continue;
    if (!pluginRoot.isDirectory() || pluginRoot.isSymbolicLink() || realpathSync(plugins) !== plugins)
      reject("agent catalog root is outside the qualified symlink-free layout");
    for (const plugin of readdirSync(plugins, { withFileTypes: true })) {
      if (plugin.isSymbolicLink()) reject("agent catalog directory symlink is outside the qualified closure");
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(plugins, plugin.name);
      requireAbsent(join(pluginDir, "catalog.json"));
      for (const name of readdirSync(pluginDir))
        if (name.startsWith("catalog.json.doctor-importing-")) requireAbsent(join(pluginDir, name));
    }
  }
  const shared = inventory.stores.find(store => store.agentId === null);
  migrationDatabaseRead(shared.path, release, database => {
    if (!inventory.configMigration && database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migration_sources'").get() &&
        database.prepare("SELECT 1 FROM migration_sources WHERE migration_kind='auth-profile-json-to-sqlite-v2' LIMIT 1").get())
      reject("auth migration receipts require separate input and credential preservation qualification");
    const row = database.prepare("SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'").get();
    if (row) {
      const value = JSON.parse(row.value_json), index = value?.index;
      if (!Number.isSafeInteger(value?.revision) || !index || !Array.isArray(index.plugins) ||
          !index.installRecords || typeof index.installRecords !== "object" || Array.isArray(index.installRecords))
        reject("installed plugin index cannot establish complete Doctor input closure");
      for (const record of Object.values(index.installRecords)) {
        if (!record || typeof record !== "object") reject("installed plugin record is malformed");
        installInputs(record);
      }
      for (const plugin of index.plugins) {
        pluginRoot(plugin.rootDir);
        for (const pathname of migrationPluginLocators(plugin)) paths.add(pathname);
        installInputs(plugin.installRecord);
      }
      if (index.workspaceDir) workspaces.add(index.workspaceDir);
    }
    const recalls = database.prepare("SELECT value_json FROM plugin_state_entries WHERE plugin_id='memory-core' AND namespace='short-term-recall'").all();
    for (const row of recalls) {
      const value = JSON.parse(row.value_json);
      workspaces.add(value.workspaceDir);
      for (const pathname of migrationRecallPaths(value)) paths.add(pathname);
    }
  });
  for (const pathname of config.plugins?.load?.paths ?? []) { paths.add(pathname); pluginRoot(pathname); }
  for (const pathname of config.skills?.load?.extraDirs ?? []) paths.add(pathname);
  for (let workspace of workspaces) {
    if (typeof workspace !== "string" || !isAbsolute(workspace)) reject("Doctor workspace is not an absolute named input");
    workspace = resolve(workspace);
    safeRelative(runtimeHome, workspace);
    mkdirSync(map(workspace), { recursive: true, mode: 0o700 });
    for (const name of ["TOOLS.md", "HEARTBEAT.md", "AGENTS.md", "skills", ".openclaw/extensions"]) paths.add(join(workspace, name));
    if (existsSync(workspace)) for (const name of readdirSync(workspace))
      if (/^(?:TOOLS|HEARTBEAT|AGENTS)\.md\.doctor-(?:importing|backup|writing)-/.test(name)) paths.add(join(workspace, name));
  }
  for (const pathname of [...paths].sort()) {
    if (typeof pathname !== "string" || !isAbsolute(pathname)) reject("Doctor input locator is not absolute");
    copy(pathname, requiredPaths.has(pathname));
  }
  for (const [index, result] of migrationRuntimeInputs(files).entries()) {
    const file = files[index];
    const ownership = { uid: file.entry.uid, gid: file.entry.gid, mode: file.entry.mode & 0o7777 };
    sources.set(result.path, { ...result, ...(file.managed ? { managed: ownership } : {}), ...(file.archive ? { archive: ownership } : {}) });
  }
  // All profiles recheck after deferred reads, without adding fields to historical artifacts.
  for (const captured of directories) {
    const entry = lstatSync(captured.path);
    if (!entry.isDirectory() || entry.dev !== captured.device || entry.ino !== captured.inode ||
        realpathSync(captured.path) !== captured.path || !isDeepStrictEqual(readdirSync(captured.path).sort(), captured.entries))
      reject("Doctor input directory changed during capture");
  }
  function syncCopied(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name);
      if (entry.isDirectory()) syncCopied(pathname);
      else if (entry.isFile()) syncPath(pathname);
    }
    syncPath(directory);
  }
  syncCopied(copyRoot); syncPath(directory);
  const managedInputs = [...sources].filter(([path]) => archiveInputs.has(path) || [...managedRoots, ...runtimeRoots].some(root => under(root, path)));
  migrationVerifyInputBytes(managedInputs, true);
  return { copyRoot, sources: [...sources], boundReleases: [...boundReleases].sort(), bytes, entries,
    ...(managedRoots.size ? { managedPluginRoots: [...managedRoots].sort() } : {}),
    ...(archiveInputs.size ? { externalArchiveFiles: [...archiveInputs].filter(path => sources.get(path) !== null).sort() } : {}) };
}

function migrationVerifyInputBytes(inputs, originalIdentity = false) {
  const files = [], fingerprints = [];
  for (const [target, fingerprint] of inputs) {
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (fingerprint === null) { if (entry) reject("Doctor created an unqualified named input"); continue; }
    if (fingerprint.sdkLink) {
      const sdk = fingerprint.sdkLink;
      if (!entry?.isSymbolicLink() || readlinkSync(target) !== (originalIdentity ? sdk.target : sdk.copyTarget) ||
          realpathSync(target) !== (originalIdentity ? sdk.resolved : sdk.copyTarget) ||
          (originalIdentity && (entry.dev !== fingerprint.device || entry.ino !== fingerprint.inode)))
        reject("managed plugin SDK link or target changed");
      if (originalIdentity && (sdk.owner || sdk.releaseDevice !== undefined) &&
          (entry.uid !== sdk.owner?.uid || entry.gid !== sdk.owner?.gid))
        reject("plugin SDK link ownership changed");
      if (sdk.releaseDevice !== undefined) {
        const sealed = lstatSync(sdk.resolved);
        if (!sealed.isDirectory() || sealed.isSymbolicLink() || sealed.dev !== sdk.releaseDevice ||
            sealed.ino !== sdk.releaseInode || (sealed.mode & 0o777) !== 0o555 ||
            sealed.uid !== (originalIdentity ? sdk.releaseUid : fingerprint.readerUid) ||
            sealed.gid !== (originalIdentity ? sdk.releaseGid : fingerprint.readerGid) ||
            sdk.target !== sdk.resolved || sdk.copyTarget !== sdk.resolved)
          reject("plugin SDK sealed release identity changed");
      } else if (originalIdentity && sdk.target !== sdk.copyTarget) {
        const pointer = lstatSync(sdk.target);
        if (!pointer.isSymbolicLink() || pointer.dev !== sdk.pointerDevice || pointer.ino !== sdk.pointerInode ||
            pointer.uid !== migrationOwner() || entry.uid !== (sdk.owner?.uid ?? migrationOwner()))
          reject("managed plugin SDK pointer identity changed");
      }
      continue;
    }
    const ownership = fingerprint.managed ?? fingerprint.archive;
    if (originalIdentity && ownership && (!entry || entry.uid !== ownership.uid ||
        entry.gid !== ownership.gid || (entry.mode & 0o7777) !== ownership.mode))
      reject("managed plugin ownership or permissions changed");
    if (fingerprint.link !== undefined || entry?.isSymbolicLink() || realpathSync(target) !== target)
      reject("Doctor input symlink is outside the qualified closure");
    if (fingerprint.entries !== undefined) {
      if (!entry?.isDirectory() || !Array.isArray(fingerprint.entries) ||
          fingerprint.entries.some(name => typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/")) ||
          !isDeepStrictEqual(readdirSync(target).sort(), fingerprint.entries) ||
          (originalIdentity && (entry.dev !== fingerprint.device || entry.ino !== fingerprint.inode)))
        reject("Doctor input directory membership or identity changed");
      continue;
    }
    if (entry.size !== fingerprint.size ||
        (originalIdentity && (entry.dev !== fingerprint.device || entry.ino !== fingerprint.inode)))
      reject("Doctor changed protected configuration, credentials, workspace or plugin bytes");
    const reader = { readerUid: fingerprint.readerUid, readerGid: fingerprint.readerGid };
    files.push({ path: target, reader, entry }); fingerprints.push(fingerprint);
  }
  for (const [index, current] of migrationRuntimeInputs(files).entries()) {
    const fingerprint = fingerprints[index];
    if (current.sha256 !== fingerprint.sha256 || current.size !== fingerprint.size ||
        (originalIdentity && (current.device !== fingerprint.device || current.inode !== fingerprint.inode)))
      reject("Doctor changed protected configuration, credentials, workspace or plugin bytes");
  }
}

function configRepairCopiedInputs(inputs) {
  // The namespace has the same paths but different inodes. Bind copies here, never via a child flag.
  return inputs.sources.map(([path, fingerprint]) => {
    if (fingerprint === null) return [path, null];
    const copied = join(inputs.copyRoot, path.slice(1));
    if (fingerprint.sdkLink) {
      const entry = lstatSync(copied);
      if (!entry.isSymbolicLink() || readlinkSync(copied) !== fingerprint.sdkLink.copyTarget)
        reject("copied managed plugin SDK binding changed");
      return [path, { ...fingerprint, device: entry.dev, inode: entry.ino,
        sdkLink: { ...fingerprint.sdkLink, target: fingerprint.sdkLink.copyTarget, resolved: fingerprint.sdkLink.copyTarget,
          ...(fingerprint.sdkLink.owner ? { owner: { uid: fingerprint.readerUid, gid: fingerprint.readerGid } } : {}),
          ...(fingerprint.sdkLink.releaseDevice !== undefined ? { releaseUid: fingerprint.readerUid, releaseGid: fingerprint.readerGid } : {}) } }];
    }
    if (fingerprint.entries) {
      const entry = lstatSync(copied);
      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(copied) !== copied ||
          !isDeepStrictEqual(readdirSync(copied).sort(), fingerprint.entries)) reject("copied metadata membership changed");
      return [path, { ...fingerprint, device: entry.dev, inode: entry.ino,
        ...(fingerprint.managed ? { managed: { uid: fingerprint.readerUid, gid: fingerprint.readerGid, mode: entry.mode & 0o7777 } } : {}) }];
    }
    const file = migrationHashFile(copied);
    if (file.sha256 !== fingerprint.sha256 || file.size !== fingerprint.size) reject("copied metadata bytes changed");
    return [path, { ...fingerprint, ...file, path,
      ...(fingerprint.managed ? { managed: { uid: fingerprint.readerUid, gid: fingerprint.readerGid, mode: lstatSync(copied).mode & 0o7777 } } : {}),
      ...(fingerprint.archive ? { archive: { uid: fingerprint.readerUid, gid: fingerprint.readerGid, mode: lstatSync(copied).mode & 0o7777 } } : {}) }];
  });
}

function migrationCopyCheck(manifestPath, readOnlyPlan = false) {
  const manifest = jsonFile(manifestPath), inventory = manifest.inventory, release = manifest.release;
  const profile = migrationRecordProfile({ predecessor: manifest.predecessor, candidate: manifest.candidateInfo, ...(manifest.configMigration ? { configMigration: manifest.configMigration } : {}) });
  if (manifest.candidateInfo.sha !== manifest.candidate) reject("copied-state migration candidate binding changed");
  if (process.getuid() !== manifest.runtimeUid || realpathSync(manifest.current) !== release)
    reject("copied-state Doctor did not run under its isolated identity and selected code");
  const backups = manifest.backups.map(value => ({ ...value, file: { ...value.file,
    path: join(dirname(manifestPath), relative(manifest.directory, value.file.path)) } }));
  const current = migrationInventory(inventory.config.path, manifest.databasePath, release, profile, !readOnlyPlan);
  let configResult;
  if (profile.config && !readOnlyPlan) {
    configResult = jsonFile(join(dirname(manifestPath), "config.stdout"));
    inventory.config = manifest.copyInventory.config;
    inventory.inputs = manifest.inputs.sources;
    inventory.configRepair.result = configResult;
    for (const value of inventory.configRepair.copies) if (value.copy)
      value.copy.path = join(dirname(manifestPath), relative(manifest.directory, value.copy.path));
    configRepairVerifyInputs(inventory, configResult, false);
  }
  migrationSameInventory(manifest.copyInventory, current, profile, !readOnlyPlan, configResult);
  migrationVerifyPreservation(inventory, backups, release, profile);
  if (!profile.nativeDoctor && (!profile.config || readOnlyPlan)) migrationVerifyInputBytes(manifest.inputs.sources);
  return { version: 1, ...migrationProfileBinding(profile), candidate: manifest.candidate, completeClosure: true, dataReady: true,
    ...(configResult ? { configRepair: { result: configResult, plan: jsonFile(join(dirname(manifestPath), "plan.stdout")) } } : {}),
    stores: current.stores.length, isolatedUid: process.getuid(), logicalPreservation: profile.nativeDoctor
      ? "native-doctor-with-schema-and-proposal-retention" : "all-ordinary-tables-and-exact-owner-transformations" };
}

function migrationPreflightClaim(root, record) {
  const preflight = migrationReadArtifact(root, record, "preflight");
  migrationCheckProfileBinding(preflight, migrationRecordProfile(record));
  const waived = preflight?.kind === "operator-waived";
  const offline = migrationRecordProfile(record).offline && preflight?.kind === "offline-cold-required";
  if (migrationRecordProfile(record).config) configRepairPreflightBinding(preflight, preflight.config);
  const claimValid = offline ? preflight.scope === "cold-doctor-only" : waived
    ? preflight.scope === "warm-copy-only" && !Object.hasOwn(preflight, "completeClosure") && !Object.hasOwn(preflight, "dataReady")
    : preflight?.completeClosure === true && preflight.dataReady === true;
  if (!claimValid || preflight.candidate !== record.candidate.sha || !preflight.config ||
      !Number.isSafeInteger(preflight.databaseBytes) || preflight.databaseBytes < 1)
    reject("rehearsal evidence or explicit waiver has a missing or stale candidate/config binding");
  const { size, ...configIdentity } = preflight.config;
  validMigrationDescriptor(configIdentity, "path", "rehearsal config");
  if (!Number.isSafeInteger(size) || size < 0)
    reject("rehearsal config size is invalid");
  return preflight;
}

function migrationCheckPreflight(root, record) {
  const preflight = migrationPreflightClaim(root, record);
  if (!isDeepStrictEqual(migrationHashFile(preflight.config.path), preflight.config))
    reject("rehearsal evidence or explicit waiver has a missing or stale candidate/config binding");
  const disk = statfsSync(root);
  if (!Number.isSafeInteger(preflight.databaseBytes) || preflight.databaseBytes < 1 ||
      disk.bavail * disk.bsize < preflight.databaseBytes * 2 + 2 * 1024 ** 3 + operationalReserveBytes)
    reject("cold backup and Doctor headroom is no longer available before interruption");
  return preflight.kind === "operator-waived" ? "OPERATOR_WAIVED" : "PREFLIGHT_OK";
}

function migrationRehearsalProcess(root, record) {
  const directory = join(process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc", String(record.process.pid));
  const stat = readFileSync(join(directory, "stat"), "utf8"), boundary = stat.lastIndexOf(") ");
  const fields = stat.slice(boundary + 2).trim().split(/\s+/);
  if (boundary < 0 || fields[19] !== record.process.generation || ["Z", "X", "x", "T", "t"].includes(fields[0]) ||
      realpathSync(join(directory, "cwd")) !== join(root, "releases", record.predecessor.sha))
    reject("rehearsal refresh requires the original running predecessor");
  return { pid: record.process.pid, generation: fields[19] };
}

// This reports work still required. Only the locked rehearsal owner can publish new proof.
function migrationRehearsalInputs(pathname, root, expected, rawUid) {
  const { record } = migrationLoad(pathname, root, expected), migration = record.agentMigration;
  if (!((record.phase === "AGENT_REHEARSAL" && migration.phase === "rehearsal") ||
      (record.phase === "A_PREPARED" && migration.phase === "prepared")) ||
      Object.keys(migration.artifacts).join(",") !== "preflight")
    reject("rehearsal refresh requires only the original warm preflight before cold work");
  const preflight = migrationPreflightClaim(root, record);
  const original = record.protectedPaths[0], database = record.protectedPaths[1];
  if (!isDeepStrictEqual({ path: preflight.config.path, device: preflight.config.device, inode: preflight.config.inode }, original) ||
      database.path !== join(dirname(original.path), "state", "openclaw.sqlite") ||
      realpathSync(original.path) !== original.path || !isDeepStrictEqual(identity(database.path), database))
    reject("rehearsal refresh lost its original config or database binding");
  const uid = integer(rawUid, "rehearsal runtime UID"), entry = lstatSync(original.path);
  if (![migrationOwner(), uid].includes(entry.uid)) reject("refreshed config owner is unsafe");
  const configFile = migrationFile(original.path, entry.uid, { mode: 0o600, group: entry.gid });
  const config = { ...configFile.descriptor, size: configFile.bytes.length };
  if (config.device !== original.device) reject("refreshed config moved to another filesystem");
  const permit = migrationPermit(root);
  if (migration.phase === "rehearsal" && !permit) reject("initial rehearsal lost its original start permit");
  migrationPointers(root, migrationOwner(), { current: record.predecessor.sha, previous: record.pointerTopology.previous.sha });
  const current = isDeepStrictEqual(config, preflight.config), waived = preflight.kind === "operator-waived";
  if (waived && !current) reject("a stale rehearsal waiver cannot be refreshed implicitly");
  const facts = { status: current ? "current" : "warm-config-refresh-required", waived,
    config, configOwner: { uid: entry.uid, gid: entry.gid, mode: entry.mode & 0o7777 },
    process: migrationRehearsalProcess(root, record), permit, policy: policy(original.path),
    releases: migrationSealedReleaseFacts(root, record), pointers: migrationLivePointers(root) };
  if (facts.status === "current") migrationCheckPreflight(root, record);
  if (!isDeepStrictEqual(migrationHashFile(original.path), config)) reject("config changed during rehearsal inspection");
  migrationLoad(pathname, root, expected);
  return facts;
}

function migrationWaiveRehearsal(pathname, root, expected, configPath, databasePath) {
  const { record } = migrationLoad(pathname, root, expected);
  const profile = migrationRecordProfile(record);
  if (record.agentMigration.phase !== "rehearsal") reject("warm rehearsal waiver requires an unchanged preparatory journal");
  if (profile.config) reject("same-schema config repair requires native copied-state rehearsal; schema waiver does not apply");
  migrationReleaseProof(root, record, migrationOwner());
  migrationPointers(root, migrationOwner(), { current: record.predecessor.sha, previous: record.pointerTopology.previous.sha });
  if (record.agentMigration.artifacts.preflight) {
    if (migrationCheckPreflight(root, record) !== "OPERATOR_WAIVED") reject("completed rehearsal evidence cannot be replaced by a waiver");
    return expected;
  }
  const release = join(root, "releases", record.candidate.sha), inventory = migrationInventory(configPath, databasePath, release, profile);
  const databaseBytes = migrationDatabaseBytes(inventory, release);
  // The root-only canonical CLI records explicit operator intent, not a copied-state success.
  return migrationAttachValue(pathname, root, expected, "preflight", { version: 1, ...migrationProfileBinding(profile), kind: "operator-waived", scope: "warm-copy-only",
    candidate: record.candidate.sha, config: inventory.config, databaseBytes, recordedAt: new Date().toISOString() });
}

function migrationDoctorTimeout(rawBudget) {
  const hex = /^[ \t\n\r\f\v]*\+?0x([\da-f]*)(?:\.([\da-f]*))?(?:p([+-]?\d+))?$/i.exec(rawBudget);
  let seconds = Number(rawBudget);
  if (hex && (hex[1] || hex[2])) {
    const fraction = hex[2] ?? "", digits = (hex[1] + fraction).replace(/^0+/, "");
    const significant = digits.slice(0, 15), exponent = Number(hex[3] ?? 0) + 4 * (digits.length - significant.length - fraction.length);
    // Keep guard/sticky bits for native float rounding, then scale without intermediate underflow.
    let mantissa = BigInt(`0x${significant || "0"}`);
    if (/[1-9a-f]/i.test(digits.slice(15))) mantissa |= 1n;
    seconds = Number(mantissa) * 2 ** Math.max(exponent, -1022) * 2 ** Math.min(exponent + 1022, 0);
  } else if (!/^[ \t\n\r\f\v]*\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawBudget)) {
    reject("Doctor budget must be finite positive numeric seconds");
  }
  const timeoutMs = Math.ceil(seconds * 1000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) reject("Doctor budget exceeds finite positive millisecond bounds");
  return timeoutMs;
}

async function migrationRehearse(pathname, root, expected, configPath, databasePath, runtimeHome, rawUid, rawGid, rawDoctorBudget) {
  const { record } = migrationLoad(pathname, root, expected), release = join(root, "releases", record.candidate.sha);
  const profile = migrationRecordProfile(record);
  const doctorTimeoutMs = profile.config ? undefined : migrationDoctorTimeout(rawDoctorBudget);
  let refresh;
  if (record.agentMigration.artifacts.preflight) {
    const inputs = migrationRehearsalInputs(pathname, root, expected, rawUid);
    if (inputs.status === "current") return expected;
    if (configPath !== record.protectedPaths[0].path || databasePath !== record.protectedPaths[1].path)
      reject("rehearsal refresh cannot select other inputs");
    refresh = { inputs, controller: migrationControllerBinding(process.ppid) };
  } else if (record.agentMigration.phase !== "rehearsal") {
    reject("copied-state rehearsal requires preparatory journal");
  }
  const uid = integer(rawUid, "rehearsal UID"), gid = integer(rawGid, "rehearsal GID");
  if (process.platform !== "linux" || process.getuid() !== 0 || uid === 0)
    reject("copied-state rehearsal requires the qualified Linux root namespace owner");
  const boundRecord = refresh ? { ...record, protectedPaths: [identity(configPath), record.protectedPaths[1]] } : record;
  migrationReleaseProof(root, boundRecord, migrationOwner());
  const directory = join(expected.identity.stage.path, `rehearsal-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 }); // Prior unbound attempts remain retained, never silently reused.
  let originalJournal;
  if (refresh) {
    originalJournal = migrationFile(pathname, migrationOwner(), { limit: migrationJournalLimit });
    const { stage: _stage, ...descriptor } = expected.identity;
    if (!isDeepStrictEqual(originalJournal.descriptor, descriptor)) reject("journal changed before rehearsal refresh");
    migrationWriteExclusive(join(directory, "previous-journal.json"), originalJournal.bytes, 0o600);
    migrationWriteExclusive(join(directory, "previous-preflight-binding.json"), Buffer.from(JSON.stringify({
      journal: expected.identity, preflight: record.agentMigration.artifacts.preflight,
    }) + "\n"), 0o600);
  }
  const inventory = migrationInventory(configPath, databasePath, release, profile);
  const databaseBytes = migrationDatabaseBytes(inventory, release);
  const disk = statfsSync(directory);
  if (disk.bavail * disk.bsize < databaseBytes * 4 + 2 * 1024 ** 3 + operationalReserveBytes)
    reject("insufficient space for warm copies, original cold backups and Doctor working headroom");
  const backups = [];
  for (const [index, store] of inventory.stores.entries()) backups.push(await migrationSnapshot(store, release, join(directory, "snapshots", `${index}.sqlite`)));
  const inputs = migrationCopyInputs(inventory, release, runtimeHome, directory);
  if (profile.config) {
    inventory.configRepair = configRepairCaptureInputs(inventory, inputs);
    migrationDatabaseRead(databasePath, release, database => configRepairAuditAdmission(database, inventory.config));
  }
  const map = value => join(inputs.copyRoot, value.slice(1));
  const copyInventory = structuredClone(inventory);
  for (const [index, store] of copyInventory.stores.entries()) {
    const target = map(store.path), copied = migrationRehearsalCopy(backups[index], store, release, target);
    Object.assign(store, copied, { path: store.path });
    for (const alias of store.aliases) if (alias.path !== store.path) {
      const targetAlias = map(alias.path); mkdirSync(dirname(targetAlias), { recursive: true, mode: 0o700 });
      if (!lstatSync(targetAlias, { throwIfNoEntry: false })) symlinkSync(store.path, targetAlias);
    }
  }
  copyInventory.config = { ...migrationHashFile(map(configPath)), path: configPath };
  const namespaceRoot = join(directory, "serving"); mkdirSync(join(namespaceRoot, "releases"), { recursive: true, mode: 0o700 });
  const bound = new Set([...inputs.boundReleases, join(root, "releases", record.predecessor.sha), release]);
  for (const boundRelease of bound) mkdirSync(join(namespaceRoot, "releases", boundRelease.split("/").at(-1)), { mode: 0o700 });
  symlinkSync(release, join(namespaceRoot, "current"));
  symlinkSync(join(root, "releases", record.predecessor.sha), join(namespaceRoot, "previous"));
  const manifestPath = join(directory, "copy-manifest.json");
  migrationWriteExclusive(manifestPath, Buffer.from(JSON.stringify({ inventory, backups, copyInventory, inputs, directory,
    predecessor: record.predecessor, candidateInfo: record.candidate, ...(profile.config ? { configMigration: record.configMigration } : {}),
    release, current: join(root, "current"), candidate: record.candidate.sha, databasePath, runtimeUid: uid })), 0o600);
  const environment = { HOME: runtimeHome, OPENCLAW_HOME: runtimeHome, OPENCLAW_STATE_DIR: inventory.stateRoot,
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_SUPERVISOR_MODE: "external", OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service", PATH: "/usr/bin:/bin", TMPDIR: "/tmp",
    XDG_CONFIG_HOME: join(runtimeHome, ".config"), XDG_CACHE_HOME: join(runtimeHome, ".cache"), NODE_DISABLE_COMPILE_CACHE: "1" };
  if (profile.config) environment.OPENCLAW_BUNDLED_PLUGINS_DIR = join(release, "dist/extensions");
  // Schema updates retain authored config; advertise the native non-writable-parent contract.
  else environment.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  const argv = ["--unshare-all", "--uid", String(uid), "--gid", String(gid), "--new-session", "--die-with-parent", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64"];
  for (const name of ["passwd", "group", "nsswitch.conf", "ld.so.cache"]) argv.push("--ro-bind", `/etc/${name}`, `/etc/${name}`);
  for (const pathname of ["/root", "/home", "/tmp", "/run", "/var/tmp"]) argv.push("--tmpfs", pathname);
  argv.push("--proc", "/proc", "--dev", "/dev", "--bind", map(runtimeHome), runtimeHome,
    "--ro-bind", namespaceRoot, root, "--ro-bind", directory, "/run/migration-proof",
    "--ro-bind", fileURLToPath(import.meta.url), "/run/migration-library.mjs");
  for (const boundRelease of bound) argv.push("--ro-bind", boundRelease, boundRelease);
  for (const plugin of inputs.managedPluginRoots ?? []) argv.push("--ro-bind", map(plugin), plugin);
  for (const archive of inputs.externalArchiveFiles ?? []) argv.push("--ro-bind", map(archive), archive);
  argv.push("--clearenv");
  for (const [key, value] of Object.entries(environment)) argv.push("--setenv", key, value);
  argv.push("--chdir", runtimeHome);
  function run(label, command) {
    const out = openSync(join(directory, `${label}.stdout`), "wx", 0o600), err = openSync(join(directory, `${label}.stderr`), "wx", 0o600);
    try {
      const timeoutMs = label === "doctor" ? doctorTimeoutMs : 600_000, startedAt = performance.now();
      const child = spawnSync("/usr/bin/bwrap", [...argv, ...command], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", out, err], timeout: timeoutMs, killSignal: "SIGKILL" });
      const outcome = { version: 1, phase: label, timeoutMs, elapsedMs: performance.now() - startedAt,
        status: child.status, signal: child.signal, errorCode: child.error?.code ?? null };
      // A generic refusal cannot distinguish a deadline kill from a native failure.
      // Retain only child outcome facts; argv, environment and output remain private.
      migrationWriteExclusive(join(directory, `${label}.outcome.json`), Buffer.from(JSON.stringify(outcome) + "\n"), 0o600);
      fsyncSync(out); fsyncSync(err);
      if (child.error || child.status !== 0) reject(`isolated copied-state ${label} failed; private logs retained`);
    } finally { closeSync(out); closeSync(err); }
  }
  if (profile.config) {
    migrationWriteExclusive(join(directory, "native-inputs.json"), Buffer.from(JSON.stringify({ inputs: configRepairCopiedInputs(inputs) })), 0o600);
    run("plan", ["/usr/bin/node", "--no-warnings", "/run/migration-library.mjs", "config-repair-native", release, "plan", "/run/migration-proof/native-inputs.json"]);
    run("plan-check", ["/usr/bin/node", "--no-warnings", "/run/migration-library.mjs", "migration-copy-check", "/run/migration-proof/copy-manifest.json", "plan"]);
    run("config", ["/usr/bin/node", "--no-warnings", "/run/migration-library.mjs", "config-repair-native", release, "commit", "/run/migration-proof/native-inputs.json", "/run/migration-proof/plan.stdout"]);
  } else {
    run("doctor", ["/usr/bin/node", "--no-warnings", join(release, "dist/index.js"), "doctor", "--repair", "--non-interactive", "--no-workspace-suggestions"]);
  }
  run("verify", ["/usr/bin/node", "--no-warnings", "/run/migration-library.mjs", "migration-copy-check", "/run/migration-proof/copy-manifest.json"]);
  const proof = { ...jsonFile(join(directory, "verify.stdout")), config: inventory.config,
    databaseBytes: backups.reduce((total, snapshot) => total + snapshot.file.size, 0) };
  if (!isDeepStrictEqual(migrationHashFile(configPath), inventory.config)) reject("config changed during copied-state rehearsal");
  migrationLoad(pathname, root, expected); migrationReleaseProof(root, boundRecord, migrationOwner());
  migrationPointers(root, migrationOwner(), { current: record.predecessor.sha, previous: record.pointerTopology.previous.sha });
  if (refresh) {
    const before = migrationFile(join(directory, "previous-journal.json"), migrationOwner());
    const binding = migrationJson(migrationFile(join(directory, "previous-preflight-binding.json"), migrationOwner()).bytes);
    if (!before.bytes.equals(originalJournal.bytes) ||
        !isDeepStrictEqual(binding, { journal: expected.identity, preflight: record.agentMigration.artifacts.preflight }))
      reject("original rehearsal recovery evidence changed");
    const bytes = Buffer.from(`${JSON.stringify(proof)}\n`);
    if (bytes.length > migrationJsonLimit) reject("migration proof exceeds artifact byte budget");
    const name = `preflight-${randomUUID()}.json`, target = join(expected.identity.stage.path, name);
    migrationWriteExclusive(target, bytes, 0o600);
    const descriptor = migrationFile(target, migrationOwner()).descriptor;
    const assertCurrent = () => {
      if (!isDeepStrictEqual(migrationRehearsalInputs(pathname, root, expected, rawUid), refresh.inputs) ||
          !isDeepStrictEqual(migrationControllerBinding(process.ppid), refresh.controller))
        reject("rehearsal refresh inputs or controller changed before publication");
    };
    record.protectedPaths[0] = { path: inventory.config.path, device: inventory.config.device, inode: inventory.config.inode };
    record.agentMigration.artifacts.preflight = { name, device: descriptor.device, inode: descriptor.inode, sha256: descriptor.sha256 };
    const updated = migrationUpdate(pathname, root, expected, record, assertCurrent);
    migrationCheckPreflight(root, updated.record);
    return updated;
  }
  return migrationAttachValue(pathname, root, expected, "preflight", proof);
}

function migrationWritersStopped(pathname, root, expected, procRoot, inventory) {
  const { record } = migrationLoad(pathname, root, expected);
  if (!inventory) inventory = migrationReadArtifact(root, record, "inventory");
  if (migrationPermit(root)) reject("writer proof requires revoked native start permission");
  const targets = new Set(inventory.stores.flatMap(store => [store.path, ...store.aliases.map(alias => alias.path)])
    .flatMap(pathname => [pathname, `${pathname}-wal`, `${pathname}-shm`]));
  if (record.offlineDoctor) for (const directory of new Set(inventory.stores.map(store => dirname(store.path))))
    for (const entry of offlineTree(directory)) if (!entry.directory)
      for (const path of [entry.path, `${entry.path}-wal`, `${entry.path}-shm`, `${entry.path}-journal`]) targets.add(path);
  if (inventory.configMigration) for (const path of configRepairBackupPaths(inventory.config.path)) targets.add(path);
  assertDatabaseWritersStopped(targets, procRoot);
  migrationLoad(pathname, root, expected);
  return "WRITERS_STOPPED";
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

async function migrationColdBackup(pathname, root, expected, configPath, databasePath, procRoot) {
  let { record } = migrationLoad(pathname, root, expected);
  const profile = migrationRecordProfile(record);
  if (record.agentMigration.phase !== "prepared" || record.phase !== "C_CURRENT_SELECTED") reject("cold backup requires stopped selected candidate before Doctor");
  const release = join(root, "releases", record.candidate.sha);
  const saved = record.agentMigration.artifacts.inventory ? migrationReadArtifact(root, record, "inventory") : undefined;
  if (!saved && (record.agentMigration.artifacts.witness || record.agentMigration.artifacts.backups))
    reject("cold artifacts require their original inventory; recapture is forbidden");
  let baseline = saved;
  if (!saved && profile.originalColdRequired &&
      databaseRead(databasePath, db => migrationStateContentVersion(db, db.prepare("PRAGMA user_version").get().user_version)) !== profile.from.state)
    reject(`state${profile.to.state} migration requires original state${profile.from.state} cold evidence`);
  // A normal candidate CLI can upgrade shared state before cold admission. Only
  // this stopped, unbound native edge may capture its actual target-state baseline.
  // Authority migrations must retain their original source-state receipts.
  if (!saved && profile.nativeDoctor && !profile.offline && !profile.originalColdRequired && profile.from.agent === profile.to.agent &&
      databaseRead(databasePath, db => db.prepare("PRAGMA user_version").get().user_version) === profile.to.state)
    baseline = { coldBaseline: { kind: "already-target-before-doctor", schemaVersions: profile.to } };
  const inventory = migrationInventory(configPath, databasePath, release, profile, false, baseline);
  if (inventory.coldBaseline) migrationSameInventory(inventory, inventory, profile, true);
  migrationWritersStopped(pathname, root, expected, procRoot, inventory);
  if (record.agentMigration.artifacts.backups) {
    const original = migrationReadArtifact(root, record, "inventory"), backups = migrationReadArtifact(root, record, "backups");
    migrationSameInventory(original, inventory, profile);
    migrationVerifyInputBytes(original.inputs, true);
    for (const store of inventory.stores) {
      const snapshot = backups.find(value => value.source === store.path);
      if (!snapshot || !isDeepStrictEqual(migrationHashFile(snapshot.file.path), snapshot.file) ||
          !isDeepStrictEqual(migrationDatabaseRead(store.path, release, migrationTableDigests), snapshot.tables))
        reject("pre-Doctor recovery cannot prove the original cold stores unchanged");
    }
    migrationVerifyWitness(inventory, release, migrationReadArtifact(root, record, "witness"));
    return offlinePrepareCapture(pathname, root, expected, inventory);
  }
  // Only before Doctor-started may missing evidence be captured under a stopped/source-schema proof.
  // Bound evidence is reused unchanged; unbound attempts remain retained and never become historical proof.
  let original = inventory;
  if (record.agentMigration.artifacts.inventory) {
    original = migrationReadArtifact(root, record, "inventory");
    migrationSameInventory(original, inventory, profile);
    migrationVerifyInputBytes(original.inputs, true);
  } else {
    const inputs = migrationCopyInputs(inventory, release, dirname(inventory.stateRoot), join(expected.identity.stage.path, `cold-inputs-${randomUUID()}`));
    inventory.inputs = inputs.sources;
    if (profile.config) {
      const preflight = migrationReadArtifact(root, record, "preflight");
      configRepairPreflightBinding(preflight, inventory.config);
      inventory.configRepair = { ...configRepairCaptureInputs(inventory, inputs), result: preflight.configRepair.result };
      migrationDatabaseRead(databasePath, release, database => configRepairAuditAdmission(database, inventory.config));
    }
    migrationVerifyInputBytes(inventory.inputs, true);
    expected = migrationAttachValue(pathname, root, expected, "inventory", inventory);
  }
  if (!record.agentMigration.artifacts.witness)
    expected = migrationAttachValue(pathname, root, expected, "witness", migrationCaptureWitness(original, release));
  const backups = [], directory = join(expected.identity.stage.path, `cold-backups-${randomUUID()}`);
  for (const [index, store] of original.stores.entries()) {
    migrationWritersStopped(pathname, root, expected, procRoot, original);
    backups.push(await migrationSnapshot(store, release, join(directory, `${index}.sqlite`)));
  }
  migrationSameInventory(original, migrationInventory(configPath, databasePath, release, profile, false, original), profile);
  migrationVerifyWitness(original, release, migrationReadArtifact(root, expected.record, "witness"));
  migrationWritersStopped(pathname, root, expected, procRoot, original);
  expected = migrationAttachValue(pathname, root, expected, "backups", backups);
  return offlinePrepareCapture(pathname, root, expected, original);
}

function offlinePrepareCapture(pathname, root, expected, inventory) {
  if (!expected.record.offlineDoctor || expected.record.agentMigration.artifacts.precapture) return expected;
  // Preserve an unchanged-byte recovery witness before any auxiliary SQLite open can fail.
  return migrationAttachValue(pathname, root, expected, "precapture", offlineByteCapture(inventory));
}

function offlineProbe(command, args) {
  const env = { ...process.env }; delete env.POSIXLY_CORRECT;
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, env });
  if (result.error || result.status !== 0) reject(`offline Doctor requires working ${command}`);
  return result.stdout.trim();
}

function offlineEntry(pathname) {
  const entry = lstatSync(pathname);
  // getfacl without a portable no-dereference mode would inspect the target.
  // A one-byte string preserves even link text that is not valid UTF-8.
  if (entry.isSymbolicLink()) return { path: pathname, kind: "symlink", linkText: readlinkSync(pathname, "buffer").toString("latin1"), uid: entry.uid, gid: entry.gid };
  if ((!entry.isDirectory() && !entry.isFile()) ||
      realpathSync(pathname) !== pathname || (entry.isFile() && entry.nlink !== 1))
    reject("offline Doctor store contains aliases or unsupported entries");
  return { path: pathname, device: entry.dev, inode: entry.ino, directory: entry.isDirectory(), ...(!entry.isDirectory() ? { size: entry.size } : {}),
    uid: entry.uid, gid: entry.gid, mode: entry.mode & 0o7777, acl: offlineProbe("getfacl", ["-cEpn", "--", pathname]) };
}

function offlineFilesystem(directory) {
  const type = statfsSync(directory).type;
  const flags = offlineProbe("lsattr", ["-d", "--", directory]).split(/\s+/)[0];
  if (!Number.isSafeInteger(type) || !/^[a-zA-Z-]+$/.test(flags))
    reject(`offline Doctor filesystem facts are malformed at ${JSON.stringify(directory)}`);
  return { type, flags };
}

function offlineCaptureDirectories(capture, inventory) {
  // Retained offline-doctor and migration journals can carry the original array shape.
  const legacy = Array.isArray(capture);
  if (!legacy) {
    suspensionObject(capture, ["version", "directories"], "offline Doctor capture");
    if (capture.version !== 2) reject("unsupported offline Doctor capture version");
  }
  const directories = legacy ? capture : capture.directories;
  if (!Array.isArray(directories) || directories.length === 0) reject("offline Doctor capture has no directories");
  const seen = new Set();
  for (const row of directories) {
    suspensionObject(row, legacy ? ["directory", "entries"] : ["directory", "filesystem", "entries"], "offline Doctor captured directory");
    if (typeof row.directory !== "string" || !isAbsolute(row.directory) || resolve(row.directory) !== row.directory ||
        seen.has(row.directory) || !Array.isArray(row.entries) || row.entries.length === 0)
      reject("offline Doctor captured directory is malformed");
    seen.add(row.directory);
    if (!legacy) {
      suspensionObject(row.filesystem, ["type", "flags"], "offline Doctor filesystem facts");
      if (!Number.isSafeInteger(row.filesystem.type) || typeof row.filesystem.flags !== "string" || !/^[a-zA-Z-]+$/.test(row.filesystem.flags))
        reject("offline Doctor filesystem facts are malformed");
    }
    const paths = new Set();
    for (const entry of row.entries) {
      const symlink = entry?.kind === "symlink";
      if (!entry || typeof entry.path !== "string" || resolve(entry.path) !== entry.path ||
          (entry.path !== row.directory && !entry.path.startsWith(row.directory + "/")) || paths.has(entry.path) ||
          (symlink ? typeof entry.linkText !== "string" || !entry.linkText || entry.linkText.includes("\0") ||
            !Number.isSafeInteger(entry.uid) || entry.uid < 0 || !Number.isSafeInteger(entry.gid) || entry.gid < 0 || entry.path === row.directory
            : entry.kind !== undefined || typeof entry.directory !== "boolean" || !Number.isSafeInteger(entry.device) || entry.device < 0 ||
              !Number.isSafeInteger(entry.inode) || entry.inode < 1))
        reject("offline Doctor captured entry is malformed");
      if (symlink) suspensionObject(entry, ["path", "kind", "linkText", "uid", "gid"], "offline Doctor captured symbolic link");
      paths.add(entry.path);
    }
    if (!row.entries.some(entry => entry.path === row.directory && entry.directory)) reject("offline Doctor capture lost its directory identity");
  }
  if (inventory && !isDeepStrictEqual([...seen].sort(), [...new Set(inventory.stores.map(store => dirname(store.path)))].sort()))
    reject("offline Doctor capture does not cover every inventory store directory");
  return directories;
}

function offlineSchema(database, primary, quickCheck = true) {
  if (quickCheck) {
    const rows = database.prepare("PRAGMA quick_check").all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") reject("offline Doctor SQLite quick_check failed");
  }
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all().map(row => ({ ...row }));
  if (!primary) return { schema };
  const registries = schema.filter(row => row.type === "table" && (row.name === "agent_databases" || /registry/.test(row.name)))
    .map(row => ({ name: row.name, count: database.prepare(`SELECT count(*) AS count FROM ${migrationSqlName(row.name)}`).get().count }));
  return { userVersion: database.prepare("PRAGMA user_version").get().user_version, schema,
    schemaMeta: migrationRowsDigest(database, "SELECT * FROM schema_meta ORDER BY meta_key"), registries };
}

// Doctor refreshes its own schema_meta receipts on every run (the primary row's timestamps and
// per-store maintenance markers) without touching the physical schema. Those rows are Doctor-owned
// content; the schema contract is user_version, DDL, registries, and a primary row that still
// names this store at its user_version with every marker scoped to the same store.
function offlineMaintainedMeta(pathname, release, facts, captured, store) {
  if (!store || !isDeepStrictEqual({ ...facts, schemaMeta: captured.schemaMeta }, captured)) return undefined;
  const rows = migrationDatabaseRead(pathname, release, database =>
    database.prepare("SELECT meta_key, role, schema_version, agent_id FROM schema_meta ORDER BY meta_key").all().map(row => ({ ...row })));
  const role = store.agentId === null ? "global" : "agent", primary = rows.find(row => row.meta_key === "primary");
  if (!primary || primary.role !== role || primary.schema_version !== facts.userVersion || (primary.agent_id ?? null) !== store.agentId) return undefined;
  if (rows.some(row => row.role !== role || (row.agent_id ?? null) !== store.agentId)) return undefined;
  return { kind: "doctor-maintained-meta", metaKeys: rows.map(row => row.meta_key) };
}

function offlineTree(directory) {
  const entries = [offlineEntry(directory)];
  if (!entries[0].directory) reject(`offline Doctor store directory must be a canonical directory at ${JSON.stringify(directory)}`);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.directory) for (const name of readdirSync(entry.path).sort()) entries.push(offlineEntry(join(entry.path, name)));
    if (entries.length > 100000) reject("offline Doctor directory inventory exceeds budget");
    if (entry.kind !== "symlink" && entry.device !== entries[0].device) reject("offline Doctor store crosses filesystems");
  }
  const databases = new Set(entries.filter(entry => !entry.directory && entry.kind !== "symlink" && entry.path.endsWith(".sqlite")).map(entry => entry.path));
  // SQLite may remove or recreate its coordination sidecars on a read-only WAL open.
  return entries.filter(entry => entry.kind === "symlink" || !["-wal", "-shm", "-journal"].some(suffix => entry.path.endsWith(suffix) && databases.has(entry.path.slice(0, -suffix.length))))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function offlineCapture(inventory, release, { live = false } = {}) {
  const primary = new Set(inventory.stores.map(store => store.path));
  return { version: 2, directories: [...new Set(inventory.stores.map(store => dirname(store.path)))].sort().map(directory => {
    const entries = offlineTree(directory);
    const filesystem = offlineFilesystem(directory);
    for (const entry of entries) if (!entry.directory && entry.kind !== "symlink" && (primary.has(entry.path) || entry.path.endsWith(".sqlite"))) {
      entry.sqliteRole = primary.has(entry.path) ? "primary" : "auxiliary";
      try {
        // The stopped capture owns integrity proof; live primary scans cannot be reused.
        entry.schema = migrationDatabaseRead(entry.path, release, database => offlineSchema(database, primary.has(entry.path), !(live && primary.has(entry.path))));
      } catch (error) {
        const busy = [5, 6].includes(error.errcode & 0xff) || /\bSQLITE_(?:BUSY|LOCKED)(?:_\w+)?\b|\bdatabase (?:table |schema )?is locked\b/i.test(`${error.code ?? ""} ${error.message}`);
        if (!live || entry.sqliteRole !== "auxiliary" || !busy) throw error;
        entry.liveState = "busy";
      }
    }
    return { directory, filesystem, entries };
  }) };
}

function offlineByteCapture(inventory, legacy = false) {
  const directories = [...new Set(inventory.stores.map(store => dirname(store.path)))].sort().map(directory => ({ directory,
    ...(legacy ? {} : { filesystem: offlineFilesystem(directory) }),
    entries: offlineTree(directory).map(entry => {
      if (entry.directory || entry.kind === "symlink") return entry;
      const sidecars = {};
      for (const suffix of ["-wal", "-journal"]) {
        const path = entry.path + suffix;
        const sidecar = entry.path.endsWith(".sqlite") ? lstatSync(path, { throwIfNoEntry: false }) : undefined;
        if (sidecar?.isFile() && sidecar.size)
          sidecars[suffix] = migrationHashFile(path);
      }
      return { ...entry, sha256: migrationHashFile(entry.path).sha256, sidecars };
    }) }));
  return legacy ? directories : { version: 2, directories };
}

function offlinePreDoctorBinding(root, record) {
  if (record.agentMigration.artifacts.doctor) reject("pre-Doctor recovery cannot follow Doctor intent");
  const inventory = migrationReadArtifact(root, record, "inventory");
  const capture = migrationReadArtifact(root, record, "precapture");
  offlineCaptureDirectories(capture, inventory);
  if (!isDeepStrictEqual(offlineByteCapture(inventory, Array.isArray(capture)), capture))
    reject("pre-Doctor store bytes, identities or metadata changed");
  return { version: 1, directories: [], databases: inventory.stores.map(store => ({ path: store.path,
    old: { device: store.device, inode: store.inode }, new: { device: store.device, inode: store.inode },
    recovery: "unchanged-before-doctor" })) };
}

function offlineCleanReport(text) {
  // Non-interactive Doctor notes may carry ANSI color and a boxed, wrapped body.
  return text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map(line => line.replace(/^\s*[│|]\s?/, "").replace(/\s*[│|]\s*$/, "").trim()).join("\n");
}

function offlineAttemptReport(text, directories) {
  const clean = offlineCleanReport(text);
  const receipts = [];
  const wrappedPath = value => [...value].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\n*") + "\\n*";
  const suffix = "([A-Za-z0-9](?:\\n*[A-Za-z0-9])*\\n*)";
  // Match the known directory through arbitrary soft path wraps. This avoids
  // mistaking a dot at a wrap boundary for the receipt's final punctuation.
  for (const directory of directories) {
    const path = wrappedPath(directory);
    const expression = new RegExp(String.raw`Rewrote\s+SQLite\s+store\s+directory\s+with\s+NOCOW:\s*${path}\.\s+Original\s+retained\s+at\s+${path}${wrappedPath(".nocow-backup-")}${suffix};\s+verified\s+WAL-aware\s+snapshots\s+at\s+${path}${wrappedPath(".nocow-snapshots-")}${suffix}\.(?=\s*(?:\n|$))`, "g");
    for (const match of clean.matchAll(expression)) receipts.push({ directory,
      backup: `${directory}.nocow-backup-${match[1].replace(/\n/g, "")}`,
      snapshotRoot: `${directory}.nocow-snapshots-${match[2].replace(/\n/g, "")}`, line: match[0] });
  }
  if ((clean.match(/Rewrote\s+SQLite\s+store\s+directory\s+with\s+NOCOW:/g) ?? []).length !== receipts.length)
    reject("offline Doctor report has an unparseable NOCOW receipt");
  return { receipts, refusals: [...clean.matchAll(/data-at-risk|incomplete-migration|needs\s+inspection|NOCOW\s+repair\s+refused|NOCOW\s+staging\s+cleanup\s+failed|SQLite\s+NOCOW\s+repair\s+skipped|NOCOW\s+check\s+skipped/gi)].map(match => match[0]) };
}

function offlineReport(report, directories) {
  if (!Array.isArray(report) || !report.length) reject("offline Doctor log lacks a bound attempt marker; legacy logs cannot be guessed");
  const attempts = report.map(attempt => ({ ...attempt, ...offlineAttemptReport(attempt.text, directories) }));
  return {
    receipts: attempts.flatMap(attempt => attempt.receipts.map(receipt => ({ ...receipt, attempt: attempt.index,
      installed: attempt.directories?.find(entry => entry.path === receipt.directory) }))),
    refused: attempts.at(-1).refusals.length > 0,
    latest: attempts.at(-1),
    priorRefusals: attempts.slice(0, -1).filter(attempt => attempt.refusals.length).map(attempt => ({
      index: attempt.index, startedAt: attempt.startedAt, messages: attempt.refusals,
    })),
  };
}

function offlineInterruptedAttempt(attempt) {
  return attempt.exit === 124 || (attempt.exit === null &&
    /Doctor\s+interrupted\s+by\s+SIGTERM;\s+cancelling\s+inspections\s+and\s+settling\s+admitted\s+repairs\s+before\s+exit/.test(offlineCleanReport(attempt.text)));
}

function offlineNocowSiblings(directory) {
  const siblings = readdirSync(dirname(directory)).sort();
  return Object.fromEntries([["backup", ".nocow-backup-"], ["snapshotRoot", ".nocow-snapshots-"]].map(([key, suffix]) =>
    [key, siblings.filter(name => name.startsWith(basename(directory) + suffix)).map(name => join(dirname(directory), name))]));
}

function offlinePartialRefusals(parsed, directories) {
  const clean = offlineCleanReport(parsed.latest.text), refusals = new Map();
  const wrappedPath = value => [...value].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\n*") + "\\n*";
  const reason = String.raw`(?:store\s+files\s+are\s+open\s+\(pids:\s*[1-9][0-9]*(?:,\s*[1-9][0-9]*)*\);\s+stop\s+processes\s+using\s+this\s+store\s+before\s+retrying\.|fuser\s+could\s+not\s+establish\s+that\s+all\s+handles\s+are\s+closed:\s+spawnSync\s+fuser\s+E2BIG;\s+ensure\s+fuser\s+is\s+installed\s+and\s+can\s+inspect\s+processes\s+using\s+this\s+store\.)\s+Original\s+store\s+remains\s+in\s+place\.`;
  for (const directory of directories) {
    const expression = new RegExp(String.raw`^SQLite\s+NOCOW\s+repair\s+refused\s+for\s+${wrappedPath(directory)}:\s*(?:Error:\s*)?${reason}(?=\s*(?:\n|$))`, "gm");
    for (const match of clean.matchAll(expression)) {
      if (refusals.has(directory)) reject("partial NOCOW recovery found a duplicate directory refusal");
      refusals.set(directory, match[0]);
    }
  }
  if ((!offlineInterruptedAttempt(parsed.latest) && !refusals.size) || parsed.latest.refusals.length !== refusals.size ||
      parsed.latest.refusals.some(message => message.replace(/\s+/g, " ") !== "NOCOW repair refused") ||
      (!offlineInterruptedAttempt(parsed.latest) && !/Doctor\s+complete\./.test(clean)))
    reject("partial NOCOW recovery requires only qualified NOCOW refusals and a completed Doctor log");
  return refusals;
}

function offlineVerify(capture, report, release, profile, inventory, partialNocowAccepted) {
  capture = offlineCaptureDirectories(capture, inventory);
  const parsed = offlineReport(report, capture.map(value => value.directory)), used = new Set(), directories = [], databases = [];
  const crossing = profile && !profile.offline;
  const interruptedAttempt = partialNocowAccepted && offlineInterruptedAttempt(parsed.latest);
  const refusals = partialNocowAccepted ? offlinePartialRefusals(parsed, capture.map(value => value.directory)) : new Map();
  if (partialNocowAccepted && !interruptedAttempt && profile.kind === "state-19-20" &&
      !/Recorded\s+cron\s+completion\s+delivery\s+attempt\s+uncertainty\s+\(v20\)/.test(offlineCleanReport(parsed.latest.text)))
    reject("partial NOCOW recovery lacks the completed state20 migration log");
  if (parsed.refused && !partialNocowAccepted) reject("offline Doctor refused or needs inspection; retained directories must not be exchanged back");
  for (const before of capture) {
    const original = before.entries.find(entry => entry.path === before.directory);
    const current = offlineTree(before.directory), installed = current.find(entry => entry.path === before.directory);
    const receipts = parsed.receipts.filter(receipt => receipt.directory === before.directory);
    if (receipts.length > 1) reject("offline Doctor report has duplicate directory receipts");
    const receipt = receipts[0], changed = installed.device !== original.device || installed.inode !== original.inode;
    const refusal = refusals.get(before.directory);
    const siblings = offlineNocowSiblings(before.directory);
    const retainedStaging = [...siblings.backup, ...siblings.snapshotRoot].sort();
    const interrupted = !changed && retainedStaging.length > 0;
    let inferredReceipt;
    if (changed && !receipt) {
      for (const [key, paths] of Object.entries(siblings)) if (paths.length !== 1)
        reject(`unreceipted NOCOW exchange at ${JSON.stringify(before.directory)} requires exactly one ${key === "backup" ? "retained backup" : "snapshots"} sibling (found ${paths.length})`);
      inferredReceipt = { backup: siblings.backup[0], snapshotRoot: siblings.snapshotRoot[0] };
      if (!isDeepStrictEqual(parsed.latest.directories?.find(entry => entry.path === before.directory),
        { path: before.directory, device: installed.device, inode: installed.inode }))
        reject("unreceipted NOCOW directory identity changed since its recorded attempt");
    }
    const exchange = receipt ?? inferredReceipt;
    let filesystem;
    try { filesystem = offlineFilesystem(before.directory); }
    catch { reject(`NOCOW rewrite did not happen at ${JSON.stringify(before.directory)}: filesystem attributes could not be verified`); }
    if (refusal && (changed || receipt || filesystem.type !== 0x9123683e || filesystem.flags.includes("C") ||
        !isDeepStrictEqual(filesystem, before.filesystem)))
      reject("refused NOCOW directory changed identity or filesystem attributes");
    const unchangedPartial = partialNocowAccepted && !changed && (refusal || interruptedAttempt);
    if (unchangedPartial && !isDeepStrictEqual(filesystem, before.filesystem))
      reject("partial NOCOW directory changed filesystem attributes");
    if (interrupted && !partialNocowAccepted)
      reject(`interrupted NOCOW directory at ${JSON.stringify(before.directory)} requires explicit partial recovery`);
    if (!unchangedPartial && (filesystem.type !== 0x9123683e || !filesystem.flags.includes("C")))
      reject(`NOCOW rewrite did not happen at ${JSON.stringify(before.directory)}: every store directory must be on btrfs with attribute C`);
    if (!unchangedPartial && (!before.filesystem || before.filesystem.type !== 0x9123683e || !before.filesystem.flags.includes("C")) && !(changed && exchange))
      reject(`NOCOW rewrite did not happen at ${JSON.stringify(before.directory)}: no preexisting NOCOW proof and no receipt-verified replacement`);
    if (exchange) {
      if (receipt && !isDeepStrictEqual(receipt.installed, { path: before.directory, device: installed.device, inode: installed.inode }))
        reject("Doctor receipt directory identity changed since its recorded attempt");
      if (!changed || !exchange.backup.startsWith(`${before.directory}.nocow-backup-`) ||
          !exchange.snapshotRoot.startsWith(`${before.directory}.nocow-snapshots-`) ||
          [exchange.backup, exchange.snapshotRoot].some(path => resolve(path) !== path || dirname(path) !== dirname(before.directory)))
        reject("offline Doctor receipt has unqualified retained directory paths");
      const retained = offlineEntry(exchange.backup), snapshots = offlineEntry(exchange.snapshotRoot);
      if (!retained.directory || retained.device !== original.device || retained.inode !== original.inode)
        reject("retained original directory does not carry its pre-Doctor inode");
      if (!snapshots.directory || snapshots.device !== original.device) reject("Doctor snapshot directory is absent or crosses filesystems");
      if (receipt) used.add(receipt);
    }
    const oldPaths = new Set(before.entries.map(entry => entry.path));
    // Doctor saves a pre-migration copy of each primary store beside it before migrating; that
    // single, owner-identical backup is the only membership growth a Doctor run may leave behind.
    const primaries = before.entries.filter(entry => entry.sqliteRole === "primary");
    const doctorBackups = [];
    for (const entry of current.filter(entry => !oldPaths.has(entry.path))) {
      const source = primaries.find(primary => dirname(primary.path) === before.directory &&
        new RegExp(`^${primary.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.pre-startup-migration-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.bak$`).test(entry.path));
      if (!source || entry.directory || entry.size === undefined || entry.uid !== source.uid || entry.gid !== source.gid || entry.mode !== source.mode || !isDeepStrictEqual(entry.acl, source.acl))
        reject(`offline Doctor directory membership changed at ${JSON.stringify(entry.path)} (key: membership)`);
      doctorBackups.push({ path: entry.path, source: source.path, size: entry.size, device: entry.device, inode: entry.inode });
    }
    for (const old of before.entries) {
      const next = current.find(entry => entry.path === old.path);
      const symlink = old.kind === "symlink" || next?.kind === "symlink";
      const changedKey = next ? (symlink ? ["kind", "linkText", "uid", "gid"] : ["device", "directory", "uid", "gid", "mode", "acl"])
        .find(key => !isDeepStrictEqual(next[key], old[key])) : "membership";
      // Quote the inventory path and name only the key, never ACL or database contents.
      if (changedKey) reject(`offline Doctor changed ${symlink ? "symbolic link" : "ownership, mode, ACL, filesystem or membership"} at ${JSON.stringify(old.path)} (key: ${changedKey})`);
      if (!exchange && next.inode !== old.inode) reject("changed file inode lacks a Doctor NOCOW receipt");
      let retainedCheck;
      if (exchange) {
        const retainedPath = join(exchange.backup, relative(before.directory, old.path));
        const retained = lstatSync(retainedPath, { throwIfNoEntry: false }) ? offlineEntry(retainedPath) : undefined;
        const retainedLink = old.kind === "symlink" || retained?.kind === "symlink";
        // Doctor clean-closes each SQLite store (checkpointing its WAL into the main file) before
        // copying, so a database's byte size legitimately moves; identity, ownership, schema and
        // integrity of the retained original are the facts that must still hold.
        const retainedDatabase = !retainedLink && old.schema !== undefined;
        const retainedKey = retained ? (retainedLink ? ["kind", "linkText", "uid", "gid"] :
          ["device", "inode", "directory", "uid", "gid", "mode", "acl", ...(old.size === undefined || retainedDatabase ? [] : ["size"])])
          .find(key => !isDeepStrictEqual(retained[key], old[key])) : "membership";
        if (retainedKey) reject(`retained original ${retainedLink ? "symbolic link" : "entry"} lost its pre-Doctor identity or metadata at ${JSON.stringify(retainedPath)} (key: ${retainedKey})`);
        // The exchanged copy is taken from the retained original after Doctor finished with it, so the
        // retained database must still carry exactly the facts the copy carries (verified below).
        if (retainedDatabase && retained.size !== old.size) retainedCheck = retainedPath;
      }
      if (old.schema) {
        const primary = old.sqliteRole !== "auxiliary";
        const schema = migrationDatabaseRead(next.path, release, database => {
          const facts = offlineSchema(database, primary);
          if (crossing && primary) {
            const store = inventory.stores.find(store => store.path === old.path);
            if (!store) reject("NOCOW primary store lost its original owner");
            migrationSchema(database, store.agentId, [store.agentId === null ? profile.to.state : profile.to.agent]);
            migrationIntegrity(database);
            if (!isDeepStrictEqual(facts.registries, old.schema.registries)) reject("migration NOCOW registry presence or counts changed");
          }
          return facts;
        });
        const maintained = crossing && primary || isDeepStrictEqual(schema, old.schema) ? undefined
          : offlineMaintainedMeta(next.path, release, schema, old.schema, inventory.stores.find(store => store.path === old.path));
        if (!(crossing && primary) && !isDeepStrictEqual(schema, old.schema) && !maintained)
          reject("offline Doctor changed schema_meta, user_version, physical schema or registry counts");
        if (retainedCheck) {
          const retainedSchema = migrationDatabaseRead(retainedCheck, release, database => offlineSchema(database, primary));
          if (!isDeepStrictEqual(retainedSchema, schema))
            reject(`retained original database diverged from its exchanged copy at ${JSON.stringify(retainedCheck)} after Doctor's checkpoint`);
        }
        databases.push({ path: old.path, old: { device: old.device, inode: old.inode }, new: { device: next.device, inode: next.inode }, quickCheck: "ok",
          schema: crossing && primary ? { kind: "declared-target", versions: profile.to, facts: schema } : maintained ?? "identical", metadata: "identical" });
      } else if (!old.directory && old.size !== undefined && next.size !== old.size) {
        reject(`offline Doctor changed file size at ${JSON.stringify(old.path)} (key: size)`);
      }
    }
    directories.push({ path: before.directory, old: { device: original.device, inode: original.inode },
      new: { device: installed.device, inode: installed.inode },
      ...(exchange ? { ...(receipt ? { receipt } : { inferredReceipt }), retainedOriginal: "verified" } : {}),
      nocow: interrupted ? "interrupted" : refusal ? "refused" : receipt ? "rewritten" : inferredReceipt ? "rewritten-unreceipted" : "preexisting",
      ...(interruptedAttempt && !changed && !refusal ? { nocowApplied: filesystem.type === 0x9123683e && filesystem.flags.includes("C") } : {}),
      ...(interrupted ? { retainedStaging } : {}), ...(refusal ? { refusal } : {}),
      ...(doctorBackups.length ? { doctorBackups } : {}), metadata: "identical" });
  }
  if (used.size !== parsed.receipts.length) reject("Doctor receipt names a directory outside the pre-Doctor inventory");
  const binding = { version: 2, directories, databases, priorRefusals: parsed.priorRefusals,
    ...(partialNocowAccepted ? { partialNocowAccepted, nocow: "partial" } : {}) };
  offlineAssertNocowBinding(binding, inventory);
  if (crossing) {
    const current = migrationInventory(inventory.config.path, inventory.stores.find(store => store.agentId === null).path, release, profile, true);
    migrationSameInventory(offlineReboundInventory(inventory, binding), current, profile, true);
  }
  return binding;
}

function offlineAssertNocowBinding(binding, inventory) {
  if (binding?.version !== 2 || !Array.isArray(binding.directories)) reject("offline Doctor binding lacks NOCOW outcomes");
  const expected = [...new Set(inventory.stores.map(store => dirname(store.path)))].sort();
  if (!isDeepStrictEqual(binding.directories.map(entry => entry.path).sort(), expected) ||
      binding.directories.some(entry => !["rewritten", "rewritten-unreceipted", "preexisting", ...(binding.partialNocowAccepted ? ["refused", "interrupted"] : [])].includes(entry.nocow) ||
        (entry.nocow === "refused" && (entry.receipt || !entry.refusal || !isDeepStrictEqual(entry.old, entry.new))) ||
        (entry.nocow === "rewritten" && (!entry.receipt || entry.retainedOriginal !== "verified")) ||
        (entry.nocow === "rewritten-unreceipted" && (entry.receipt || !entry.inferredReceipt?.backup || !entry.inferredReceipt?.snapshotRoot || entry.retainedOriginal !== "verified")) ||
        (entry.nocow === "interrupted" && (!entry.retainedStaging?.length || entry.receipt || entry.inferredReceipt || !isDeepStrictEqual(entry.old, entry.new))) ||
        (entry.nocow === "preexisting" && (entry.receipt || entry.inferredReceipt || !isDeepStrictEqual(entry.old, entry.new)))))
    reject("offline Doctor binding must attest NOCOW for every inventory store directory");
  if (binding.partialNocowAccepted && (binding.nocow !== "partial" ||
      binding.partialNocowAccepted.flag !== "--accept-partial-nocow" ||
      !Number.isFinite(Date.parse(binding.partialNocowAccepted.at)) ||
      !Number.isSafeInteger(binding.partialNocowAccepted.operator?.uid)))
    reject("partial NOCOW binding lacks explicit operator acceptance");
}

function offlineBoundArtifact(root, record) {
  const binding = migrationReadArtifact(root, record, "rebinding");
  // Old complete receipt bindings remain usable, but omitted directories never attest NOCOW.
  if (binding.version === 1 && Array.isArray(binding.directories) && binding.directories.length)
    return { ...binding, version: 2, directories: binding.directories.map(entry => ({ ...entry, nocow: entry.nocow === true ? "rewritten" : entry.nocow })) };
  return binding;
}

function offlineRequireFence(pathname, root, expected, procRoot) {
  const { record } = migrationLoad(pathname, root, expected);
  if (!migrationRecordProfile(record).nocow || record.agentMigration.phase !== "doctor-started" || migrationPermit(root))
    reject("offline Doctor requires its stopped, revoked-permit fence");
  migrationPointers(root, migrationOwner(), { current: record.candidate.sha, previous: record.predecessor.sha });
  migrationWritersStopped(pathname, root, expected, procRoot);
  const inventory = migrationReadArtifact(root, record, "inventory");
  if (!isDeepStrictEqual(migrationHashFile(inventory.config.path), inventory.config)) reject("offline Doctor changed protected configuration");
  return record;
}

function offlinePreflight(pathname, root, expected, configPath, databasePath) {
  const { record } = migrationLoad(pathname, root, expected);
  const profile = migrationRecordProfile(record);
  if (!profile.nocow || record.agentMigration.phase !== "rehearsal") reject("offline preflight requires explicit intent");
  if (profile.offline && record.agentMigration.artifacts.preflight) { migrationCheckPreflight(root, record); return expected; }
  migrationReleaseProof(root, record, migrationOwner());
  const release = join(root, "releases", record.candidate.sha);
  const inventory = migrationInventory(configPath, databasePath, release, profile);
  offlineCapture(inventory, release, { live: true });
  // A crossing still needs its independent copied migration rehearsal.
  if (!profile.offline) return expected;
  return migrationAttachValue(pathname, root, expected, "preflight", { version: 1, ...migrationProfileBinding(profile),
    kind: "offline-cold-required", scope: "cold-doctor-only", candidate: record.candidate.sha, config: inventory.config,
    databaseBytes: migrationDatabaseBytes(inventory, release) });
}

function offlineSaveDoctor(pathname, root, expected, doctor) {
  const { record } = migrationLoad(pathname, root, expected);
  if (record.agentMigration.phase !== "doctor-started" || record.agentMigration.artifacts.rebinding)
    reject("Doctor attempt evidence cannot change after verification");
  // Publish a new hash-bound snapshot; every preceding intent/outcome artifact survives.
  const name = `doctor-${randomUUID()}.json`, target = join(expected.identity.stage.path, name);
  const bytes = Buffer.from(`${JSON.stringify(doctor)}\n`);
  if (bytes.length > migrationJsonLimit) reject("Doctor attempt evidence exceeds artifact byte budget");
  migrationWriteExclusive(target, bytes, 0o600);
  const { device, inode, sha256 } = migrationFile(target, migrationOwner()).descriptor;
  record.agentMigration.artifacts.doctor = { name, device, inode, sha256 };
  return migrationUpdate(pathname, root, expected, record);
}

const offlineAttemptPrefix = "OPENCLAW_TEAM_DOCTOR_ATTEMPT ";
const offlineHash = bytes => createHash("sha256").update(bytes).digest("hex");
const offlineAttemptMarker = attempt => `\n${offlineAttemptPrefix}${JSON.stringify({
  identity: attempt.identity, index: attempt.index, startedAt: attempt.startedAt,
})}\n`;

function offlineDoctorLogs(root, record, doctor) {
  const { log, logs } = doctor;
  if (dirname(log) !== migrationStage(root, record, migrationOwner()).path) reject("Doctor log escaped bound stage");
  if (!Array.isArray(logs) || logs.length !== 2) reject("Doctor intent lost its durable log identities");
  return [".stdout", ".stderr"].map((suffix, index) => {
    if (!isDeepStrictEqual(identity(log + suffix), logs[index])) reject("Doctor log identity changed");
    const file = migrationFile(log + suffix, migrationOwner(), { limit: migrationJsonLimit });
    syncPath(log + suffix);
    return file.bytes;
  });
}

function offlineReadReport(root, record, preparing = false) {
  const doctor = migrationReadArtifact(root, record, "doctor");
  if (doctor.version !== 2 || !Array.isArray(doctor.attempts) || !doctor.attempts.length)
    reject("offline Doctor log lacks a bound attempt marker; legacy logs cannot be guessed");
  const buffers = offlineDoctorLogs(root, record, doctor);
  const stage = migrationStage(root, record, migrationOwner());
  return doctor.attempts.map((attempt, index) => {
    if (attempt.index !== index + 1 || !isDeepStrictEqual(attempt.identity?.stage, stage) ||
        !/^[a-f0-9]{64}$/.test(attempt.identity?.sha256) || !Number.isFinite(Date.parse(attempt.startedAt)) ||
        !Array.isArray(attempt.logs) || attempt.logs.length !== 2 ||
        (index < doctor.attempts.length - 1 && !attempt.finishedAt))
      reject("Doctor attempt marker binding is malformed");
    const pending = attempt.markerState === "preparing";
    if (!["preparing", "ready"].includes(attempt.markerState) ||
        (pending && (!preparing || index !== doctor.attempts.length - 1 || attempt.finishedAt)))
      reject("Doctor attempt marker publication is incomplete; resume explicit recovery intent");
    const marker = Buffer.from(offlineAttemptMarker(attempt));
    const text = buffers.map((bytes, stream) => {
      const bound = attempt.logs[stream], previous = doctor.attempts[index - 1]?.logs[stream];
      const next = doctor.attempts[index + 1]?.logs[stream];
      const end = attempt.finishedAt ? bound.end : bytes.length;
      if (pending) {
        if (!Number.isSafeInteger(bound.offset) || bound.offset !== (previous?.end ?? 0) ||
            bytes.length < bound.offset || bytes.length > bound.offset + marker.length ||
            offlineHash(bytes.subarray(0, bound.offset)) !== bound.prefixSha256 ||
            !bytes.subarray(bound.offset).equals(marker.subarray(0, bytes.length - bound.offset)))
          reject("Doctor preparing attempt marker or historical log bytes changed");
        return "";
      }
      if (!Number.isSafeInteger(bound.offset) || bound.offset !== (previous?.end ?? 0) ||
          !Number.isSafeInteger(end) || end < bound.offset + marker.length || end > bytes.length ||
          (next ? end !== next.offset : end !== bytes.length) ||
          !bytes.subarray(bound.offset, bound.offset + marker.length).equals(marker))
        reject("Doctor attempt marker is missing or changed");
      if (offlineHash(bytes.subarray(0, bound.offset)) !== bound.prefixSha256 ||
          (attempt.finishedAt && offlineHash(bytes.subarray(0, end)) !== bound.sha256))
        reject("Doctor attempt log hash changed; historical evidence must remain intact");
      const body = bytes.subarray(bound.offset + marker.length, end).toString("utf8");
      if (body.includes(offlineAttemptPrefix)) reject("Doctor log contains an unbound attempt marker");
      return body;
    }).join("\n");
    return { index: attempt.index, startedAt: attempt.startedAt, exit: attempt.exit, directories: attempt.directories, text };
  });
}

function offlineFinishAttempt(pathname, root, expected, exitCode) {
  const { record } = migrationLoad(pathname, root, expected);
  offlineReadReport(root, record);
  const doctor = migrationReadArtifact(root, record, "doctor"), attempt = doctor.attempts.at(-1);
  if (attempt.finishedAt) {
    if (exitCode !== null && attempt.exit !== exitCode) reject("Doctor attempt exit changed");
    return expected;
  }
  const buffers = offlineDoctorLogs(root, record, doctor);
  attempt.logs = attempt.logs.map((bound, index) => ({ ...bound, end: buffers[index].length, sha256: offlineHash(buffers[index]) }));
  attempt.exit = exitCode; attempt.finishedAt = new Date().toISOString();
  const inventory = migrationReadArtifact(root, record, "inventory");
  attempt.directories = [...new Set(inventory.stores.map(store => dirname(store.path)))].map(path => {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) reject("Doctor outcome directory is unsafe");
    return { path, device: entry.dev, inode: entry.ino };
  });
  return offlineSaveDoctor(pathname, root, expected, doctor);
}

function offlinePublishAttempt(pathname, root, expected) {
  const { record } = migrationLoad(pathname, root, expected);
  const doctor = migrationReadArtifact(root, record, "doctor"), attempt = doctor.attempts?.at(-1);
  if (attempt?.markerState !== "preparing") return expected;
  offlineReadReport(root, record, true);
  const buffers = offlineDoctorLogs(root, record, doctor), marker = Buffer.from(offlineAttemptMarker(attempt));
  for (const [index, entry] of doctor.logs.entries()) {
    const fd = openSync(entry.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { writeFileSync(fd, marker.subarray(buffers[index].length - attempt.logs[index].offset)); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  attempt.markerState = "ready";
  return offlineSaveDoctor(pathname, root, expected, doctor);
}

function offlineDoctorIntent(pathname, root, expected, log, procRoot) {
  let record = offlineRequireFence(pathname, root, expected, procRoot), doctor;
  if (record.agentMigration.artifacts.rebinding) reject("Doctor attempt cannot restart after identity verification");
  if (record.agentMigration.artifacts.doctor) {
    doctor = migrationReadArtifact(root, record, "doctor");
    // A preparing attempt has never dispatched Doctor. Complete only its exact bound marker bytes.
    if (doctor.attempts?.at(-1)?.markerState === "preparing") return offlinePublishAttempt(pathname, root, expected);
    if (migrationRecordProfile(record).offline) reject("offline Doctor already attempted; explicit predecessor recovery required");
    // Validate and freeze the previous attempt before appending anything, including after interruption.
    expected = offlineFinishAttempt(pathname, root, expected, null);
    record = migrationLoad(pathname, root, expected).record;
    doctor = migrationReadArtifact(root, record, "doctor");
  } else {
    if (!record.agentMigration.artifacts.nocow || record.agentMigration.artifacts.failure ||
        dirname(log) !== expected.identity.stage.path || !/^doctor-[0-9TZ-]+$/.test(basename(log)))
      reject("offline Doctor already attempted or log is not in its bound stage");
    for (const suffix of [".stdout", ".stderr"]) if (existsSync(log + suffix)) reject("offline Doctor log already exists");
    const logs = [".stdout", ".stderr"].map(suffix => {
      migrationWriteExclusive(log + suffix, Buffer.alloc(0), 0o600);
      return identity(log + suffix);
    });
    doctor = { version: 2, log, logs, attempts: [] };
  }
  const buffers = offlineDoctorLogs(root, record, doctor);
  const attempt = { markerState: "preparing", index: doctor.attempts.length + 1, startedAt: new Date().toISOString(), identity: expected.identity,
    logs: buffers.map(bytes => ({ offset: bytes.length, prefixSha256: offlineHash(bytes) })), exit: null };
  doctor.attempts.push(attempt);
  // Bind the exact marker before appending; a crash can resume either partial stream safely.
  expected = offlineSaveDoctor(pathname, root, expected, doctor);
  return offlinePublishAttempt(pathname, root, expected);
}

function offlineInventory(root, record, inventory) {
  if (!record.offlineDoctor) return inventory;
  return offlineReboundInventory(inventory, migrationReadArtifact(root, record, "rebinding"));
}

function offlineReboundInventory(inventory, binding) {
  const result = structuredClone(inventory);
  for (const store of result.stores) {
    const entry = binding.databases.find(value => value.path === store.path);
    if (!entry || entry.old.device !== store.device || entry.old.inode !== store.inode) reject("offline rebinding lost its original store identity");
    Object.assign(store, entry.new);
  }
  return result;
}

function offlineWitness(root, record) {
  const witness = migrationReadArtifact(root, record, "witness");
  if (!record.offlineDoctor) return witness;
  const binding = migrationReadArtifact(root, record, "rebinding");
  return sessionWitnessTuples(witness).map(row => {
    const entry = binding.databases.find(value => value.path === row[1] && value.old.device === row[2] && value.old.inode === row[3]);
    if (!entry) reject("offline rebinding lost the original witness database");
    row[2] = entry.new.device; row[3] = entry.new.inode;
    return JSON.stringify(row);
  });
}

function offlineVerifyBound(root, record) {
  const inventory = migrationReadArtifact(root, record, "inventory");
  const binding = offlineBoundArtifact(root, record);
  if (binding.partialNocowAccepted) offlinePartialAttempt(root, record);
  const predecessorRecovery = migrationRecordProfile(record).offline && record.agentMigration.phase === "recovering-predecessor";
  if (migrationRecordProfile(record).offline && record.agentMigration.artifacts.failure && !predecessorRecovery && !binding.partialNocowAccepted)
    reject("failed offline Doctor requires explicit partial acceptance before forward verification");
  const proof = predecessorRecovery && !record.agentMigration.artifacts.doctor && record.agentMigration.artifacts.precapture
    ? offlinePreDoctorBinding(root, record)
    : offlineVerify(migrationReadArtifact(root, record, "nocow"), offlineReadReport(root, record), join(root, "releases", record.candidate.sha),
      migrationRecordProfile(record), inventory, binding.partialNocowAccepted);
  if (!predecessorRecovery) offlineAssertNocowBinding(proof, inventory);
  const comparable = structuredClone(proof);
  // Retained pre-interruption bindings classified qualified refusals without staging annotations.
  // Reverify all filesystem facts above, then compare using that original persisted vocabulary.
  if (binding.partialNocowAccepted) for (const entry of comparable.directories) {
    const prior = binding.directories.find(value => value.path === entry.path);
    if (prior?.nocow === "refused" && !Object.hasOwn(prior, "retainedStaging") && entry.nocow === "interrupted" && entry.refusal) {
      entry.nocow = "refused"; delete entry.retainedStaging;
    }
  }
  if (!isDeepStrictEqual(comparable, binding)) reject("verified offline Doctor identities changed");
  return proof;
}

function offlinePartialAttempt(root, record) {
  const profile = migrationRecordProfile(record);
  if (!profile.nocow || !record.agentMigration.artifacts.doctor)
    reject("partial NOCOW recovery is not applicable: requires a retained NOCOW Doctor attempt");
  const attempt = migrationReadArtifact(root, record, "doctor").attempts?.at(-1);
  const report = offlineReadReport(root, record).at(-1);
  const interrupted = offlineInterruptedAttempt(report);
  if (!interrupted && (!attempt?.finishedAt || attempt.exit !== 0))
    reject("partial NOCOW recovery requires the latest Doctor attempt to have exited 0 or been interrupted by timeout/SIGTERM");
  if (record.agentMigration.artifacts.failure) migrationReadArtifact(root, record, "failure");
  else if (!interrupted) reject("partial NOCOW recovery requires a retained Doctor failure");
}

function offlineAcceptPartial(pathname, root, expected, procRoot) {
  let record = offlineRequireFence(pathname, root, expected, procRoot);
  offlinePartialAttempt(root, record);
  if (record.agentMigration.artifacts.rebinding) {
    if (!offlineBoundArtifact(root, record).partialNocowAccepted) reject("partial NOCOW recovery is not applicable to a complete binding");
    offlineVerifyBound(root, record);
    return expected;
  }
  expected = offlineFinishAttempt(pathname, root, expected, null);
  record = migrationLoad(pathname, root, expected).record;
  const binding = offlineVerify(migrationReadArtifact(root, record, "nocow"), offlineReadReport(root, record),
    join(root, "releases", record.candidate.sha), migrationRecordProfile(record), migrationReadArtifact(root, record, "inventory"),
    { operator: { uid: process.getuid(), gid: process.getgid(), login: process.env.SUDO_USER ?? null },
      at: new Date().toISOString(), flag: "--accept-partial-nocow" });
  return migrationAttachValue(pathname, root, expected, "rebinding", binding);
}

function offlineNocowSummary(root, record) {
  if (!record.offlineDoctor || !record.agentMigration.artifacts.rebinding) return "";
  const binding = offlineBoundArtifact(root, record);
  if (!binding.partialNocowAccepted) return "";
  offlineAssertNocowBinding(binding, migrationReadArtifact(root, record, "inventory"));
  const refused = binding.directories.filter(entry => entry.refusal);
  const cow = binding.directories.filter(entry => entry.refusal || entry.nocowApplied === false);
  const interrupted = binding.directories.filter(entry => entry.nocow === "interrupted");
  const unreceipted = binding.directories.filter(entry => entry.nocow === "rewritten-unreceipted");
  return ` nocow=partial refused=${refused.length} cow-directories=${JSON.stringify(cow.map(entry => entry.path))} interrupted=${interrupted.length} rewritten-unreceipted=${unreceipted.length}`;
}

function offlineDoctorVerify(pathname, root, expected, rawExit, procRoot) {
  let { record } = migrationLoad(pathname, root, expected);
  const exitCode = integer(rawExit, "Doctor exit");
  try {
    offlineRequireFence(pathname, root, expected, procRoot);
    if (migrationRecordProfile(record).offline && record.agentMigration.artifacts.failure) reject("offline Doctor failure is retained; explicit recovery required");
    expected = offlineFinishAttempt(pathname, root, expected, exitCode);
    record = migrationLoad(pathname, root, expected).record;
    const report = offlineReadReport(root, record);
    if (exitCode !== 0) reject(`offline Doctor exited ${exitCode}`);
    const binding = offlineVerify(migrationReadArtifact(root, record, "nocow"), report, join(root, "releases", record.candidate.sha),
      migrationRecordProfile(record), migrationReadArtifact(root, record, "inventory"));
    if (record.agentMigration.artifacts.rebinding) { offlineVerifyBound(root, record); return expected; }
    return migrationAttachValue(pathname, root, expected, "rebinding", binding);
  } catch (error) {
    offlineRecordFailure(pathname, root, exitCode, error);
    throw error;
  }
}

function offlineRecordFailure(pathname, root, exitCode, error) {
  const expected = migrationLoad(pathname, root), record = expected.record;
    if (record.offlineDoctor && record.agentMigration.phase === "doctor-started" && !record.agentMigration.artifacts.failure) {
      const capture = migrationReadArtifact(root, record, record.agentMigration.artifacts.nocow ? "nocow" : "precapture");
      const retained = offlineCaptureDirectories(capture).flatMap(({ directory }) => readdirSync(dirname(directory))
        .filter(name => name.startsWith(`${basename(directory)}.nocow-`)).map(name => join(dirname(directory), name)));
      migrationAttachValue(pathname, root, expected, "failure", { version: 1, exitCode, reason: String(error.message), retained });
    }
}

function offlineRecoveryPosition(pathname, root, expected) {
  const { record } = migrationLoad(pathname, root, expected);
  if (!migrationRecordProfile(record).offline || record.agentMigration.phase !== "recovering-predecessor") reject("offline predecessor recovery is not admitted; schema crossing is forward-only");
  migrationReleaseProof(root, record, migrationOwner());
  const current = realpathSync(join(root, "current")), previousPath = join(root, "previous");
  const previous = lstatSync(previousPath, { throwIfNoEntry: false }) ? realpathSync(previousPath) : null;
  const originalPrevious = record.pointerTopology.previous.sha;
  if (![record.candidate.sha, record.predecessor.sha].some(sha => current === join(root, "releases", sha)) ||
      ![record.predecessor.sha, originalPrevious].some(sha => previous === (sha === null ? null : join(root, "releases", sha))))
    reject("offline recovery pointers are outside the original transaction");
  migrationPointers(root, migrationOwner(), { current: basename(current), previous: previous === null ? null : basename(previous) });
  if (migrationPermit(root) && current !== join(root, "releases", record.predecessor.sha)) reject("offline recovery permit cannot select candidate");
  return "RECOVERY_POSITION_OK";
}

function offlineDoctorRecover(pathname, root, expected, procRoot) {
  let record = offlineRequireFence(pathname, root, expected, procRoot);
  if (!migrationRecordProfile(record).offline) reject("schema-crossing NOCOW recovery is forward-only; predecessor recovery is forbidden");
  if (record.agentMigration.artifacts.doctor) {
    expected = offlinePublishAttempt(pathname, root, expected);
    expected = offlineFinishAttempt(pathname, root, expected, null);
    record = migrationLoad(pathname, root, expected).record;
  }
  // Recovery never repeats Doctor or exchanges directories. Re-establish readable,
  // unchanged schemas and proven identities before allowing the old code to start.
  const report = record.agentMigration.artifacts.doctor ? offlineReadReport(root, record) : "";
  const binding = !record.agentMigration.artifacts.doctor && record.agentMigration.artifacts.precapture
    ? offlinePreDoctorBinding(root, record)
    : offlineVerify(migrationReadArtifact(root, record, "nocow"), report, join(root, "releases", record.candidate.sha),
      migrationRecordProfile(record), migrationReadArtifact(root, record, "inventory"));
  if (!record.agentMigration.artifacts.rebinding) expected = migrationAttachValue(pathname, root, expected, "rebinding", binding);
  else if (!isDeepStrictEqual(binding, offlineBoundArtifact(root, record))) reject("verified offline Doctor identities changed");
  const current = migrationLoad(pathname, root, expected).record;
  const inventory = migrationReadArtifact(root, current, "inventory"), release = join(root, "releases", current.candidate.sha);
  migrationSameInventory(offlineInventory(root, current, inventory), migrationInventory(inventory.config.path, current.protectedPaths[1].path, release, migrationRecordProfile(current), true), migrationRecordProfile(current), true);
  migrationVerifyPreservation(inventory, migrationReadArtifact(root, current, "backups"), release, migrationRecordProfile(current));
  migrationVerifyWitness(offlineInventory(root, current, inventory), release, offlineWitness(root, current));
  current.protectedPaths[1] = identity(current.protectedPaths[1].path);
  current.agentMigration.phase = "recovering-predecessor"; current.phase = "ROLLBACK_FAILED";
  migrationWritersStopped(pathname, root, expected, procRoot);
  return migrationUpdate(pathname, root, expected, current);
}

function offlineRecoveryCheck(pathname, root, expected, procRoot, finish = false) {
  const { record } = migrationLoad(pathname, root, expected);
  if (!migrationRecordProfile(record).offline || record.agentMigration.phase !== "recovering-predecessor") reject("offline predecessor recovery is not admitted; schema crossing is forward-only");
  migrationReleaseProof(root, record, migrationOwner());
  migrationPointers(root, migrationOwner(), { current: record.predecessor.sha, previous: record.pointerTopology.previous.sha });
  const inventory = migrationReadArtifact(root, record, "inventory"), release = join(root, "releases", record.predecessor.sha), profile = migrationRecordProfile(record);
  migrationSameInventory(offlineInventory(root, record, inventory), migrationInventory(inventory.config.path, record.protectedPaths[1].path, release, profile, true), profile, true);
  migrationVerifyWitness(offlineInventory(root, record, inventory), release, offlineWitness(root, record));
  if (!migrationPermit(root)) {
    offlineVerifyBound(root, record);
    migrationWritersStopped(pathname, root, expected, procRoot);
    migrationVerifyPreservation(inventory, migrationReadArtifact(root, record, "backups"), release, profile);
  }
  migrationLoad(pathname, root, expected);
  if (finish) {
    if (!migrationPermit(root)) reject("offline recovery never started predecessor");
    unlinkSync(pathname); syncPath(dirname(pathname)); return "RECOVERED";
  }
  return migrationPublishPermit(root);
}

function migrationVerifyStores(pathname, root, expected, configPath, databasePath) {
  const { record } = migrationLoad(pathname, root, expected);
  const profile = migrationRecordProfile(record);
  if (record.agentMigration.phase !== "doctor-started") reject("store verification requires durable Doctor-started history");
  if (profile.nocow) offlineVerifyBound(root, record);
  const inventory = migrationReadArtifact(root, record, "inventory"), backups = migrationReadArtifact(root, record, "backups");
  const release = join(root, "releases", record.candidate.sha), current = migrationInventory(configPath, databasePath, release, profile, true);
  const configResult = profile.config ? migrationReadArtifact(root, record, "config") : undefined;
  if (profile.config) {
    configRepairVerifyInputs(inventory, configResult);
    inventory.configRepair.result = configResult;
  }
  migrationSameInventory(offlineInventory(root, record, inventory), current, profile, true, configResult);
  migrationVerifyPreservation(inventory, backups, release, profile);
  if (!Array.isArray(inventory.inputs)) reject("original cold Doctor input closure is missing");
  if (!profile.config && !profile.nativeDoctor) migrationVerifyInputBytes(inventory.inputs, true);
  migrationVerifyWitness(current, release, offlineWitness(root, record));
  const ready = { version: 1, ...migrationProfileBinding(profile), candidate: record.candidate.sha, dataReady: true,
    ...(profile.config ? { configEffects: configRepairEffects(inventory, backups, release) } : {}),
    artifacts: Object.fromEntries(["inventory", "witness", "backups"].map(kind => [kind, record.agentMigration.artifacts[kind].sha256])),
    stores: current.stores.map(({ path, device, inode, agentId, version, metadata }) => ({ path, device, inode, agentId, version, metadata })) };
  if (record.agentMigration.artifacts.ready) {
    if (!isDeepStrictEqual(migrationReadArtifact(root, record, "ready"), ready)) reject("retained readiness proof changed");
  } else expected = migrationAttachValue(pathname, root, expected, "ready", ready);
  return migrationTransition(pathname, root, expected, { phase: "stores-verified" });
}

function migrationVerifyReadyStores(root, record, readyBytes, reviewedConfig) {
  const ready = migrationJson(readyBytes);
  const profile = migrationRecordProfile(record);
  migrationCheckProfileBinding(ready, profile);
  const inventory = migrationReadArtifact(root, record, "inventory");
  const backups = migrationReadArtifact(root, record, "backups");
  if (ready?.version !== 1 || ready.candidate !== record.candidate.sha || ready.dataReady !== true ||
      !isDeepStrictEqual(ready.artifacts, Object.fromEntries(["inventory", "witness", "backups"].map(kind => [kind, record.agentMigration.artifacts[kind].sha256]))) ||
      !Array.isArray(ready.stores) || !Array.isArray(backups) || backups.length !== inventory.stores?.length)
    reject("migration readiness does not bind the original complete inventory, backups and witness");
  for (const store of inventory.stores) {
    const snapshot = backups.find(value => value.source === store.path);
    if (!snapshot || !isDeepStrictEqual(migrationHashFile(snapshot.file.path), snapshot.file)) reject("original verified backup is missing or changed");
  }
  const release = join(root, "releases", record.candidate.sha);
  const current = migrationInventory(inventory.config.path, record.protectedPaths[1].path, release, profile, true);
  const configResult = profile.config ? migrationReadArtifact(root, record, "config") : undefined;
  const startPermit = profile.config || profile.nocow ? migrationPermit(root) : null;
  if (profile.nocow) offlineAssertNocowBinding(offlineBoundArtifact(root, record), inventory);
  if (profile.nocow && !startPermit) offlineVerifyBound(root, record);
  if (profile.config) {
    // The recorded permit ends the input freeze, not canonical config or original-evidence checks.
    if (startPermit) configRepairVerifyCanonicalResult(inventory, configResult);
    else configRepairVerifyInputs(inventory, configResult);
  }
  const reconciled = record.agentMigration.artifacts.reconciliation ? migrationReadArtifact(root, record, "reconciliation") : null;
  if (reconciled) migrationReconciledLive(root, record, reconciled, !reviewedConfig);
  const expectedConfig = reviewedConfig ?? reconciled?.config;
  const effectiveInventory = offlineInventory(root, record, inventory);
  migrationSameInventory(expectedConfig ? { ...effectiveInventory, config: expectedConfig } : effectiveInventory, current, profile, true, configResult);
  if (profile.config && !startPermit &&
      !isDeepStrictEqual(ready.configEffects, configRepairEffects(inventory, backups, release)))
    reject("verified native config effects changed before start permission");
  if (!isDeepStrictEqual(ready.stores, current.stores.map(({ path, device, inode, agentId, version, metadata }) => ({ path, device, inode, agentId, version, metadata }))))
    reject("migration readiness physical schema proof changed");
  migrationVerifyWitness(current, release, offlineWitness(root, record));
  return current;
}

function migrationStatus(pathname, root) {
  const namespace = migrationNamespace(root);
  if (pathname !== namespace.pathname) reject("migration journal path is not canonical");
  if (!lstatSync(pathname, { throwIfNoEntry: false })) return "none";
  const file = migrationFile(pathname, namespace.owner, { limit: migrationJournalLimit });
  const record = ownedJournal(pathname);
  if (!isDeepStrictEqual(record, migrationJson(file.bytes))) reject("activation journal changed during inspection");
  return Object.hasOwn(record, "agentMigration") ? migrationLoad(pathname, root).record.agentMigration.phase : "none";
}

function migrationAbandonEvidence(pathname, root, candidate) {
  if (!shaPattern.test(candidate)) reject("rehearsal abandonment requires an exact candidate SHA");
  const { owner, pathname: canonical } = migrationNamespace(root);
  if (pathname !== canonical) reject("rehearsal abandonment journal path is not canonical");
  if (!lstatSync(pathname, { throwIfNoEntry: false })) reject("no activation journal pending for rehearsal abandonment");
  const raw = migrationJson(migrationFile(pathname, owner, { limit: migrationJournalLimit }).bytes);
  if (raw.version !== 1 || raw.phase !== "AGENT_REHEARSAL" || raw.agentMigration?.phase !== "rehearsal" || raw.suspension !== null)
    reject("rehearsal abandonment requires AGENT_REHEARSAL/rehearsal with no suspension");
  if (!isDeepStrictEqual(raw.agentMigration.artifacts, {})) reject("rehearsal abandonment refuses migration artifacts");
  if (raw.candidate?.sha !== candidate) reject("rehearsal abandonment candidate SHA mismatch");
  return migrationLoad(pathname, root, undefined, true);
}

function migrationAbandonSnapshot(pathname, root, candidate, rawControllerPid, instance, expected) {
  const evidence = migrationAbandonEvidence(pathname, root, candidate), { record, identity: binding } = evidence;
  if (expected && !isDeepStrictEqual(evidence, expected)) reject("rehearsal abandonment journal or stage changed");
  const owner = migrationOwner(), boundary = process.env.OPENCLAW_TEAM_ANCESTOR_BOUNDARY ?? "/";
  migrationReleaseProof(root, record, owner);
  migrationPointers(root, owner, { current: record.predecessor.sha, previous: record.pointerTopology.previous.sha });
  migrationRehearsalProcess(root, record);
  if (instance !== record.process.instance) reject("rehearsal abandonment Gateway process instance changed");
  const procRoot = process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc", controllerPid = integer(rawControllerPid, "controller PID");
  const lock = process.env.OPENCLAW_TEAM_LOCK_FILE ?? "/run/openclaw-release-deploy.lock";
  migrationAncestors(dirname(lock), owner, boundary);
  const held = fstatSync(9), entry = lstatSync(lock);
  if (process.getuid() !== owner || !held.isFile() || !entry.isFile() || held.dev !== entry.dev || held.ino !== entry.ino ||
      entry.uid !== owner || entry.gid !== rootGroup() || entry.nlink !== 1 || (entry.mode & 0o022))
    reject("rehearsal abandonment requires the canonical owner lock");
  if (process.platform === "linux") migrationControllerBinding(rawControllerPid);
  // The controller shell runs every proof through $(...) subshells that keep its argv;
  // everything descending from the controller PID is this invocation, not a foreign owner.
  const parents = new Map();
  for (const name of readdirSync(procRoot).filter(name => /^[1-9]\d*$/.test(name))) {
    try {
      const stat = readFileSync(join(procRoot, name, "stat"), "utf8");
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const own = pid => {
    for (let current = pid, hops = 0; Number.isSafeInteger(current) && current > 0 && hops < 64; current = parents.get(current), hops++)
      if (current === controllerPid || current === process.pid || current === process.ppid) return true;
    return false;
  };
  for (const name of readdirSync(procRoot).filter(name => /^[1-9]\d*$/.test(name) && !own(Number(name)))) {
    const directory = join(procRoot, name);
    try {
      const argv = readFileSync(join(directory, "cmdline"), "utf8").split("\0");
      if (argv.some(arg => ["openclaw-release-deploy", "openclaw-hourly-update", "release-lib.mjs"].includes(basename(arg))))
        reject("rehearsal abandonment refuses another canonical executable");
    } catch (error) {
      if (error.code === "ENOENT" && !existsSync(directory)) continue;
      throw error;
    }
  }
  const show = (unit, keys) => {
    const child = spawnSync(process.env.OPENCLAW_TEAM_SYSTEMCTL ?? "systemctl",
      ["show", unit, ...keys.map(key => `--property=${key}`)], { encoding: "utf8", timeout: 15_000 });
    if (child.error || child.status !== 0) reject(`rehearsal abandonment cannot inspect ${unit}`);
    const values = {};
    for (const line of child.stdout.trimEnd().split("\n")) {
      const split = line.indexOf("="), key = line.slice(0, split);
      if (split < 1 || !keys.includes(key) || Object.hasOwn(values, key)) reject("ambiguous rehearsal abandonment unit properties");
      values[key] = line.slice(split + 1);
    }
    if (Object.keys(values).length !== keys.length) reject("incomplete rehearsal abandonment unit properties");
    return values;
  };
  const gateway = show("openclaw-gateway.service", ["ActiveState", "SubState", "MainPID", "ControlPID", "Job", "InvocationID", "NRestarts"]);
  if (gateway.ActiveState !== "active" || gateway.SubState !== "running" || gateway.MainPID !== String(record.process.pid) ||
      gateway.ControlPID !== "0" || !["", "0"].includes(gateway.Job) || gateway.NRestarts !== "0" || !/^[a-f\d]{32}$/.test(gateway.InvocationID))
    reject("rehearsal abandonment Gateway generation, restart count or job changed");
  // Version-1 journals bind native instance/start ticks, but predate a systemd invocation field.
  // Bind the invocation inherited by that exact still-running process, without exposing its environment.
  const invocations = readFileSync(join(procRoot, String(record.process.pid), "environ"), "utf8").split("\0")
    .filter(value => value.startsWith("INVOCATION_ID=")).map(value => value.slice("INVOCATION_ID=".length));
  if (invocations.length !== 1 || invocations[0] !== gateway.InvocationID)
    reject("rehearsal abandonment Gateway invocation changed");
  const timer = show("openclaw-hourly-update.timer", ["UnitFileState", "ActiveState", "Job"]);
  if (timer.UnitFileState !== "disabled" || timer.ActiveState !== "inactive" || !["", "0"].includes(timer.Job))
    reject("rehearsal abandonment requires the hourly timer disabled and inactive");
  const updater = show("openclaw-hourly-update.service", ["MainPID", "ControlPID", "Job", "ActiveState"]);
  if (updater.MainPID !== "0" || updater.ControlPID !== "0" || !["", "0"].includes(updater.Job) || !["inactive", "failed"].includes(updater.ActiveState))
    reject("rehearsal abandonment requires a settled updater");
  const permit = migrationPermit(root);
  if (!permit) reject("rehearsal abandonment requires the original positive start permit");
  const guardDirectory = join(boundary, "etc/systemd/system/openclaw-gateway.service.d");
  migrationAncestors(guardDirectory, owner, boundary);
  const guard = migrationFile(join(guardDirectory, migrationGuardName), owner, { privateOnly: false, mode: 0o644 });
  if (!guard.bytes.equals(Buffer.from(migrationGuardBody(root)))) reject("rehearsal abandonment migration guard changed");
  for (const directory of [guardDirectory, join(boundary, "run/systemd/system/openclaw-gateway.service.d"), join(root, "journal")]) {
    if (!lstatSync(directory, { throwIfNoEntry: false })) continue;
    exactDirectory(directory, owner, "rehearsal abandonment side-effect directory");
    for (const name of readdirSync(directory)) {
      if (name.includes(".next.") || (name !== record.agentMigration.stage && name.includes(record.agentMigration.stage)) ||
          (name.startsWith(migrationPermitName) && name !== migrationPermitName) ||
          (directory !== join(root, "journal") && (name.includes("migration") || name.includes("permit")) &&
            !(directory === guardDirectory && name === migrationGuardName)))
        reject(`rehearsal abandonment refuses permit, guard or publication side effect: ${name}`);
      if (directory !== join(root, "journal")) {
        const file = migrationFile(join(directory, name), owner, { privateOnly: false, limit: migrationJournalLimit });
        if (file.bytes.includes(Buffer.from(record.agentMigration.stage))) reject("rehearsal abandonment refuses a stage-bound guard");
      }
    }
  }
  const stage = binding.stage.path, receiptName = `abandon-${record.agentMigration.stage}.json`;
  const attempts = [];
  for (const name of readdirSync(stage).sort()) {
    if (name === receiptName) continue;
    if (!/^rehearsal-[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(name))
      reject(`rehearsal abandonment refuses non-rehearsal stage artifact: ${name}`);
    const directory = join(stage, name);
    const attempt = exactDirectory(directory, owner, "retained rehearsal", { privateOnly: true });
    const children = readdirSync(directory).sort();
    const allowed = new Set(["rootfs", "serving", "snapshots", "copy-manifest.json", "doctor.stdout", "doctor.stderr", "doctor.outcome.json", "verify.stdout", "verify.stderr", "verify.outcome.json"]);
    if (children.some(child => !allowed.has(child))) reject("rehearsal abandonment refuses unexpected copied rehearsal evidence");
    const outcomes = {};
    for (const label of ["doctor", "verify"]) {
      const file = join(directory, `${label}.outcome.json`);
      if (!lstatSync(file, { throwIfNoEntry: false })) { outcomes[label] = null; continue; }
      const { bytes, descriptor } = migrationFile(file, owner, { mode: 0o600, limit: migrationJournalLimit });
      const value = migrationJson(bytes);
      if (value.version !== 1 || value.phase !== label || !(value.status === null || Number.isSafeInteger(value.status)) ||
          !(value.signal === null || typeof value.signal === "string") || !(value.errorCode === null || typeof value.errorCode === "string") ||
          !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)
        reject("rehearsal abandonment outcome summary is malformed");
      outcomes[label] = { descriptor, summary: value };
    }
    attempts.push({ name, identity: { path: directory, device: attempt.dev, inode: attempt.ino }, children, outcomes });
  }
  migrationLoad(pathname, root, evidence, true);
  migrationRehearsalProcess(root, record);
  return { evidence, gateway, timer, updater, permit, guard: guard.descriptor, pointers: migrationLivePointers(root), attempts };
}

function migrationAbandon(pathname, root, candidate, rawControllerPid, instance, expected) {
  const snapshot = migrationAbandonSnapshot(pathname, root, candidate, rawControllerPid, instance, expected.evidence);
  if (!isDeepStrictEqual(snapshot, expected)) reject("rehearsal abandonment admission changed");
  const { record, identity: binding } = snapshot.evidence, stage = binding.stage.path;
  const destination = join(root, "journal", `abandoned-${record.agentMigration.stage}`);
  const retiredJournal = join(stage, "activation.abandoned.json"), receiptPath = join(stage, `abandon-${record.agentMigration.stage}.json`);
  if (lstatSync(destination, { throwIfNoEntry: false }) || lstatSync(retiredJournal, { throwIfNoEntry: false }))
    reject("rehearsal abandonment destination already exists");
  const intent = { version: 1, kind: "abandon-rehearsal", reason: "operator abandoned candidate after rehearsal-only attempt",
    candidate, predecessor: record.predecessor.sha, journal: binding, destination, snapshot };
  if (lstatSync(receiptPath, { throwIfNoEntry: false })) {
    const receipt = migrationJson(migrationFile(receiptPath, migrationOwner(), { mode: 0o600 }).bytes);
    if (!isDeepStrictEqual(receipt.intent, intent) || !Number.isSafeInteger(receipt.preparedAt) ||
        receipt.operator?.uid !== migrationOwner() || !Number.isSafeInteger(receipt.operator?.pid))
      reject("retained rehearsal abandonment receipt does not match admitted evidence");
  } else {
    migrationWriteExclusive(receiptPath, Buffer.from(JSON.stringify({ intent, preparedAt: Date.now(),
      operator: { uid: process.getuid(), gid: process.getgid(), pid: Number(rawControllerPid), login: process.env.SUDO_USER ?? null } }) + "\n"), 0o600);
  }
  // Receipt publication is the commit intent. Both crash windows retain all original bytes.
  migrationLoad(pathname, root, snapshot.evidence, true);
  migrationRehearsalProcess(root, record);
  renameSync(pathname, retiredJournal);
  syncPath(stage); syncPath(dirname(pathname));
  renameSync(stage, destination);
  syncPath(destination); syncPath(dirname(destination));
  return destination;
}

function migrationCandidateLive(root, record, processBinding) {
  if (record.phase !== "D_VERIFYING" || record.agentMigration.phase !== "stores-verified" ||
      migrationRecordProfile(record).offline || migrationRecordProfile(record).config || record.runtimeChange)
    reject("live config reconciliation requires a D_VERIFYING/stores-verified schema-crossing candidate");
  if (!Number.isSafeInteger(processBinding?.pid) || processBinding.pid < 1 ||
      !/^[1-9]\d*$/.test(processBinding.generation) || typeof processBinding.instance !== "string" || !processBinding.instance)
    reject("live config reconciliation requires an exact Gateway generation");
  const directory = join(process.env.OPENCLAW_TEAM_PROC_ROOT ?? "/proc", String(processBinding.pid));
  const stat = readFileSync(join(directory, "stat"), "utf8"), boundary = stat.lastIndexOf(") ");
  const fields = stat.slice(boundary + 2).trim().split(/\s+/);
  if (boundary < 0 || fields[19] !== processBinding.generation || ["Z", "X", "x", "T", "t"].includes(fields[0]) ||
      realpathSync(join(directory, "cwd")) !== join(root, "releases", record.candidate.sha))
    reject("live selected candidate Gateway generation changed");
  migrationPointers(root, migrationOwner(), { current: record.candidate.sha, previous: record.predecessor.sha });
  const pointers = Object.fromEntries(["current", "previous"].map(name => {
    const entry = lstatSync(join(root, name));
    return [name, { device: entry.dev, inode: entry.ino }];
  }));
  const permit = migrationPermit(root);
  if (!permit) reject("live selected candidate requires its existing start permit");
  if (migrationRecordProfile(record).nocow) {
    const binding = offlineBoundArtifact(root, record);
    offlineAssertNocowBinding(binding, migrationReadArtifact(root, record, "inventory"));
    for (const store of [...binding.directories, ...binding.databases]) {
      const entry = lstatSync(store.path);
      if (entry.isSymbolicLink() || entry.dev !== store.new.device || entry.ino !== store.new.inode)
        reject("live candidate store identity changed since NOCOW rebinding");
    }
  }
  return { pointers, permit };
}

function migrationReviewedConfig(record, runtimeUid) {
  const path = record.protectedPaths[0].path, entry = lstatSync(path);
  migrationFile(path, integer(runtimeUid, "config runtime owner"), { mode: 0o600, group: entry.gid });
  return migrationHashFile(path);
}

function migrationReconciledLive(root, record, receipt, checkConfig = true) {
  if (receipt?.version !== 1 || receipt.candidate !== record.candidate.sha ||
      !isDeepStrictEqual(migrationCandidateLive(root, record, receipt.process), receipt.live))
    reject("reconciled candidate pointers, permit or generation changed");
  if (checkConfig && !isDeepStrictEqual(migrationReviewedConfig(record, receipt.runtimeUid), receipt.config))
    reject("reviewed live candidate config changed");
}

function migrationNativeConfigAudit(root, record, previous, config, runtimeUid, startup) {
  const entry = lstatSync(config.path);
  return migrationDatabaseRead(record.protectedPaths[1].path, join(root, "releases", record.candidate.sha), database => {
    const rows = database.prepare("SELECT event_key,payload_json FROM diagnostic_events WHERE scope='config-audit' ORDER BY sequence DESC LIMIT 50000").all();
    for (const row of rows) {
      const value = JSON.parse(row.payload_json);
      if (value.event !== "config.write" || value.source !== "config-io" || value.result !== "rename" ||
          value.configPath !== config.path || value.existsBefore !== true ||
          value.previousHash !== previous.sha256 || value.nextHash !== config.sha256 ||
          value.previousBytes !== previous.size || value.nextBytes !== config.size) continue;
      if (!Number.isFinite(Date.parse(value.ts)) || !row.event_key.startsWith(`${value.ts}:config.write:`) ||
          !Number.isSafeInteger(value.pid) || value.pid < 1) continue;
      if (startup && (value.pid !== startup.pid || Date.parse(value.ts) < startup.startedAt ||
          Date.parse(value.ts) > startup.startedAt + 600_000 || Date.parse(value.ts) > Date.now())) continue;
      if ([["previous", previous], ["next", config]].some(([prefix, descriptor]) =>
        value[`${prefix}Dev`] !== String(descriptor.device) || value[`${prefix}Ino`] !== String(descriptor.inode) ||
        value[`${prefix}Mode`] !== 0o600 || value[`${prefix}Nlink`] !== 1 ||
        value[`${prefix}Uid`] !== runtimeUid || value[`${prefix}Gid`] !== entry.gid)) continue;
      // Retain only the exact audit binding, never the native writer's argv or config values.
      return { key: row.event_key, sha256: createHash("sha256").update(row.payload_json).digest("hex") };
    }
    reject("reviewed config lacks a native runtime-owner atomic replacement audit");
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
      record.agentMigration || record.configMigration || record.runtimeChange || !record.originalWitness ||
      record.candidate.sha === record.predecessor.sha || !isDeepStrictEqual(record.predecessor.schemaVersions, record.candidate.schemaVersions) ||
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

function migrationReconcileSnapshot(pathname, root, expected, request) {
  const { record } = migrationLoad(pathname, root, expected);
  if (request?.candidate !== record.candidate.sha || request.journalSha256 !== expected.identity.sha256 ||
      !/^[a-f0-9]{64}$/.test(request.configSha256))
    reject("live config reconciliation candidate or reviewed journal hash mismatch");
  const live = migrationCandidateLive(root, record, request.process);
  const runtimeUid = integer(request.runtimeUid, "config runtime owner");
  const config = migrationReviewedConfig(record, runtimeUid);
  if (config.sha256 !== request.configSha256) reject("reviewed reconciliation config hash mismatch");
  if (config.device !== record.protectedPaths[0].device || config.inode === record.protectedPaths[0].inode)
    reject("config reconciliation requires an atomic replacement on the original filesystem");
  const prior = record.agentMigration.artifacts.reconciliation ? migrationReadArtifact(root, record, "reconciliation") : null;
  if (prior) migrationReconciledLive(root, record, prior, false);
  const previous = prior?.config ?? migrationReadArtifact(root, record, "inventory").config;
  if (!isDeepStrictEqual(record.protectedPaths[0], { path: previous.path, device: previous.device, inode: previous.inode }))
    reject("config reconciliation lost the original protected config binding");
  const audit = migrationNativeConfigAudit(root, record, previous, config, runtimeUid);
  const rebound = structuredClone(record);
  rebound.protectedPaths[0] = { path: config.path, device: config.device, inode: config.inode };
  migrationReleaseProof(root, rebound, migrationOwner());
  policy(config.path);
  migrationVerifyReadyStores(root, record, migrationArtifactRead(root, record, "ready", migrationOwner()), config);
  migrationLoad(pathname, root, expected);
  if (!isDeepStrictEqual(live, migrationCandidateLive(root, record, request.process)) ||
      !isDeepStrictEqual(config, migrationReviewedConfig(record, runtimeUid)))
    reject("live reconciliation inputs changed during verification");
  return { version: 1, candidate: record.candidate.sha, process: request.process, runtimeUid, config, audit, live, original: expected };
}

function migrationReconcileCommit(pathname, root, expected, snapshot) {
  const request = { candidate: snapshot.candidate, process: snapshot.process, runtimeUid: snapshot.runtimeUid,
    configSha256: snapshot.config.sha256, journalSha256: expected.identity.sha256 };
  if (!isDeepStrictEqual(migrationReconcileSnapshot(pathname, root, expected, request), snapshot))
    reject("live config reconciliation snapshot changed before publication");
  const record = structuredClone(expected.record);
  const name = `reconciliation-${randomUUID()}.json`, target = join(expected.identity.stage.path, name);
  migrationWriteExclusive(target, Buffer.from(`${JSON.stringify(snapshot)}\n`), 0o600);
  const descriptor = migrationFile(target, migrationOwner()).descriptor;
  record.agentMigration.artifacts.reconciliation = { name, device: descriptor.device, inode: descriptor.inode, sha256: descriptor.sha256 };
  record.protectedPaths[0] = { path: snapshot.config.path, device: snapshot.config.device, inode: snapshot.config.inode };
  return migrationUpdate(pathname, root, expected, record, () => {
    if (!isDeepStrictEqual(snapshot.live, migrationCandidateLive(root, record, snapshot.process)) ||
        !isDeepStrictEqual(snapshot.config, migrationReviewedConfig(record, snapshot.runtimeUid)))
      reject("live reconciliation changed at journal compare-and-swap");
  });
}

function migrationReconcileCheck(pathname, root, expected) {
  const { record } = migrationLoad(pathname, root, expected);
  const receipt = migrationReadArtifact(root, record, "reconciliation");
  migrationReconciledLive(root, record, receipt);
  migrationReleaseProof(root, record, migrationOwner());
  migrationVerifyReadyStores(root, record, migrationArtifactRead(root, record, "ready", migrationOwner()));
  migrationLoad(pathname, root, expected);
  migrationReconciledLive(root, record, receipt);
  return receipt;
}

function migrationFinish(pathname, root, expected) {
  const { record } = migrationLoad(pathname, root, expected);
  if (record.agentMigration.phase !== "stores-verified" || !["D_VERIFYING", "ROLLBACK_FAILED"].includes(record.phase))
    reject("migration retirement requires verified stores and a terminal outer phase");
  const owner = migrationOwner();
  const pointers = { current: record.candidate.sha, previous: record.predecessor.sha };
  migrationReleaseProof(root, record, owner);
  migrationPointers(root, owner, pointers);
  migrationVerifyReadyStores(root, record, migrationArtifactRead(root, record, "ready", owner));
  migrationLoad(pathname, root, expected);
  migrationPointers(root, owner, pointers);
  const nocowSummary = offlineNocowSummary(root, record);
  if (record.agentMigration.artifacts.reconciliation)
    migrationReconciledLive(root, record, migrationReadArtifact(root, record, "reconciliation"));
  unlinkSync(pathname);
  syncPath(dirname(pathname));
  // The bound stage, original witness and backups remain retained evidence.
  return `OK${nocowSummary}`;
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
  return {
    mode: config.tools.exec.mode,
    appServer: server,
    workspaceOnly: config.tools.fs.workspaceOnly,
    updateAuto: config.update.auto.enabled,
    clickclackCommandMenu: config.channels?.clickclack?.commandMenu,
    model,
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

function verifyStateCompatibility(databasePath, existing, candidate, inspectAgent, captured = [], beforeAgentRead) {
  const stateRoot = dirname(dirname(databasePath));
  const agents = new Map(), historicalRegistrations = new Set();
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
      for (const column of ["agent_id", "path", "schema_version"]) {
        if (!columns.has(column)) reject(`agent database registry is missing ${column}`);
      }
      const rows = database
        .prepare("SELECT agent_id, path, schema_version FROM agent_databases LIMIT 257")
        .all();
      if (rows.length > 256)
        reject("agent database registry exceeds the bounded compatibility budget");
      for (const row of rows) {
        if (
          typeof row.agent_id !== "string" ||
          !row.agent_id ||
          typeof row.path !== "string" ||
          !row.path ||
          !Number.isSafeInteger(row.schema_version) ||
          (row.schema_version !== candidate.agent && !(row.schema_version === 17 && existing.agent === 18 && candidate.agent === 18))
        ) {
          reject("registered agent database identity or schema is incompatible");
        }
        const pathname = isAbsolute(row.path) ? resolve(row.path) : resolve(stateRoot, row.path);
        if (!isAbsolute(row.path))
          safeRelative(realpathSync(stateRoot), realpathSync(dirname(pathname)));
        recordAgent(pathname, row.agent_id);
        // Doctor commits physical18 before separately registering it. This closed historical
        // hint is accepted only after the exact physical/meta18 owner proof below, never as a reader range.
        if (row.schema_version === 17 && candidate.agent === 18) historicalRegistrations.add(pathname);
      }
    }
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
        if (version !== existing.agent || version !== candidate.agent) {
          reject(`live agent database schema is incompatible: ${agentId}`);
        }
        const metadata = database
          .prepare("SELECT type FROM sqlite_master WHERE name = ?")
          .get("schema_meta");
        if (!metadata && capturedEntry) reject("captured database requires exact physical ownership metadata");
        if (!metadata && historicalRegistrations.has(pathname)) reject("historical registration requires exact physical18 ownership metadata");
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

function originalWitness(pathname, record, expected) {
  if (expected && (Object.hasOwn(record, "originalWitness") !== Object.hasOwn(expected, "originalWitness") ||
      !isDeepStrictEqual(record.originalWitness, expected.originalWitness)))
    reject("original session witness binding changed; activation evidence retained");
  if (record.gatewayRuntime || record.runtimeChange) runtimeJournalCheck(record, dirname(dirname(pathname)), expected);
  if (!Object.hasOwn(record, "originalWitness")) return undefined;
  const namespace = migrationNamespace(dirname(dirname(pathname)));
  if (pathname !== namespace.pathname) reject("original session witness journal path is not canonical");
  const journal = migrationFile(pathname, namespace.owner, { mode: 0o600, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(migrationJson(journal.bytes), record)) reject("original session witness journal changed before reading");
  const { name, ...descriptor } = record.originalWitness;
  const file = migrationFile(join(namespace.directory, name), namespace.owner, { mode: 0o600 });
  if (!isDeepStrictEqual(file.descriptor, { path: join(namespace.directory, name), ...descriptor }))
    reject("original session witness artifact changed; activation evidence retained");
  sessionWitnessTuples(migrationJson(file.bytes));
  const after = migrationFile(pathname, namespace.owner, { mode: 0o600, limit: migrationJournalLimit });
  if (!isDeepStrictEqual(after.descriptor, journal.descriptor)) reject("original session witness journal changed while reading");
  return file.bytes;
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
  let count = 0;
  return {
    record(tuple, ordinal, failure) {
      count += 1;
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
        process.stderr.write(`WARNING HISTORY_PRESERVATION_GAPS count=${count} shown=${diagnostics.length} historical-bytes=unverified continuation=allowed\n`);
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

function ownedJournal(pathname) {
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
  const record = validJournal(jsonFile(pathname));
  runtimeJournalCheck(record, dirname(dirname(pathname)));
  return record;
}

function recoveryEvidence(pathname, root, expected, position = "observed", configRequest) {
  if (!["observed", "restored", "selected"].includes(position))
    reject("unknown recovery pointer view");
  const restored = position === "restored",
    selected = position === "selected";
  const record = ownedJournal(pathname);
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
  const originalBytes = originalWitness(pathname, record, expected?.record);
  const snapshot = { record, identity: identity(pathname), releases };
  const reconciliation = expected?.configReconciliation ?? configRequest;
  if (reconciliation) {
    // An operator may accept one reviewed config replacement on an exact live release.
    // The historical journal stays intact; the new bytes and inode bind this recovery only.
    if (!(restored || selected) || !["ROLLBACK_FAILED", "C_CURRENT_SELECTED"].includes(record.phase) || record.topology !== "system" ||
        record.candidate.sha === record.predecessor.sha || !record.originalWitness || record.agentMigration || record.configMigration ||
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
    const journal = migrationFile(pathname, owner, { mode: 0o600 });
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
    const journal = migrationFile(pathname, owner, { mode: 0o600 });
    const { sha256, ...journalIdentity } = journal.descriptor;
    if (sha256 !== snapshot.configReconciliation.journalSha256 || !isDeepStrictEqual(journalIdentity, snapshot.identity))
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
        env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: remaining(30000), killSignal: "SIGKILL", maxBuffer: 65536,
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
      const readinessWaived = snapshotCpuWaived(input.readiness, true, "readiness");
      const channelsWaived = snapshotCpuWaived(input.channels, true, "channels");
      assert(input.readiness.ready === true && Array.isArray(input.readiness.failing) &&
        input.readiness.failing.length === 0 && Number.isFinite(input.readiness.uptimeMs) && input.readiness.uptimeMs >= 0);
      verifyChannelAccounts(input.channels);
      assert.equal(input.convergenceState, readinessWaived || channelsWaived ? "READY_CPU_DEGRADED_OPERATOR_WAIVED" : "READY");
      assert.equal(input.channelState, channelsWaived ? "CHANNELS_CPU_DEGRADED_OPERATOR_WAIVED" : "CHANNELS_OK");
      if (readinessWaived || channelsWaived) return { operation: record.operation, outcome: "ineligible-load" };
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

try {
  if (["suspension-prepare", "suspension-status", "suspension-recovery-status", "suspension-running"].includes(command)) {
    // Import the reviewed public protocol closure, never a mutable installed package.
    // Loading these verified bytes also avoids rereading a replaced module path.
    const bytes = readFileSync(suspensionContractPath);
    if (createHash("sha256").update(bytes).digest("hex") !== suspensionContractSha256)
      reject("Gateway suspension contract artifact hash changed");
    suspensionContract = await import(`data:text/javascript;base64,${bytes.toString("base64")}`);
  }
  let result;
  switch (command) {
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

    case "offline-doctor-inputs": {
      const { record } = migrationLoad(args[0], args[1], migrationArgument(args[2]));
      if (!record.offlineDoctor || record.agentMigration.phase !== "doctor-started" || migrationPermit(args[1])) reject("offline Doctor requires revoked start fence");
      const inventory = migrationReadArtifact(args[1], record, "inventory");
      if (!isDeepStrictEqual(migrationHashFile(inventory.config.path), inventory.config)) reject("offline Doctor changed protected config");
      result = "FENCED";
      break;
    }
    case "offline-recovery-position":
      result = offlineRecoveryPosition(args[0], args[1], migrationArgument(args[2]));
      break;
    case "offline-recovery-permit":
    case "offline-recovery-finish":
      result = offlineRecoveryCheck(args[0], args[1], migrationArgument(args[2]), args[3], command === "offline-recovery-finish");
      break;
    case "offline-doctor-preflight":
      result = JSON.stringify(offlinePreflight(args[0], args[1], migrationArgument(args[2]), args[3], args[4]));
      break;
    case "offline-doctor-intent":
      result = JSON.stringify(offlineDoctorIntent(args[0], args[1], migrationArgument(args[2]), args[3], args[4]));
      break;
    case "offline-doctor-log": {
      const record = offlineRequireFence(args[0], args[1], migrationArgument(args[2]), args[3]);
      offlineReadReport(args[1], record);
      result = migrationReadArtifact(args[1], record, "doctor").log;
      break;
    }
    case "offline-doctor-capture": {
      const expected = migrationArgument(args[2]);
      try {
        const record = offlineRequireFence(args[0], args[1], expected, args[3]);
        if (record.agentMigration.artifacts.nocow) { result = JSON.stringify(expected); break; }
        offlinePreDoctorBinding(args[1], record);
        const capture = offlineCapture(migrationReadArtifact(args[1], record, "inventory"), join(args[1], "releases", record.candidate.sha));
        offlinePreDoctorBinding(args[1], record);
        result = JSON.stringify(migrationAttachValue(args[0], args[1], expected, "nocow", capture));
      } catch (error) {
        offlineRecordFailure(args[0], args[1], 0, error);
        throw error;
      }
      break;
    }
    case "offline-doctor-verify":
      result = JSON.stringify(offlineDoctorVerify(args[0], args[1], migrationArgument(args[2]), args[3], args[4]));
      break;
    case "offline-doctor-accept-partial":
      if (args.length !== 4) reject("usage: offline-doctor-accept-partial JOURNAL ROOT EXPECTED_EVIDENCE_JSON PROC_ROOT");
      result = JSON.stringify(offlineAcceptPartial(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-nocow-summary":
      if (args.length !== 3) reject("usage: migration-nocow-summary JOURNAL ROOT EXPECTED_EVIDENCE_JSON");
      result = offlineNocowSummary(args[1], migrationLoad(args[0], args[1], migrationArgument(args[2])).record);
      break;
    case "offline-doctor-recover":
      result = JSON.stringify(offlineDoctorRecover(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-publication-recover":
      if (args.length !== 1) reject("usage: migration-publication-recover ROOT");
      result = migrationRecoverPublications(args[0]);
      break;
    case "migration-input-batch":
      if (args.length !== 0) reject("usage: migration-input-batch (bounded stdin request)");
      result = JSON.stringify(migrationReadRuntimeBatch(migrationJson(migrationReadBytes(0, migrationInputBatchBytes))));
      if (Buffer.byteLength(result) > migrationInputBatchBytes) reject("runtime input batch exceeds response budget");
      break;
    case "migration-rehearse":
      if (args.length !== 9) reject("usage: migration-rehearse JOURNAL ROOT EVIDENCE CONFIG DATABASE HOME UID GID DOCTOR_SECONDS");
      result = JSON.stringify(await migrationRehearse(args[0], args[1], migrationArgument(args[2]), ...args.slice(3)));
      break;
    case "migration-waive-rehearsal":
      if (args.length !== 5) reject("usage: migration-waive-rehearsal JOURNAL ROOT EVIDENCE CONFIG DATABASE");
      result = JSON.stringify(migrationWaiveRehearsal(args[0], args[1], migrationArgument(args[2]), args[3], args[4]));
      break;
    case "migration-preflight-check": {
      const { record } = migrationLoad(args[0], args[1], migrationArgument(args[2]));
      result = migrationCheckPreflight(args[1], record);
      break;
    }
    case "migration-abandon-evidence":
      if (args.length !== 3) reject("usage: migration-abandon-evidence JOURNAL ROOT CANDIDATE");
      result = JSON.stringify(migrationAbandonEvidence(...args));
      break;
    case "migration-abandon-snapshot":
      if (args.length !== 6) reject("usage: migration-abandon-snapshot JOURNAL ROOT CANDIDATE CONTROLLER_PID INSTANCE EVIDENCE");
      result = JSON.stringify(migrationAbandonSnapshot(...args.slice(0, 5), migrationArgument(args[5])));
      break;
    case "migration-abandon":
      if (args.length !== 6) reject("usage: migration-abandon JOURNAL ROOT CANDIDATE CONTROLLER_PID INSTANCE SNAPSHOT");
      result = migrationAbandon(...args.slice(0, 5), migrationArgument(args[5]));
      break;
    case "migration-rehearsal-inputs":
      if (args.length !== 4) reject("usage: migration-rehearsal-inputs JOURNAL ROOT EVIDENCE RUNTIME_UID");
      result = JSON.stringify(migrationRehearsalInputs(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-live-preflight":
      if (args.length !== 4) reject("usage: migration-live-preflight JOURNAL ROOT EVIDENCE CONTROLLER_PID");
      result = JSON.stringify(migrationLivePreflight(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-live-check":
      if (args.length !== 5) reject("usage: migration-live-check JOURNAL ROOT EVIDENCE RELEASE_FACTS CONTROLLER_PID");
      result = migrationLiveCheck(args[0], args[1], migrationArgument(args[2]), migrationArgument(args[3]), args[4]);
      break;
    case "migration-copy-check":
      if (args.length !== 1 && !(args.length === 2 && args[1] === "plan")) reject("usage: migration-copy-check COPY_MANIFEST [plan]");
      result = JSON.stringify(migrationCopyCheck(args[0], args[1] === "plan"));
      break;
    case "migration-workspaces": {
      if (args.length !== 1 || process.getuid() === 0) reject("usage: migration-workspaces RELEASE (runtime identity required)");
      const list = await configRepairSymbol(args[0], "workspace-dirs", "listAgentWorkspaceDirs");
      result = JSON.stringify(list(migrationJson(migrationReadBytes(0, migrationJsonLimit)), process.env));
      break;
    }
    case "config-repair-native":
      if (args.length < 3 || args.length > 4) reject("usage: config-repair-native RELEASE plan|commit|verify OWNER_INPUTS [ORIGINAL_PLAN]");
      {
        const payload = args[2] === "@stdin" ? migrationJson(migrationReadBytes(0, migrationJsonLimit)) : jsonFile(args[2]);
        result = JSON.stringify(await configRepairNative(args[0], args[1], args[3] ? jsonFile(args[3]) : payload.original, payload.inputs));
      }
      break;
    case "migration-config-apply":
      if (args.length !== 4) reject("usage: migration-config-apply JOURNAL ROOT EVIDENCE PROC_ROOT");
      result = JSON.stringify(configRepairApply(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-config-recovery-check": {
      const { record } = migrationLoad(args[0], args[1], migrationArgument(args[2]));
      configRepairRecoveryCheck(args[1], record);
      result = "OK";
      break;
    }
    case "migration-config-policy": {
      const { record } = migrationLoad(args[0], args[1], migrationArgument(args[2]));
      if (!migrationRecordProfile(record).config || record.agentMigration.phase !== "stores-verified")
        reject("config policy rebinding requires verified canonical stores");
      migrationVerifyReadyStores(args[1], record, migrationArtifactRead(args[1], record, "ready", migrationOwner()));
      result = JSON.stringify(policy(record.protectedPaths[0].path));
      break;
    }
    case "migration-record-kind":
      result = migrationRecordProfile(migrationLoad(args[0], args[1]).record).kind;
      break;
    case "migration-record-nocow":
      result = migrationRecordProfile(migrationLoad(args[0], args[1]).record).nocow ? "1" : "0";
      break;
    case "migration-cold-backup":
      if (args.length !== 6) reject("usage: migration-cold-backup JOURNAL ROOT EVIDENCE CONFIG DATABASE PROC_ROOT");
      result = JSON.stringify(await migrationColdBackup(args[0], args[1], migrationArgument(args[2]), ...args.slice(3)));
      break;
    case "migration-writers-stopped":
      if (args.length !== 4) reject("usage: migration-writers-stopped JOURNAL ROOT EVIDENCE PROC_ROOT");
      result = migrationWritersStopped(args[0], args[1], migrationArgument(args[2]), args[3]);
      break;
    case "migration-verify-stores":
      if (args.length !== 5) reject("usage: migration-verify-stores JOURNAL ROOT EVIDENCE CONFIG DATABASE");
      try {
        result = JSON.stringify(migrationVerifyStores(args[0], args[1], migrationArgument(args[2]), args[3], args[4]));
      } catch (error) {
        if (migrationLoad(args[0], args[1]).record.offlineDoctor) offlineRecordFailure(args[0], args[1], 0, error);
        throw error;
      }
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
    case "migration-permit-revoke":
      result = migrationRevokePermit(args[0], args[1], migrationArgument(args[2]));
      break;
    case "migration-permit-publish":
      if (args.length !== 4) reject("usage: migration-permit-publish JOURNAL ROOT EVIDENCE PROC_ROOT");
      result = JSON.stringify(migrationAllowPermit(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-permit-absent":
      if (migrationPermit(args[0])) reject("Gateway start permit still permits a reader");
      result = "FENCED";
      break;
    case "migration-kind": {
      if (args.length !== 2 && args.length !== 3) reject("usage: migration-kind BEFORE_INFO_JSON AFTER_INFO_JSON [CONFIG]");
      const config = args[2] ? jsonFile(args[2]) : undefined;
      result = migrationKind(migrationArgument(args[0]), migrationArgument(args[1]), config);
      if (result === "none" && config && configRepairKeys(config).length)
        result = migrationProfile(migrationArgument(args[0]), migrationArgument(args[1]), { kind: "config-codex-turn-idle" }).kind;
      break;
    }
    case "migration-guard-install":
      if (args.length !== 4) reject("usage: migration-guard-install FRAGMENT_PATH ROOT ROOT_UID ANCESTOR_BOUNDARY");
      result = JSON.stringify(migrationGuardInstall(...args));
      break;
    case "migration-guard-verify":
      if (args.length !== 4) reject("usage: migration-guard-verify GUARD_DESCRIPTOR_JSON CONDITIONS_JSON EXEC_CONDITION_EX_JSON ROOT");
      result = migrationGuardVerify(migrationArgument(args[0]), migrationArgument(args[1]), migrationArgument(args[2]), args[3]);
      break;
    case "migration-create":
      if (args.length !== 2 || args[1] !== "@stdin") reject("usage: migration-create ROOT @stdin");
      result = JSON.stringify(migrationCreate(args[0], migrationJson(migrationReadBytes(0, migrationJournalLimit))));
      break;
    case "migration-load":
      if (args.length !== 2) reject("usage: migration-load JOURNAL ROOT");
      result = JSON.stringify(migrationLoad(...args));
      break;
    case "migration-check":
      if (args.length !== 3) reject("usage: migration-check JOURNAL ROOT EXPECTED_EVIDENCE_JSON");
      migrationLoad(args[0], args[1], migrationArgument(args[2]));
      result = "OK";
      break;
    case "migration-status":
      if (args.length !== 2) reject("usage: migration-status JOURNAL ROOT");
      result = migrationStatus(...args);
      break;
    case "migration-reconcile-snapshot":
    case "migration-reconcile-commit":
      if (args.length !== 4) reject("usage: migration-reconcile-snapshot|commit JOURNAL ROOT EXPECTED_EVIDENCE_JSON REQUEST_OR_SNAPSHOT_JSON");
      result = JSON.stringify((command === "migration-reconcile-snapshot" ? migrationReconcileSnapshot : migrationReconcileCommit)(
        args[0], args[1], migrationArgument(args[2]), migrationArgument(args[3])));
      break;
    case "migration-reconcile-check":
      if (args.length !== 3) reject("usage: migration-reconcile-check JOURNAL ROOT EXPECTED_EVIDENCE_JSON");
      result = JSON.stringify(migrationReconcileCheck(args[0], args[1], migrationArgument(args[2])));
      break;
    case "migration-finish":
      if (args.length !== 3) reject("usage: migration-finish JOURNAL ROOT EXPECTED_EVIDENCE_JSON");
      result = migrationFinish(args[0], args[1], migrationArgument(args[2]));
      break;
    case "migration-artifact":
      if (args.length !== 4) reject("usage: migration-artifact JOURNAL ROOT EXPECTED_EVIDENCE_JSON KIND");
      result = JSON.stringify(migrationArtifact(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-advance-activation":
      if (args.length !== 4) reject("usage: migration-advance-activation JOURNAL ROOT EXPECTED_EVIDENCE_JSON B_PREVIOUS_PUBLISHED|C_CURRENT_SELECTED");
      result = JSON.stringify(migrationAdvanceActivation(args[0], args[1], migrationArgument(args[2]), args[3]));
      break;
    case "migration-transition":
      if (![4, 5].includes(args.length) || args[3] !== "@stdin") reject("usage: migration-transition JOURNAL ROOT EXPECTED_EVIDENCE_JSON @stdin [CONTROLLER_PID]");
      result = JSON.stringify(migrationTransition(args[0], args[1], migrationArgument(args[2]),
        migrationJson(migrationReadBytes(0, migrationJournalLimit)), args[4]));
      break;
    case "migration-session-proof":
    case "migration-original-witness": {
      if (args.length !== 3) reject(`usage: ${command} JOURNAL ROOT EXPECTED_EVIDENCE_JSON`);
      const expected = migrationArgument(args[2]);
      const { record } = migrationLoad(args[0], args[1], expected);
      const inventory = migrationReadArtifact(args[1], record, "inventory");
      migrationSourceSchemas(inventory, migrationRecordProfile(record));
      const bytes = migrationArtifactRead(args[1], record, "witness", migrationOwner());
      migrationLoad(args[0], args[1], expected);
      if (command === "migration-session-proof")
        result = inventory.coldBaseline ? "recovery-pre-doctor-already-target" : "original-pre-migration";
      else process.stdout.write(record.offlineDoctor ? JSON.stringify(offlineWitness(args[1], record)) : bytes);
      break;
    }
    case "user-manager-stopped":
      if (args.length !== 2) reject("usage: user-manager-stopped ANCESTOR_BOUNDARY RUNTIME_UID");
      result = assertUserManagerStopped(...args);
      break;
    case "maintenance-idle":
      if (args.length !== 1) reject("usage: maintenance-idle ANCESTOR_BOUNDARY");
      result = assertMaintenanceIdle(args[0]);
      break;
    case "snapshot-for-rehearsal":
      if (args.length !== 5) reject("usage: snapshot-for-rehearsal ROOT RELEASE CONFIG DATABASE LABEL");
      result = JSON.stringify(await snapshotForRehearsal(...args));
      break;
    case "verify-rehearsal-snapshot":
      if (args.length !== 4) reject("usage: verify-rehearsal-snapshot MANIFEST SOURCE_RELEASE CANDIDATE_RELEASE MANIFEST_SHA256");
      result = JSON.stringify(verifyRehearsalSnapshot(...args));
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
    case "audit-build": {
      const [
        base,
        rawRootUid,
        rawDeployUid,
        rawDeployGid,
        runtimeHome,
        rawFileOwner = rawDeployUid,
      ] = args;
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
      if (
        runtimeRelative === "" ||
        (!runtimeRelative.startsWith("../") && runtimeRelative !== "..")
      ) {
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
      result = "BUILD_OWNER_SAFE";
      break;
    }
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
      if (candidate.agent !== existing.agent)
        reject("candidate agent schema is incompatible with its predecessor");
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
      const waived = snapshotCpuWaived(payload, allowCpuDegraded, "channels");
      verifyChannelAccounts(payload);
      result = waived ? "CHANNELS_CPU_DEGRADED_OPERATOR_WAIVED" : "CHANNELS_OK";
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
      if (!Number.isFinite(startup.uptimeMs) || startup.uptimeMs < 0) {
        reject("Gateway startupz proof is malformed");
      }
      if (startupCode === "503" && startup.ok === false && startup.status === "starting") {
        if (typeof startup.pendingReason !== "string" || !startup.pendingReason) {
          reject("Gateway startupz recovery reason is malformed");
        }
        result = "RECOVERING";
        break;
      }
      if (startupCode !== "200" || startup.ok !== true || startup.status !== "started") {
        reject("Gateway startupz is not started");
      }
      const readinessWaived = snapshotCpuWaived(readiness, allowCpuDegraded, "readiness");
      const channelsWaived = snapshotCpuWaived(channels, allowCpuDegraded, "channels");
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
      });
      break;
    }
    case "suspension-handoff": {
      const response = jsonArgument(args[0]);
      suspensionObject(response, ["status", "suspensionId", "expiresAtMs"], "Gateway handoff result");
      if (
        response.status !== "armed" ||
        response.suspensionId !== suspensionToken(args[1], "expected handoff suspension") ||
        !Number.isSafeInteger(response.expiresAtMs) ||
        response.expiresAtMs !== integer(args[2], "expected handoff expiry") ||
        response.expiresAtMs <= Date.now() + 5_000
      )
        reject("Gateway handoff did not arm the exact unexpired suspension");
      result = "ARMED";
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
      const expectedId = args[1];
      const priorExpiry = args[2];
      if (!suspensionContract.validateGatewaySuspendPrepareResult(response))
        reject("Gateway suspension prepare result is malformed");
      if (response?.status === "busy") {
        const custody = suspensionWriteCustody(response);
        suspensionRetryDelay(response.retryAfterMs);
        const blockers = suspensionBlockers(response, "Gateway suspension busy result", custody);
        if (expectedId !== undefined) reject("owned Gateway suspension renewal became busy");
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
      if (expectedId !== undefined && response.suspensionId !== expectedId) {
        reject("renewed Gateway suspension identity changed");
      }
      if (
        priorExpiry !== undefined &&
        response.expiresAtMs <= integer(priorExpiry, "prior suspension expiry")
      ) {
        reject("renewed Gateway suspension expiry did not advance");
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
      rejectMigrationFallback(record);
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
    case "recovery-snapshot":
      rejectMigrationFallback(ownedJournal(args[0]));
      result = recoveryEvidence(args[0], args[1], undefined, args[3], args[4] ? jsonArgument(args[4]) : undefined);
      if (JSON.stringify(result.record) !== JSON.stringify(jsonArgument(args[2])))
        reject("recovery journal changed before classification");
      result = JSON.stringify(result);
      break;
    case "recovery-process": {
      const response = jsonArgument(args[0]);
      const { record } = jsonArgument(args[1]);
      rejectMigrationFallback(record);
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
      rejectMigrationFallback(ownedJournal(args[0]));
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
      ] = args;
      if (lstatSync(pathname, { throwIfNoEntry: false })) {
        rejectMigrationFallback(ownedJournal(pathname));
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
      const root = dirname(dirname(pathname));
      const evidence = Object.hasOwn(record, "agentMigration") ? migrationLoad(pathname, root) : undefined;
      if (evidence && !isDeepStrictEqual(evidence.record, record)) reject("migration phase journal changed");
      if (evidence && phase !== "ROLLBACK_FAILED")
        reject("migration activation phases require the evidence-bound migration helpers");
      record.phase = phase;
      validJournal(record);
      if (evidence) migrationUpdate(pathname, root, evidence, record);
      else atomicJson(pathname, record);
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
      sealTree(args[0]);
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
      rejectMigrationFallback(record);
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

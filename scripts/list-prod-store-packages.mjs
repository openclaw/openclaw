// Lists production store packages from lockfile data.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
const roots = Array.isArray(parsed) ? parsed : [parsed];
const specs = new Set();

// Seed only packages whose lockfile platform metadata matches this build. The
// `pnpm store add` that consumes this list exists solely to satisfy the offline
// `pnpm prune` that immediately follows, and that prune is already scoped to the
// target os/cpu (Dockerfile `--config.supportedArchitectures.*`). Seeding
// tarballs for other platforms is wasted network that can time out the build.
// We only drop packages this platform's prune also drops, so the seed stays a
// superset of what prune keeps and no needed package is lost. libc is left to
// prune (keeping all libc variants here only over-seeds, never under-seeds).
//
// `matchesList` mirrors npm/pnpm `checkList` (npm-install-checks): "any" always
// matches; "!x" denies value x; a list with positive entries requires a
// positive match; an all-negation list matches anything not explicitly denied.
function matchesList(value, list) {
  if (list.length === 1 && list[0] === "any") {
    return true;
  }
  let negated = 0;
  let match = false;
  for (const entry of list) {
    if (typeof entry !== "string") {
      continue;
    }
    if (entry.charAt(0) === "!") {
      negated += 1;
      if (entry.slice(1) === value) {
        return false;
      }
    } else if (entry === value) {
      match = true;
    }
  }
  return match || negated === list.length;
}

function matchesBuildPlatform(meta) {
  if (!meta) {
    return true;
  }
  if (Array.isArray(meta.os) && meta.os.length > 0 && !matchesList(process.platform, meta.os)) {
    return false;
  }
  if (Array.isArray(meta.cpu) && meta.cpu.length > 0 && !matchesList(process.arch, meta.cpu)) {
    return false;
  }
  return true;
}

function packageSpec(name, version) {
  if (!name || !version || typeof version !== "string") {
    return undefined;
  }
  const normalizedVersion = version.replace(/\(.+\)$/, "");
  if (
    normalizedVersion.startsWith("file:") ||
    normalizedVersion.startsWith("link:") ||
    normalizedVersion.startsWith("workspace:")
  ) {
    return undefined;
  }
  return `${name}@${normalizedVersion}`;
}

function packageSpecFromLockfileKey(key) {
  if (typeof key !== "string") {
    return undefined;
  }
  const normalizedKey = (key.startsWith("/") ? key.slice(1) : key).replace(/\(.+\)$/, "");
  const separator = normalizedKey.lastIndexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  return packageSpec(normalizedKey.slice(0, separator), normalizedKey.slice(separator + 1));
}

function visitListNode(node) {
  for (const dep of Object.values(node.dependencies ?? {})) {
    const name = dep.from || dep.name;
    const spec = packageSpec(name, dep.version);
    if (spec && dep.resolved?.startsWith("https://registry.npmjs.org/")) {
      specs.add(spec);
    }
    visitListNode(dep);
  }
}

function readLockfile() {
  const lockfilePath = path.join(process.cwd(), "pnpm-lock.yaml");
  if (!fs.existsSync(lockfilePath)) {
    return undefined;
  }
  return parse(fs.readFileSync(lockfilePath, "utf8"));
}

function addLockfilePackages(lockfile) {
  for (const key of Object.keys(lockfile?.packages ?? {})) {
    const spec = packageSpecFromLockfileKey(key);
    if (spec) {
      specs.add(spec);
    }
  }
}

function addSnapshotClosure(lockfile) {
  const snapshots = lockfile?.snapshots;
  const packages = lockfile?.packages;
  if (!snapshots || !packages) {
    return;
  }
  const pending = [...specs];
  const visited = new Set();
  while (pending.length > 0) {
    const spec = pending.pop();
    if (!spec || visited.has(spec)) {
      continue;
    }
    visited.add(spec);
    const snapshot = snapshots[spec];
    if (!snapshot) {
      continue;
    }
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {})) {
      const depSpec = packageSpec(name, typeof version === "string" ? version : version?.version);
      if (!depSpec || !packages[depSpec] || specs.has(depSpec)) {
        continue;
      }
      specs.add(depSpec);
      pending.push(depSpec);
    }
  }
}

for (const root of roots) {
  visitListNode(root);
}
const lockfile = readLockfile();
addSnapshotClosure(lockfile);
addLockfilePackages(lockfile);

const outputSpecs = [...specs].filter((spec) => matchesBuildPlatform(lockfile?.packages?.[spec]));
process.stdout.write(outputSpecs.toSorted((a, b) => a.localeCompare(b)).join("\n"));

import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
const roots = Array.isArray(parsed) ? parsed : [parsed];
const specs = new Set();

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

function buildNormalizedLockfileKeyMap(entries) {
  const map = new Map();
  for (const key of Object.keys(entries ?? {})) {
    const spec = packageSpecFromLockfileKey(key);
    if (!spec) {
      continue;
    }
    const keys = map.get(spec);
    if (keys) {
      keys.push(key);
    } else {
      map.set(spec, [key]);
    }
  }
  return map;
}

function lockfileEntriesForSpec(entries, keyMap, spec) {
  const keys = new Set();
  if (entries?.[spec]) {
    keys.add(spec);
  }
  for (const key of keyMap.get(spec) ?? []) {
    if (entries?.[key]) {
      keys.add(key);
    }
  }
  return [...keys].map((key) => entries[key]);
}

function snapshotDependencyEntries(snapshot) {
  return Object.entries({
    ...snapshot.dependencies,
    ...snapshot.optionalDependencies,
  });
}

function addSnapshotClosure(lockfile) {
  const snapshots = lockfile?.snapshots;
  const packages = lockfile?.packages;
  if (!snapshots || !packages) {
    return;
  }
  const snapshotKeys = buildNormalizedLockfileKeyMap(snapshots);
  const packageKeys = buildNormalizedLockfileKeyMap(packages);
  const pending = [...specs];
  const visited = new Set();
  while (pending.length > 0) {
    const spec = pending.pop();
    if (!spec || visited.has(spec)) {
      continue;
    }
    visited.add(spec);
    const matchingSnapshots = lockfileEntriesForSpec(snapshots, snapshotKeys, spec);
    if (matchingSnapshots.length === 0) {
      continue;
    }
    for (const snapshot of matchingSnapshots) {
      for (const [name, version] of snapshotDependencyEntries(snapshot)) {
        const depSpec = packageSpec(name, typeof version === "string" ? version : version?.version);
        if (
          !depSpec ||
          lockfileEntriesForSpec(packages, packageKeys, depSpec).length === 0 ||
          specs.has(depSpec)
        ) {
          continue;
        }
        specs.add(depSpec);
        pending.push(depSpec);
      }
    }
  }
}

for (const root of roots) {
  visitListNode(root);
}
const lockfile = readLockfile();
addSnapshotClosure(lockfile);

process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));

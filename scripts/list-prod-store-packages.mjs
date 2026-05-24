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
addSnapshotClosure(readLockfile());

process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));

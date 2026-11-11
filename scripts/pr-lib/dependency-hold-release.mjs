import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANCHOR_PREFIX,
  dependencyCacheRoot,
  dependencyHoldState,
  readDependencyHolds,
  releaseFinishedAnchor,
} from "./cache-lifetime.mjs";

const confirmation = "--confirmed-no-running-tools";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const creatorPid = (path) =>
  Number(basename(path).match(/^openclaw-pr-anchor-v3\.([0-9]+)\./)?.[1]);

function processScan() {
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: Infinity,
      timeout: 30_000,
    });
    if (result.error || result.status !== 0 || !result.stdout.trim()) {
      throw new Error(`Unable to inspect processes; check ${command} before retrying`);
    }
    return result.stdout;
  };
  const processes = new Map();
  for (const line of run("ps", ["axww", "-o", "pid=,ppid=,pgid=,uid=,command="]).split("\n")) {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (row) {
      const [, pid, ppid, pgid, uid, command] = row;
      processes.set(Number(pid), {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        uid: Number(uid),
        command,
      });
    }
  }
  if (!processes.has(process.pid)) {
    throw new Error("Unable to parse process census");
  }
  const ancestors = new Set();
  for (let pid = process.pid; pid && !ancestors.has(pid); pid = processes.get(pid)?.ppid) {
    ancestors.add(pid);
  }
  const files = [];
  let pid;
  for (const field of run("lsof", ["-nP", "-Fpn0"]).split("\0")) {
    const record = field.replace(/^\n/, "");
    if (record.startsWith("p")) {
      pid = Number(record.slice(1));
    }
    if (record.startsWith("n") && pid && /openclaw-pr-anchor-v3\.|[a-f0-9]{64}/.test(record)) {
      files.push({ pid, name: record.slice(1) });
    }
  }
  return { processes, ancestors, files };
}

function evidence(hold, scan) {
  const { anchor, created, entriesIntact } = dependencyHoldState(hold);
  const creatorId = creatorPid(hold.path);
  const creator = scan.processes.get(creatorId);
  const blockers = [];
  if (creator?.uid === process.getuid()) {
    blockers.push("creator-live");
  }
  if (
    [...scan.processes.values()].some((p) => p.uid === process.getuid() && p.pgid === creatorId)
  ) {
    blockers.push("process-group-live");
  }
  const targets = [basename(hold.path), ...hold.holds.map(({ key }) => key)];
  const references = [];
  const match = (pid, via, text) => {
    for (const target of targets) {
      if (
        text.includes(target) &&
        !references.some((r) => r.pid === pid && r.via === via && r.target === target)
      ) {
        references.push({
          pid,
          via,
          target,
          command: (scan.processes.get(pid)?.command ?? "").slice(0, 160),
        });
      }
    }
  };
  for (const p of scan.processes.values()) {
    if (!scan.ancestors.has(p.pid)) {
      match(p.pid, "argv", p.command);
    }
  }
  for (const file of scan.files) {
    match(file.pid, "open-file", file.name);
  }
  if (references.length) {
    blockers.push("process-references");
  }
  if (anchor === "changed") {
    blockers.push("anchor-identity-changed");
  }
  if (!entriesIntact) {
    blockers.push("entry-identity-changed");
  }
  return {
    evidence: {
      anchor,
      ...(created ? { created } : {}),
      creatorPid: creatorId,
      creator: creator ? (creator.uid === process.getuid() ? "live" : "foreign-uid") : "gone",
      references,
    },
    blockers,
  };
}

function validatePlan(plan) {
  const identity = (value) =>
    value &&
    ["dev", "ino", "uid", "mode"].every(
      (key) => typeof value[key] === "string" && /^[0-9]+$/.test(value[key]),
    );
  const anchor = (value) =>
    identity(value) &&
    typeof value.path === "string" &&
    isAbsolute(value.path) &&
    basename(value.path).startsWith(ANCHOR_PREFIX) &&
    creatorPid(value.path) > 0 &&
    Array.isArray(value.holds) &&
    value.holds.length > 0 &&
    value.holds.every(
      (entry) =>
        identity(entry) && typeof entry.key === "string" && /^[a-f0-9]{64}$/.test(entry.key),
    ) &&
    new Set(value.holds.map(({ key }) => key)).size === value.holds.length;
  if (
    plan?.version !== 1 ||
    plan.cache !== dependencyCacheRoot() ||
    !Array.isArray(plan.anchors) ||
    !Array.isArray(plan.blocked) ||
    ![...plan.anchors, ...plan.blocked].every(anchor)
  ) {
    throw new Error("Invalid PR dependency hold release plan");
  }
}

function main(args) {
  if (args[0] !== "--dry-run" && !args.includes(confirmation)) {
    console.error(
      "Release requires --confirmed-no-running-tools after checking for detached PR tools.",
    );
    return 2;
  }
  if (args[0] === "--dry-run") {
    const selected = [];
    for (let index = 1; index < args.length; index += 2) {
      if (args[index] !== "--anchor" || !args[index + 1]) {
        throw new Error("Expected --anchor <path>");
      }
      selected.push(args[index + 1]);
    }
    // One census per run, outside the metadata mutex. Same-uid PID reuse is an accepted false block.
    const scan = processScan();
    const { cache, holds } = readDependencyHolds();
    for (const path of selected) {
      if (!holds.some((hold) => hold.path === path)) {
        throw new Error(`No dependency hold for anchor: ${path}`);
      }
    }
    const counts = new Map();
    for (const hold of holds) {
      for (const { key } of hold.holds) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const plan = { version: 1, cache, anchors: [], blocked: [] };
    for (const hold of holds.filter((item) => !selected.length || selected.includes(item.path))) {
      const checked = evidence(hold, scan);
      const blocked = checked.blockers.length > 0;
      const item = { ...hold, evidence: checked.evidence };
      (blocked ? plan.blocked : plan.anchors).push(
        blocked ? { ...item, blockers: checked.blockers } : item,
      );
      console.error(
        `${blocked ? "blocked" : "release"} ${hold.path} entries=${hold.holds.map(({ key }) => `${key.slice(0, 12)}(holds=${counts.get(key)})`).join(",")} created=${checked.evidence.created ?? "-"} anchor=${checked.evidence.anchor} creator=${checked.evidence.creator} references=${checked.evidence.references.length} blockers=${checked.blockers.join(",") || "none"}`,
      );
    }
    const releasedCounts = new Map();
    for (const anchor of plan.anchors) {
      for (const { key } of anchor.holds) {
        releasedCounts.set(key, (releasedCounts.get(key) ?? 0) + 1);
      }
    }
    const settling = [...releasedCounts].filter(([key, count]) => count === counts.get(key)).length;
    const bytes = `${JSON.stringify(plan, null, 2)}\n`;
    const seal = hash(bytes);
    console.error(
      `Anchors: ${plan.anchors.length} releasable, ${plan.blocked.length} blocked; entries settling: ${settling}`,
    );
    console.error(`SHA-256: ${seal}`);
    console.error(
      `scripts/pr dependency-hold-release plan.json --plan-sha256 ${seal} ${confirmation}`,
    );
    process.stdout.write(bytes);
    return 0;
  }
  if (args.length !== 4 || args[1] !== "--plan-sha256" || args[3] !== confirmation) {
    throw new Error(`Expected <plan.json> --plan-sha256 <SHA256> ${confirmation}`);
  }
  const bytes = readFileSync(args[0]);
  if (!/^[a-f0-9]{64}$/.test(args[2]) || hash(bytes) !== args[2]) {
    throw new Error("PR dependency hold release plan seal differs");
  }
  const plan = JSON.parse(bytes);
  validatePlan(plan);
  const { holds } = readDependencyHolds();
  let failed = false;
  for (const anchor of plan.anchors) {
    // Rescan per anchor: removal can stall long enough to stale a batch-wide snapshot. This stays
    // outside the metadata mutex, which other wrappers wait on for at most one second. A failed
    // scan aborts the batch; earlier outcomes already printed stand.
    const scan = processScan();
    let result;
    try {
      const current = holds.some(
        (hold) => hold.path === anchor.path && hold.dev === anchor.dev && hold.ino === anchor.ino,
      );
      const checked = current ? evidence(anchor, scan) : { blockers: [] };
      result = checked.blockers.length
        ? { state: "blocked", blockers: checked.blockers }
        : releaseFinishedAnchor(anchor);
    } catch (error) {
      result = { state: "refused", reason: error.message };
    }
    process.stdout.write(`${JSON.stringify({ path: anchor.path, ...result })}\n`);
    if (result.state !== "released" && result.state !== "already-released") {
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`PR dependency hold release refused: ${error.message}`);
    process.exitCode = 1;
  }
}

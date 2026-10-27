import fs from "node:fs/promises";
import path from "node:path";

const processLimit = 32;
const threadLimit = 16;
const descriptorLimit = 64;
const outputLimit = 12_000;

async function readProc(file, limit = 4096) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function entries(directory, limit) {
  try {
    return (await fs.readdir(directory))
      .filter((value) => /^\d+$/u.test(value))
      .toSorted((a, b) => Number(a) - Number(b))
      .slice(0, limit);
  } catch {
    return null;
  }
}

function procIdentity(text) {
  const fields = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  if (!/^[A-Z]$/u.test(fields[0] ?? "") || !/^\d+$/u.test(fields[19] ?? "")) {
    return null;
  }
  return { state: fields[0], parentPid: Number(fields[1]), started: fields[19] };
}

function counter(text, name) {
  const value = text.match(new RegExp(`^${name}:\\s+(\\d+)$`, "mu"))?.[1];
  const number = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function role(command) {
  const args = command.split("\0");
  const files = new Set(args.map((arg) => path.basename(arg)));
  if (files.has("update-candidate-state.worker.js")) {
    return "snapshot-worker";
  }
  if (files.has("update-migrated-finalize.worker.js")) {
    return "candidate-finalizer";
  }
  if (args.some((arg) => /^npm(?:\s|$)/u.test(arg))) {
    return "npm";
  }
  if (args.includes("doctor") || args[0]?.startsWith("openclaw-doctor")) {
    return "doctor";
  }
  if (args.includes("gateway") || args[0]?.startsWith("openclaw-gateway")) {
    return "gateway";
  }
  if (args.includes("update") || args[0]?.startsWith("openclaw-update")) {
    return "updater";
  }
  return "child";
}

async function threadWait(pid, tid) {
  const root = `/proc/${pid}/task/${tid}`;
  const wait = (await readProc(`${root}/wchan`, 128)).trim();
  const syscall = (await readProc(`${root}/syscall`, 256)).trim().split(/\s+/u)[0];
  const number = /^\d+$/u.test(syscall ?? "") ? Number(syscall) : null;
  const syncCalls = process.arch === "arm64" ? [82, 83] : process.arch === "x64" ? [74, 75] : [];
  return {
    tid: Number(tid),
    wait: /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/u.test(wait) ? wait : "unavailable",
    syscall: number,
    fsync: (number !== null && syncCalls.includes(number)) || /fsync/u.test(wait),
  };
}

async function copyFiles(pid) {
  const files = new Map();
  let copying = false;
  const descriptors = await entries(`/proc/${pid}/fd`, descriptorLimit + 1);
  let filesComplete = descriptors !== null && descriptors.length <= descriptorLimit;
  for (const fd of (descriptors ?? []).slice(0, descriptorLimit)) {
    let target;
    try {
      target = await fs.readlink(`/proc/${pid}/fd/${fd}`);
    } catch {
      filesComplete = false;
      continue;
    }
    // Observe the old driver's private copy handles without walking its plugin tree.
    if (!/\/openclaw-update-canary-[^/]+\/\.plugin-copy-[^/]+(?:\/|$)/u.test(target)) {
      continue;
    }
    copying = true;
    if (!/\/(?:payload|\.fs-safe-[^/]+\.tmp)$/u.test(target)) {
      continue;
    }
    const info = await readProc(`/proc/${pid}/fdinfo/${fd}`);
    const inode = counter(info, "ino");
    const mount = counter(info, "mnt_id");
    const position = counter(info, "pos");
    if (inode !== null && mount !== null && position !== null) {
      // A descriptor can close or be reused while /proc is read.
      try {
        if ((await fs.readlink(`/proc/${pid}/fd/${fd}`)) !== target) {
          filesComplete = false;
          continue;
        }
      } catch {
        filesComplete = false;
        continue;
      }
      const id = `${mount}:${inode}`;
      files.set(id, Math.max(files.get(id) ?? 0, position));
    } else {
      filesComplete = false;
    }
  }
  return { files: [...files].map(([id, position]) => ({ id, position })), copying, filesComplete };
}

/** Read only the timed child's descendants; never emit argv, environment, or file contents. */
export async function captureUpdateProcesses(rootPid) {
  const at = Date.now();
  const processes = [];
  const pending = [{ pid: rootPid, parentPid: null }];
  const seen = new Set();
  while (pending.length && processes.length < processLimit) {
    const next = pending.shift();
    if (seen.has(next.pid)) {
      continue;
    }
    seen.add(next.pid);
    const root = `/proc/${next.pid}`;
    const identity = procIdentity(await readProc(`${root}/stat`));
    if (!identity || (next.parentPid !== null && identity.parentPid !== next.parentPid)) {
      continue;
    }
    const kind = role(await readProc(`${root}/cmdline`, 16_384));
    const waits = [];
    for (const tid of (await entries(`${root}/task`, threadLimit)) ?? []) {
      waits.push(await threadWait(next.pid, tid));
    }
    const copy =
      kind === "snapshot-worker"
        ? await copyFiles(next.pid)
        : { files: [], copying: false, filesComplete: false };
    const writtenBytes = counter(await readProc(`${root}/io`), "wchar");
    const children = (await readProc(`${root}/task/${next.pid}/children`)).match(/\d+/gu) ?? [];
    const current = procIdentity(await readProc(`${root}/stat`));
    if (current?.started !== identity.started || current.parentPid !== identity.parentPid) {
      continue;
    }
    processes.push({ pid: next.pid, ...identity, role: kind, waits, ...copy, writtenBytes });
    for (const child of children.slice(0, processLimit)) {
      pending.push({ pid: Number(child), parentPid: next.pid });
    }
  }
  return { at, processes, truncated: pending.length > 0 };
}

/** Format sampled evidence, not an inferred failure cause from empty updater output. */
export function formatUpdateTimeoutDiagnostics(samples, now = Date.now()) {
  const latest = samples.at(-1);
  const lines = ["Update interruption diagnostics (last observed child tree):"];
  if (!latest?.processes.length) {
    return `${lines[0]}\nsubphase unknown; process observation unavailable; progress unknown\n`;
  }
  const age = Math.max(0, (now - latest.at) / 1000).toFixed(1);
  const summary = [
    `Last sample ${age}s ago; at most ${processLimit} processes and ${threadLimit} threads per process.`,
  ];
  const snapshot =
    latest.processes.find((entry) => entry.role === "snapshot-worker" && entry.copying) ??
    latest.processes.find((entry) => entry.role === "snapshot-worker");
  const history = snapshot
    ? samples.flatMap((sample) => {
        const entry = sample.processes.find(
          (item) => item.pid === snapshot.pid && item.started === snapshot.started && item.copying,
        );
        return entry ? [{ at: sample.at, entry }] : [];
      })
    : [];
  let progress = "unknown";
  if (snapshot && history.length >= 2) {
    const first = history[0];
    const last = history.at(-1);
    const firstFiles = new Map(first.entry.files.map((file) => [file.id, file.position]));
    const observedFiles = new Set(
      history.flatMap(({ entry }) => entry.files.map((file) => file.id)),
    );
    const newFiles = [...observedFiles].filter((id) => !firstFiles.has(id)).length;
    const fileBytes = last.entry.files.reduce(
      (sum, file) => sum + Math.max(0, file.position - (firstFiles.get(file.id) ?? file.position)),
      0,
    );
    const ioBytes =
      first.entry.writtenBytes === null || last.entry.writtenBytes === null
        ? null
        : last.entry.writtenBytes - first.entry.writtenBytes;
    // Missing or clipped handles cannot establish whether a later inode is new.
    const comparableFiles =
      first.entry.filesComplete &&
      last.entry.filesComplete &&
      first.entry.files.length > 0 &&
      last.entry.files.length > 0;
    if (comparableFiles && (newFiles > 0 || fileBytes > 0)) {
      progress = "continuing";
    } else if (
      comparableFiles &&
      ioBytes === 0 &&
      last.at > first.at &&
      last.at === latest.at &&
      last.entry.files.every((file) => firstFiles.get(file.id) === file.position)
    ) {
      progress = "stalled";
    }
    summary.push(
      `Copy observation over ${((latest.at - first.at) / 1000).toFixed(1)}s (last copy handle ${(latest.at - last.at) / 1000}s ago): sampled new file handles=${newFiles}, same-file position bytes=+${fileBytes}, worker write bytes=${ioBytes === null || ioBytes < 0 ? "unavailable" : `+${ioBytes}`}. File handles are a lower bound, not a completed-file inventory.`,
    );
    if (!comparableFiles) {
      summary.push(
        "File progress unavailable: descriptor observations are incomplete or lack comparable payload handles.",
      );
    }
  }
  let verdict;
  if (snapshot?.copying) {
    const fsync = snapshot.waits.some((wait) => wait.fsync);
    verdict = `published-driver plugin snapshot copy${fsync ? " fsync-bound" : "; wait not identified as fsync"}; progress ${progress}`;
  } else {
    verdict = `subphase ${snapshot ? "snapshot worker (copy not observed)" : "unknown"}; progress unknown`;
  }
  for (const entry of latest.processes) {
    const main = entry.waits.find((wait) => wait.tid === entry.pid);
    lines.push(
      `pid=${entry.pid} ppid=${entry.parentPid} role=${entry.role} state=${entry.state} wait=${main?.wait ?? "unavailable"} syscall=${main?.syscall ?? "unavailable"}`,
    );
    for (const wait of entry.waits.filter((item) => item.fsync && item.tid !== entry.pid)) {
      lines.push(
        `  tid=${wait.tid} wait=${wait.wait} syscall=${wait.syscall ?? "unavailable"} fsync`,
      );
    }
  }
  if (latest.truncated) {
    lines.push("Process tree truncated at the observation limit.");
  }
  let output = "";
  const truncated = "Diagnostic output truncated.\n";
  // The lane prints log tails; keep progress and its age beside the verdict.
  const suffix = `${[...summary, verdict].join("\n")}\n`;
  for (const line of lines) {
    if (
      Buffer.byteLength(output) +
        Buffer.byteLength(line) +
        1 +
        truncated.length +
        Buffer.byteLength(suffix) >
      outputLimit
    ) {
      output += truncated;
      break;
    }
    output += `${line}\n`;
  }
  return output + suffix;
}

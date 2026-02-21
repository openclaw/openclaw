#!/usr/bin/env node
import { readdir, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function parseArgs(argv) {
  return { json: argv.includes("--json") };
}

async function safeList(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries;
  } catch {
    return [];
  }
}

async function safeStat(file) {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

async function gather() {
  const home = os.homedir();
  const stateDir = path.join(home, ".openclaw", "state");
  const memDir = path.join(home, ".openclaw", "workspace", "memory");
  const heartbeat = path.join(home, ".openclaw", "workspace", "HEARTBEAT.md");

  const stateEntries = await safeList(stateDir);
  const memEntries = await safeList(memDir);

  const now = Date.now();
  const recent48h = [];
  for (const e of memEntries) {
    if (!e.isFile()) {
      continue;
    }
    const fp = path.join(memDir, e.name);
    const st = await safeStat(fp);
    if (st && now - st.mtimeMs <= 48 * 60 * 60 * 1000) {
      recent48h.push({ file: e.name, mtimeMs: st.mtimeMs });
    }
  }

  const logCandidates = [];
  for (const e of stateEntries) {
    if (!e.isFile()) {
      continue;
    }
    if (!e.name.toLowerCase().includes("log")) {
      continue;
    }
    const fp = path.join(stateDir, e.name);
    const st = await safeStat(fp);
    if (st) {
      logCandidates.push({ file: e.name, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  logCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const hbStat = await safeStat(heartbeat);
  let heartbeatPreview = null;
  if (hbStat) {
    const txt = await readFile(heartbeat, "utf8").catch(() => "");
    heartbeatPreview = txt.trim().split("\n").slice(0, 2).join(" ");
  }

  return {
    paths: { stateDir, memDir, heartbeat },
    stateFileCount: stateEntries.filter((e) => e.isFile()).length,
    stateDirCount: stateEntries.filter((e) => e.isDirectory()).length,
    memoryFileCount: memEntries.filter((e) => e.isFile()).length,
    memoryRecent48h: recent48h
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
      .map((x) => ({ file: x.file, modifiedAt: new Date(x.mtimeMs).toISOString() })),
    heartbeat: hbStat
      ? {
          exists: true,
          modifiedAt: new Date(hbStat.mtimeMs).toISOString(),
          preview: heartbeatPreview,
        }
      : { exists: false },
    logs: logCandidates
      .slice(0, 5)
      .map((x) => ({ file: x.file, modifiedAt: new Date(x.mtimeMs).toISOString(), size: x.size })),
  };
}

function printHuman(data) {
  console.log("Ops Board Snapshot");
  console.log(`state: ${data.stateFileCount} files, ${data.stateDirCount} dirs`);
  console.log(
    `memory: ${data.memoryFileCount} files (${data.memoryRecent48h.length} modified in last 48h)`,
  );
  console.log(`heartbeat: ${data.heartbeat.exists ? "present" : "missing"}`);
  if (data.heartbeat.exists) {
    console.log(`heartbeat preview: ${data.heartbeat.preview || "(empty)"}`);
  }
  if (data.logs.length) {
    console.log("latest logs:");
    for (const l of data.logs) {
      console.log(`- ${l.file} (${l.size} bytes)`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const data = await gather();
  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printHuman(data);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

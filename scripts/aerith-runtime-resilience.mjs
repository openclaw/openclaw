#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_WORKSPACE = "/home/node/.openclaw/workspace";
const DEFAULT_OPENCLAW_HOME = "/home/node/.openclaw";

export function nativeHookRelayBridgeDir(uid = typeof process.getuid === "function" ? process.getuid() : "nouid") {
  return path.join(os.tmpdir(), `openclaw-native-hook-relays-${uid}`);
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function portIsReachable(host, port, timeoutMs = 250) {
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return false;
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function inspectNativeHookRelayRecords(options = {}) {
  const bridgeDir = options.bridgeDir ?? nativeHookRelayBridgeDir(options.uid);
  const now = options.nowMs ?? Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(bridgeDir).filter((name) => name.endsWith(".json"));
  } catch {
    return { bridgeDir, records: [], summary: { total: 0, alive: 0, stale: 0 } };
  }

  const records = [];
  for (const name of entries) {
    const file = path.join(bridgeDir, name);
    const record = readJsonFile(file);
    const pidAlive = pidIsAlive(record?.pid);
    const expired = typeof record?.expiresAtMs === "number" ? now > record.expiresAtMs : true;
    const reachable = await portIsReachable(record?.hostname, record?.port);
    records.push({
      file,
      relayId: typeof record?.relayId === "string" ? record.relayId : undefined,
      pid: record?.pid,
      pidAlive,
      hostname: record?.hostname,
      port: record?.port,
      portReachable: reachable,
      expiresAtMs: record?.expiresAtMs,
      expired,
      stale: expired || !pidAlive || !reachable,
    });
  }
  return {
    bridgeDir,
    records,
    summary: {
      total: records.length,
      alive: records.filter((record) => !record.stale).length,
      stale: records.filter((record) => record.stale).length,
    },
  };
}

export function inspectMemory(workspaceDir = DEFAULT_WORKSPACE) {
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  let bytes = 0;
  try {
    bytes = fs.statSync(memoryPath).size;
  } catch {
    return { memoryPath, exists: false, bytes: 0, bootstrapRisk: "missing" };
  }
  return {
    memoryPath,
    exists: true,
    bytes,
    bootstrapRisk: bytes > 250_000 ? "critical" : bytes > 100_000 ? "high" : "normal",
    recommendation:
      bytes > 100_000
        ? "split into active memory, historical archive, and retrieval index"
        : "keep current bootstrap path",
  };
}

export function inspectCodexBinding(openclawHome = DEFAULT_OPENCLAW_HOME, sessionId) {
  const sessionsDir = path.join(openclawHome, "agents/main/sessions");
  const candidates = sessionId
    ? [path.join(sessionsDir, `${sessionId}.jsonl.codex-app-server.json`)]
    : fs
        .readdirSync(sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl.codex-app-server.json"))
        .map((entry) => path.join(sessionsDir, entry.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
        .slice(0, 5);
  return candidates.map((file) => {
    const parsed = readJsonFile(file);
    return {
      file,
      threadId: parsed?.threadId,
      updatedAt: parsed?.updatedAt,
      hasNativeHookRelayGeneration:
        typeof parsed?.nativeHookRelayGeneration === "string" &&
        parsed.nativeHookRelayGeneration.trim().length > 0,
      nativeHookRelayGeneration: parsed?.nativeHookRelayGeneration,
    };
  });
}

export function inspectInstalledCodex(openclawHome = DEFAULT_OPENCLAW_HOME) {
  const distDir = path.join(openclawHome, "npm/node_modules/@openclaw/codex/dist");
  const runAttempt = path.join(distDir, "run-attempt-CRHVB240.js");
  const threadLifecycle = path.join(distDir, "thread-lifecycle-Cgi62SSl.js");
  const files = [runAttempt, threadLifecycle];
  const contents = files
    .map((file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  return {
    distDir,
    exists: fs.existsSync(distDir),
    persistsNativeHookRelayGeneration: contents.includes("nativeHookRelayGeneration"),
  };
}

export async function diagnose(options = {}) {
  const workspaceDir = options.workspaceDir ?? DEFAULT_WORKSPACE;
  const openclawHome = options.openclawHome ?? DEFAULT_OPENCLAW_HOME;
  const [relay, memory] = await Promise.all([
    inspectNativeHookRelayRecords(options),
    Promise.resolve(inspectMemory(workspaceDir)),
  ]);
  const bindings = inspectCodexBinding(openclawHome, options.sessionId);
  const installedCodex = inspectInstalledCodex(openclawHome);
  const findings = [];
  if (relay.summary.stale > 0) {
    findings.push("stale_native_hook_relay_records");
  }
  if (bindings.some((binding) => !binding.hasNativeHookRelayGeneration)) {
    findings.push("codex_binding_missing_native_hook_relay_generation");
  }
  if (installedCodex.exists && !installedCodex.persistsNativeHookRelayGeneration) {
    findings.push("installed_codex_runtime_lacks_native_hook_relay_generation_persistence");
  }
  if (memory.bootstrapRisk === "critical" || memory.bootstrapRisk === "high") {
    findings.push("memory_bootstrap_payload_too_large");
  }
  return {
    ok: findings.length === 0,
    checkedAt: new Date().toISOString(),
    findings,
    relay,
    bindings,
    installedCodex,
    memory,
  };
}

function printHuman(report) {
  console.log(`AERITH_RUNTIME_RESILIENCE_DIAG=${report.ok ? "OK" : "ATTENTION"}`);
  console.log(`findings=${report.findings.join(",") || "none"}`);
  console.log(`relay_records=${report.relay.summary.total} alive=${report.relay.summary.alive} stale=${report.relay.summary.stale}`);
  console.log(`memory_bytes=${report.memory.bytes} bootstrap_risk=${report.memory.bootstrapRisk}`);
  console.log(`installed_codex_generation_persistence=${report.installedCodex.persistsNativeHookRelayGeneration}`);
  for (const binding of report.bindings) {
    console.log(
      `binding=${path.basename(binding.file)} thread=${binding.threadId ?? "unknown"} generation=${binding.hasNativeHookRelayGeneration ? "present" : "missing"}`,
    );
  }
}

async function main() {
  const json = process.argv.includes("--json");
  const sessionArgIndex = process.argv.indexOf("--session-id");
  const sessionId = sessionArgIndex >= 0 ? process.argv[sessionArgIndex + 1] : undefined;
  const report = await diagnose({ sessionId });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

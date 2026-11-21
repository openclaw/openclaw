// Run with a shipped host and built plugin directories; no production state is used:
// node --import tsx scripts/prove-memory-wiki-diagnostics-upgrade.mts \
//   <released-host-entry.mjs> <candidate-host-entry.mjs> <pre-repair-plugin-dir> <candidate-plugin-dir> <output.json> [pages=12000]
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { listDirectoryTreeStrict } from "../src/infra/directory-walk.ts";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import { createGatewayBenchEnv } from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

function requiredArg(index: number): string {
  const value = process.argv[index + 2];
  assert(
    value,
    "Expected released host, candidate host, pre-repair plugin, candidate plugin, output",
  );
  return value;
}
const entry = requiredArg(0);
const candidateEntry = requiredArg(1);
const brokenPlugin = requiredArg(2);
const candidatePlugin = requiredArg(3);
const output = requiredArg(4);
const pagesRaw = process.argv[7] ?? "12000";
const pages = Number(pagesRaw);
assert(Number.isInteger(pages) && pages > 0);
const port = await getFreePort();
// openclaw-temp-dir: allow this command owns an isolated upgrade fixture and Gateway processes.
const root = await fs.mkdtemp(path.join(tmpdir(), "wiki-diagnostic-upgrade-"));
const home = path.join(root, "server");
const vault = path.join(home, "wiki");
const workspace = path.join(home, "workspace");
const configPath = path.join(home, "openclaw.json");
const token = "synthetic-wiki-diagnostics-proof-token";
const records: Array<Record<string, unknown>> = [];
let child: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let currentLog = "";
let phase = "";
let complete = false;
const preservation: Record<string, unknown> = {};
const pluginSettings = {
  vaultMode: "bridge",
  vault: { path: vault, renderMode: "native" },
  bridge: {
    enabled: true,
    readMemoryArtifacts: true,
    indexMemoryRoot: true,
    indexDailyNotes: true,
    indexDreamReports: true,
    followMemoryEvents: false,
  },
  obsidian: { enabled: false },
  ingest: { autoCompile: false },
  render: { createBacklinks: false, createDashboards: false },
};
function config(plugin?: string, remote = false) {
  return {
    browser: { enabled: false },
    update: { checkOnStart: false },
    discovery: { mdns: { mode: "off" } },
    gateway: remote
      ? { mode: "remote", remote: { url: `ws://127.0.0.1:${port}`, token, transport: "direct" } }
      : {
          mode: "local",
          port,
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
    agents: { defaults: { workspace } },
    memory: { search: { enabled: false } },
    plugins: {
      allow: ["memory-core", "memory-wiki"],
      slots: { memory: "memory-core" },
      ...(plugin ? { load: { paths: [path.resolve(plugin)] } } : {}),
      entries: {
        "memory-core": { enabled: true },
        "memory-wiki": { enabled: true, config: pluginSettings },
      },
    },
  };
}
async function stop() {
  client?.close();
  client = undefined;
  if (child) {
    await stopChild(child, { teardownGraceMs: 30_000 });
    child = undefined;
    await fs.writeFile(`${output}.${phase}.log`, currentLog);
  }
}
async function start(name: string, plugin?: string) {
  await stop();
  phase = name;
  currentLog = "";
  await fs.writeFile(configPath, JSON.stringify(config(plugin)));
  child = spawn(
    process.execPath,
    [
      path.resolve(plugin === candidatePlugin ? candidateEntry : entry),
      "gateway",
      "run",
      "--port",
      String(port),
    ],
    {
      env: createGatewayBenchEnv(home, configPath, {}),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child.stdout?.on("data", (chunk) => {
    currentLog += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    currentLog += String(chunk);
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `${name} Gateway exited: ${currentLog.slice(-5000)}`);
    const probe = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    try {
      await probe.waitOpen();
      const connected = await probe.request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "wiki-diagnostics-proof",
          version: "1.0.0",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        auth: { token },
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: [],
      });
      assert(connected.ok, JSON.stringify(connected.error));
      client = probe;
      return;
    } catch {
      probe.close();
      await delay(500);
    }
  }
  throw new Error(`${name} readiness timeout: ${currentLog.slice(-5000)}`);
}
async function rpc(method: string, params: Record<string, unknown> = {}) {
  assert(client);
  const result = await client.request(method, params, 300_000);
  assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
  assert(isRecord(result.payload));
  return result.payload;
}
async function cli(label: string, command: "status" | "doctor", plugin?: string, expectedExit = 0) {
  const cliHome = path.join(root, label);
  await fs.mkdir(cliHome, { recursive: true });
  const cliConfig = path.join(cliHome, "openclaw.json");
  await fs.writeFile(cliConfig, JSON.stringify(config(plugin, true)));
  const started = performance.now();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const proc = spawn(
        process.execPath,
        [
          path.resolve(plugin === candidatePlugin ? candidateEntry : entry),
          "wiki",
          command,
          "--json",
        ],
        {
          env: createGatewayBenchEnv(cliHome, cliConfig, { startupTrace: false }),
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        },
      );
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      proc.once("error", reject);
      proc.once("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    },
  );
  assert.equal(result.code, expectedExit, `${label}: ${result.stderr}\n${result.stdout}`);
  const payload: unknown = JSON.parse(result.stdout);
  assert(isRecord(payload));
  records.push({
    label,
    command,
    exitCode: result.code,
    elapsedMs: performance.now() - started,
    payload,
  });
  console.log(JSON.stringify({ label, command, exitCode: result.code }));
  return payload;
}
async function runtimeIdentity(plugin: string) {
  const digest = createHash("sha256");
  for (const file of await listDirectoryTreeStrict(path.join(plugin, "dist"))) {
    if (file.dirent.isFile() && /\.(?:m?js|json)$/.test(file.relativePath)) {
      digest
        .update(file.relativePath)
        .update(await fs.readFile(path.join(plugin, "dist", file.relativePath)));
    }
  }
  return {
    version: JSON.parse(await fs.readFile(path.join(plugin, "package.json"), "utf8")).version,
    digest: digest.digest("hex"),
  };
}
async function vaultDigest() {
  const hash = createHash("sha256");
  async function walk(relative: string) {
    for (const item of (
      await fs.readdir(path.join(vault, relative), { withFileTypes: true })
    ).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(relative, item.name);
      if (item.isDirectory()) {
        await walk(file);
      } else if (item.isFile()) {
        hash.update(file).update(await fs.readFile(path.join(vault, file)));
      }
    }
  }
  await walk("");
  return hash.digest("hex");
}
function statusOf(payload: Record<string, unknown>, doctor = false) {
  const status = doctor ? payload.status : payload;
  assert(isRecord(status));
  assert(isRecord(status.pageCounts));
  assert(isRecord(status.sourceCounts));
  return status;
}
try {
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "MEMORY.md"),
    "# Synthetic memory\n\nBridge input before upgrade.\n",
  );
  await start("released");
  await rpc("wiki.init");
  for (let i = 0; i < pages; i++) {
    await fs.writeFile(
      path.join(vault, "sources", `source-${i}.md`),
      `---\npageType: source\nid: source.${i}\ntitle: Synthetic ${i}\n---\n# Synthetic ${i}\n\nPreserved human content.\n`,
    );
  }
  await rpc("wiki.compile");
  const released = statusOf(await cli("released-client-released-server", "status"));
  const oldServerNewClient = statusOf(
    await cli("candidate-client-released-server", "status", candidatePlugin),
  );
  assert.deepEqual(oldServerNewClient.pageCounts, released.pageCounts);
  const oldServerNewDoctor = await cli(
    "candidate-doctor-released-server",
    "doctor",
    candidatePlugin,
  );
  assert.equal(oldServerNewDoctor.healthy, true);
  await stop();
  const legacyDigest = await vaultDigest();
  preservation.legacyVaultDigest = legacyDigest;
  preservation.legacyPageCounts = released.pageCounts;
  const expectedSettings = JSON.stringify(pluginSettings);
  await start("pre-repair", brokenPlugin);
  const broken = await cli("released-client-pre-repair-server", "status", undefined, 1);
  assert(isRecord(broken.error));
  assert.match(String(broken.error.message), /Invalid Gateway response/);
  await stop();
  assert.equal(
    await vaultDigest(),
    legacyDigest,
    "Old publication changed during pre-repair diagnostic",
  );
  await start("candidate", candidatePlugin);
  assert.equal(
    JSON.stringify(
      JSON.parse(await fs.readFile(configPath, "utf8")).plugins.entries["memory-wiki"].config,
    ),
    expectedSettings,
  );
  assert.equal(await vaultDigest(), legacyDigest, "Upgrade altered existing wiki files/journal");
  preservation.settingsRetained = true;
  preservation.upgradeVaultDigest = await vaultDigest();
  await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "memory", "2026-01-02.md"),
    "# Pending bridge input\n\nMust not be imported by snapshot diagnostics.\n",
  );
  for (const command of ["status", "doctor"] as const) {
    const result = await cli(
      `candidate-client-candidate-server-${command}`,
      command,
      candidatePlugin,
    );
    const status = statusOf(result, command === "doctor");
    assert.deepEqual(status.pageCounts, released.pageCounts);
    assert(isRecord(status.snapshot));
    assert.equal(status.snapshot.state, "published");
    assert.equal(status.snapshot.compiledAt, null);
    assert(isRecord(status.sourceCounts));
    assert(Object.values(status.sourceCounts).every((value) => value === null));
    if (command === "doctor") {
      assert.equal(result.healthy, true);
    }
    assert.equal(
      await vaultDigest(),
      legacyDigest,
      "Snapshot diagnostics wrote/imported/compiled the vault",
    );
  }
  preservation.afterSnapshotDiagnosticsVaultDigest = await vaultDigest();
  preservation.snapshotPreservedPendingInput = true;
  for (const command of ["status", "doctor"] as const) {
    const status = statusOf(
      await cli(`released-client-candidate-server-${command}`, command),
      command === "doctor",
    );
    assert(isRecord(status.pageCounts));
    assert(isRecord(status.sourceCounts));
    assert(Object.values(status.pageCounts).every((value) => typeof value === "number"));
    assert(Object.values(status.sourceCounts).every((value) => typeof value === "number"));
  }
  assert.notEqual(
    await vaultDigest(),
    legacyDigest,
    "Legacy sync did not import the pending bridge input",
  );
  preservation.afterLegacySyncVaultDigest = await vaultDigest();
  preservation.legacySyncImportedPendingInput = true;
  await stop();
  // A separate empty fixture exercises the public missing-publication contract.
  await fs.rename(vault, path.join(home, "retained-wiki"));
  await start("candidate-missing", candidatePlugin);
  const missing = statusOf(await cli("candidate-missing-status", "status", candidatePlugin));
  assert(isRecord(missing.pageCounts));
  assert(Object.values(missing.pageCounts).every((value) => value === null));
  const missingDoctor = await cli("candidate-missing-doctor", "doctor", candidatePlugin, 1);
  assert.equal(missingDoctor.healthy, false);
  const missingDoctorStatus = statusOf(missingDoctor, true);
  assert(isRecord(missingDoctorStatus.snapshot));
  assert.equal(missingDoctorStatus.snapshot.state, "unavailable");
  await cli("released-missing-status", "status");
  complete = true;
} finally {
  await stop();
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        complete,
        pages,
        releasedHost: path.resolve(entry),
        candidateHost: path.resolve(candidateEntry),
        candidatePlugin: path.resolve(candidatePlugin),
        records,
        preservation,
        identities: {
          host: JSON.parse(
            await fs.readFile(
              path.join(path.dirname(path.resolve(entry)), "dist", "build-info.json"),
              "utf8",
            ),
          ),
          candidateHost: JSON.parse(
            await fs.readFile(
              path.join(path.dirname(path.resolve(candidateEntry)), "dist", "build-info.json"),
              "utf8",
            ),
          ),
          candidate: await runtimeIdentity(candidatePlugin),
          preRepair: await runtimeIdentity(brokenPlugin),
        },
      },
      null,
      2,
    ),
  );
  await fs.rm(root, { recursive: true, force: true });
}

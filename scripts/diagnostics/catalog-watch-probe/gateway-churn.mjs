import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
// Standalone, synthetic-only investigation fixture. Run from a prepared source checkout.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const output = path.resolve(process.argv[2] ?? "catalog-probe-results");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output);
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-churn-"));
const state = path.join(fixture, "state");
const codexHome = path.join(fixture, ".codex");
const workspace = path.join(fixture, "workspace");
const sessions = path.join(codexHome, "sessions", "2026", "10", "06");
const skills = path.join(codexHome, "skills", "probe");
for (const directory of [state, workspace, sessions, skills]) {
  await fs.mkdir(directory, { recursive: true });
}
const skill = "# Probe\n\nSynthetic skill used only for watcher measurement.\n";
await fs.writeFile(
  path.join(skills, "SKILL.md"),
  "---\nname: probe\ndescription: Synthetic probe\n---\n" + skill,
);
await fs.writeFile(path.join(codexHome, "config.toml"), "");
const configPath = path.join(fixture, "openclaw.json");
await fs.writeFile(
  configPath,
  JSON.stringify({
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "synthetic-catalog-probe-token" },
      controlUi: { enabled: false },
    },
    agents: { defaults: { workspace, model: { primary: "openai/gpt-5.6-sol" } } },
    plugins: {
      allow: ["codex", "openai"],
      entries: {
        codex: { enabled: true, config: { appServer: { homeScope: "user" } } },
        openai: { enabled: true },
      },
    },
    skills: { load: { extraDirs: [path.join(codexHome, "skills")] } },
  }),
);
const events = [];
async function mark(phase, data = {}) {
  const event = { at: Date.now(), phase, ...data };
  events.push(event);
  await fs.writeFile(path.join(output, "phases.json"), JSON.stringify(events, null, 2));
  console.log(JSON.stringify(event));
}
const env = {
  ...process.env,
  HOME: fixture,
  USERPROFILE: fixture,
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  CODEX_HOME: codexHome,
  CATALOG_PROBE_OUTPUT: output,
  OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
  OPENCLAW_NO_RESPAWN: "1",
  NODE_OPTIONS:
    "--import=" +
    pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "gateway-probe-preload.mjs"),
    ).href,
};
for (const key of Object.keys(env)) {
  if (
    /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) ||
    /^ANTHROPIC_|^OPENAI_|^GH_|^GITHUB_/u.test(key)
  ) {
    delete env[key];
  }
}
// The probe is unauthenticated and never executes model turns or uses personal credentials.
const port = 19876;
const lifetime = new AbortController();
const interrupt = () => lifetime.abort(new Error("Probe interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const wait = (ms) => sleep(ms, undefined, { signal: lifetime.signal });
// Reuse the repository owner for POSIX groups, Windows jobs and joined stdio.
const { runManagedCommand, hasUnjoinedWork } = await import(
  pathToFileURL(path.join(process.cwd(), "scripts/lib/managed-child-process.mts")).href
);
const managedOptions = {
  bin: process.execPath,
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  requireProcessTreeExit: process.platform !== "win32",
  cleanupDrainTimeoutMs: 10_000,
  onSignal: interrupt,
};
let retainFixture = false;
async function primeCatalog() {
  const chunks = [];
  let bytes = 0;
  const errors = createWriteStream(path.join(output, "catalog-prime.stderr.log"));
  errors.on("error", (error) => lifetime.abort(error));
  try {
    const code = await runManagedCommand({
      ...managedOptions,
      args: [
        "scripts/run-node.mjs",
        "gateway",
        "call",
        "models.list",
        "--json",
        "--params",
        JSON.stringify({ view: "all", refresh: true }),
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        "synthetic-catalog-probe-token",
        "--timeout",
        "240000",
      ],
      env: { ...env, NODE_OPTIONS: "", CATALOG_PROBE_OUTPUT: "" },
      signal: lifetime.signal,
      timeoutMs: 270_000,
      timeoutForceKillOnLeaderExit: true,
      onReady(child) {
        child.stdout.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= 8 * 1024 * 1024) {
            chunks.push(chunk);
          }
        });
        child.stderr.pipe(errors);
      },
    });
    if (code !== 0 || bytes > 8 * 1024 * 1024) {
      throw new Error("Catalog refresh failed; inspect captured stderr");
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    retainFixture ||= hasUnjoinedWork(error);
    throw error;
  } finally {
    errors.end();
  }
}
const stdout = createWriteStream(path.join(output, "gateway.stdout.log"));
const stderr = createWriteStream(path.join(output, "gateway.stderr.log"));
stdout.on("error", (error) => lifetime.abort(error));
stderr.on("error", (error) => lifetime.abort(error));
const gatewayStop = new AbortController();
let closed = false;
const exited = runManagedCommand({
  ...managedOptions,
  args: ["scripts/run-node.mjs", "gateway", "run", "--port", String(port), "--bind", "loopback"],
  env,
  signal: gatewayStop.signal,
  onReady(child) {
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.once("exit", () => {
      closed = true;
      gatewayStop.abort();
    });
  },
}).then(
  (code) => {
    closed = true;
    return { code };
  },
  (error) => {
    closed = true;
    return { error };
  },
);
const failures = [];
try {
  await mark("starting", {
    source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    node: process.version,
    platform: process.platform,
  });
  const deadline = Date.now() + 15 * 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (closed) {
      break;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(2000)]),
      });
      ready = response.ok;
    } catch {}
    if (ready) {
      break;
    }
    await wait(1000);
  }
  if (!ready) {
    throw new Error("Gateway did not become ready; inspect captured logs");
  }
  await mark("ready");
  await mark("catalog-prime");
  const catalog = await primeCatalog();
  await mark("catalog-primed", { modelCount: catalog.models?.length ?? null });
  await wait(20_000);
  await mark("quiet");
  await wait(30_000);
  await mark("unrelated-writes");
  let writes = 0;
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (closed) {
      throw new Error("Gateway exited during workload");
    }
    await fs.appendFile(
      path.join(sessions, `rollout-${writes % 20}.jsonl`),
      JSON.stringify({ type: "synthetic", n: writes++ }) + "\n",
    );
    await wait(50);
  }
  await mark("burst", { writes });
  for (let i = 0; i < 1000; i++) {
    lifetime.signal.throwIfAborted();
    await fs.writeFile(path.join(sessions, `burst-${i}.jsonl`), "{}\n");
  }
  await wait(10_000);
  await mark("selected-skill-edit");
  await fs.appendFile(path.join(skills, "SKILL.md"), "\nA selected edit should refresh Skills.\n");
  await wait(35_000);
  await mark("complete");
  if (closed) {
    throw new Error("Gateway exited during workload");
  }
} catch (error) {
  failures.push(error);
}
gatewayStop.abort();
const result = await exited;
if (result.error) {
  retainFixture ||= hasUnjoinedWork(result.error);
  if (result.error.code !== "ABORT_ERR") {
    failures.push(result.error);
  }
}
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", interrupt);
stdout.end();
stderr.end();
if (!retainFixture) {
  try {
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    failures.push(error);
  }
} else {
  console.error("Process cleanup is unconfirmed; retained synthetic fixture:", fixture);
}
if (failures.length > 0) {
  throw new AggregateError(failures, "Catalog probe or cleanup failed");
}

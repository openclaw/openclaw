// Self-contained Docker survivor: packed current checkout -> distinct release identity.
// Migration and rollback with changed state are covered by the schema-bumped acceptance kit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readDatabase } from "./observations.mjs";
import { mapRegistryHosts, prepareRegistryTls, startRegistryTlsRelay } from "./registry-tls.mjs";
import { prepareReleaseFixture } from "./release-fixture.mjs";

assert(
  fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"),
  "requires an isolated container",
);
const sourceTarball = process.env.OPENCLAW_CURRENT_PACKAGE_TGZ;
assert(sourceTarball, "missing packed current checkout");
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
assert(artifacts, "missing artifact directory");
fs.mkdirSync(artifacts, { recursive: true });
// openclaw-temp-dir: allow standalone Docker lane owns its runtime until container removal.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-survivor-"));
const state = path.join(root, "home", ".openclaw");
const prefix = path.join(root, "prefix");
fs.mkdirSync(state, { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("OPENCLAW_") &&
      !/^npm_config_/iu.test(key) &&
      !["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].includes(key),
  ),
);
Object.assign(env, {
  HOME: path.join(root, "home"),
  PATH: `${prefix}/bin:${process.env.PATH}`,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  CI: "true",
});
const save = (name, value) =>
  fs.writeFileSync(path.join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`);
const children = [];
let tlsRelay;
function start(program, args, logName, extra = {}) {
  const fd = fs.openSync(path.join(artifacts, logName), "a");
  try {
    const child = spawn(program, args, { env, stdio: ["ignore", fd, fd], ...extra });
    children.push(child);
    return child;
  } finally {
    fs.closeSync(fd);
  }
}
async function command(program, args, logName) {
  const child = start(program, args, logName);
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `${program} exited ${code ?? signal}; see ${logName}`);
}
async function waitFor(read, message, budget = 300_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) {
      return value;
    }
    await delay(250);
  }
  throw new Error(message);
}
const port = 18789;
const ready = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) }))
      .ok;
  } catch {
    return false;
  }
};
const database = path.join(state, "state", "openclaw.sqlite");
const readRun = () =>
  readDatabase(database, (db) =>
    db.prepare("SELECT * FROM update_runs ORDER BY created_at_ms DESC LIMIT 1").get(),
  );
try {
  const tlsRoot = path.join(root, "tls");
  await prepareRegistryTls(tlsRoot);
  mapRegistryHosts(tlsRoot);
  env.NODE_EXTRA_CA_CERTS = path.join(tlsRoot, "cert.pem");
  for (const name of ["cert.pem", "hosts.before", "hosts.effective", "public-ip"]) {
    fs.copyFileSync(path.join(tlsRoot, name), path.join(artifacts, `tls-${name}`));
  }
  const fixture = prepareReleaseFixture(sourceTarball, path.join(root, "fixture"));
  save("fixture.json", fixture);
  const registry = start(
    process.execPath,
    [
      path.resolve("scripts/e2e/lib/plugins/npm-registry-server.mjs"),
      path.join(root, "registry.port"),
      "openclaw",
      fixture.previous.version,
      sourceTarball,
      "openclaw",
      fixture.next.version,
      fixture.next.tarball,
    ],
    "registry.log",
    {
      env: { ...env, OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const [registryPort] = await once(registry, "message");
  tlsRelay = await startRegistryTlsRelay(
    tlsRoot,
    { t: fixture.previous, next: fixture.next },
    registryPort,
  );
  fs.writeFileSync(
    path.join(env.HOME, ".npmrc"),
    `registry=http://127.0.0.1:${registryPort}\nprefix=${prefix}\ncache=${root}/npm-cache\n`,
  );
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token: "release-survivor-token" },
      },
      update: { channel: "stable", checkOnStart: false },
    }),
  );
  await command(
    "npm",
    ["install", "--global", sourceTarball, "--no-audit", "--no-fund"],
    "install.log",
  );
  await command("npm", ["view", "openclaw", "dist-tags", "--json"], "registry-dist-tags.json");
  await command(
    "npm",
    ["view", "openclaw", "dist-tags", "--json", "--registry=https://registry.npmjs.org"],
    "public-dist-tags.json",
  );
  save("cli-env.json", env);
  const gateway = start("openclaw", ["gateway", "run"], "gateway.log", { detached: true });
  await waitFor(ready, "T did not become ready");
  assert.equal(gateway.exitCode, null, "T exited before the API update");
  save(
    "gateway-env.json",
    Object.fromEntries(
      fs
        .readFileSync(`/proc/${gateway.pid}/environ`, "utf8")
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
    ),
  );
  const startedAt = Date.now();
  await command(
    "openclaw",
    ["gateway", "call", "update.run", "--params", "{}", "--json"],
    "update-api.json",
  );
  const row = await waitFor(
    () => {
      const current = readRun();
      return current && current.status !== "running" ? current : null;
    },
    "release update did not finish",
    45 * 60_000,
  );
  save("update-row.json", row);
  assert.equal(row.trigger, "api");
  assert.equal(row.status, "succeeded", row.reason ?? "release update failed");
  assert.equal(JSON.parse(row.before_json).version, fixture.previous.version);
  assert.equal(JSON.parse(row.target_json).version, fixture.next.version);
  const verification = JSON.parse(row.verification_json);
  assert.equal(verification.runningBuildId, fixture.next.buildId, "wrong build is serving");
  assert.equal(verification.runningVersion, fixture.next.version);
  assert.equal(verification.booted, true);
  await waitFor(ready, "T+1 is not serving");
  const releasePrefix = path.join(state, "git-install");
  const trial = JSON.parse(fs.readFileSync(path.join(releasePrefix, "releases", ".trial"), "utf8"));
  assert.equal(trial.phase, "committed");
  assert.equal(trial.buildId, fixture.next.buildId);
  const previous = path.resolve(releasePrefix, trial.previous);
  assert(fs.existsSync(path.join(previous, "openclaw.mjs")), "previous release was not retained");
  const previousBuild = JSON.parse(
    fs.readFileSync(path.join(previous, "dist", "build-info.json"), "utf8"),
  );
  assert.equal(previousBuild.buildId, fixture.previous.buildId);
  const selected = fs.realpathSync(path.join(releasePrefix, "openclaw"));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(selected, "dist", "build-info.json"), "utf8")).buildId,
    fixture.next.buildId,
  );
  assert(
    fs
      .readFileSync(path.join(artifacts, "gateway.log"), "utf8")
      .includes(`update.run ${row.run_id}`),
    "Gateway route receipt is missing",
  );
  save("trial.json", trial);
  save("summary.json", {
    head: fixture.previous.commit,
    runId: row.run_id,
    trigger: row.trigger,
    status: row.status,
    servingBuildId: verification.runningBuildId,
    previous,
    wallMs: Date.now() - startedAt,
    migrationProof: false,
  });
} finally {
  tlsRelay?.closeAllConnections();
  tlsRelay?.close();
  for (const child of children.toReversed()) {
    if (child.exitCode === null && child.signalCode === null) {
      if (
        child.spawnargs[0] === "openclaw" &&
        child.spawnargs[1] === "gateway" &&
        child.spawnargs[2] === "run"
      ) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") {
            console.error(error);
            process.exitCode = 1;
          }
        }
      } else {
        child.kill("SIGTERM");
      }
    }
  }
}

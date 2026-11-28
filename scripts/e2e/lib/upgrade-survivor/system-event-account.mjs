import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, request } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readDatabase } from "./observations.mjs";

// Disposable published-driver prefix, fresh state root, packed candidate, full expected commit.
const [prefix, root, tarball, commit, version, mode, rawPort] = process.argv.slice(2);
assert(["stored", "literal", "env-ref", "no-model"].includes(mode));
assert.match(commit, /^[a-f0-9]{40}$/);
const port = Number(rawPort);
const run = promisify(execFile);
const cli = path.join(prefix, "bin/openclaw");
const pkg = path.join(prefix, "lib/node_modules/openclaw");
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
assert.equal((await readJson(path.join(pkg, "package.json"))).version, version);
process.umask(0o077);
await fs.mkdir(root, { mode: 0o700 });
const home = path.join(root, "home");
const state = path.join(root, "state");
const tmp = path.join(root, "tmp");
await Promise.all([home, state, tmp].map((dir) => fs.mkdir(dir)));
const token = randomBytes(24).toString("hex");
const env = {
  ...process.env,
  HOME: home,
  TMPDIR: tmp,
  TMP: tmp,
  TEMP: tmp,
  npm_config_prefix: prefix,
  PATH: prefix + "/bin:" + process.env.PATH,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_GATEWAY_PORT: String(port),
  OPENCLAW_GATEWAY_TOKEN: token,
};
const config = {
  gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
  agents: {
    entries: { main: { workspace: path.join(root, "workspace") } },
    defaults: { systemAgent: { agentId: "main" } },
  },
  cron: { enabled: true },
  plugins: { enabled: mode !== "no-model" },
};
const text = "Report the saved system event: upgrade-event-fixture";
const requestLog = path.join(root, "requests.jsonl");
const fixtureKey = "sk-test-synthetic-loopback-only-207275";
if (mode === "env-ref") {
  env.OPENCLAW_REMINDER_FIXTURE_KEY = fixtureKey;
}
const children = new Set();
const otherKey = "sk-test-synthetic-other-account-207275";
const accountHits = [];
// Observe only synthetic account labels at the HTTP boundary, never store credential values.
const witness =
  mode === "literal"
    ? createServer((req, res) => {
        if (req.method === "POST") {
          const bearer = req.headers.authorization;
          accountHits.push(
            bearer === "Bearer " + fixtureKey
              ? "default"
              : bearer === "Bearer " + otherKey
                ? "other"
                : "unknown",
          );
        }
        const upstream = request(
          {
            hostname: "127.0.0.1",
            port: port + 200,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.writeHead(502);
          res.end();
        });
        req.pipe(upstream);
      })
    : undefined;
async function start(exe, args, name, extra = {}) {
  const log = await fs.open(path.join(root, name + ".log"), "w", 0o600);
  try {
    const proc = spawn(exe, args, {
      cwd: root,
      env: { ...env, ...extra },
      stdio: ["ignore", log.fd, log.fd],
    });
    children.add(proc);
    return proc;
  } finally {
    await log.close();
  }
}
async function stop(proc) {
  if (proc.exitCode === null && proc.signalCode === null) {
    const closed = once(proc, "close");
    proc.kill();
    await closed;
  }
  children.delete(proc);
}
async function gateway(name) {
  const proc = await start(
    cli,
    ["gateway", "--bind", "loopback", "--port", String(port), "--allow-unconfigured"],
    name,
  );
  for (let i = 0; i < 180; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(name + " exited before readiness");
    }
    if (
      await fetch("http://127.0.0.1:" + port + "/readyz").then(
        (r) => r.ok,
        () => false,
      )
    ) {
      return proc;
    }
    await delay(500);
  }
  throw new Error(name + " not ready");
}
async function call(args, extra = {}) {
  return (await run(cli, args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024, ...extra })).stdout;
}
function storedJob(id) {
  return readDatabase(path.join(state, "state/openclaw.sqlite"), (db) => {
    const row = db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(id);
    assert(row, "expected the original job row");
    const { inferenceBinding, name, enabled, schedule, payload, agentId, sessionTarget, delivery } =
      JSON.parse(row.job_json);
    return {
      settings: { name, enabled, schedule, payload, agentId, sessionTarget, delivery },
      profile: inferenceBinding?.profileId ?? null,
      source: inferenceBinding?.source ?? null,
    };
  });
}
async function occurrence(id) {
  try {
    await call(["cron", "run", id, "--wait", "--wait-timeout", "120s", "--json"]);
  } catch (error) {
    if (!error.stdout) {
      throw error;
    }
  }
  const history = JSON.parse(await call(["cron", "runs", "--id", id, "--limit", "1", "--json"]));
  assert.equal(history.entries[0]?.jobId, id);
  return history.entries[0];
}
try {
  if (witness) {
    witness.listen(port + 100, "127.0.0.1");
    await once(witness, "listening");
  }
  if (mode !== "no-model") {
    config.agents.defaults.model = { primary: "proof/proof-model" };
    config.models = {
      providers: {
        proof: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:" + (port + 100) + "/v1",
          apiKey:
            mode === "env-ref"
              ? { source: "env", provider: "default", id: "OPENCLAW_REMINDER_FIXTURE_KEY" }
              : fixtureKey,
          models: [{ id: "proof-model", name: "Proof", contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    };
    const control = path.join(root, "model.json");
    await fs.writeFile(control, JSON.stringify({ text: "UPGRADE_EVENT_OK" }));
    await start(
      process.execPath,
      [fileURLToPath(new URL("../../mock-openai-server.mjs", import.meta.url))],
      "model",
      {
        MOCK_PORT: String(port + (witness ? 200 : 100)),
        MOCK_REQUEST_LOG: requestLog,
        MOCK_RESPONSE_CONTROL: control,
      },
    );
  }
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
  async function saveAccount(profileId = "proof:fixture", key = fixtureKey) {
    const child = spawn(
      cli,
      [
        "models",
        "auth",
        "paste-api-key",
        "--provider",
        "proof",
        "--profile-id",
        profileId,
        "--agent",
        "main",
      ],
      { cwd: root, env, stdio: ["pipe", "ignore", "inherit"] },
    );
    const done = once(child, "close");
    child.stdin.end(key + "\n");
    assert.equal((await done)[0], 0);
  }
  const latestStable = version === "2026.11.10";
  if (mode === "stored" && !latestStable) {
    await saveAccount();
  }
  if (mode === "literal" || mode === "env-ref") {
    const help = await call(["setup", "--help"]);
    await call([
      "setup",
      ...(help.includes("--baseline") ? ["--baseline"] : []),
      "--workspace",
      path.join(root, "workspace"),
    ]);
  }
  const old = await gateway("old-gateway");
  const job = JSON.parse(
    await call([
      "cron",
      "add",
      "--agent",
      "main",
      "--every",
      "7d",
      "--wake",
      "next-heartbeat",
      "--session",
      "main",
      "--name",
      "upgrade-event",
      "--system-event",
      text,
      "--json",
    ]),
  );
  const before = await occurrence(job.id);
  assert.equal(before.status, "ok");
  await stop(old);
  const original = storedJob(job.id);
  assert.equal(original.profile, null);
  if (latestStable && mode === "stored") {
    // Retain a successful key-only run before introducing an eligible stored account.
    await saveAccount();
  }
  const updateEnv = { ...env };
  delete updateEnv.OPENCLAW_GATEWAY_TOKEN;
  const update = JSON.parse(
    await call(
      [
        "update",
        "--channel",
        "stable",
        "--tag",
        "file:" + tarball,
        "--no-restart",
        "--yes",
        "--json",
      ],
      { env: updateEnv },
    ),
  );
  assert.equal(update.status, "ok");
  const installed = (await readJson(path.join(pkg, "dist/build-info.json"))).commit;
  assert.equal(installed, commit);
  const upgraded = storedJob(job.id);
  assert.deepEqual(upgraded.settings, original.settings);
  assert.equal(
    upgraded.profile,
    mode === "stored" ? "proof:fixture" : mode === "literal" ? "proof:default" : null,
  );
  await fs.writeFile(requestLog, "");
  const updatedGateway = await gateway("new-gateway");
  const retained = JSON.parse(
    await call(["cron", "runs", "--id", job.id, "--limit", "5", "--json"]),
  ).entries.find((row) => row.runAtMs === before.runAtMs && row.jobId === job.id);
  assert(retained);
  for (const key of ["runId", "status", "summary"]) {
    assert.deepEqual(retained[key], before[key]);
  }
  const after = await occurrence(job.id);
  assert(after.runAtMs > before.runAtMs);
  const requests = (await fs.readFile(requestLog, "utf8"))
    .split("\n")
    .filter((line) => line.includes("upgrade-event-fixture")).length;
  let recovery;
  if (mode === "literal" || mode === "env-ref") {
    let command = `openclaw automations edit ${job.id} --model proof/proof-model@proof:default`;
    if (mode === "env-ref") {
      // Introducing a stored account later exercises manual recovery without an intervening Doctor.
      await stop(updatedGateway);
      await saveAccount("proof:default");
      await call(["config", "set", "models.providers.proof.apiKey", "proof:default"]);
      await gateway("stored-account-gateway");
      const refusal = await occurrence(job.id);
      assert.equal(refusal.status, "error");
      assert(refusal.error.includes(`Record the account with ${command}.`), refusal.error);
      command = refusal.error.match(/Record the account with (.+?)\. For eligible/u)[1];
    }
    await call(command.split(" ").slice(1));
    await fs.writeFile(requestLog, "");
    const repaired = await occurrence(job.id);
    assert.equal(repaired.status, "ok", repaired.error);
    const persisted = storedJob(job.id);
    assert.deepEqual(persisted.settings, original.settings);
    assert.equal(persisted.profile, "proof:default");
    assert.equal(persisted.source, "user");
    const recoveryRequests = (await fs.readFile(requestLog, "utf8"))
      .split("\n")
      .filter((line) => line.includes("upgrade-event-fixture")).length;
    assert.equal(recoveryRequests, 1);
    recovery = {
      command,
      status: repaired.status,
      profile: persisted.profile,
      source: persisted.source,
      requests: recoveryRequests,
    };
  }
  let fresh;
  if (mode === "literal") {
    await stop(updatedGateway);
    await saveAccount("proof:other", otherKey);
    const gw = await gateway("fresh-reminder-gateway");
    const select = (profile) =>
      call([
        "gateway",
        "call",
        "sessions.patch",
        "--params",
        JSON.stringify({ key: "agent:main:main", model: "proof/proof-model@proof:" + profile }),
        "--json",
      ]);
    await select("default");
    const reminder = JSON.parse(
      await call([
        "cron",
        "add",
        "--agent",
        "main",
        "--session",
        "main",
        "--every",
        "7d",
        "--system-event",
        "Report fresh-reminder-check",
        "--name",
        "fresh-reminder",
        "--json",
      ]),
    );
    assert.equal(storedJob(reminder.id).profile, null);
    const runWithAccount = async (id, expected) => {
      accountHits.length = 0;
      const result = await occurrence(id);
      assert.equal(result.status, "ok", result.error);
      assert.deepEqual(accountHits, [expected]);
    };
    await runWithAccount(reminder.id, "default");
    await select("other");
    await stop(gw);
    await call(["doctor", "--fix", "--non-interactive"]);
    await gateway("after-repeat-doctor");
    assert.equal(storedJob(reminder.id).profile, null);
    await runWithAccount(reminder.id, "other");
    await runWithAccount(job.id, "default");
    fresh = {
      id: reminder.id,
      profileAfterDoctor: storedJob(reminder.id).profile,
      accounts: ["default", "other"],
      repairedAccount: "default",
    };
  }
  console.log(
    JSON.stringify({
      fresh,
      recovery,
      version,
      mode,
      installed,
      jobId: job.id,
      settings: upgraded.settings,
      profileBefore: original.profile,
      profileAfter: upgraded.profile,
      retainedRun: { runId: retained.runId, runAtMs: retained.runAtMs, status: retained.status },
      before: before.status,
      after: after.status,
      error: after.error,
      model: after.model,
      requests,
      steps: update.steps?.map(({ name, exitCode }) => ({ name, exitCode })),
    }),
  );
  if (mode === "no-model") {
    assert.equal(after.status, "error");
    assert.match(after.error, /No model is configured/i);
    assert.equal(requests, 0);
  } else {
    assert.equal(after.status, "ok", after.error);
    assert(requests > 0, "saved event did not reach the model");
  }
} finally {
  for (const child of [...children].toReversed()) {
    await stop(child);
  }
  if (witness?.listening) {
    await new Promise((resolve) => {
      witness.close(resolve);
    });
  }
}

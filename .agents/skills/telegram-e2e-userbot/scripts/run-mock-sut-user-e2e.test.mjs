import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import {
  applyScenarioConfigPatch,
  assertSutMatchesLease,
  assertTesterMatchesLease,
  createGatewayEnvironment,
  createScenarioCommandEnvironment,
  drainSutUpdates,
  ownChild,
  runCommand,
  summarizeScenarioCommand,
  watchChildCompletion,
  writeConfig,
} from "./run-mock-sut-user-e2e.mjs";
import { currentTelegramRun, withTelegramRun } from "./telegram-run-scope.mjs";

// Cancellation cases return their expected terminal error after checking cleanup.
const test = (name, run) =>
  nodeTest(name, async (context) => {
    let expectedFailure;
    const result = await withTelegramRun(async () => {
      expectedFailure = await run(context);
    }).then(
      () => ({}),
      (error) => ({ error }),
    );
    if (expectedFailure) {
      assert.equal(result.error, expectedFailure);
    } else if (result.error) {
      throw result.error;
    }
  });

function startOwnedChild() {
  return ownChild(
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    }),
  );
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

test("config patches restart before releasing their scenario barrier", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-config-patch-"));
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const configPath = path.join(temp, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ channels: { telegram: { historyLimit: 5 } } }));
  const calls = [];
  const restarted = { pid: 2 };
  const result = await applyScenarioConfigPatch({
    configPath,
    patch: { channels: { telegram: { historyLimit: 9 } } },
    gateway: { pid: 1 },
    stopGateway: async () => calls.push("stop"),
    startGateway: async () => {
      calls.push("start");
      return restarted;
    },
    markApplied: () => calls.push("mark"),
  });
  assert.equal(result, restarted);
  assert.deepEqual(calls, ["stop", "start", "mark"]);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).channels.telegram.historyLimit, 9);
});

test("runner rejects a live tester identity that differs from the lease", () => {
  assert.throws(
    () => assertTesterMatchesLease({ id: "42" }, { testerUserId: "43" }),
    /identity does not match the lease/u,
  );
  assert.doesNotThrow(() => assertTesterMatchesLease({ id: "42" }, { testerUserId: "42" }));
});

test("runner rejects a live SUT identity that differs from the lease", () => {
  const credential = { sutBotId: "42", sutUsername: "sut_bot" };
  assert.throws(
    () => assertSutMatchesLease({ id: "43", username: "sut_bot" }, credential),
    /bot identity does not match the lease/u,
  );
  assert.throws(
    () => assertSutMatchesLease({ id: "42", username: "other_bot" }, credential),
    /bot identity does not match the lease/u,
  );
  assert.doesNotThrow(() => assertSutMatchesLease({ id: "42", username: "sut_bot" }, credential));
});

test("scenario commands receive credential file locations without broker authority", () => {
  const commandEnv = createScenarioCommandEnvironment({
    gatewayEnv: {
      OPENCLAW_CONFIG_PATH: "/tmp/openclaw.json",
      OPENCLAW_STATE_DIR: "/tmp/state",
    },
    driverEnv: {
      TELEGRAM_E2E_STATE_DIR: "/tmp/lease-state",
      TELEGRAM_USER_DRIVER_STATE_DIR: "/tmp/user-driver",
    },
    telegramApiRoot: "http://127.0.0.1:19881",
  });
  assert.deepEqual(commandEnv, {
    OPENCLAW_CONFIG_PATH: "/tmp/openclaw.json",
    OPENCLAW_STATE_DIR: "/tmp/state",
    TELEGRAM_E2E_STATE_DIR: "/tmp/lease-state",
    TELEGRAM_USER_DRIVER_STATE_DIR: "/tmp/user-driver",
    TELEGRAM_E2E_TEST_API_ROOT: "http://127.0.0.1:19881",
  });
});

test("gateway environment strips inherited bot tokens and keeps the synthetic provider key", () => {
  const gatewayEnv = createGatewayEnvironment({
    baseEnv: {
      PATH: "/safe/bin",
      TELEGRAM_BOT_TOKEN: "synthetic-bot-token",
      TELEGRAM_E2E_SUT_BOT_TOKEN: "synthetic-bot-token",
      OPENCLAW_QA_CONVEX_SECRET_CI: "synthetic-broker-secret",
      GITHUB_TOKEN: "github-secret",
      TELEGRAM_E2E_STATE_DIR: "/private/lease",
      TELEGRAM_USER_DRIVER_STATE_DIR: "/private/lease/user-driver",
    },
    configPath: "/tmp/openclaw.json",
    stateDir: "/tmp/state",
  });
  assert.deepEqual(gatewayEnv, {
    PATH: "/safe/bin",
    OPENCLAW_CONFIG_PATH: "/tmp/openclaw.json",
    OPENCLAW_STATE_DIR: "/tmp/state",
    OPENAI_API_KEY: "openclaw-e2e-mock-key",
  });
});

test("gateway token stays in a private run-owned file until scratch cleanup", async () => {
  const token = "42:synthetic-file-token";
  const temp = writeConfig({
    sutToken: token,
    backend: "mock",
    gatewayPort: 19879,
    mockPort: 19882,
    telegramApiRoot: "http://127.0.0.1:19881",
    testerId: "123",
    groupId: "-1001",
  });
  const configText = fs.readFileSync(temp.configPath, "utf8");
  const config = JSON.parse(configText);
  const tokenFile = config.channels.telegram.tokenFile;
  assert.equal(path.dirname(tokenFile), temp.root);
  assert.equal(fs.readFileSync(tokenFile, "utf8"), token);
  assert.equal(Object.hasOwn(config.channels.telegram, "botToken"), false);
  assert.equal(configText.includes(token), false);
  for (const directory of [temp.root, temp.stateDir, temp.workspace]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  for (const file of [tokenFile, temp.configPath]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  await currentTelegramRun().close();
  assert.equal(fs.existsSync(tokenFile), false);
  assert.equal(fs.existsSync(temp.root), false);
});

test("scenario command evidence retains no argv or process output", () => {
  const credential = "123456789:leased-test-token";
  const summary = summarizeScenarioCommand({
    action: { type: "command", cwd: "repo", argv: ["echo", credential] },
    result: { status: 0, timedOut: false, stdout: credential, stderr: credential },
    elapsedMs: 10,
    durationMs: 20,
  });
  assert.deepEqual(summary, {
    type: "command",
    cwd: "repo",
    status: "completed",
    exitCode: 0,
    timedOut: false,
    elapsedMs: 10,
    durationMs: 20,
  });
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(credential, "u"));
});

test("termination joins credential-bearing children before lease release", async () => {
  const gateway = startOwnedChild();
  const recorder = startOwnedChild();
  let released = false;
  await currentTelegramRun().acquire(
    Promise.resolve({
      async release() {
        assert.notEqual(gateway.signalCode, null);
        assert.notEqual(recorder.signalCode, null);
        released = true;
      },
    }),
  );
  await currentTelegramRun().close();
  assert.equal(released, true);
});

test("signal cleanup waits for credential acquisition before releasing scratch", async (context) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-pending-acquire-"));
  context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  let resolveCredential;
  const credentialPromise = currentTelegramRun().acquire(
    new Promise((resolve) => {
      resolveCredential = resolve;
    }),
  );
  const signalCleanup = currentTelegramRun().close();
  let releaseCount = 0;
  let finishRelease;
  const releaseGate = new Promise((resolve) => {
    finishRelease = resolve;
  });
  const credential = {
    async release() {
      releaseCount += 1;
      await releaseGate;
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
  resolveCredential(credential);
  await credentialPromise;
  const mainCleanup = currentTelegramRun().close();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(releaseCount, 1);
  finishRelease();
  await Promise.all([signalCleanup, mainCleanup]);
  assert.equal(releaseCount, 1);
  assert.equal(fs.existsSync(scratch), false);
});

test("lease loss signals active Telegram process groups before waiting", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-concurrent-lease-fence-"));
  const cronSideEffect = path.join(temp, "cron-delivered");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  ownChild(
    spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),300)); setInterval(()=>{},1000);',
      ],
      { detached: true, stdio: "ignore" },
    ),
  );
  const cron = ownChild(
    spawn(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.CRON_SIDE_EFFECT,"delivered"),150); setInterval(()=>{},1000);',
      ],
      {
        detached: true,
        env: { ...process.env, CRON_SIDE_EFFECT: cronSideEffect },
        stdio: "ignore",
      },
    ),
  );
  const restartedGateway = startOwnedChild();
  let controlsCancelled = false;
  let logsPersisted = false;
  const leaseError = new Error("lease heartbeat failed");
  const scope = currentTelegramRun();
  scope.trackTask(
    scope.wait(new Promise(() => {})).catch((error) => {
      assert.equal(error, leaseError);
      controlsCancelled = true;
    }),
  );
  scope.preserveEvidence(() => {
    assert.equal(controlsCancelled, true);
    assert.notEqual(cron.signalCode, null);
    assert.notEqual(restartedGateway.signalCode, null);
    logsPersisted = true;
  });
  scope.cancel(leaseError);
  await scope.close();
  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });
  assert.equal(fs.existsSync(cronSideEffect), false);
  assert.equal(logsPersisted, true);
  return leaseError;
});

test("lease loss during blocked readiness stops the gateway before polling", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-gateway-lease-fence-"));
  const pollMarker = path.join(temp, "poll-started");
  const gatewayReady = path.join(temp, "gateway-ready");
  const childScript = path.join(temp, "fixture.cjs");
  const gatewayScript = path.join(temp, "gateway.cjs");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(
    childScript,
    'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.POLL_MARKER,"polled"),200); setInterval(()=>{},1000);',
  );
  fs.writeFileSync(
    gatewayScript,
    'const fs=require("node:fs"); const {spawn}=require("node:child_process"); spawn(process.execPath,[process.env.CHILD_SCRIPT],{env:process.env,stdio:"ignore"}); fs.writeFileSync(process.env.GATEWAY_READY,"ready"); setInterval(()=>{},1000);',
  );
  const gatewayEnv = createGatewayEnvironment({
    baseEnv: {
      PATH: "/safe/bin",
      OPENCLAW_QA_CONVEX_SECRET_CI: "broker-secret",
      TELEGRAM_E2E_STATE_DIR: "/private/lease",
    },
    configPath: path.join(temp, "openclaw.json"),
    stateDir: path.join(temp, "state"),
  });
  ownChild(
    spawn(process.execPath, [gatewayScript], {
      detached: true,
      env: {
        ...process.env,
        ...gatewayEnv,
        CHILD_SCRIPT: childScript,
        GATEWAY_READY: gatewayReady,
        POLL_MARKER: pollMarker,
      },
      stdio: "ignore",
    }),
  );
  const leaseError = new Error("lease heartbeat failed during gateway readiness");
  const leaseFailure = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!fs.existsSync(gatewayReady)) {
        return;
      }
      clearInterval(poll);
      resolve({ type: "lease-failure", error: leaseError });
    }, 5);
  });

  leaseFailure.then(({ error }) => currentTelegramRun().cancel(error));
  await assert.rejects(
    currentTelegramRun().wait(new Promise(() => {})),
    (error) => error === leaseError,
  );
  await currentTelegramRun().close();
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  assert.equal(gatewayEnv.PATH, "/safe/bin");
  assert.equal(gatewayEnv.OPENCLAW_QA_CONVEX_SECRET_CI, undefined);
  assert.equal(gatewayEnv.TELEGRAM_E2E_STATE_DIR, undefined);
  assert.equal(fs.existsSync(gatewayReady), true);
  assert.equal(fs.existsSync(pollMarker), false);
  return leaseError;
});

test("lease revocation between startup Bot API calls prevents update polling", async () => {
  const leaseError = new Error("lease revoked between Bot API calls");
  let healthy = true;
  let revoke;
  const whenUnhealthy = new Promise((resolve) => {
    revoke = () => {
      healthy = false;
      resolve({ type: "lease-failure", error: leaseError });
    };
  });
  const methods = [];
  const fetchImpl = async (url) => {
    methods.push(new URL(url).pathname.split("/").at(-1));
    return {
      ok: true,
      status: 200,
      json: async () => {
        revoke();
        return { ok: true, result: { url: "", pending_update_count: 0 } };
      },
    };
  };
  const lease = {
    assertHealthy: () => {
      if (!healthy) {
        throw leaseError;
      }
    },
    whenUnhealthy,
  };

  await assert.rejects(
    drainSutUpdates("sut-token", lease, fetchImpl),
    (error) => error === leaseError,
  );
  assert.deepEqual(methods, ["getWebhookInfo"]);
});

test("lease loss during a credential command stops every owned child before its side effect", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-command-lease-fence-"));
  const sideEffect = path.join(temp, "sent");
  const wrapperReady = path.join(temp, "wrapper-ready");
  const childScript = path.join(temp, "child.cjs");
  const wrapperScript = path.join(temp, "wrapper.cjs");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(
    childScript,
    'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.SIDE_EFFECT,"sent"),200); setInterval(()=>{},1000);',
  );
  fs.writeFileSync(
    wrapperScript,
    'const fs=require("node:fs"); const {spawn}=require("node:child_process"); spawn(process.execPath,[process.env.CHILD_SCRIPT],{env:process.env,stdio:"ignore"}); fs.writeFileSync(process.env.WRAPPER_READY,"ready"); setInterval(()=>{},1000);',
  );
  const gateway = startOwnedChild();
  const leaseError = new Error("lease revoked during credential command");
  const leaseFailure = new Promise((resolve) => {
    const deadline = Date.now() + 1_000;
    const poll = setInterval(() => {
      if (fs.existsSync(wrapperReady) || Date.now() >= deadline) {
        clearInterval(poll);
        resolve({ type: "lease-failure", error: leaseError });
      }
    }, 5);
  });

  leaseFailure.then(({ error }) => currentTelegramRun().cancel(error));
  await assert.rejects(
    runCommand(process.execPath, [wrapperScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHILD_SCRIPT: childScript,
        SIDE_EFFECT: sideEffect,
        WRAPPER_READY: wrapperReady,
      },
      timeoutMs: 1_000,
    }),
    (error) => error === leaseError,
  );
  await exited(gateway);
  await new Promise((resolve) => {
    setTimeout(resolve, 250);
  });
  assert.equal(fs.existsSync(wrapperReady), true);
  assert.equal(fs.existsSync(sideEffect), false);
  return leaseError;
});

test("successful command parents keep descendants lease-owned until cleanup", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-command-cleanup-fence-"));
  const sideEffect = path.join(temp, "sent");
  const childScript = path.join(temp, "child.cjs");
  const wrapperScript = path.join(temp, "wrapper.cjs");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(
    childScript,
    'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.SIDE_EFFECT,"sent"),200); setInterval(()=>{},1000);',
  );
  fs.writeFileSync(
    wrapperScript,
    'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,[process.env.CHILD_SCRIPT],{env:process.env,stdio:"ignore"}); child.unref();',
  );

  const result = await runCommand(process.execPath, [wrapperScript], {
    cwd: process.cwd(),
    env: { ...process.env, CHILD_SCRIPT: childScript, SIDE_EFFECT: sideEffect },
    timeoutMs: 1_000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  await currentTelegramRun().close();
  await new Promise((resolve) => {
    setTimeout(resolve, 300);
  });
  assert.equal(fs.existsSync(sideEffect), false);
});

test("failed executable launches settle before credential release", async () => {
  const result = await runCommand("/missing/openclaw-telegram-executable", [], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 1_000,
  });
  assert.equal(result.status, null);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /ENOENT/u);
  let released = false;
  await currentTelegramRun().acquire(
    Promise.resolve({
      async release() {
        released = true;
      },
    }),
  );
  await currentTelegramRun().close();
  assert.equal(released, true);
});

test("failed direct probe launches settle before credential release", async () => {
  const probe = ownChild(
    spawn("/missing/openclaw-telegram-uv", [], {
      detached: true,
      stdio: "ignore",
    }),
  );
  const outcome = await watchChildCompletion(probe);
  assert.equal(outcome.type, "spawn-error");
  assert.match(outcome.error.message, /ENOENT/u);
  let released = false;
  await currentTelegramRun().acquire(
    Promise.resolve({
      async release() {
        released = true;
      },
    }),
  );
  await currentTelegramRun().close();
  assert.equal(released, true);
});

test("credential command timeout stops a nested wrapper before its side effect", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-command-timeout-fence-"));
  const sideEffect = path.join(temp, "sent");
  const wrapperReady = path.join(temp, "wrapper-ready");
  const childScript = path.join(temp, "child.cjs");
  const wrapperScript = path.join(temp, "wrapper.cjs");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(
    childScript,
    'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.SIDE_EFFECT,"sent"),1000); setInterval(()=>{},1000);',
  );
  fs.writeFileSync(
    wrapperScript,
    'const fs=require("node:fs"); const {spawn}=require("node:child_process"); spawn(process.execPath,[process.env.CHILD_SCRIPT],{env:process.env,stdio:"ignore"}); fs.writeFileSync(process.env.WRAPPER_READY,"ready"); setInterval(()=>{},1000);',
  );

  const result = await runCommand(process.execPath, [wrapperScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHILD_SCRIPT: childScript,
      SIDE_EFFECT: sideEffect,
      WRAPPER_READY: wrapperReady,
    },
    timeoutMs: 500,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 600);
  });
  assert.equal(result.timedOut, true);
  assert.equal(fs.existsSync(wrapperReady), true);
  assert.equal(fs.existsSync(sideEffect), false);
});

test("clears a leased bot webhook before polling updates", async () => {
  const methods = [];
  const bodies = [];
  const results = [
    { url: "https://example.test/webhook", pending_update_count: 2 },
    true,
    [],
    { url: "", pending_update_count: 0 },
  ];
  const fetchImpl = async (url, init) => {
    methods.push(new URL(url).pathname.split("/").at(-1));
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: results.shift() }),
    };
  };
  const result = await drainSutUpdates(
    "sut-token",
    { assertHealthy: () => {}, whenUnhealthy: new Promise(() => {}) },
    fetchImpl,
  );

  assert.deepEqual(methods, ["getWebhookInfo", "deleteWebhook", "getUpdates", "getWebhookInfo"]);
  assert.deepEqual(bodies[1], { drop_pending_updates: true });
  assert.deepEqual(result, {
    webhookUrlSet: true,
    pendingBefore: 2,
    drained: 0,
    pendingAfter: 0,
  });
});

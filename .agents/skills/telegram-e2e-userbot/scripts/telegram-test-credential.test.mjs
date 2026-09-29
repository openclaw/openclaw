import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resumeQaLease } from "./qa-credential-lease.mjs";
import { runCommand, runTelegramTestScenario } from "./run-mock-sut-user-e2e.mjs";
import {
  acquireTelegramTestCredential,
  parseTelegramTestCredential,
  restoreTelegramTestCredential,
} from "./telegram-test-credential.mjs";
import { checkTelegramTestCredential } from "./telegram-test-doctor.mjs";

function makeCredential() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tg-test-credential-fixture-"));
  fs.mkdirSync(path.join(fixture, "db"));
  fs.writeFileSync(
    path.join(fixture, "config.local.json"),
    JSON.stringify({
      testDc: true,
      testerUserId: 42,
      apiId: 123,
      apiHash: "api-hash",
      databaseEncryptionKey: "database-key",
    }),
  );
  fs.writeFileSync(path.join(fixture, "db", "td_test.binlog"), "tdlib-session");
  const archivePath = path.join(fixture, "session.tgz");
  const packed = spawnSync("tar", ["-czf", archivePath, "config.local.json", "db/td_test.binlog"], {
    cwd: fixture,
  });
  assert.equal(packed.status, 0);
  const archive = fs.readFileSync(archivePath);
  return {
    fixture,
    payload: {
      schemaVersion: 1,
      environment: "test",
      groupId: "-1001",
      sutToken: "100:test-token",
      sutUsername: "sut_bot",
      sutBotId: "100",
      testerUserId: "42",
      tdlibArchiveBase64: archive.toString("base64"),
      tdlibArchiveSha256: createHash("sha256").update(archive).digest("hex"),
      tdlibVersion: "1.8.67",
    },
  };
}

test("validates and restores one isolated Test Server credential", (context) => {
  const { fixture, payload } = makeCredential();
  context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const stateRoot = path.join(fixture, "restored");
  const restored = restoreTelegramTestCredential(payload, stateRoot);
  assert.equal(restored.groupId, "-1001");
  assert.equal(
    restored.driverEnv.TELEGRAM_USER_DRIVER_STATE_DIR,
    path.join(stateRoot, "user-driver"),
  );
  assert.equal(restored.driverEnv.TELEGRAM_USER_DRIVER_SUT_ID, payload.sutBotId);
  assert.equal(restored.driverEnv.TELEGRAM_USER_DRIVER_SUT_USERNAME, payload.sutUsername);
  assert.equal(restored.driverEnv.TELEGRAM_E2E_STATE_DIR, stateRoot);
  assert.equal(Object.hasOwn(restored.driverEnv, "TELEGRAM_E2E_SUT_BOT_TOKEN"), false);
  assert.equal(JSON.stringify(restored.driverEnv).includes(payload.sutToken), false);
  for (const key of [
    "HOME",
    "OPENCLAW_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CACHE_HOME",
    "UV_CACHE_DIR",
    "TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR",
  ]) {
    const directory = restored.driverEnv[key];
    assert.equal(typeof directory, "string", `${key} must be runner-owned`);
    assert.equal(
      path.relative(stateRoot, directory).startsWith(".."),
      false,
      `${key} escaped state`,
    );
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  for (const directory of [stateRoot, restored.userDriverDir]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  assert.equal(fs.statSync(path.join(stateRoot, "credentials.local.json")).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(stateRoot, "credentials.local.json"), "utf8")).sutBotToken,
    payload.sutToken,
  );
  assert.equal(fs.existsSync(path.join(stateRoot, "user-driver", "db", "td_test.binlog")), true);
  fs.rmSync(fixture, { recursive: true, force: true });
});

test(
  "scenario readiness runs the real UV launcher with shared temp ancestors confined",
  {
    skip: process.platform !== "darwin" || spawnSync("uv", ["--version"]).status !== 0,
  },
  async (context) => {
    const { fixture, payload } = makeCredential();
    const root = fs.mkdtempSync("/private/tmp/telegram-readiness-test-");
    context.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(fixture, { recursive: true, force: true });
    });
    const restored = restoreTelegramTestCredential(payload, path.join(root, "state"));
    const script = path.join(root, "status.py");
    // Import and initialize the real driver's private config, but never construct
    // a TDLib client. Only the external authorization response is synthetic.
    fs.writeFileSync(
      script,
      `# /// script\n# requires-python = ">=3.12"\n# ///\n
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("driver", ${JSON.stringify(path.join(import.meta.dirname, "user-driver.py"))})
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
driver.load_config()
print(json.dumps({"ok": True, "authorized": True, "testDc": True, "tdlibVersion": "1.8.67", "user": {"id": 42}}))
`,
    );
    for (const name of ["home", "tmp", "uv-cache"]) {
      fs.mkdirSync(path.join(root, name));
    }
    const policy = path.join(root, "isolation.sb");
    fs.writeFileSync(
      policy,
      `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(root)}))
(deny file-read* (require-all (subpath "/private/tmp") (require-not (subpath ${JSON.stringify(root)}))))
`,
    );
    let releases = 0;
    let driven = false;
    const credential = {
      ...restored,
      driverEnv: {
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        UV_CACHE_DIR: path.join(root, "uv-cache"),
        UV_OFFLINE: "1",
        UV_PYTHON_DOWNLOADS: "never",
        PYTHONDONTWRITEBYTECODE: "1",
        ...restored.driverEnv,
      },
      assertLeaseHealthy() {},
      whenLeaseUnhealthy: new Promise(() => {}),
      async release() {
        releases++;
        fs.rmSync(restored.stateRoot, { recursive: true });
      },
    };
    await runTelegramTestScenario({
      args: { dm: true },
      acquireCredential: async () => credential,
      checkCredential: (leasedCredential) =>
        checkTelegramTestCredential({
          credential: leasedCredential,
          dm: true,
          runCommandImpl: (command, args, options) =>
            runCommand(
              "/usr/bin/sandbox-exec",
              [
                "-f",
                policy,
                command,
                ...args.map((arg) => (arg.endsWith("user-driver.py") ? script : arg)),
              ],
              options,
            ),
          startProxy: async () => ({ apiRoot: "http://127.0.0.1:1", async close() {} }),
          fetchImpl: async () =>
            Response.json({ ok: true, result: { id: 100, username: "sut_bot" } }),
        }),
      driveScenario: async () => {
        driven = true;
      },
    });
    assert.equal(driven, true);
    assert.equal(releases, 1);
    assert.equal(fs.existsSync(restored.stateRoot), false);
  },
);

test("rejects an archive hash mismatch and production credentials", () => {
  const { fixture, payload } = makeCredential();
  assert.throws(
    () =>
      restoreTelegramTestCredential(
        { ...payload, tdlibArchiveSha256: "0".repeat(64) },
        path.join(fixture, "bad"),
      ),
    /hash mismatch/u,
  );
  assert.throws(
    () => parseTelegramTestCredential({ ...payload, environment: "production" }),
    /unsupported schema or environment/u,
  );
  fs.rmSync(fixture, { recursive: true, force: true });
});

test(
  "rejects symbolic links in a leased TDLib archive",
  { skip: process.platform === "win32" },
  () => {
    const { fixture, payload } = makeCredential();
    fs.rmSync(path.join(fixture, "db", "td_test.binlog"));
    fs.symlinkSync("../config.local.json", path.join(fixture, "db", "td_test.binlog"));
    const archivePath = path.join(fixture, "linked-session.tgz");
    const packed = spawnSync(
      "tar",
      ["-czf", archivePath, "config.local.json", "db/td_test.binlog"],
      { cwd: fixture },
    );
    assert.equal(packed.status, 0);
    const archive = fs.readFileSync(archivePath);
    assert.throws(
      () =>
        restoreTelegramTestCredential(
          {
            ...payload,
            tdlibArchiveBase64: archive.toString("base64"),
            tdlibArchiveSha256: createHash("sha256").update(archive).digest("hex"),
          },
          path.join(fixture, "linked-restored"),
        ),
      /unexpected layout/u,
    );
    fs.rmSync(fixture, { recursive: true, force: true });
  },
);

test("removes restored Convex state before releasing the lease", async () => {
  const { fixture, payload } = makeCredential();
  const originalFetch = globalThis.fetch;
  let stateRoot;
  let releaseObservedStateRemoved = false;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/acquire")) {
      return Response.json({
        status: "ok",
        credentialId: "credential-1",
        leaseToken: "lease-token-1",
        payload,
      });
    }
    if (String(url).endsWith("/release")) {
      releaseObservedStateRemoved = stateRoot !== undefined && !fs.existsSync(stateRoot);
    }
    return Response.json({ status: "ok" });
  };
  try {
    const credential = await acquireTelegramTestCredential({
      env: {
        OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.example.test",
        OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
      },
    });
    stateRoot = credential.stateRoot;
    const receipt = path.join(path.dirname(stateRoot), "lease.json");
    const recovery = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.equal(recovery.identity.credentialId, "credential-1");
    assert.equal(recovery.identity.leaseToken, "lease-token-1");
    assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(stateRoot), true);
    await credential.release();
    assert.equal(releaseObservedStateRemoved, true);
    assert.equal(fs.existsSync(receipt), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("failed broker release retains only the private handle for same-owner recovery", async () => {
  const { fixture, payload } = makeCredential();
  const originalFetch = globalThis.fetch;
  const env = {
    OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.example.test",
    OPENCLAW_QA_CONVEX_SECRET_CI: "ci-secret",
  };
  let failRelease = true;
  let acquisitions = 0;
  let leaseDir;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/acquire")) {
      acquisitions += 1;
      return Response.json({
        status: "ok",
        credentialId: "retained-credential",
        leaseToken: "retained-token",
        payload,
      });
    }
    if (String(url).endsWith("/release") && failRelease)
      return Response.json(
        { status: "error", code: "TEMPORARY_FAILURE", message: "release unavailable" },
        { status: 503 },
      );
    return Response.json({ status: "ok" });
  };
  try {
    const credential = await acquireTelegramTestCredential({ env });
    leaseDir = path.dirname(credential.stateRoot);
    const first = credential.release();
    const second = credential.release();
    const failure = await first.catch((error) => error);
    assert.match(failure.message, /TEMPORARY_FAILURE/);
    await assert.rejects(second, (error) => error === failure);
    await assert.rejects(credential.release(), (error) => error === failure);
    assert.equal(
      fs.existsSync(credential.stateRoot),
      false,
      "credential material must be removed before release",
    );
    const recovery = JSON.parse(fs.readFileSync(path.join(leaseDir, "lease.json"), "utf8"));
    failRelease = false;
    const held = await resumeQaLease({ recovery, env });
    assert.equal(held.credentialId, "retained-credential");
    await held.release();
    assert.equal(acquisitions, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (leaseDir) fs.rmSync(leaseDir, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("validates optional forum and distinct participant fixtures without echoing private fields", () => {
  const base = {
    schemaVersion: 1,
    environment: "test",
    groupId: "-1001",
    sutToken: "synthetic-token",
    sutUsername: "sut_bot",
    sutBotId: "200",
    testerUserId: "100",
    tdlibArchiveBase64: "YQ==",
    tdlibArchiveSha256: "a".repeat(64),
    tdlibVersion: "1.8.67",
  };
  const second = {
    alias: "second",
    testerUserId: "101",
    tdlibArchiveBase64: "Yg==",
    tdlibArchiveSha256: "b".repeat(64),
    tdlibVersion: "1.8.67",
  };
  assert.deepEqual(
    parseTelegramTestCredential({
      ...base,
      forumGroupId: "-1002",
      forumTopicId: 42,
      participants: [second],
    }).participants,
    [second],
  );
  for (const patch of [
    { participants: [second, second] },
    { participants: [{ ...second, testerUserId: "100" }] },
    { participants: [{ ...second, alias: "primary" }] },
    { participants: [{ ...second, tdlibArchiveBase64: "private-invalid-value" }] },
    { participants: [{ ...second, tdlibArchiveSha256: "private-invalid-value" }] },
    { forumGroupId: "1002" },
    { forumTopicId: 0 },
  ]) {
    assert.throws(
      () => parseTelegramTestCredential({ ...base, ...patch }),
      (error) => {
        assert.equal(error.message.includes("private-invalid-value"), false);
        assert.equal(error.message.includes(base.sutToken), false);
        return true;
      },
    );
  }
});

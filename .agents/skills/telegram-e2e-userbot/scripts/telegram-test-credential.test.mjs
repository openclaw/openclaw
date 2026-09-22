import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resumeQaLease } from "./qa-credential-lease.mjs";
import {
  acquireTelegramTestCredential,
  parseTelegramTestCredential,
  restoreTelegramTestCredential,
} from "./telegram-test-credential.mjs";

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

test("validates and restores one isolated Test Server credential", () => {
  const { fixture, payload } = makeCredential();
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

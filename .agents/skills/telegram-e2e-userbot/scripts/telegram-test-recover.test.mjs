import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { restoreTelegramTestCredential } from "./telegram-test-credential.mjs";

function restoreCredential(root, directory) {
  const source = path.join(root, "archive-source");
  fs.mkdirSync(path.join(source, "db"), { recursive: true });
  fs.chmodSync(path.join(source, "db"), 0o755);
  fs.writeFileSync(
    path.join(source, "config.local.json"),
    JSON.stringify({
      testDc: true,
      testerUserId: 42,
      apiId: 123,
      apiHash: "api-hash",
      databaseEncryptionKey: "database-key",
    }),
  );
  fs.writeFileSync(path.join(source, "db", "td_test.binlog"), "tdlib-session");
  const archivePath = path.join(root, "session.tgz");
  const packed = spawnSync("tar", ["-czf", archivePath, "config.local.json", "db"], {
    cwd: source,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = fs.readFileSync(archivePath);
  const previousUmask = process.umask(0o022);
  try {
    return restoreTelegramTestCredential(
      {
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
      path.join(directory, "state"),
    );
  } finally {
    process.umask(previousUmask);
  }
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-recovery-test-"));
  const temp = path.join(root, "tmp");
  fs.mkdirSync(temp, { mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(temp, "openclaw-tg-test-credential-"));
  const receipt = path.join(directory, "lease.json");
  const identity = {
    kind: "telegram-test-userbot",
    credentialId: "owned",
    ownerId: "test-owner",
    actorRole: "ci",
    leaseToken: "synthetic",
  };
  fs.writeFileSync(
    receipt,
    JSON.stringify({
      identity,
      leaseTtlMs: 1200000,
      heartbeatIntervalMs: 30000,
    }),
    { mode: 0o600 },
  );
  const methods = [];
  let rejected = false;
  let liveLeaseToken = identity.leaseToken;
  const server = http.createServer(async (request, response) => {
    methods.push(request.url.split("/").at(-1));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const matchingIdentity = Object.entries({ ...identity, leaseToken: liveLeaseToken }).every(
      ([key, value]) => body[key] === value,
    );
    const code = rejected ? "LEASE_EXPIRED" : matchingIdentity ? undefined : "LEASE_NOT_OWNER";
    response.writeHead(code ? 409 : 200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(code ? { status: "error", code, message: code } : { status: "ok" }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    root,
    temp,
    directory,
    receipt,
    methods,
    rejectLease() {
      rejected = true;
    },
    replaceLease() {
      liveLeaseToken = "replacement";
    },
    async run(target = directory, command = "release") {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./telegram-test-recover.mjs", import.meta.url)), target, command],
        {
          env: {
            PATH: root + path.delimiter + process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: temp,
            OPENCLAW_QA_CONVEX_SITE_URL: `http://127.0.0.1:${server.address().port}`,
            OPENCLAW_QA_CONVEX_SECRET_CI: "synthetic",
            OPENCLAW_QA_ALLOW_INSECURE_HTTP: "1",
          },
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const [code] = await once(child, "close");
      return { code, stdout, stderr };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("release removes its receipt but preserves unknown sibling files", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.directory, "operator-notes"), "keep", { mode: 0o600 });
    const result = await f.run();
    assert.equal(
      fs.existsSync(path.join(f.directory, "operator-notes")),
      true,
      "unrelated files must survive broker release",
    );
    assert.equal(fs.readFileSync(path.join(f.directory, "operator-notes"), "utf8"), "keep");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(f.receipt), false);
    assert.deepEqual(f.methods, ["heartbeat", "release"]);
  } finally {
    await f.close();
  }
});

test("cleanup recovers an actual restored archive with ordinary directory modes", async () => {
  const f = await fixture();
  try {
    const restored = restoreCredential(f.root, f.directory);
    assert.equal(fs.statSync(path.join(restored.userDriverDir, "db")).mode & 0o777, 0o755);
    fs.writeFileSync(
      path.join(f.root, "uv"),
      `#!${process.execPath}
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
assert.equal(process.argv[4], "cleanup-group");
assert.equal(fs.readFileSync(path.join(process.env.TELEGRAM_USER_DRIVER_STATE_DIR, "db", "td_test.binlog"), "utf8"), "tdlib-session");
console.log(JSON.stringify({ ok: true, cleaned: true }));
`,
      { mode: 0o700 },
    );
    const result = await f.run(f.directory, "cleanup-group");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, cleaned: true, leaseReleased: true });
    assert.equal(fs.existsSync(f.directory), false);
    assert.deepEqual(f.methods, ["heartbeat", "release"]);
  } finally {
    await f.close();
  }
});

for (const layout of [
  "wrong-root",
  "linked-directory",
  "linked-receipt",
  "linked-state",
  "linked-db",
  "public-directory",
  "public-state",
  "public-user-driver",
  "public-receipt",
]) {
  test(`recovery rejects ${layout} before broker access or deletion`, async () => {
    const f = await fixture();
    try {
      let target = f.directory;
      if (layout === "wrong-root") {
        target = path.join(f.root, path.basename(f.directory));
        fs.renameSync(f.directory, target);
      } else if (layout === "linked-directory") {
        target = path.join(f.temp, "openclaw-tg-test-credential-link");
        fs.symlinkSync(f.directory, target);
      } else if (layout === "linked-receipt") {
        const saved = path.join(f.root, "saved-receipt");
        fs.renameSync(f.receipt, saved);
        fs.symlinkSync(saved, f.receipt);
      } else if (layout === "linked-state") {
        fs.symlinkSync(f.root, path.join(f.directory, "state"));
      } else if (layout === "linked-db") {
        const restored = restoreCredential(f.root, f.directory);
        const db = path.join(restored.userDriverDir, "db");
        fs.renameSync(db, path.join(f.root, "saved-db"));
        fs.symlinkSync(path.join(f.root, "saved-db"), db);
      } else {
        const restored = restoreCredential(f.root, f.directory);
        const boundary = {
          "public-directory": f.directory,
          "public-state": restored.stateRoot,
          "public-user-driver": restored.userDriverDir,
          "public-receipt": f.receipt,
        }[layout];
        fs.chmodSync(boundary, layout === "public-receipt" ? 0o644 : 0o755);
      }
      const result = await f.run(target);
      assert.notEqual(result.code, 0);
      assert.equal(fs.existsSync(path.join(target, "lease.json")), true);
      assert.deepEqual(f.methods, []);
    } finally {
      await f.close();
    }
  });
}

test("expired recovery leaves its receipt and never releases a replacement", async () => {
  const f = await fixture();
  try {
    f.rejectLease();
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LEASE_EXPIRED/);
    assert.equal(fs.existsSync(f.receipt), true);
    assert.deepEqual(f.methods, ["heartbeat"]);
  } finally {
    await f.close();
  }
});

test("a replaced lease cannot clean up retained credential state or release its new owner", async () => {
  const f = await fixture();
  try {
    const restored = restoreCredential(f.root, f.directory);
    f.replaceLease();
    const result = await f.run(f.directory, "cleanup-group");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LEASE_NOT_OWNER/);
    assert.equal(fs.existsSync(f.receipt), true);
    assert.equal(fs.existsSync(restored.stateRoot), true);
    assert.deepEqual(f.methods, ["heartbeat"]);
  } finally {
    await f.close();
  }
});

test("status revalidates a retained broker receipt after credential state was removed", async () => {
  const f = await fixture();
  try {
    const result = await f.run(f.directory, "status");
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      leaseHealthy: true,
      credentialStatePresent: false,
      leaseReleased: false,
    });
    assert.equal(fs.existsSync(f.receipt), true);
    assert.deepEqual(f.methods, ["heartbeat"]);
  } finally {
    await f.close();
  }
});

test("failed group cleanup preserves both credential state and recovery receipt", async () => {
  const f = await fixture();
  try {
    const { stateRoot: state } = restoreCredential(f.root, f.directory);
    fs.writeFileSync(
      path.join(f.root, "uv"),
      "#!/bin/sh\necho 'unconfirmed group creation' >&2\nexit 1\n",
      { mode: 0o700 },
    );
    const result = await f.run(f.directory, "cleanup-group");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unconfirmed group creation/);
    assert.equal(fs.existsSync(f.receipt), true);
    assert.equal(fs.existsSync(state), true);
    assert.deepEqual(f.methods, ["heartbeat"]);
  } finally {
    await f.close();
  }
});

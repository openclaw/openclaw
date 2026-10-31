import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function packCredential(root, member = "db/td_test.binlog", name = "session.tgz") {
  const archivePath = path.join(root, name);
  const packed = spawnSync("tar", ["-czf", archivePath, "config.local.json", member], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = fs.readFileSync(archivePath);
  return {
    tdlibArchiveBase64: archive.toString("base64"),
    tdlibArchiveSha256: createHash("sha256").update(archive).digest("hex"),
  };
}

export function credentialFixture(root, member = "db/td_test.binlog") {
  fs.mkdirSync(path.join(root, "db"), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.join(root, "db"), 0o755);
  fs.writeFileSync(
    path.join(root, "config.local.json"),
    JSON.stringify({
      testDc: true,
      testerUserId: 42,
      apiId: 123,
      apiHash: "api-hash",
      databaseEncryptionKey: "database-key",
    }),
  );
  fs.writeFileSync(path.join(root, "db", "td_test.binlog"), "tdlib-session");
  const emptyPath = path.join(root, "empty-path");
  fs.mkdirSync(emptyPath);
  return {
    hostEnv: { PATH: emptyPath },
    payload: {
      schemaVersion: 1,
      environment: "test",
      groupId: "-1001",
      sutToken: "100:test-token",
      sutUsername: "sut_bot",
      sutBotId: "100",
      testerUserId: "42",
      tdlibVersion: "1.8.67",
      ...packCredential(root, member),
    },
  };
}

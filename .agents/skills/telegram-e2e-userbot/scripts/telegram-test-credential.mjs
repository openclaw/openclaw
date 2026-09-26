#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireQaLease } from "./qa-credential-lease.mjs";

const TELEGRAM_TEST_CREDENTIAL_KIND = "telegram-test-userbot";

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireString(source, key) {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Telegram Test Server credential requires ${key}.`);
  }
  return value.trim();
}

function requireIntegerString(source, key, pattern) {
  const value = requireString(source, key);
  if (!pattern.test(value)) {
    throw new Error(`Telegram Test Server credential has invalid ${key}.`);
  }
  return value;
}

function decodeBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("Telegram Test Server credential has invalid tdlibArchiveBase64.");
  }
  return Buffer.from(value, "base64");
}

export function parseTelegramTestCredential(value) {
  const payload = requireObject(value, "Telegram Test Server credential");
  if (payload.schemaVersion !== 1 || payload.environment !== "test") {
    throw new Error("Telegram Test Server credential has an unsupported schema or environment.");
  }
  const tdlibArchiveSha256 = requireString(payload, "tdlibArchiveSha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(tdlibArchiveSha256)) {
    throw new Error("Telegram Test Server credential has invalid tdlibArchiveSha256.");
  }
  const tdlibArchiveBase64 = requireString(payload, "tdlibArchiveBase64");
  decodeBase64(tdlibArchiveBase64);
  const credential = {
    schemaVersion: 1,
    environment: "test",
    groupId: requireIntegerString(payload, "groupId", /^-?\d+$/u),
    sutToken: requireString(payload, "sutToken"),
    sutUsername: requireString(payload, "sutUsername").replace(/^@/u, ""),
    sutBotId: requireIntegerString(payload, "sutBotId", /^\d+$/u),
    testerUserId: requireIntegerString(payload, "testerUserId", /^\d+$/u),
    tdlibArchiveBase64,
    tdlibArchiveSha256,
    tdlibVersion: requireString(payload, "tdlibVersion"),
  };
  if (payload.forumGroupId !== undefined) {
    credential.forumGroupId = requireIntegerString(payload, "forumGroupId", /^-\d+$/u);
  }
  if (payload.forumTopicId !== undefined) {
    if (!Number.isSafeInteger(payload.forumTopicId) || payload.forumTopicId <= 0) {
      throw new Error("Telegram QA forumTopicId must be a positive integer.");
    }
    credential.forumTopicId = payload.forumTopicId;
  }
  if (payload.participants !== undefined) {
    if (!Array.isArray(payload.participants)) {
      throw new Error("Telegram QA participants must be an array.");
    }
    const identities = new Set([credential.testerUserId]);
    const aliases = new Set(["primary"]);
    credential.participants = payload.participants.map((value) => {
      const participant = requireObject(value, "Telegram QA participant");
      const alias = requireString(participant, "alias");
      if (!/^[a-z][a-z0-9-]*$/u.test(alias) || aliases.has(alias)) {
        throw new Error("Telegram QA participants require distinct lowercase aliases.");
      }
      const parsed = parseTelegramTestCredential({
        ...credential,
        testerUserId: participant.testerUserId,
        tdlibArchiveBase64: participant.tdlibArchiveBase64,
        tdlibArchiveSha256: participant.tdlibArchiveSha256,
        tdlibVersion: participant.tdlibVersion,
      });
      if (identities.has(parsed.testerUserId)) {
        throw new Error("Telegram QA mixed participants require distinct leased user identities.");
      }
      aliases.add(alias);
      identities.add(parsed.testerUserId);
      return {
        alias,
        testerUserId: parsed.testerUserId,
        tdlibArchiveBase64: parsed.tdlibArchiveBase64,
        tdlibArchiveSha256: parsed.tdlibArchiveSha256,
        tdlibVersion: parsed.tdlibVersion,
      };
    });
  }
  return credential;
}

function normalizeArchiveEntry(entry) {
  return entry.replace(/^\.\//u, "").replace(/\/$/u, "");
}

function verifyArchiveEntries(archivePath) {
  const listed = spawnSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error("Telegram Test Server TDLib archive cannot be listed.");
  }
  const entries = listed.stdout.split(/\r?\n/u).filter(Boolean).map(normalizeArchiveEntry);
  const typed = spawnSync("tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (typed.status !== 0) {
    throw new Error("Telegram Test Server TDLib archive types cannot be inspected.");
  }
  const memberTypes = typed.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.trimStart()[0]);
  const allowed = new Set(["config.local.json", "db", "db/td_test.binlog"]);
  if (
    new Set(entries).size !== entries.length ||
    memberTypes.length !== entries.length ||
    !entries.includes("config.local.json") ||
    !entries.includes("db/td_test.binlog") ||
    entries.some((entry) => !allowed.has(entry)) ||
    entries.some((entry, index) => memberTypes[index] !== (entry === "db" ? "d" : "-"))
  ) {
    throw new Error("Telegram Test Server TDLib archive has an unexpected layout.");
  }
}

export function restoreTelegramTestCredential(payloadValue, stateRoot) {
  const payload = parseTelegramTestCredential(payloadValue);
  const root = path.resolve(stateRoot);
  const userDriverDir = path.join(root, "user-driver");
  const archivePath = path.join(root, "tdlib-session.tgz");
  fs.mkdirSync(userDriverDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const archive = decodeBase64(payload.tdlibArchiveBase64);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (sha256 !== payload.tdlibArchiveSha256) {
    throw new Error("Telegram Test Server TDLib archive hash mismatch.");
  }
  fs.writeFileSync(archivePath, archive, { mode: 0o600 });
  verifyArchiveEntries(archivePath);
  const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", userDriverDir], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  fs.rmSync(archivePath, { force: true });
  if (extracted.status !== 0) {
    throw new Error("Telegram Test Server TDLib archive cannot be restored.");
  }
  const configPath = path.join(userDriverDir, "config.local.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (
    config.testDc !== true ||
    String(config.testerUserId) !== payload.testerUserId ||
    typeof config.apiId !== "number" ||
    typeof config.apiHash !== "string" ||
    typeof config.databaseEncryptionKey !== "string"
  ) {
    throw new Error("Telegram Test Server TDLib config does not match the leased tester.");
  }
  fs.chmodSync(configPath, 0o600);
  fs.chmodSync(path.join(userDriverDir, "db", "td_test.binlog"), 0o600);
  const credentialsPath = path.join(root, "credentials.local.json");
  fs.writeFileSync(
    credentialsPath,
    `${JSON.stringify({ groupId: payload.groupId, sutBotToken: payload.sutToken, sutBotId: payload.sutBotId, sutUsername: payload.sutUsername, testerUserId: payload.testerUserId, tdlibVersion: payload.tdlibVersion }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    ...payload,
    stateRoot: root,
    credentialsPath,
    userDriverDir,
    driverEnv: {
      TELEGRAM_E2E_STATE_DIR: root,
      TELEGRAM_USER_DRIVER_STATE_DIR: userDriverDir,
      TELEGRAM_USER_DRIVER_SUT_ID: payload.sutBotId,
      TELEGRAM_USER_DRIVER_SUT_USERNAME: payload.sutUsername,
    },
  };
}

async function cleanupTemporaryCredential(leaseDir, upstreamRelease) {
  fs.rmSync(path.join(leaseDir, "state"), { recursive: true, force: true });
  await upstreamRelease();
  fs.rmSync(leaseDir, { recursive: true, force: true });
}

async function restoreTemporaryCredential(payload, lease) {
  const upstreamRelease = lease.release;
  let leaseDir;
  try {
    leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-test-credential-"));
  } catch (error) {
    await upstreamRelease();
    throw error;
  }
  const stateRoot = path.join(leaseDir, "state");
  try {
    // A failed fixture cleanup must leave a recoverable broker owner after exit.
    fs.writeFileSync(path.join(leaseDir, "lease.json"), JSON.stringify(lease.recovery), {
      mode: 0o600,
    });
    const credential = restoreTelegramTestCredential(payload, stateRoot);
    let releasing;
    return {
      ...credential,
      release: () => {
        releasing ??= cleanupTemporaryCredential(leaseDir, upstreamRelease);
        return releasing;
      },
    };
  } catch (error) {
    try {
      await cleanupTemporaryCredential(leaseDir, upstreamRelease);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Telegram credential restore and cleanup failed.",
      );
    }
    throw error;
  }
}

export async function acquireTelegramTestCredential({ env = process.env, signal } = {}) {
  const lease = await acquireQaLease({ kind: TELEGRAM_TEST_CREDENTIAL_KIND, env, signal });
  const credential = await restoreTemporaryCredential(lease.payload, lease);
  return {
    ...credential,
    credentialSource: "convex",
    credentialId: lease.credentialId,
    assertLeaseHealthy: lease.assertHealthy,
    whenLeaseUnhealthy: lease.whenUnhealthy,
  };
}

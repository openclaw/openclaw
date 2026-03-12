import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { getWempDataRoot } from "../src/storage.js";

const DATA_DIR = getWempDataRoot();

interface FileSnapshot {
  existed: boolean;
  content: string;
}

function snapshotFile(file: string): FileSnapshot {
  if (!existsSync(file)) return { existed: false, content: "" };
  return { existed: true, content: readFileSync(file, "utf8") };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, snapshot.content, "utf8");
}

test("assistant-toggle migrates legacy account file into account/openId isolated storage", async (t) => {
  mkdirSync(path.join(DATA_DIR, "assistant-toggle"), { recursive: true });

  const seed = `${Date.now()}-${Math.random()}`;
  const accountId = `acct/isolated/account/${seed}`;
  const openId = `open/isolated/${seed}`;
  const encodedAccountId = encodeURIComponent(accountId);
  const encodedOpenId = encodeURIComponent(openId);

  const legacyFile = path.join(DATA_DIR, "assistant-toggle.json");
  const legacyAccountFile = path.join(DATA_DIR, "assistant-toggle", `${encodedAccountId}.json`);
  const isolatedAccountDir = path.join(DATA_DIR, "assistant-toggle", encodedAccountId);
  const isolatedOpenFile = path.join(isolatedAccountDir, `${encodedOpenId}.json`);

  const legacySnapshot = snapshotFile(legacyFile);
  const legacyAccountSnapshot = snapshotFile(legacyAccountFile);
  const isolatedSnapshot = snapshotFile(isolatedOpenFile);
  const isolatedDirExisted = existsSync(isolatedAccountDir);

  t.after(() => {
    restoreFile(legacyFile, legacySnapshot);
    restoreFile(legacyAccountFile, legacyAccountSnapshot);
    restoreFile(isolatedOpenFile, isolatedSnapshot);
    if (!isolatedDirExisted) rmSync(isolatedAccountDir, { recursive: true, force: true });
  });

  writeFileSync(legacyAccountFile, JSON.stringify({ [openId]: true }, null, 2), "utf8");
  rmSync(isolatedOpenFile, { force: true });

  const moduleUrl = new URL("../src/features/assistant-toggle.ts", import.meta.url);
  moduleUrl.searchParams.set("seed", seed);
  const feature = await import(moduleUrl.href);

  assert.equal(feature.isAssistantEnabled(accountId, openId), true);
  assert.equal(existsSync(isolatedOpenFile), true);
  assert.equal(JSON.parse(readFileSync(isolatedOpenFile, "utf8")), true);

  feature.setAssistantEnabled(accountId, openId, false);
  assert.equal(JSON.parse(readFileSync(isolatedOpenFile, "utf8")), false);

  const legacyAccountState = JSON.parse(readFileSync(legacyAccountFile, "utf8")) as Record<
    string,
    boolean
  >;
  assert.equal(legacyAccountState[openId], false);
});

test("assistant-toggle migrates legacy aggregated file into account/openId isolated storage", async (t) => {
  mkdirSync(path.join(DATA_DIR, "assistant-toggle"), { recursive: true });

  const seed = `${Date.now()}-${Math.random()}`;
  const accountId = `acct/legacy-aggregate/${seed}`;
  const openId = `open/legacy-aggregate/${seed}`;
  const encodedAccountId = encodeURIComponent(accountId);
  const encodedOpenId = encodeURIComponent(openId);

  const legacyFile = path.join(DATA_DIR, "assistant-toggle.json");
  const legacyAccountFile = path.join(DATA_DIR, "assistant-toggle", `${encodedAccountId}.json`);
  const isolatedAccountDir = path.join(DATA_DIR, "assistant-toggle", encodedAccountId);
  const isolatedOpenFile = path.join(isolatedAccountDir, `${encodedOpenId}.json`);

  const legacySnapshot = snapshotFile(legacyFile);
  const legacyAccountSnapshot = snapshotFile(legacyAccountFile);
  const isolatedSnapshot = snapshotFile(isolatedOpenFile);
  const isolatedDirExisted = existsSync(isolatedAccountDir);

  t.after(() => {
    restoreFile(legacyFile, legacySnapshot);
    restoreFile(legacyAccountFile, legacyAccountSnapshot);
    restoreFile(isolatedOpenFile, isolatedSnapshot);
    if (!isolatedDirExisted) rmSync(isolatedAccountDir, { recursive: true, force: true });
  });

  writeFileSync(legacyFile, JSON.stringify({ [`${accountId}:${openId}`]: true }, null, 2), "utf8");
  rmSync(legacyAccountFile, { force: true });
  rmSync(isolatedOpenFile, { force: true });

  const moduleUrl = new URL("../src/features/assistant-toggle.ts", import.meta.url);
  moduleUrl.searchParams.set("seed", seed);
  const feature = await import(moduleUrl.href);

  assert.equal(feature.isAssistantEnabled(accountId, openId), true);
  assert.equal(JSON.parse(readFileSync(isolatedOpenFile, "utf8")), true);

  const migratedLegacyAccountState = JSON.parse(readFileSync(legacyAccountFile, "utf8")) as Record<
    string,
    boolean
  >;
  assert.equal(migratedLegacyAccountState[openId], true);
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getWempDataRoot } from "../src/storage.js";

const DATA_DIR = getWempDataRoot();
const PERSIST_DEBOUNCE_MS = 60;
const PERSIST_WAIT_MS = PERSIST_DEBOUNCE_MS + 60;

interface FileSnapshot {
  existed: boolean;
  content: string;
}

function snapshotFile(file: string): FileSnapshot {
  if (!existsSync(file)) return { existed: false, content: "" };
  return { existed: true, content: readFileSync(file, "utf8") };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.existed) {
    writeFileSync(file, snapshot.content, "utf8");
    return;
  }
  rmSync(file, { force: true });
}

function useEnvWithRestore(
  t: { after: (callback: () => void) => void },
  key: string,
  value: string,
): void {
  const prev = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (prev === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = prev;
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageLimitOpenIdFile(accountId: string, openId: string): string {
  return path.join(
    DATA_DIR,
    "usage-limit",
    encodeURIComponent(accountId),
    `${encodeURIComponent(openId)}.json`,
  );
}

function yesterday(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

test("assistant-toggle supports legacy fallback and persists per-account file", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.join(DATA_DIR, "assistant-toggle"), { recursive: true });
  useEnvWithRestore(t, "WEMP_ASSISTANT_TOGGLE_PERSIST_DEBOUNCE_MS", `${PERSIST_DEBOUNCE_MS}`);

  const seed = `${Date.now()}-${Math.random()}`;
  const accountId = `acct/assistant/${seed}`;
  const openId = `open-${seed}`;
  const legacyFile = path.join(DATA_DIR, "assistant-toggle.json");
  const accountFile = path.join(
    DATA_DIR,
    "assistant-toggle",
    `${encodeURIComponent(accountId)}.json`,
  );
  const legacySnapshot = snapshotFile(legacyFile);
  const accountSnapshot = snapshotFile(accountFile);

  t.after(() => {
    restoreFile(legacyFile, legacySnapshot);
    restoreFile(accountFile, accountSnapshot);
  });

  writeFileSync(legacyFile, JSON.stringify({ [`${accountId}:${openId}`]: true }, null, 2), "utf8");
  rmSync(accountFile, { force: true });

  const moduleUrl = new URL("../src/features/assistant-toggle.ts", import.meta.url);
  moduleUrl.searchParams.set("seed", seed);
  const feature = await import(moduleUrl.href);

  assert.equal(feature.isAssistantEnabled(accountId, openId), true);
  assert.equal(existsSync(accountFile), true);

  feature.setAssistantEnabled(accountId, openId, false);
  const immediate = JSON.parse(readFileSync(accountFile, "utf8")) as Record<string, boolean>;
  assert.equal(immediate[openId], true);

  await delay(PERSIST_WAIT_MS);
  const persisted = JSON.parse(readFileSync(accountFile, "utf8")) as Record<string, boolean>;
  assert.equal(persisted[openId], false);
});

test("usage-limit migrates legacy account aggregate file into per-openId storage", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.join(DATA_DIR, "usage-limit"), { recursive: true });
  useEnvWithRestore(t, "WEMP_USAGE_LIMIT_PERSIST_DEBOUNCE_MS", `${PERSIST_DEBOUNCE_MS}`);

  const seed = `${Date.now()}-${Math.random()}`;
  const accountId = `acct/usage/${seed}`;
  const openId = `open-${seed}`;
  const legacyFile = path.join(DATA_DIR, "usage-limit.json");
  const legacyAccountFile = path.join(
    DATA_DIR,
    "usage-limit",
    `${accountId.replaceAll("/", "_").replaceAll("\\", "_")}.json`,
  );
  const openIdFile = usageLimitOpenIdFile(accountId, openId);
  const legacySnapshot = snapshotFile(legacyFile);
  const legacyAccountSnapshot = snapshotFile(legacyAccountFile);
  const openIdSnapshot = snapshotFile(openIdFile);

  t.after(() => {
    restoreFile(legacyFile, legacySnapshot);
    restoreFile(legacyAccountFile, legacyAccountSnapshot);
    restoreFile(openIdFile, openIdSnapshot);
  });

  const legacyAccountUsage = {
    [openId]: { messages: 2, tokens: 9, day: today() },
  };
  writeFileSync(legacyFile, JSON.stringify({}, null, 2), "utf8");
  writeFileSync(legacyAccountFile, JSON.stringify(legacyAccountUsage, null, 2), "utf8");
  rmSync(openIdFile, { force: true });

  const moduleUrl = new URL("../src/features/usage-limit.ts", import.meta.url);
  moduleUrl.searchParams.set("seed", seed);
  const feature = await import(moduleUrl.href);

  const before = feature.getUsage(accountId, openId);
  assert.equal(before.messages, 2);
  assert.equal(before.tokens, 9);

  feature.recordUsage(accountId, openId, 5);
  const after = feature.getUsage(accountId, openId);
  assert.equal(after.messages, 3);
  assert.equal(after.tokens, 14);

  const immediate = JSON.parse(readFileSync(openIdFile, "utf8")) as {
    messages: number;
    tokens: number;
    day: string;
  };
  assert.equal(immediate.messages, 2);
  assert.equal(immediate.tokens, 9);

  await delay(PERSIST_WAIT_MS);
  const persisted = JSON.parse(readFileSync(openIdFile, "utf8")) as {
    messages: number;
    tokens: number;
    day: string;
  };
  assert.equal(persisted.messages, 3);
  assert.equal(persisted.tokens, 14);
});

test("usage-limit migrates legacy global aggregate file into per-openId storage", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.join(DATA_DIR, "usage-limit"), { recursive: true });
  useEnvWithRestore(t, "WEMP_USAGE_LIMIT_PERSIST_DEBOUNCE_MS", `${PERSIST_DEBOUNCE_MS}`);

  const seed = `${Date.now()}-${Math.random()}`;
  const accountId = `acct/global/${seed}`;
  const openId = `open-${seed}`;
  const legacyFile = path.join(DATA_DIR, "usage-limit.json");
  const legacyAccountFile = path.join(
    DATA_DIR,
    "usage-limit",
    `${accountId.replaceAll("/", "_").replaceAll("\\", "_")}.json`,
  );
  const openIdFile = usageLimitOpenIdFile(accountId, openId);
  const legacySnapshot = snapshotFile(legacyFile);
  const legacyAccountSnapshot = snapshotFile(legacyAccountFile);
  const openIdSnapshot = snapshotFile(openIdFile);

  t.after(() => {
    restoreFile(legacyFile, legacySnapshot);
    restoreFile(legacyAccountFile, legacyAccountSnapshot);
    restoreFile(openIdFile, openIdSnapshot);
  });

  const legacyGlobalUsage = {
    [`${accountId}:${openId}`]: { messages: 1, tokens: 7, day: today() },
  };
  writeFileSync(legacyFile, JSON.stringify(legacyGlobalUsage, null, 2), "utf8");
  rmSync(legacyAccountFile, { force: true });
  rmSync(openIdFile, { force: true });

  const moduleUrl = new URL("../src/features/usage-limit.ts", import.meta.url);
  moduleUrl.searchParams.set("seed", seed);
  const feature = await import(moduleUrl.href);

  const before = feature.getUsage(accountId, openId);
  assert.equal(before.messages, 1);
  assert.equal(before.tokens, 7);
  assert.equal(existsSync(openIdFile), true);

  feature.recordUsage(accountId, openId, 3);
  const after = feature.getUsage(accountId, openId);
  assert.equal(after.messages, 2);
  assert.equal(after.tokens, 10);

  const immediate = JSON.parse(readFileSync(openIdFile, "utf8")) as {
    messages: number;
    tokens: number;
    day: string;
  };
  assert.equal(immediate.messages, 1);
  assert.equal(immediate.tokens, 7);

  await delay(PERSIST_WAIT_MS);
  const persisted = JSON.parse(readFileSync(openIdFile, "utf8")) as {
    messages: number;
    tokens: number;
    day: string;
  };
  assert.equal(persisted.messages, 2);
  assert.equal(persisted.tokens, 10);
});

test("usage-limit keeps daily reset and exceeded behavior with per-openId storage", async (t) => {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(path.join(DATA_DIR, "usage-limit"), { recursive: true });
  useEnvWithRestore(t, "WEMP_USAGE_LIMIT_PERSIST_DEBOUNCE_MS", `${PERSIST_DEBOUNCE_MS}`);

  const seed = `${Date.now()}-${Math.random()}`;
  const accountId = `acct/reset/${seed}`;
  const openId = `open-${seed}`;
  const legacyFile = path.join(DATA_DIR, "usage-limit.json");
  const legacyAccountFile = path.join(
    DATA_DIR,
    "usage-limit",
    `${accountId.replaceAll("/", "_").replaceAll("\\", "_")}.json`,
  );
  const openIdFile = usageLimitOpenIdFile(accountId, openId);
  const legacySnapshot = snapshotFile(legacyFile);
  const legacyAccountSnapshot = snapshotFile(legacyAccountFile);
  const openIdSnapshot = snapshotFile(openIdFile);

  t.after(() => {
    restoreFile(legacyFile, legacySnapshot);
    restoreFile(legacyAccountFile, legacyAccountSnapshot);
    restoreFile(openIdFile, openIdSnapshot);
  });

  mkdirSync(path.dirname(openIdFile), { recursive: true });
  writeFileSync(
    openIdFile,
    JSON.stringify({ messages: 3, tokens: 12, day: yesterday() }, null, 2),
    "utf8",
  );
  writeFileSync(legacyFile, JSON.stringify({}, null, 2), "utf8");
  rmSync(legacyAccountFile, { force: true });

  const moduleUrl = new URL("../src/features/usage-limit.ts", import.meta.url);
  moduleUrl.searchParams.set("seed", seed);
  const feature = await import(moduleUrl.href);

  const reset = feature.getUsage(accountId, openId);
  assert.equal(reset.messages, 0);
  assert.equal(reset.tokens, 0);
  assert.equal(feature.isUsageExceeded(accountId, openId, { dailyMessages: 1 }), false);
  assert.equal(feature.isUsageExceeded(accountId, openId, { dailyTokens: 1 }), false);

  feature.recordUsage(accountId, openId, 2);
  const after = feature.getUsage(accountId, openId);
  assert.equal(after.messages, 1);
  assert.equal(after.tokens, 2);
  assert.equal(feature.isUsageExceeded(accountId, openId, { dailyMessages: 1 }), true);
  assert.equal(feature.isUsageExceeded(accountId, openId, { dailyTokens: 3 }), false);

  const immediate = JSON.parse(readFileSync(openIdFile, "utf8")) as {
    messages: number;
    tokens: number;
    day: string;
  };
  assert.equal(immediate.messages, 3);
  assert.equal(immediate.tokens, 12);

  await delay(PERSIST_WAIT_MS);
  const persisted = JSON.parse(readFileSync(openIdFile, "utf8")) as {
    messages: number;
    tokens: number;
    day: string;
  };
  assert.equal(persisted.messages, 1);
  assert.equal(persisted.tokens, 2);
});

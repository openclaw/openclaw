import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  base64url,
  generateIdentity,
  signReceipt,
  verifyChain,
  type ReviewRequest,
} from "../protocol/index.js";
import {
  clearReefSetupSession,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  loadReefSetupSession,
  openStores,
  saveReefIdentityBinding,
  saveReefSetupSession,
} from "./state.js";

const auditKey = base64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const replayKey = base64url(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
const receiptId = "01JZ0000000000000000000000";

function createRuntime(stateDir: string) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return runtime;
}

describe("Reef SQLite state", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-state-"));
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists keys and registration state without creating Reef files", async () => {
    const runtime = createRuntime(stateDir);
    const keys = await generateAndStoreKeys(runtime);
    saveReefIdentityBinding(runtime, { handle: "molty", relayUrl: "https://reefwire.ai" });
    saveReefSetupSession(runtime, {
      session: "setup-secret",
      relayUrl: "https://reefwire.ai",
      email: "molty@example.com",
    });

    expect(await loadKeys(createRuntime(stateDir))).toEqual(keys);
    expect(loadReefIdentityBinding(createRuntime(stateDir))).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
    expect(loadReefSetupSession(createRuntime(stateDir))?.session).toBe("setup-secret");
    clearReefSetupSession(runtime);
    expect(loadReefSetupSession(runtime)).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "data", "reef"))).toBe(false);
  });

  it("appends and reopens a verified audit chain", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const first = openStores(createRuntime(stateDir), keys);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        first.audit.appendEvent("test", { id: index }, 10 + index),
      ),
    );

    const reopened = await openStores(createRuntime(stateDir), keys).audit.entries();
    expect(reopened).toHaveLength(20);
    expect(verifyChain(reopened)).toBe(true);
  });

  it("roundtrips encrypted replay completions and durable dedupe state", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const stores = openStores(createRuntime(stateDir), keys);
    const receipt = signReceipt(
      {
        id: receiptId,
        bodyHash: "a".repeat(64),
        auditHead: "b".repeat(64),
        status: "accepted",
      },
      identity.signing.secretKey,
    );
    const body = { text: "RECOVERABLE SECRET BODY" };

    await expect(stores.replay.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("new");
    await stores.replay.complete("alice", receiptId, receipt, body);
    const reopened = openStores(createRuntime(stateDir), keys).replay;
    await expect(reopened.claim("alice", receiptId, "c".repeat(64))).resolves.toBe("duplicate");
    await expect(reopened.completed("alice", receiptId)).resolves.toEqual({ receipt, body });
    await expect(reopened.claim("alice", receiptId, "d".repeat(64))).resolves.toBe("mismatch");

    const raw = createPluginStateSyncKeyedStoreForTests<unknown>("reef", {
      namespace: "replay",
      maxEntries: 3_000,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    expect(JSON.stringify(raw.entries())).not.toContain(body.text);
  });

  it("persists review decisions and delivered ids", async () => {
    const identity = generateIdentity();
    const keys = { ...identity, auditKey, replayKey, keyEpoch: 1 };
    const stores = openStores(createRuntime(stateDir), keys);
    const review: ReviewRequest = {
      id: receiptId,
      from: "alice#1",
      to: "bob#1",
      direction: "outbound",
      bodyHash: "a".repeat(64),
      approvalDigest: "b".repeat(64),
      verdict: {
        decision: "review",
        category: "ambiguous",
        reason: "Owner review.",
        model: "test-model",
        policyVersion: "v1",
      },
    };

    await expect(stores.reviews.request(review)).resolves.toBeUndefined();
    await expect(stores.reviews.decide(review.approvalDigest, true)).resolves.toBe(true);
    await expect(
      openStores(createRuntime(stateDir), keys).reviews.request(review),
    ).resolves.toEqual({
      approved: true,
      approvalDigest: review.approvalDigest,
    });
    await stores.delivered.add(receiptId);
    await expect(openStores(createRuntime(stateDir), keys).delivered.has(receiptId)).resolves.toBe(
      true,
    );
  });
});

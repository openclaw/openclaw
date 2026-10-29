import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuDedupeState } from "./dedup-state.js";
import {
  claimUnprocessedFeishuMessage as claimMessage,
  finalizeFeishuMessageProcessing as finalizeMessage,
  hasProcessedFeishuMessage,
  warmupDedupFromPluginState,
} from "./dedup.js";

let tempDir: string | undefined;
const message = (messageId: string) => ({ messageId, namespace: "account-a" });

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-feishu-dedup-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
  feishuDedupeState.reset();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

// Reopen SQLite with an empty guard so replay detection must read committed rows.
async function restartFeishuDedup(): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
  feishuDedupeState.reset();
}

describe("Feishu claimable dedupe", () => {
  it("preserves committed marks but not pending claims across a restart", async () => {
    const params = message("msg-4");
    await expect(claimMessage(params)).resolves.toMatchObject({ kind: "claimed" });
    await restartFeishuDedup();
    await expect(finalizeMessage(params)).resolves.toBe(true);

    await restartFeishuDedup();
    await expect(claimMessage(params)).resolves.toEqual({ kind: "duplicate" });
    await expect(finalizeMessage(params)).resolves.toBe(false);
  });

  it("commits a held claim without reclaiming it", async () => {
    const params = message("msg-5");
    const claim = await claimMessage(params);
    assert(claim.kind === "claimed");
    await expect(finalizeMessage({ ...params, processingClaim: claim.handle })).resolves.toBe(true);
    await expect(finalizeMessage(params)).resolves.toBe(false);
  });

  it("warms memory from persisted plugin state", async () => {
    const params = message("msg-7");
    await expect(finalizeMessage(params)).resolves.toBe(true);
    await restartFeishuDedup();

    await expect(warmupDedupFromPluginState("account-a")).resolves.toBe(1);
    await expect(finalizeMessage(params)).resolves.toBe(false);
  });

  it("ignores committed messages after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await expect(finalizeMessage(message("msg-8"))).resolves.toBe(true);
    await restartFeishuDedup();

    vi.setSystemTime(1_000 + 24 * 60 * 60 * 1000 + 1);
    await expect(hasProcessedFeishuMessage("msg-8", "account-a")).resolves.toBe(false);
  });

  it("keeps deduping in memory and logs when plugin-state persistence fails", async () => {
    // A regular file where the state dir should be makes every SQLite open fail.
    const blockedPath = path.join(tempDir as string, "not-a-dir");
    fs.writeFileSync(blockedPath, "x", "utf8");
    process.env.OPENCLAW_STATE_DIR = path.join(blockedPath, "nested");
    const log = vi.fn();
    const params = { ...message("msg-9"), log };

    await expect(finalizeMessage(params)).resolves.toBe(true);
    await expect(claimMessage(params)).resolves.toEqual({ kind: "duplicate" });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("feishu-dedup: persistent state error"),
    );
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCortexCaptureHistory,
  getCachedLatestCortexCaptureHistoryEntry,
  getLatestCortexCaptureHistoryEntry,
  getLatestCortexCaptureHistoryEntrySync,
  readRecentCortexCaptureHistory,
} from "./cortex-history.js";

describe("cortex capture history", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("appends and reads recent capture history", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-history-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await appendCortexCaptureHistory({
      agentId: "main",
      sessionId: "session-1",
      channelId: "channel-1",
      captured: true,
      score: 0.7,
      reason: "high-signal memory candidate",
      timestamp: 1_000,
    });

    const recent = await readRecentCortexCaptureHistory({ limit: 5 });

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      agentId: "main",
      captured: true,
      reason: "high-signal memory candidate",
    });
  });

  it("returns the latest matching capture entry in async and sync modes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-history-sync-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await appendCortexCaptureHistory({
      agentId: "main",
      sessionId: "session-1",
      channelId: "channel-1",
      captured: false,
      score: 0.1,
      reason: "low-signal short reply",
      timestamp: 1_000,
    });
    await appendCortexCaptureHistory({
      agentId: "main",
      sessionId: "session-1",
      channelId: "channel-1",
      captured: true,
      score: 0.7,
      reason: "high-signal memory candidate",
      syncedCodingContext: true,
      syncPlatforms: ["claude-code", "cursor", "copilot"],
      timestamp: 2_000,
    });

    const asyncEntry = await getLatestCortexCaptureHistoryEntry({
      agentId: "main",
      sessionId: "session-1",
      channelId: "channel-1",
    });
    const cachedEntry = getCachedLatestCortexCaptureHistoryEntry({
      agentId: "main",
      sessionId: "session-1",
      channelId: "channel-1",
    });
    const syncEntry = getLatestCortexCaptureHistoryEntrySync({
      agentId: "main",
      sessionId: "session-1",
      channelId: "channel-1",
    });

    expect(asyncEntry?.timestamp).toBe(2_000);
    expect(asyncEntry?.syncedCodingContext).toBe(true);
    expect(cachedEntry?.timestamp).toBe(2_000);
    expect(syncEntry?.timestamp).toBe(2_000);
    expect(syncEntry?.syncPlatforms).toEqual(["claude-code", "cursor", "copilot"]);
  });

  it("finds an older matching conversation entry even when newer unrelated entries exceed 100", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cortex-history-scan-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await appendCortexCaptureHistory({
      agentId: "main",
      sessionId: "session-target",
      channelId: "channel-target",
      captured: true,
      score: 0.8,
      reason: "target conversation capture",
      timestamp: 1_000,
    });

    for (let index = 0; index < 150; index += 1) {
      await appendCortexCaptureHistory({
        agentId: "main",
        sessionId: `session-${index}`,
        channelId: `channel-${index}`,
        captured: true,
        score: 0.5,
        reason: `other capture ${index}`,
        timestamp: 2_000 + index,
      });
    }

    const asyncEntry = await getLatestCortexCaptureHistoryEntry({
      agentId: "main",
      sessionId: "session-target",
      channelId: "channel-target",
    });
    const syncEntry = getLatestCortexCaptureHistoryEntrySync({
      agentId: "main",
      sessionId: "session-target",
      channelId: "channel-target",
    });

    expect(asyncEntry?.reason).toBe("target conversation capture");
    expect(asyncEntry?.timestamp).toBe(1_000);
    expect(syncEntry?.reason).toBe("target conversation capture");
    expect(syncEntry?.timestamp).toBe(1_000);
  });
});

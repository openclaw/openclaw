import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectSlackMissionId,
  persistSlackMissionThread,
  resolveSlackMissionThread,
} from "./mission-threads.js";

let tmpDir: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-slack-mission-"));
  process.env.OPENCLAW_SLACK_MISSION_THREAD_STORE = path.join(tmpDir, "threads.json");
});

afterEach(async () => {
  delete process.env.OPENCLAW_SLACK_MISSION_THREAD_STORE;
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("Slack mission thread store", () => {
  it("detects explicit mission lines", () => {
    expect(detectSlackMissionId("Mission: thread-routing-final-test")).toBe(
      "thread-routing-final-test",
    );
  });

  it("ignores branch-like text without an explicit mission marker", () => {
    expect(detectSlackMissionId("Continue feat/read-only-ui-verify now")).toBeUndefined();
    expect(detectSlackMissionId("THREADING TEST")).toBeUndefined();
  });

  it("persists and resolves canonical mission threads", async () => {
    await persistSlackMissionThread({
      missionId: "feat/thread-routing",
      channelId: "C123",
      threadTs: "111.222",
      ownerAgent: "melvin",
      createdFromMessageTs: "111.222",
    });

    const resolved = await resolveSlackMissionThread({
      missionId: "feat/thread-routing",
      channelId: "C123",
    });

    expect(resolved).toMatchObject({
      platform: "slack",
      missionId: "feat/thread-routing",
      channelId: "C123",
      threadTs: "111.222",
      ownerAgent: "melvin",
      createdFromMessageTs: "111.222",
      routingPolicy: "thread_required",
    });
  });

  it("scopes canonical mission threads by Slack account", async () => {
    await persistSlackMissionThread({
      missionId: "shared-mission",
      accountId: "lettuce",
      teamId: "T_LETTUCE",
      channelId: "C123",
      threadTs: "111.222",
    });
    await persistSlackMissionThread({
      missionId: "shared-mission",
      accountId: "proof",
      teamId: "T_PROOF",
      channelId: "C123",
      threadTs: "333.444",
    });

    await expect(
      resolveSlackMissionThread({
        missionId: "shared-mission",
        accountId: "lettuce",
        channelId: "C123",
      }),
    ).resolves.toMatchObject({
      accountId: "lettuce",
      teamId: "T_LETTUCE",
      threadTs: "111.222",
    });
    await expect(
      resolveSlackMissionThread({
        missionId: "shared-mission",
        accountId: "proof",
        channelId: "C123",
      }),
    ).resolves.toMatchObject({
      accountId: "proof",
      teamId: "T_PROOF",
      threadTs: "333.444",
    });
    await expect(
      resolveSlackMissionThread({
        missionId: "shared-mission",
        accountId: "unknown",
        channelId: "C123",
      }),
    ).resolves.toBeUndefined();
  });
});

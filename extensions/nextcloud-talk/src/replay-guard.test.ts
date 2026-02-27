import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNextcloudTalkReplayGuard } from "./replay-guard.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nextcloud-talk-replay-"));
  tempDirs.push(dir);
  return dir;
}

describe("createNextcloudTalkReplayGuard", () => {
  it("persists replay decisions across guard instances", async () => {
    const stateDir = await makeTempDir();

    const firstGuard = createNextcloudTalkReplayGuard({ stateDir });
    const firstAttempt = await firstGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });
    const replayAttempt = await firstGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });

    const secondGuard = createNextcloudTalkReplayGuard({ stateDir });
    const restartReplayAttempt = await secondGuard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-1",
    });

    expect(firstAttempt).toBe(true);
    expect(replayAttempt).toBe(false);
    expect(restartReplayAttempt).toBe(false);
  });

  it("scopes replay state by account namespace", async () => {
    const stateDir = await makeTempDir();
    const guard = createNextcloudTalkReplayGuard({ stateDir });

    const accountAFirst = await guard.shouldProcessMessage({
      accountId: "account-a",
      roomToken: "room-1",
      messageId: "msg-9",
    });
    const accountBFirst = await guard.shouldProcessMessage({
      accountId: "account-b",
      roomToken: "room-1",
      messageId: "msg-9",
    });

    expect(accountAFirst).toBe(true);
    expect(accountBFirst).toBe(true);
  });
});

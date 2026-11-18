import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IMinimalEvent, IRoomEvent, ISyncResponse } from "matrix-js-sdk/lib/matrix.js";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, vi } from "vitest";
import { installMatrixTestRuntime } from "../../test-runtime.js";

export function useSyncStoreFixture(prefix: string, sdkDeadlines = false) {
  let root: string;
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installMatrixTestRuntime();
    root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    if (sdkDeadlines) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
  });
  afterEach(async () => {
    // SDK HTTP deadlines outlive completed requests; drain only after sync stops.
    if (sdkDeadlines) {
      await vi.runOnlyPendingTimersAsync();
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (sdkDeadlines) {
      vi.unstubAllGlobals();
    }
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get root() {
      return root;
    },
  };
}

export function matrixSyncResponse(
  nextBatch: string,
  roomId: string,
  event: IRoomEvent,
  prevBatch: string,
  accountData: IMinimalEvent[] = [],
): ISyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {
        [roomId]: {
          summary: { "m.heroes": [] },
          state: { events: [] },
          timeline: { events: [event], prev_batch: prevBatch },
          ephemeral: { events: [] },
          account_data: { events: [] },
          unread_notifications: {},
        },
      },
      invite: {},
      leave: {},
      knock: {},
    },
    account_data: { events: accountData },
  };
}

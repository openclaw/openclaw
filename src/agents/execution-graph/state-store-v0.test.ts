import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileExecutionGraphStateStoreV0,
  createInMemoryExecutionGraphStateStoreV0,
} from "./state-store-v0.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore test cleanup failures
    }
  }
});

describe("FileExecutionGraphStateStoreV0", () => {
  it("persists and reloads node state schema fields", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-graph-v0-store-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const store = new FileExecutionGraphStateStoreV0(process.env);
    store.save({
      version: 1,
      graphId: "sessions_send_a2a_announce_v0",
      runId: "run-123",
      planVersion: "sessions-send-a2a/graph-v0",
      createdAtMs: 100,
      updatedAtMs: 200,
      nodeStates: {
        deliver_announce: {
          nodeId: "deliver_announce",
          status: "succeeded",
          planVersion: "sessions-send-a2a/graph-v0",
          inputsHash: "abc123",
          outputsSummary: "delivered=true",
          errorTrace: undefined,
          output: { delivered: true },
          startedAtMs: 150,
          updatedAtMs: 200,
          attempts: 1,
        },
      },
    });

    const loaded = store.load({
      graphId: "sessions_send_a2a_announce_v0",
      runId: "run-123",
    });

    expect(loaded).toBeDefined();
    expect(loaded?.planVersion).toBe("sessions-send-a2a/graph-v0");
    expect(loaded?.nodeStates.deliver_announce).toMatchObject({
      status: "succeeded",
      inputsHash: "abc123",
      outputsSummary: "delivered=true",
      attempts: 1,
    });
  });

  it("supports deterministic in-memory store access", () => {
    const store = createInMemoryExecutionGraphStateStoreV0();
    store.save({
      version: 1,
      graphId: "g",
      runId: "r",
      planVersion: "v0",
      createdAtMs: 1,
      updatedAtMs: 1,
      nodeStates: {},
    });

    const loaded = store.load({ graphId: "g", runId: "r" });
    expect(loaded).toBeDefined();
    expect(loaded?.graphId).toBe("g");
    expect(loaded?.runId).toBe("r");
  });
});

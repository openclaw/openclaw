import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import { appendRawStream } from "./pi-embedded-subscribe.raw-stream.js";

describe("appendRawStream", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("stores default raw stream events in SQLite state", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-raw-stream-"));
    try {
      vi.stubEnv("OPENCLAW_RAW_STREAM", "1");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

      appendRawStream({ type: "chunk", text: "hello" });

      const entries = listOpenClawStateKvJson<Record<string, unknown>>("diagnostics.raw_stream", {
        env: process.env,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.value).toMatchObject({ type: "chunk", text: "hello" });
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as fsSafe from "../infra/fs-safe.js";
import { appendRawStream } from "./embedded-agent-subscribe.raw-stream.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let target: string;
const unhandledRejections: unknown[] = [];
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};
beforeEach(() => {
  target = path.join(tempDirs.make("openclaw-raw-stream-test-"), "raw.jsonl");
  vi.stubEnv("OPENCLAW_RAW_STREAM", "true");
  vi.stubEnv("OPENCLAW_RAW_STREAM_PATH", target);
  process.on("unhandledRejection", onUnhandledRejection);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandledRejection);
  vi.unstubAllEnvs();
  expect(unhandledRejections.splice(0)).toEqual([]);
});

describe("appendRawStream", () => {
  it("contains a real rejected append without leaking an unhandled rejection", async () => {
    fs.mkdirSync(target);
    expect(() => appendRawStream(() => ({ event: "test", ts: 1 }), undefined)).not.toThrow();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });

  it("snapshots the factory result before appending exact JSONL", async ({ signal }) => {
    const append = vi.spyOn(fsSafe, "appendRegularFile");
    const payload = { event: "test", ts: 1 };
    try {
      appendRawStream(() => payload, undefined);
      payload.ts = 2;
      // The real append owns both the write and handle close; keep its completion promise.
      await withinTest(append.mock.results[0]!.value, signal);
      expect(fs.readFileSync(target, "utf8")).toBe('{"event":"test","ts":1}\n');
    } finally {
      append.mockRestore();
    }
  });

  it("does not evaluate Incognito stream content or create a log file", () => {
    const createPayload = vi.fn(() => ({ rawText: "synthetic private reply" }));
    appendRawStream(createPayload, "agent:main:internal-session-effects:incognito-private");
    expect(createPayload).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("contains synchronous factory and JSON serialization failures", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    expect(() => appendRawStream(() => payload, undefined)).not.toThrow();
    expect(() =>
      appendRawStream(() => {
        throw new Error("payload unavailable");
      }, undefined),
    ).not.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });
});

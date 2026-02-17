import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  getActiveEmbeddedPiRunMeta,
  isEmbeddedPiRunActive,
  releaseEmbeddedPiRunLockOnTimeout,
  setActiveEmbeddedRun,
} from "./runs.js";

describe("embedded run single-flight metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps active run metadata for lock rejection context", () => {
    const handle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
      abort: vi.fn(),
    };

    setActiveEmbeddedRun("session-singleflight-meta", handle, { runId: "run-meta-1" });

    const meta = getActiveEmbeddedPiRunMeta("session-singleflight-meta");
    expect(meta?.runId).toBe("run-meta-1");
    expect(typeof meta?.startedAt).toBe("number");
    clearActiveEmbeddedRun("session-singleflight-meta", handle);
  });

  it("releases stale lock on timeout and aborts active handle", () => {
    const handle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
      abort: vi.fn(),
    };

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    setActiveEmbeddedRun("session-singleflight-timeout", handle, { runId: "run-stale-1" });

    now.mockReturnValue(25_500);
    const result = releaseEmbeddedPiRunLockOnTimeout("session-singleflight-timeout", 20_000);

    expect(result.released).toBe(true);
    expect(result.runId).toBe("run-stale-1");
    expect(result.ageMs).toBe(24_500);
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(isEmbeddedPiRunActive("session-singleflight-timeout")).toBe(false);
    expect(getActiveEmbeddedPiRunMeta("session-singleflight-timeout")).toBeUndefined();
  });
});

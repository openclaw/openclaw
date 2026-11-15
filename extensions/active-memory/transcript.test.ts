import { beforeEach, describe, expect, it, vi } from "vitest";

const { readDelta } = vi.hoisted(() => ({ readDelta: vi.fn() }));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>()),
  readSessionTranscriptRawDelta: readDelta,
}));

import { streamActiveMemoryTranscriptRecords } from "./transcript.js";

describe("active-memory transcript consumers", () => {
  beforeEach(() => {
    readDelta.mockResolvedValue({
      kind: "page",
      events: [{ event: { role: "assistant" } }, { event: { role: "toolResult" } }],
    });
  });

  it("propagates consumer failures instead of reporting a complete scan", async () => {
    const failure = new Error("consumer failed");
    const onRecord = vi.fn(() => {
      throw failure;
    });
    await expect(
      streamActiveMemoryTranscriptRecords({
        source: { agentId: "main", sessionId: "synthetic", sessionKey: "agent:main:synthetic" },
        onRecord,
      }),
    ).rejects.toBe(failure);
    expect(onRecord).toHaveBeenCalledTimes(1);
  });

  it("stops when its consumer has found the requested record", async () => {
    const onRecord = vi.fn(() => true);
    await streamActiveMemoryTranscriptRecords({
      source: { agentId: "main", sessionId: "synthetic", sessionKey: "agent:main:synthetic" },
      onRecord,
    });
    expect(onRecord).toHaveBeenCalledExactlyOnceWith({ role: "assistant" });
  });
});

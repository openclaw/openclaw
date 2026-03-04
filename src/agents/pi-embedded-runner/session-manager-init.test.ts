import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSessionManagerForRun } from "./session-manager-init.js";

vi.mock("node:fs/promises", () => ({
  default: { writeFile: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeSm(fileEntries: Array<{ type: string; [key: string]: unknown }>) {
  return {
    sessionId: "test-session",
    flushed: true,
    fileEntries,
    byId: new Map(),
    labelsById: new Map(),
    leafId: "leaf-1",
  };
}

describe("prepareSessionManagerForRun", () => {
  it("resets session when no assistant and no custom entries", async () => {
    const sm = makeSm([
      { type: "session", id: "s1", cwd: "/tmp" },
      { type: "message", message: { role: "user" } },
    ]);
    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile: "/tmp/session.json",
      hadSessionFile: true,
      sessionId: "s1",
      cwd: "/tmp",
    });
    expect(fs.writeFile).toHaveBeenCalledWith("/tmp/session.json", "", "utf-8");
    expect(sm.fileEntries).toHaveLength(1);
    expect(sm.flushed).toBe(false);
  });

  it("preserves session when no assistant but custom entries exist (prompt-error)", async () => {
    const sm = makeSm([
      { type: "session", id: "s1", cwd: "/tmp" },
      { type: "message", message: { role: "user" } },
      { type: "openclaw:prompt-error", timestamp: Date.now() },
    ]);
    await prepareSessionManagerForRun({
      sessionManager: sm,
      sessionFile: "/tmp/session.json",
      hadSessionFile: true,
      sessionId: "s1",
      cwd: "/tmp",
    });
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(sm.fileEntries).toHaveLength(3);
    expect(sm.flushed).toBe(true);
  });
});

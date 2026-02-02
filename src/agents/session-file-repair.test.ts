import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repairSessionFileIfNeeded } from "./session-file-repair.js";

describe("repairSessionFileIfNeeded", () => {
  it("rewrites session files that contain malformed lines", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-repair-"));
    const file = path.join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: 7,
      id: "session-1",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    };
    const message = {
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello" },
    };

    const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n{"type":"message"`;
    await fs.writeFile(file, content, "utf-8");

    const result = await repairSessionFileIfNeeded({ sessionFile: file });
    expect(result.repaired).toBe(true);
    expect(result.droppedLines).toBe(1);
    expect(result.backupPath).toBeTruthy();

    const repaired = await fs.readFile(file, "utf-8");
    expect(repaired.trim().split("\n")).toHaveLength(2);

    if (result.backupPath) {
      const backup = await fs.readFile(result.backupPath, "utf-8");
      expect(backup).toBe(content);
    }
  });
});

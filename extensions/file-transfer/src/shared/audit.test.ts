// Audit log path honors OPENCLAW_STATE_DIR so an isolated gateway writes its
// file-transfer audit alongside the rest of its state, not always ~/.openclaw.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("file-transfer audit log path", () => {
  it("writes the audit log under OPENCLAW_STATE_DIR when set", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    tmpRoots.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;

    vi.resetModules();
    const { appendFileTransferAudit } = await import("./audit.js");

    await appendFileTransferAudit({
      op: "file.fetch",
      nodeId: "node-1",
      requestedPath: "/tmp/example.txt",
      decision: "allowed",
    });

    delete process.env.OPENCLAW_STATE_DIR;

    const logPath = path.join(stateDir, "audit", "file-transfer.jsonl");
    const contents = await fs.readFile(logPath, "utf8");
    expect(contents).toContain('"op":"file.fetch"');
    expect(contents).toContain('"nodeId":"node-1"');
    expect(contents).toContain('"requestedPath":"/tmp/example.txt"');
    expect(contents).toContain('"decision":"allowed"');
  });
});

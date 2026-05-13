import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileTransferAudit, listFileTransferAuditRecordsForTests } from "./audit.js";

const tempDirs: string[] = [];

async function makeStateDir(): Promise<string> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-file-transfer-audit-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  resetPluginStateStoreForTests();
  return stateDir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  resetPluginStateStoreForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("file-transfer audit", () => {
  it("stores audit decisions in SQLite plugin state", async () => {
    await makeStateDir();

    await appendFileTransferAudit({
      op: "file.fetch",
      nodeId: "node-1",
      nodeDisplayName: "Node 1",
      requestedPath: "/tmp/input.txt",
      canonicalPath: "/private/tmp/input.txt",
      decision: "allowed",
      sizeBytes: 12,
      sha256: "abc123",
      durationMs: 7,
      requesterAgentId: "main",
      sessionKey: "agent:main:main",
    });

    const records = await listFileTransferAuditRecordsForTests();

    expect(records).toMatchObject([
      {
        op: "file.fetch",
        nodeId: "node-1",
        nodeDisplayName: "Node 1",
        requestedPath: "/tmp/input.txt",
        canonicalPath: "/private/tmp/input.txt",
        decision: "allowed",
        sizeBytes: 12,
        sha256: "abc123",
        durationMs: 7,
        requesterAgentId: "main",
        sessionKey: "agent:main:main",
      },
    ]);
    expect(Date.parse(records[0].timestamp)).toBeGreaterThan(0);
  });
});

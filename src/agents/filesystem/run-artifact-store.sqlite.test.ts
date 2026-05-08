import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createSqliteRunArtifactStore,
  deleteSqliteRunArtifacts,
  exportSqliteRunArtifacts,
  listSqliteRunArtifacts,
  readSqliteRunArtifact,
  writeSqliteRunArtifact,
} from "./run-artifact-store.sqlite.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-run-artifacts-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite run artifact store", () => {
  it("stores path-addressed artifacts by agent and run", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    expect(
      writeSqliteRunArtifact({
        env,
        agentId: "Main",
        runId: "run-1",
        path: "reports/summary.txt",
        kind: "text",
        metadata: { source: "worker" },
        blob: "hello",
        now: () => 1000,
      }),
    ).toEqual({
      agentId: "main",
      runId: "run-1",
      path: "/reports/summary.txt",
      kind: "text",
      metadata: { source: "worker" },
      size: 5,
      createdAt: 1000,
    });
    writeSqliteRunArtifact({
      env,
      agentId: "ops",
      runId: "run-1",
      path: "reports/summary.txt",
      kind: "text",
      blob: "ops",
    });

    expect(listSqliteRunArtifacts({ env, agentId: "main", runId: "run-1" })).toEqual([
      {
        agentId: "main",
        runId: "run-1",
        path: "/reports/summary.txt",
        kind: "text",
        metadata: { source: "worker" },
        size: 5,
        createdAt: 1000,
      },
    ]);
    expect(
      readSqliteRunArtifact({
        env,
        agentId: "main",
        runId: "run-1",
        path: "/reports/summary.txt",
      }),
    ).toEqual({
      agentId: "main",
      runId: "run-1",
      path: "/reports/summary.txt",
      kind: "text",
      metadata: { source: "worker" },
      size: 5,
      createdAt: 1000,
      blobBase64: "aGVsbG8=",
    });
  });

  it("lists by prefix, exports blobs, and deletes a run", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };

    writeSqliteRunArtifact({
      env,
      agentId: "main",
      runId: "run-1",
      path: "/reports/z.bin",
      kind: "binary",
      metadata: { order: 2 },
      blob: Buffer.from([1, 2, 3]),
      now: () => 2000,
    });
    writeSqliteRunArtifact({
      env,
      agentId: "main",
      runId: "run-1",
      path: "reports/a.txt",
      kind: "note",
      now: () => 1000,
    });
    writeSqliteRunArtifact({
      env,
      agentId: "main",
      runId: "run-1",
      path: "logs/raw.txt",
      kind: "log",
    });

    expect(
      exportSqliteRunArtifacts({
        env,
        agentId: "main",
        runId: "run-1",
        prefix: "reports",
      }),
    ).toEqual([
      {
        agentId: "main",
        runId: "run-1",
        path: "/reports/a.txt",
        kind: "note",
        metadata: {},
        size: 0,
        createdAt: 1000,
      },
      {
        agentId: "main",
        runId: "run-1",
        path: "/reports/z.bin",
        kind: "binary",
        metadata: { order: 2 },
        size: 3,
        createdAt: 2000,
        blobBase64: "AQID",
      },
    ]);
    expect(deleteSqliteRunArtifacts({ env, agentId: "main", runId: "run-1" })).toBe(3);
    expect(listSqliteRunArtifacts({ env, agentId: "main", runId: "run-1" })).toEqual([]);
  });

  it("exposes an AgentFilesystem run artifact store adapter", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const runArtifacts = createSqliteRunArtifactStore({
      env,
      agentId: "main",
      runId: "run-2",
    });

    runArtifacts.write({
      path: "notes/result.txt",
      kind: "text",
      blob: "hello",
    });

    expect(runArtifacts.list()).toEqual([
      expect.objectContaining({
        agentId: "main",
        runId: "run-2",
        path: "/notes/result.txt",
        kind: "text",
        size: 5,
      }),
    ]);
    expect(runArtifacts.read("notes/result.txt")).toEqual(
      expect.objectContaining({
        path: "/notes/result.txt",
        blobBase64: "aGVsbG8=",
      }),
    );
    expect(runArtifacts.deleteAll()).toBe(1);
  });
});

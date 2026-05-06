import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createSqliteToolArtifactStore,
  deleteSqliteToolArtifacts,
  exportSqliteToolArtifacts,
  listSqliteToolArtifacts,
  readSqliteToolArtifact,
  writeSqliteToolArtifact,
} from "./tool-artifact-store.sqlite.js";

function createTempDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tool-artifacts-"));
  return path.join(root, "state", "openclaw.sqlite");
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite tool artifact store", () => {
  it("stores artifacts by agent and run", () => {
    const dbPath = createTempDbPath();

    expect(
      writeSqliteToolArtifact({
        path: dbPath,
        agentId: "Main",
        runId: "run-1",
        artifactId: "summary",
        kind: "text",
        metadata: { tool: "diagnostic" },
        blob: "hello",
        now: () => 1000,
      }),
    ).toEqual({
      agentId: "main",
      runId: "run-1",
      artifactId: "summary",
      kind: "text",
      metadata: { tool: "diagnostic" },
      size: 5,
      createdAt: 1000,
    });
    writeSqliteToolArtifact({
      path: dbPath,
      agentId: "ops",
      runId: "run-1",
      artifactId: "summary",
      kind: "text",
      blob: "ops",
    });

    expect(listSqliteToolArtifacts({ path: dbPath, agentId: "main", runId: "run-1" })).toEqual([
      {
        agentId: "main",
        runId: "run-1",
        artifactId: "summary",
        kind: "text",
        metadata: { tool: "diagnostic" },
        size: 5,
        createdAt: 1000,
      },
    ]);
    expect(
      readSqliteToolArtifact({
        path: dbPath,
        agentId: "main",
        runId: "run-1",
        artifactId: "summary",
      }),
    ).toEqual({
      agentId: "main",
      runId: "run-1",
      artifactId: "summary",
      kind: "text",
      metadata: { tool: "diagnostic" },
      size: 5,
      createdAt: 1000,
      blobBase64: "aGVsbG8=",
    });
  });

  it("exports and deletes run artifacts", () => {
    const dbPath = createTempDbPath();

    writeSqliteToolArtifact({
      path: dbPath,
      agentId: "main",
      runId: "run-1",
      artifactId: "a",
      kind: "json",
      metadata: { order: 2 },
      blob: Buffer.from([1, 2, 3]),
      now: () => 2000,
    });
    writeSqliteToolArtifact({
      path: dbPath,
      agentId: "main",
      runId: "run-1",
      artifactId: "b",
      kind: "note",
      now: () => 1000,
    });

    expect(exportSqliteToolArtifacts({ path: dbPath, agentId: "main", runId: "run-1" })).toEqual([
      {
        agentId: "main",
        runId: "run-1",
        artifactId: "b",
        kind: "note",
        metadata: {},
        size: 0,
        createdAt: 1000,
      },
      {
        agentId: "main",
        runId: "run-1",
        artifactId: "a",
        kind: "json",
        metadata: { order: 2 },
        size: 3,
        createdAt: 2000,
        blobBase64: "AQID",
      },
    ]);
    expect(deleteSqliteToolArtifacts({ path: dbPath, agentId: "main", runId: "run-1" })).toBe(2);
    expect(listSqliteToolArtifacts({ path: dbPath, agentId: "main", runId: "run-1" })).toEqual([]);
  });

  it("exposes an AgentFilesystem artifact store adapter", () => {
    const dbPath = createTempDbPath();
    const artifacts = createSqliteToolArtifactStore({
      path: dbPath,
      agentId: "main",
      runId: "run-2",
    });

    artifacts.write({
      artifactId: "note",
      kind: "text",
      blob: "hello",
    });

    expect(artifacts.list()).toEqual([
      expect.objectContaining({
        agentId: "main",
        runId: "run-2",
        artifactId: "note",
        kind: "text",
        size: 5,
      }),
    ]);
    expect(artifacts.read("note")).toEqual(
      expect.objectContaining({
        artifactId: "note",
        blobBase64: "aGVsbG8=",
      }),
    );
    expect(artifacts.deleteAll()).toBe(1);
  });
});

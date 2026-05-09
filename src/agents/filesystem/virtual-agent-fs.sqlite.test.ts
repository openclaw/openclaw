import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { VirtualAgentFsEntry } from "./agent-filesystem.js";
import { parseVirtualAgentFsEntryKind } from "./agent-filesystem.js";
import { createSqliteVirtualAgentFs } from "./virtual-agent-fs.sqlite.js";

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vfs-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SqliteVirtualAgentFs", () => {
  it("types public results and rejects invalid persisted entry kinds", () => {
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      env: { OPENCLAW_STATE_DIR: createTempStateDir() },
    });

    expectTypeOf(scratch.stat("/tmp")).toEqualTypeOf<VirtualAgentFsEntry | null>();
    expect(parseVirtualAgentFsEntryKind("file")).toBe("file");
    expect(parseVirtualAgentFsEntryKind("directory")).toBe("directory");
    expect(() => parseVirtualAgentFsEntryKind("socket")).toThrow(
      "Invalid persisted VFS entry kind",
    );
  });

  it("stores scratch files by agent and namespace", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const mainScratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      env,
      now: () => 1000,
    });
    const opsScratch = createSqliteVirtualAgentFs({
      agentId: "ops",
      namespace: "scratch",
      env,
      now: () => 2000,
    });

    mainScratch.writeFile("reports/summary.txt", "hello", {
      metadata: { source: "test" },
    });
    opsScratch.writeFile("reports/summary.txt", "ops");

    expect(mainScratch.readFile("/reports/summary.txt").toString("utf8")).toBe("hello");
    expect(opsScratch.readFile("/reports/summary.txt").toString("utf8")).toBe("ops");
    expect(mainScratch.stat("/reports/summary.txt")).toMatchObject({
      path: "/reports/summary.txt",
      kind: "file",
      size: 5,
      metadata: { source: "test" },
      updatedAt: 1000,
    });
    expect(mainScratch.readdir("/reports").map((entry) => entry.path)).toEqual([
      "/reports/summary.txt",
    ]);
  });

  it("renames and removes directory trees", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      env,
      now: () => 3000,
    });

    scratch.writeFile("/tmp/a.txt", "a");
    scratch.writeFile("/tmp/nested/b.txt", "b");
    expect(() => scratch.remove("/tmp")).toThrow("VFS directory is not empty");

    scratch.rename("/tmp", "/archive/tmp");
    expect(scratch.readFile("/archive/tmp/a.txt").toString("utf8")).toBe("a");
    expect(scratch.readFile("/archive/tmp/nested/b.txt").toString("utf8")).toBe("b");
    scratch.remove("/archive", { recursive: true });

    expect(scratch.stat("/archive/tmp/a.txt")).toBeNull();
  });

  it("lists and exports VFS contents for support bundles", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "run:abc",
      env,
      now: () => 4000,
    });

    scratch.writeFile("/artifacts/report.txt", "hello", {
      metadata: { kind: "summary" },
    });
    scratch.writeFile("/artifacts/nested/raw.bin", Buffer.from([0, 1, 2]));

    expect(scratch.list("/artifacts").map((entry) => entry.path)).toEqual([
      "/artifacts",
      "/artifacts/nested",
      "/artifacts/report.txt",
    ]);
    expect(scratch.list("/artifacts", { recursive: true }).map((entry) => entry.path)).toEqual([
      "/artifacts",
      "/artifacts/nested",
      "/artifacts/nested/raw.bin",
      "/artifacts/report.txt",
    ]);
    expect(scratch.export("/artifacts", { recursive: true })).toEqual([
      {
        path: "/artifacts",
        kind: "directory",
        size: 0,
        metadata: {},
        updatedAt: 4000,
      },
      {
        path: "/artifacts/nested",
        kind: "directory",
        size: 0,
        metadata: {},
        updatedAt: 4000,
      },
      {
        path: "/artifacts/nested/raw.bin",
        kind: "file",
        size: 3,
        metadata: {},
        updatedAt: 4000,
        contentBase64: "AAEC",
      },
      {
        path: "/artifacts/report.txt",
        kind: "file",
        size: 5,
        metadata: { kind: "summary" },
        updatedAt: 4000,
        contentBase64: "aGVsbG8=",
      },
    ]);
  });

  it("rejects corrupt persisted entry kinds from public sqlite methods", () => {
    const env = { OPENCLAW_STATE_DIR: createTempStateDir() };
    const scratch = createSqliteVirtualAgentFs({
      agentId: "main",
      namespace: "scratch",
      env,
      now: () => 5000,
    });

    scratch.writeFile("/reports/summary.txt", "hello");
    openOpenClawAgentDatabase({ agentId: "main", env })
      .db.prepare("UPDATE vfs_entries SET kind = ? WHERE namespace = ? AND path = ?")
      .run("socket", "scratch", "/reports/summary.txt");

    expect(() => scratch.stat("/reports/summary.txt")).toThrow("Invalid persisted VFS entry kind");
    expect(() => scratch.readFile("/reports/summary.txt")).toThrow(
      "Invalid persisted VFS entry kind",
    );
  });
});

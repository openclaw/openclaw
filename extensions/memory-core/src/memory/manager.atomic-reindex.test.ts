// Memory Core tests cover manager.atomic reindex plugin behavior.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  moveMemoryIndexFiles,
  removeMemoryIndexFiles,
  runMemoryAtomicReindex,
} from "./manager-atomic-reindex.js";

const managerDbModuleUrl = new URL("./manager-db.ts", import.meta.url).href;

async function expectPathMissing(targetPath: string): Promise<void> {
  await expectRejectCode(fs.access(targetPath), "ENOENT");
}

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe(code);
    return;
  }
  throw new Error(`Expected rejection with code ${code}`);
}

function normalizeBackupName(filePath: string): string {
  return path
    .basename(filePath)
    .replace(
      /backup-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      "backup-<uuid>",
    );
}

type PeerWriter = {
  commit: () => Promise<void>;
  close: () => Promise<void>;
};

async function attemptPeerCommit(dbPath: string): Promise<"blocked" | "committed"> {
  const script = `
    import {
      closeMemoryDatabase,
      openMemoryDatabaseAtPath,
    } from ${JSON.stringify(managerDbModuleUrl)};
    const [dbPath] = process.argv.slice(1);
    let db;
    try {
      db = openMemoryDatabaseAtPath(dbPath, false);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      db.exec("CREATE TABLE peer_commits (id TEXT PRIMARY KEY)");
      db.prepare("INSERT INTO peer_commits (id) VALUES (?)").run("acknowledged");
      process.stdout.write("committed\\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (/SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(\`\${code} \${message}\`)) {
        process.stdout.write("blocked\\n");
      } else {
        console.error(message);
        process.exitCode = 1;
      }
    } finally {
      if (db) closeMemoryDatabase(db);
    }
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, dbPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await waitForChildExit(child, () => stderr);
  const result = stdout.trim();
  if (result !== "blocked" && result !== "committed") {
    throw new Error(`unexpected peer commit result: ${result}`);
  }
  return result;
}

async function startPeerWriter(dbPath: string): Promise<PeerWriter> {
  const script = `
    import {
      closeMemoryDatabase,
      openMemoryDatabaseAtPath,
    } from ${JSON.stringify(managerDbModuleUrl)};
    const [dbPath] = process.argv.slice(1);
    const db = openMemoryDatabaseAtPath(dbPath, false);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\\n");
        if (newline < 0) break;
        const command = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (command === "commit") {
          db.exec("CREATE TABLE peer_commits (id TEXT PRIMARY KEY)");
          db.prepare("INSERT INTO peer_commits (id) VALUES (?)").run("acknowledged");
          process.stdout.write("committed\\n");
        } else if (command === "close") {
          closeMemoryDatabase(db);
        }
      }
    });
    process.stdout.write("ready\\n");
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, dbPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const expectLine = async (expected: string): Promise<void> => {
    const next = await lines.next();
    if (next.done || next.value !== expected) {
      throw new Error(`peer writer expected ${expected}, got ${String(next.value)}: ${stderr}`);
    }
  };
  await expectLine("ready");
  return {
    commit: async () => {
      child.stdin.write("commit\n");
      await expectLine("committed");
    },
    close: async () => {
      child.stdin.end("close\n");
      await waitForChildExit(child, () => stderr);
    },
  };
}

async function waitForChildExit(child: ChildProcess, getStderr: () => string): Promise<void> {
  if (child.exitCode !== null) {
    expect(child.exitCode, getStderr()).toBe(0);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      try {
        expect(code, getStderr()).toBe(0);
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

describe("memory manager atomic reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let indexPath: string;
  let tempIndexPath: string;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-atomic-"));
  });

  beforeEach(async () => {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    indexPath = path.join(workspaceDir, "index.sqlite");
    tempIndexPath = `${indexPath}.tmp`;
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("keeps the prior index when a full reindex fails", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");

    await expect(
      runMemoryAtomicReindex({
        targetPath: indexPath,
        tempPath: tempIndexPath,
        build: async () => {
          throw new Error("embedding failure");
        },
      }),
    ).rejects.toThrow("embedding failure");

    expect(readChunkMarker(indexPath)).toBe("before");
    await expectPathMissing(tempIndexPath);
  });

  it("replaces the old index after a successful temp reindex", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");

    await runMemoryAtomicReindex({
      targetPath: indexPath,
      tempPath: tempIndexPath,
      build: async () => undefined,
    });

    expect(readChunkMarker(indexPath)).toBe("after");
    await expectPathMissing(tempIndexPath);
  });

  it("refuses to publish while a peer owns an acknowledged live write", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");
    const peer = await startPeerWriter(indexPath);

    try {
      await peer.commit();
      expect((await fs.stat(`${indexPath}-wal`)).size).toBeGreaterThan(0);
      await expect(
        runMemoryAtomicReindex({
          targetPath: indexPath,
          tempPath: tempIndexPath,
          build: async () => undefined,
        }),
      ).rejects.toThrow(/another process is using the live database/);

      expect(readChunkMarker(indexPath)).toBe("before");
      expect(readPeerCommit(indexPath)).toBe("acknowledged");
      expect(readIntegrityCheck(indexPath)).toBe("ok");
      await expectPathMissing(tempIndexPath);
    } finally {
      await peer.close();
    }
  });

  it("blocks peer commits beyond the final temp checkpoint", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");
    let peerCommit: "blocked" | "committed" | undefined;

    await runMemoryAtomicReindex({
      targetPath: indexPath,
      tempPath: tempIndexPath,
      build: async () => {
        peerCommit = await attemptPeerCommit(indexPath);
      },
    });

    expect(peerCommit).toBe("blocked");
    expect(readChunkMarker(indexPath)).toBe("after");
  });

  it("retries transient rename failures during index swaps", async () => {
    const rename = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
      .mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    await moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
      fileOps: { rename, rm: fs.rm, wait },
      maxRenameAttempts: 3,
      renameRetryDelayMs: 10,
    });

    // main (1 retry) + -wal + -shm + -journal.
    expect(rename).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(10);
  });

  it("throws after retrying transient rename failures up to the attempt limit", async () => {
    const rename = vi.fn().mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
        fileOps: { rename, rm: fs.rm, wait },
        maxRenameAttempts: 3,
        renameRetryDelayMs: 10,
      }),
      "EBUSY",
    );

    expect(rename).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
  });

  it("does not retry missing optional sqlite sidecar files", async () => {
    const rename = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("missing wal"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing shm"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error("missing journal"), { code: "ENOENT" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
      fileOps: { rename, rm: fs.rm, wait },
      maxRenameAttempts: 3,
      renameRetryDelayMs: 10,
    });

    // main + the three optional sidecars (-wal, -shm, -journal), none retried.
    expect(rename).toHaveBeenCalledTimes(4);
    expect(wait).not.toHaveBeenCalled();
  });

  it("requires the main sqlite file during index moves", async () => {
    const rename = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
        fileOps: { rename, rm: fs.rm, wait },
        maxRenameAttempts: 3,
        renameRetryDelayMs: 10,
      }),
      "ENOENT",
    );

    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry non-transient rename failures", async () => {
    const rename = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("invalid"), { code: "EINVAL" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      moveMemoryIndexFiles("index.sqlite.tmp", "index.sqlite", {
        fileOps: { rename, rm: fs.rm, wait },
        maxRenameAttempts: 3,
        renameRetryDelayMs: 10,
      }),
      "EINVAL",
    );

    expect(rename).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(["EBUSY", "EPERM", "EACCES"] as const)(
    "retries transient %s rm failures during index file cleanup",
    async (code) => {
      const calls: string[] = [];
      const rm: typeof fs.rm = vi.fn(async (filePath) => {
        calls.push(String(filePath));
        if (calls.length === 1) {
          throw Object.assign(new Error("busy"), { code });
        }
      });
      const wait = vi.fn().mockResolvedValue(undefined);

      await removeMemoryIndexFiles("index.sqlite.tmp", {
        fileOps: { rename: fs.rename, rm, wait },
        maxRemoveAttempts: 3,
        removeRetryDelayMs: 10,
      });

      expect(calls).toEqual([
        "index.sqlite.tmp",
        "index.sqlite.tmp",
        "index.sqlite.tmp-wal",
        "index.sqlite.tmp-shm",
        "index.sqlite.tmp-journal",
      ]);
      expect(wait).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledWith(10);
    },
  );

  it("throws after exhausting transient rm retries", async () => {
    const rm = vi.fn().mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      removeMemoryIndexFiles("index.sqlite.tmp", {
        fileOps: { rename: fs.rename, rm, wait },
        maxRemoveAttempts: 3,
        removeRetryDelayMs: 10,
      }),
      "EBUSY",
    );

    expect(rm).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
  });

  it("does not retry non-transient rm failures", async () => {
    const rm = vi.fn().mockRejectedValue(Object.assign(new Error("invalid"), { code: "EINVAL" }));
    const wait = vi.fn().mockResolvedValue(undefined);

    await expectRejectCode(
      removeMemoryIndexFiles("index.sqlite.tmp", {
        fileOps: { rename: fs.rename, rm, wait },
        maxRemoveAttempts: 3,
        removeRetryDelayMs: 10,
      }),
      "EINVAL",
    );

    expect(rm).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("closes temp resources before removing temp files after build failure", async () => {
    const events: string[] = [];
    let tempClosed = false;
    const rm: typeof fs.rm = vi.fn(async (filePath) => {
      const entryName = path.basename(String(filePath));
      events.push(tempClosed ? `rm:${entryName}:closed` : `rm:${entryName}:open`);
    });

    await expect(
      runMemoryAtomicReindex({
        targetPath: indexPath,
        tempPath: tempIndexPath,
        beforeTempCleanup: async () => {
          events.push("close-temp");
          tempClosed = true;
        },
        fileOptions: {
          fileOps: { rename: fs.rename, rm, wait: vi.fn().mockResolvedValue(undefined) },
        },
        build: async () => {
          throw new Error("embedding failure");
        },
      }),
    ).rejects.toThrow("embedding failure");

    expect(events).toEqual([
      "close-temp",
      "rm:index.sqlite.tmp:closed",
      "rm:index.sqlite.tmp-wal:closed",
      "rm:index.sqlite.tmp-shm:closed",
      "rm:index.sqlite.tmp-journal:closed",
    ]);
  });

  it("atomic swap on POSIX: target file never goes absent during swap", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");

    const existsChecks: boolean[] = [];
    const realRename = fs.rename;
    const rename: typeof fs.rename = vi.fn(async (source, target) => {
      existsChecks.push(
        await fs.access(indexPath).then(
          () => true,
          () => false,
        ),
      );
      return realRename(source, target);
    });

    await runMemoryAtomicReindex({
      targetPath: indexPath,
      tempPath: tempIndexPath,
      fileOptions: {
        fileOps: { rename, rm: fs.rm, wait: vi.fn().mockResolvedValue(undefined) },
      },
      build: async () => undefined,
    });

    expect(readChunkMarker(indexPath)).toBe("after");
    expect(existsChecks.length).toBeGreaterThan(0);
    for (const exists of existsChecks) {
      expect(exists).toBe(true);
    }
  });

  it("backs up stale target sidecars before replacing the main index", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");
    await fs.writeFile(`${indexPath}-wal`, "stale wal");
    await fs.writeFile(`${indexPath}-shm`, "stale shm");
    await fs.writeFile(`${indexPath}-journal`, "stale journal");
    await fs.writeFile(`${tempIndexPath}-wal`, "closed temp wal");
    await fs.writeFile(`${tempIndexPath}-shm`, "closed temp shm");
    await fs.writeFile(`${tempIndexPath}-journal`, "closed temp journal");

    const events: string[] = [];
    const realRename = fs.rename;
    const realRm = fs.rm;
    const rename: typeof fs.rename = vi.fn(async (source, target) => {
      events.push(
        `rename:${normalizeBackupName(String(source))}->${normalizeBackupName(String(target))}`,
      );
      await realRename(source, target);
    });
    const rm: typeof fs.rm = vi.fn(async (filePath, options) => {
      events.push(`rm:${normalizeBackupName(String(filePath))}:${readChunkMarker(indexPath)}`);
      await realRm(filePath, options);
    });

    await runMemoryAtomicReindex({
      targetPath: indexPath,
      tempPath: tempIndexPath,
      fileOptions: {
        fileOps: { rename, rm, wait: vi.fn().mockResolvedValue(undefined) },
      },
      build: async () => undefined,
    });

    expect(readChunkMarker(indexPath)).toBe("after");
    expect(rename).toHaveBeenCalledTimes(4);
    expect(events).toEqual([
      "rename:index.sqlite-wal->index.sqlite.backup-<uuid>-wal",
      "rename:index.sqlite-shm->index.sqlite.backup-<uuid>-shm",
      "rename:index.sqlite-journal->index.sqlite.backup-<uuid>-journal",
      "rename:index.sqlite.tmp->index.sqlite",
      "rm:index.sqlite.backup-<uuid>:after",
      "rm:index.sqlite.backup-<uuid>-wal:after",
      "rm:index.sqlite.backup-<uuid>-shm:after",
      "rm:index.sqlite.backup-<uuid>-journal:after",
      "rm:index.sqlite.tmp-wal:after",
      "rm:index.sqlite.tmp-shm:after",
      "rm:index.sqlite.tmp-journal:after",
    ]);
    await expectPathMissing(`${indexPath}-wal`);
    await expectPathMissing(`${indexPath}-shm`);
    await expectPathMissing(`${indexPath}-journal`);
    await expectPathMissing(`${tempIndexPath}-wal`);
    await expectPathMissing(`${tempIndexPath}-shm`);
    await expectPathMissing(`${tempIndexPath}-journal`);
  });

  it("does not strand a stale rollback-journal next to the published index", async () => {
    // journal_mode=DELETE stores (e.g. NFS-backed) leave a -journal sidecar
    // instead of -wal/-shm. A swap that ignores it would publish the new main
    // file beside a stale rollback journal, so the next open would roll the
    // fresh index back to a torn state. The journal must be cleared on publish.
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");
    await fs.writeFile(`${indexPath}-journal`, "stale rollback journal");

    await runMemoryAtomicReindex({
      targetPath: indexPath,
      tempPath: tempIndexPath,
      build: async () => undefined,
    });

    // Real disk readback across the swap boundary.
    expect(readChunkMarker(indexPath)).toBe("after");
    await expectPathMissing(`${indexPath}-journal`);
  });

  it("removes the temp rollback-journal sidecar when a reindex build fails", async () => {
    // A crashed/failed reindex on a DELETE-mode store can leave a temp
    // -journal sidecar. Cleanup must remove it alongside the temp main file so
    // the startup orphan sweep is never required to reclaim it.
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");
    await fs.writeFile(`${tempIndexPath}-journal`, "temp rollback journal");

    await expect(
      runMemoryAtomicReindex({
        targetPath: indexPath,
        tempPath: tempIndexPath,
        build: async () => {
          throw new Error("embedding failure");
        },
      }),
    ).rejects.toThrow("embedding failure");

    // The prior index survives and the temp triplet (incl. -journal) is gone.
    expect(readChunkMarker(indexPath)).toBe("before");
    await expectPathMissing(tempIndexPath);
    await expectPathMissing(`${tempIndexPath}-journal`);
  });

  it("moves the rollback-journal sidecar with the main index across the real filesystem", async () => {
    // moveMemoryIndexFiles is the Windows backup-protocol restore primitive.
    // It must carry the -journal sidecar so a DELETE-mode index is recovered
    // intact when a publish is rolled back.
    const sourceBase = `${indexPath}.tmp`;
    writeChunkMarker(sourceBase, "recovered");
    await fs.writeFile(`${sourceBase}-journal`, "recovered journal");

    await moveMemoryIndexFiles(sourceBase, indexPath);

    // Real disk readback at the destination. Inspect the relocated journal
    // before opening the DB, since opening index.sqlite would treat a sibling
    // -journal as a hot journal and consume it.
    await expect(fs.readFile(`${indexPath}-journal`, "utf8")).resolves.toBe("recovered journal");
    await expectPathMissing(sourceBase);
    await expectPathMissing(`${sourceBase}-journal`);
    await fs.rm(`${indexPath}-journal`, { force: true });
    expect(readChunkMarker(indexPath)).toBe("recovered");
  });

  it("reports publish before post-swap cleanup failures", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");

    let published = false;
    const realRename = fs.rename;
    const rename: typeof fs.rename = vi.fn(async (source, target) => {
      await realRename(source, target);
    });
    const rm: typeof fs.rm = vi.fn(async (filePath) => {
      if (String(filePath).includes(".backup-")) {
        throw Object.assign(new Error("backup cleanup locked"), { code: "EACCES" });
      }
    });

    await expectRejectCode(
      runMemoryAtomicReindex({
        targetPath: indexPath,
        tempPath: tempIndexPath,
        afterPublish: () => {
          published = true;
        },
        fileOptions: {
          fileOps: { rename, rm, wait: vi.fn().mockResolvedValue(undefined) },
        },
        build: async () => undefined,
      }),
      "EACCES",
    );

    expect(published).toBe(true);
    expect(readChunkMarker(indexPath)).toBe("after");
  });

  it("restores backed-up target sidecars when publishing the main index fails", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");
    await fs.writeFile(`${indexPath}-wal`, "stale wal");
    await fs.writeFile(`${indexPath}-shm`, "stale shm");

    const realRename = fs.rename;
    const rename: typeof fs.rename = vi.fn(async (source, target) => {
      if (String(source) === tempIndexPath && String(target) === indexPath) {
        throw Object.assign(new Error("locked target"), { code: "EACCES" });
      }
      await realRename(source, target);
    });

    await expectRejectCode(
      runMemoryAtomicReindex({
        targetPath: indexPath,
        tempPath: tempIndexPath,
        fileOptions: {
          fileOps: { rename, rm: fs.rm, wait: vi.fn().mockResolvedValue(undefined) },
        },
        build: async () => undefined,
      }),
      "EACCES",
    );

    await expect(fs.readFile(`${indexPath}-wal`, "utf8")).resolves.toBe("stale wal");
    await expect(fs.readFile(`${indexPath}-shm`, "utf8")).resolves.toBe("stale shm");
    expect(readChunkMarker(indexPath)).toBe("before");
    await expectPathMissing(tempIndexPath);
  });

  it("restores target sidecars when sidecar backup partially fails", async () => {
    writeChunkMarker(indexPath, "before");
    writeChunkMarker(tempIndexPath, "after");
    await fs.writeFile(`${indexPath}-wal`, "stale wal");
    await fs.writeFile(`${indexPath}-shm`, "stale shm");

    const realRename = fs.rename;
    const rename: typeof fs.rename = vi.fn(async (source, target) => {
      if (String(source) === `${indexPath}-shm` && String(target).includes(".backup-")) {
        throw Object.assign(new Error("locked shm"), { code: "EACCES" });
      }
      await realRename(source, target);
    });

    await expectRejectCode(
      runMemoryAtomicReindex({
        targetPath: indexPath,
        tempPath: tempIndexPath,
        fileOptions: {
          fileOps: { rename, rm: fs.rm, wait: vi.fn().mockResolvedValue(undefined) },
        },
        build: async () => undefined,
      }),
      "EACCES",
    );

    await expect(fs.readFile(`${indexPath}-wal`, "utf8")).resolves.toBe("stale wal");
    await expect(fs.readFile(`${indexPath}-shm`, "utf8")).resolves.toBe("stale shm");
    expect(readChunkMarker(indexPath)).toBe("before");
    await expectPathMissing(tempIndexPath);
  });
});

function writeChunkMarker(dbPath: string, marker: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE chunks (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
    db.prepare("INSERT INTO chunks (id, text) VALUES (?, ?)").run("chunk-1", marker);
  } finally {
    db.close();
  }
}

function readChunkMarker(dbPath: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare("SELECT text FROM chunks WHERE id = ?").get("chunk-1") as
        | { text: string }
        | undefined
    )?.text;
  } finally {
    db.close();
  }
}

function readPeerCommit(dbPath: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare("SELECT id FROM peer_commits WHERE id = ?").get("acknowledged") as
        | { id: string }
        | undefined
    )?.id;
  } finally {
    db.close();
  }
}

function readIntegrityCheck(dbPath: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined)
      ?.integrity_check;
  } finally {
    db.close();
  }
}

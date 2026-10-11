import fs from "node:fs";
import path from "node:path";
import { serialize } from "node:v8";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as command from "../../../process/exec.js";
import { readLocalFile } from "./read-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;

beforeEach(() => {
  root = tempDirs.make("read-routing-");
  fs.mkdirSync(path.join(root, "state"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.spyOn(command, "runCommandBuffered").mockResolvedValue({
    stdout: serialize({ buffer: Buffer.from("isolated bytes") }),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reads ordinary files in-process even when child spawning is unavailable", async () => {
  vi.mocked(command.runCommandBuffered).mockRejectedValue(
    Object.assign(new Error("spawn failed"), { code: "EAGAIN" }),
  );
  const filePath = path.join(root, "state-neighbor", "notes.txt");
  fs.mkdirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, "ordinary bytes");

  await expect(readLocalFile(filePath)).resolves.toEqual(Buffer.from("ordinary bytes"));
  expect(command.runCommandBuffered).not.toHaveBeenCalled();
});

it.each([
  "agent.sqlite",
  "agent.sqlite-wal",
  "agent.sqlite-shm",
  "agent.sqlite-journal",
  "plugin.sqlite3",
  "plugin.sqlite3-wal",
  "plugin.sqlite3-shm",
  "plugin.sqlite3-journal",
  "plugin.db",
  "plugin.db-wal",
  "plugin.db-shm",
  "plugin.db-journal",
  "PLUGIN.DB-SHM",
  "state/custom-storage",
])("isolates the SQLite-relevant target %s", async (name) => {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, "must not open in this process");

  await expect(readLocalFile(filePath)).resolves.toEqual(Buffer.from("isolated bytes"));
  expect(command.runCommandBuffered).toHaveBeenCalledOnce();
});

it("isolates state files reached through a directory alias", async () => {
  const alias = path.join(root, "alias");
  fs.symlinkSync(
    path.join(root, "state"),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.writeFileSync(path.join(root, "state", "custom-storage"), "live state");

  await expect(readLocalFile(path.join(alias, "custom-storage"))).resolves.toEqual(
    Buffer.from("isolated bytes"),
  );
  expect(command.runCommandBuffered).toHaveBeenCalledOnce();
});

it("isolates renamed hardlinks to database files", async () => {
  const database = path.join(root, "agent.sqlite-shm");
  const alias = path.join(root, "notes.txt");
  fs.writeFileSync(database, "live state");
  fs.linkSync(database, alias);

  await expect(readLocalFile(alias)).resolves.toEqual(Buffer.from("isolated bytes"));
  expect(command.runCommandBuffered).toHaveBeenCalledOnce();
});

it("resolves a symlinked state root before classifying its files", async () => {
  const alias = path.join(root, "state-alias");
  fs.symlinkSync(
    path.join(root, "state"),
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", alias);
  const filePath = path.join(root, "state", "custom-storage");
  fs.writeFileSync(filePath, "live state");

  await expect(readLocalFile(filePath)).resolves.toEqual(Buffer.from("isolated bytes"));
  expect(command.runCommandBuffered).toHaveBeenCalledOnce();
});

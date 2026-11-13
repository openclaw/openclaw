import fs from "node:fs";
import path from "node:path";
import { serialize } from "node:v8";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as command from "../../../process/exec.js";
import { runWithSpawnBroker } from "../../../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../../process/spawn-broker/host.js";
import { readLocalFile } from "./read-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const exited = { code: 0, signal: null, killed: false, termination: "exit" as const };
let root: string;
const file = (...parts: string[]) => path.join(root, ...parts);
const write = (name: string, text = "live state") => fs.writeFileSync(file(name), text);
const expectIsolated = (name: string) =>
  expect(readLocalFile(file(name))).resolves.toEqual(Buffer.from("isolated bytes"));

beforeEach(() => {
  root = tempDirs.make("read-routing-");
  fs.mkdirSync(file("state"));
  vi.stubEnv("OPENCLAW_STATE_DIR", file("state"));
  vi.spyOn(command, "runCommandBuffered").mockResolvedValue({
    ...exited,
    stdout: serialize({ buffer: Buffer.from("isolated bytes") }),
    stderr: Buffer.alloc(0),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reads ordinary files in-process even when child spawning is unavailable", async () => {
  vi.mocked(command.runCommandBuffered).mockRejectedValue(new Error("spawning unavailable"));
  const filePath = file("state-neighbor", "notes.txt");
  fs.mkdirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, "ordinary bytes");

  await expect(readLocalFile(filePath)).resolves.toEqual(Buffer.from("ordinary bytes"));
  expect(command.runCommandBuffered).not.toHaveBeenCalled();
});

it.each([
  ...["", "-wal", "-shm", "-journal"].map((suffix) => `agent.sqlite${suffix}`),
  "plugin.sqlite3",
  "plugin.db",
  "PLUGIN.DB-SHM",
  "agent.sqlite.memory-reindex-11111111-2222-3333-4444-555555555555",
  "agent.sqlite.memory-reindex-11111111-2222-3333-4444-555555555555-shm",
  "state/custom-storage",
])("isolates the SQLite-relevant target %s", async (name) => {
  write(name, "must not open in this process");
  await expectIsolated(name);
});

it.each([false, true])("isolates aliased state (root: %s)", async (rootAlias) => {
  fs.symlinkSync(file("state"), file("alias"), process.platform === "win32" ? "junction" : "dir");
  write("state/custom-storage");
  if (rootAlias) {
    vi.stubEnv("OPENCLAW_STATE_DIR", file("alias"));
  }
  await expectIsolated(rootAlias ? "state/custom-storage" : "alias/custom-storage");
});

it("isolates renamed hardlinks to database files", async () => {
  write("agent.sqlite-shm");
  fs.linkSync(file("agent.sqlite-shm"), file("notes.txt"));
  await expectIsolated("notes.txt");
});

it("reuses the broker for isolated reads, preserving bytes, failures, and cancellation", async () => {
  vi.mocked(command.runCommandBuffered).mockRestore();
  const broker = createSpawnBrokerHost();
  onTestFinished(() => broker.close());
  const filePath = file("state/notes.txt");
  const read = (name = "notes.txt", signal?: AbortSignal) =>
    readLocalFile(file("state", name), signal);
  const hex = "a7".repeat(1024 * 1024 + 13);
  fs.writeFileSync(filePath, hex, "hex");
  write("state/empty.txt", "");
  await expect(read("missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
  await broker.ready();
  await runWithSpawnBroker(broker, async () => {
    const reads = await Promise.all([read(), read("empty.txt"), read()]);
    expect(reads.map((buffer) => buffer.toString("hex"))).toEqual([hex, "", hex]);
    await expect(read("missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(read("")).rejects.toThrow("regular file");
    fs.symlinkSync(filePath, file("state/link.txt"));
    await expect(read("link.txt")).rejects.toThrow("regular file");
    const reason = new Error("read canceled");
    await expect(read(undefined, AbortSignal.abort(reason))).rejects.toBe(reason);
    const active = new AbortController();
    const reading = read(undefined, active.signal);
    await Promise.resolve();
    active.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect((await read()).toString("hex")).toBe(hex);
  });
  await broker.close();
  await expect(broker.readFile(filePath)).rejects.toThrow("closing");
});

it("refuses raw reads in a broker that owns native resources", async () => {
  const broker = createSpawnBrokerHost({ nativeResources: true });
  onTestFinished(() => broker.close());
  await expect(broker.readFile(file("state/notes.txt"))).rejects.toThrow(
    "cannot admit a raw file read",
  );
});

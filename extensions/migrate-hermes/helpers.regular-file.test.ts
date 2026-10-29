import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createMigrationItem } from "openclaw/plugin-sdk/migration";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendItem, readText } from "./helpers.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { discoverHermesSource } from "./source.js";
import { makeContext, makeHermesPaths, writeFile } from "./test/provider-helpers.js";

let workspace: TempWorkspace;
async function withoutFifoRead(file: string, action: () => Promise<void>) {
  execFileSync("mkfifo", [file]);
  const opened = file + ".opened";
  const writer = spawn(
    process.execPath,
    [
      "-e",
      'const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "w"); fs.writeSync(fd, "backstop input"); fs.writeFileSync(process.argv[2], "opened"); fs.closeSync(fd);',
      file,
      opened,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((resolve) => {
    writer.once("exit", () => resolve());
  });
  try {
    await action();
    await expect(fs.access(opened)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    writer.kill("SIGKILL");
    await exited;
  }
  expect((await fs.lstat(file)).isFIFO()).toBe(true);
}
function memoryItem(source: string, target: string) {
  return createMigrationItem({
    id: "memory:MEMORY.md",
    kind: "memory",
    action: "append",
    source,
    target,
    status: "planned",
  });
}
describe("Hermes regular-file admission", () => {
  beforeEach(async () => {
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "hermes-regular-",
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await workspace.cleanup();
  });
  it.skipIf(process.platform === "win32").each([false, true])(
    "does not open optional FIFO input (symlink: %s)",
    async (link) => {
      const file = path.join(workspace.dir, "pipe");
      const input = link ? path.join(workspace.dir, "link") : file;
      await withoutFifoRead(file, async () => {
        if (link) {
          await fs.symlink(file, input);
        }
        await expect(readText(input)).resolves.toBeUndefined();
      });
    },
  );
  it.skipIf(process.platform === "win32").each(["active_profile", "config.yaml", ".env"])(
    "does not open %s in discovery or planning",
    async (name) => {
      const { source, stateDir, workspaceDir } = makeHermesPaths(workspace.dir);
      await fs.mkdir(source, { recursive: true });
      await withoutFifoRead(path.join(source, name), async () => {
        if (name === "active_profile") {
          const found = await discoverHermesSource(undefined, {
            env: { HERMES_HOME: source },
            platform: "linux",
          });
          expect(found.root).toBe(source);
        } else {
          const plan = await buildHermesMigrationProvider().plan(
            makeContext({ source, stateDir, workspaceDir }),
          );
          expect(plan).toBeDefined();
        }
      });
    },
  );
  it.skipIf(process.platform === "win32").each(["source", "target"])(
    "does not open a FIFO memory %s",
    async (side) => {
      const source = path.join(workspace.dir, "source");
      const target = path.join(workspace.dir, "target");
      await writeFile(side === "source" ? target : source, "preserve me");
      await withoutFifoRead(side === "source" ? source : target, async () => {
        expect(await appendItem(memoryItem(source, target))).toMatchObject({ status: "error" });
      });
      expect(await fs.readFile(side === "source" ? target : source, "utf8")).toBe("preserve me");
    },
  );
  it("keeps directory, missing and absent optional inputs soft", async () => {
    await expect(readText(workspace.dir)).resolves.toBeUndefined();
    await expect(readText(path.join(workspace.dir, "missing"))).resolves.toBeUndefined();
    await expect(readText(undefined)).resolves.toBeUndefined();
  });
  it.skipIf(process.platform === "win32")(
    "preserves ordinary source symlinks, Unicode, BOM and append dedupe",
    async () => {
      const source = path.join(workspace.dir, "source");
      const link = path.join(workspace.dir, "link");
      const target = path.join(workspace.dir, "target");
      const text = "﻿Café 会议 �";
      await writeFile(source, text);
      await fs.symlink(source, link);
      await writeFile(target, "operator prefix");
      await expect(readText(link)).resolves.toBe(text);
      expect(await appendItem(memoryItem(link, target))).toMatchObject({ status: "migrated" });
      const first = await fs.readFile(target, "utf8");
      expect(first).toContain("operator prefix");
      expect(first).toContain("<!-- Imported from Hermes: link -->");
      expect(first).toContain(text);
      expect(await appendItem(memoryItem(link, target))).toMatchObject({
        status: "skipped",
        reason: "already imported from Hermes",
      });
      expect(await fs.readFile(target, "utf8")).toBe(first);
      expect(await fs.readFile(source, "utf8")).toBe(text);
    },
  );
  it.skipIf(process.platform === "win32")(
    "rejects a source replaced with a symlink after realpath",
    async () => {
      const source = path.join(workspace.dir, "source");
      const other = path.join(workspace.dir, "other");
      const target = path.join(workspace.dir, "target");
      await writeFile(source, "original");
      await writeFile(other, "replacement");
      await writeFile(target, "keep");
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementationOnce(async (input) => {
        const resolved = await realpath(input);
        await fs.unlink(source);
        await fs.symlink(other, source);
        return resolved;
      });
      expect(await appendItem(memoryItem(source, target))).toMatchObject({ status: "error" });
      expect(await fs.readFile(target, "utf8")).toBe("keep");
      expect(await fs.readFile(other, "utf8")).toBe("replacement");
    },
  );
  it("retains malformed source bytes and refuses append", async () => {
    const source = path.join(workspace.dir, "source");
    const target = path.join(workspace.dir, "target");
    const bytes = Buffer.from([0x61, 0xc3, 0x28]);
    await fs.writeFile(source, bytes);
    await writeFile(target, "keep");
    expect(await appendItem(memoryItem(source, target))).toMatchObject({
      status: "error",
      reason: expect.stringContaining("UTF-8"),
    });
    expect(await fs.readFile(source)).toEqual(bytes);
    expect(await fs.readFile(target, "utf8")).toBe("keep");
  });
});

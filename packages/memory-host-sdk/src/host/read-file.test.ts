import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { readAgentMemoryFile, readMemoryFile } from "./read-file.js";
import * as memoryReadRetry from "./read-retry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture(files: Record<string, string | Buffer>) {
  const directory = tempDirs.make("memory-read-");
  const workspaceDir = path.join(directory, "workspace");
  await fs.mkdir(workspaceDir);
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  return { directory, workspaceDir, extraDir: path.join(directory, "extra") };
}
async function createDirectorySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "dir");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw err;
  }
}

it.each([
  { name: "omitted agent limits", contextLimits: undefined, maxChars: 2000 },
  {
    name: "partial agent limits",
    contextLimits: { postCompactionMaxChars: 1800 },
    maxChars: 2000,
  },
  {
    name: "an explicit agent override",
    contextLimits: { memoryGetMaxChars: 1000 },
    maxChars: 1000,
  },
])("applies the memory excerpt budget with $name", async ({ contextLimits, maxChars }) => {
  const content = "cedar memory ".repeat(600);
  const { workspaceDir } = await fixture({ "workspace/MEMORY.md": content });
  const result = await readAgentMemoryFile({
    cfg: {
      agents: {
        defaults: { contextLimits: { memoryGetMaxChars: 2000 } },
        entries: { main: { workspace: workspaceDir, contextLimits } },
      },
    },
    agentId: "main",
    relPath: "MEMORY.md",
  });
  expect(result).toMatchObject({ status: "ok", truncated: true, from: 1, lines: 1 });
  expect(result.text.split("\n\n")[0]).toBe(content.slice(0, maxChars));
  expect(result.text).toContain("use read on the source file");
});

it("follows contained workspace parent aliases while keeping extra directories strict", async () => {
  const { directory, workspaceDir } = await fixture({ "workspace/notes/note.md": "linked notes" });
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.symlink(
    path.join(workspaceDir, "notes"),
    path.join(workspaceDir, "memory/alias"),
    "junction",
  );
  const relPath = "memory/alias/note.md";
  await expect(readMemoryFile({ workspaceDir, relPath })).resolves.toMatchObject({
    status: "ok",
    text: "linked notes",
    path: relPath,
  });
  await expect(
    readMemoryFile({
      workspaceDir: path.join(directory, "other-workspace"),
      extraPaths: [workspaceDir],
      relPath: path.join(workspaceDir, relPath),
    }),
  ).rejects.toMatchObject({ code: "MEMORY_PATH_NOT_ALLOWED" });
});

it.each(["EAGAIN", "EIO"])("preserves read-time %s handling for workspace memory", async (code) => {
  const { workspaceDir } = await fixture({ "workspace/memory/note.md": "memory contents" });
  const relPath = "memory/note.md";
  const absolutePath = path.join(workspaceDir, relPath);
  const failure = Object.assign(new Error(`${code}: read metadata unavailable`), { code });
  const faultSeen = createDeferred();
  let reading = false;
  let injected = false;
  const retry = memoryReadRetry.retryTransientMemoryRead;
  vi.spyOn(memoryReadRetry, "retryTransientMemoryRead").mockImplementation((read, label) =>
    retry(async () => {
      reading = true;
      return await read();
    }, label),
  );
  const lstat = fsSync.lstatSync;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (reading && !injected && path.resolve(String(args[0])) === absolutePath) {
      injected = true;
      faultSeen.resolve();
      throw failure;
    }
    return lstat(...args);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = readMemoryFile({ workspaceDir, relPath }).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await Promise.race([faultSeen.promise, result]);
  await vi.runAllTimersAsync();
  expect(await result).toEqual(
    code === "EAGAIN"
      ? {
          status: "fulfilled",
          value: { status: "ok", text: "memory contents", path: relPath, from: 1, lines: 1 },
        }
      : { status: "rejected", error: failure },
  );
  expect(injected).toBe(true);
});

it.each(["workspace", "extra directory"])(
  "retains the authorized %s when its pathname is replaced before reading",
  async (source) => {
    const filename = source === "workspace" ? "memory/note.md" : "note.md";
    const rootName = source === "workspace" ? "workspace" : "extra";
    const { directory, workspaceDir } = await fixture({
      [`${rootName}/${filename}`]: "authorized contents",
      [`outside/${filename}`]: "outside contents",
    });
    const authorized = path.join(directory, rootName);
    const outside = path.join(directory, "outside");
    const moved = path.join(directory, "moved");
    const retry = memoryReadRetry.retryTransientMemoryRead;
    vi.spyOn(memoryReadRetry, "retryTransientMemoryRead").mockImplementation(
      async (read, label) => {
        await fs.rename(authorized, moved);
        await fs.symlink(outside, authorized, "junction");
        return await retry(read, label);
      },
    );
    const absolutePath = path.join(authorized, filename);
    await expect(
      readMemoryFile({
        workspaceDir,
        extraPaths: source === "workspace" ? [] : [authorized],
        relPath: absolutePath,
      }),
    ).resolves.toEqual({
      status: "not_found",
      text: "",
      path: path.relative(workspaceDir, absolutePath).replace(/\\/g, "/"),
    });
    expect(await fs.realpath(authorized)).toBe(await fs.realpath(outside));
    expect(await fs.readFile(path.join(moved, filename), "utf8")).toBe("authorized contents");
    expect(await fs.readFile(path.join(outside, filename), "utf8")).toBe("outside contents");
  },
);

it("reads an allowed hardlinked memory file larger than the default Root byte limit", async () => {
  const { directory, workspaceDir } = await fixture({
    "source.md": Buffer.concat([Buffer.from("first line\n"), Buffer.alloc(17 * 1024 * 1024, 120)]),
  });
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.link(path.join(directory, "source.md"), path.join(workspaceDir, "memory/large.md"));
  await expect(
    readMemoryFile({ workspaceDir, relPath: "memory/large.md", lines: 1 }),
  ).resolves.toMatchObject({
    status: "ok",
    text: "first line\n\n[More content available. Use from=2 to continue.]",
    path: "memory/large.md",
    lines: 1,
    nextFrom: 2,
  });
});

it("returns not found for absent extra paths and rejects non-directory parents", async () => {
  const { workspaceDir, extraDir } = await fixture({ "extra/note.md": "note" });
  const read = (name: string) =>
    readMemoryFile({ workspaceDir, extraPaths: [extraDir], relPath: path.join(extraDir, name) });
  await expect(read("missing.md")).resolves.toEqual({
    status: "not_found",
    text: "",
    path: "../extra/missing.md",
  });
  await expect(read("note.md/child.md")).rejects.toThrow(
    "path is not an allowed Markdown memory file",
  );
});

it.each(["EACCES", "EIO"])("scopes extra-path %s errors to the requested file", async (code) => {
  const { directory, workspaceDir, extraDir } = await fixture({
    "extra/note.md": "secret",
    "healthy/note.md": "healthy",
    "healthy/blocked.md": "blocked",
  });
  const target = path.join(extraDir, "note.md");
  const healthyDir = path.join(directory, "healthy");
  const blockedTarget = path.join(healthyDir, "blocked.md");
  const scanError = Object.assign(new Error(`${code}: extra path unreadable`), { code });
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if ([extraDir, blockedTarget].includes(path.resolve(String(args[0])))) {
      throw scanError;
    }
    return await lstat(...args);
  });
  // fs-safe checks children synchronously; configured-root admission remains async.
  const lstatSync = fsSync.lstatSync;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (path.resolve(String(args[0])) === blockedTarget) {
      throw scanError;
    }
    return lstatSync(...args);
  });
  const read = (
    relPath: string,
    extraPaths: Parameters<typeof readMemoryFile>[0]["extraPaths"] = [extraDir, healthyDir],
  ) => readMemoryFile({ workspaceDir, extraPaths, relPath });
  for (const relPath of [target, blockedTarget]) {
    await expect(read(relPath)).rejects.toMatchObject({
      code,
      message: `${code}: extra path unreadable`,
    });
  }
  await expect(read(path.join(healthyDir, "note.md"))).resolves.toMatchObject({ text: "healthy" });
  await expect(read(target, [extraDir, target])).resolves.toMatchObject({ text: "secret" });
  for (const relPath of [path.join(directory, "outside.md"), path.join(extraDir, "note.txt")]) {
    await expect(read(relPath, [extraDir])).rejects.toThrow(
      "path is not an allowed Markdown memory file",
    );
  }
  await expect(read(target, [{ path: extraDir, pattern: "runbooks/**/*.md" }])).rejects.toThrow(
    "path is not an allowed Markdown memory file",
  );
});

it("rejects extra path reads through symlinked directory components", async () => {
  const { directory, workspaceDir, extraDir } = await fixture({
    "extra/inside.md": "inside",
    "outside/private.md": "private",
  });
  const read = (name: string) =>
    readMemoryFile({ workspaceDir, extraPaths: [extraDir], relPath: path.join(extraDir, name) });
  expect((await read("inside.md")).text).toBe("inside");
  for (const [target, link, files] of [
    [extraDir, "inside-link", ["inside.md"]],
    [path.join(directory, "outside"), "link", ["private.md", "missing.md"]],
  ] as const) {
    if (!(await createDirectorySymlink(target, path.join(extraDir, link)))) {
      return;
    }
    for (const file of files) {
      await expect(read(path.join(link, file))).rejects.toThrow(
        "path is not an allowed Markdown memory file",
      );
    }
  }
});

it.each(["runbooks", "..notes", "...notes", "~"])(
  "enforces %s glob patterns through agent reads",
  async (name) => {
    const { workspaceDir, extraDir } = await fixture({
      [`extra/${name}/team/allowed.md`]: "allowed",
      "extra/private.md": "private",
    });
    const cfg = {
      agents: { entries: { main: { workspace: workspaceDir } } },
      memory: { search: { extraPaths: [{ path: extraDir, pattern: `${name}/**/*.md` }] } },
    };
    const read = (relativePath: string) =>
      readAgentMemoryFile({ cfg, agentId: "main", relPath: path.join(extraDir, relativePath) });
    await expect(read(`${name}/team/allowed.md`)).resolves.toMatchObject({ text: "allowed" });
    await expect(read("private.md")).rejects.toThrow("path is not an allowed Markdown memory file");
  },
);

it("retries transient read errors for workspace memory files", async () => {
  const { workspaceDir } = await fixture({ "workspace/memory/retry.md": "alpha\nbeta" });
  const relPath = "memory/retry.md";
  const absPath = path.join(workspaceDir, relPath);
  const realOpen = fs.open;
  let attempts = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
    const [target, flags, mode] = args;
    if (typeof target === "string" && path.resolve(target) === absPath && attempts++ === 0) {
      throw Object.assign(new Error("Unknown system error -11: Unknown system error -11, open"), {
        code: "UNKNOWN",
        errno: -11,
      });
    }
    return await realOpen(target, flags, mode);
  });
  await expect(readMemoryFile({ workspaceDir, extraPaths: [], relPath })).resolves.toEqual({
    status: "ok",
    text: "alpha\nbeta",
    path: relPath,
    from: 1,
    lines: 2,
  });
  expect(attempts).toBe(2);
});

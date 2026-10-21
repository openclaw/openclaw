import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  commitMemoryContent,
  hashMemoryContent,
  MemoryWriteConflictError,
  resolveMemoryWritePath,
} from "./short-term-promotion-memory-write.js";

const openState = vi.hoisted(() => ({
  failInPlaceWriteAfterBytes: null as number | null,
  shortFirstRestoreWrite: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...(args as Parameters<typeof actual.open>));
    const partialBytes = openState.failInPlaceWriteAfterBytes;
    if (args[1] !== "r+" || partialBytes === null) {
      return handle;
    }
    openState.failInPlaceWriteAfterBytes = null;
    let shortWriteArmed = openState.shortFirstRestoreWrite;
    openState.shortFirstRestoreWrite = false;
    const realWrite = handle.write.bind(handle);
    const failingWriteFile = async (content: string) => {
      const partial = Buffer.from(content, "utf-8").subarray(0, partialBytes);
      await realWrite(partial, 0, partial.length, 0);
      throw Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
    };
    const write = async (buffer: Buffer, offset: number, length: number, position: number) => {
      const cappedLength = shortWriteArmed && length > 1 ? Math.floor(length / 2) : length;
      shortWriteArmed = false;
      return await realWrite(buffer, offset, cappedLength, position);
    };
    Object.defineProperties(handle, {
      writeFile: { value: failingWriteFile },
      write: { value: write },
    });
    return handle;
  };
  return { ...actual, default: { ...actual, open }, open };
});

// Root ignores directory permissions, so a read-only parent cannot force the
// in-place fallback there; those cases would silently prove atomic replacement.
const readOnlyParentRejectsWrites = process.getuid?.() !== 0;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  openState.failInPlaceWriteAfterBytes = null;
  openState.shortFirstRestoreWrite = false;
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function setupMemoryFile(originalContent: string, readOnlyParent = false): Promise<string> {
  const tempRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-test-")),
  );
  const memoryDir = path.join(tempRoot, "workspace");
  await fs.mkdir(memoryDir);
  const memoryPath = path.join(memoryDir, "MEMORY.md");
  await fs.writeFile(memoryPath, originalContent, "utf-8");
  if (readOnlyParent) {
    await fs.chmod(memoryDir, 0o555);
  }
  cleanups.push(async () => {
    await fs.chmod(memoryDir, 0o755);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  return memoryPath;
}

const original = "# Long-Term Memory\n\n- existing entry that must survive\n";
function commit(
  filePath: string,
  content: string | null,
  options: Partial<Parameters<typeof commitMemoryContent>[0]> = {},
) {
  return commitMemoryContent({
    filePath,
    tempPrefix: `${path.basename(filePath)}.test`,
    expectedHash: hashMemoryContent(original),
    expectedContent: original,
    allowInPlaceFallback: true,
    content,
    ...options,
  });
}

it.each(["missing/MEMORY.md", ...(process.platform === "win32" ? [] : ["missing/../MEMORY.md"])])(
  "rejects a memory target whose missing suffix is %s",
  async (suffix) => {
    const memoryPath = await setupMemoryFile("existing memory");
    const filePath = `${path.dirname(memoryPath)}${path.sep}${suffix.replaceAll("/", path.sep)}`;

    await expect(resolveMemoryWritePath(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(Boolean(process.versions.bun) && process.platform !== "win32")(
  "rejects a non-directory symlink before a parent traversal",
  async () => {
    const tempRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-not-directory-")),
    );
    cleanups.push(async () => await fs.rm(tempRoot, { recursive: true, force: true }));
    const regularFile = path.join(tempRoot, "regular-file");
    const regularLink = path.join(tempRoot, "regular-link");
    const collision = path.join(tempRoot, "collision.md");
    await fs.writeFile(regularFile, "regular");
    await fs.writeFile(collision, "collision");
    await fs.symlink(regularFile, regularLink);

    const invalidPath = `${regularLink}${path.sep}..${path.sep}${path.basename(collision)}`;
    await expect(resolveMemoryWritePath(invalidPath)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await fs.readFile(collision, "utf8")).toBe("collision");
  },
);

it.runIf(process.platform !== "win32" && readOnlyParentRejectsWrites)(
  "uses the checked in-place fallback when the parent rejects a sibling temp file",
  async () => {
    const memoryPath = await setupMemoryFile(original, true);
    const replacement = `${original}- replacement entry\n`;
    await commit(memoryPath, replacement);
    expect(await fs.readFile(memoryPath, "utf-8")).toBe(replacement);
  },
);

it.each([[false, false], ...(readOnlyParentRejectsWrites ? [[true, false]] : []), [false, true]])(
  "rejects changed preimages (read-only=%s, removal=%s)",
  async (readOnlyParent, removal) => {
    const externalEdit = `${original}- external edit\n`;
    const memoryPath = await setupMemoryFile(externalEdit, readOnlyParent);
    await expect(
      commit(memoryPath, removal ? null : `${original}- replacement entry\n`),
    ).rejects.toBeInstanceOf(MemoryWriteConflictError);
    expect(await fs.readFile(memoryPath, "utf-8")).toBe(externalEdit);
  },
);

it.runIf(process.platform !== "win32" && readOnlyParentRejectsWrites)(
  "completes the restore across short writes before truncating",
  async () => {
    const memoryPath = await setupMemoryFile(original, true);
    const promoted = `# Long-Term Memory\n\n## 2026-08-19\n${"- promoted entry\n".repeat(200)}`;
    openState.failInPlaceWriteAfterBytes = 1024;
    openState.shortFirstRestoreWrite = true;

    await expect(commit(memoryPath, promoted)).rejects.toMatchObject({ code: "EFBIG" });

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(original);
  },
);

it.each([false, true])("preserves malformed UTF-8 (read-only parent: %s)", async (readOnly) => {
  const malformed = Buffer.from([0x61, 0xff, 0x62]);
  const memoryPath = await setupMemoryFile("placeholder", readOnly);
  await fs.writeFile(memoryPath, malformed);
  const lossy = malformed.toString("utf-8");

  await expect(
    commit(memoryPath, `${lossy}- promoted entry\n`, {
      expectedHash: hashMemoryContent(lossy),
      expectedContent: lossy,
    }),
  ).rejects.toThrow("not valid UTF-8");

  expect(await fs.readFile(memoryPath)).toEqual(malformed);
});

it("merges valid non-ASCII memory including a literal replacement character", async () => {
  // An intentional U+FFFD is valid UTF-8 and must survive byte-for-byte.
  const unicode = "# Long-Term Memory\n\n- note: 中文 🦀 \uFFFD tail\n";
  const memoryPath = await setupMemoryFile(unicode);

  await commitMemoryContent({
    filePath: memoryPath,
    tempPrefix: `${path.basename(memoryPath)}.promotion`,
    expectedHash: hashMemoryContent(unicode),
    content: `${unicode}- promoted entry\n`,
  });

  expect(await fs.readFile(memoryPath)).toEqual(Buffer.from(`${unicode}- promoted entry\n`));
});

it("still creates a missing memory file (first promotion)", async () => {
  const memoryPath = await setupMemoryFile("placeholder");
  await fs.rm(memoryPath);

  await commitMemoryContent({
    filePath: memoryPath,
    tempPrefix: `${path.basename(memoryPath)}.promotion`,
    content: "# Long-Term Memory\n\n- first entry\n",
  });

  expect(await fs.readFile(memoryPath, "utf-8")).toContain("first entry");
});

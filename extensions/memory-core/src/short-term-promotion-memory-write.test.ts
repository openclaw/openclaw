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

it.runIf(process.platform !== "win32")(
  "atomically replaces memory content without changing its mode",
  async () => {
    const original = "# Long-Term Memory\n\n- existing entry\n";
    const memoryPath = await setupMemoryFile(original);
    await fs.chmod(memoryPath, 0o640);

    await commitMemoryContent({
      filePath: memoryPath,
      tempPrefix: `${path.basename(memoryPath)}.test`,
      expectedHash: hashMemoryContent(original),
      content: `${original}- replacement entry\n`,
    });

    expect((await fs.stat(memoryPath)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(memoryPath, "utf-8")).toContain("replacement entry");
  },
);

it.each([
  "missing/MEMORY.md",
  ...(process.platform === "win32" ? [] : ["missing/../MEMORY.md"]),
  "missing/",
])("rejects a memory target whose missing suffix is %s", async (suffix) => {
  const memoryPath = await setupMemoryFile("existing memory");
  const filePath = `${path.dirname(memoryPath)}${path.sep}${suffix.replaceAll("/", path.sep)}`;

  await expect(resolveMemoryWritePath(filePath)).rejects.toMatchObject({ code: "ENOENT" });
});

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

it.runIf(process.platform !== "win32")(
  "uses the checked in-place fallback when the parent rejects a sibling temp file",
  async () => {
    const original = "# Long-Term Memory\n\n- existing entry\n";
    const memoryPath = await setupMemoryFile(original, true);
    const replacement = `${original}- replacement entry\n`;

    await commitMemoryContent({
      filePath: memoryPath,
      tempPrefix: `${path.basename(memoryPath)}.test`,
      expectedHash: hashMemoryContent(original),
      expectedContent: original,
      allowInPlaceFallback: true,
      content: replacement,
    });

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(replacement);
  },
);

it.each([
  { label: "atomic replacement", readOnlyParent: false },
  { label: "in-place fallback", readOnlyParent: true },
])("rejects a changed preimage before $label", async ({ readOnlyParent }) => {
  const original = "# Long-Term Memory\n\n- original entry\n";
  const externalEdit = `${original}- external edit\n`;
  const memoryPath = await setupMemoryFile(externalEdit, readOnlyParent);

  await expect(
    commitMemoryContent({
      filePath: memoryPath,
      tempPrefix: `${path.basename(memoryPath)}.test`,
      expectedHash: hashMemoryContent(original),
      expectedContent: original,
      allowInPlaceFallback: true,
      content: `${original}- replacement entry\n`,
    }),
  ).rejects.toBeInstanceOf(MemoryWriteConflictError);

  expect(await fs.readFile(memoryPath, "utf-8")).toBe(externalEdit);
});

it("rejects a changed preimage before removing a memory file", async () => {
  const original = "# Long-Term Memory\n\n- original entry\n";
  const externalEdit = `${original}- external edit\n`;
  const memoryPath = await setupMemoryFile(externalEdit);

  await expect(
    commitMemoryContent({
      filePath: memoryPath,
      tempPrefix: `${path.basename(memoryPath)}.test`,
      expectedContent: original,
      content: null,
    }),
  ).rejects.toBeInstanceOf(MemoryWriteConflictError);

  expect(await fs.readFile(memoryPath, "utf-8")).toBe(externalEdit);
});

it.runIf(process.platform !== "win32")(
  "completes the restore across short writes before truncating",
  async () => {
    const original = "# Long-Term Memory\n\n- existing entry that must survive\n";
    const memoryPath = await setupMemoryFile(original, true);
    const promoted = `# Long-Term Memory\n\n## 2026-08-19\n${"- promoted entry\n".repeat(200)}`;
    openState.failInPlaceWriteAfterBytes = 1024;
    openState.shortFirstRestoreWrite = true;

    await expect(
      commitMemoryContent({
        filePath: memoryPath,
        tempPrefix: `${path.basename(memoryPath)}.promotion`,
        expectedHash: hashMemoryContent(original),
        expectedContent: original,
        allowInPlaceFallback: true,
        content: promoted,
      }),
    ).rejects.toMatchObject({ code: "EFBIG" });

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(original);
  },
);

it("refuses to rewrite a memory file that is not valid UTF-8", async () => {
  const malformed = Buffer.concat([
    Buffer.from("# Long-Term Memory\n\n- note: a", "utf-8"),
    Buffer.from([0xff]),
    Buffer.from("b\n", "utf-8"),
  ]);
  const memoryPath = await setupMemoryFile("placeholder");
  await fs.writeFile(memoryPath, malformed);
  const lossy = malformed.toString("utf-8");

  await expect(
    commitMemoryContent({
      filePath: memoryPath,
      tempPrefix: `${path.basename(memoryPath)}.promotion`,
      expectedHash: hashMemoryContent(lossy),
      expectedContent: lossy,
      allowInPlaceFallback: true,
      content: `${lossy}- promoted entry\n`,
    }),
  ).rejects.toMatchObject({
    name: "MemoryFileNotUtf8Error",
    message: expect.stringContaining("not valid UTF-8") as unknown as string,
  });

  // The refusal must leave the file byte-for-byte unchanged, U+FFFD included nowhere.
  expect(await fs.readFile(memoryPath)).toEqual(malformed);
});

it("refuses before any write attempt even when the parent directory is read-only", async () => {
  const malformed = Buffer.concat([
    Buffer.from("# Long-Term Memory\n\n- note: a", "utf-8"),
    Buffer.from([0xff]),
    Buffer.from("b\n", "utf-8"),
  ]);
  const memoryPath = await setupMemoryFile("placeholder", true);
  await fs.writeFile(memoryPath, malformed);
  const lossy = malformed.toString("utf-8");

  await expect(
    commitMemoryContent({
      filePath: memoryPath,
      tempPrefix: `${path.basename(memoryPath)}.promotion`,
      expectedHash: hashMemoryContent(lossy),
      expectedContent: lossy,
      allowInPlaceFallback: true,
      content: `${lossy}- promoted entry\n`,
    }),
  ).rejects.toMatchObject({ name: "MemoryFileNotUtf8Error" });

  expect(await fs.readFile(memoryPath)).toEqual(malformed);
});

it("merges valid non-ASCII memory including a literal replacement character", async () => {
  // A validator that rejects every decoded U+FFFD must fail this test: the
  // original bytes contain an intentional replacement character that has to
  // survive the merge byte-for-byte.
  const original = "# Long-Term Memory\n\n- note: 中文 🦀 \uFFFD tail\n";
  const memoryPath = await setupMemoryFile(original);

  await commitMemoryContent({
    filePath: memoryPath,
    tempPrefix: `${path.basename(memoryPath)}.promotion`,
    expectedHash: hashMemoryContent(original),
    content: `${original}- promoted entry\n`,
  });

  const written = await fs.readFile(memoryPath);
  expect(
    written.subarray(0, Buffer.byteLength(original)).equals(Buffer.from(original, "utf-8")),
  ).toBe(true);
  expect(written.toString("utf-8")).toContain("- promoted entry");
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

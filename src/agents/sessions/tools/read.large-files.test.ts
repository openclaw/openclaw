import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import * as attachments from "@openclaw/media-core/attachment-classify";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../../../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../../process/spawn-broker/host.js";
import { createReadTool } from "./read.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

const sizeHints = vi.hoisted(() => new Map<string, number>());
vi.mock("@openclaw/fs-safe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const directory = await actual.root(...args);
      const size = sizeHints.get(directory.rootReal);
      if (size !== undefined) {
        const open = directory.open.bind(directory);
        directory.open = async (...openArgs) => {
          const opened = await open(...openArgs);
          opened.stat.size = size;
          return opened;
        };
      }
      return directory;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  sizeHints.clear();
  vi.restoreAllMocks();
});

it.each([0, 1])("reads beyond an admitted size hint of %i bytes", async (size) => {
  const root = tempDirs.make("read-size-hint-");
  const filePath = path.join(root, "notes.txt");
  await fs.writeFile(
    filePath,
    Buffer.from(`\uFEFFfirst\n${"x".repeat(2 * 1024 * 1024)}`, "utf16le"),
  );
  sizeHints.set(await fs.realpath(root), size);
  const result = await createReadTool(root).execute("size-hint-read", { path: filePath, limit: 1 });
  expect(result.details).toMatchObject({
    kind: "truncated",
    content: "first",
  });
});

it.skipIf(process.platform !== "linux")("reads zero-sized proc files to actual EOF", async () => {
  const filePath = "/proc/version";
  expect((await fs.stat(filePath)).size).toBe(0);
  const content = await fs.readFile(filePath, "utf8");
  expect(content.length).toBeGreaterThan(0);
  const result = await createReadTool("/").execute("proc-read", { path: filePath });
  expect(result.details).toEqual({ kind: "text", content });
});

it("bounds first-page source reads and reports uncounted totals explicitly", async () => {
  const root = tempDirs.make("read-work-bound-");
  const filePath = path.join(root, "large.txt");
  await fs.writeFile(filePath, Buffer.from(`\uFEFF${"x".repeat(2 * 1024 * 1024)}`, "utf16le"));
  let bytesRead = 0;
  const open = fs.open.bind(fs);
  const reads: MockInstance<FileHandle["read"]>[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    reads.push(vi.spyOn(handle, "read"));
    return handle;
  });
  const result = await createReadTool(root).execute("bounded-read", { path: filePath });
  for (const observed of reads) {
    for (const read of observed.mock.results) {
      if (read.type === "return") {
        bytesRead += (await read.value).bytesRead;
      }
    }
  }
  expect(bytesRead).toBeGreaterThan(0);
  expect(bytesRead).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024);
  expect(result.details).toMatchObject({
    kind: "truncated",
    continuation: { kind: "cursor", offset: 1 },
  });
});

it("keeps the classified file when its pathname is atomically replaced", async () => {
  const root = tempDirs.make("read-admitted-file-");
  const filePath = path.join(root, "notes.txt");
  const replacement = path.join(root, "replacement.txt");
  await fs.writeFile(filePath, `original\n${"a".repeat(2 * 1024 * 1024)}`);
  await fs.writeFile(replacement, `replacement\n${"b".repeat(2 * 1024 * 1024)}`);
  const classify = attachments.classifyAttachmentBytes;
  vi.spyOn(attachments, "classifyAttachmentBytes").mockImplementation(async (params) => {
    const result = await classify(params);
    await fs.rename(replacement, filePath);
    return result;
  });
  const result = await createReadTool(root).execute("admitted-read", { path: filePath, limit: 1 });
  expect(result.details).toMatchObject({ kind: "truncated", content: "original" });
  expect(await fs.readFile(filePath, "utf8")).toMatch(/^replacement\n/);
});

it.each([
  [30_000, 10, 2, 9],
  [6, 2_100, 2_001, 100],
])(
  "preserves remaining line limits after a %i-character source page",
  async (width, limit, offset, remaining) => {
    const root = tempDirs.make("read-remaining-limit-");
    const filePath = path.join(root, "large.txt");
    const lines = Array.from({ length: limit + 1 }, (_, index) => `${index}:${"x".repeat(width)}`);
    await fs.writeFile(filePath, `${lines.join("\n")}\n${"x".repeat(2 * 1024 * 1024)}`);
    const result = await createReadTool(root).execute("limited-read", { path: filePath, limit });
    expect(result.details).toMatchObject({
      kind: "truncated",
      continuation: { kind: "line", offset, limit: remaining },
    });
  },
);

it.each(["utf8", "utf16le", "utf16be"])(
  "preserves legacy double-BOM normalization for large %s text",
  async (encoding) => {
    const root = tempDirs.make("read-double-bom-");
    const filePath = path.join(root, "unicode.txt");
    const bytes = Buffer.from(
      `\uFEFF\uFEFFfirst\n${"x\n".repeat(600_000)}`,
      encoding === "utf8" ? "utf8" : "utf16le",
    );
    await fs.writeFile(filePath, encoding === "utf16be" ? bytes.swap16() : bytes);
    const result = await createReadTool(root).execute("bom-read", { path: filePath, limit: 1 });
    expect(result.details).toMatchObject({
      kind: "truncated",
      content: encoding === "utf8" && process.platform !== "win32" ? "\uFEFFfirst" : "first",
    });
  },
);

it.each(["local", "standalone", "broker"])(
  "pages a 513 MiB file through the %s reader without losing later ranges",
  async (mode) => {
    const root = tempDirs.make("read-large-file-");
    const filePath = path.join(root, mode === "local" ? "large.txt" : "large.sqlite");
    const firstLineBytes = 513 * 1024 * 1024;
    const handle = await fs.open(filePath, "w");
    try {
      // Sparse bytes exercise the real string limit without allocating a giant fixture.
      await handle.write(Buffer.from("\nlast line\n"), 0, 11, firstLineBytes);
    } finally {
      await handle.close();
    }
    const broker = mode === "broker" ? createSpawnBrokerHost() : undefined;
    try {
      await broker?.ready();
      await runWithSpawnBroker(broker, async () => {
        const tool = createReadTool(root);
        const read = (args: { offset?: number; cursor?: number }) =>
          tool.execute("large-read", { path: filePath, ...args });
        const first = await read({});
        expect(first.details).toMatchObject({
          kind: "truncated",
          continuation: { kind: "cursor", offset: 1 },
        });
        const firstText = first.content[0];
        expect(firstText?.type).toBe("text");
        expect(
          Buffer.byteLength(firstText?.type === "text" ? firstText.text : ""),
        ).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
        const nearEnd = await read({ cursor: firstLineBytes - 8 });
        expect(nearEnd.details).toEqual({
          kind: "text",
          content: `${"\0".repeat(8)}\nlast line\n`,
        });
        expect((await read({ offset: 2 })).details).toEqual({
          kind: "text",
          content: "last line\n",
        });
      });
    } finally {
      await broker?.close();
    }
  },
);

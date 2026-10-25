import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  ensureDir,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPathEntries,
  normalizeExtraMemoryPaths,
  remapChunkLines,
  runWithConcurrency,
  stripMemoryAnnotationCarriers,
} from "./internal.js";
import { normalizeMemoryMultimodalSettings, type MemoryMultimodalSettings } from "./multimodal.js";
import { readMemoryFile } from "./read-file.js";

type MultimodalIndexingChunk = NonNullable<
  Awaited<ReturnType<typeof buildMultimodalChunkForIndexing>>
>;

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
afterEach(() => vi.restoreAllMocks());

const expectFileEntry = (entry: Awaited<ReturnType<typeof buildFileEntry>>) =>
  expectDefined(entry, "Expected file entry to be built");

function writeFiles(root: string, files: Record<string, string | Buffer>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, content);
  }
}

function tryCreateSymlink(target: string, linkPath: string, type?: "dir"): boolean {
  try {
    fsSync.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw err;
  }
}

const expectMultimodalIndexingChunk = (
  built: Awaited<ReturnType<typeof buildMultimodalChunkForIndexing>>,
) => expectDefined(built, "Expected multimodal indexing chunk to be built");
const expectEmbeddingInput = (chunk: MultimodalIndexingChunk["chunk"]) =>
  expectDefined(chunk.embeddingInput, "Expected multimodal chunk embedding input");

const multimodal: MemoryMultimodalSettings = normalizeMemoryMultimodalSettings({ enabled: true });

describe("memory host SDK package internals", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = tempDirs.make("memory-package-");
  });
  const getTmpDir = () => testDir;

  it.skipIf(process.platform === "win32")(
    "rejects an uppercase explicit extra file on case-sensitive hosts",
    async () => {
      const tmpDir = getTmpDir();
      const workspaceDir = path.join(tmpDir, "workspace");
      const upperPath = path.join(tmpDir, "NOTES.MD");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(upperPath, "not lowercase Markdown", "utf8");

      await expect(listMemoryFiles(workspaceDir, [upperPath])).resolves.toEqual([]);
      await expect(
        readMemoryFile({ workspaceDir, extraPaths: [upperPath], relPath: upperPath }),
      ).rejects.toThrow("path is not an allowed Markdown memory file");
    },
  );

  it("drains in-flight work before propagating a concurrency failure", async () => {
    const failure = new Error("embedding failed");
    const release = createDeferred();
    const started: number[] = [];
    const completed: number[] = [];
    const run = runWithConcurrency(
      [
        async () => {
          started.push(0);
          await release.promise;
          completed.push(0);
          return 0;
        },
        async () => {
          started.push(1);
          throw failure;
        },
        async () => {
          started.push(2);
          return 2;
        },
      ],
      2,
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    const onSettled = vi.fn();
    void run.then(onSettled, onSettled);
    await Promise.resolve();
    expect(onSettled).not.toHaveBeenCalled();

    release.resolve();
    await expect(run).rejects.toBe(failure);
    expect(completed).toEqual([0]);
    expect(started).toEqual([0, 1]);
  });

  it("propagates directory creation failures", () => {
    const mkdirError = new Error("disk full");
    const targetDir = path.join(getTmpDir(), "blocked");
    vi.spyOn(fsSync, "mkdirSync").mockImplementation(() => {
      throw mkdirError;
    });

    expect(() => ensureDir(targetDir)).toThrow(mkdirError);
  });

  it("normalizes additional memory paths", () => {
    const workspaceDir = path.join(os.tmpdir(), "memory-test-workspace");
    const absPath = path.resolve(path.sep, "shared-notes");
    expect(
      normalizeExtraMemoryPaths(workspaceDir, [
        " notes ",
        "./notes",
        absPath,
        absPath,
        "~/shared-notes",
        "~",
        "",
      ]),
    ).toEqual([
      path.resolve(workspaceDir, "notes"),
      absPath,
      path.join(os.homedir(), "shared-notes"),
      os.homedir(),
    ]);
    expect(
      normalizeExtraMemoryPathEntries(workspaceDir, [
        " notes ",
        { path: "notes" },
        { path: " notes ", pattern: " runbooks/**/*.md " },
        { path: "notes", pattern: "runbooks/**/*.md" },
        { path: "notes", pattern: "archive/**/*.md" },
        "reference",
        { path: "reference", evergreen: true },
        { path: "canonical", evergreen: true },
        "canonical",
        { path: "archive", pattern: "**/*.md", evergreen: true },
      ]),
    ).toEqual([
      { path: path.resolve(workspaceDir, "notes") },
      { path: path.resolve(workspaceDir, "notes"), pattern: "runbooks/**/*.md" },
      { path: path.resolve(workspaceDir, "notes"), pattern: "archive/**/*.md" },
      { path: path.resolve(workspaceDir, "reference"), evergreen: true },
      { path: path.resolve(workspaceDir, "canonical") },
      { path: path.resolve(workspaceDir, "archive"), pattern: "**/*.md", evergreen: true },
    ]);
  });

  it("lists canonical markdown and enabled multimodal files", async () => {
    const tmpDir = getTmpDir();
    const extraDir = path.join(tmpDir, "extra");
    writeFiles(tmpDir, {
      "MEMORY.md": "# Default memory",
      "USER.md": "# User profile",
      "memory.md": "# Legacy memory",
      "memory/default-diagram.png": Buffer.from("png"),
      "extra/note.md": "# Note",
      "extra/diagram.png": Buffer.from("png"),
      "extra/recording.m2a": Buffer.from("audio"),
      "extra/ignore.txt": "ignored",
    });

    const files = await listMemoryFiles(
      tmpDir,
      [path.join(tmpDir, "memory.md"), extraDir],
      multimodal,
    );

    expect(files.map((file) => path.relative(tmpDir, file)).toSorted()).toEqual([
      "MEMORY.md",
      "USER.md",
      path.join("extra", "diagram.png"),
      path.join("extra", "note.md"),
      path.join("extra", "recording.m2a"),
    ]);
  });

  it.each([
    ["lstat", "USER.md", "EIO"],
    ["lstat", "memory", "EIO"],
    ["lstat", "extra", "EIO"],
    ["readdir", "", "EIO"],
    ["readdir", "memory", "EIO"],
    ["readdir", "memory/nested", "EACCES"],
  ] as const)("names a %s failure at %s", async (operation, relative, code) => {
    const workspaceDir = getTmpDir();
    const failedPath = path.join(workspaceDir, relative);
    if (operation === "readdir") {
      fsSync.mkdirSync(failedPath, { recursive: true });
      if (relative.includes("/")) {
        writeFiles(workspaceDir, { "memory/ok.md": "# ok\n" });
      }
    }
    const scanError = Object.assign(new Error(`I/O failure: ${failedPath}`), { code });
    const failTarget = (target: unknown) => {
      if (path.resolve(String(target)) === failedPath) {
        throw scanError;
      }
    };
    if (operation === "lstat") {
      const original = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        failTarget(args[0]);
        return original(...args);
      });
    } else {
      const original = fs.readdir;
      vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        failTarget(args[0]);
        return original(...args);
      });
    }
    await expect(
      listMemoryFiles(workspaceDir, relative === "extra" ? [failedPath] : undefined),
    ).rejects.toMatchObject({
      name: "MemorySourceScanError",
      path: failedPath,
      code,
      cause: scanError,
      message: `memory source scan failed at ${failedPath} (${code}): I/O failure: ${failedPath}`,
    });
  });

  it.each([
    { directory: "notes", rootFile: "root.md" },
    { directory: "..notes", rootFile: "..root.md" },
    { directory: "...notes", rootFile: "...root.md" },
  ])(
    "filters $directory by glob while preserving symlink skips",
    async ({ directory, rootFile }) => {
      const tmpDir = getTmpDir();
      const extraDir = path.join(tmpDir, "extra");
      const outsideDir = path.join(tmpDir, "outside");
      writeFiles(extraDir, {
        [rootFile]: "root",
        [`${directory}/keep.md`]: "keep",
        [`${directory}/nested/keep.md`]: "nested",
        "drafts/skip.md": "skip",
        [`${directory}/ignore.txt`]: "ignore",
      });
      writeFiles(outsideDir, { "linked.md": "linked" });
      tryCreateSymlink(
        path.join(outsideDir, "linked.md"),
        path.join(extraDir, directory, "linked.md"),
      );
      tryCreateSymlink(outsideDir, path.join(extraDir, directory, "linked-dir"), "dir");

      const files = await listMemoryFiles(tmpDir, [
        { path: extraDir, pattern: rootFile },
        { path: extraDir, pattern: `${directory}/**/*.md` },
      ]);

      expect(files.map((file) => path.relative(extraDir, file)).toSorted()).toEqual(
        [
          path.join(directory, "keep.md"),
          path.join(directory, "nested", "keep.md"),
          rootFile,
        ].toSorted(),
      );
    },
  );

  const fixtureFiles = [
    "root.md",
    "notes/team/keep.md",
    "notes/team/deeper/keep.md",
    "logs.cache/deep/keep.md",
    "archive/deep/keep.md",
    ".hidden/deep/keep.md",
    "scratch/deep/keep.md",
  ];
  it.each([
    [
      ["*.md", "notes/*/*.md", "logs.cache/**"],
      [0, 1, 3],
      " notes notes/team logs.cache logs.cache/deep",
    ],
    [["**"], undefined, undefined],
    [["{notes,archive/deep}/**/*.md", "@(logs.cache|scratch)/**/*.md"], undefined, undefined],
    [[".hidden/**/*.md"], [5], " .hidden .hidden/deep"],
    [["x".repeat(65_537), "notes/team/*.md"], [1], " notes notes/team"],
    [["notes/team/*.md", undefined], [0, 1, 2, 3, 4, 5, 6], undefined],
  ] as const)(
    "scans a shared extra root once for %j without losing matching files",
    async (patterns, expectedFiles, expectedDirectories) => {
      const workspaceDir = getTmpDir();
      const extraDir = path.join(workspaceDir, "extra");
      writeFiles(extraDir, Object.fromEntries(fixtureFiles.map((file) => [file, "# Memory\n"])));
      const readdir = vi.spyOn(fs, "readdir");

      const files = await listMemoryFiles(
        workspaceDir,
        patterns.map((pattern) => ({ path: extraDir, pattern })),
      );

      expect(
        files.map((file) => path.relative(extraDir, file).replaceAll(path.sep, "/")).toSorted(),
      ).toEqual(
        (
          expectedFiles?.map((index) => fixtureFiles[index]) ??
          // Node and Bun differ on dotfiles and extglobs. Pruning must preserve
          // each runtime's existing exhaustive leaf-match results.
          fixtureFiles.filter((file) =>
            patterns.some((pattern) => !pattern || path.posix.matchesGlob(file, pattern)),
          )
        ).toSorted(),
      );
      const scannedDirectories = readdir.mock.calls
        .map(([dir]) => path.resolve(String(dir)))
        .filter((dir) => dir === extraDir || dir.startsWith(`${extraDir}${path.sep}`));
      if (expectedDirectories) {
        expect(scannedDirectories.toSorted()).toEqual(
          expectedDirectories
            .split(" ")
            .map((dir) => path.join(extraDir, dir))
            .toSorted(),
        );
      } else {
        expect(scannedDirectories.filter((dir) => dir === extraDir)).toHaveLength(1);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips a symlinked workspace root file instead of aborting enumeration",
    async () => {
      const tmpDir = getTmpDir();
      const outsideDir = path.join(tmpDir, "outside");
      writeFiles(outsideDir, { "shared-user.md": "# Outside user profile" });
      expect(
        tryCreateSymlink(path.join(outsideDir, "shared-user.md"), path.join(tmpDir, "USER.md")),
      ).toBe(true);
      writeFiles(tmpDir, { "memory/notes.md": "# Notes" });

      const files = await listMemoryFiles(tmpDir);

      expect(files.map((file) => path.relative(tmpDir, file))).toEqual([
        path.join("memory", "notes.md"),
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips a symlink when building a file entry",
    async () => {
      const tmpDir = getTmpDir();
      const outsideDir = path.join(tmpDir, "outside");
      const realPath = path.join(outsideDir, "kept.md");
      writeFiles(outsideDir, { "kept.md": "# Kept" });
      const linkedPath = path.join(tmpDir, "linked.md");
      expect(tryCreateSymlink(realPath, linkedPath)).toBe(true);

      await expect(buildFileEntry(linkedPath, tmpDir)).resolves.toBeNull();
      const entry = expectFileEntry(await buildFileEntry(realPath, tmpDir));
      expect(entry.path).toBe(path.relative(tmpDir, realPath));
    },
  );

  it("allows top-level dreams path casing variants", () => {
    expect(isMemoryPath("USER.md")).toBe(true);
    expect(isMemoryPath("dreams.md")).toBe(true);
    expect(isMemoryPath("DREAMS.md")).toBe(true);
  });

  it("retries transient markdown reads while building file entries", async () => {
    const tmpDir = getTmpDir();
    const notePath = path.join(tmpDir, "note.md");
    fsSync.writeFileSync(notePath, "hello", "utf-8");

    const realOpen = fs.open;
    let attempts = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      const [target, flags, mode] = args;
      if (typeof target === "string" && path.resolve(target) === notePath && attempts++ === 0) {
        const err = new Error(
          "Unknown system error -11: Unknown system error -11, open",
        ) as NodeJS.ErrnoException;
        err.code = "UNKNOWN";
        err.errno = -11;
        throw err;
      }
      return await realOpen(target, flags, mode);
    });
    expect(await buildFileEntry(notePath, tmpDir)).toMatchObject({
      path: "note.md",
      kind: "markdown",
    });
    expect(attempts).toBe(2);
  });

  it("builds multimodal chunks lazily and rejects changed files", async () => {
    const tmpDir = getTmpDir();
    const imagePath = path.join(tmpDir, "diagram.png");
    fsSync.writeFileSync(imagePath, Buffer.from("png"));

    const entry = expectFileEntry(await buildFileEntry(imagePath, tmpDir, multimodal));
    expect(entry).toMatchObject({
      path: "diagram.png",
      kind: "multimodal",
      modality: "image",
      mimeType: "image/png",
      contentText: "Image file: diagram.png",
    });
    const built = expectMultimodalIndexingChunk(await buildMultimodalChunkForIndexing(entry));
    const parts = expectEmbeddingInput(built.chunk).parts ?? [];
    expect(parts[0]).toEqual({ type: "text", text: "Image file: diagram.png" });
    const inlinePart = parts[1];
    if (inlinePart?.type !== "inline-data") {
      throw new Error("Expected multimodal inline-data embedding part");
    }
    expect(inlinePart.mimeType).toBe("image/png");

    fsSync.writeFileSync(imagePath, Buffer.alloc(entry.size + 32, 1));
    await expect(buildMultimodalChunkForIndexing(entry)).resolves.toBeNull();
  });

  it("chunks mixed text", () => {
    const mixed = Array.from(
      { length: 30 },
      (_, index) => `Line ${index}: 这是中英文混合的测试内容 with English`,
    ).join("\n");
    const mixedChunks = chunkMarkdown(mixed, { tokens: 50, overlap: 0 });
    expect(mixedChunks.length).toBeGreaterThan(1);
    expect(mixedChunks.map((chunk) => chunk.text).join("\n")).toContain("Line 29");
  });

  it("preserves a surrogate pair at the coarse split boundary", () => {
    const text = `${"a".repeat(39)}🌸${"b".repeat(39)}`;

    const chunks = chunkMarkdown(text, { tokens: 10, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(() => encodeURIComponent(chunk.text)).not.toThrow();
    }
  });

  it.each([
    ["a long segment", "a".repeat(3000), ["a".repeat(100)]],
    [
      "mixed short and long lines",
      ["intro line", "b".repeat(3000), "outro line"].join("\n"),
      ["intro line", "outro line"],
    ],
    [
      "already retained carry entries",
      ["a".repeat(900), "b".repeat(100), "c".repeat(1450)].join("\n"),
      [],
    ],
  ] as const)("bounds overlap with %s", (_name, content, retained) => {
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 80 });
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1600);
    }
    for (const text of retained) {
      expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(text);
    }
  });

  it.each([
    { label: "common CJK", character: "中", count: 60, retained: 24 },
    { label: "rare BMP CJK", character: "\u3400", count: 60, retained: 8 },
    { label: "supplementary CJK", character: "\u{20000}", count: 60, retained: 6 },
    { label: "emoji", character: "🌸", count: 60, retained: 49 },
    { label: "lone high surrogates", character: "\ud800", count: 120, retained: 99 },
    { label: "lone low surrogates", character: "\udc00", count: 120, retained: 99 },
  ])("preserves the weighted overlap tail for $label", ({ character, count, retained }) => {
    const firstLine = `${"a".repeat(600)}${character.repeat(count)}`;
    const nextLine = "x".repeat(1499);
    const content = [firstLine, nextLine].join("\n");

    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 80 });

    // The 100-unit overlap window reserves one unit for its separator.
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      firstLine,
      `${character.repeat(retained)}\n${nextLine}`,
    ]);
    for (const chunk of chunks) {
      expect(estimateStringChars(chunk.text)).toBeLessThanOrEqual(1600);
    }
  });

  it("chunks top-level curated entries without carrying neighboring bullets", () => {
    const text = [
      "# Curated memory",
      "",
      "- Alpha entry",
      "  alpha continuation",
      "- Beta entry",
      "  beta continuation",
      "- Global entry",
    ].join("\n");

    const chunks = chunkMarkdown(text, { tokens: 400, overlap: 40, perEntry: true });

    expect(
      chunks.map((c) => [c.text, c.startLine, c.endLine, c.entryStartLine, c.entryEndLine]),
    ).toEqual([
      ["# Curated memory\n", 1, 2, undefined, undefined],
      ["- Alpha entry\n  alpha continuation", 3, 4, 3, 4],
      ["- Beta entry\n  beta continuation", 5, 6, 5, 6],
      ["- Global entry", 7, 7, 7, 7],
    ]);
  });

  it("strips recall annotation carriers while preserving source line positions", () => {
    const text = [
      "- Keep. <!-- trigger: recall --> <!-- importance: 9 -->",
      "  <!-- project: project/key -->",
      "  Note <!-- note: visible -->.",
    ].join("\n");
    expect(stripMemoryAnnotationCarriers(text)).toBe("- Keep.\n\n  Note <!-- note: visible -->.");
  });

  it("keeps promotion headings and markers out of neighboring entries", () => {
    const text = [
      "- Alpha entry <!-- project: github.com/acme/alpha -->",
      "### Project: github.com/acme/beta",
      "",
      "<!-- openclaw-memory-promotion:memory:beta -->",
      "- Beta entry <!-- project: github.com/acme/beta -->",
    ].join("\n");

    const chunks = chunkMarkdown(text, { tokens: 400, overlap: 40, perEntry: true });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "- Alpha entry <!-- project: github.com/acme/alpha -->",
      "### Project: github.com/acme/beta\n\n<!-- openclaw-memory-promotion:memory:beta -->",
      "- Beta entry <!-- project: github.com/acme/beta -->",
    ]);
    expect(chunks.map((chunk) => [chunk.entryStartLine, chunk.entryEndLine])).toEqual([
      [1, 1],
      [undefined, undefined],
      [5, 5],
    ]);
  });

  it("remaps chunk lines using JSONL source line maps", () => {
    const lineMap = [4, 6, 7, 10, 13];
    const chunks = chunkMarkdown(
      "User: Hello\nAssistant: Hi\nUser: Question\nAssistant: Answer\nUser: Thanks",
      { tokens: 400, overlap: 0 },
    );

    remapChunkLines(chunks, lineMap);

    expect([chunks[0]?.startLine, chunks.at(-1)?.endLine]).toEqual([4, 13]);
  });
});

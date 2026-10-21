import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import * as tar from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DIR_FETCH_HARD_MAX_BYTES } from "../shared/dir-fetch-limits.js";
import { FILE_TRANSFER_SUBDIR } from "./descriptors.js";

const appendFileTransferAudit = vi.fn(async () => undefined);
const saveMediaBuffer = vi.fn<() => Promise<{ path: string }>>();
const invokeNodeToolPayload = vi.fn<typeof import("./node-tool-invoke.js").invokeNodeToolPayload>();
let bindFileTransferAudit: typeof import("../shared/audit-context.js").bindFileTransferAudit;
let createDirFetchTool: typeof import("./dir-fetch-tool.js").createDirFetchTool;
let tmpRoot: string;

beforeAll(async () => {
  // Keep the real archive runtime stable; only the node payload and saved path vary per case.
  vi.resetModules();
  vi.doMock("openclaw/plugin-sdk/media-store", () => ({ saveMediaBuffer }));
  vi.doMock("../shared/audit.js", () => ({ appendFileTransferAudit }));
  vi.doMock("./node-tool-invoke.js", () => ({
    readRequiredNodePath: (params: Record<string, unknown>) => ({
      node: String(params.node),
      requestedPath: String(params.path),
    }),
    invokeNodeToolPayload,
  }));
  ({ bindFileTransferAudit } = await import("../shared/audit-context.js"));
  ({ createDirFetchTool } = await import("./dir-fetch-tool.js"));
});

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-tool-test-")));
});

afterEach(async () => {
  appendFileTransferAudit.mockReset();
  saveMediaBuffer.mockReset();
  invokeNodeToolPayload.mockReset();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/media-store");
  vi.doUnmock("../shared/audit.js");
  vi.doUnmock("./node-tool-invoke.js");
  vi.resetModules();
});

async function createTarBuffer(files: Record<string, string | Buffer>): Promise<Buffer> {
  const sourceDir = path.join(tmpRoot, `source-${randomUUID()}`);
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(sourceDir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ cwd: sourceDir, gzip: true, portable: true }, ["."])) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

type RawTarEntry = {
  path: string;
  contents?: string;
  type?: tar.Header["type"];
  linkpath?: string;
};

function createRawTarBuffer(entries: RawTarEntry[]): Buffer {
  const blocks = entries.flatMap(({ path: entryPath, contents = "", type = "File", linkpath }) => {
    const payload = Buffer.from(contents);
    const block = Buffer.alloc(512);
    const header = new tar.Header({
      path: entryPath,
      type,
      linkpath,
      size: payload.byteLength,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
    });
    // Bypass tar.c and filesystem naming rules without letting the header encoder
    // truncate, split, or normalize the raw path these security cases exercise.
    expect(Buffer.byteLength(entryPath)).toBeLessThan(100);
    expect(header.encode(block)).toBe(false);
    expect(block.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "")).toBe(entryPath);
    return [block, payload, Buffer.alloc((512 - (payload.byteLength % 512)) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function pathOverrideEntries(
  format: "PAX" | "GNU",
  rawPath: string,
  effectivePath: string,
): RawTarEntry[] {
  return [
    format === "PAX"
      ? {
          path: "PaxHeader",
          type: "ExtendedHeader",
          contents: new tar.Pax({ path: effectivePath }).encodeBody(),
        }
      : { path: "././@LongLink", type: "NextFileHasLongPath", contents: `${effectivePath}\0` },
    { path: rawPath, contents: "normalized" },
  ];
}

function prepareArchive(tarBuffer: Buffer, mediaName = "media", canonicalPath = "/tmp/project") {
  const mediaDir = path.join(tmpRoot, mediaName);
  const archivePath = path.join(mediaDir, `archive-${randomUUID()}.tar.gz`);
  saveMediaBuffer.mockImplementation(async () => {
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(archivePath, tarBuffer);
    return { path: archivePath };
  });
  invokeNodeToolPayload.mockImplementation(async (input) => ({
    payload: {
      ok: true,
      path: canonicalPath,
      tarBase64: tarBuffer.toString("base64"),
      tarBytes: tarBuffer.byteLength,
      sha256: crypto.createHash("sha256").update(tarBuffer).digest("hex"),
      fileCount: 3,
    },
    audit: bindFileTransferAudit(
      {
        op: input.command,
        nodeId: "node-1",
        nodeDisplayName: "Node One",
        requestedPath: input.requestedPath,
      },
      Date.now(),
    ),
  }));
  return { archivePath, mediaDir };
}

async function executeDirFetch() {
  return await createDirFetchTool().execute("tool-call-1", {
    node: "node-1",
    path: "/tmp/project",
  });
}

type ToolResult = Awaited<ReturnType<AnyAgentTool["execute"]>>;
type SavedFile = {
  relPath: string;
  localPath: string;
  size: number;
  sha256: string;
  mimeType: string;
};
const sha256 = (bytes: string | Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const resultText = (content: ToolResult["content"]) =>
  content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

function readSavedContent(content: ToolResult["content"]) {
  const text = resultText(content);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
  expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
  const manifest = JSON.parse(text.split("\n").find((line) => line.startsWith("{"))!) as {
    rootDir: string;
    fileCount: number;
    displayedCount: number;
    files: Array<{ relPath: string; size: number }>;
  };
  expect(manifest.displayedCount).toBe(manifest.files.length);
  return { text, ...manifest };
}

function expectAudit(fields: { decision: string; errorCode?: string }) {
  expect(appendFileTransferAudit).toHaveBeenLastCalledWith(expect.objectContaining(fields));
}

async function expectUnsafeArchive(
  entries: RawTarEntry[],
  causeCode: "entry-path" | "entry-filtered" = "entry-path",
  message = /^dir\.fetch UNSAFE_ARCHIVE:/u,
) {
  const { archivePath, mediaDir } = prepareArchive(createRawTarBuffer(entries));
  await expect(executeDirFetch()).rejects.toMatchObject({
    message: expect.stringMatching(message),
    cause: { name: "ArchiveSecurityError", code: causeCode },
  });
  await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readdir(mediaDir)).resolves.toEqual([]);
  expectAudit({ decision: "error", errorCode: "UNSAFE_ARCHIVE" });
}

describe("dir.fetch archive extraction", () => {
  it("reports unreadable extracted metadata instead of returning a partial manifest", async () => {
    prepareArchive(createRawTarBuffer([{ path: "ok.txt", contents: "saved" }]));
    const stat = fs.stat;
    const failure = Object.assign(new Error("cannot read extracted metadata"), { code: "EIO" });
    const metadata = vi.spyOn(fs, "stat").mockImplementation((...args) => {
      if (
        String(args[0]).includes(`${path.sep}dir-fetch-`) &&
        path.basename(String(args[0])) === "ok.txt"
      ) {
        return Promise.reject(failure);
      }
      return stat(...args);
    });
    try {
      await expect(executeDirFetch()).rejects.toBe(failure);
      expect(appendFileTransferAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ decision: "allowed" }),
      );
    } finally {
      metadata.mockRestore();
    }
  });

  it("extracts a bounded tar and returns the plugin-side manifest", async () => {
    const expectedContents: Record<string, string> = {
      "ok.txt": "ok",
      [path.join("nested", "also-ok.txt")]: "also ok",
      ".root-note": "hidden root",
      [path.join(".hidden", "note.txt")]: "hidden member",
      "empty.bin": "",
      "large.bin": "a".repeat(300_017),
    };
    const tarBuffer = await createTarBuffer(expectedContents);
    prepareArchive(tarBuffer);
    const result = await executeDirFetch();
    const visible = readSavedContent(result.content);
    expect(visible.text).toContain("ok.txt");
    expect(visible.text).toContain(".root-note");
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Fetched 6 files") }],
      details: { path: "/tmp/project", fileCount: 6 },
    });
    const { files } = result.details as { files: SavedFile[] };
    expect(files).toHaveLength(6);
    expect(visible).toMatchObject({ fileCount: 6, files: expect.any(Array) });
    expect(visible.files.map((file) => file.relPath).toSorted()).toEqual(
      Object.keys(expectedContents).toSorted(),
    );
    for (const file of files) {
      const contents = expectedContents[file.relPath]!;
      expect(file).toMatchObject({ sha256: sha256(contents), size: Buffer.byteLength(contents) });
    }
    for (const file of visible.files) {
      const bytes = await fs.readFile(path.join(visible.rootDir, file.relPath));
      expect(bytes.toString()).toBe(expectedContents[file.relPath]);
      expect(bytes.byteLength).toBe(file.size);
    }
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      tarBuffer,
      "application/gzip",
      FILE_TRANSFER_SUBDIR,
      DIR_FETCH_HARD_MAX_BYTES,
    );
    expectAudit({ decision: "allowed" });
  });

  it("bounds a large saved manifest while preserving every file and image-first attachments", async () => {
    const names = Array.from(
      { length: 240 },
      (_, i) => `${String(i).padStart(3, "0")}-${"雪".repeat(16)}.txt`,
    );
    if (process.platform !== "win32") {
      names.push('000-quoted"line\n.txt');
    }
    const relPaths = [...names, "z-image.png", "z-image.jpg"];
    const tarBuffer = await createTarBuffer(
      Object.fromEntries(relPaths.map((name) => [name, name])),
    );
    // Remote metadata need not fit in text; the exact local root identifies the saved tree.
    const { archivePath } = prepareArchive(tarBuffer, "media", "/" + "雪".repeat(10000));
    const stringify = JSON.stringify;
    let encodedRecords = 0;
    const encoding = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value: unknown, replacer, space) => {
        if (typeof value === "object" && value !== null) {
          if ("files" in value && Array.isArray(value.files)) {
            encodedRecords += value.files.length;
          } else if ("relPath" in value && "size" in value && Object.keys(value).length === 2) {
            encodedRecords += 1;
          }
        }
        return stringify(value, replacer, space);
      });
    let result: ToolResult;
    try {
      result = await executeDirFetch();
    } finally {
      encoding.mockRestore();
    }
    const visible = readSavedContent(result.content);
    expect(visible.fileCount).toBe(relPaths.length);
    expect(visible.displayedCount).toBeGreaterThan(0);
    expect(visible.displayedCount).toBeLessThan(relPaths.length);
    expect(visible.files).toEqual(
      relPaths
        .toSorted()
        .slice(0, visible.displayedCount)
        .map((relPath) => ({
          relPath,
          size: Buffer.byteLength(relPath),
        })),
    );
    expect(visible.text).toContain(
      `${relPaths.length - visible.displayedCount} saved files omitted`,
    );
    expect(visible.text).toContain("available local file or directory capabilities");
    expect(visible.text).not.toContain("details.files");
    expect(visible.text).not.toContain("pageToken");
    // Independent structured/media contract: extraction walk order, every metadata
    // field and all saved bytes survive even when their text rows are omitted.
    const rootDir = path.join(
      path.dirname(archivePath),
      `dir-fetch-${path.basename(archivePath, ".gz")}`,
    );
    const expectedFiles: SavedFile[] = [];
    for (const relPath of await fs.readdir(rootDir)) {
      const localPath = path.join(rootDir, relPath);
      const bytes = await fs.readFile(localPath);
      expect(bytes.toString()).toBe(relPath);
      expectedFiles.push({
        relPath,
        localPath,
        size: bytes.length,
        sha256: sha256(bytes),
        mimeType: relPath.endsWith(".png")
          ? "image/png"
          : relPath.endsWith(".jpg")
            ? "image/jpeg"
            : "text/plain",
      });
    }
    expect(expectedFiles.map((file) => file.relPath).toSorted()).toEqual(relPaths.toSorted());
    const images = expectedFiles.filter((file) => file.mimeType.startsWith("image/"));
    const others = expectedFiles.filter((file) => !file.mimeType.startsWith("image/"));
    expect(result.details).toEqual({
      path: "/" + "雪".repeat(10000),
      rootDir,
      fileCount: relPaths.length,
      tarBytes: tarBuffer.length,
      sha256: sha256(tarBuffer),
      files: expectedFiles,
      media: { mediaUrls: [...images, ...others].slice(0, 25).map((file) => file.localPath) },
    });
    expect(visible.text.split("\n").find((line) => line.startsWith("{"))).toBe(
      JSON.stringify({
        rootDir,
        fileCount: relPaths.length,
        displayedCount: visible.displayedCount,
        files: visible.files,
      }),
    );
    expect(encodedRecords).toBeGreaterThan(0);
    expect(encodedRecords).toBeLessThanOrEqual(visible.displayedCount + 1);
  });

  it("reports a reserved root without partial or rewritten saved paths", async () => {
    const tarBuffer = await createTarBuffer({ "ok.txt": "saved" });
    prepareArchive(tarBuffer, "[INST]");
    const result = await executeDirFetch();
    const text = resultText(result.content);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
    expect(text).toContain("No usable local path is shown");
    expect(text).not.toContain("REMOVED_SPECIAL_TOKEN");
    expect(result.details).toMatchObject({
      fileCount: 1,
      files: expect.any(Array),
    });
    const details = result.details as { files: SavedFile[] };
    expect(details.files.map((file) => file.relPath)).toEqual(["ok.txt"]);
    for (const file of details.files) {
      await expect(fs.readFile(file.localPath, "utf8")).resolves.toBe("saved");
    }
  });

  it.each(["SymbolicLink", "Link"] as const)(
    "rejects a Fleet-shaped archive containing a %s",
    async (type) => {
      // A symlink entry used to hang extraction instead of rejecting; the test
      // timeout bounds settling without a wall-clock race, including on Windows.
      await expectUnsafeArchive(
        [
          { path: "data", type: "Directory" },
          { path: "data/state.json", contents: "{}" },
          { path: "auth", type: "Directory" },
          { path: "auth/token", contents: "secret" },
          { path: "data/token-link", type, linkpath: "../auth/token" },
        ],
        "entry-filtered",
        /dir\.fetch UNSAFE_ARCHIVE:.*link/iu,
      );
    },
  );

  it.each(["PAX", "GNU"] as const)(
    "extracts canonical %s override names beneath the destination",
    async (format) => {
      const entries = pathOverrideEntries(format, "raw.txt", "./pkg//dir\\note.txt");
      const expectedPath = ["pkg", "dir", "note.txt"];
      const { mediaDir } = prepareArchive(createRawTarBuffer(entries));
      const result = await executeDirFetch();
      const details = result.details as {
        rootDir: string;
        files: Array<{ relPath: string; localPath: string }>;
      };
      expect(details.files).toMatchObject([
        {
          relPath: path.join(...expectedPath),
          localPath: path.join(details.rootDir, ...expectedPath),
        },
      ]);
      expect(path.dirname(details.rootDir)).toBe(mediaDir);
      await expect(fs.readFile(details.files[0]!.localPath, "utf8")).resolves.toBe("normalized");
      expectAudit({ decision: "allowed" });
    },
  );

  it.each([
    "../escape.txt",
    "dir/..\\escape.txt",
    "/escape.txt",
    "\\\\server\\share\\escape.txt",
    "C:escape.txt",
    "dir/C:escape.txt",
  ])("rejects unsafe raw path %j", async (entryPath) => {
    await expectUnsafeArchive([{ path: entryPath, contents: "blocked" }]);
  });

  it.each(["PAX", "GNU"] as const)(
    "does not let a safe %s override hide an unsafe raw name",
    async (format) => {
      await expectUnsafeArchive(pathOverrideEntries(format, "dir\\..\\escape.txt", "safe.txt"));
    },
  );

  it("rejects canonical collisions", async () => {
    await expectUnsafeArchive([
      { path: "dir/note.txt", contents: "first" },
      { path: "./dir//note.txt", contents: "second" },
    ]);
  });

  it("maps single-entry expansion limits to TREE_TOO_LARGE", async () => {
    const tarBuffer = await createTarBuffer({ "large.bin": Buffer.alloc(16 * 1024 * 1024 + 1) });
    const { archivePath, mediaDir } = prepareArchive(tarBuffer);

    await expect(executeDirFetch()).rejects.toThrow(
      /dir\.fetch UNCOMPRESSED_TOO_LARGE: archive entry extracted size exceeds limit/iu,
    );
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(mediaDir)).resolves.toEqual([]);
    expectAudit({ decision: "error", errorCode: "TREE_TOO_LARGE" });
  });
});

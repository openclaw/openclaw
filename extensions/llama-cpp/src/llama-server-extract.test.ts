import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLAMA_SERVER_BUILD,
  LLAMA_SERVER_COMMIT,
  LLAMA_SERVER_RELEASE,
  selectLlamaServerAsset,
  type LlamaServerAsset,
} from "./llama-server-assets.js";
import { ensureLlamaServerInstalled } from "./llama-server-install.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  resolveLlamaCppDataDir: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./defaults.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./defaults.js")>()),
  resolveLlamaCppDataDir: mocks.resolveLlamaCppDataDir,
}));

const tempRoots: string[] = [];
const TEST_ARCHIVE_ROOT = selectLlamaServerAsset("linux", "x64").archiveRoot;

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.execFile.mockReset();
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.resolveLlamaCppDataDir.mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createTempRoot(): Promise<string> {
  // Resolve the mkdtemp root: macOS reports /var, while extraction compares the
  // canonical /private/var spelling.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-extract-")));
  tempRoots.push(root);
  return root;
}

async function createTarArchive(
  root: string,
  build: (buildDir: string) => Promise<void>,
  entries: readonly string[] = [TEST_ARCHIVE_ROOT],
): Promise<{ archivePath: string; destDir: string }> {
  const stageDir = path.join(root, "stage");
  const buildDir = path.join(stageDir, TEST_ARCHIVE_ROOT);
  await fs.mkdir(buildDir, { recursive: true });
  await build(buildDir);
  const archivePath = path.join(root, "asset.tar.gz");
  // Keep tiny fixtures synchronous: node-tar's async hard-link queue can close gzip twice.
  tar.c({ file: archivePath, cwd: stageDir, gzip: true, sync: true }, [...entries]);
  const destDir = path.join(root, "dest");
  await fs.mkdir(destDir, { recursive: true });
  return { archivePath, destDir };
}

async function createZipArchive(
  root: string,
  entries: Record<string, string>,
): Promise<{ archivePath: string; destDir: string }> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  const archivePath = path.join(root, "asset.zip");
  await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  const destDir = path.join(root, "dest");
  await fs.mkdir(destDir, { recursive: true });
  return { archivePath, destDir };
}

function withoutAliases(asset: LlamaServerAsset): LlamaServerAsset {
  return { ...asset, regularFileAliases: [] };
}

function installedPath(destDir: string, asset: LlamaServerAsset) {
  return path.join(destDir, LLAMA_SERVER_RELEASE, `win32-${asset.arch}`, asset.executable);
}

async function installArchive(params: {
  archivePath: string;
  destDir: string;
  asset: LlamaServerAsset;
}) {
  const bytes = await fs.readFile(params.archivePath);
  mocks.resolveLlamaCppDataDir.mockReturnValue(params.destDir);
  mocks.fetchWithSsrFGuard.mockResolvedValue({
    response: new Response(new Uint8Array(bytes)),
    release: vi.fn(),
  });
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) =>
      callback(
        null,
        `version: test (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
        "",
      ),
  );
  const { command } = await ensureLlamaServerInstalled({
    asset: {
      ...params.asset,
      // Archive admission uses synthetic host metadata, independent of the host's
      // glibc/macOS floor; the native version probe above is the only scripted step.
      platform: "win32",
      dependencies: [],
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  return command;
}

describe("managed installer archive admission", () => {
  it("materializes the pinned SONAME manifest as regular files", async () => {
    const root = await createTempRoot();
    const asset = selectLlamaServerAsset("linux", "x64");
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, asset.executable), "binary");
      for (const [source, aliases] of asset.regularFileAliases) {
        await fs.writeFile(path.join(buildDir, source), `contents:${source}`);
        for (const alias of aliases) {
          await fs.symlink(source, path.join(buildDir, alias));
        }
      }
    });

    await expect(installArchive({ archivePath, destDir, asset })).resolves.toBe(
      installedPath(destDir, asset),
    );

    const buildDir = path.dirname(installedPath(destDir, asset));
    for (const [source, aliases] of asset.regularFileAliases) {
      for (const alias of aliases) {
        expect((await fs.lstat(path.join(buildDir, alias))).isFile()).toBe(true);
        expect(await fs.readFile(path.join(buildDir, alias), "utf8")).toBe(`contents:${source}`);
      }
    }
  });

  it("ignores archive-provided symlink targets outside the pinned manifest", async () => {
    const root = await createTempRoot();
    const asset = withoutAliases(selectLlamaServerAsset("linux", "x64"));
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, asset.executable), "binary");
      await fs.symlink("../../../escape.txt", path.join(buildDir, "unexpected-link"));
    });

    await installArchive({ archivePath, destDir, asset });

    await expect(
      fs.lstat(path.join(path.dirname(installedPath(destDir, asset)), "unexpected-link")),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(root, "escape.txt"))).rejects.toThrow();
  });

  it("does not publish archive-provided hard links", async () => {
    const root = await createTempRoot();
    const asset = withoutAliases(selectLlamaServerAsset("linux", "x64"));
    const { archivePath, destDir } = await createTarArchive(
      root,
      async (buildDir) => {
        const executable = path.join(buildDir, asset.executable);
        await fs.writeFile(executable, "binary");
        await fs.link(executable, path.join(buildDir, "unexpected-hardlink"));
      },
      [
        path.posix.join(TEST_ARCHIVE_ROOT, asset.executable),
        path.posix.join(TEST_ARCHIVE_ROOT, "unexpected-hardlink"),
      ],
    );

    await installArchive({ archivePath, destDir, asset });

    await expect(
      fs.lstat(path.join(path.dirname(installedPath(destDir, asset)), "unexpected-hardlink")),
    ).rejects.toThrow();
  });

  it("rejects archives that exceed the llama.cpp entry budget", async () => {
    const root = await createTempRoot();
    const asset = withoutAliases(selectLlamaServerAsset("linux", "x64"));
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await Promise.all(
        Array.from({ length: 1_000 }, (_, index) =>
          fs.writeFile(path.join(buildDir, `component-${index}`), "metadata"),
        ),
      );
    });

    await expect(installArchive({ archivePath, destDir, asset })).rejects.toThrow(
      /entry count exceeds limit/u,
    );
    expect(await fs.readdir(destDir)).toStrictEqual([]);
  });

  it("fails when a pinned regular-file alias source is absent", async () => {
    const root = await createTempRoot();
    const baseAsset = selectLlamaServerAsset("linux", "x64");
    const asset: LlamaServerAsset = {
      ...baseAsset,
      regularFileAliases: [["missing.so.1", ["missing.so"]]],
    };
    const { archivePath, destDir } = await createTarArchive(root, async (buildDir) => {
      await fs.writeFile(path.join(buildDir, asset.executable), "binary");
    });

    await expect(installArchive({ archivePath, destDir, asset })).rejects.toThrow(
      /does not contain regular alias source missing\.so\.1/u,
    );
  });

  it("rejects a zip entry that escapes through Windows separators", async () => {
    const root = await createTempRoot();
    const asset = selectLlamaServerAsset("win32", "x64");
    const { archivePath, destDir } = await createZipArchive(root, {
      "..\\..\\escape.txt": "owned",
      [asset.executable]: "binary",
    });

    await expect(installArchive({ archivePath, destDir, asset })).rejects.toThrow();
    expect(await fs.readdir(destDir)).toStrictEqual([]);
    await expect(fs.stat(path.join(root, "escape.txt"))).rejects.toThrow();
  });

  it("extracts the flat Windows zip layout", async () => {
    const root = await createTempRoot();
    const asset = selectLlamaServerAsset("win32", "x64");
    const { archivePath, destDir } = await createZipArchive(root, {
      [asset.executable]: "binary",
      "ggml-base.dll": "library",
    });

    await expect(installArchive({ archivePath, destDir, asset })).resolves.toBe(
      installedPath(destDir, asset),
    );
    expect(
      (await fs.readdir(path.dirname(installedPath(destDir, asset)))).toSorted(),
    ).toStrictEqual(["ggml-base.dll", asset.executable]);
  });
});

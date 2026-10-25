import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import {
  createClosedChunkStream,
  createStreamingResponse,
} from "../../test-support/streaming-error-response.js";

type CapturedArchiveLimits = NonNullable<
  Parameters<typeof import("openclaw/plugin-sdk/setup-tools").extractArchive>[0]["limits"]
>;

const { limits, fetchMock, brewMock, runMock, downloads } = vi.hoisted(() => ({
  limits: [] as CapturedArchiveLimits[],
  fetchMock: vi.fn(),
  brewMock: vi.fn(),
  runMock: vi.fn(),
  downloads: [] as string[],
}));

// mock-isolation: Supply the controlled downloader without opening a real network request.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: fetchMock }));

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>();
  return {
    ...actual,
    extractArchive: async (params: Parameters<typeof actual.extractArchive>[0]) => {
      limits.push(params.limits ?? {});
      return await actual.extractArchive(params);
    },
    resolveBrewExecutable: brewMock,
  };
});

// mock-isolation: Inspect installer commands without executing host processes.
vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: runMock,
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  return {
    ...actual,
    withTempDownloadPath: async (
      params: { prefix: string; fileName?: string; tmpDir?: string },
      run: (tmpPath: string) => Promise<unknown>,
    ) =>
      await actual.withTempDownloadPath(params, async (tmpPath) => {
        downloads.push(tmpPath);
        return await run(tmpPath);
      }),
  };
});

const { downloadToFile, installSignalCli } = await import("./install-signal-cli.js");

function okDownloadResponse(body: BodyInit, init: ResponseInit = {}) {
  const result = {
    response: new Response(body, { status: 200, ...init }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  fetchMock.mockResolvedValueOnce(result);
  return result;
}

const DOWNLOAD_URL = "https://example.com/signal-cli.tgz";
const NATIVE_ASSET = {
  name: "signal-cli-0.0.0-Linux-native.tar.gz",
  browser_download_url: "https://example.com/linux-native.tar.gz",
};
function mockRelease(version: string, assets: unknown[] = [NATIVE_ASSET]) {
  return okDownloadResponse(JSON.stringify({ tag_name: `v${version}`, assets }), {
    headers: { "content-type": "application/json" },
  });
}

let workDir: string;
let filePath: string;

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessPlatform(platform: NodeJS.Platform, arch: string) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-install-"));
  filePath = path.join(workDir, "signal-cli.tgz");
  limits.length = 0;
  fetchMock.mockReset();
  brewMock.mockReset();
  runMock.mockReset();
  downloads.length = 0;
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  Object.defineProperty(process, "arch", { configurable: true, value: originalArch });
  await fs.rm(workDir, { recursive: true, force: true });
});

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectTempDownloadDirMissing(): Promise<void> {
  expect(downloads).toHaveLength(1);
  const [tmpPath] = downloads;
  if (!tmpPath) {
    throw new Error("expected one captured temp download path");
  }
  await expectPathMissing(path.dirname(tmpPath));
}
async function archive(directory: string, contents: string) {
  await fs.mkdir(path.join(workDir, directory), { recursive: true });
  await fs.writeFile(path.join(workDir, directory, "signal-cli"), contents, "utf-8");
  const archivePath = path.join(workDir, "archive.tgz");
  await tar.c({ cwd: workDir, file: archivePath, gzip: true }, [directory]);
  return archivePath;
}
async function expectRejectedDownload(error: string, release: ReturnType<typeof vi.fn>) {
  await expect(downloadToFile(DOWNLOAD_URL, filePath)).rejects.toThrow(error);
  await expectPathMissing(filePath);
  expect(release).toHaveBeenCalledOnce();
}

it("rejects a release with only signatures or incomplete assets", async () => {
  setProcessPlatform("linux", "x64");
  mockRelease("0.0.0", [
    { name: "signal-cli.tar.gz" },
    { browser_download_url: "https://example.com/file.tar.gz" },
    { name: "signal-cli.tgz.asc", browser_download_url: "https://example.com/signature" },
  ]);
  await expect(installSignalCli(createRuntimeSpies())).resolves.toEqual({
    ok: false,
    error: "No compatible release asset found for this platform.",
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([
  ["linux", "arm64", expect.stringContaining("Install Homebrew")],
  ["win32", "x64", "Signal CLI auto-install is not supported on Windows yet."],
] as const)("does not fetch archives on %s/%s", async (platform, arch, error) => {
  setProcessPlatform(platform, arch);
  brewMock.mockReturnValue(undefined);
  await expect(installSignalCli(createRuntimeSpies())).resolves.toEqual({ ok: false, error });
  expect(fetchMock).not.toHaveBeenCalled();
});
it("releases non-success responses before rejecting", async () => {
  const { release } = okDownloadResponse("service unavailable", { status: 503 });
  await expect(downloadToFile(DOWNLOAD_URL, filePath)).rejects.toThrow("HTTP 503");
  expect(release).toHaveBeenCalledOnce();
});

it.each([undefined, "0x10"])("downloads with SSRF guard and declared length %s", async (length) => {
  const fetchResult = okDownloadResponse("archive", {
    headers: length === undefined ? {} : { "content-length": length },
  });
  await downloadToFile(DOWNLOAD_URL, filePath);
  await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("archive");
  if (process.platform !== "win32") {
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o666 & ~process.umask());
  }
  expect(fetchMock).toHaveBeenCalledWith({
    url: "https://example.com/signal-cli.tgz",
    maxRedirects: 5,
    requireHttps: true,
    timeoutMs: 5 * 60_000,
    capture: false,
    auditContext: "signal-cli-install-archive",
  });
  expect(fetchResult.release).toHaveBeenCalledTimes(1);
});

it("preserves an existing destination without locking or consuming the response", async () => {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new Uint8Array([1, 2, 3]));
    controller.close();
  });
  const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
  const fetchResult = okDownloadResponse(body);
  await fs.writeFile(filePath, "keep this");
  await expect(downloadToFile(DOWNLOAD_URL, filePath)).rejects.toMatchObject({
    code: "already-exists",
  });
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe("keep this");
  expect(body.locked).toBe(false);
  expect(pull).not.toHaveBeenCalled();
  expect(fetchResult.release).toHaveBeenCalledOnce();
});

it("rejects declared archives above the download cap", async () => {
  const fetchResult = okDownloadResponse("archive", {
    headers: { "content-length": "268435457" },
  });
  await expectRejectedDownload("declared 268435457", fetchResult.release);
});

it("aborts streamed archives above the download cap and removes partial files", async () => {
  const body = createClosedChunkStream([new Uint8Array(6), Buffer.alloc(256 * 1024 * 1024)]);
  const fetchResult = okDownloadResponse(body);
  await expectRejectedDownload("268435456-byte download cap", fetchResult.release);
});
it.each([
  ["service unavailable", 503, "Failed to fetch release info (503)"],
  [
    JSON.stringify({ tag_name: "v0.14.6", assets: {} }),
    200,
    "Failed to parse signal-cli release info.",
  ],
] as const)("returns metadata error for %s", async (body, status, error) => {
  setProcessPlatform("linux", "x64");
  const { release } = okDownloadResponse(body, { status });
  expect(await installSignalCli(createRuntimeSpies())).toEqual({ ok: false, error });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it("bounds oversized GitHub release metadata and cancels the stream", async () => {
  setProcessPlatform("linux", "x64");
  const chunkSize = 1024 * 1024;
  const chunkCount = 20; // 20 MiB — over the 16 MiB cap
  const oversized = createStreamingResponse({
    status: 200,
    chunkCount,
    chunkSize,
    byte: 0,
    headers: { "Content-Type": "application/json" },
  });
  const releaseMock = vi.fn().mockResolvedValue(undefined);
  fetchMock.mockResolvedValue({ response: oversized.response, release: releaseMock });
  const result = await installSignalCli(createRuntimeSpies());
  expect(result).toEqual({ ok: false, error: "Failed to parse signal-cli release info." });
  expect(oversized.wasCanceled()).toBe(true);
  expect(oversized.getReadCount()).toBeLessThan(chunkCount);
  expect(releaseMock).toHaveBeenCalledTimes(1);
});

it("removes the download temp dir even when extraction fails", async () => {
  setProcessPlatform("linux", "x64");
  mockRelease("0.0.0-leak-test");
  okDownloadResponse("not-a-real-archive");
  const result = await installSignalCli(createRuntimeSpies());
  expect(result.ok).toBe(false);
  await expectTempDownloadDirMissing();
});

it("removes the download temp dir on the success path too", async () => {
  setProcessPlatform("linux", "x64");
  const archivePath = await archive("signal-cli-0.0.0-success-test", "#!/bin/sh\necho ok\n");
  const archiveBytes = await fs.readFile(archivePath);
  mockRelease("0.0.0-success-test");
  okDownloadResponse(archiveBytes);
  const result = await installSignalCli(createRuntimeSpies());
  expect(result).toMatchObject({ ok: true, version: "0.0.0-success-test" });
  if (!result.cliPath) {
    throw new Error("expected the installed signal-cli path");
  }
  expect(result.cliPath).toContain(`${path.sep}0.0.0-success-test${path.sep}`);
  const installedStat = await fs.stat(result.cliPath);
  await expect(fs.readFile(result.cliPath, "utf8")).resolves.toBe("#!/bin/sh\necho ok\n");
  expect(installedStat.isFile()).toBe(true);
  expect(installedStat.mode & 0o111).not.toBe(0);
  await expectTempDownloadDirMissing();
  expect(limits).toEqual([
    {
      maxArchiveBytes: 256 * 1024 * 1024,
      maxEntries: 32,
      maxEntryBytes: 384 * 1024 * 1024,
      maxExtractedBytes: 384 * 1024 * 1024,
    },
  ]);
});

it("skips malformed asset rows while retaining a valid download", async () => {
  setProcessPlatform("linux", "x64");
  mockRelease("0.0.0-download-failure-test", [
    null,
    { name: 42, browser_download_url: "https://example.com/wrong-name.tar.gz" },
    { name: "signal-cli-wrong-url.tar.gz", browser_download_url: false },
    NATIVE_ASSET,
  ]);
  fetchMock.mockRejectedValueOnce(new Error("download failed"));
  await expect(installSignalCli(createRuntimeSpies())).rejects.toThrow("download failed");
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ url: "https://example.com/linux-native.tar.gz" }),
  );
  await expectTempDownloadDirMissing();
});
it.each([
  { binaryDir: "bin", found: true },
  { binaryDir: path.join("libexec", "nested", "native", "bin"), found: false },
])("finds Homebrew binaries within four levels: $binaryDir", async ({ binaryDir, found }) => {
  setProcessPlatform("darwin", "arm64");
  const brewPrefix = workDir;
  await fs.mkdir(path.join(brewPrefix, binaryDir), { recursive: true });
  await fs.writeFile(path.join(brewPrefix, binaryDir, "signal-cli"), "");
  brewMock.mockReturnValue("/opt/homebrew/bin/brew");
  runMock
    .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: `${brewPrefix}\n`, stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: "signal-cli 0.14.5\n", stderr: "" });
  const result = await installSignalCli(createRuntimeSpies());
  expect(result).toEqual(
    found
      ? {
          ok: true,
          cliPath: path.join(brewPrefix, binaryDir, "signal-cli"),
          version: "0.14.5",
        }
      : { ok: false, error: "brew install succeeded but signal-cli binary was not found." },
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

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

const { extractMock, fetchMock, brewMock, runMock, downloads } = vi.hoisted(() => ({
  extractMock: vi.fn<typeof import("openclaw/plugin-sdk/setup-tools").extractArchive>(),
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
    extractArchive: extractMock.mockImplementation(actual.extractArchive),
    resolveBrewExecutable: brewMock,
  };
});

// mock-isolation: Inspect installer commands without executing host processes.
vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: runMock,
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>();
  const withTempDownloadPath: typeof actual.withTempDownloadPath = (params, run) =>
    actual.withTempDownloadPath(params, async (tmpPath) => {
      downloads.push(tmpPath);
      return await run(tmpPath);
    });
  return { ...actual, withTempDownloadPath };
});

const { downloadToFile, installSignalCli } = await import("./install-signal-cli.js");
const install = (platform: NodeJS.Platform = "linux", arch = "x64") => {
  setProcessPlatform(platform, arch);
  return installSignalCli(createRuntimeSpies());
};

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

function setProcessPlatform(platform: NodeJS.Platform, arch = "x64") {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-install-"));
  filePath = path.join(workDir, "signal-cli.tgz");
  extractMock.mockClear();
  for (const mock of [fetchMock, brewMock, runMock]) {
    mock.mockReset();
  }
  downloads.length = 0;
});

afterEach(async () => {
  setProcessPlatform(originalPlatform, originalArch);
  await fs.rm(workDir, { recursive: true, force: true });
});

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectTempDownloadDirMissing(): Promise<void> {
  expect(downloads).toHaveLength(1);
  await expectPathMissing(path.dirname(downloads[0]!));
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
  mockRelease("0.0.0", [
    { name: "signal-cli.tar.gz" },
    { browser_download_url: "https://example.com/file.tar.gz" },
    { name: "signal-cli.tgz.asc", browser_download_url: "https://example.com/signature" },
  ]);
  await expect(install()).resolves.toEqual({
    ok: false,
    error: "No compatible release asset found for this platform.",
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([
  ["linux", "arm64", expect.stringContaining("Install Homebrew")],
  ["win32", "x64", "Signal CLI auto-install is not supported on Windows yet."],
] as const)("does not fetch archives on %s/%s", async (platform, arch, error) => {
  brewMock.mockReturnValue(undefined);
  await expect(install(platform, arch)).resolves.toEqual({ ok: false, error });
  expect(fetchMock).not.toHaveBeenCalled();
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
    url: DOWNLOAD_URL,
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

it("releases non-success responses before rejecting", async () => {
  await expectRejectedDownload(
    "HTTP 503",
    okDownloadResponse("service unavailable", { status: 503 }).release,
  );
});
it("rejects declared archives above the download cap", async () => {
  const { release } = okDownloadResponse("archive", { headers: { "content-length": "268435457" } });
  await expectRejectedDownload("declared 268435457", release);
});
it("aborts streamed archives above the download cap and removes partial files", async () => {
  const body = createClosedChunkStream([new Uint8Array(6), Buffer.alloc(256 * 1024 * 1024)]);
  await expectRejectedDownload("268435456-byte download cap", okDownloadResponse(body).release);
});
it.each([
  ["service unavailable", 503, "Failed to fetch release info (503)"],
  [
    JSON.stringify({ tag_name: "v0.14.6", assets: {} }),
    200,
    "Failed to parse signal-cli release info.",
  ],
] as const)("returns metadata error for %s", async (body, status, error) => {
  const { release } = okDownloadResponse(body, { status });
  expect(await install()).toEqual({ ok: false, error });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});

it("bounds oversized GitHub release metadata and cancels the stream", async () => {
  const chunkCount = 20; // 20 MiB — over the 16 MiB cap
  const oversized = createStreamingResponse({
    status: 200,
    chunkCount,
    chunkSize: 1024 * 1024,
    byte: 0,
    headers: { "Content-Type": "application/json" },
  });
  const releaseMock = vi.fn().mockResolvedValue(undefined);
  fetchMock.mockResolvedValue({ response: oversized.response, release: releaseMock });
  expect(await install()).toEqual({ ok: false, error: "Failed to parse signal-cli release info." });
  expect(oversized.wasCanceled()).toBe(true);
  expect(oversized.getReadCount()).toBeLessThan(chunkCount);
  expect(releaseMock).toHaveBeenCalledTimes(1);
});

it("removes the download temp dir even when extraction fails", async () => {
  mockRelease("0.0.0-leak-test");
  okDownloadResponse("not-a-real-archive");
  expect((await install()).ok).toBe(false);
  await expectTempDownloadDirMissing();
});

it("removes the download temp dir on the success path too", async () => {
  const archivePath = await archive("signal-cli-0.0.0-success-test", "#!/bin/sh\necho ok\n");
  mockRelease("0.0.0-success-test");
  okDownloadResponse(await fs.readFile(archivePath));
  const result = await install();
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
  expect(extractMock.mock.calls.map(([params]) => params.limits)).toEqual([
    {
      maxArchiveBytes: 256 * 1024 * 1024,
      maxEntries: 32,
      maxEntryBytes: 384 * 1024 * 1024,
      maxExtractedBytes: 384 * 1024 * 1024,
    },
  ]);
});

it("skips malformed asset rows while retaining a valid download", async () => {
  mockRelease("0.0.0-download-failure-test", [
    null,
    { name: 42, browser_download_url: "https://example.com/wrong-name.tar.gz" },
    { name: "signal-cli-wrong-url.tar.gz", browser_download_url: false },
    NATIVE_ASSET,
  ]);
  fetchMock.mockRejectedValueOnce(new Error("download failed"));
  await expect(install()).rejects.toThrow("download failed");
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
  const binary = path.join(workDir, binaryDir, "signal-cli");
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, "");
  brewMock.mockReturnValue("/opt/homebrew/bin/brew");
  runMock
    .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: `${workDir}\n`, stderr: "" })
    .mockResolvedValueOnce({ code: 0, stdout: "signal-cli 0.14.5\n", stderr: "" });
  expect(await install("darwin", "arm64")).toEqual(
    found
      ? {
          ok: true,
          cliPath: binary,
          version: "0.14.5",
        }
      : { ok: false, error: "brew install succeeded but signal-cli binary was not found." },
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps the Homebrew error after long warnings", async () => {
  brewMock.mockReturnValue("/opt/homebrew/bin/brew");
  const stderr = `Warning: ${"w".repeat(300)}\nError: signal-cli: no bottle available!`;
  runMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr });
  expect(await install("darwin", "arm64")).toEqual({
    ok: false,
    error: `brew install signal-cli failed (exit 1): ...${"w".repeat(160)}\nError: signal-cli: no bottle available!`,
  });
});

it("redacts credentials before selecting the Homebrew error tail", async () => {
  brewMock.mockReturnValue("/opt/homebrew/bin/brew");
  const secret = "synthetic-brew-credential-".repeat(20);
  const stderr = `Warning: ${"w".repeat(300)}\ntoken=${secret}\nError: signal-cli: unavailable!`;
  runMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr });
  const result = await install("darwin", "arm64");
  expect(result.ok).toBe(false);
  expect(result.error).toContain("Error: signal-cli: unavailable!");
  expect(result.error).toContain("token=synthe…ial-");
  expect(result.error).not.toContain(secret.slice(-100));
});

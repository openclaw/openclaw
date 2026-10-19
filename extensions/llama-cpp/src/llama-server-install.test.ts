import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as fileDurability from "@openclaw/fs-safe/durability";
import JSZip from "jszip";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  extractWindowsVcRuntime: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
  resolveLlamaCppDataDir: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/durability")>()),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
vi.mock("./defaults.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./defaults.js")>()),
  resolveLlamaCppDataDir: mocks.resolveLlamaCppDataDir,
}));
vi.mock("./llama-server-vc-runtime.js", () => ({
  extractWindowsVcRuntime: mocks.extractWindowsVcRuntime,
}));

import {
  LLAMA_SERVER_BUILD,
  LLAMA_SERVER_COMMIT,
  resolveManagedLlamaServerPaths,
  selectLlamaServerAsset,
  type LlamaServerAsset,
} from "./llama-server-assets.js";
import {
  downloadVerifiedFile,
  ensureLlamaServerInstalled,
  sha256File,
  UnsupportedLlamaServerHostError,
} from "./llama-server-install.js";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;
const tempRoots: string[] = [];
const pinnedVersion = `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function mockCommand(
  run: (command: string, args: string[], options: { timeout?: number }) => string | Promise<string>,
) {
  mocks.execFile.mockImplementation(
    (
      command: string,
      args: string[],
      options: { timeout?: number },
      callback: (error: unknown, stdout: string, stderr: string) => void,
    ) => {
      void Promise.resolve()
        .then(() => run(command, args, options))
        .then(
          (output) => callback(null, output, ""),
          (error: unknown) => callback(error, "", ""),
        );
    },
  );
}

async function createRoot(prefix: string, canonical = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = canonical ? await fs.realpath(temporary) : temporary;
  tempRoots.push(root);
  mocks.resolveLlamaCppDataDir.mockReturnValue(root);
  return root;
}

function download(
  destination: string,
  payload: Buffer,
  options: Partial<Parameters<typeof downloadVerifiedFile>[0]> = {},
) {
  return downloadVerifiedFile({
    url: "https://downloads.example/model.gguf",
    destination,
    expectedSha256: digest(payload),
    ...options,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.execFile.mockReset();
  mocks.extractWindowsVcRuntime.mockReset();
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.resolveLlamaCppDataDir.mockReset();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createDestination(): Promise<{ destination: string; root: string }> {
  const root = await createRoot("llama-server-download-");
  return { destination: path.join(root, "model.gguf"), root };
}

async function createInstalledServer(): Promise<string> {
  await createRoot("llama-server-installed-");
  const asset = selectLlamaServerAsset();
  const { command } = resolveManagedLlamaServerPaths(asset);
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.writeFile(command, "");
  return command;
}

async function createCpuArchive() {
  const root = await createRoot("llama-cpu-install-", true);
  const source = selectLlamaServerAsset("win32", "arm64", { kind: "cpu" });
  const runtime = source.dependencies![0]!;
  if (runtime.archive !== "vc-redist") {
    throw new Error("expected the Windows CPU asset to use the Visual C++ redistributable");
  }
  const serverBytes = await new JSZip()
    .file(source.executable, "server")
    .generateAsync({ type: "nodebuffer" });
  const runtimeBytes = Buffer.from("verified Visual C++ runtime bundle");
  const asset: LlamaServerAsset = {
    ...source,
    sha256: digest(serverBytes),
    dependencies: [
      {
        ...runtime,
        sha256: digest(runtimeBytes),
        size: runtimeBytes.byteLength,
      },
    ],
  };
  mocks.extractWindowsVcRuntime.mockImplementation(
    async ({ asset: dependency, destDir }: { asset: typeof runtime; destDir: string }) => {
      for (const file of dependency.files) {
        await fs.writeFile(path.join(destDir, file.target), `runtime:${file.target}`);
      }
      return destDir;
    },
  );
  mocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => ({
    response: new Response(new Uint8Array(url === runtime.url ? runtimeBytes : serverBytes)),
    release: vi.fn(),
  }));
  return { root, asset, runtime };
}

function mockDownload(payload: Buffer): ReturnType<typeof vi.fn> {
  const release = vi.fn();
  mocks.fetchWithSsrFGuard.mockResolvedValue({
    response: new Response(new Uint8Array(payload), {
      headers: { "content-length": String(payload.byteLength) },
    }),
    release,
  });
  return release;
}

function injectFileHandle(customize: (handle: FileHandle) => void): void {
  const actualOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    customize(handle);
    return handle;
  });
}

function installWriteFileThroughWrite(handle: FileHandle): void {
  handle.writeFile = (async (data: string | NodeJS.ArrayBufferView) => {
    const buffer =
      typeof data === "string"
        ? Buffer.from(data)
        : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset);
      if (bytesWritten === 0) {
        throw new Error("injected zero-byte write");
      }
      offset += bytesWritten;
    }
  }) as typeof handle.writeFile;
}

describe("cached file integrity", () => {
  it("reuses unchanged verified bytes but detects replacement, edits, and deletion", async () => {
    const { destination } = await createDestination();
    const original = Buffer.from("GGUFverified");
    const expectedDigest = digest(original);
    await fs.writeFile(destination, original);
    const scans = vi.spyOn(fileDurability, "sha256File");

    expect(await sha256File(destination)).toBe(expectedDigest);
    expect(await sha256File(destination)).toBe(expectedDigest);
    expect(scans).toHaveBeenCalledTimes(1);
    // Preserve length and mtime: inode/ctime changes must still invalidate verification.
    const previous = await fs.stat(destination);
    const replacement = `${destination}.replacement`;
    await fs.writeFile(replacement, "GGUFcorrupt!");
    await fs.utimes(replacement, previous.atime, previous.mtime);
    await fs.rename(replacement, destination);
    expect(await sha256File(destination)).not.toBe(expectedDigest);
    await fs.writeFile(destination, original);
    expect(await sha256File(destination)).toBe(expectedDigest);
    await fs.rm(destination);
    await expect(sha256File(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(scans).toHaveBeenCalledTimes(3);
  });

  it.each(["replacement", "cancellation"] as const)(
    "does not retain a digest after %s during the scan",
    async (mode) => {
      const { destination } = await createDestination();
      const replacement = `${destination}.replacement`;
      await fs.writeFile(destination, Buffer.alloc(2 * 1024 * 1024, 1));
      await fs.writeFile(replacement, "replacement bytes");
      const controller = new AbortController();
      const hashFile = fileDurability.sha256File;
      vi.spyOn(fileDurability, "sha256File").mockImplementationOnce(async (...args) => {
        const hashed = hashFile(...args);
        if (mode === "cancellation") {
          controller.abort();
        } else {
          nodeFs.renameSync(replacement, destination);
        }
        return await hashed;
      });
      await expect(sha256File(destination, controller.signal)).rejects.toThrow(
        mode === "cancellation" ? /abort/iu : "File changed during integrity verification",
      );
      vi.restoreAllMocks();
      const actual = digest(await fs.readFile(destination));
      expect(await sha256File(destination)).toBe(actual);
    },
  );

  it("reuses the download's verified publication without reading it again", async () => {
    const { destination } = await createDestination();
    const payload = Buffer.from("GGUFdownload");
    mockDownload(payload);
    await download(destination, payload);
    const scan = vi.spyOn(fileDurability, "sha256File");
    const opened = vi.spyOn(fs, "open");
    expect(await sha256File(destination)).toBe(digest(payload));
    expect(scan).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("downloadVerifiedFile", () => {
  it.each(["partial", "unavailable", "cancelled"] as const)(
    "preserves the previous artifact and removes partial bytes after %s, then permits retry",
    async (outcome) => {
      const { destination, root } = await createDestination();
      const previous = "GGUFprevious";
      const payload = Buffer.from("GGUFprojector");
      await fs.writeFile(destination, previous);
      const controller = new AbortController();
      const release = mockDownload(outcome === "partial" ? payload.subarray(0, 4) : payload);
      if (outcome === "unavailable") {
        mocks.fetchWithSsrFGuard.mockResolvedValue({
          response: new Response(null, { status: 503 }),
          release,
        });
      }
      await expect(
        download(destination, payload, {
          url: "https://downloads.example/mmproj.gguf",
          expectedSize: payload.byteLength,
          signal: controller.signal,
          onProgress: () => {
            if (outcome === "cancelled") {
              controller.abort();
            }
          },
        }),
      ).rejects.toThrow(
        {
          partial: /size mismatch/u,
          unavailable: /HTTP 503/u,
          cancelled: /abort/iu,
        }[outcome],
      );
      expect(await fs.readFile(destination, "utf8")).toBe(previous);
      expect(await fs.readdir(root)).toEqual(["model.gguf"]);
      expect(release).toHaveBeenCalledOnce();
      expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );

      mockDownload(payload);
      await download(destination, payload, {
        url: "https://downloads.example/mmproj.gguf",
        expectedSize: payload.byteLength,
      });
      expect(await fs.readFile(destination)).toEqual(payload);
      expect(await fs.readdir(root)).toEqual(["model.gguf"]);
    },
  );

  it("counts every persisted byte across shared clock ticks after an established sample", async () => {
    const times = [1010, 1010, 1030];
    const { destination } = await createDestination();
    const chunks = [1, 2, 3].map((value) => Buffer.alloc(1_000_000, value));
    const payload = Buffer.concat(chunks);
    const release = vi.fn();
    mocks.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
      ),
      release,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    let written = 0;
    injectFileHandle((handle) => {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...args) => {
        await writeFile(...args);
        clock.mockReturnValue(times[written++]!);
      };
    });
    const onProgress = vi.fn();

    await download(destination, payload, {
      expectedSize: payload.byteLength,
      onProgress,
    });

    expect(onProgress.mock.calls.map(([progress]) => progress.bytesPerSecond)).toEqual([
      100_000_000, 100_000_000, 100_000_000,
    ]);
    expect(onProgress.mock.calls.map(([progress]) => progress.downloadedSize)).toEqual([
      1_000_000, 2_000_000, 3_000_000,
    ]);
    assert.deepStrictEqual(await fs.readFile(destination), payload);
    expect(release).toHaveBeenCalledOnce();
  });

  it("persists complete chunks before reporting progress under positive short writes", async () => {
    const payload = Buffer.from("short writes must not truncate verified downloads");
    const { destination, root } = await createDestination();
    const release = mockDownload(payload);
    const onProgress = vi.fn();
    const writes: number[] = [];
    injectFileHandle((handle) => {
      const actualWrite = handle.write.bind(handle);
      let firstWrite = true;
      handle.write = (async (
        buffer: Uint8Array,
        offset?: number | null,
        length?: number | null,
        position?: number | null,
      ) => {
        const start = offset ?? 0;
        const requested = length ?? buffer.byteLength - start;
        const result = await actualWrite(
          buffer,
          start,
          firstWrite ? Math.min(7, requested) : requested,
          position,
        );
        firstWrite = false;
        writes.push(result.bytesWritten);
        return result;
      }) as typeof handle.write;
      installWriteFileThroughWrite(handle);
    });

    await download(destination, payload, {
      expectedSize: payload.byteLength,
      onProgress,
    });

    expect(await fs.readFile(destination)).toEqual(payload);
    expect(writes[0]).toBe(7);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.reduce((total, size) => total + size, 0)).toBe(payload.byteLength);
    const published = await fs.stat(destination);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ downloadedSize: published.size, totalSize: payload.byteLength }),
    );
    if (process.platform !== "win32") {
      expect(published.mode & 0o777).toBe(0o600);
    }
    expect(release).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual(["model.gguf"]);
  });
});

describe("ensureLlamaServerInstalled", () => {
  it("cancels a queued setup without cancelling another installation or poisoning reuse", async () => {
    const command = await createInstalledServer();
    const started = createDeferred<void>();
    const versionReply = createDeferred<string>();
    mockCommand((file) => {
      // macOS hosts probe the product version first; hold only the server probe.
      if (file === "/usr/bin/sw_vers") {
        return "26.0\n";
      }
      started.resolve();
      return versionReply.promise;
    });
    const first = ensureLlamaServerInstalled();
    await started.promise;
    const controller = new AbortController();
    const queued = ensureLlamaServerInstalled({ signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    versionReply.resolve(`${pinnedVersion}\nbuilt with test compiler`);
    await expect(first).resolves.toMatchObject({ command });
    await expect(ensureLlamaServerInstalled()).resolves.toMatchObject({ command });
    expect(mocks.execFile.mock.calls.filter(([file]) => file === command)).toHaveLength(2);
  });

  it("allows slow version initialization during staging and on reuse", async () => {
    const { root, asset, runtime } = await createCpuArchive();
    const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    mockCommand(async (command, args, options) => {
      calls.push({ command, args, timeout: options.timeout });
      // Measured Metal initialization took 23 seconds even for an installed runtime.
      if (options.timeout !== undefined && options.timeout < 23_000) {
        throw Object.assign(new Error("version initialization timed out"), {
          cmd: [command, ...args].join(" "),
          killed: true,
          signal: "SIGTERM" as const,
        });
      }
      await Promise.all(
        runtime.files.map((file) => fs.stat(path.join(path.dirname(command), file.target))),
      );
      return pinnedVersion;
    });

    const { command } = resolveManagedLlamaServerPaths(asset);
    await expect(ensureLlamaServerInstalled({ asset })).resolves.toMatchObject({ command });
    await expect(ensureLlamaServerInstalled({ asset })).resolves.toMatchObject({ command });

    expect(
      calls.map((call) => ({
        published: call.command === command,
        args: call.args,
        timeout: call.timeout,
      })),
    ).toEqual(
      [false, false, true].map((published) => ({
        published,
        args: ["--version"],
        timeout: 120_000,
      })),
    );
    expect(await fs.readFile(command, "utf8")).toBe("server");
    for (const file of runtime.files) {
      expect(await fs.readFile(path.join(path.dirname(command), file.target), "utf8")).toBe(
        `runtime:${file.target}`,
      );
    }
    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ url: runtime.url }),
    );
    expect((await fs.readdir(root)).every((entry) => !entry.startsWith("."))).toBe(true);
  });

  it.each(["verified", "wrong-build"])(
    "does not fetch the VC runtime for a launchable %s CPU ZIP",
    async (build) => {
      const { root, asset, runtime } = await createCpuArchive();
      mockCommand(() =>
        build === "verified" ? pinnedVersion : "version: 0.1.0-dev (build 1, commit deadbeef0)",
      );
      const { command } = resolveManagedLlamaServerPaths(asset);
      const install = ensureLlamaServerInstalled({ asset });
      if (build === "verified") {
        await expect(install).resolves.toMatchObject({ command });
        for (const file of runtime.files) {
          await expect(
            fs.stat(path.join(path.dirname(command), file.target)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await fs.readFile(command, "utf8")).toBe("server");
        expect((await fs.readdir(root)).every((entry) => !entry.startsWith("."))).toBe(true);
      } else {
        await expect(install).rejects.toThrow(
          `expected b${LLAMA_SERVER_BUILD} (${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
        );
        expect(await fs.readdir(root)).toEqual([]);
      }
      expect(mocks.extractWindowsVcRuntime).not.toHaveBeenCalled();
      expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: runtime.url }),
      );
    },
  );

  it("preserves both launch errors when the VC runtime fallback cannot start the server", async () => {
    const { root, asset } = await createCpuArchive();
    let attempt = 0;
    mockCommand((command) => {
      const detail = attempt++ === 0 ? "initial launch failed" : "fallback launch failed";
      throw Object.assign(new Error(detail), { cmd: `${command} --version` });
    });

    await expect(ensureLlamaServerInstalled({ asset })).rejects.toThrow(
      /Initial startup detail: .*initial launch failed.*Fallback detail: .*fallback launch failed/u,
    );
    expect(mocks.extractWindowsVcRuntime).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("aborts fresh validation and removes the unpublished CPU ZIP files", async () => {
    const { root, asset } = await createCpuArchive();
    const controller = new AbortController();
    const timeouts: Array<number | undefined> = [];
    mockCommand((command, _args, options) => {
      timeouts.push(options.timeout);
      controller.abort();
      throw Object.assign(new Error("The operation was aborted"), { cmd: `${command} --version` });
    });

    const { command } = resolveManagedLlamaServerPaths(asset);
    await expect(
      ensureLlamaServerInstalled({ asset, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(timeouts).toEqual([120_000]);
    await expect(fs.stat(command)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["ready", "corrupt-runtime", "missing-runtime", "no-device"] as const)(
    "publishes the complete CUDA installation only after verification: %s",
    async (outcome) => {
      const root = await createRoot("llama-cuda-install-", true);
      const source = selectLlamaServerAsset("win32", "x64", {
        kind: "cuda",
        devices: [{ driverVersion: "551.78", computeCapability: 8.6 }],
      });
      const runtime = source.dependencies![0]!;
      if (runtime.archive === "vc-redist") {
        throw new Error("expected the CUDA dependency archive before the Visual C++ runtime");
      }
      const vcRuntime = source.dependencies![1]!;
      if (vcRuntime.archive !== "vc-redist") {
        throw new Error("expected the CUDA asset to include the Visual C++ runtime");
      }
      const serverZip = new JSZip()
        .file(source.executable, "server")
        .file("ggml-cuda.dll", "backend");
      const runtimeZip = new JSZip();
      for (const file of runtime.files) {
        if (outcome !== "missing-runtime" || file !== "cudart64_12.dll") {
          runtimeZip.file(file, `runtime:${file}`);
        }
      }
      const serverBytes = await serverZip.generateAsync({ type: "nodebuffer" });
      const runtimeBytes = await runtimeZip.generateAsync({ type: "nodebuffer" });
      const asset: LlamaServerAsset = {
        ...source,
        sha256: digest(serverBytes),
        dependencies: [
          {
            ...runtime,
            sha256: outcome === "corrupt-runtime" ? "0".repeat(64) : digest(runtimeBytes),
          },
          ...(outcome === "no-device" ? [vcRuntime] : []),
        ],
      };
      const controller = new AbortController();
      const release = vi.fn();
      mocks.fetchWithSsrFGuard.mockImplementation(async ({ url }: { url: string }) => {
        const payload = url.endsWith(runtime.name) ? runtimeBytes : serverBytes;
        return { response: new Response(new Uint8Array(payload)), release };
      });
      const validatedFiles: string[][] = [];
      const commandCalls: Array<{ args: string[]; timeout?: number }> = [];
      mockCommand(async (command, args, options) => {
        commandCalls.push({ args, timeout: options.timeout });
        validatedFiles.push(await fs.readdir(path.dirname(command)));
        return args[0] === "--version"
          ? pinnedVersion
          : outcome === "no-device"
            ? "Available devices:\n  (none)"
            : "Available devices:\n  CUDA0: Test GPU (12288 MiB, 11264 MiB free)";
      });
      const result = ensureLlamaServerInstalled({
        asset,
        signal: controller.signal,
      });
      const { command, installDir } = resolveManagedLlamaServerPaths(asset);
      if (outcome === "ready") {
        await expect(result).resolves.toMatchObject({ command, asset: { backend: "cuda" } });
        for (const file of runtime.files) {
          expect(await fs.readFile(path.join(installDir, file), "utf8")).toBe(`runtime:${file}`);
        }
        expect(validatedFiles.length).toBeGreaterThan(0);
        expect(
          validatedFiles.every((files) => runtime.files.every((file) => files.includes(file))),
        ).toBe(true);
        expect(commandCalls).toEqual([
          { args: ["--version"], timeout: 120_000 },
          { args: ["--list-devices"], timeout: 15_000 },
        ]);
      } else {
        const expected = {
          "corrupt-runtime": /SHA-256 mismatch/u,
          "missing-runtime": /regular file cudart64_12\.dll/u,
          "no-device": /could not initialize an NVIDIA CUDA device/u,
        }[outcome];
        await expect(result).rejects.toThrow(expected);
        await expect(fs.stat(command)).rejects.toMatchObject({ code: "ENOENT" });
        if (outcome === "no-device") {
          expect(commandCalls).toEqual([
            { args: ["--version"], timeout: 120_000 },
            { args: ["--list-devices"], timeout: 15_000 },
          ]);
          expect(mocks.extractWindowsVcRuntime).not.toHaveBeenCalled();
          expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalledWith(
            expect.objectContaining({ url: vcRuntime.url }),
          );
        } else {
          expect(commandCalls).toEqual([]);
        }
      }
      expect((await fs.readdir(root)).every((entry) => !entry.startsWith("."))).toBe(true);
      expect(
        mocks.fetchWithSsrFGuard.mock.calls.every(([request]) => !request.url.includes("win-cpu")),
      ).toBe(true);
    },
  );
});

describe("macOS runtime floor", () => {
  it.each([
    ["12.7.6", "none"],
    ["12.7.6", "valid"],
    ["12.7.6", "crashes"],
    [Object.assign(new Error("sw_vers unavailable"), { cmd: "sw_vers" }), "crashes"],
    ["13.3", "crashes"],
  ] as const)(
    "preserves the runtime-floor/launch distinction on macOS %s with %s installation",
    async (productVersion, installed) => {
      await createRoot("llama-server-macos-");
      const asset = selectLlamaServerAsset("darwin", "x64", { kind: "cpu" });
      const { command } = resolveManagedLlamaServerPaths(asset);
      if (installed !== "none") {
        await fs.mkdir(path.dirname(command), { recursive: true });
        await fs.writeFile(command, "");
      }
      mockCommand((file) => {
        if (file !== "/usr/bin/sw_vers") {
          if (installed === "crashes") {
            throw Object.assign(new Error("dyld: Symbol not found: _cblas_sgemm$NEWLAPACK$ILP64"), {
              cmd: "llama-server --version",
            });
          }
          return pinnedVersion;
        } else if (typeof productVersion !== "string") {
          throw productVersion;
        } else {
          return `${productVersion}\n`;
        }
      });
      const install = ensureLlamaServerInstalled({ asset });
      if (installed === "valid") {
        await expect(install).resolves.toMatchObject({ command });
      } else if (productVersion === "12.7.6") {
        await expect(install).rejects.toBeInstanceOf(UnsupportedLlamaServerHostError);
        if (installed === "none") {
          await expect(install).rejects.toThrow(
            "requires macOS 13.3+; this Mac runs macOS 12.7.6. Build llama-server for this Mac and set models.providers.llama-cpp.localService.command",
          );
        } else {
          await expect(install).rejects.toMatchObject({
            message: expect.stringContaining("requires macOS 13.3+"),
            cause: expect.objectContaining({ message: expect.stringContaining("dyld") }),
          });
        }
      } else {
        await expect(install).rejects.not.toBeInstanceOf(UnsupportedLlamaServerHostError);
        await expect(install).rejects.toThrow("dyld");
      }
      expect(mocks.execFile.mock.calls.map(([file]) => file)).toEqual(
        installed === "none"
          ? ["/usr/bin/sw_vers"]
          : installed === "valid"
            ? [command]
            : [command, "/usr/bin/sw_vers"],
      );
      expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    },
  );
});

describe("CUDA runtime selection", () => {
  it("checks the upstream driver and device contract", () => {
    expect(() =>
      selectLlamaServerAsset("win32", "x64", {
        kind: "cuda",
        devices: [{ driverVersion: "551.77", computeCapability: 8.6 }],
      }),
    ).toThrow(/driver 551\.78/u);
  });

  it("does not silently replace unavailable CUDA on Windows arm64 with CPU", () => {
    expect(() =>
      selectLlamaServerAsset("win32", "arm64", {
        kind: "cuda",
        devices: [{ driverVersion: "580.1" }],
      }),
    ).toThrow(/No verified CUDA/u);
  });
});

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
} from "./llama-server-install.js";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

const tempRoots: string[] = [];
const versionOutput = `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`;

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-download-"));
  tempRoots.push(root);
  return { destination: path.join(root, "model.gguf"), root };
}

async function createInstalledServer(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-installed-"));
  tempRoots.push(root);
  mocks.resolveLlamaCppDataDir.mockReturnValue(root);
  const asset = selectLlamaServerAsset();
  const { command } = resolveManagedLlamaServerPaths(asset);
  await fs.mkdir(path.dirname(command), { recursive: true });
  await fs.writeFile(command, "");
  return command;
}

async function createCpuArchive(arch: "arm64" | "x64" = "arm64") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-cpu-install-")));
  tempRoots.push(root);
  mocks.resolveLlamaCppDataDir.mockReturnValue(root);
  const source = selectLlamaServerAsset("win32", arch, { kind: "cpu" });
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
    sha256: createHash("sha256").update(serverBytes).digest("hex"),
    dependencies: [
      {
        ...runtime,
        sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
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

function mockServerCommand(
  run: (command: string, args: string[], options: { timeout?: number }) => string | Promise<string>,
): void {
  mocks.execFile.mockImplementation(
    (
      command: string,
      args: string[],
      options: { timeout?: number },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      void Promise.resolve()
        .then(() => run(command, args, options))
        .then(
          (output) => callback(null, output, ""),
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error(String(error)), "", ""),
        );
    },
  );
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
    const digest = createHash("sha256").update(original).digest("hex");
    await fs.writeFile(destination, original);
    const scans = vi.spyOn(fileDurability, "sha256File");

    expect(await sha256File(destination)).toBe(digest);
    expect(await sha256File(destination)).toBe(digest);
    expect(scans).toHaveBeenCalledTimes(1);
    // Preserve length and mtime: inode/ctime changes must still invalidate verification.
    const previous = await fs.stat(destination);
    const replacement = `${destination}.replacement`;
    await fs.writeFile(replacement, "GGUFcorrupt!");
    await fs.utimes(replacement, previous.atime, previous.mtime);
    await fs.rename(replacement, destination);
    expect(await sha256File(destination)).not.toBe(digest);
    await fs.writeFile(destination, original);
    expect(await sha256File(destination)).toBe(digest);
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
      const actual = createHash("sha256")
        .update(await fs.readFile(destination))
        .digest("hex");
      expect(await sha256File(destination)).toBe(actual);
    },
  );
});

describe("downloadVerifiedFile", () => {
  it("counts same-tick bytes before and after establishing the download rate", async () => {
    const times = [1000, 1000, 1010, 1010, 1030];
    const { destination } = await createDestination();
    const chunks = [1, 2, 3, 4, 5].map((value) => Buffer.alloc(100, value));
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

    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSize: payload.byteLength,
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
      onProgress,
    });

    expect(onProgress.mock.calls.map(([progress]) => progress.bytesPerSecond)).toEqual([
      0, 0, 30_000, 30_000, 25_000,
    ]);
    expect(onProgress.mock.calls.map(([progress]) => progress.downloadedSize)).toEqual([
      100, 200, 300, 400, 500,
    ]);
    assert.deepStrictEqual(await fs.readFile(destination), payload);
    expect(release).toHaveBeenCalledOnce();
  });

  it("publishes and reuses fully persisted verified bytes under positive short writes", async () => {
    const payload = Buffer.from("short writes must not truncate verified downloads");
    const digest = createHash("sha256").update(payload).digest("hex");
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

    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSha256: digest,
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
    const scan = vi.spyOn(fileDurability, "sha256File");
    const opened = vi.spyOn(fs, "open").mockClear();
    expect(await sha256File(destination)).toBe(digest);
    expect(scan).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  it("keeps the destination absent and removes the partial file after a write failure", async () => {
    const payload = Buffer.from("a download that cannot be persisted");
    const { destination, root } = await createDestination();
    const release = mockDownload(payload);
    injectFileHandle((handle) => {
      handle.write = vi.fn(async () => {
        throw new Error("injected write failure");
      }) as typeof handle.write;
      installWriteFileThroughWrite(handle);
    });

    await expect(
      downloadVerifiedFile({
        url: "https://downloads.example/model.gguf",
        destination,
        expectedSha256: createHash("sha256").update(payload).digest("hex"),
        expectedSize: payload.byteLength,
      }),
    ).rejects.toThrow("injected write failure");
    await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("ensureLlamaServerInstalled", () => {
  it("cancels a queued setup without cancelling another installation or poisoning reuse", async () => {
    const command = await createInstalledServer();
    const started = createDeferred<void>();
    const versionReply = createDeferred<string>();
    mockServerCommand(() => {
      started.resolve();
      return versionReply.promise;
    });
    const first = ensureLlamaServerInstalled();
    await started.promise;
    const controller = new AbortController();
    const queued = ensureLlamaServerInstalled({ signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    versionReply.resolve(`${versionOutput}\nbuilt with test compiler`);
    await expect(first).resolves.toMatchObject({ command });
    await expect(ensureLlamaServerInstalled()).resolves.toMatchObject({ command });
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it("stages the app-local VC runtime only after the fresh CPU ZIP cannot start", async () => {
    const { root, asset, runtime } = await createCpuArchive("x64");
    const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    mockServerCommand(async (command, args, options) => {
      calls.push({ command, args, timeout: options.timeout });
      await Promise.all(
        runtime.files.map((file) => fs.stat(path.join(path.dirname(command), file.target))),
      );
      return versionOutput;
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
    ).toEqual([
      { published: false, args: ["--version"], timeout: 120_000 },
      { published: false, args: ["--version"], timeout: 120_000 },
      { published: true, args: ["--version"], timeout: 15_000 },
      { published: true, args: ["--version"], timeout: 15_000 },
    ]);
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

  it("does not fetch the VC runtime when the fresh CPU ZIP already starts", async () => {
    const { root, asset, runtime } = await createCpuArchive();
    mockServerCommand(() => versionOutput);

    const { command } = resolveManagedLlamaServerPaths(asset);
    await expect(ensureLlamaServerInstalled({ asset })).resolves.toMatchObject({ command });

    expect(mocks.extractWindowsVcRuntime).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: runtime.url }),
    );
    for (const file of runtime.files) {
      await expect(fs.stat(path.join(path.dirname(command), file.target))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(await fs.readFile(command, "utf8")).toBe("server");
    expect((await fs.readdir(root)).every((entry) => !entry.startsWith("."))).toBe(true);
  });

  it("rejects a different build despite a pinned-build note without fetching the VC runtime", async () => {
    const { root, asset, runtime } = await createCpuArchive();
    mockServerCommand(
      () => `version: 0.1.0-dev (build 1, commit deadbeef0)\ncompatibility note: ${versionOutput}`,
    );

    await expect(ensureLlamaServerInstalled({ asset })).rejects.toThrow(
      `expected b${LLAMA_SERVER_BUILD} (${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
    );

    expect(mocks.extractWindowsVcRuntime).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: runtime.url }),
    );
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("preserves both launch errors when the VC runtime fallback cannot start the server", async () => {
    const { root, asset } = await createCpuArchive();
    let attempt = 0;
    mockServerCommand(() => {
      throw new Error(attempt++ === 0 ? "initial launch failed" : "fallback launch failed");
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
    mockServerCommand((_command, _args, options) => {
      timeouts.push(options.timeout);
      controller.abort();
      throw new Error("The operation was aborted");
    });

    const { command } = resolveManagedLlamaServerPaths(asset);
    await expect(
      ensureLlamaServerInstalled({ asset, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(timeouts).toEqual([120_000]);
    await expect(fs.stat(command)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["ready", "corrupt-runtime", "missing-runtime", "no-device", "cancelled"] as const)(
    "publishes the complete CUDA installation only after verification: %s",
    async (outcome) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "llama-cuda-install-")),
      );
      tempRoots.push(root);
      mocks.resolveLlamaCppDataDir.mockReturnValue(root);
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
        sha256: createHash("sha256").update(serverBytes).digest("hex"),
        dependencies: [
          {
            ...runtime,
            sha256:
              outcome === "corrupt-runtime"
                ? "0".repeat(64)
                : createHash("sha256").update(runtimeBytes).digest("hex"),
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
      mockServerCommand(async (command, args, options) => {
        commandCalls.push({ args, timeout: options.timeout });
        validatedFiles.push(await fs.readdir(path.dirname(command)));
        return args[0] === "--version"
          ? versionOutput
          : outcome === "no-device"
            ? "Available devices:\n  (none)"
            : "Available devices:\n  CUDA0: Test GPU (12288 MiB, 11264 MiB free)";
      });
      const result = ensureLlamaServerInstalled({
        asset,
        signal: controller.signal,
        onProgress: () => {
          if (outcome === "cancelled") {
            controller.abort();
          }
        },
      });
      const { command, installDir } = resolveManagedLlamaServerPaths(asset);
      if (outcome === "ready") {
        await expect(result).resolves.toMatchObject({ command, asset: { backend: "cuda" } });
        expect(command).not.toBe(
          resolveManagedLlamaServerPaths(selectLlamaServerAsset("win32", "x64")).command,
        );
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
          { args: ["--version"], timeout: 15_000 },
          { args: ["--list-devices"], timeout: 15_000 },
        ]);
      } else {
        const expected = {
          "corrupt-runtime": /SHA-256 mismatch/u,
          "missing-runtime": /regular file cudart64_12\.dll/u,
          "no-device": /could not initialize an NVIDIA CUDA device/u,
          cancelled: /abort/iu,
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

describe("CUDA runtime selection", () => {
  it.each([
    ["551.77", 8.6],
    ["535.1", 8.6],
    ["unknown", 8.6],
    ["580.1", 3.5],
  ] as const)(
    "checks the upstream driver and device contract for %s / SM %s",
    (driverVersion, computeCapability) => {
      expect(() =>
        selectLlamaServerAsset("win32", "x64", {
          kind: "cuda",
          devices: [{ driverVersion, computeCapability }],
        }),
      ).toThrow(/driver 551\.78/u);
    },
  );

  it.each(["linux", "win32"] as const)(
    "does not silently replace unavailable CUDA on %s/arm64 with CPU",
    (platform) => {
      expect(() =>
        selectLlamaServerAsset(platform, "arm64", {
          kind: "cuda",
          devices: [{ driverVersion: "580.1" }],
        }),
      ).toThrow(/No verified CUDA/u);
    },
  );
});

import assert from "node:assert/strict";
import type { ExecFileException } from "node:child_process";
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

async function createCpuArchive() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-cpu-install-")));
  tempRoots.push(root);
  mocks.resolveLlamaCppDataDir.mockReturnValue(root);
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

function mockVersionOutput(output: string): void {
  mocks.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, output, "");
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

  it("reuses the download's verified publication without reading it again", async () => {
    const { destination } = await createDestination();
    const payload = Buffer.from("GGUFdownload");
    const digest = createHash("sha256").update(payload).digest("hex");
    mockDownload(payload);
    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSha256: digest,
    });
    const scan = vi.spyOn(fileDurability, "sha256File");
    const opened = vi.spyOn(fs, "open");
    expect(await sha256File(destination)).toBe(digest);
    expect(scan).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });
});

describe("downloadVerifiedFile", () => {
  it.each([
    { label: "shared clock ticks", times: [1000, 1000, 1010], rates: [0, 0, 300_000_000] },
    {
      label: "shared clock ticks after an established sample",
      times: [1010, 1010, 1030],
      rates: [100_000_000, 100_000_000, 100_000_000],
    },
    {
      label: "distinct clock ticks",
      times: [1010, 1020, 1030],
      rates: [100_000_000, 100_000_000, 100_000_000],
    },
  ])("counts every persisted byte in the rate across $label", async ({ times, rates }) => {
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

    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSize: payload.byteLength,
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
      onProgress,
    });

    expect(onProgress.mock.calls.map(([progress]) => progress.bytesPerSecond)).toEqual(rates);
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

    await downloadVerifiedFile({
      url: "https://downloads.example/model.gguf",
      destination,
      expectedSha256: createHash("sha256").update(payload).digest("hex"),
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
    mocks.execFile.mockImplementation(
      (
        file: string,
        _args: string[],
        _options: unknown,
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        // macOS hosts probe the product version first; hold only the server probe.
        if (file === "/usr/bin/sw_vers") {
          callback(null, "26.0\n", "");
          return;
        }
        started.resolve();
        void versionReply.promise.then((output) => callback(null, output, ""));
      },
    );
    const first = ensureLlamaServerInstalled();
    await started.promise;
    const controller = new AbortController();
    const queued = ensureLlamaServerInstalled({ signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    versionReply.resolve(
      `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})\nbuilt with test compiler`,
    );
    await expect(first).resolves.toMatchObject({ command });
    await expect(ensureLlamaServerInstalled()).resolves.toMatchObject({ command });
    expect(mocks.execFile.mock.calls.filter(([file]) => file === command)).toHaveLength(2);
  });

  it("rejects a different active build even when output mentions the pinned build later", async () => {
    await createInstalledServer();
    mockVersionOutput(
      `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD + 1}, commit deadbeef0)\ncompatibility note: (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
    );

    await expect(ensureLlamaServerInstalled()).rejects.toThrow(
      `expected b${LLAMA_SERVER_BUILD} (${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
    );
  });

  it("allows slow version initialization before publication, after publication, and on reuse", async () => {
    const { root, asset, runtime } = await createCpuArchive();
    const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    mocks.execFile.mockImplementation(
      (
        command: string,
        args: string[],
        options: { timeout?: number },
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        calls.push({ command, args, timeout: options.timeout });
        // Measured Metal initialization took 23 seconds even for an installed runtime.
        if (options.timeout !== undefined && options.timeout < 23_000) {
          callback(
            Object.assign(new Error("version initialization timed out"), {
              cmd: [command, ...args].join(" "),
              killed: true,
              signal: "SIGTERM" as const,
            }),
            "",
            "",
          );
          return;
        }
        void Promise.all(
          runtime.files.map((file) => fs.stat(path.join(path.dirname(command), file.target))),
        )
          .then(() => {
            callback(
              null,
              `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
              "",
            );
          })
          .catch((error: unknown) => callback(error as ExecFileException, "", ""));
      },
    );

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
      { published: true, args: ["--version"], timeout: 120_000 },
      { published: true, args: ["--version"], timeout: 120_000 },
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
    mockVersionOutput(
      `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`,
    );

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

  it("does not fetch the VC runtime when the fresh CPU ZIP reports a different build", async () => {
    const { root, asset, runtime } = await createCpuArchive();
    mockVersionOutput("version: 0.1.0-dev (build 1, commit deadbeef0)");

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
    mocks.execFile.mockImplementation(
      (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        const detail = attempt++ === 0 ? "initial launch failed" : "fallback launch failed";
        const error = new Error(detail) as ExecFileException;
        error.cmd = `${command} --version`;
        callback(error, "", "");
      },
    );

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
    mocks.execFile.mockImplementation(
      (
        command: string,
        _args: string[],
        options: { timeout?: number },
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        timeouts.push(options.timeout);
        controller.abort();
        const error = new Error("The operation was aborted") as ExecFileException;
        error.cmd = `${command} --version`;
        callback(error, "", "");
      },
    );

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
      mocks.execFile.mockImplementation(
        (
          command: string,
          args: string[],
          options: { timeout?: number },
          callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
        ) => {
          commandCalls.push({ args, timeout: options.timeout });
          void fs.readdir(path.dirname(command)).then((files) => {
            validatedFiles.push(files);
            const stdout =
              args[0] === "--version"
                ? `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`
                : outcome === "no-device"
                  ? "Available devices:\n  (none)"
                  : "Available devices:\n  CUDA0: Test GPU (12288 MiB, 11264 MiB free)";
            callback(null, stdout, "");
          });
        },
      );
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
          { args: ["--version"], timeout: 120_000 },
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

describe("macOS runtime floor", () => {
  const pinnedVersion = `version: 0.1.0-dev (build ${LLAMA_SERVER_BUILD}, commit ${LLAMA_SERVER_COMMIT.slice(0, 9)})`;
  const dyldFailure = Object.assign(
    new Error("dyld: Symbol not found: _cblas_sgemm$NEWLAPACK$ILP64"),
    {
      cmd: "llama-server --version",
    },
  );

  async function prepareMac(
    productVersion: string | ExecFileException,
    installed: "none" | "valid" | "crashes",
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-server-macos-"));
    tempRoots.push(root);
    mocks.resolveLlamaCppDataDir.mockReturnValue(root);
    const asset = selectLlamaServerAsset("darwin", "x64", { kind: "cpu" });
    const { command } = resolveManagedLlamaServerPaths(asset);
    if (installed !== "none") {
      await fs.mkdir(path.dirname(command), { recursive: true });
      await fs.writeFile(command, "");
    }
    mocks.execFile.mockImplementation(
      (
        file: string,
        _args: string[],
        _options: unknown,
        callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
      ) => {
        if (file !== "/usr/bin/sw_vers") {
          callback(installed === "crashes" ? dyldFailure : null, pinnedVersion, "");
        } else if (typeof productVersion !== "string") {
          callback(productVersion, "", "");
        } else {
          callback(null, `${productVersion}\n`, "");
        }
      },
    );
    return { asset, command };
  }

  it("refuses macOS below 13.3 before downloading the verified build", async () => {
    const { asset } = await prepareMac("12.7.6", "none");

    const install = ensureLlamaServerInstalled({ asset });
    await expect(install).rejects.toBeInstanceOf(UnsupportedLlamaServerHostError);
    await expect(install).rejects.toThrow(
      "requires macOS 13.3+; this Mac runs macOS 12.7.6. Build llama-server for this Mac and set models.providers.llama-cpp.localService.command",
    );
    expect(mocks.execFile.mock.calls.map(([file]) => file)).toEqual(["/usr/bin/sw_vers"]);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("reuses a validating build on macOS below 13.3", async () => {
    const { asset, command } = await prepareMac("12.7.6", "valid");

    await expect(ensureLlamaServerInstalled({ asset })).resolves.toMatchObject({ command });
    expect(mocks.execFile.mock.calls.map(([file]) => file)).toEqual([command]);
  });

  it("explains a build that cannot start on macOS below 13.3", async () => {
    const { asset } = await prepareMac("12.7.6", "crashes");

    const install = ensureLlamaServerInstalled({ asset });
    await expect(install).rejects.toBeInstanceOf(UnsupportedLlamaServerHostError);
    await expect(install).rejects.toMatchObject({
      message: expect.stringContaining("requires macOS 13.3+"),
      cause: expect.objectContaining({ message: expect.stringContaining("dyld") }),
    });
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each(["13.3", "26.0.1"])("keeps the verified build on macOS %s", async (productVersion) => {
    const { asset, command } = await prepareMac(productVersion, "valid");

    await expect(ensureLlamaServerInstalled({ asset })).resolves.toMatchObject({ command });
  });

  it("keeps the launch error when the macOS version cannot be read", async () => {
    const { asset, command } = await prepareMac(
      Object.assign(new Error("sw_vers unavailable"), { cmd: "sw_vers" }),
      "crashes",
    );

    const install = ensureLlamaServerInstalled({ asset });
    await expect(install).rejects.not.toBeInstanceOf(UnsupportedLlamaServerHostError);
    await expect(install).rejects.toThrow("dyld");
    expect(mocks.execFile.mock.calls.map(([file]) => file)).toEqual([command, "/usr/bin/sw_vers"]);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("keeps the launch error for a build that cannot start on a supported Mac", async () => {
    const { asset } = await prepareMac("13.3", "crashes");

    const install = ensureLlamaServerInstalled({ asset });
    await expect(install).rejects.not.toBeInstanceOf(UnsupportedLlamaServerHostError);
    await expect(install).rejects.toThrow("dyld");
  });
});

describe("CUDA runtime selection", () => {
  it("pins the verified archives and extraction limit", () => {
    const asset = selectLlamaServerAsset("win32", "x64", {
      kind: "cuda",
      devices: [{ driverVersion: "551.78", computeCapability: 8.6 }],
    });
    const mebibyte = 1024 * 1024;

    expect(asset).toMatchObject({
      name: "llama-b10809-bin-win-cuda-12.4-x64.zip",
      sha256: "c77bfcd9ed8d91e8721a2d6a290b907fddd4fa5412a47b21c6fa1709116b85f9",
      limits: {
        maxArchiveBytes: 400 * mebibyte,
        maxExtractedBytes: 600 * mebibyte,
        maxEntryBytes: 521 * mebibyte,
      },
    });
    expect(asset.dependencies?.[0]).toMatchObject({
      name: "cudart-llama-bin-win-cuda-12.4-x64.zip",
      sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
      limits: { maxEntries: 3, maxEntryBytes: 521 * mebibyte },
    });
  });

  it.each([
    ["551.78", 5, true],
    ["580.1", 8.9, true],
    ["551.77", 8.6, false],
    ["535.1", 8.6, false],
    ["unknown", 8.6, false],
    ["580.1", 3.5, false],
  ] as const)(
    "checks the upstream driver and device contract for %s / SM %s",
    (driverVersion, computeCapability, supported) => {
      const choose = () =>
        selectLlamaServerAsset("win32", "x64", {
          kind: "cuda",
          devices: [{ driverVersion, computeCapability }],
        });
      if (supported) {
        mocks.resolveLlamaCppDataDir.mockReturnValue(os.tmpdir());
        const asset = choose();
        expect(asset.backend).toBe("cuda");
        expect(asset.dependencies?.[0]?.files).toContain("cudart64_12.dll");
        expect(resolveManagedLlamaServerPaths(asset).command).not.toBe(
          resolveManagedLlamaServerPaths(selectLlamaServerAsset("win32", "x64")).command,
        );
      } else {
        expect(choose).toThrow(/driver 551\.78/u);
      }
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

describe("Windows VC runtime selection", () => {
  it.each([
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ] as const)("does not add a VC runtime dependency on %s/%s", (platform, arch) => {
    const asset = selectLlamaServerAsset(platform, arch, { kind: "cpu" });

    expect(asset.dependencies?.some((dependency) => dependency.archive === "vc-redist")).not.toBe(
      true,
    );
  });

  it.each([
    [
      "arm64",
      "VC_redist.arm64.exe",
      "https://download.visualstudio.microsoft.com/download/pr/ece44298-3977-4f73-ab91-c13fe79cfea8/B70EF586669A620A0A30A1156969C05C6A3831DC8F8BC992DA75779D2A92F944/VC_redist.arm64.exe",
      "b70ef586669a620a0a30a1156969c05c6a3831dc8f8bc992da75779d2a92f944",
      11_870_816,
      684_112,
      11_176_508,
      "a1",
      [
        { source: "msvcp140.dll_arm64", target: "msvcp140.dll" },
        { source: "vcruntime140.dll_arm64", target: "vcruntime140.dll" },
      ],
    ],
    [
      "x64",
      "VC_redist.x64.exe",
      "https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe",
      "843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c",
      18_731_856,
      630_000,
      18_091_661,
      "a4",
      [
        { source: "msvcp140.dll_amd64", target: "msvcp140.dll" },
        { source: "vcruntime140.dll_amd64", target: "vcruntime140.dll" },
        { source: "vcruntime140_1.dll_amd64", target: "vcruntime140_1.dll" },
      ],
    ],
  ] as const)(
    "pins the Microsoft %s app-local runtime",
    (arch, name, url, sha256, size, containerOffset, containerSize, nestedCabinet, files) => {
      const asset = selectLlamaServerAsset("win32", arch, { kind: "cpu" });
      const runtime = asset.dependencies?.find((dependency) => dependency.archive === "vc-redist");

      expect(runtime).toEqual({
        archive: "vc-redist",
        name,
        url,
        sha256,
        size,
        containerOffset,
        containerSize,
        nestedCabinet,
        files,
      });
    },
  );

  it("stages the x64 runtime with the CUDA dependencies", () => {
    const asset = selectLlamaServerAsset("win32", "x64", {
      kind: "cuda",
      devices: [{ driverVersion: "551.78", computeCapability: 8.6 }],
    });

    expect(asset.dependencies?.some((dependency) => dependency.archive === "vc-redist")).toBe(true);
  });
});

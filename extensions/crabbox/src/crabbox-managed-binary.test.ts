import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { buildTimeoutAbortSignal, createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as network from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CRABBOX_MIN_VERSION,
  ensureManagedCrabboxBinary,
  probeCrabboxVersion,
  resolveManagedCrabboxBinaryPath,
} from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const runCommand: CrabboxCommandRunner = async ([binary]) => ({
  stdout: `crabbox version ${await fs.readFile(binary!, "utf8")}`,
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
});

async function fixture(version = "0.54.0") {
  const root = tempDirs.make("crabbox-managed-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const candidate = path.join(root, "operator-crabbox");
  await fs.writeFile(candidate, version);
  const binary = resolveManagedCrabboxBinaryPath(env);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const extension = platform === "windows" ? "zip" : "tar.gz";
  const asset = `crabbox_${CRABBOX_MIN_VERSION}_${platform}_${arch}.${extension}`;
  const files = { [path.basename(binary)]: CRABBOX_MIN_VERSION, "companion-helper": "keep me" };
  let archive: Buffer;
  if (platform === "windows") {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      zip.file(name, content);
    }
    archive = await zip.generateAsync({ type: "nodebuffer" });
  } else {
    const source = path.join(root, "source");
    await fs.mkdir(source);
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(source, name), content, { mode: 0o755 });
    }
    const archivePath = path.join(root, asset);
    await tar.c({ cwd: source, file: archivePath, gzip: true }, Object.keys(files));
    archive = await fs.readFile(archivePath);
  }
  const checksums = `${createHash("sha256").update(archive).digest("hex")}  ${asset}\n`;
  const fetch = vi.spyOn(network, "fetchWithSsrFGuard").mockImplementation(async ({ url }) => ({
    response: new Response(url.endsWith("/checksums.txt") ? checksums : new Uint8Array(archive)),
    finalUrl: url,
    release: async () => {},
  }));
  return { root, env, candidate, binary, asset, archive, checksums, fetch };
}

describe("managed Crabbox", () => {
  it.each(["0.55.0", "0.55.1", "1.0.0"])(
    "uses supported operator version %s without network or state mutation",
    async (version) => {
      const test = await fixture(version);
      await expect(
        ensureManagedCrabboxBinary({ binary: test.candidate, env: test.env, runCommand }),
      ).resolves.toBe(test.candidate);
      expect(test.fetch).not.toHaveBeenCalled();
      await expect(fs.access(test.env.OPENCLAW_STATE_DIR)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("upgrades an old candidate, preserves its complete distribution, and reuses it offline", async () => {
    const test = await fixture();
    const params = { binary: test.candidate, env: test.env, runCommand };
    await expect(ensureManagedCrabboxBinary(params)).resolves.toBe(test.binary);
    expect(await fs.readFile(test.candidate, "utf8")).toBe("0.54.0");
    expect(
      await fs.readFile(path.join(path.dirname(test.binary), "companion-helper"), "utf8"),
    ).toBe("keep me");
    if (process.platform !== "win32") {
      for (const name of [path.basename(test.binary), "companion-helper"]) {
        expect((await fs.stat(path.join(path.dirname(test.binary), name))).mode & 0o111).toBe(
          0o111,
        );
      }
    }
    test.fetch.mockRejectedValue(new Error("offline"));
    await expect(ensureManagedCrabboxBinary(params)).resolves.toBe(test.binary);
    expect(test.fetch).toHaveBeenCalledTimes(2);
    expect(await fs.readdir(path.dirname(path.dirname(test.binary)))).toEqual([
      path.basename(path.dirname(test.binary)),
    ]);
  });

  it("installs when the selected executable is missing", async () => {
    const test = await fixture();
    await fs.rm(test.candidate);
    await expect(
      ensureManagedCrabboxBinary({ binary: test.candidate, env: test.env, runCommand }),
    ).resolves.toBe(test.binary);
  });

  it("rejects mismatched archive bytes without publication and permits a later retry", async () => {
    const test = await fixture();
    const params = { binary: test.candidate, env: test.env, runCommand };
    test.fetch.mockResolvedValueOnce({
      response: new Response(`${"0".repeat(64)}  ${test.asset}\n`),
      finalUrl: "https://github.com",
      release: async () => {},
    });
    await expect(ensureManagedCrabboxBinary(params)).rejects.toThrow("checksum mismatch");
    expect(await fs.readdir(path.dirname(path.dirname(test.binary)))).toEqual([]);
    expect(await fs.readFile(test.candidate, "utf8")).toBe("0.54.0");
    await expect(ensureManagedCrabboxBinary(params)).resolves.toBe(test.binary);
  });

  it("rejects an executable whose version disagrees with the verified release", async () => {
    const test = await fixture();
    const staleRunner: CrabboxCommandRunner = async (argv, options) => ({
      ...(await runCommand(argv, options)),
      stdout: "crabbox version 0.54.0",
    });
    await expect(
      ensureManagedCrabboxBinary({
        binary: test.candidate,
        env: test.env,
        runCommand: staleRunner,
      }),
    ).rejects.toThrow("does not satisfy 0.55.0");
    expect(await fs.readdir(path.dirname(path.dirname(test.binary)))).toEqual([]);
  });

  it("shares an acquisition while cancellation only abandons the cancelling caller", async () => {
    const test = await fixture();
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    test.fetch.mockImplementationOnce(async ({ url }) => {
      started.resolve();
      await finish.promise;
      return { response: new Response(test.checksums), finalUrl: url, release: async () => {} };
    });
    const controller = new AbortController();
    const candidatesProbed = createDeferred<void>();
    let probes = 0;
    const synchronizedRunner: CrabboxCommandRunner = async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv[0] === test.candidate) {
        probes += 1;
        if (probes === 2) {
          candidatesProbed.resolve();
        }
        await candidatesProbed.promise;
      }
      return result;
    };
    const params = { binary: test.candidate, env: test.env, runCommand: synchronizedRunner };
    const cancelled = ensureManagedCrabboxBinary({ ...params, signal: controller.signal });
    const cancelledResult = expect(cancelled).rejects.toThrow("caller stopped");
    const retained = ensureManagedCrabboxBinary(params);
    await started.promise;
    controller.abort(new Error("caller stopped"));
    try {
      await cancelledResult;
      await expect(fs.access(test.binary)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finish.resolve();
      await retained;
    }
    await expect(retained).resolves.toBe(test.binary);
    expect(test.fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels an abandoned download, joins its cleanup, and can retry", async () => {
    const test = await fixture();
    const started = createDeferred<void>();
    test.fetch.mockImplementationOnce(async ({ signal }) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(toErrorObject(signal!.reason, "aborted")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    });
    const controller = new AbortController();
    const params = { binary: test.candidate, env: test.env, runCommand };
    const pending = ensureManagedCrabboxBinary({ ...params, signal: controller.signal });
    const result = expect(pending).rejects.toThrow("caller stopped");
    await started.promise;
    controller.abort(new Error("caller stopped"));
    await result;
    expect(await fs.readdir(path.dirname(path.dirname(test.binary)))).toEqual([]);
    await expect(ensureManagedCrabboxBinary(params)).resolves.toBe(test.binary);
  });

  it("uses another process's verified installation when it wins publication", async () => {
    const test = await fixture();
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === path.dirname(test.binary) && typeof source === "string") {
        await fs.cp(source, destination, { recursive: true });
        throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
      }
      await rename(source, destination);
    });
    await expect(
      ensureManagedCrabboxBinary({ binary: test.candidate, env: test.env, runCommand }),
    ).resolves.toBe(test.binary);
    expect(
      await fs.readFile(path.join(path.dirname(test.binary), "companion-helper"), "utf8"),
    ).toBe("keep me");
  });

  it.each(["missing", "0.54.0", "corrupt"])(
    "repairs a %s managed executable while preserving the previous directory",
    async (damage) => {
      const test = await fixture();
      const destination = path.dirname(test.binary);
      await fs.mkdir(destination, { recursive: true });
      if (damage !== "missing") {
        await fs.writeFile(test.binary, damage);
      }
      await fs.writeFile(path.join(destination, "operator-note"), "preserve this");
      await expect(
        ensureManagedCrabboxBinary({ binary: test.candidate, env: test.env, runCommand }),
      ).resolves.toBe(test.binary);
      expect(await fs.readFile(test.binary, "utf8")).toBe(CRABBOX_MIN_VERSION);
      expect(await fs.readFile(test.candidate, "utf8")).toBe("0.54.0");
      const parent = path.dirname(destination);
      const entries = await fs.readdir(parent);
      const backups = entries.filter((name) =>
        name.startsWith(`${path.basename(destination)}.recovery-`),
      );
      expect(backups).toHaveLength(1);
      expect(await fs.readFile(path.join(parent, backups[0]!, "operator-note"), "utf8")).toBe(
        "preserve this",
      );
      if (damage !== "missing") {
        expect(
          await fs.readFile(path.join(parent, backups[0]!, path.basename(test.binary)), "utf8"),
        ).toBe(damage);
      }
      expect(entries).toHaveLength(2);
    },
  );

  it("restores a damaged installation when verified publication fails", async () => {
    const test = await fixture();
    const destination = path.dirname(test.binary);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(test.binary, "corrupt");
    await fs.writeFile(path.join(destination, "operator-note"), "preserve this");
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (
        target === destination &&
        typeof source === "string" &&
        path.basename(source) === "distribution"
      ) {
        throw Object.assign(new Error("publication blocked"), { code: "EACCES" });
      }
      await rename(source, target);
    });
    await expect(
      ensureManagedCrabboxBinary({ binary: test.candidate, env: test.env, runCommand }),
    ).rejects.toThrow("publication blocked");
    expect(await fs.readFile(test.binary, "utf8")).toBe("corrupt");
    expect(await fs.readFile(path.join(destination, "operator-note"), "utf8")).toBe(
      "preserve this",
    );
    expect(await fs.readdir(path.dirname(destination))).toEqual([path.basename(destination)]);
  });

  it("preserves the recovered directory and published binary if staging cleanup fails", async () => {
    const test = await fixture();
    const destination = path.dirname(test.binary);
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(test.binary, "corrupt");
    const rm = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.basename(target).startsWith(".install-")) {
        throw Object.assign(new Error("cleanup blocked"), { code: "EACCES" });
      }
      await rm(target, options);
    });
    const params = { binary: test.candidate, env: test.env, runCommand };
    await expect(ensureManagedCrabboxBinary(params)).rejects.toThrow("cleanup blocked");
    expect(await fs.readFile(test.binary, "utf8")).toBe(CRABBOX_MIN_VERSION);
    const parent = path.dirname(destination);
    const backup = (await fs.readdir(parent)).find((name) =>
      name.startsWith(`${path.basename(destination)}.recovery-`),
    );
    expect(backup).toBeDefined();
    expect(await fs.readFile(path.join(parent, backup!, path.basename(test.binary)), "utf8")).toBe(
      "corrupt",
    );
    test.fetch.mockRejectedValue(new Error("offline"));
    await expect(ensureManagedCrabboxBinary(params)).resolves.toBe(test.binary);
  });

  it("refuses a symlinked managed directory without changing its target", async () => {
    const test = await fixture();
    const destination = path.dirname(test.binary);
    const external = path.join(test.root, "external");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, path.basename(test.binary)), "0.54.0");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.symlink(external, destination, process.platform === "win32" ? "junction" : "dir");
    await expect(
      ensureManagedCrabboxBinary({ binary: test.candidate, env: test.env, runCommand }),
    ).rejects.toThrow("must be a regular directory");
    expect(await fs.readFile(path.join(external, path.basename(test.binary)), "utf8")).toBe(
      "0.54.0",
    );
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { transfer: "progress", elapsedMs: 160_000, succeeds: true },
    { transfer: "stall", elapsedMs: 30_000, succeeds: false },
    { transfer: "trickle", elapsedMs: 600_000, succeeds: false },
  ] as const)(
    "bounds a $transfer download by progress and total duration",
    async ({ transfer, elapsedMs, succeeds }) => {
      const test = await fixture();
      const started = createDeferred<void>();
      test.fetch.mockImplementation(async ({ url, signal, timeoutMs }) => {
        if (url.endsWith("/checksums.txt")) {
          return { response: new Response(test.checksums), finalUrl: url, release: async () => {} };
        }
        // Retain the SDK's real deadline behavior while replacing only the HTTP transport.
        const deadline = buildTimeoutAbortSignal({ signal, timeoutMs });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let offset = 0;
        let abort: () => void = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            abort = () => {
              clearTimeout(timer);
              controller.error(deadline.signal?.reason);
            };
            deadline.signal?.addEventListener("abort", abort, { once: true });
            const next = () => {
              const size = transfer === "trickle" ? 1 : Math.ceil(test.archive.length / 8);
              controller.enqueue(new Uint8Array(test.archive.subarray(offset, offset + size)));
              offset += size;
              if (offset >= test.archive.length) {
                controller.close();
              } else {
                timer = setTimeout(next, 20_000);
              }
            };
            if (transfer !== "stall") {
              timer = setTimeout(next, 20_000);
            }
            started.resolve();
          },
          cancel() {
            clearTimeout(timer);
          },
        });
        return {
          response: new Response(body),
          finalUrl: url,
          refreshTimeout: deadline.refresh,
          release: async () => {
            clearTimeout(timer);
            deadline.signal?.removeEventListener("abort", abort);
            deadline.cleanup();
          },
        };
      });
      vi.useFakeTimers();
      const pending = ensureManagedCrabboxBinary({
        binary: test.candidate,
        env: test.env,
        runCommand,
      });
      let settled = false;
      const result = pending.then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(elapsedMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      if (succeeds) {
        await expect(result).resolves.toEqual({ value: test.binary });
      } else {
        await expect(result).resolves.toEqual({
          error: expect.objectContaining({ name: "TimeoutError" }),
        });
        expect(await fs.readdir(path.dirname(path.dirname(test.binary)))).toEqual([]);
      }
    },
  );
});

describe("Crabbox version admission", () => {
  it.each([
    ["0.54.9", "outdated"],
    ["0.55.0-rc.1", "outdated"],
    ["0.55.0+build.1", "supported"],
    ["0.56.0-dev", "supported"],
    ["0.9007199254740993.0", "indeterminate"],
    ["development", "indeterminate"],
  ])("classifies %s as %s", async (version, status) => {
    const test = await fixture(version);
    await expect(probeCrabboxVersion(test.candidate, runCommand)).resolves.toMatchObject({
      status,
    });
  });
});

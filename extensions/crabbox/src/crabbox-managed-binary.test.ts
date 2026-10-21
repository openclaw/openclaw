import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import JSZip from "jszip";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { buildTimeoutAbortSignal, createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import * as network from "openclaw/plugin-sdk/ssrf-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary } from "../cli-runtime-api.js";
import {
  CRABBOX_MIN_VERSION,
  isCrabboxVersionAtLeast,
  probeCrabboxVersion,
  resolveManagedCrabboxBinaryPath,
} from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function versionResult(version: string): SpawnResult {
  return {
    stdout: `crabbox version ${version}`,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}
const runCommand: CrabboxCommandRunner = async ([binary]) =>
  versionResult(await fs.readFile(binary!, "utf8"));

function download(body: BodyInit, init?: ResponseInit) {
  return {
    response: new Response(body, init),
    finalUrl: "https://github.com",
    release: async () => {},
  };
}

async function fixture(version = "0.66.0") {
  const root = tempDirs.make("crabbox-managed-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const candidate = path.join(root, "operator-crabbox");
  await fs.writeFile(candidate, version);
  const binary = resolveManagedCrabboxBinaryPath(env);
  const directory = path.dirname(binary);
  const parent = path.dirname(directory);
  const executable = path.basename(binary);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const extension = platform === "windows" ? "zip" : "tar.gz";
  const asset = `crabbox_${CRABBOX_MIN_VERSION}_${platform}_${arch}.${extension}`;
  const files = {
    [executable]: CRABBOX_MIN_VERSION,
    "companion-helper": "keep me",
    "crabbox-runtime/manifest.json": '{"runtime":"fixture"}',
    "crabbox-runtime/linux-amd64": "runtime-pack-fixture",
  };
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
      await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await fs.writeFile(path.join(source, name), content, { mode: 0o755 });
    }
    const archivePath = path.join(root, asset);
    await tar.c({ cwd: source, file: archivePath, gzip: true }, Object.keys(files));
    archive = await fs.readFile(archivePath);
  }
  const checksums = `${createHash("sha256").update(archive).digest("hex")}  ${asset}\n`;
  const fetch = vi.spyOn(network, "fetchWithSsrFGuard").mockImplementation(async ({ url }) => ({
    ...download(url.endsWith("/checksums.txt") ? checksums : new Uint8Array(archive)),
    finalUrl: url,
  }));
  const options = { binary: candidate, env, runCommand };
  const read = (name = executable, from = directory) => fs.readFile(path.join(from, name), "utf8");
  return {
    root,
    env,
    candidate,
    binary,
    directory,
    parent,
    executable,
    asset,
    archive,
    checksums,
    fetch,
    ensure: (overrides: { runCommand?: CrabboxCommandRunner; signal?: AbortSignal } = {}) =>
      ensureManagedCrabboxBinary({ ...options, ...overrides }),
    read,
    expectFiles: async (expected: Record<string, string>, from = directory) => {
      expect(await Promise.all(Object.keys(expected).map((name) => read(name, from)))).toEqual(
        Object.values(expected),
      );
    },
    entries: () => fs.readdir(parent),
    recoveries: async () =>
      (await fs.readdir(parent)).filter((name) =>
        name.startsWith(`${path.basename(directory)}.recovery-`),
      ),
    damage: async (content?: string) => {
      await fs.mkdir(directory, { recursive: true });
      if (content !== undefined) {
        await fs.writeFile(binary, content);
      }
      await fs.writeFile(path.join(directory, "operator-note"), "preserve this");
    },
    installed: {
      binary,
      version: CRABBOX_MIN_VERSION,
      rejected: expect.stringContaining("outdated"),
    },
  };
}

describe("managed Crabbox", () => {
  it("probes the executable in the caller's supplied environment and working directory", async () => {
    const root = tempDirs.make("crabbox-probe-env-");
    const binary = path.join(root, "crabbox");
    const env = { PATH: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const command = vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      ...versionResult(CRABBOX_MIN_VERSION),
      stdout: `crabbox ${CRABBOX_MIN_VERSION}`,
    });

    await expect(ensureManagedCrabboxBinary({ binary, env, cwd: root })).resolves.toEqual({
      binary,
      version: CRABBOX_MIN_VERSION,
    });
    expect(command).toHaveBeenCalledExactlyOnceWith(
      [binary, "--version"],
      expect.objectContaining({ baseEnv: env, cwd: root }),
    );
  });

  it("keeps a supported configured binary through startup contention", async () => {
    const test = await fixture("999.0.0");
    const started = createDeferred<void>();
    const delayedRunner: CrabboxCommandRunner = async (argv, options) => {
      const result = await runCommand(argv, options);
      if (argv[0] !== test.candidate) {
        return result;
      }
      const deadline = buildTimeoutAbortSignal({
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      const completed = createDeferred<typeof result>();
      const timer = setTimeout(() => completed.resolve(result), 7_000);
      const onAbort = () =>
        completed.resolve({ ...result, stdout: "", code: 124, termination: "timeout" });
      deadline.signal?.addEventListener("abort", onAbort, { once: true });
      started.resolve();
      try {
        return await completed.promise;
      } finally {
        clearTimeout(timer);
        deadline.signal?.removeEventListener("abort", onAbort);
        deadline.cleanup();
      }
    };
    vi.useFakeTimers();
    const pending = test.ensure({ runCommand: delayedRunner });
    const result = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(7_000);
    vi.useRealTimers();
    await expect(result).resolves.toEqual({
      value: { binary: test.candidate, version: "999.0.0" },
    });
    expect(test.fetch).not.toHaveBeenCalled();
    await expect(fs.access(test.env.OPENCLAW_STATE_DIR)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("upgrades an old candidate, preserves its distribution, and reuses it offline", async () => {
    const test = await fixture("0.72.0");
    await expect(test.ensure()).resolves.toEqual(test.installed);
    expect(await fs.readFile(test.candidate, "utf8")).toBe("0.72.0");
    await test.expectFiles({
      "companion-helper": "keep me",
      "crabbox-runtime/manifest.json": '{"runtime":"fixture"}',
      "crabbox-runtime/linux-amd64": "runtime-pack-fixture",
    });
    if (process.platform !== "win32") {
      for (const name of [test.executable, "companion-helper", "crabbox-runtime/linux-amd64"]) {
        expect((await fs.stat(path.join(test.directory, name))).mode & 0o111).toBe(0o111);
      }
    }
    await fs.writeFile(test.binary, "0.78.0");
    test.fetch.mockRejectedValue(new Error("offline"));
    await expect(test.ensure()).resolves.toEqual({
      ...test.installed,
      version: "0.78.0",
    });
    expect(test.fetch).toHaveBeenCalledTimes(2);
    expect(await test.entries()).toEqual([path.basename(test.directory)]);
  });

  it("installs when the selected executable is missing", async () => {
    const test = await fixture();
    await fs.rm(test.candidate);
    await expect(test.ensure()).resolves.toEqual({
      ...test.installed,
      rejected: expect.stringContaining("indeterminate"),
    });
  });

  it.each(["EACCES", "EIO"])(
    "surfaces %s inspecting a managed executable without downloading or replacing it",
    async (code) => {
      const test = await fixture();
      await test.damage(CRABBOX_MIN_VERSION);
      await expect(test.ensure()).resolves.toEqual(test.installed);
      const failure = Object.assign(new Error(`managed executable inspection ${code}`), { code });
      const lstat = fs.lstat;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (String(args[0]) === test.binary) {
          throw failure;
        }
        return await lstat(...args);
      });

      await expect(test.ensure()).rejects.toBe(failure);
      expect(test.fetch).not.toHaveBeenCalled();
      await test.expectFiles({
        [test.executable]: CRABBOX_MIN_VERSION,
        "operator-note": "preserve this",
      });
      expect(await test.entries()).toEqual([path.basename(test.directory)]);
    },
  );

  it("rejects mismatched archive bytes without publication and permits a later retry", async () => {
    const test = await fixture();
    test.fetch.mockResolvedValueOnce(download(`${"0".repeat(64)}  ${test.asset}\n`));
    await expect(test.ensure()).rejects.toThrow("checksum mismatch");
    expect(await test.entries()).toEqual([]);
    expect(await fs.readFile(test.candidate, "utf8")).toBe("0.66.0");
    await expect(test.ensure()).resolves.toEqual(test.installed);
  });

  it("keeps release writes inside the original staging directory after a download await", async () => {
    const test = await fixture();
    const external = path.join(test.root, "external");
    await fs.mkdir(external);
    const fetch = test.fetch.getMockImplementation()!;
    test.fetch.mockImplementation(async (params) => {
      if (!params.url.endsWith("/checksums.txt")) {
        const staging = (await test.entries()).find((entry) => entry.startsWith(".install-"))!;
        const stagingPath = path.join(test.parent, staging);
        await fs.rename(stagingPath, path.join(test.root, "original-staging"));
        await fs.symlink(external, stagingPath, process.platform === "win32" ? "junction" : "dir");
      }
      return fetch(params);
    });

    await expect(test.ensure()).rejects.toThrow();
    expect(await fs.readdir(external)).toEqual([]);
    await expect(fs.access(test.binary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["advertised", "streamed"])(
    "rejects %s oversized checksums and releases the transport before cleanup",
    async (size) => {
      const test = await fixture();
      const cancelled = createDeferred<void>();
      const release = vi.fn(async () => {
        await cancelled.promise;
      });
      test.fetch.mockResolvedValueOnce({
        response: new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1));
            },
            cancel() {
              cancelled.resolve();
              throw new Error("cancellation failed");
            },
          }),
          size === "advertised" ? { headers: { "content-length": String(64 * 1024 + 1) } } : {},
        ),
        finalUrl: "https://github.com",
        release,
      });
      await expect(test.ensure()).rejects.toThrow(/bytes|large/i);
      expect(release).toHaveBeenCalledOnce();
      expect(await test.entries()).toEqual([]);
    },
  );

  it("rejects an executable whose version disagrees with the verified release", async () => {
    const test = await fixture();
    const staleRunner: CrabboxCommandRunner = async (argv, options) => ({
      ...(await runCommand(argv, options)),
      stdout: "crabbox version 0.55.0",
    });
    await expect(test.ensure({ runCommand: staleRunner })).rejects.toThrow(
      `does not satisfy ${CRABBOX_MIN_VERSION}`,
    );
    expect(await test.entries()).toEqual([]);
  });

  it("shares an acquisition while cancellation only abandons the cancelling caller", async () => {
    const test = await fixture();
    const started = createDeferred<void>();
    const finish = createDeferred<void>();
    test.fetch.mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return download(test.checksums);
    });
    const retained = test.ensure();
    await started.promise;
    const controller = new AbortController();
    const cancellationReady = createDeferred<void>();
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (type, listener, options) => {
        addEventListener(type, listener, options);
        if (type === "abort") {
          cancellationReady.resolve();
        }
      },
    );
    const cancelled = test.ensure({ signal: controller.signal });
    const cancelledResult = expect(cancelled).rejects.toThrow("caller stopped");
    // Candidate probes happen before acquisition admission. Cancel only after
    // this caller joins the held download and subscribes to abandonment.
    await cancellationReady.promise;
    controller.abort(new Error("caller stopped"));
    try {
      await cancelledResult;
      await expect(fs.access(test.binary)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      finish.resolve();
      await retained;
    }
    await expect(retained).resolves.toEqual(test.installed);
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
    const pending = test.ensure({ signal: controller.signal });
    const result = expect(pending).rejects.toThrow("caller stopped");
    await started.promise;
    controller.abort(new Error("caller stopped"));
    await result;
    expect(await test.entries()).toEqual([]);
    await expect(test.ensure()).resolves.toEqual(test.installed);
  });

  it.each(["missing", "corrupt"])(
    "repairs a %s managed executable while preserving the previous directory",
    async (damage) => {
      const test = await fixture();
      await test.damage(damage === "missing" ? undefined : damage);
      const probes = vi.fn(runCommand);
      await expect(test.ensure({ runCommand: probes })).resolves.toEqual(test.installed);
      expect(await test.read()).toBe(CRABBOX_MIN_VERSION);
      expect(await fs.readFile(test.candidate, "utf8")).toBe("0.66.0");
      const entries = await test.entries();
      const backups = await test.recoveries();
      expect(backups).toHaveLength(1);
      const backup = path.join(test.parent, backups[0]!);
      expect(await test.read("operator-note", backup)).toBe("preserve this");
      if (damage !== "missing") {
        expect(await test.read(test.executable, backup)).toBe(damage);
        expect(probes.mock.calls.filter(([argv]) => argv[0] === test.binary)).toHaveLength(2);
      }
      expect(entries).toHaveLength(2);
    },
  );

  it("preserves a damaged distribution for recovery when publication fails", async () => {
    const test = await fixture();
    await test.damage("corrupt");
    const rename = fs.rename;
    const publish = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (
        target === test.directory &&
        typeof source === "string" &&
        path.basename(source) === "distribution"
      ) {
        throw Object.assign(new Error("publication blocked"), { code: "EACCES" });
      }
      await rename(source, target);
    });
    const pending = test.ensure();
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining("previous installation is preserved at"),
      cause: expect.objectContaining({ message: "publication blocked", code: "EACCES" }),
    });
    const [backup] = await test.recoveries();
    expect(backup).toBeDefined();
    const recovery = path.join(test.parent, backup!);
    await expect(pending).rejects.toThrow(recovery);
    await test.expectFiles(
      { [test.executable]: "corrupt", "operator-note": "preserve this" },
      recovery,
    );
    await expect(fs.access(test.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await test.entries()).toEqual([backup]);
    publish.mockRestore();
    await expect(test.ensure()).resolves.toEqual(test.installed);
    await test.expectFiles(
      { [test.executable]: "corrupt", "operator-note": "preserve this" },
      recovery,
    );
    expect(await test.read()).toBe(CRABBOX_MIN_VERSION);
  });

  it("preserves the recovered directory and published binary if staging cleanup fails", async () => {
    const test = await fixture();
    await test.damage("corrupt");
    const rm = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.basename(target).startsWith(".install-")) {
        throw Object.assign(new Error("cleanup blocked"), { code: "EACCES" });
      }
      await rm(target, options);
    });
    await expect(test.ensure()).rejects.toThrow("cleanup blocked");
    expect(await test.read()).toBe(CRABBOX_MIN_VERSION);
    const [backup] = await test.recoveries();
    expect(backup).toBeDefined();
    expect(await test.read(test.executable, path.join(test.parent, backup!))).toBe("corrupt");
    test.fetch.mockRejectedValue(new Error("offline"));
    await expect(test.ensure()).resolves.toEqual(test.installed);
  });

  it("refuses a symlinked managed directory without changing its target", async () => {
    const test = await fixture();
    const external = path.join(test.root, "external");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, test.executable), "0.54.0");
    await fs.mkdir(test.parent, { recursive: true });
    await fs.symlink(external, test.directory, process.platform === "win32" ? "junction" : "dir");
    await expect(test.ensure()).rejects.toThrow("must be a regular directory");
    expect(await test.read(test.executable, external)).toBe("0.54.0");
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
      const chunks = Array.from({ length: elapsedMs / 20_000 }, () => createDeferred<void>());
      test.fetch.mockImplementation(async ({ url, signal, timeoutMs }) => {
        if (url.endsWith("/checksums.txt")) {
          return download(test.checksums);
        }
        // Retain the SDK's real deadline behavior while replacing only the HTTP transport.
        const deadline = buildTimeoutAbortSignal({ signal, timeoutMs });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let offset = 0;
        let requested = 0;
        let abort: () => void = () => {};
        let finishPull = () => {};
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              abort = () => {
                clearTimeout(timer);
                controller.error(deadline.signal?.reason);
                finishPull();
              };
              deadline.signal?.addEventListener("abort", abort, { once: true });
            },
            pull(controller) {
              started.resolve();
              chunks[requested]?.resolve();
              requested += 1;
              return new Promise<void>((resolve) => {
                finishPull = resolve;
                if (transfer !== "stall") {
                  timer = setTimeout(() => {
                    const size = transfer === "trickle" ? 1 : Math.ceil(test.archive.length / 8);
                    controller.enqueue(
                      new Uint8Array(test.archive.subarray(offset, offset + size)),
                    );
                    offset += size;
                    if (offset >= test.archive.length) {
                      controller.close();
                    }
                    resolve();
                  }, 20_000);
                }
              });
            },
            cancel() {
              clearTimeout(timer);
              finishPull();
            },
          },
          { highWaterMark: 0 },
        );
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
      let settled = false;
      const result = test.ensure().then(
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
      for (let elapsed = 0; elapsed < elapsedMs; elapsed += 20_000) {
        if (transfer !== "stall") {
          await chunks[elapsed / 20_000]!.promise;
        }
        await vi.advanceTimersByTimeAsync(Math.min(20_000, elapsedMs - elapsed) - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      vi.useRealTimers();
      if (succeeds) {
        await expect(result).resolves.toEqual({ value: test.installed });
      } else {
        await expect(result).resolves.toEqual({
          error: expect.objectContaining({ name: "TimeoutError" }),
        });
        expect(await test.entries()).toEqual([]);
      }
    },
  );
});

describe("Crabbox version admission", () => {
  it.each([
    ["0.78.0", true],
    ["0.78.0+build", true],
    ["0.78.1", true],
    ["1.0.0", true],
    ["0.77.9", false],
    ["0.78.0-rc.1", false],
    ["unparseable", false],
  ])("compares %s against a release floor (%s)", (version, expected) => {
    expect(isCrabboxVersionAtLeast(version, "0.78.0")).toBe(expected);
  });

  it("reports a redacted version failure without retaining private error data", async () => {
    const token = "synthetic-version-secret-0123456789";
    const cause = Object.assign(
      new Error(`output capture failed token=${token}`, {
        cause: new Error(`nested token=${token}`),
      }),
      { stdout: token, stderr: token },
    );
    const probe = await probeCrabboxVersion("crabbox", async () => {
      throw cause;
    });
    expect(probe).toMatchObject({
      status: "indeterminate",
      reason: expect.stringContaining(
        "Crabbox version command execution failed: output capture failed",
      ),
    });
    for (
      let current: unknown = Object.getOwnPropertyDescriptor(probe, "cause")?.value;
      current instanceof Error;
      current = current.cause
    ) {
      expect(current.message).not.toContain(token);
    }
    expect(inspect(probe, { depth: null })).not.toContain(token);
    expect(probe).not.toHaveProperty("cause");
    expect(probe).toHaveProperty("reason", expect.not.stringContaining("synthetic-version-secret"));
  });

  it.each([
    ["0.72.0", "outdated"],
    ["0.77.0", "supported"],
    ["0.77.0-rc.1", "outdated"],
    ["0.77.0+build.1", "supported"],
    ["0.78.0", "supported"],
    ["0.9007199254740993.0", "indeterminate"],
  ])("classifies %s as %s", async (version, status) => {
    await expect(
      probeCrabboxVersion("crabbox", async () => versionResult(version)),
    ).resolves.toMatchObject({ status });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMatrixCryptoRuntime, ensureMatrixSdkInstalled } from "./deps.js";

const logStub = vi.fn();

beforeEach(() => {
  logStub.mockReset();
});

describe("ensureMatrixCryptoRuntime", () => {
  it("returns immediately when matrix SDK loads", async () => {
    const runCommand = vi.fn();
    const requireFn = vi.fn(() => ({}));

    await ensureMatrixCryptoRuntime({
      log: logStub,
      requireFn,
      runCommand,
      resolveFn: () => "/tmp/download-lib.js",
      nodeExecutable: "/usr/bin/node",
    });

    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("bootstraps missing crypto runtime and retries matrix SDK load", async () => {
    let bootstrapped = false;
    const requireFn = vi.fn(() => {
      if (!bootstrapped) {
        throw new Error(
          "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
        );
      }
      return {};
    });
    const runCommand = vi.fn(async () => {
      bootstrapped = true;
      return { code: 0, stdout: "", stderr: "" };
    });

    await ensureMatrixCryptoRuntime({
      log: logStub,
      requireFn,
      runCommand,
      resolveFn: () => "/tmp/download-lib.js",
      nodeExecutable: "/usr/bin/node",
    });

    expect(runCommand).toHaveBeenCalledWith({
      argv: ["/usr/bin/node", "/tmp/download-lib.js"],
      cwd: "/tmp",
      timeoutMs: 300_000,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });
    expect(requireFn).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-crypto module errors without bootstrapping", async () => {
    const runCommand = vi.fn();
    const requireFn = vi.fn(() => {
      throw new Error("Cannot find module '@vector-im/matrix-bot-sdk'");
    });

    await expect(
      ensureMatrixCryptoRuntime({
        log: logStub,
        requireFn,
        runCommand,
        resolveFn: () => "/tmp/download-lib.js",
        nodeExecutable: "/usr/bin/node",
      }),
    ).rejects.toThrow("Cannot find module '@vector-im/matrix-bot-sdk'");

    expect(runCommand).not.toHaveBeenCalled();
    expect(requireFn).toHaveBeenCalledTimes(1);
  });
});

describe("ensureMatrixSdkInstalled", () => {
  it("returns immediately when the matrix SDK is already available", async () => {
    const runCommand = vi.fn();

    await ensureMatrixSdkInstalled({
      log: logStub,
      isAvailable: () => true,
      runCommand,
      resolvePluginRoot: () => "/tmp/matrix",
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(logStub).not.toHaveBeenCalled();
  });

  it("installs the matrix SDK when missing and rechecks availability", async () => {
    let available = false;
    const runCommand = vi.fn(async () => {
      available = true;
      return { code: 0, stdout: "", stderr: "" };
    });

    await ensureMatrixSdkInstalled({
      log: logStub,
      isAvailable: () => available,
      runCommand,
      resolvePluginRoot: () => "/tmp/matrix",
    });

    expect(runCommand).toHaveBeenCalledWith({
      argv: ["npm", "install", "--omit=dev", "--silent"],
      cwd: "/tmp/matrix",
      timeoutMs: 300_000,
      env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });
    expect(logStub).toHaveBeenCalledWith("matrix: installing dependencies via npm (/tmp/matrix)…");
  });

  it("coalesces concurrent install attempts into a single command", async () => {
    let available = false;
    let resolveInstall: (() => void) | undefined;
    const runCommand = vi.fn(
      async () =>
        await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
          resolveInstall = () => {
            available = true;
            resolve({ code: 0, stdout: "", stderr: "" });
          };
        }),
    );

    const first = ensureMatrixSdkInstalled({
      log: logStub,
      isAvailable: () => available,
      runCommand,
      resolvePluginRoot: () => "/tmp/matrix",
    });
    const second = ensureMatrixSdkInstalled({
      log: logStub,
      isAvailable: () => available,
      runCommand,
      resolvePluginRoot: () => "/tmp/matrix",
    });

    resolveInstall?.();
    await Promise.all([first, second]);

    expect(runCommand).toHaveBeenCalledTimes(1);
  });
});

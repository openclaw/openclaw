import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureMatrixSdkInstalled } from "./deps.js";

const cryptoRequire = vi.hoisted(() =>
  Object.assign(vi.fn<(id: string) => unknown>(), { resolve: vi.fn<(id: string) => string>() }),
);

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (url: string | URL) =>
    /\/matrix\/deps\.[jt]s$/.test(String(url)) ? cryptoRequire : actual.createRequire(url);
  return new Proxy(actual, {
    get(target, property, receiver) {
      return property === "createRequire" ? createRequire : Reflect.get(target, property, receiver);
    },
  });
});

function resolveTestNativeBindingFilename(): string | null {
  const report = process.platform === "linux" ? process.report?.getReport?.() : undefined;
  const isMusl = !(report as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
    ?.glibcVersionRuntime;
  const suffixes: Record<string, string | null> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-x64": `linux-x64-${isMusl ? "musl" : "gnu"}`,
    "linux-arm64": isMusl ? null : "linux-arm64-gnu",
    "linux-arm": "linux-arm-gnueabihf",
    "linux-s390x": "linux-s390x-gnu",
    "win32-x64": "win32-x64-msvc",
    "win32-ia32": "win32-ia32-msvc",
    "win32-arm64": "win32-arm64-msvc",
  };
  const suffix = suffixes[`${process.platform}-${process.arch}`];
  return suffix ? `matrix-sdk-crypto.${suffix}.node` : null;
}

describe("ensureMatrixCryptoRuntime", () => {
  let ensureMatrixCryptoRuntime: typeof import("./deps.js").ensureMatrixCryptoRuntime;
  let tmpDir: string;

  function writeBootstrap(lines: string[]) {
    const scriptPath = path.join(tmpDir, "download-lib.js");
    fs.writeFileSync(scriptPath, ['const fs = require("node:fs");', ...lines].join("\n"));
    cryptoRequire.resolve.mockReturnValue(scriptPath);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-crypto-"));
    vi.resetModules();
    cryptoRequire.mockReset().mockReturnValue({});
    cryptoRequire.resolve.mockReset().mockImplementation(() => {
      throw new Error("package not resolved");
    });
    ({ ensureMatrixCryptoRuntime } = await import("./deps.js"));
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("shares one bootstrap of missing crypto runtime and retries matrix SDK load", async () => {
    const markerPath = path.join(tmpDir, "bootstrapped");
    writeBootstrap([
      `if (fs.realpathSync(process.cwd()) !== ${JSON.stringify(fs.realpathSync(tmpDir))}) process.exit(2);`,
      'if (process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT !== "0") process.exit(3);',
      `fs.writeFileSync(${JSON.stringify(markerPath)}, "ok");`,
    ]);
    cryptoRequire.mockImplementation(() => {
      if (!fs.existsSync(markerPath)) {
        throw new Error(
          "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
        );
      }
      return {};
    });

    await Promise.all([ensureMatrixCryptoRuntime(), ensureMatrixCryptoRuntime()]);
    await ensureMatrixCryptoRuntime();

    expect(fs.readFileSync(markerPath, "utf8")).toBe("ok");
    expect(cryptoRequire).toHaveBeenCalledTimes(2);
  });

  it("rethrows non-crypto module errors and allows a later load to retry", async () => {
    cryptoRequire.mockImplementationOnce(() => {
      throw new Error("Cannot find module 'not-the-matrix-crypto-runtime'");
    });

    await expect(ensureMatrixCryptoRuntime()).rejects.toThrow(
      "Cannot find module 'not-the-matrix-crypto-runtime'",
    );
    await ensureMatrixCryptoRuntime();

    expect(cryptoRequire).toHaveBeenCalledTimes(2);
  });

  it("removes an incomplete native binding before loading the matrix SDK", async () => {
    const nativeBindingFilename = resolveTestNativeBindingFilename();
    if (!nativeBindingFilename) {
      return;
    }

    const nativeBindingPath = path.join(tmpDir, nativeBindingFilename);
    writeBootstrap([
      `fs.writeFileSync(${JSON.stringify(nativeBindingPath)}, Buffer.alloc(1_000_000));`,
    ]);
    fs.writeFileSync(nativeBindingPath, Buffer.alloc(16));

    const bindingSizes: number[] = [];
    cryptoRequire.mockImplementation(() => {
      const size = fs.existsSync(nativeBindingPath) ? fs.statSync(nativeBindingPath).size : 0;
      bindingSizes.push(size);
      if (size < 1_000_000) {
        throw new Error(
          "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
        );
      }
      return {};
    });

    await ensureMatrixCryptoRuntime();

    expect(cryptoRequire).toHaveBeenCalledTimes(2);
    expect(fs.statSync(nativeBindingPath).size).toBe(1_000_000);
    expect(bindingSizes).toEqual([0, 1_000_000]);
  });
});

describe("ensureMatrixSdkInstalled", () => {
  it("returns without error when all required packages resolve", async () => {
    const resolveFn = vi.fn((_id: string) => "/fake/path");
    await expect(ensureMatrixSdkInstalled({ resolveFn })).resolves.toBeUndefined();
    expect(resolveFn).toHaveBeenCalled();
  });

  it("lists missing packages without prompting for installation (regression: #80758)", async () => {
    const confirm = vi.fn(async () => true);
    const resolveFn = vi.fn((id: string) => {
      if (id === "@matrix-org/matrix-sdk-crypto-wasm") {
        throw new Error("Cannot find module");
      }
      return "/fake/path";
    });
    await expect(ensureMatrixSdkInstalled({ resolveFn, confirm })).rejects.toThrow(
      /Matrix plugin dependencies are missing: @matrix-org\/matrix-sdk-crypto-wasm\./,
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});

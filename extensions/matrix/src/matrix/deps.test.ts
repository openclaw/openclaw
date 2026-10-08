// Matrix tests cover deps plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  switch (process.platform) {
    case "darwin":
      return process.arch === "arm64"
        ? "matrix-sdk-crypto.darwin-arm64.node"
        : process.arch === "x64"
          ? "matrix-sdk-crypto.darwin-x64.node"
          : null;
    case "linux": {
      const report = process.report?.getReport?.() as
        | { header?: { glibcVersionRuntime?: string } }
        | undefined;
      const isMusl = !report?.header?.glibcVersionRuntime;
      if (process.arch === "x64") {
        return isMusl
          ? "matrix-sdk-crypto.linux-x64-musl.node"
          : "matrix-sdk-crypto.linux-x64-gnu.node";
      }
      if (process.arch === "arm64" && !isMusl) {
        return "matrix-sdk-crypto.linux-arm64-gnu.node";
      }
      if (process.arch === "arm") {
        return "matrix-sdk-crypto.linux-arm-gnueabihf.node";
      }
      if (process.arch === "s390x") {
        return "matrix-sdk-crypto.linux-s390x-gnu.node";
      }
      return null;
    }
    case "win32":
      return process.arch === "x64"
        ? "matrix-sdk-crypto.win32-x64-msvc.node"
        : process.arch === "ia32"
          ? "matrix-sdk-crypto.win32-ia32-msvc.node"
          : process.arch === "arm64"
            ? "matrix-sdk-crypto.win32-arm64-msvc.node"
            : null;
    default:
      return null;
  }
}

describe("ensureMatrixCryptoRuntime", () => {
  let ensureMatrixCryptoRuntime: typeof import("./deps.js").ensureMatrixCryptoRuntime;

  beforeEach(async () => {
    vi.resetModules();
    cryptoRequire.mockReset().mockReturnValue({});
    cryptoRequire.resolve.mockReset().mockImplementation(() => {
      throw new Error("package not resolved");
    });
    ({ ensureMatrixCryptoRuntime } = await import("./deps.js"));
  });

  it("loads the matrix SDK once across repeated calls", async () => {
    await ensureMatrixCryptoRuntime();
    await ensureMatrixCryptoRuntime();

    expect(cryptoRequire).toHaveBeenCalledTimes(1);
  });

  it("shares one bootstrap of missing crypto runtime and retries matrix SDK load", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-crypto-bootstrap-"));
    const scriptPath = path.join(tmpDir, "download-lib.js");
    const markerPath = path.join(tmpDir, "bootstrapped");
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        `if (fs.realpathSync(process.cwd()) !== ${JSON.stringify(fs.realpathSync(tmpDir))}) process.exit(2);`,
        'if (process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT !== "0") process.exit(3);',
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "ok");`,
      ].join("\n"),
    );
    cryptoRequire.resolve.mockReturnValue(scriptPath);
    cryptoRequire.mockImplementation(() => {
      if (!fs.existsSync(markerPath)) {
        throw new Error(
          "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
        );
      }
      return {};
    });

    try {
      await Promise.all([ensureMatrixCryptoRuntime(), ensureMatrixCryptoRuntime()]);
      await ensureMatrixCryptoRuntime();

      expect(fs.readFileSync(markerPath, "utf8")).toBe("ok");
      expect(cryptoRequire).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-crypto-runtime-"));
    const scriptPath = path.join(tmpDir, "download-lib.js");
    const nativeBindingPath = path.join(tmpDir, nativeBindingFilename);
    fs.writeFileSync(
      scriptPath,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(nativeBindingPath)}, Buffer.alloc(1_000_000));`,
      ].join("\n"),
    );
    fs.writeFileSync(nativeBindingPath, Buffer.alloc(16));

    const bindingSizes: number[] = [];
    cryptoRequire.resolve.mockReturnValue(scriptPath);
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

    try {
      await ensureMatrixCryptoRuntime();

      expect(cryptoRequire).toHaveBeenCalledTimes(2);
      expect(fs.statSync(nativeBindingPath).size).toBe(1_000_000);
      expect(bindingSizes).toEqual([0, 1_000_000]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("ensureMatrixSdkInstalled", () => {
  it("returns without error when all required packages resolve", async () => {
    const resolveFn = vi.fn((_id: string) => "/fake/path");
    await expect(ensureMatrixSdkInstalled({ resolveFn })).resolves.toBeUndefined();
    expect(resolveFn).toHaveBeenCalled();
  });

  it("lists only the packages that fail to resolve", async () => {
    const resolveFn = vi.fn((id: string) => {
      if (id === "@matrix-org/matrix-sdk-crypto-wasm") {
        throw new Error("Cannot find module");
      }
      return "/fake/path";
    });
    await expect(ensureMatrixSdkInstalled({ resolveFn })).rejects.toThrow(
      /Matrix plugin dependencies are missing: @matrix-org\/matrix-sdk-crypto-wasm\./,
    );
  });

  it("does not invoke the install confirm prompt when packages are missing (regression: #80758)", async () => {
    const confirm = vi.fn(async () => true);
    const resolveFn = vi.fn((_id: string) => {
      throw new Error("Cannot find module");
    });
    await expect(ensureMatrixSdkInstalled({ resolveFn, confirm })).rejects.toThrow(
      /Matrix plugin dependencies are missing: matrix-js-sdk, @matrix-org\/matrix-sdk-crypto-nodejs, @matrix-org\/matrix-sdk-crypto-wasm\. Repair this plugin with `openclaw plugins update matrix` or run `openclaw doctor --fix`\./,
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});

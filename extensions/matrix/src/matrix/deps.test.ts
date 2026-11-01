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

  it.each(["missing", "truncated"] as const)(
    "bootstraps a %s runtime once, sharing concurrent loads",
    async (mode) => {
      const filename = mode === "missing" ? "bootstrapped" : resolveTestNativeBindingFilename();
      if (!filename) {
        return;
      }
      const artifact = path.join(tmpDir, filename);
      const bytes = mode === "missing" ? 2 : 1_000_000;
      writeBootstrap([
        `if (fs.realpathSync(process.cwd()) !== ${JSON.stringify(fs.realpathSync(tmpDir))}) process.exit(2);`,
        'if (process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT !== "0") process.exit(3);',
        `fs.writeFileSync(${JSON.stringify(artifact)}, Buffer.alloc(${bytes}));`,
      ]);
      if (mode === "truncated") {
        fs.writeFileSync(artifact, Buffer.alloc(16));
      }
      const bindingSizes: number[] = [];
      cryptoRequire.mockImplementation(() => {
        const size = fs.existsSync(artifact) ? fs.statSync(artifact).size : 0;
        bindingSizes.push(size);
        if (size !== bytes) {
          throw new Error(
            "Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs-linux-x64-gnu' (required by matrix sdk)",
          );
        }
        return {};
      });
      await Promise.all([ensureMatrixCryptoRuntime(), ensureMatrixCryptoRuntime()]);
      await ensureMatrixCryptoRuntime();
      expect(fs.readFileSync(artifact)).toEqual(Buffer.alloc(bytes));
      expect(bindingSizes).toEqual([0, bytes]);
    },
  );

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
});

describe("ensureMatrixSdkInstalled", () => {
  it("returns without error when all required packages resolve", async () => {
    await expect(
      ensureMatrixSdkInstalled({ resolveFn: () => "/fake/path" }),
    ).resolves.toBeUndefined();
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

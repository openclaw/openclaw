// Copilot tests cover sdk loader plugin behavior.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import copilotPluginPackage from "../package.json" with { type: "json" };
import { loadCopilotSdk } from "./sdk-loader.js";

const FAKE_SDK = {
  CopilotClient: class FakeCopilotClient {
    _fake = true;
  },
} as unknown as typeof import("@github/copilot-sdk");

describe("sdk-loader", () => {
  it("default fallback importer resolves and imports the installed SDK entry", async () => {
    // Exercise the real default fallback importer (no fallbackImport injection)
    // to prove it imports a concrete entry file rather than the package
    // directory, which Node ESM would reject with ERR_UNSUPPORTED_DIR_IMPORT.
    const tmp = mkdtempSync(path.join(tmpdir(), "copilot-sdk-loader-default-"));
    try {
      const pkgDir = path.join(tmp, "node_modules", "@github", "copilot-sdk");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@github/copilot-sdk",
          version: "0.0.0-test",
          main: "./index.cjs",
        }),
      );
      writeFileSync(
        path.join(pkgDir, "index.cjs"),
        "module.exports = { openclawDefaultImporterSentinel: true };",
      );

      const primaryImport = vi.fn(async () => {
        const err = new Error("Cannot find module '@github/copilot-sdk'") as Error & {
          code: string;
        };
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      });

      const sdk = (await loadCopilotSdk({
        cache: false,
        fallbackDir: tmp,
        primaryImport,
        // Intentionally NOT injecting fallbackImport; exercise the default.
      })) as unknown as { openclawDefaultImporterSentinel?: boolean };

      expect(sdk.openclawDefaultImporterSentinel).toBe(true);
      expect(primaryImport).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws an actionable error with install and resolution details", async () => {
    const primaryImport = vi.fn(async () => {
      throw new Error("primary boom");
    });
    const fallbackImport = vi.fn(async () => {
      throw new Error("should not be called when fallback dir does not exist");
    });
    const fallbackDir = path.join(tmpdir(), "copilot-sdk-loader-missing-" + Date.now());
    const failed = loadCopilotSdk({ cache: false, fallbackDir, primaryImport, fallbackImport });

    await expect(failed).rejects.toMatchObject({ code: "COPILOT_SDK_MISSING" });
    for (const detail of [
      "openclaw plugins install @openclaw/copilot",
      "primary boom",
      path.join(fallbackDir, "node_modules", "@github", "copilot-sdk"),
      `@github/copilot-sdk@${copilotPluginPackage.dependencies["@github/copilot-sdk"]}`,
    ]) {
      await expect(failed).rejects.toThrow(detail);
    }
    expect(fallbackImport).not.toHaveBeenCalled();
  });

  it("caches successful loads across calls when cache is enabled", async () => {
    vi.resetModules();
    const { loadCopilotSdk: loadFreshCopilotSdk } = await import("./sdk-loader.js");
    const primaryImport = vi.fn(async () => FAKE_SDK);
    const fallbackImport = vi.fn(async () => {
      throw new Error("should not be called");
    });

    const a = await loadFreshCopilotSdk({
      primaryImport,
      fallbackImport,
      fallbackDir: "/dev/null/does-not-exist",
    });
    const b = await loadFreshCopilotSdk({
      primaryImport,
      fallbackImport,
      fallbackDir: "/dev/null/does-not-exist",
    });

    expect(a).toBe(FAKE_SDK);
    expect(b).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(1);
    expect(fallbackImport).not.toHaveBeenCalled();
  });

  it("does not poison the cache after a failed load", async () => {
    vi.resetModules();
    const { loadCopilotSdk: loadFreshCopilotSdk } = await import("./sdk-loader.js");
    const primaryImport = vi
      .fn<typeof Promise>()
      .mockRejectedValueOnce(new Error("first boom"))
      .mockResolvedValueOnce(FAKE_SDK);

    await expect(
      loadFreshCopilotSdk({
        primaryImport: primaryImport as unknown as () => Promise<
          typeof import("@github/copilot-sdk")
        >,
        fallbackDir: "/dev/null/does-not-exist",
      }),
    ).rejects.toBeInstanceOf(Error);

    const sdk = await loadFreshCopilotSdk({
      primaryImport: primaryImport as unknown as () => Promise<
        typeof import("@github/copilot-sdk")
      >,
      fallbackDir: "/dev/null/does-not-exist",
    });
    expect(sdk).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(2);
  });

  it("resolves the fallback install from OPENCLAW_STATE_DIR", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "copilot-sdk-loader-state-"));
    try {
      const fallbackPath = path.join(
        stateDir,
        "npm-runtime",
        "copilot",
        "node_modules",
        "@github",
        "copilot-sdk",
      );
      mkdirSync(fallbackPath, { recursive: true });
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const fallbackImport = vi.fn(async (absolutePath: string) => {
        expect(absolutePath).toBe(fallbackPath);
        return FAKE_SDK;
      });

      await expect(
        loadCopilotSdk({
          cache: false,
          primaryImport: async () => {
            throw new Error("primary missing");
          },
          fallbackImport,
        }),
      ).resolves.toBe(FAKE_SDK);
      expect(fallbackImport).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPILOT_SDK_FALLBACK_DIR,
  COPILOT_SDK_SPEC,
  _resetCopilotSdkCacheForTests,
  loadCopilotSdk,
} from "./sdk-loader.js";

const FAKE_SDK = {
  CopilotClient: class FakeCopilotClient {},
} as unknown as typeof import("@github/copilot-sdk");

describe("sdk-loader", () => {
  beforeEach(() => {
    _resetCopilotSdkCacheForTests();
  });

  it("returns the primary import when it succeeds", async () => {
    const primaryImport = vi.fn(async () => FAKE_SDK);
    const fallbackImport = vi.fn(async () => {
      throw new Error("should not be called");
    });

    const sdk = await loadCopilotSdk({
      cache: false,
      fallbackDir: "/dev/null/does-not-exist",
      primaryImport,
      fallbackImport,
    });

    expect(sdk).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(1);
    expect(fallbackImport).not.toHaveBeenCalled();
  });

  it("falls back to the on-demand install location when primary import fails", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "copilot-sdk-loader-"));
    try {
      // Materialize the fallback path so the existsSync check passes.
      const fallbackPath = path.join(tmp, "node_modules", "@github", "copilot-sdk");
      mkdirSync(fallbackPath, { recursive: true });
      writeFileSync(path.join(fallbackPath, "index.js"), "// placeholder");

      const primaryImport = vi.fn(async () => {
        const err = new Error("Cannot find module '@github/copilot-sdk'") as Error & {
          code: string;
        };
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      });
      const fallbackImport = vi.fn(async (abs: string) => {
        expect(abs).toBe(fallbackPath);
        return FAKE_SDK;
      });

      const sdk = await loadCopilotSdk({
        cache: false,
        fallbackDir: tmp,
        primaryImport,
        fallbackImport,
      });

      expect(sdk).toBe(FAKE_SDK);
      expect(primaryImport).toHaveBeenCalledTimes(1);
      expect(fallbackImport).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws an actionable error with install instructions when both probes fail", async () => {
    const primaryImport = vi.fn(async () => {
      throw new Error("Cannot find module '@github/copilot-sdk'");
    });
    const fallbackImport = vi.fn(async () => {
      throw new Error("should not be called when fallback dir does not exist");
    });

    await expect(
      loadCopilotSdk({
        cache: false,
        fallbackDir: path.join(tmpdir(), "copilot-sdk-loader-missing-" + Date.now()),
        primaryImport,
        fallbackImport,
      }),
    ).rejects.toMatchObject({
      code: "COPILOT_SDK_MISSING",
      message: expect.stringContaining(COPILOT_SDK_SPEC),
    });

    expect(fallbackImport).not.toHaveBeenCalled();
  });

  it("error message includes the fallback path and underlying primary error", async () => {
    const primaryImport = vi.fn(async () => {
      throw new Error("primary boom");
    });

    const fallbackDir = path.join(tmpdir(), "copilot-sdk-loader-missing-" + Date.now());
    let captured: Error | undefined;
    try {
      await loadCopilotSdk({
        cache: false,
        fallbackDir,
        primaryImport,
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    const message = captured?.message ?? "";
    expect(message).toContain("primary boom");
    expect(message).toContain(path.join(fallbackDir, "node_modules", "@github", "copilot-sdk"));
    expect(message).toContain("pnpm add");
  });

  it("caches successful loads across calls when cache is enabled", async () => {
    const primaryImport = vi.fn(async () => FAKE_SDK);

    const a = await loadCopilotSdk({ primaryImport, fallbackDir: "/dev/null/does-not-exist" });
    const b = await loadCopilotSdk({ primaryImport, fallbackDir: "/dev/null/does-not-exist" });

    expect(a).toBe(FAKE_SDK);
    expect(b).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(1);
  });

  it("does not poison the cache after a failed load", async () => {
    const primaryImport = vi
      .fn<typeof Promise>()
      .mockRejectedValueOnce(new Error("first boom"))
      .mockResolvedValueOnce(FAKE_SDK);

    await expect(
      loadCopilotSdk({
        primaryImport: primaryImport as unknown as () => Promise<
          typeof import("@github/copilot-sdk")
        >,
        fallbackDir: "/dev/null/does-not-exist",
      }),
    ).rejects.toBeInstanceOf(Error);

    const sdk = await loadCopilotSdk({
      primaryImport: primaryImport as unknown as () => Promise<
        typeof import("@github/copilot-sdk")
      >,
      fallbackDir: "/dev/null/does-not-exist",
    });
    expect(sdk).toBe(FAKE_SDK);
    expect(primaryImport).toHaveBeenCalledTimes(2);
  });

  it("default fallback dir points at ~/.openclaw/npm-runtime/copilot", () => {
    expect(COPILOT_SDK_FALLBACK_DIR).toMatch(/\.openclaw[\\/]+npm-runtime[\\/]+copilot$/);
  });

  afterEach(() => {
    _resetCopilotSdkCacheForTests();
  });
});

describe("contract with core copilot-sdk-install", () => {
  it("COPILOT_SDK_FALLBACK_DIR and COPILOT_SDK_SPEC match the core install command", async () => {
    const core = await import("../../../src/commands/copilot-sdk-install.js");
    expect(COPILOT_SDK_FALLBACK_DIR).toBe(core.COPILOT_SDK_FALLBACK_DIR);
    expect(COPILOT_SDK_SPEC).toBe(core.COPILOT_SDK_SPEC);
  });
});

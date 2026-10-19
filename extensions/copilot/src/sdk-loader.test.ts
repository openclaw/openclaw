// Copilot tests cover sdk loader plugin behavior.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import copilotPluginPackage from "../package.json" with { type: "json" };

const FAKE_SDK = {
  CopilotClient: vi.fn(),
};

function mockPrimaryImport(factory: () => Promise<unknown>) {
  vi.doMock("@github/copilot-sdk", factory);
}

describe("sdk-loader", () => {
  let stateDir: string;
  let fallbackPath: string;

  beforeEach(() => {
    vi.resetModules();
    stateDir = mkdtempSync(path.join(tmpdir(), "copilot-sdk-loader-"));
    fallbackPath = path.join(
      stateDir,
      "npm-runtime",
      "copilot",
      "node_modules",
      "@github",
      "copilot-sdk",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    vi.doUnmock("@github/copilot-sdk");
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("resolves and imports the installed SDK entry from OPENCLAW_STATE_DIR", async () => {
    // Exercise a concrete entry file: Node ESM rejects package directory imports.
    mkdirSync(fallbackPath, { recursive: true });
    writeFileSync(
      path.join(fallbackPath, "package.json"),
      JSON.stringify({ name: "@github/copilot-sdk", version: "0.0.0-test", main: "./index.cjs" }),
    );
    writeFileSync(
      path.join(fallbackPath, "index.cjs"),
      "module.exports = { openclawDefaultImporterSentinel: true };",
    );
    mockPrimaryImport(async () => {
      throw new Error("Cannot find module '@github/copilot-sdk'");
    });
    const { loadCopilotSdk } = await import("./sdk-loader.js");

    const sdk = (await loadCopilotSdk()) as unknown as {
      openclawDefaultImporterSentinel?: boolean;
    };
    expect(sdk.openclawDefaultImporterSentinel).toBe(true);
  });

  it("throws an actionable error with install and resolution details", async () => {
    const { loadCopilotSdk } = await import("./sdk-loader.js");
    // Vitest wraps rejected mock factories, hiding the original import diagnostic.
    const failed = loadCopilotSdk({
      primaryImport: async () => {
        throw new Error("primary boom");
      },
    });

    await expect(failed).rejects.toMatchObject({ code: "COPILOT_SDK_MISSING" });
    for (const detail of [
      "openclaw plugins install @openclaw/copilot",
      "primary boom",
      fallbackPath,
      `@github/copilot-sdk@${copilotPluginPackage.dependencies["@github/copilot-sdk"]}`,
    ]) {
      await expect(failed).rejects.toThrow(detail);
    }
  });

  it("caches successful loads across calls", async () => {
    mockPrimaryImport(async () => FAKE_SDK);
    const { loadCopilotSdk } = await import("./sdk-loader.js");
    const first = await loadCopilotSdk();

    mockPrimaryImport(async () => {
      throw new Error("a cached load must not import again");
    });
    expect(await loadCopilotSdk()).toBe(first);
    expect(first.CopilotClient).toBe(FAKE_SDK.CopilotClient);
  });

  it("does not poison the cache after a failed load", async () => {
    mockPrimaryImport(async () => {
      throw new Error("first boom");
    });
    const { loadCopilotSdk } = await import("./sdk-loader.js");
    await expect(loadCopilotSdk()).rejects.toMatchObject({ code: "COPILOT_SDK_MISSING" });

    mockPrimaryImport(async () => FAKE_SDK);
    const sdk = await loadCopilotSdk();
    expect(sdk.CopilotClient).toBe(FAKE_SDK.CopilotClient);
  });
});

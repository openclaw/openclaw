import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";

const { resolveBrewExecutableMock, runPluginCommandWithTimeoutMock } = vi.hoisted(() => ({
  resolveBrewExecutableMock: vi.fn(),
  runPluginCommandWithTimeoutMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>();
  return {
    ...actual,
    resolveBrewExecutable: resolveBrewExecutableMock,
  };
});

vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: runPluginCommandWithTimeoutMock,
}));

const { installIMessageCli } = await import("./install-imsg.js");
const install = (upgrade?: boolean) =>
  installIMessageCli(createRuntimeSpies(), upgrade ? { upgrade } : undefined);

async function writeCli(cliPath: string) {
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(cliPath, "");
}

function brewCommand(step: number, args: string[], timeoutMs: number) {
  expect(runPluginCommandWithTimeoutMock).toHaveBeenNthCalledWith(step, {
    argv: ["/opt/homebrew/bin/brew", ...args],
    timeoutMs,
  });
}

describe("installIMessageCli", () => {
  const originalPlatform = process.platform;

  function setProcessPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
  }

  function mockCommandOutputs(...outputs: string[]) {
    for (const stdout of outputs) {
      runPluginCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout, stderr: "" });
    }
  }

  beforeEach(() => {
    setProcessPlatform("darwin");
    resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    vi.clearAllMocks();
  });

  it("installs imsg through Homebrew on macOS", async () => {
    await withTempDir("openclaw-imsg-brew-", async (brewPrefix) => {
      await writeCli(path.join(brewPrefix, "bin", "imsg"));
      mockCommandOutputs("", `${brewPrefix}\n`);

      const result = await install();

      expect(result).toEqual({
        ok: true,
        cliPath: path.join(brewPrefix, "bin", "imsg"),
      });
      brewCommand(1, ["install", "steipete/tap/imsg"], 15 * 60_000);
    });
  });

  it("updates imsg when its Homebrew formula is installed", async () => {
    await withTempDir("openclaw-imsg-brew-", async (brewPrefix) => {
      const cellar = path.join(brewPrefix, "Cellar");
      const formulaCliPath = path.join(cellar, "imsg", "0.13.1", "bin", "imsg");
      const cliPath = path.join(brewPrefix, "bin", "imsg");
      await writeCli(formulaCliPath);
      await fs.mkdir(path.dirname(cliPath), { recursive: true });
      await fs.symlink(formulaCliPath, cliPath);
      mockCommandOutputs(
        "steipete/tap/imsg\n",
        `${cliPath}\n`,
        `${cellar}\n`,
        "",
        "",
        `${brewPrefix}\n`,
      );

      const result = await install(true);

      expect(result).toEqual({
        ok: true,
        cliPath,
      });
      brewCommand(4, ["update"], 5 * 60_000);
      brewCommand(5, ["upgrade", "imsg"], 15 * 60_000);
    });
  });

  it("preserves detected imsg when Homebrew does not own it", async () => {
    runPluginCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "wget\n",
      stderr: "",
    });

    const result = await install(true);

    expect(result).toEqual({ ok: true });
    expect(runPluginCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    brewCommand(1, ["list", "--formula", "--full-name"], 10_000);
  });

  it("preserves a PATH imsg that shadows an installed Homebrew formula", async () => {
    await withTempDir("openclaw-imsg-shadow-", async (tmpDir) => {
      const cliPath = path.join(tmpDir, "local", "bin", "imsg");
      const cellar = path.join(tmpDir, "Cellar");
      await writeCli(cliPath);
      await fs.mkdir(path.join(cellar, "imsg"), { recursive: true });
      mockCommandOutputs("steipete/tap/imsg\n", `${cliPath}\n`, `${cellar}\n`);

      const result = await install(true);

      expect(result).toEqual({ ok: true });
      expect(runPluginCommandWithTimeoutMock.mock.calls).not.toContainEqual([
        { argv: ["/opt/homebrew/bin/brew", "update"], timeoutMs: 5 * 60_000 },
      ]);
      expect(runPluginCommandWithTimeoutMock.mock.calls).not.toContainEqual([
        { argv: ["/opt/homebrew/bin/brew", "upgrade", "imsg"], timeoutMs: 15 * 60_000 },
      ]);
    });
  });

  it("explains that Homebrew is required when brew is missing", async () => {
    resolveBrewExecutableMock.mockReturnValue(null);

    const result = await install();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Homebrew is required for imsg setup");
    expect(runPluginCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("does not auto-install imsg on non-macOS hosts", async () => {
    setProcessPlatform("linux");

    const result = await install();

    expect(result).toEqual({
      ok: false,
      error: "imsg auto-install is supported only on macOS.",
    });
    expect(resolveBrewExecutableMock).not.toHaveBeenCalled();
  });
});

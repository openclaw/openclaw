import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";

const { resolveBrewExecutableMock, runCommandMock } = vi.hoisted(() => ({
  resolveBrewExecutableMock: vi.fn(),
  runCommandMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>();
  return { ...actual, resolveBrewExecutable: resolveBrewExecutableMock };
});

// mock-isolation: Installer fixtures record Homebrew commands without executing host processes.
vi.mock("openclaw/plugin-sdk/run-command", () => ({
  runPluginCommandWithTimeout: runCommandMock,
}));

const { installIMessageCli } = await import("./install-imsg.js");
const install = (upgrade?: boolean) =>
  installIMessageCli(createRuntimeSpies(), upgrade ? { upgrade } : undefined);

async function writeCli(cliPath: string) {
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(cliPath, "");
}

function brewCommand(step: number, args: string[], timeoutMs: number) {
  expect(runCommandMock).toHaveBeenNthCalledWith(step, {
    argv: ["/opt/homebrew/bin/brew", ...args],
    timeoutMs,
  });
}

const originalPlatform = process.platform;

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function mockCommandOutputs(...outputs: string[]) {
  for (const stdout of outputs) {
    runCommandMock.mockResolvedValueOnce({ code: 0, stdout, stderr: "" });
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

it.each([false, true])("installs with Homebrew (upgrade=%s)", async (upgrade) => {
  await withTempDir("openclaw-imsg-brew-", async (brewPrefix) => {
    const cellar = path.join(brewPrefix, "Cellar");
    const formulaCliPath = path.join(cellar, "imsg", "0.13.1", "bin", "imsg");
    const cliPath = path.join(brewPrefix, "bin", "imsg");
    if (upgrade) {
      await writeCli(formulaCliPath);
      await fs.mkdir(path.dirname(cliPath), { recursive: true });
      await fs.symlink(formulaCliPath, cliPath);
    } else {
      await writeCli(cliPath);
    }
    mockCommandOutputs(
      ...(upgrade ? ["steipete/tap/imsg\n", `${cliPath}\n`, `${cellar}\n`, ""] : []),
      "",
      `${brewPrefix}\n`,
    );
    expect(await install(upgrade)).toEqual({ ok: true, cliPath });
    if (upgrade) {
      brewCommand(4, ["update"], 5 * 60_000);
    }
    brewCommand(
      upgrade ? 5 : 1,
      upgrade ? ["upgrade", "imsg"] : ["install", "steipete/tap/imsg"],
      15 * 60_000,
    );
  });
});

it("preserves detected imsg when Homebrew does not own it", async () => {
  runCommandMock.mockResolvedValue({ code: 0, stdout: "wget\n", stderr: "" });

  expect(await install(true)).toEqual({ ok: true });
  expect(runCommandMock).toHaveBeenCalledTimes(1);
  brewCommand(1, ["list", "--formula", "--full-name"], 10_000);
});

it("preserves a PATH imsg that shadows an installed Homebrew formula", async () => {
  await withTempDir("openclaw-imsg-shadow-", async (tmpDir) => {
    const cliPath = path.join(tmpDir, "local", "bin", "imsg");
    const cellar = path.join(tmpDir, "Cellar");
    await writeCli(cliPath);
    await fs.mkdir(path.join(cellar, "imsg"), { recursive: true });
    mockCommandOutputs("steipete/tap/imsg\n", `${cliPath}\n`, `${cellar}\n`);

    expect(await install(true)).toEqual({ ok: true });
    expect(runCommandMock.mock.calls).not.toContainEqual([
      { argv: ["/opt/homebrew/bin/brew", "update"], timeoutMs: 5 * 60_000 },
    ]);
    expect(runCommandMock.mock.calls).not.toContainEqual([
      { argv: ["/opt/homebrew/bin/brew", "upgrade", "imsg"], timeoutMs: 15 * 60_000 },
    ]);
  });
});

it.each([
  ["darwin", expect.stringContaining("Homebrew is required for imsg setup")],
  ["linux", "imsg auto-install is supported only on macOS."],
] as const)("rejects setup without prerequisites on %s", async (platform, error) => {
  setProcessPlatform(platform);
  resolveBrewExecutableMock.mockReturnValue(null);
  expect(await install()).toEqual({ ok: false, error });
  expect(runCommandMock).not.toHaveBeenCalled();
  if (platform === "linux") {
    expect(resolveBrewExecutableMock).not.toHaveBeenCalled();
  }
});

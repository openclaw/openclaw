import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";

const { resolveBrewExecutableMock, runCommandMock } = vi.hoisted(() => ({
  resolveBrewExecutableMock: vi.fn(),
  runCommandMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>()),
  resolveBrewExecutable: resolveBrewExecutableMock,
}));

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

const commands = () => runCommandMock.mock.calls.map(([command]) => command.argv);

const originalPlatform = process.platform;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let brewPrefix: string, cliPath: string, cellar: string;

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function mockCommandOutputs(...outputs: string[]) {
  for (const stdout of outputs) {
    runCommandMock.mockResolvedValueOnce({ code: 0, stdout, stderr: "" });
  }
}

beforeEach(() => {
  brewPrefix = tempDirs.make("openclaw-imsg-brew-");
  cliPath = path.join(brewPrefix, "bin", "imsg");
  cellar = path.join(brewPrefix, "Cellar");
  setProcessPlatform("darwin");
  resolveBrewExecutableMock.mockReturnValue("/opt/homebrew/bin/brew");
});

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  vi.clearAllMocks();
});

it.each([false, true])("installs with Homebrew (upgrade=%s)", async (upgrade) => {
  const formulaCliPath = path.join(cellar, "imsg", "0.13.1", "bin", "imsg");
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
  expect(commands().slice(upgrade ? 3 : 0, -1)).toEqual(
    (upgrade ? [["update"], ["upgrade", "imsg"]] : [["install", "steipete/tap/imsg"]]).map((args) =>
      ["/opt/homebrew/bin/brew"].concat(args),
    ),
  );
});

it.each([false, true])("preserves unmanaged imsg (installed=%s)", async (installed) => {
  await writeCli(cliPath);
  await fs.mkdir(path.join(cellar, "imsg"), { recursive: true });
  mockCommandOutputs(
    ...(installed ? ["steipete/tap/imsg\n", `${cliPath}\n`, `${cellar}\n`] : ["wget\n"]),
  );

  expect(await install(true)).toEqual({ ok: true });
  expect(commands()).not.toContainEqual(["/opt/homebrew/bin/brew", "update"]);
  expect(commands()).not.toContainEqual(["/opt/homebrew/bin/brew", "upgrade", "imsg"]);
});

it.each([
  ["darwin", expect.stringContaining("Homebrew is required for imsg setup")],
  ["linux", "imsg auto-install is supported only on macOS."],
] as const)("rejects setup without prerequisites on %s", async (platform, error) => {
  setProcessPlatform(platform);
  resolveBrewExecutableMock.mockReturnValue(null);
  expect(await install()).toEqual({ ok: false, error });
  expect(runCommandMock).not.toHaveBeenCalled();
});

it("keeps the Homebrew error after long warnings", async () => {
  const stderr = `Warning: ${"w".repeat(300)}\nError: imsg: no bottle available!`;
  runCommandMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr });
  expect(await install()).toEqual({
    ok: false,
    error: `brew install steipete/tap/imsg failed (exit 1): ...${"w".repeat(166)}\nError: imsg: no bottle available!`,
  });
});

it("redacts credentials before selecting the Homebrew error tail", async () => {
  const secret = "synthetic-brew-credential-".repeat(20);
  const stderr = `Warning: ${"w".repeat(300)}\ntoken=${secret}\nError: imsg: unavailable!`;
  runCommandMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr });
  const result = await install();
  expect(result.ok).toBe(false);
  expect(result.error).toContain("Error: imsg: unavailable!");
  expect(result.error).toContain("token=synthe…ial-");
  expect(result.error).not.toContain(secret.slice(-100));
});

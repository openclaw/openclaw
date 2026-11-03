import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const spawnMock = vi.hoisted(() => vi.fn());
const getActiveSkillEnvKeysCore = vi.hoisted(() => vi.fn<() => string[]>(() => []));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
// mock-isolation: The spawn fixture must not mutate the host PATH.
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
// mock-isolation: Supply synthetic skill keys without loading an admitted run's environment.
vi.mock("../skills/runtime/env-overrides.js", () => ({
  getActiveSkillEnvKeysCore,
}));
vi.mock("../secrets/provider-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/provider-env-vars.js")>()),
  listKnownProviderAuthEnvVarNamesCore: () => ["ACP_FIXTURE_API_KEY"],
}));

import { runAcpClientInteractive } from "./client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = [...process.argv];
const originalEnv = process.env;
const originalProcess = process;
const stopBeforeHandshake = new Error("fixture stops at the ACP spawn boundary");

function standalone(argv1?: string) {
  vi.stubGlobal(
    "__openclawStandaloneRootUrl",
    pathToFileURL(tempDirs.make("openclaw-acp-standalone-")).href,
  );
  process.argv = argv1 ? [process.execPath, argv1] : [process.execPath];
}

async function expectInvocation(
  options: Parameters<typeof runAcpClientInteractive>[0],
  command: string,
  args: string[],
  env?: Record<string, unknown>,
) {
  await expect(runAcpClientInteractive(options)).rejects.toBe(stopBeforeHandshake);
  expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
    command,
    args,
    env ? expect.objectContaining({ env }) : expect.any(Object),
  );
}

beforeEach(() => {
  process.env = { PATH: "/usr/bin:/bin" };
  getActiveSkillEnvKeysCore.mockReset().mockReturnValue([]);
  spawnMock.mockReset().mockImplementation(() => {
    throw stopBeforeHandshake;
  });
});

afterEach(() => {
  originalProcess.argv = [...originalArgv];
  originalProcess.env = originalEnv;
  vi.unstubAllGlobals();
});

it("pins a loose entry symlink before the ACP arguments", async () => {
  const entry = path.join(tempDirs.make("openclaw-acp-loose-"), "openclaw.mjs");
  await writeFile(entry, "export {};\n");
  const link = path.join(path.dirname(entry), "current.mjs");
  await symlink(entry, link);
  process.argv = [process.execPath, link];

  await expectInvocation({ serverVerbose: true }, process.execPath, [entry, "acp", "--verbose"]);
});

it.each([
  { server: "default", strip: true },
  { server: "self", strip: true },
  { server: "custom", strip: false },
])("scrubs the actual $server server environment", async ({ server, strip }) => {
  standalone(server === "default" ? "/$bunfs/root/openclaw" : undefined);
  process.env = {
    PATH: "/usr/bin",
    SKILL_SECRET: "skill-fixture",
    OPENCLAW_SHELL: "skill-overridden",
    ACP_FIXTURE_API_KEY: "provider-fixture",
    OPENCLAW_API_KEY: "keep-me",
  };
  getActiveSkillEnvKeysCore.mockReturnValue(["SKILL_SECRET", "OPENCLAW_SHELL"]);

  await expectInvocation(
    {
      serverCommand:
        server === "default" ? undefined : server === "self" ? process.execPath : "custom-acp",
      serverArgs: server === "custom" ? ["--custom"] : [],
      serverVerbose: true,
    },
    server === "custom" ? "custom-acp" : process.execPath,
    server === "custom" ? ["acp", "--custom", "--verbose"] : ["acp", "--verbose"],
    {
      PATH: "/usr/bin",
      OPENCLAW_SHELL: "acp-client",
      OPENCLAW_API_KEY: "keep-me",
      ...(strip ? {} : { ACP_FIXTURE_API_KEY: "provider-fixture" }),
    },
  );
});

it("rejects unresolved Windows wrappers before spawning a shell", async () => {
  const dir = tempDirs.make("openclaw-acp-client-test-");
  const shimPath = path.join(dir, "openclaw.cmd");
  await writeFile(shimPath, "@ECHO off\r\necho wrapper\r\n", "utf8");
  vi.stubGlobal(
    "process",
    Object.create(process, {
      platform: { value: "win32" },
      execPath: { value: "C:\\node\\node.exe" },
      env: { value: { PATH: dir, PATHEXT: ".CMD;.EXE;.BAT" } },
    }),
  );

  await expect(runAcpClientInteractive({ serverCommand: shimPath })).rejects.toThrow(
    /without shell execution/,
  );
  expect(spawnMock).not.toHaveBeenCalled();
});

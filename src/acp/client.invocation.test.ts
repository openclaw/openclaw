import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
// mock-isolation: The spawn fixture must not mutate the host PATH.
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
// mock-isolation: Active skill environment belongs to an admitted run, absent in this spawn fixture.
vi.mock("../skills/runtime/env-overrides.js", () => ({
  getActiveSkillEnvKeysCore: () => [],
}));
vi.mock("../secrets/provider-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../secrets/provider-env-vars.js")>()),
  listKnownProviderAuthEnvVarNamesCore: () => ["ACP_FIXTURE_API_KEY"],
}));

import { runAcpClientInteractive } from "./client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = [...process.argv];
const originalEnv = process.env;
const stopBeforeHandshake = new Error("fixture stops at the ACP spawn boundary");

describe("ACP client self-invocation", () => {
  beforeEach(() => {
    process.env = { PATH: "/usr/bin:/bin", ACP_FIXTURE_API_KEY: "fixture-provider-key" };
    spawnMock.mockReset().mockImplementation(() => {
      throw stopBeforeHandshake;
    });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it.each([undefined, "/$bunfs/root/openclaw"])(
    "uses the standalone executable without a loose entry (argv1=%s)",
    async (argv1) => {
      const runtime = tempDirs.make("openclaw-acp-standalone-");
      vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL(runtime).href);
      process.argv = argv1 ? [process.execPath, argv1] : [process.execPath];

      await expect(runAcpClientInteractive({ serverVerbose: true })).rejects.toBe(
        stopBeforeHandshake,
      );
      expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
        process.execPath,
        ["acp", "--verbose"],
        expect.objectContaining({
          env: expect.not.objectContaining({ ACP_FIXTURE_API_KEY: expect.anything() }),
        }),
      );
    },
  );

  it("keeps an explicit ACP server command in a standalone process", async () => {
    const runtime = tempDirs.make("openclaw-acp-override-");
    vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL(runtime).href);
    process.argv = [process.execPath, "/$bunfs/root/openclaw"];

    await expect(
      runAcpClientInteractive({ serverCommand: "custom-acp", serverArgs: ["--custom"] }),
    ).rejects.toBe(stopBeforeHandshake);
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
      "custom-acp",
      ["acp", "--custom"],
      expect.objectContaining({
        env: expect.objectContaining({ ACP_FIXTURE_API_KEY: "fixture-provider-key" }),
      }),
    );
  });

  it("keeps the loose entry before the ACP arguments", async () => {
    const entry = path.join(tempDirs.make("openclaw-acp-loose-"), "openclaw.mjs");
    await writeFile(entry, "export {};\n");
    process.argv = [process.execPath, entry];

    await expect(runAcpClientInteractive({ serverVerbose: true })).rejects.toBe(
      stopBeforeHandshake,
    );
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [entry, "acp", "--verbose"],
      expect.any(Object),
    );
  });
});

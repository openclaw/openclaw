import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACPX_LOCAL_INSTALL_COMMAND,
  ACPX_PINNED_VERSION,
  buildAcpxLocalInstallCommand,
} from "./config.js";

const { resolveSpawnFailureMock, spawnAndCollectMock } = vi.hoisted(() => ({
  resolveSpawnFailureMock: vi.fn<
    (error: unknown, cwd: string) => "missing-command" | "missing-cwd" | null
  >(() => null),
  spawnAndCollectMock: vi.fn(),
}));

vi.mock("./runtime-internals/process.js", () => ({
  resolveSpawnFailure: resolveSpawnFailureMock,
  spawnAndCollect: spawnAndCollectMock,
}));

import { checkAcpxVersion, ensureAcpx } from "./ensure.js";

describe("acpx ensure", () => {
  beforeEach(() => {
    resolveSpawnFailureMock.mockReset();
    resolveSpawnFailureMock.mockReturnValue(null);
    spawnAndCollectMock.mockReset();
  });

  it("accepts the pinned acpx version", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: `acpx ${ACPX_PINNED_VERSION}\n`,
      stderr: "",
      code: 0,
      error: null,
    });

    const result = await checkAcpxVersion({
      command: "/plugin/node_modules/.bin/acpx",
      cwd: "/plugin",
      expectedVersion: ACPX_PINNED_VERSION,
    });

    expect(result).toEqual({
      ok: true,
      version: ACPX_PINNED_VERSION,
      expectedVersion: ACPX_PINNED_VERSION,
    });
  });

  it("reports version mismatch", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: "acpx 0.0.9\n",
      stderr: "",
      code: 0,
      error: null,
    });

    const result = await checkAcpxVersion({
      command: "/plugin/node_modules/.bin/acpx",
      cwd: "/plugin",
      expectedVersion: ACPX_PINNED_VERSION,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "version-mismatch",
      expectedVersion: ACPX_PINNED_VERSION,
      installedVersion: "0.0.9",
      installCommand: ACPX_LOCAL_INSTALL_COMMAND,
    });
  });

  it("accepts any installed version when expectedVersion is unset", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: "acpx 9.9.9\n",
      stderr: "",
      code: 0,
      error: null,
    });

    const result = await checkAcpxVersion({
      command: "/custom/acpx",
      cwd: "/custom",
      expectedVersion: undefined,
    });

    expect(result).toEqual({
      ok: true,
      version: "9.9.9",
      expectedVersion: undefined,
    });
  });

  it("installs and verifies pinned acpx when precheck fails", async () => {
    spawnAndCollectMock
      .mockResolvedValueOnce({
        stdout: "acpx 0.0.9\n",
        stderr: "",
        code: 0,
        error: null,
      })
      .mockResolvedValueOnce({
        stdout: "added 1 package\n",
        stderr: "",
        code: 0,
        error: null,
      })
      .mockResolvedValueOnce({
        stdout: `acpx ${ACPX_PINNED_VERSION}\n`,
        stderr: "",
        code: 0,
        error: null,
      });

    await ensureAcpx({
      command: "/plugin/node_modules/.bin/acpx",
      pluginRoot: "/plugin",
      expectedVersion: ACPX_PINNED_VERSION,
    });

    expect(spawnAndCollectMock).toHaveBeenCalledTimes(3);
    expect(spawnAndCollectMock.mock.calls[1]?.[0]).toMatchObject({
      command: "npm",
      args: ["install", "--omit=dev", "--no-save", `acpx@${ACPX_PINNED_VERSION}`],
      cwd: "/plugin",
    });
  });

  it("fails with actionable error when npm install fails", async () => {
    spawnAndCollectMock
      .mockResolvedValueOnce({
        stdout: "acpx 0.0.9\n",
        stderr: "",
        code: 0,
        error: null,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "network down",
        code: 1,
        error: null,
      });

    await expect(
      ensureAcpx({
        command: "/plugin/node_modules/.bin/acpx",
        pluginRoot: "/plugin",
        expectedVersion: ACPX_PINNED_VERSION,
      }),
    ).rejects.toThrow("failed to install plugin-local acpx");
  });

  it("skips install path when allowInstall=false", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      code: 0,
      error: new Error("not found"),
    });
    resolveSpawnFailureMock.mockReturnValue("missing-command");

    await expect(
      ensureAcpx({
        command: "/custom/acpx",
        pluginRoot: "/plugin",
        expectedVersion: undefined,
        allowInstall: false,
      }),
    ).rejects.toThrow("acpx command not found at /custom/acpx");

    expect(spawnAndCollectMock).toHaveBeenCalledTimes(1);
  });

  it("uses expectedVersion for install command metadata", async () => {
    spawnAndCollectMock.mockResolvedValueOnce({
      stdout: "acpx 0.0.9\n",
      stderr: "",
      code: 0,
      error: null,
    });

    const result = await checkAcpxVersion({
      command: "/plugin/node_modules/.bin/acpx",
      cwd: "/plugin",
      expectedVersion: "0.2.0",
    });

    expect(result).toMatchObject({
      ok: false,
      installCommand: buildAcpxLocalInstallCommand("0.2.0"),
    });
  });
});

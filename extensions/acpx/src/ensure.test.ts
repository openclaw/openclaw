import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACPX_LOCAL_INSTALL_COMMAND, ACPX_PINNED_VERSION } from "./config.js";

const { resolveSpawnFailureMock, spawnAndCollectMock } = vi.hoisted(() => ({
  resolveSpawnFailureMock: vi.fn(() => null),
  spawnAndCollectMock: vi.fn(),
}));

vi.mock("./runtime-internals/process.js", () => ({
  resolveSpawnFailure: resolveSpawnFailureMock,
  spawnAndCollect: spawnAndCollectMock,
}));

import { checkPinnedAcpxVersion, ensurePinnedAcpx } from "./ensure.js";

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

    const result = await checkPinnedAcpxVersion({
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

    const result = await checkPinnedAcpxVersion({
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

    await ensurePinnedAcpx({
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
      ensurePinnedAcpx({
        command: "/plugin/node_modules/.bin/acpx",
        pluginRoot: "/plugin",
        expectedVersion: ACPX_PINNED_VERSION,
      }),
    ).rejects.toThrow("failed to install plugin-local acpx");
  });
});

import { access, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureCaptureBinary,
  ensureHelperArtifacts,
  inspectFaceTimeNativePackage,
} from "../src/plugin-paths.js";

vi.mock("node:fs/promises", () => ({ access: vi.fn(), readFile: vi.fn(), readdir: vi.fn() }));

const homebrewDir = "/opt/homebrew/opt/openclaw-facetime/libexec";

describe("plugin paths", () => {
  beforeEach(() => {
    vi.mocked(access)
      .mockReset()
      .mockImplementation(async (path) => {
        if (
          !String(path).startsWith(homebrewDir) &&
          !String(path).endsWith("FaceTimeHelper.dylib")
        ) {
          throw new Error("missing");
        }
      });
    vi.mocked(readFile)
      .mockReset()
      .mockImplementation(async (path) =>
        typeof path === "string" && path.endsWith("native-protocol.env")
          ? "NATIVE_PROTOCOL_VERSION=1\n"
          : `${"b".repeat(64)}\n`,
      );
  });

  it("inspects native package readiness without staging runtime artifacts", async () => {
    await expect(inspectFaceTimeNativePackage()).resolves.toBe(true);
    vi.mocked(access).mockRejectedValue(new Error("missing"));
    await expect(inspectFaceTimeNativePackage()).resolves.toBe(false);
  });

  it("rejects an incompatible native protocol", async () => {
    vi.mocked(readFile).mockImplementation(async (path) =>
      typeof path === "string" && path.endsWith("native-protocol.env")
        ? "NATIVE_PROTOCOL_VERSION=2\n"
        : `${"b".repeat(64)}\n`,
    );
    await expect(ensureCaptureBinary()).rejects.toThrow(
      "Compatible FaceTime native helpers are not installed. Run: brew install openclaw/tap/openclaw-facetime",
    );
  });

  it("stages and validates the installed injected helper", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await expect(
      ensureHelperArtifacts({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as never,
      }),
    ).resolves.toMatchObject({ buildId: "b".repeat(64), ipcKey: "b".repeat(64) });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/stage-helper.sh", "--if-needed"],
      { timeoutMs: 120_000 },
    );
  });
});

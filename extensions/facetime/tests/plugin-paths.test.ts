import { describe, expect, it, vi } from "vitest";
import {
  ensureCaptureBinary,
  ensureHelperArtifacts,
  inspectFaceTimeNativePackage,
} from "../src/plugin-paths.js";

const homebrewDir = "/opt/homebrew/opt/openclaw-facetime/libexec";

function installedAccess() {
  return vi.fn(async (path: string) => {
    if (!path.startsWith(homebrewDir) && !path.endsWith("FaceTimeHelper.dylib")) {
      throw new Error("missing");
    }
  });
}

function installedReadFile() {
  return vi.fn(async (path: string) => {
    if (path.endsWith("native-protocol.env")) {
      return "NATIVE_PROTOCOL_VERSION=1\n";
    }
    return `${"b".repeat(64)}\n`;
  });
}

describe("plugin paths", () => {
  it("inspects native package readiness without staging runtime artifacts", async () => {
    await expect(
      inspectFaceTimeNativePackage({
        access: installedAccess() as never,
        readFile: installedReadFile() as never,
      }),
    ).resolves.toBe(true);
    await expect(
      inspectFaceTimeNativePackage({
        access: vi.fn().mockRejectedValue(new Error("missing")) as never,
        readFile: installedReadFile() as never,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an incompatible native protocol", async () => {
    const readFile = vi.fn(async (path: string) =>
      path.endsWith("native-protocol.env") ? "NATIVE_PROTOCOL_VERSION=2\n" : `${"b".repeat(64)}\n`,
    );
    await expect(
      ensureCaptureBinary({ access: installedAccess() as never, readFile: readFile as never }),
    ).rejects.toThrow(
      "Compatible FaceTime native helpers are not installed. Run: brew install openclaw/tap/openclaw-facetime",
    );
  });

  it("stages and validates the installed injected helper", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await expect(
      ensureHelperArtifacts({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as never,
        access: installedAccess() as never,
        readFile: installedReadFile() as never,
      }),
    ).resolves.toMatchObject({ buildId: "b".repeat(64), ipcKey: "b".repeat(64) });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/stage-helper.sh", "--if-needed"],
      { timeoutMs: 120_000 },
    );
  });
});

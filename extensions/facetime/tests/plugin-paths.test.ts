import { describe, expect, it, vi } from "vitest";
import {
  ensureCaptureBinary,
  ensureHelperArtifacts,
  resolveCaptureBinary,
  resolvePluginRoot,
} from "../src/plugin-paths.js";

describe("plugin paths", () => {
  it("resolves source and built entries to the same package root", () => {
    expect(resolvePluginRoot("file:///tmp/facetime/index.ts")).toBe("/tmp/facetime");
    expect(resolvePluginRoot("file:///tmp/facetime/dist/index.js")).toBe("/tmp/facetime");
    expect(resolveCaptureBinary("/tmp/facetime")).toBe(
      "/tmp/facetime/native/.build/release/facetime-audio-capture",
    );
  });

  it("builds the packaged capture helper on first activation", async () => {
    const access = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(undefined);
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });

    await expect(
      ensureCaptureBinary({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as any,
        access,
      }),
    ).resolves.toBe("/tmp/facetime/native/.build/release/facetime-audio-capture");
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/build-capture.sh"],
      { timeoutMs: 120_000 },
    );
    expect(access).toHaveBeenCalledTimes(2);
  });

  it("builds and validates the packaged injected helper on activation", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const access = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn().mockResolvedValue("b".repeat(64));

    await expect(
      ensureHelperArtifacts({
        pluginRoot: "/tmp/facetime",
        runCommandWithTimeout: runCommandWithTimeout as any,
        access,
        readFile: readFile as any,
      }),
    ).resolves.toMatchObject({
      buildId: "b".repeat(64),
      ipcKey: "b".repeat(64),
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["/bin/bash", "/tmp/facetime/scripts/build-helper-macabi.sh", "--if-needed"],
      { timeoutMs: 120_000 },
    );
  });
});

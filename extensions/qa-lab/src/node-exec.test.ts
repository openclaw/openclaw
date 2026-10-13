// Qa Lab tests cover node exec plugin behavior.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runExecMock } = vi.hoisted(() => ({ runExecMock: vi.fn() }));

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runExec: runExecMock }));

import { resolveQaNodeExecPath } from "./node-exec.js";

describe("resolveQaNodeExecPath", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  it("reuses nodejs as a valid current Node executable", async () => {
    await expect(
      resolveQaNodeExecPath({
        execPath: "/usr/bin/nodejs",
        platform: "linux",
        versions: { ...process.versions, bun: undefined },
      }),
    ).resolves.toBe("/usr/bin/nodejs");
    expect(runExecMock).not.toHaveBeenCalled();
  });

  it("uses trusted Windows where.exe when resolving node from PATH", async () => {
    runExecMock.mockResolvedValueOnce({
      stdout: String.raw`D:\nodejs\node.exe` + "\r\n",
      stderr: "",
    });
    await expect(
      resolveQaNodeExecPath({
        execPath: String.raw`D:\Tools\bun.exe`,
        platform: "win32",
        versions: { ...process.versions, bun: "1.2.3" },
        env: { SystemRoot: String.raw`D:\Windows` },
      }),
    ).resolves.toBe(String.raw`D:\nodejs\node.exe`);
    expect(runExecMock).toHaveBeenCalledWith(
      path.win32.join(String.raw`D:\Windows`, "System32", "where.exe"),
      ["node"],
      { baseEnv: { SystemRoot: String.raw`D:\Windows` }, logOutput: false, timeoutMs: 5_000 },
    );
  });

  it("throws a clear error when node is unavailable", async () => {
    runExecMock.mockRejectedValueOnce(new Error("missing"));
    await expect(
      resolveQaNodeExecPath({
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
        versions: { ...process.versions, bun: "1.2.3" },
      }),
    ).rejects.toThrow("Node not found in PATH");
  });
});

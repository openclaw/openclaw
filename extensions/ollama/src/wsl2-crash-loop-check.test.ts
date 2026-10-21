import { beforeEach, describe, expect, it, vi } from "vitest";

const { isWSL2SyncMock, runExecMock } = vi.hoisted(() => ({
  isWSL2SyncMock: vi.fn(() => false),
  runExecMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({ isWSL2Sync: isWSL2SyncMock }));
vi.mock("node:fs/promises", () => ({ access: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runExec: runExecMock }));

import { access } from "node:fs/promises";
import { checkWsl2CrashLoopRisk } from "./wsl2-crash-loop-check.js";

const accessMock = vi.mocked(access);
const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

async function check() {
  await checkWsl2CrashLoopRisk(logger);
  return logger;
}

function mockSystemctl(stdout: string): void {
  runExecMock.mockResolvedValue({ stdout, stderr: "" });
}

describe("wsl2 crash-loop check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isWSL2SyncMock.mockReturnValue(true);
  });

  it("warns for WSL2 plus Ollama autostart plus CUDA", async () => {
    mockSystemctl("IgnoredLine\nUnitFileState=enabled\nRestart=always\n");
    accessMock.mockResolvedValueOnce(undefined);
    await check();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(logger.warn.mock.calls.at(0)?.[0]);
    expect(message).toContain("WSL2 crash-loop risk");
    expect(message).toContain("sudo systemctl disable ollama");
    expect(message).toContain("autoMemoryReclaim=disabled");
    expect(message).toContain("OLLAMA_KEEP_ALIVE=5m");
    expect(runExecMock).toHaveBeenCalledWith(
      "systemctl",
      ["show", "ollama.service", "--property=UnitFileState,Restart", "--no-pager"],
      { logOutput: false, timeoutMs: 5000 },
    );
    expect(accessMock).toHaveBeenCalledWith("/dev/dxg");
  });

  it("does not probe systemd outside WSL2", async () => {
    isWSL2SyncMock.mockReturnValue(false);
    expect((await check()).warn).not.toHaveBeenCalled();
    expect(runExecMock).not.toHaveBeenCalled();
  });

  it("does not warn when CUDA is not visible", async () => {
    mockSystemctl("UnitFileState=enabled\nRestart=always\n");
    accessMock.mockRejectedValue(new Error("missing"));
    expect((await check()).warn).not.toHaveBeenCalled();
    expect(accessMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    "UnitFileState=enabled-runtime\nRestart=always\n",
    "UnitFileState=enabled\nRestart=on-failure\n",
  ])("does not warn when the Ollama service is not persistent Restart=always", async (stdout) => {
    mockSystemctl(stdout);
    accessMock.mockResolvedValueOnce(undefined);
    expect((await check()).warn).not.toHaveBeenCalled();
    expect(accessMock).not.toHaveBeenCalled();
  });

  it("never throws from advisory checks", async () => {
    runExecMock.mockRejectedValue(new Error("boom"));
    await expect(checkWsl2CrashLoopRisk(logger)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

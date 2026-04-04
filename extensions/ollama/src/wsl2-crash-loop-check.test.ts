import { describe, expect, it, vi, afterEach } from "vitest";

// Mock node:fs/promises and node:child_process BEFORE importing the module under test.
// Do NOT mock node:util — real promisify must wrap the mocked execFile.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import {
  checkWsl2CrashLoopRisk,
  isWsl2,
  isOllamaEnabledWithRestartAlways,
} from "./wsl2-crash-loop-check.js";

const readFileMock = vi.mocked(fs.readFile);
const accessMock = vi.mocked(fs.access);
// execFile is callback-based; promisify wraps it, so mock must use the callback style
const execFileMock = vi.mocked(childProcess.execFile);

// Helper: make execFile callback succeed with the given stdout
function mockExecFileOk(stdout: string) {
  execFileMock.mockImplementation(((
    _cmd: unknown,
    _args: unknown,
    _opts: unknown,
    cb: (err: null, r: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr: "" });
  }) as never);
}

// Helper: make execFile callback fail
function mockExecFileFail() {
  execFileMock.mockImplementation(((
    _cmd: unknown,
    _args: unknown,
    _opts: unknown,
    cb: (err: Error) => void,
  ) => {
    cb(new Error("command not found"));
  }) as never);
}

describe("isWsl2", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns true when /proc/version contains microsoft and WSL2", async () => {
    readFileMock.mockResolvedValue(
      "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...)" as never,
    );
    expect(await isWsl2()).toBe(true);
  });

  it("returns false on bare Linux (no microsoft)", async () => {
    readFileMock.mockResolvedValue("Linux version 6.1.0-debian-amd64 (gcc ...)" as never);
    expect(await isWsl2()).toBe(false);
  });

  it("returns false on WSL1 (microsoft present but no WSL2)", async () => {
    readFileMock.mockResolvedValue("Linux version 4.4.0-microsoft-standard (gcc ...)" as never);
    expect(await isWsl2()).toBe(false);
  });

  it("returns false when /proc/version is unreadable", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT") as never);
    expect(await isWsl2()).toBe(false);
  });
});

describe("isOllamaEnabledWithRestartAlways", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns true when UnitFileState=enabled and Restart=always", async () => {
    mockExecFileOk("UnitFileState=enabled\nRestart=always\n");
    expect(await isOllamaEnabledWithRestartAlways()).toBe(true);
  });

  it("returns false when UnitFileState=disabled", async () => {
    mockExecFileOk("UnitFileState=disabled\nRestart=always\n");
    expect(await isOllamaEnabledWithRestartAlways()).toBe(false);
  });

  it("returns false when Restart=on-failure", async () => {
    mockExecFileOk("UnitFileState=enabled\nRestart=on-failure\n");
    expect(await isOllamaEnabledWithRestartAlways()).toBe(false);
  });

  it("returns false when systemctl fails (not installed)", async () => {
    mockExecFileFail();
    expect(await isOllamaEnabledWithRestartAlways()).toBe(false);
  });
});

describe("checkWsl2CrashLoopRisk", () => {
  afterEach(() => vi.clearAllMocks());

  it("emits warn when WSL2 + enabled + Restart=always", async () => {
    readFileMock.mockResolvedValue(
      "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...)" as never,
    );
    mockExecFileOk("UnitFileState=enabled\nRestart=always\n");
    // No CUDA (access throws)
    accessMock.mockRejectedValue(new Error("ENOENT") as never);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await checkWsl2CrashLoopRisk(logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const msg = logger.warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain("WSL2 crash loop risk");
    expect(msg).toContain("sudo systemctl disable ollama");
    expect(msg).toContain("autoMemoryReclaim=disabled");
    expect(msg).toContain("OLLAMA_KEEP_ALIVE=5m");
  });

  it("does NOT emit warn when not on WSL2", async () => {
    readFileMock.mockResolvedValue("Linux version 6.1.0-debian-amd64 (gcc ...)" as never);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await checkWsl2CrashLoopRisk(logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does NOT emit warn when WSL2 but ollama not enabled", async () => {
    readFileMock.mockResolvedValue(
      "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...)" as never,
    );
    mockExecFileOk("UnitFileState=disabled\nRestart=always\n");

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await checkWsl2CrashLoopRisk(logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does NOT throw and does NOT warn when readFile fails", async () => {
    readFileMock.mockRejectedValue(new Error("EACCES") as never);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await expect(checkWsl2CrashLoopRisk(logger)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does NOT throw and does NOT warn when execFile fails", async () => {
    readFileMock.mockResolvedValue(
      "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...)" as never,
    );
    mockExecFileFail();

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await expect(checkWsl2CrashLoopRisk(logger)).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("includes CUDA note when nvidia-smi is present", async () => {
    readFileMock.mockResolvedValue(
      "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...)" as never,
    );
    mockExecFileOk("UnitFileState=enabled\nRestart=always\n");
    // Make /usr/lib/wsl/lib/nvidia-smi accessible
    accessMock.mockResolvedValue(undefined as never);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await checkWsl2CrashLoopRisk(logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0] as string).toContain("CUDA installation detected");
  });
});

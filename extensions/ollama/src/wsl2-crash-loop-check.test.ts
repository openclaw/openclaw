import { promisify } from "node:util";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

// Mock node:fs/promises BEFORE importing the module under test.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}));

// Create a mock execFile with util.promisify.custom support.
// vi.mock factory must not reference outer scope, so we build the mock inline.
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify: realPromisify } = await import("node:util");
  const mockFn = vi.fn();
  // Attach the promisify.custom symbol so util.promisify returns our async mock
  const asyncMock = vi.fn();
  (mockFn as unknown as Record<symbol, unknown>)[realPromisify.custom] = asyncMock;
  return { execFile: mockFn };
});

import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import {
  checkWsl2CrashLoopRisk,
  hasCuda,
  isWsl2,
  isOllamaEnabledWithRestartAlways,
} from "./wsl2-crash-loop-check.js";

const readFileMock = vi.mocked(fs.readFile);
const accessMock = vi.mocked(fs.access);
// Access the promisify.custom mock from the mocked execFile
const execFileMock = childProcess.execFile as unknown as ReturnType<typeof vi.fn> & {
  [key: symbol]: ReturnType<typeof vi.fn>;
};
const execFilePromiseMock = vi.mocked(execFileMock[promisify.custom]);

// Helper: make execFile resolve with the given stdout
function mockExecFileOk(stdout: string) {
  execFilePromiseMock.mockResolvedValue({ stdout, stderr: "" });
}

// Helper: make execFile reject
function mockExecFileFail() {
  execFilePromiseMock.mockRejectedValue(new Error("command not found"));
}

describe("isWsl2", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("returns true when /proc/version contains wsl2 or microsoft-standard", async () => {
    readFileMock.mockResolvedValue(
      "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...)" as never,
    );
    expect(await isWsl2()).toBe(true);
  });

  it("returns false on bare Linux (no microsoft)", async () => {
    readFileMock.mockResolvedValue("Linux version 6.1.0-debian-amd64 (gcc ...)" as never);
    expect(await isWsl2()).toBe(false);
  });

  it("returns false on WSL1 (microsoft present but no WSL2 or microsoft-standard)", async () => {
    readFileMock.mockResolvedValue("Linux version 4.4.0-microsoft (gcc ...)" as never);
    expect(await isWsl2()).toBe(false);
  });

  it("returns true when osrelease contains microsoft-standard (no WSL2 suffix)", async () => {
    readFileMock.mockResolvedValue("Linux version 5.15.0-microsoft-standard (gcc ...)" as never);
    expect(await isWsl2()).toBe(true);
  });

  it("returns false when /proc/version is unreadable", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT") as never);
    expect(await isWsl2()).toBe(false);
  });
});

describe("hasCuda", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns true when /usr/lib/wsl/lib/nvidia-smi exists", async () => {
    accessMock.mockResolvedValueOnce(undefined as never);
    expect(await hasCuda()).toBe(true);
    expect(accessMock).toHaveBeenCalledTimes(1);
    expect(accessMock).toHaveBeenCalledWith("/usr/lib/wsl/lib/nvidia-smi");
  });

  it("returns true via fallback when /usr/local/cuda exists but nvidia-smi does not", async () => {
    accessMock
      .mockRejectedValueOnce(new Error("ENOENT") as never) // nvidia-smi fails
      .mockResolvedValueOnce(undefined as never); // /usr/local/cuda succeeds
    expect(await hasCuda()).toBe(true);
    expect(accessMock).toHaveBeenCalledTimes(2);
    expect(accessMock).toHaveBeenNthCalledWith(1, "/usr/lib/wsl/lib/nvidia-smi");
    expect(accessMock).toHaveBeenNthCalledWith(2, "/usr/local/cuda");
  });

  it("returns false when neither path exists", async () => {
    accessMock.mockRejectedValue(new Error("ENOENT") as never);
    expect(await hasCuda()).toBe(false);
    expect(accessMock).toHaveBeenCalledTimes(2);
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the @boxlite-ai/boxlite NAPI module before importing runtime.
const mockExec = vi.fn();
const mockCopyIn = vi.fn();
const mockCopyOut = vi.fn();
const mockStop = vi.fn();

class MockSimpleBox {
  exec = mockExec;
  copyIn = mockCopyIn;
  copyOut = mockCopyOut;
  stop = mockStop;
}

vi.mock("@boxlite-ai/boxlite", () => ({
  SimpleBox: MockSimpleBox,
}));

// Use dynamic import so the mock is in place before the module loads.
const {
  ensureBoxLiteBox,
  runBoxLiteCommand,
  stopBoxLiteBox,
  stopAllBoxLiteBoxes,
  getActiveBoxLiteBoxCount,
  isBoxLiteAvailable,
  resolveBoxLiteWorkdir,
} = await import("./runtime.js");

describe("BoxLite runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mockCopyIn.mockResolvedValue(undefined);
    mockCopyOut.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await stopAllBoxLiteBoxes();
  });

  it("isBoxLiteAvailable returns true when module is present", async () => {
    expect(await isBoxLiteAvailable()).toBe(true);
  });

  it("resolveBoxLiteWorkdir returns default when no config", () => {
    expect(resolveBoxLiteWorkdir()).toBe("/workspace");
  });

  it("resolveBoxLiteWorkdir returns configured workdir", () => {
    expect(resolveBoxLiteWorkdir({ workdir: "/app" })).toBe("/app");
  });

  it("creates a box on first call and reuses on second", async () => {
    const handle1 = await ensureBoxLiteBox("test-scope-1");
    expect(getActiveBoxLiteBoxCount()).toBe(1);

    const handle2 = await ensureBoxLiteBox("test-scope-1");
    // Reused existing box — same handle returned.
    expect(handle1).toBe(handle2);
    expect(getActiveBoxLiteBoxCount()).toBe(1);
  });

  it("runs setup command when configured", async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });

    await ensureBoxLiteBox("test-setup", {
      setupCommand: "apt-get update",
    });

    expect(mockExec).toHaveBeenCalledWith("sh", "-c", "apt-get update");
  });

  it("skips setup command when blank", async () => {
    await ensureBoxLiteBox("test-no-setup", { setupCommand: "  " });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("runBoxLiteCommand delegates to handle.run", async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: "hello", stderr: "" });

    await ensureBoxLiteBox("test-run");
    const result = await runBoxLiteCommand("test-run", "echo", ["hello"]);

    expect(result).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
    expect(mockExec).toHaveBeenCalledWith("echo", "hello");
  });

  it("runBoxLiteCommand throws when box not found", async () => {
    await expect(runBoxLiteCommand("nonexistent", "echo", [])).rejects.toThrow(
      "BoxLite box not found for scope key: nonexistent",
    );
  });

  it("stopBoxLiteBox removes box and calls stop", async () => {
    await ensureBoxLiteBox("test-stop");
    expect(getActiveBoxLiteBoxCount()).toBe(1);

    await stopBoxLiteBox("test-stop");
    expect(getActiveBoxLiteBoxCount()).toBe(0);
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("stopBoxLiteBox is idempotent for unknown keys", async () => {
    await stopBoxLiteBox("unknown-key");
    expect(mockStop).not.toHaveBeenCalled();
  });

  it("stopAllBoxLiteBoxes cleans up all boxes", async () => {
    await ensureBoxLiteBox("box-a");
    await ensureBoxLiteBox("box-b");
    expect(getActiveBoxLiteBoxCount()).toBe(2);

    await stopAllBoxLiteBoxes();
    expect(getActiveBoxLiteBoxCount()).toBe(0);
    expect(mockStop).toHaveBeenCalledTimes(2);
  });

  it("cleans up VM when setup command throws", async () => {
    mockExec.mockRejectedValueOnce(new Error("setup failed"));

    await expect(ensureBoxLiteBox("test-setup-fail", { setupCommand: "bad-cmd" })).rejects.toThrow(
      "setup failed",
    );

    // VM should be cleaned up — not left in registry.
    expect(getActiveBoxLiteBoxCount()).toBe(0);
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("cleans up VM when setup command exits non-zero", async () => {
    mockExec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "pkg not found" });

    await expect(
      ensureBoxLiteBox("test-setup-nonzero", { setupCommand: "apt-get install missing" }),
    ).rejects.toThrow("BoxLite setup command failed with exit code 1: pkg not found");

    expect(getActiveBoxLiteBoxCount()).toBe(0);
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent creation for the same scope key", async () => {
    // Both calls start before either finishes — second should join first's in-flight promise.
    const p1 = ensureBoxLiteBox("concurrent-key");
    const p2 = ensureBoxLiteBox("concurrent-key");

    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1).toBe(h2);
    expect(getActiveBoxLiteBoxCount()).toBe(1);
  });
});

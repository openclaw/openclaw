import { describe, it, expect, vi } from "vitest";
import { AgentRepositoryImpl } from "../agent-repository.ts";

// Helper: mock exec function
const createMockExec = () =>
  vi.fn<
    (options: {
      argv: string[];
      timeoutMs: number;
    }) => Promise<{ code: number; stdout: string; stderr: string }>
  >();

describe("AgentRepository", () => {
  it("builds correct argv with message and --deliver flag", async () => {
    const mockExec = createMockExec();
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const repo = new AgentRepositoryImpl(mockExec);

    await repo.send("A meeting was detected");

    expect(mockExec).toHaveBeenCalledWith({
      argv: [
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--message",
        "A meeting was detected",
        "--deliver",
      ],
      timeoutMs: 120_000,
    });
  });

  it("returns success when exec exits with code 0", async () => {
    const mockExec = createMockExec();
    mockExec.mockResolvedValueOnce({ code: 0, stdout: "ok", stderr: "" });
    const repo = new AgentRepositoryImpl(mockExec);

    const result = await repo.send("test message");

    expect(result).toEqual({ success: true });
  });

  it("returns error when exec exits with non-zero code", async () => {
    const mockExec = createMockExec();
    mockExec.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "agent not found" });
    const repo = new AgentRepositoryImpl(mockExec);

    const result = await repo.send("test message");

    expect(result).toEqual({ success: false, error: "agent not found" });
  });

  it("returns error when exec throws", async () => {
    const mockExec = createMockExec();
    mockExec.mockRejectedValueOnce(new Error("command timed out after 120000ms"));
    const repo = new AgentRepositoryImpl(mockExec);

    const result = await repo.send("test message");

    expect(result).toEqual({ success: false, error: "command timed out after 120000ms" });
  });
});

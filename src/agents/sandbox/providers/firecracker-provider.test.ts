import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock gRPC client module
const mockSandboxClient = {
  createSandbox: vi.fn(),
  destroySandbox: vi.fn(),
  sandboxStatus: vi.fn(),
  listSandboxes: vi.fn(),
};

const mockExecClient = {
  exec: vi.fn(),
};

const mockHealthClient = { check: vi.fn() };

vi.mock("../grpc/client.js", () => ({
  createSandboxClient: vi.fn(() => mockSandboxClient),
  createExecClient: vi.fn(() => mockExecClient),
  createHealthClient: vi.fn(() => mockHealthClient),
}));

// Mock health module
const mockCheckHealth = vi.fn();
vi.mock("../grpc/health.js", () => ({
  checkFirecrackerHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

// Mock errors module -- pass through real implementation
vi.mock("../grpc/errors.js", async () => {
  const actual = await vi.importActual<typeof import("../grpc/errors.js")>("../grpc/errors.js");
  return actual;
});

import { SandboxProviderError } from "../grpc/errors.js";
import type { SandboxConfig } from "../types.js";
import { FirecrackerProvider } from "./firecracker-provider.js";

// SandboxState enum values matching proto
const ProtoState = {
  UNSPECIFIED: 0,
  CREATING: 1,
  RUNNING: 2,
  STOPPED: 3,
  ERROR: 4,
};

describe("FirecrackerProvider", () => {
  let provider: FirecrackerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new FirecrackerProvider();
  });

  it("has name 'firecracker'", () => {
    expect(provider.name).toBe("firecracker");
  });

  describe("checkHealth", () => {
    it("delegates to checkFirecrackerHealth and returns the result", async () => {
      mockCheckHealth.mockResolvedValueOnce({
        available: true,
        message: "Firecracker vm-runner is healthy",
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(true);
      expect(result.message).toBe("Firecracker vm-runner is healthy");
      expect(mockCheckHealth).toHaveBeenCalledWith(mockHealthClient);
    });

    it("returns unavailable when health check fails", async () => {
      mockCheckHealth.mockResolvedValueOnce({
        available: false,
        message: "/dev/kvm not available",
      });

      const result = await provider.checkHealth();

      expect(result.available).toBe(false);
      expect(result.message).toContain("/dev/kvm");
    });
  });

  describe("ensureSandbox", () => {
    it("calls gRPC CreateSandbox and returns the sandbox ID", async () => {
      mockSandboxClient.createSandbox.mockResolvedValueOnce({
        sandboxId: "vm-abc123",
        state: ProtoState.RUNNING,
        createdAt: new Date(),
      });

      const result = await provider.ensureSandbox({
        sessionKey: "session-1",
        workspaceDir: "/workspace",
        agentWorkspaceDir: "/agent-workspace",
        cfg: {} as unknown as SandboxConfig,
      });

      expect(result).toBe("vm-abc123");
      expect(mockSandboxClient.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: "session-1",
        }),
      );
    });

    it("wraps gRPC errors through mapGrpcError", async () => {
      // @ts-expect-error -- nice-grpc is an optional dependency for Firecracker support
      const { ClientError, Status } = await import("nice-grpc");
      mockSandboxClient.createSandbox.mockRejectedValueOnce(
        new ClientError("test.Service", Status.ALREADY_EXISTS, "VM exists"),
      );

      await expect(
        provider.ensureSandbox({
          sessionKey: "session-1",
          workspaceDir: "/workspace",
          agentWorkspaceDir: "/agent-workspace",
          cfg: {} as unknown as SandboxConfig,
        }),
      ).rejects.toThrow(SandboxProviderError);
    });
  });

  describe("exec", () => {
    it("collects streaming output and returns aggregated ExecResult", async () => {
      const chunks = [
        { stdoutData: Buffer.from("hello "), stderrData: undefined, exit: undefined },
        { stdoutData: undefined, stderrData: Buffer.from("warn"), exit: undefined },
        { stdoutData: Buffer.from("world"), stderrData: undefined, exit: undefined },
        { stdoutData: undefined, stderrData: undefined, exit: { exitCode: 0, error: "" } },
      ];

      async function* streamChunks() {
        for (const chunk of chunks) {
          yield chunk;
        }
      }

      mockExecClient.exec.mockReturnValueOnce(streamChunks());

      const result = await provider.exec("vm-abc123", ["ls", "-la"], {
        cwd: "/tmp",
        env: { FOO: "bar" },
        timeout: 5000,
      });

      expect(result.stdout.toString()).toBe("hello world");
      expect(result.stderr.toString()).toBe("warn");
      expect(result.code).toBe(0);

      // Verify exec was called with a request stream (async iterable)
      expect(mockExecClient.exec).toHaveBeenCalledTimes(1);
      const requestStream = mockExecClient.exec.mock.calls[0][0];
      // Consume the request stream to verify its contents
      const requests: unknown[] = [];
      for await (const req of requestStream) {
        requests.push(req);
      }
      expect(requests).toHaveLength(1);
      expect((requests[0] as { start: unknown }).start).toEqual(
        expect.objectContaining({
          sandboxId: "vm-abc123",
          command: ["ls", "-la"],
          workingDir: "/tmp",
          env: { FOO: "bar" },
          timeoutMs: 5000,
        }),
      );
    });

    it("returns exit code from final message", async () => {
      async function* streamChunks() {
        yield { stdoutData: Buffer.from("output"), stderrData: undefined, exit: undefined };
        yield { stdoutData: undefined, stderrData: undefined, exit: { exitCode: 42, error: "" } };
      }

      mockExecClient.exec.mockReturnValueOnce(streamChunks());

      const result = await provider.exec("vm-1", ["exit", "42"]);
      expect(result.code).toBe(42);
    });

    it("defaults exit code to -1 when no exit code received", async () => {
      async function* streamChunks() {
        yield { stdoutData: Buffer.from("output"), stderrData: undefined, exit: undefined };
      }

      mockExecClient.exec.mockReturnValueOnce(streamChunks());

      const result = await provider.exec("vm-1", ["cmd"]);
      expect(result.code).toBe(-1);
    });

    it("truncates output at MAX_OUTPUT_BYTES", async () => {
      const bigChunk = Buffer.alloc(6 * 1024 * 1024, "A"); // 6 MiB
      async function* streamChunks() {
        yield { stdoutData: bigChunk, stderrData: undefined, exit: undefined };
        yield { stdoutData: bigChunk, stderrData: undefined, exit: undefined };
        yield { stdoutData: undefined, stderrData: undefined, exit: { exitCode: 0, error: "" } };
      }

      mockExecClient.exec.mockReturnValueOnce(streamChunks());

      const result = await provider.exec("vm-1", ["big-output"]);
      // Total stdout should be capped at 10 MiB
      expect(result.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024);
      expect(result.stderr.toString()).toContain("truncated");
      expect(result.code).toBe(0);
    });

    it("handles empty stream", async () => {
      async function* streamChunks() {
        // empty - no chunks
      }

      mockExecClient.exec.mockReturnValueOnce(streamChunks());

      const result = await provider.exec("vm-1", ["cmd"]);
      expect(result.stdout.length).toBe(0);
      expect(result.stderr.length).toBe(0);
      expect(result.code).toBe(-1);
    });

    it("wraps gRPC errors through mapGrpcError", async () => {
      // @ts-expect-error -- nice-grpc is an optional dependency for Firecracker support
      const { ClientError, Status } = await import("nice-grpc");
      mockExecClient.exec.mockImplementationOnce(() => {
        throw new ClientError("test.Service", Status.INTERNAL, "exec failed");
      });

      await expect(provider.exec("vm-1", ["cmd"])).rejects.toThrow(SandboxProviderError);
    });
  });

  describe("destroy", () => {
    it("calls gRPC DestroySandbox with sandbox ID", async () => {
      mockSandboxClient.destroySandbox.mockResolvedValueOnce({});

      await provider.destroy("vm-abc123");

      expect(mockSandboxClient.destroySandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: "vm-abc123",
          force: false,
        }),
      );
    });

    it("passes force option when specified", async () => {
      mockSandboxClient.destroySandbox.mockResolvedValueOnce({});

      await provider.destroy("vm-abc123", { force: true });

      expect(mockSandboxClient.destroySandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: "vm-abc123",
          force: true,
        }),
      );
    });

    it("wraps gRPC errors through mapGrpcError", async () => {
      // @ts-expect-error -- nice-grpc is an optional dependency for Firecracker support
      const { ClientError, Status } = await import("nice-grpc");
      mockSandboxClient.destroySandbox.mockRejectedValueOnce(
        new ClientError("test.Service", Status.NOT_FOUND, "VM not found"),
      );

      await expect(provider.destroy("vm-unknown")).rejects.toThrow(SandboxProviderError);
    });
  });

  describe("status", () => {
    it("calls gRPC SandboxStatus and maps to SandboxState", async () => {
      mockSandboxClient.sandboxStatus.mockResolvedValueOnce({
        sandboxId: "vm-1",
        state: ProtoState.RUNNING,
      });

      const result = await provider.status("vm-1");

      expect(result).toEqual({ exists: true, running: true });
      expect(mockSandboxClient.sandboxStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: "vm-1" }),
      );
    });

    it("maps stopped state correctly", async () => {
      mockSandboxClient.sandboxStatus.mockResolvedValueOnce({
        sandboxId: "vm-1",
        state: ProtoState.STOPPED,
      });

      const result = await provider.status("vm-1");

      expect(result).toEqual({ exists: true, running: false });
    });

    it("maps unspecified state to non-existent", async () => {
      mockSandboxClient.sandboxStatus.mockResolvedValueOnce({
        sandboxId: "vm-1",
        state: ProtoState.UNSPECIFIED,
      });

      const result = await provider.status("vm-1");

      expect(result).toEqual({ exists: false, running: false });
    });

    it("wraps gRPC errors through mapGrpcError", async () => {
      // @ts-expect-error -- nice-grpc is an optional dependency for Firecracker support
      const { ClientError, Status } = await import("nice-grpc");
      mockSandboxClient.sandboxStatus.mockRejectedValueOnce(
        new ClientError("test.Service", Status.NOT_FOUND, "not found"),
      );

      await expect(provider.status("vm-unknown")).rejects.toThrow(SandboxProviderError);
    });
  });

  describe("list", () => {
    it("calls gRPC ListSandboxes and maps SandboxInfo to SandboxInfo", async () => {
      mockSandboxClient.listSandboxes.mockResolvedValueOnce({
        sandboxes: [
          { sandboxId: "vm-1", state: ProtoState.RUNNING },
          { sandboxId: "vm-2", state: ProtoState.STOPPED },
        ],
      });

      const result = await provider.list();

      expect(result).toEqual([
        {
          containerName: "vm-1",
          sessionKey: "vm-1",
          running: true,
        },
        {
          containerName: "vm-2",
          sessionKey: "vm-2",
          running: false,
        },
      ]);
    });

    it("returns empty array when no sandboxes exist", async () => {
      mockSandboxClient.listSandboxes.mockResolvedValueOnce({ sandboxes: [] });

      const result = await provider.list();

      expect(result).toEqual([]);
    });

    it("wraps gRPC errors through mapGrpcError", async () => {
      // @ts-expect-error -- nice-grpc is an optional dependency for Firecracker support
      const { ClientError, Status } = await import("nice-grpc");
      mockSandboxClient.listSandboxes.mockRejectedValueOnce(
        new ClientError("test.Service", Status.UNAVAILABLE, "unavailable"),
      );

      await expect(provider.list()).rejects.toThrow(SandboxProviderError);
    });
  });
});

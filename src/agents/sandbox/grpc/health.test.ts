import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:fs/promises
const mockAccess = vi.fn();
vi.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => mockAccess(...args),
  constants: { R_OK: 4, W_OK: 2 },
}));

// Mock channel to control VM_RUNNER_SOCKET
vi.mock("./channel.js", () => ({
  VM_RUNNER_SOCKET: "/var/run/openclaw-vm-runner.sock",
}));

import { checkFirecrackerHealth } from "./health.js";

describe("checkFirecrackerHealth", () => {
  let mockHealthClient: { check: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHealthClient = { check: vi.fn() };
  });

  it("returns unavailable when /dev/kvm is not accessible", async () => {
    mockAccess.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await checkFirecrackerHealth(mockHealthClient as any);

    expect(result.available).toBe(false);
    expect(result.message).toContain("/dev/kvm");
    // Should not proceed to check socket or gRPC
    expect(mockHealthClient.check).not.toHaveBeenCalled();
  });

  it("returns unavailable when socket file doesn't exist but /dev/kvm is OK", async () => {
    // /dev/kvm succeeds
    mockAccess.mockResolvedValueOnce(undefined);
    // socket check fails
    mockAccess.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await checkFirecrackerHealth(mockHealthClient as any);

    expect(result.available).toBe(false);
    expect(result.message).toContain("vm-runner socket not found");
    expect(mockHealthClient.check).not.toHaveBeenCalled();
  });

  it("returns unavailable when gRPC health check fails but /dev/kvm and socket are OK", async () => {
    // /dev/kvm succeeds
    mockAccess.mockResolvedValueOnce(undefined);
    // socket succeeds
    mockAccess.mockResolvedValueOnce(undefined);
    // gRPC health check fails
    mockHealthClient.check.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await checkFirecrackerHealth(mockHealthClient as any);

    expect(result.available).toBe(false);
    expect(result.message).toContain("vm-runner health check failed");
  });

  it("returns available when all three checks pass", async () => {
    // /dev/kvm succeeds
    mockAccess.mockResolvedValueOnce(undefined);
    // socket succeeds
    mockAccess.mockResolvedValueOnce(undefined);
    // gRPC health check succeeds
    mockHealthClient.check.mockResolvedValueOnce({ status: 1 });

    const result = await checkFirecrackerHealth(mockHealthClient as any);

    expect(result.available).toBe(true);
    expect(result.message).toBe("Firecracker vm-runner is healthy");
  });

  it("checks run in order: /dev/kvm -> socket -> gRPC (cheapest first)", async () => {
    const callOrder: string[] = [];

    mockAccess.mockImplementation(async (path: string) => {
      if (path === "/dev/kvm") {
        callOrder.push("kvm");
      } else {
        callOrder.push("socket");
      }
    });

    mockHealthClient.check.mockImplementation(async () => {
      callOrder.push("grpc");
      return { status: 1 };
    });

    await checkFirecrackerHealth(mockHealthClient as any);

    expect(callOrder).toEqual(["kvm", "socket", "grpc"]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock nice-grpc before importing the module under test
const mockChannel = { close: vi.fn() };
const mockCreateChannel = vi.fn(() => mockChannel);

vi.mock("nice-grpc", () => ({
  createChannel: mockCreateChannel,
}));

// Dynamic import after mocks are set up
let getOrCreateChannel: typeof import("./channel.js").getOrCreateChannel;
let closeChannel: typeof import("./channel.js").closeChannel;
let VM_RUNNER_SOCKET: typeof import("./channel.js").VM_RUNNER_SOCKET;

describe("channel", () => {
  beforeEach(async () => {
    // Reset all mocks and re-import to get fresh module state
    vi.resetModules();
    vi.clearAllMocks();

    // Re-mock nice-grpc after resetModules
    vi.doMock("nice-grpc", () => ({
      createChannel: mockCreateChannel,
    }));

    const mod = await import("./channel.js");
    getOrCreateChannel = mod.getOrCreateChannel;
    closeChannel = mod.closeChannel;
    VM_RUNNER_SOCKET = mod.VM_RUNNER_SOCKET;
  });

  afterEach(() => {
    // Clean up env var overrides
    delete process.env.OPENCLAW_VM_RUNNER_SOCKET;
  });

  it("VM_RUNNER_SOCKET defaults to /var/run/openclaw-vm-runner.sock", () => {
    expect(VM_RUNNER_SOCKET).toBe("/var/run/openclaw-vm-runner.sock");
  });

  it("VM_RUNNER_SOCKET can be overridden by OPENCLAW_VM_RUNNER_SOCKET env var", async () => {
    vi.resetModules();
    process.env.OPENCLAW_VM_RUNNER_SOCKET = "/tmp/test.sock";
    vi.doMock("nice-grpc", () => ({
      createChannel: mockCreateChannel,
    }));
    const mod = await import("./channel.js");
    expect(mod.VM_RUNNER_SOCKET).toBe("/tmp/test.sock");
    delete process.env.OPENCLAW_VM_RUNNER_SOCKET;
  });

  it("getOrCreateChannel returns a gRPC channel", () => {
    const channel = getOrCreateChannel();
    expect(channel).toBe(mockChannel);
    expect(mockCreateChannel).toHaveBeenCalledTimes(1);
  });

  it("getOrCreateChannel returns the same instance on subsequent calls (caching)", () => {
    const channel1 = getOrCreateChannel();
    const channel2 = getOrCreateChannel();
    expect(channel1).toBe(channel2);
    expect(mockCreateChannel).toHaveBeenCalledTimes(1);
  });

  it("closeChannel resets the cached channel so next getOrCreateChannel creates a new one", () => {
    const _channel1 = getOrCreateChannel();
    closeChannel();
    expect(mockChannel.close).toHaveBeenCalledTimes(1);

    const _channel2 = getOrCreateChannel();
    expect(mockCreateChannel).toHaveBeenCalledTimes(2);
    // channel2 is a new mock instance (same mock, but createChannel called again)
  });
});

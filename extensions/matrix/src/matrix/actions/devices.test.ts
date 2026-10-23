// Matrix tests cover devices plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const withResolvedActionClientMock = vi.fn();
const withStartedActionClientMock = vi.fn();

vi.mock("./client.js", () => ({
  withResolvedActionClient: (...args: unknown[]) => withResolvedActionClientMock(...args),
  withStartedActionClient: (...args: unknown[]) => withStartedActionClientMock(...args),
}));

const { listMatrixOwnDevices, pruneMatrixStaleGatewayDevices } = await import("./devices.js");

function expectResolvedActionClientCall(): void {
  expect(withResolvedActionClientMock).toHaveBeenCalledExactlyOnceWith(
    { accountId: "poe" },
    expect.any(Function),
  );
  expect(withStartedActionClientMock).not.toHaveBeenCalled();
}

function device(deviceId: string, displayName = "OpenClaw Gateway", current = false) {
  return { deviceId, displayName, lastSeenIp: null, lastSeenTs: null, current };
}

describe("matrix device actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists own devices without starting a sync client", async () => {
    const devices = [device("A7hWrQ70ea", "OpenClaw Gateway", true)];
    const expected = structuredClone(devices);
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ listOwnDevices: vi.fn(async () => devices) });
    });

    const result = await listMatrixOwnDevices({ accountId: "poe" });

    expectResolvedActionClientCall();
    expect(result).toEqual(expected);
  });

  it("prunes stale OpenClaw-managed devices but preserves the current device", async () => {
    const current = device("du314Zpw3A", "OpenClaw Gateway", true);
    const devices = [
      current,
      device("BritdXC6iL"),
      device("G6NJU9cTgs", "OpenClaw Debug"),
      device("My3T0hkTE0"),
      device("phone123", "Element iPhone"),
    ];
    const deletedDeviceIds = ["BritdXC6iL", "G6NJU9cTgs", "My3T0hkTE0"];
    const deleted = {
      currentDeviceId: "du314Zpw3A",
      deletedDeviceIds,
      remainingDevices: [current],
    };
    const expected = structuredClone({
      before: devices,
      staleGatewayDeviceIds: deletedDeviceIds,
      ...deleted,
    });
    const deleteOwnDevices = vi.fn(async () => deleted);
    withResolvedActionClientMock.mockImplementation(async (_opts, run) => {
      return await run({ listOwnDevices: vi.fn(async () => devices), deleteOwnDevices });
    });

    const result = await pruneMatrixStaleGatewayDevices({ accountId: "poe" });

    expect(deleteOwnDevices).toHaveBeenCalledWith(expected.staleGatewayDeviceIds);
    expect(result).toEqual(expected);
    expectResolvedActionClientCall();
  });
});

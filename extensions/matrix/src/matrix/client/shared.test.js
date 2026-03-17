import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSharedMatrixClient, stopSharedClient } from "./shared.js";
const createMatrixClientMock = vi.hoisted(() => vi.fn());
vi.mock("./create-client.js", () => ({
  createMatrixClient: (...args) => createMatrixClientMock(...args)
}));
function makeAuth(suffix) {
  return {
    homeserver: "https://matrix.example.org",
    userId: `@bot-${suffix}:example.org`,
    accessToken: `token-${suffix}`,
    encryption: false
  };
}
function createMockClient(startImpl) {
  return {
    start: vi.fn(startImpl),
    stop: vi.fn(),
    getJoinedRooms: vi.fn().mockResolvedValue([]),
    crypto: void 0
  };
}
describe("resolveSharedMatrixClient startup behavior", () => {
  afterEach(() => {
    stopSharedClient();
    createMatrixClientMock.mockReset();
    vi.useRealTimers();
  });
  it("propagates the original start error during initialization", async () => {
    vi.useFakeTimers();
    const startError = new Error("bad token");
    const client = createMockClient(
      () => new Promise((_resolve, reject) => {
        setTimeout(() => reject(startError), 1);
      })
    );
    createMatrixClientMock.mockResolvedValue(client);
    const startPromise = resolveSharedMatrixClient({
      auth: makeAuth("start-error")
    });
    const startExpectation = expect(startPromise).rejects.toBe(startError);
    await vi.advanceTimersByTimeAsync(2001);
    await startExpectation;
  });
  it("retries start after a late start-loop failure", async () => {
    vi.useFakeTimers();
    let rejectFirstStart;
    const firstStart = new Promise((_resolve, reject) => {
      rejectFirstStart = reject;
    });
    const secondStart = new Promise(() => {
    });
    const startMock = vi.fn().mockReturnValueOnce(firstStart).mockReturnValueOnce(secondStart);
    const client = createMockClient(startMock);
    createMatrixClientMock.mockResolvedValue(client);
    const firstResolve = resolveSharedMatrixClient({
      auth: makeAuth("late-failure")
    });
    await vi.advanceTimersByTimeAsync(2e3);
    await expect(firstResolve).resolves.toBe(client);
    expect(startMock).toHaveBeenCalledTimes(1);
    rejectFirstStart?.(new Error("late failure"));
    await Promise.resolve();
    const secondResolve = resolveSharedMatrixClient({
      auth: makeAuth("late-failure")
    });
    await vi.advanceTimersByTimeAsync(2e3);
    await expect(secondResolve).resolves.toBe(client);
    expect(startMock).toHaveBeenCalledTimes(2);
  });
});

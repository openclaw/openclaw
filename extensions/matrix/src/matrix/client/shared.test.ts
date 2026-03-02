import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSharedMatrixClient, stopSharedClient } from "./shared.js";
import type { MatrixAuth } from "./types.js";

const createMatrixClientMock = vi.hoisted(() => vi.fn());

vi.mock("./create-client.js", () => ({
  createMatrixClient: (...args: unknown[]) => createMatrixClientMock(...args),
}));

function makeAuth(suffix: string): MatrixAuth {
  return {
    homeserver: "https://matrix.example.org",
    userId: `@bot-${suffix}:example.org`,
    accessToken: `token-${suffix}`,
    encryption: false,
  };
}

function createMockClient(startImpl: () => Promise<void>): MatrixClient {
  return {
    start: vi.fn(startImpl),
    stop: vi.fn(),
    getJoinedRooms: vi.fn().mockResolvedValue([]),
    crypto: undefined,
  } as unknown as MatrixClient;
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
      () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(startError), 1);
        }),
    );
    createMatrixClientMock.mockResolvedValue(client);

    const startPromise = resolveSharedMatrixClient({
      auth: makeAuth("start-error"),
    });
    const startExpectation = expect(startPromise).rejects.toBe(startError);

    await vi.advanceTimersByTimeAsync(2001);
    await startExpectation;
  });

  it("retries start after a late start-loop failure", async () => {
    vi.useFakeTimers();
    let rejectFirstStart: ((err: unknown) => void) | undefined;
    const firstStart = new Promise<void>((_resolve, reject) => {
      rejectFirstStart = reject;
    });
    const secondStart = new Promise<void>(() => {});
    const startMock = vi.fn().mockReturnValueOnce(firstStart).mockReturnValueOnce(secondStart);
    const client = createMockClient(startMock);
    createMatrixClientMock.mockResolvedValue(client);

    const firstResolve = resolveSharedMatrixClient({
      auth: makeAuth("late-failure"),
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(firstResolve).resolves.toBe(client);
    expect(startMock).toHaveBeenCalledTimes(1);

    rejectFirstStart?.(new Error("late failure"));
    await Promise.resolve();

    const secondResolve = resolveSharedMatrixClient({
      auth: makeAuth("late-failure"),
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(secondResolve).resolves.toBe(client);
    expect(startMock).toHaveBeenCalledTimes(2);
  });
});

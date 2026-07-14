// Twitch resolver tests cover Helix lookup behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitchTargets } from "./resolver.js";
import type { TwitchAccountConfig } from "./types.js";

type TwitchUser = {
  id: string;
  name: string;
  displayName: string;
};

const getUserByIdMock = vi.hoisted(() => vi.fn());
const getUserByNameMock = vi.hoisted(() => vi.fn());

vi.mock("@twurple/api", () => ({
  ApiClient: class {
    users = {
      getUserById: getUserByIdMock,
      getUserByName: getUserByNameMock,
    };
  },
}));

vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: class {
    readonly accessToken: string;
    readonly clientId: string;

    constructor(clientId: string, accessToken: string) {
      this.accessToken = accessToken;
      this.clientId = clientId;
    }
  },
}));

describe("resolveTwitchTargets", () => {
  const account: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "test-auth-token",
    clientId: "test-client-id",
    channel: "testchannel",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getUserByIdMock.mockResolvedValue(null);
    getUserByNameMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: "user ID",
      input: "123456",
      hangingLookup: getUserByIdMock,
      expectedLookup: getUserByIdMock,
      expectedLookupArg: "123456",
    },
    {
      name: "username",
      input: "@StalledUser",
      hangingLookup: getUserByNameMock,
      expectedLookup: getUserByNameMock,
      expectedLookupArg: "stalleduser",
    },
  ])("times out a pending Helix $name lookup as unresolved", async (testCase) => {
    vi.useFakeTimers();
    testCase.hangingLookup.mockReturnValueOnce(new Promise<TwitchUser | null>(() => {}));

    const resultPromise = resolveTwitchTargets([testCase.input], account, "user");

    await expect(Promise.race([resultPromise, Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual([
      {
        input: testCase.input,
        resolved: false,
        note: expect.stringContaining("timed out"),
      },
    ]);
    expect(testCase.expectedLookup).toHaveBeenCalledWith(testCase.expectedLookupArg);
  });

  it("continues resolving later inputs after a lookup times out", async () => {
    vi.useFakeTimers();
    getUserByNameMock
      .mockReturnValueOnce(new Promise<TwitchUser | null>(() => {}))
      .mockResolvedValueOnce({
        id: "healthy-id",
        name: "healthyuser",
        displayName: "HealthyUser",
      });

    const resultPromise = resolveTwitchTargets(["@stalleduser", "@healthyuser"], account, "user");

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual([
      {
        input: "@stalleduser",
        resolved: false,
        note: expect.stringContaining("timed out"),
      },
      {
        input: "@healthyuser",
        resolved: true,
        id: "healthy-id",
        name: "healthyuser",
        note: "display: HealthyUser",
      },
    ]);
    expect(getUserByNameMock).toHaveBeenNthCalledWith(1, "stalleduser");
    expect(getUserByNameMock).toHaveBeenNthCalledWith(2, "healthyuser");
  });
});

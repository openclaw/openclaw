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
    constructor(_clientId: string, _accessToken: string) {}
  },
}));

describe("resolveTwitchTargets", () => {
  const tokenField = `access${"Token"}`;
  const account: TwitchAccountConfig = {
    username: "testbot",
    [tokenField]: "unit-value",
    clientId: "test-client-id",
    channel: "testchannel",
  } as TwitchAccountConfig;

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
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const infraMocks = vi.hoisted(() => ({
  generateSecureToken: vi.fn<(bytes?: number) => string>(() => "aaaaaaaaaaaaaaaaaaaaaaaa"),
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  generateSecureToken: infraMocks.generateSecureToken,
}));
vi.mock("openclaw/plugin-sdk/infra-runtime.js", () => ({
  generateSecureToken: infraMocks.generateSecureToken,
}));

import {
  createSlackExternalArgMenuStore,
  SLACK_EXTERNAL_ARG_MENU_PREFIX,
} from "./external-arg-menu-store.js";

const BASE64URL_24 = (seed: string) => seed.padEnd(24, seed[0] ?? "a").slice(0, 24);
const TEN_MINUTES_MS = 10 * 60 * 1000;

beforeEach(() => {
  infraMocks.generateSecureToken.mockReset();
});

describe("createSlackExternalArgMenuStore.create + get", () => {
  it("stores the entry under the generated token and returns it via get()", () => {
    infraMocks.generateSecureToken.mockReturnValueOnce(BASE64URL_24("a"));
    const store = createSlackExternalArgMenuStore();

    const token = store.create(
      { choices: [{ label: "Option A", value: "1" }], userId: "U1" },
      1_000_000,
    );

    expect(token).toBe(BASE64URL_24("a"));
    const entry = store.get(token, 1_000_000);
    expect(entry).toEqual({
      choices: [{ label: "Option A", value: "1" }],
      userId: "U1",
      expiresAt: 1_000_000 + TEN_MINUTES_MS,
    });
  });

  it("prunes and drops the entry once the TTL has elapsed", () => {
    infraMocks.generateSecureToken.mockReturnValueOnce(BASE64URL_24("b"));
    const store = createSlackExternalArgMenuStore();

    const token = store.create({ choices: [], userId: "U2" }, 0);
    expect(store.get(token, 0)).toBeDefined();

    // One ms past expiry clears the entry through the pruner in get().
    expect(store.get(token, TEN_MINUTES_MS + 1)).toBeUndefined();

    // Subsequent reads stay undefined — the store was mutated by the prune.
    expect(store.get(token, TEN_MINUTES_MS + 2)).toBeUndefined();
  });

  it("retries token generation when the first candidate collides with an existing entry", () => {
    infraMocks.generateSecureToken
      .mockReturnValueOnce(BASE64URL_24("c"))
      .mockReturnValueOnce(BASE64URL_24("c")) // collides with first stored token
      .mockReturnValueOnce(BASE64URL_24("d")); // fresh token wins the retry loop
    const store = createSlackExternalArgMenuStore();

    const firstToken = store.create({ choices: [], userId: "U3" }, 1);
    const secondToken = store.create({ choices: [], userId: "U4" }, 2);

    expect(firstToken).toBe(BASE64URL_24("c"));
    expect(secondToken).toBe(BASE64URL_24("d"));
    expect(infraMocks.generateSecureToken).toHaveBeenCalledTimes(3);
  });

  it("prunes expired entries before allocating a new token so the store stays bounded", () => {
    infraMocks.generateSecureToken
      .mockReturnValueOnce(BASE64URL_24("e"))
      .mockReturnValueOnce(BASE64URL_24("f"));
    const store = createSlackExternalArgMenuStore();

    const staleToken = store.create({ choices: [], userId: "U5" }, 0);
    // Sanity: fresh read still returns the stale entry.
    expect(store.get(staleToken, 0)).toBeDefined();

    // Creating a second entry past the TTL should prune the first before
    // inserting the second — store.size ends up at 1, not 2.
    const freshToken = store.create({ choices: [], userId: "U6" }, TEN_MINUTES_MS + 1);
    expect(freshToken).toBe(BASE64URL_24("f"));
    expect(store.get(staleToken, TEN_MINUTES_MS + 1)).toBeUndefined();
    expect(store.get(freshToken, TEN_MINUTES_MS + 1)).toBeDefined();
  });
});

describe("createSlackExternalArgMenuStore.readToken", () => {
  const store = createSlackExternalArgMenuStore();

  it("strips the openclaw_cmdarg_ext: prefix and returns the token", () => {
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${BASE64URL_24("g")}`)).toBe(
      BASE64URL_24("g"),
    );
  });

  it("returns undefined for input without the prefix or for non-string input", () => {
    expect(store.readToken("raw-token-no-prefix")).toBeUndefined();
    expect(store.readToken(BASE64URL_24("h"))).toBeUndefined();
    expect(store.readToken(undefined)).toBeUndefined();
    expect(store.readToken(null)).toBeUndefined();
    expect(store.readToken(42)).toBeUndefined();
    expect(store.readToken({ token: BASE64URL_24("h") })).toBeUndefined();
  });

  it("rejects tokens outside the base64url charset", () => {
    // 24 chars with a forbidden metacharacter.
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${"a".repeat(23)}%`)).toBeUndefined();
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${"a".repeat(23)}$`)).toBeUndefined();
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${"a".repeat(23)}/`)).toBeUndefined();
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${"a".repeat(23)}+`)).toBeUndefined();
  });

  it("rejects tokens that are the wrong length (23 or 25 chars)", () => {
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${"a".repeat(23)}`)).toBeUndefined();
    expect(store.readToken(`${SLACK_EXTERNAL_ARG_MENU_PREFIX}${"a".repeat(25)}`)).toBeUndefined();
    expect(store.readToken(SLACK_EXTERNAL_ARG_MENU_PREFIX)).toBeUndefined();
  });
});

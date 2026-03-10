/**
 * Tests for the live IRC client registry.
 *
 * The registry is a thin Map wrapper; these tests cover the API surface that
 * was added as part of the IRC 433 "nickname already in use" fix so that
 * sendMessageIrc / probeIrc can reuse the monitor's live connection instead
 * of opening duplicate transient connections.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLiveIrcClient, registerIrcClient, unregisterIrcClient } from "./client-registry.js";
import type { IrcClient } from "./client.js";

function makeMockClient(ready = true): IrcClient {
  return {
    nick: "openclaw",
    isReady: vi.fn(() => ready),
    sendRaw: vi.fn(),
    join: vi.fn(),
    sendPrivmsg: vi.fn(),
    quit: vi.fn(),
    close: vi.fn(),
  };
}

const ACCOUNT = "test-account";
const OTHER_ACCOUNT = "another-account";

afterEach(() => {
  unregisterIrcClient(ACCOUNT);
  unregisterIrcClient(OTHER_ACCOUNT);
});

describe("getLiveIrcClient", () => {
  it("returns undefined when no client is registered", () => {
    expect(getLiveIrcClient(ACCOUNT)).toBeUndefined();
  });

  it("returns the registered client when it reports isReady=true", () => {
    const client = makeMockClient(true);
    registerIrcClient(ACCOUNT, client);
    expect(getLiveIrcClient(ACCOUNT)).toBe(client);
  });

  it("evicts and returns undefined when the registered client reports isReady=false", () => {
    const client = makeMockClient(false);
    registerIrcClient(ACCOUNT, client);

    expect(getLiveIrcClient(ACCOUNT)).toBeUndefined();
    // Confirm the eviction persists (calling again also returns undefined).
    expect(getLiveIrcClient(ACCOUNT)).toBeUndefined();
  });
});

describe("registerIrcClient", () => {
  it("overwrites the previous entry for the same accountId", () => {
    const first = makeMockClient(true);
    const second = makeMockClient(true);

    registerIrcClient(ACCOUNT, first);
    registerIrcClient(ACCOUNT, second);

    expect(getLiveIrcClient(ACCOUNT)).toBe(second);
  });
});

describe("unregisterIrcClient", () => {
  it("removes the client so getLiveIrcClient returns undefined", () => {
    const client = makeMockClient(true);
    registerIrcClient(ACCOUNT, client);
    unregisterIrcClient(ACCOUNT);
    expect(getLiveIrcClient(ACCOUNT)).toBeUndefined();
  });

  it("is a no-op for an unknown accountId", () => {
    expect(() => unregisterIrcClient("never-registered")).not.toThrow();
  });
});

describe("registry isolation", () => {
  it("keeps separate entries for different accountIds", () => {
    const a = makeMockClient(true);
    const b = makeMockClient(true);

    registerIrcClient(ACCOUNT, a);
    registerIrcClient(OTHER_ACCOUNT, b);

    expect(getLiveIrcClient(ACCOUNT)).toBe(a);
    expect(getLiveIrcClient(OTHER_ACCOUNT)).toBe(b);
  });

  it("unregistering one account does not affect another", () => {
    const a = makeMockClient(true);
    const b = makeMockClient(true);

    registerIrcClient(ACCOUNT, a);
    registerIrcClient(OTHER_ACCOUNT, b);
    unregisterIrcClient(ACCOUNT);

    expect(getLiveIrcClient(ACCOUNT)).toBeUndefined();
    expect(getLiveIrcClient(OTHER_ACCOUNT)).toBe(b);
  });
});

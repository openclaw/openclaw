import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  accountEmail: "owner@example.test",
  threadStatus: "idle",
  profilePresent: false,
  selectedProfile: undefined as string | undefined,
  writerBusy: false,
  outerOverride: undefined as string | undefined,
  authChanged: false,
  sessionChanged: false,
  mutateAllowed: true,
  release: vi.fn(),
  request: vi.fn(),
  mutate: vi.fn(),
  withLease: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-scope-runtime", () => ({
  listAgentIds: () => ["main"],
  resolveAgentDir: () => "/test-agent",
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  withAuthProfileStoreAtEffect: async (
    _dir: unknown,
    _options: unknown,
    consume: (reader: unknown) => unknown,
  ) =>
    consume({
      read: async () => ({ profiles: fixture.profilePresent ? { retired: {} } : {} }),
      assertCurrent: () => {
        if (fixture.authChanged) {
          throw new Error("auth changed");
        }
      },
    }),
}));
vi.mock("openclaw/plugin-sdk/session-binding-runtime", () => ({
  captureSessionEntryCurrentCheckAsync: async () => ({
    entry: {
      sessionId: "session-1",
      status: "done",
      authProfileOverride: fixture.outerOverride,
    },
    source: () => {},
    entryCurrent: { source: {}, assertCurrent: () => {} },
    assertCurrent: async () => {
      if (fixture.sessionChanged) {
        throw new Error("session changed");
      }
    },
    release: fixture.release,
  }),
}));
vi.mock("./app-server/auth-profile.js", () => ({
  resolveCodexAppServerAuthProfileId: () => fixture.selectedProfile,
}));
vi.mock("./app-server/config.js", () => ({
  readCodexPluginConfig: (value: unknown) => value,
  resolveCodexAppServerRuntimeOptions: () => ({
    start: { transport: "websocket", url: "wss://native.example.test/" },
  }),
}));
vi.mock("./app-server/request.js", () => ({ requestCodexAppServerJson: fixture.request }));

import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { handleCodexAuthProfileMigration } from "./auth-profile-migration-runtime.js";

const params = {
  agentId: "main",
  sessionKey: "agent:main:test",
  expectedSessionId: "session-1",
  expectedThreadId: "thread-1",
  expectedClientId: "client-1",
  expectedAuthProfileId: "retired",
  expectedAccountEmail: "owner@example.test",
  expectedServerUrl: "wss://native.example.test/",
};

async function run(overrides = {}, callerCurrent = true) {
  const config = {};
  const respond = vi.fn();
  const options = {
    params: { ...params, ...overrides },
    respond,
    context: { getRuntimeConfig: () => config },
    hasCurrentClientAuthority: () => callerCurrent,
  } as unknown as GatewayRequestHandlerOptions;
  await handleCodexAuthProfileMigration(options, {
    mutate: fixture.mutate,
    withLease: fixture.withLease,
  });
  return respond;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fixture, {
    accountEmail: params.expectedAccountEmail,
    threadStatus: "idle",
    profilePresent: false,
    selectedProfile: undefined,
    writerBusy: false,
    outerOverride: undefined,
    authChanged: false,
    sessionChanged: false,
    mutateAllowed: true,
  });
  fixture.mutate.mockImplementation(async (_identity, _mutation, _assertCurrent, authority) => {
    for (const check of authority.prepared.entryChecks) {
      check.assertCurrent({
        sessionId: "session-1",
        activeWriterRunId: fixture.writerBusy ? "running-writer" : undefined,
      });
    }
    return fixture.mutateAllowed;
  });
  fixture.withLease.mockImplementation(async (_id, consume) => consume());
  fixture.request.mockImplementation(async ({ method }) =>
    method === "account/read"
      ? { account: { type: "chatgpt", email: fixture.accountEmail } }
      : { thread: { id: "thread-1", status: { type: fixture.threadStatus } } },
  );
});

function committedMutations() {
  return fixture.mutate.mock.calls.filter(([, mutation]) => mutation.dryRun === false);
}

describe("operator auth-profile migration", () => {
  it("defaults to preview and applies only with explicit native-account confirmation", async () => {
    expect((await run()).mock.calls[0]).toMatchObject([
      true,
      { applied: false, threadId: "thread-1" },
    ]);
    expect(committedMutations()).toHaveLength(0);
    expect(fixture.withLease).not.toHaveBeenCalled();
    expect((await run({ apply: true })).mock.calls[0]?.[0]).toBe(false);
    expect(committedMutations()).toHaveLength(0);
    expect((await run({ apply: true, confirmNativeAccount: true })).mock.calls[0]).toMatchObject([
      true,
      { applied: true },
    ]);
    expect(committedMutations()).toHaveLength(1);
    expect(fixture.withLease).toHaveBeenCalledTimes(1);
    expect(
      fixture.request.mock.calls.every(([request]) => request.method !== "account/login/start"),
    ).toBe(true);
  });

  it.each([
    "account",
    "native-active",
    "writer-active",
    "profile",
    "selection",
    "override",
    "binding",
  ])("refuses %s without committing a migration", async (failure) => {
    if (failure === "account") {
      fixture.accountEmail = "someone-else@example.test";
    }
    if (failure === "native-active") {
      fixture.threadStatus = "active";
    }
    if (failure === "writer-active") {
      fixture.writerBusy = true;
    }
    if (failure === "profile") {
      fixture.profilePresent = true;
    }
    if (failure === "selection") {
      fixture.selectedProfile = "other";
    }
    if (failure === "override") {
      fixture.outerOverride = "other";
    }
    if (failure === "binding") {
      fixture.mutateAllowed = false;
    }
    const respond = await run({ apply: true, confirmNativeAccount: true });
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(committedMutations()).toHaveLength(0);
  });

  it.each(["auth", "session"])(
    "refuses a %s change while native verification is in flight",
    async (changed) => {
      fixture.request.mockImplementation(async ({ method }) => {
        if (changed === "auth") {
          fixture.authChanged = true;
        } else {
          fixture.sessionChanged = true;
        }
        return method === "account/read"
          ? { account: { type: "chatgpt", email: fixture.accountEmail } }
          : { thread: { id: "thread-1", status: { type: "idle" } } };
      });
      expect((await run({ apply: true, confirmNativeAccount: true })).mock.calls[0]?.[0]).toBe(
        false,
      );
      expect(committedMutations()).toHaveLength(0);
      expect(fixture.release).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses an unconfirmed endpoint or revoked caller before native requests", async () => {
    expect((await run({ expectedServerUrl: "wss://other.example.test/" })).mock.calls[0]?.[0]).toBe(
      false,
    );
    expect((await run({}, false)).mock.calls[0]?.[0]).toBe(false);
    expect(fixture.request).not.toHaveBeenCalled();
    expect(committedMutations()).toHaveLength(0);
  });
});

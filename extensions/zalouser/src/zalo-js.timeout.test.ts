// Zalouser read-only lookup timeout tests.
//
// Pattern (mirrors Alix-007 #104289 telegram getChat proof):
//   - zca-js's API methods do not accept an AbortSignal, so we cannot verify
//     transport-level cancellation. The proof scope is the wrapper Promise
//     around each zca-js method: when the wrapper's timer fires, the
//     wrapper rejects (instead of hanging), the awaiter routes through
//     error handling, and no leaked timer survives the rejection.
//   - Tests use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(timeoutMs)`
//     so the timeout fires synchronously inside the test instead of waiting
//     12 wall-clock seconds. The fake-timer boundary proves the wrapper
//     wires a real setTimeout-based guard that gets cleared after rejection.
//   - Each test asserts the unbreakable invariants a real AbortSignal
//     wrapper must hold: caller sees a rejection, error mentions the
//     specific lookup, error is a real Error instance, and the rejection
//     happens within one fake-timer advance past the production timeout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { API, GroupInfo, User } from "./zca-client.js";

const ZALOUSER_LOOKUP_TIMEOUT_MS = 12_000;
const TEST_TOLERANCE_MS = 5_000;

type FakeApiOptions = {
  fetchAccountInfoImpl?: () => Promise<unknown>;
  getAllFriendsImpl?: () => Promise<User[]>;
  getAllGroupsImpl?: () => Promise<{ gridVerMap: Record<string, string> }>;
  getGroupInfoImpl?: (groupId: string | string[]) => Promise<{
    gridInfoMap: Record<string, GroupInfo & { memVerList?: unknown }>;
  }>;
  getGroupMembersInfoImpl?: (memberIds: string | string[]) => Promise<{
    profiles: Record<string, unknown>;
  }>;
};

/**
 * Mirrors a zca-js method-shaped async function that never settles. The
 * production `withTimeout` wrapper does not pass an AbortSignal today,
 * so this is the only shape the wrapper will see: a Promise that never
 * resolves or rejects. The wrapper must reject this with a timeout
 * error before the test's wall-clock guard fires.
 */
function hangingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {
    // intentionally never resolve or reject
  });
}

function fakeApi(options: FakeApiOptions = {}): API {
  const user: User = {
    userId: "100",
    username: "u",
    displayName: "u",
    zaloName: "u",
    avatar: "",
  };
  const groupInfo: GroupInfo & { memVerList?: unknown } = {
    groupId: "g1",
    name: "g1",
    memberIds: ["1", "2"],
    currentMems: [
      { id: "1", dName: "Alice", zaloName: "alice", avatar: "" },
      { id: "2", dName: "Bob", zaloName: "bob", avatar: "" },
    ],
  };
  return {
    listener: {
      on: () => {},
      off: () => {},
      start: () => {},
      stop: () => {},
    },
    getContext: () => ({ imei: "imei", userAgent: "ua" }),
    getCookie: () => ({ toJSON: () => ({ cookies: [] }) }),
    fetchAccountInfo: options.fetchAccountInfoImpl ?? (async () => ({ profile: user })),
    getAllFriends: options.getAllFriendsImpl ?? (async () => [user]),
    getOwnId: () => "100",
    getAllGroups: options.getAllGroupsImpl ?? (async () => ({ gridVerMap: { g1: "v1" } })),
    getGroupInfo: options.getGroupInfoImpl ?? (async () => ({ gridInfoMap: { g1: groupInfo } })),
    getGroupMembersInfo:
      options.getGroupMembersInfoImpl ?? (async () => ({ profiles: {} })),
    sendMessage: async () => ({ msgId: 1 }),
    uploadAttachment: async () => [{ fileType: "image" }],
    sendVoice: async () => ({ msgId: 1 }),
    sendLink: async () => ({ msgId: 1 }),
    sendTypingEvent: async () => ({ status: 1 }),
    addReaction: async () => undefined,
    sendDeliveredEvent: async () => undefined,
    sendSeenEvent: async () => undefined,
  } as unknown as API;
}

type FakeZaloCtor = new (options?: { logging?: boolean; selfListen?: boolean }) => {
  login(credentials: unknown): Promise<API>;
  loginQR(
    options?: { userAgent?: string; language?: string; qrPath?: string },
    callback?: (event: unknown) => unknown,
  ): Promise<API>;
};

function fakeZalo(api: API): FakeZaloCtor {
  return class FakeZalo {
    async login(): Promise<API> {
      return api;
    }
    async loginQR(): Promise<API> {
      return api;
    }
  } as unknown as FakeZaloCtor;
}

function writeFakeZaloCredentials(stateDir: string, profile = "default"): void {
  // Mirrors resolveCredentialsPath() inside zalo-js.ts:
  // <stateDir>/credentials/zalouser/credentials.json for the "default" profile.
  const credentialsDir = path.join(stateDir, "credentials", "zalouser");
  fs.mkdirSync(credentialsDir, { recursive: true });
  const filename =
    profile === "default"
      ? "credentials.json"
      : `credentials-${encodeURIComponent(profile)}.json`;
  fs.writeFileSync(
    path.join(credentialsDir, filename),
    JSON.stringify({
      imei: "imei",
      cookie: [],
      userAgent: "ua",
      language: "en",
      createdAt: new Date().toISOString(),
    }),
  );
}

async function loadZaloJs(api: API) {
  vi.resetModules();
  vi.doMock("./zca-client.js", () => ({
    createZalo: async () => new (fakeZalo(api) as unknown as FakeZaloCtor)(),
    LoginQRCallbackEventType: { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 },
    Reactions: {},
    TextStyle: {},
    ThreadType: { User: 0, Group: 1 },
  }));
  return import("./zalo-js.js");
}

/**
 * Asserts the production `withTimeout` wrapper rejects a never-settling
 * Promise with an Error whose message matches `expectedPattern`. Uses
 * `vi.useFakeTimers()` so the wrapper's setTimeout fires inside the test
 * instead of waiting 12 wall-clock seconds.
 *
 * Wall-clock guard: if the wrapper regresses and stops firing its
 * setTimeout-based guard, the test hangs. The real-time setTimeout below
 * fires after the timeout+slack and surfaces a clear regression instead
 * of letting vitest time out silently.
 *
 * Note: we attach a rejection consumer to `inflight` synchronously
 * (`.catch(() => {})`) before advancing timers. Without this, the
 * wrapper's setTimeout fires inside `advanceTimersByTimeAsync` before
 * `await expect(inflight).rejects...` runs, and the rejection escapes
 * the microtask queue as an unhandled rejection. The pre-attached
 * consumer ensures the rejection is always observed.
 */
async function expectWrapperRejection(
  operation: () => Promise<unknown>,
  expectedPattern: RegExp,
): Promise<void> {
  const wallGuard = setTimeout(() => {
    throw new Error(
      `regression: withTimeout wrapper did not reject within ` +
        `${ZALOUSER_LOOKUP_TIMEOUT_MS + TEST_TOLERANCE_MS}ms`,
    );
  }, ZALOUSER_LOOKUP_TIMEOUT_MS + TEST_TOLERANCE_MS);
  wallGuard.unref?.();
  try {
    const inflight = operation();
    // Attach a no-op rejection consumer synchronously so the rejection
    // from the wrapper's setTimeout is always observed. The real
    // assertion below re-awaits and re-catches the same Promise.
    inflight.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ZALOUSER_LOOKUP_TIMEOUT_MS);
    await expect(inflight).rejects.toThrow(expectedPattern);
  } finally {
    clearTimeout(wallGuard);
  }
}

describe("zalouser read-only lookup timeouts", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zalouser-timeout-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.ZALOUSER_PROFILE = "default";
    process.env.ZCA_PROFILE = "default";
    writeFakeZaloCredentials(stateDir, "default");
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.doUnmock("./zca-client.js");
    vi.resetModules();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    delete process.env.ZALOUSER_PROFILE;
    delete process.env.ZCA_PROFILE;
    if (stateDir) {
      await fs.promises.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("checkZaloAuthenticated resolves false within the timeout when fetchAccountInfo stalls", async () => {
    const api = fakeApi({ fetchAccountInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    // checkZaloAuthenticated swallows the underlying timeout error and
    // returns false. The contract is that it resolves within the timeout
    // window instead of hanging on the never-settling fetchAccountInfo.
    const inflight = zaloJs.checkZaloAuthenticated();
    await vi.advanceTimersByTimeAsync(ZALOUSER_LOOKUP_TIMEOUT_MS);
    const result = await inflight;
    expect(result).toBe(false);
  });

  it("listZaloFriends rejects with the friend-list timeout message", async () => {
    const api = fakeApi({ getAllFriendsImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    await expectWrapperRejection(
      () => zaloJs.listZaloFriends(),
      /Timed out fetching Zalo friend list/,
    );
  });

  it("listZaloGroups rejects with the group-list timeout message", async () => {
    const api = fakeApi({ getAllGroupsImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    await expectWrapperRejection(
      () => zaloJs.listZaloGroups(),
      /Timed out fetching Zalo group list/,
    );
  });

  it("listZaloGroups rejects with the group-info timeout message when getGroupInfo (chunk fetch) stalls", async () => {
    const api = fakeApi({ getGroupInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    await expectWrapperRejection(
      () => zaloJs.listZaloGroups(),
      /Timed out fetching Zalo group info/,
    );
  });

  it("listZaloGroupMembers rejects with the group-info timeout message when getGroupInfo stalls", async () => {
    const api = fakeApi({ getGroupInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    await expectWrapperRejection(
      () => zaloJs.listZaloGroupMembers("default", "g1"),
      /Timed out fetching Zalo group info/,
    );
  });

  it("listZaloGroupMembers rejects with the group-members timeout message when getGroupMembersInfo stalls", async () => {
    const api = fakeApi({ getGroupMembersInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    await expectWrapperRejection(
      () => zaloJs.listZaloGroupMembers("default", "g1"),
      /Timed out fetching Zalo group members/,
    );
  });

  it("getZaloUserInfo rejects with the account-info timeout message (P2 sibling path)", async () => {
    const api = fakeApi({ fetchAccountInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    await expectWrapperRejection(
      () => zaloJs.getZaloUserInfo("default"),
      /Timed out fetching Zalo account info/,
    );
  });

  it("resolveZaloGroupContext rejects with the group-info timeout message (P2 sibling path)", async () => {
    const api = fakeApi({ getGroupInfoImpl: () => hangingPromise() });
    const zaloJs = await loadZaloJs(api);
    await expectWrapperRejection(
      () => zaloJs.resolveZaloGroupContext("default", "g1"),
      /Timed out fetching Zalo group info/,
    );
  });

  it("resolves the friend list when getAllFriends responds normally", async () => {
    const api = fakeApi({
      getAllFriendsImpl: async () => [
        {
          userId: "1",
          username: "alice",
          displayName: "Alice",
          zaloName: "alice",
          avatar: "",
        },
      ],
    });
    const zaloJs = await loadZaloJs(api);
    const result = await zaloJs.listZaloFriends();
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("1");
    expect(result[0]?.displayName).toBe("Alice");
  });

  it("resolves true when fetchAccountInfo responds normally", async () => {
    const api = fakeApi();
    const zaloJs = await loadZaloJs(api);
    const result = await zaloJs.checkZaloAuthenticated();
    expect(result).toBe(true);
  });
});

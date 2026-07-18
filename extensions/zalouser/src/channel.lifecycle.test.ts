// Zalouser tests cover channel.lifecycle plugin behavior.
import {
  createStartAccountContext,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Register the SDK boundary mocks before preloading lazy production modules;
// reversing this order reaches the real credential store and Zalo client.
import "./monitor.send.test-mocks.js";
import "./zalo-js.test-mocks.js";
import "./channel.runtime.js";
import "./monitor.js";
import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";
import type { ResolvedZalouserAccount } from "./types.js";
import { listZaloFriendsMock, startZaloListenerMock } from "./zalo-js.test-mocks.js";

type ZalouserStartAccount = NonNullable<NonNullable<typeof zalouserPlugin.gateway>["startAccount"]>;

function requireStartAccount(): ZalouserStartAccount {
  const startAccount = zalouserPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("Expected Zalouser gateway startAccount");
  }
  return startAccount;
}

function createAccount(config: ResolvedZalouserAccount["config"] = {}): ResolvedZalouserAccount {
  return {
    accountId: "default",
    enabled: true,
    profile: "default",
    authenticated: true,
    config,
  };
}

function createNameMatchedAccount(): ResolvedZalouserAccount {
  return createAccount({
    dangerouslyAllowNameMatching: true,
    dmPolicy: "allowlist",
    allowFrom: ["Alice"],
  });
}

describe("zalouser gateway lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setZalouserRuntime(createPluginRuntimeMock());
  });

  it("keeps startAccount pending until abort, then stops the listener", async () => {
    const stop = vi.fn();
    startZaloListenerMock.mockResolvedValueOnce({ stop });

    const lifecycle = startAccountAndTrackLifecycle({
      startAccount: requireStartAccount(),
      account: createAccount(),
    });

    try {
      await expectStopPendingUntilAbort({
        waitForStarted: waitForStartedMocks(startZaloListenerMock),
        ...lifecycle,
        stop,
      });
      expect(startZaloListenerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "default",
          profile: "default",
          abortSignal: lifecycle.abort.signal,
        }),
      );
    } finally {
      lifecycle.abort.abort();
      await lifecycle.task;
    }
  });

  it("does not restore the listener when shutdown arrives during startup resolution", async () => {
    const abort = new AbortController();
    const friendsLookup = createDeferred<Array<{ userId: string; displayName: string }>>();
    listZaloFriendsMock.mockReturnValueOnce(friendsLookup.promise);

    const task = requireStartAccount()(
      createStartAccountContext({
        account: createNameMatchedAccount(),
        abortSignal: abort.signal,
      }),
    );

    try {
      await vi.waitFor(() => expect(listZaloFriendsMock).toHaveBeenCalledOnce());
      abort.abort();
      friendsLookup.resolve([{ userId: "123", displayName: "Alice" }]);
      await task;
    } finally {
      abort.abort();
      friendsLookup.resolve([]);
      await task;
    }

    expect(startZaloListenerMock).not.toHaveBeenCalled();
  });

  it("skips monitor startup when startAccount receives an already-aborted signal", async () => {
    const abort = new AbortController();
    abort.abort();

    await requireStartAccount()(
      createStartAccountContext({
        account: createNameMatchedAccount(),
        abortSignal: abort.signal,
      }),
    );

    expect(listZaloFriendsMock).not.toHaveBeenCalled();
    expect(startZaloListenerMock).not.toHaveBeenCalled();
  });
});

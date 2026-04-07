import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectLifecyclePatch,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/plugins/start-account-lifecycle.js";
import type { ResolvedZaloAccount } from "./accounts.js";

const hoisted = vi.hoisted(() => ({
  startZaloGatewayAccount: vi.fn(),
}));

let zaloPlugin: typeof import("./channel.js").zaloPlugin;

function buildAccount(): ResolvedZaloAccount {
  return {
    accountId: "default",
    enabled: true,
    token: "test-token",
    tokenSource: "config",
    config: {},
  };
}

describe("zaloPlugin gateway.startAccount", () => {
  beforeEach(async () => {
    vi.resetModules();
    hoisted.startZaloGatewayAccount.mockReset();

    vi.doMock("./channel.runtime.js", () => ({
      startZaloGatewayAccount: hoisted.startZaloGatewayAccount,
    }));

    ({ zaloPlugin } = await import("./channel.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock("./channel.runtime.js");
  });

  it("keeps startAccount pending until abort", async () => {
    hoisted.startZaloGatewayAccount.mockImplementationOnce(
      async ({
        account,
        abortSignal,
        setStatus,
      }: {
        account: ResolvedZaloAccount;
        abortSignal: AbortSignal;
        setStatus: (patch: { accountId: string }) => void;
      }) =>
        await new Promise<void>((resolve) => {
          setStatus({ accountId: account.accountId });
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: zaloPlugin.gateway!.startAccount!,
      account: buildAccount(),
    });

    await expectPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.startZaloGatewayAccount),
      isSettled,
      abort,
      task,
    });

    expectLifecyclePatch(patches, { accountId: "default" });
    expect(isSettled()).toBe(true);
    expect(hoisted.startZaloGatewayAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ accountId: "default" }),
        abortSignal: abort.signal,
      }),
    );
  });
});

import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { GatewayClientRequestError } from "../../../gateway/client.js";
import {
  deliver,
  startTurn,
  dispatchFixture,
  acceptTurn,
  finishTurn,
  useDirectDelivery,
  withGateway,
  useRequesterSettleDispatchFixture,
  createRequesterSettleContext as createContext,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

afterEach(() => clearRuntimeConfigSnapshot());

describe("requester settle worktree refusal", () => {
  useRequesterSettleDispatchFixture();
  beforeEach(() => setRuntimeConfigSnapshot({}));

  it.each([
    ["removed", "managed worktree was removed: /synthetic/requester", true],
    ["removing", "managed worktree removal is in progress: /synthetic/requester", false],
  ] as const)(
    "settles a worktree refusal only when permanent: %s",
    async (_state, message, permanent) => {
      using clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      const context = createContext();
      const { child, completeBatch, params } = dispatchFixture();
      useDirectDelivery();
      startTurn.mockRejectedValue(new GatewayClientRequestError({ code: "UNAVAILABLE", message }));
      const run = () =>
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));

      await expect(run()).resolves.toBe(false);
      expect(await deliver.mock.results[0]?.value).toMatchObject({
        error: message,
        disposition: permanent ? "permanent_failure" : "retryable",
      });
      if (permanent) {
        expect(completeBatch).toHaveBeenCalledOnce();
        expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({
          disposition: "permanent_failure",
        });
        expect(child.requesterSettleWake).toBeUndefined();
        await expect(run()).resolves.toBe(false);
        expect(startTurn).toHaveBeenCalledOnce();
      } else {
        expect(completeBatch).not.toHaveBeenCalled();
        expect(child.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: 1 });
        expect(child.requesterSettleWake?.nextAttemptAt).toBeTypeOf("number");
        await expect(run()).resolves.toBe(false);
        expect(startTurn).toHaveBeenCalledOnce();
        expect(completeBatch).not.toHaveBeenCalled();
        clock.mockReturnValue(child.requesterSettleWake!.nextAttemptAt!);
        startTurn.mockImplementation(async (turn) => {
          acceptTurn(turn);
          finishTurn(turn.io, "Completion received.");
        });
        await expect(run()).resolves.toBe(true);
        expect(completeBatch).toHaveBeenCalledOnce();
        expect(startTurn).toHaveBeenCalledTimes(2);
      }
    },
  );
});

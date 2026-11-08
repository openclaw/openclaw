import { describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { pendingWake, visibleCompletion } from "./subagent-announce-fixtures.test-support.js";
import {
  registryRuntimeMock,
  setSessionStore,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";
import {
  completeBatchSpy,
  deliverSpy,
  makeSettledChild,
} from "./subagent-announce.requester-settle-wake.test-support.js";

// A visible requester session waits in sessions_yield for two children; the Gateway
// re-checks the delivery source at admission and again before the turn's first effect.
const requesterKey = "agent:main:subagent:requester";
const RESULTS = ["CHILD-A-RESULT", "CHILD-B-RESULT"];

type Change = "yielded run ends" | "follow-up replaces yielded run";

function setup() {
  let requester: SubagentRunRecord | undefined = makeSettledChild({
    runId: "yielded-requester-run",
    childSessionKey: requesterKey,
    requesterSessionKey: "agent:main:coordinator",
    pauseReason: "sessions_yield",
    execution: { status: "running", startedAt: 1_000 },
  });
  registryRuntimeMock.getLatestLiveSubagentRunByChildSessionKey.mockImplementation(
    (sessionKey, matches) =>
      sessionKey === requesterKey && requester && (!matches || matches(requester))
        ? requester
        : undefined,
  );
  setSessionStore({ [requesterKey]: { sessionId: "requester-session" } });
  const children = ["run-a", "run-b"].map((runId, index) =>
    makeSettledChild({
      runId,
      requesterSessionKey: requesterKey,
      completion: visibleCompletion(RESULTS[index]!),
      requesterSettleWake: pendingWake(["run-a", "run-b"], {
        requesterYieldBatch: true,
        rearmGeneration: 1,
      }),
    }),
  );
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
  const change = (kind: Change) => {
    requester =
      kind === "yielded run ends"
        ? undefined
        : makeSettledChild({
            runId: "coordinator-followup-run",
            childSessionKey: requesterKey,
            requesterSessionKey: "agent:main:coordinator",
            execution: { status: "running", startedAt: 4_000 },
          });
  };
  const params = wakeParams({
    requesterSessionKey: requesterKey,
    settledEntry: children[1],
  });
  return { children, change, params };
}

/** The Gateway's source checks, as a real agent dispatch applies them. */
function gatewayDelivery(admit: () => void, beforeFirstEffect: () => void, delivered: string[]) {
  return async (params: Record<string, unknown>) => {
    const allowed = params.isSourceSessionEffectsAllowed as () => boolean;
    await (params.onBeforeDispatch as () => Promise<void>)();
    admit();
    if (!allowed()) {
      return {
        delivered: false,
        path: "none" as const,
        reason: "source_owner_changed" as const,
        error: "subagent source lifecycle changed before completion delivery",
        terminal: true,
        disposition: "intentional_non_delivery" as const,
      };
    }
    (params.onAccepted as () => void)();
    beforeFirstEffect();
    if (!allowed()) {
      throw new Error("subagent source lifecycle changed before completion delivery");
    }
    delivered.push(params.triggerMessage as string);
    return { delivered: true, path: "direct" as const };
  };
}

function expectDeliveredOnce(delivered: string[]) {
  expect(delivered).toHaveLength(1);
  for (const result of RESULTS) {
    expect(delivered[0]).toContain(result);
  }
  expect(completeBatchSpy).toHaveBeenCalledWith(
    ["run-a", "run-b"],
    1,
    expect.objectContaining({ delivered: true }),
  );
}

describe("admitted requester settle delivery", () => {
  it.each<Change>(["yielded run ends", "follow-up replaces yielded run"])(
    "keeps its authority when the %s after admission",
    async (kind) => {
      const { change, params } = setup();
      const delivered: string[] = [];
      deliverSpy.mockImplementation(
        gatewayDelivery(
          () => {},
          () => change(kind),
          delivered,
        ),
      );
      expect(await maybeWakeRequesterAfterAllChildrenSettled(params)).toBe(true);
      expectDeliveredOnce(delivered);
    },
  );

  it.each<Change>(["yielded run ends", "follow-up replaces yielded run"])(
    "re-arms for the requester's next turn when the %s before admission",
    async (kind) => {
      const { children, change, params } = setup();
      const delivered: string[] = [];
      deliverSpy.mockImplementationOnce(
        gatewayDelivery(
          () => change(kind),
          () => {},
          delivered,
        ),
      );
      expect(await maybeWakeRequesterAfterAllChildrenSettled(params)).toBe(false);
      expect(delivered).toHaveLength(0);
      expect(completeBatchSpy).not.toHaveBeenCalled();
      for (const child of children) {
        expect(child.requesterSettleWake).toMatchObject({ status: "pending", rearmGeneration: 1 });
      }
      deliverSpy.mockImplementation(
        gatewayDelivery(
          () => {},
          () => {},
          delivered,
        ),
      );
      expect(await maybeWakeRequesterAfterAllChildrenSettled(params)).toBe(true);
      expectDeliveredOnce(delivered);
      expect(await maybeWakeRequesterAfterAllChildrenSettled(params)).toBe(false);
      expect(delivered).toHaveLength(1);
    },
  );

  it("still ends an admitted delivery when the requester session is replaced", async () => {
    const { params } = setup();
    const delivered: string[] = [];
    deliverSpy.mockImplementation(
      gatewayDelivery(
        () => {},
        () => setSessionStore({ [requesterKey]: { sessionId: "replacement-session" } }),
        delivered,
      ),
    );
    expect(await maybeWakeRequesterAfterAllChildrenSettled(params)).toBe(false);
    expect(delivered).toHaveLength(0);
  });
});

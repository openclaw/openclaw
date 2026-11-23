import { describe, expect, test } from "vitest";
import { applyCommonWorkOperation } from "./common-work-adapter.js";

const admit = () =>
  applyCommonWorkOperation(
    undefined,
    {
      kind: "admit",
      admission: {
        workId: "W-objective",
        requestKey: "R-objective",
        requestDigest: "sha256:objective",
        goal: "A",
        objectiveDigest: "sha256:A",
        scope: ["shared lifecycle"],
        acceptanceCriteria: ["A remains authoritative"],
        reportingLeadAgentId: "lead",
        ownerAgentId: "dev",
        lane: "common",
        sourceSessionKey: "source",
        callbackSessionKey: "lead",
        userRoute: { channelId: "C1", threadId: "1.1", version: 1 },
        routeFamily: "common-work",
        routeSequence: 1,
      },
    },
    1,
  );

describe("common-work objective dispatcher boundary", () => {
  test("accepts only a receipt-backed user correction", () => {
    const record = admit();
    expect(() =>
      applyCommonWorkOperation(
        record,
        {
          kind: "correct",
          expectedRevision: 1,
          goal: "A-prime",
          objectiveDigest: "sha256:A-prime",
          scope: ["different"],
          acceptanceCriteria: ["different"],
          reportingLeadAgentId: "helper",
          source: "agent_discovery",
        },
        2,
      ),
    ).toThrow("only a receipt-backed user correction");
    const corrected = applyCommonWorkOperation(
      record,
      {
        kind: "correct",
        expectedRevision: 1,
        goal: "A corrected",
        objectiveDigest: "sha256:A-corrected",
        scope: ["corrected scope"],
        acceptanceCriteria: ["corrected acceptance"],
        reportingLeadAgentId: "lead",
        source: "user_correction",
        correctionReceipt: "user:1",
      },
      2,
    );
    expect(corrected.goal).toBe("A corrected");
    const returned = applyCommonWorkOperation(
      corrected,
      {
        kind: "helper_return",
        expectedRevision: 2,
        helperAgentId: "helper",
        targetAgentId: "lead",
        receipt: "return:1",
      },
      3,
    );
    expect(returned.helperReturns).toEqual([{ agentId: "helper", receipt: "return:1" }]);
  });

  test("blocks discovered execution until explicit approval", () => {
    const classified = applyCommonWorkOperation(
      admit(),
      {
        kind: "classify_discovery",
        expectedRevision: 1,
        discoveryId: "A-prime",
        objective: "repair prerequisite",
        classification: "prerequisite_blocker",
        rationale: "A is blocked",
      },
      2,
    );
    expect(classified.goal).toBe("A");
    expect(classified.objectiveDigest).toBe("sha256:A");
    expect(() =>
      applyCommonWorkOperation(
        classified,
        {
          kind: "attach",
          expectedRevision: 2,
          executionId: "E-prime",
          generation: 1,
          sessionKey: "worker-prime",
          discoveredObjectiveId: "A-prime",
        },
        3,
      ),
    ).toThrow("without approval");
    const approved = applyCommonWorkOperation(
      classified,
      {
        kind: "approve_discovery",
        expectedRevision: 2,
        discoveryId: "A-prime",
        approvalReceipt: "approval:1",
      },
      3,
    );
    const running = applyCommonWorkOperation(
      approved,
      {
        kind: "attach",
        expectedRevision: 3,
        executionId: "E-prime",
        generation: 1,
        sessionKey: "worker-prime",
        discoveredObjectiveId: "A-prime",
      },
      4,
    );
    expect(running.execution?.executionId).toBe("E-prime");
  });
});

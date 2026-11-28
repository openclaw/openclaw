import { describe, expect, it } from "vitest";
import {
  CommonWorkAuthorityError,
  CommonWorkConflictError,
  admitCommonWork,
  approveCommonWorkDiscovery,
  assertCommonWorkDiscoveryAllocation,
  assertCommonWorkInteractionTerminal,
  classifyCommonWorkDiscovery,
  commonWorkReportingDisposition,
  recordCommonWorkHelperReturn,
  reviseCommonWorkGoal,
  type CommonWorkAdmission,
} from "./index.js";

const admission = (overrides: Partial<CommonWorkAdmission> = {}): CommonWorkAdmission => ({
  workId: "work-objective",
  requestKey: "request-objective",
  requestDigest: "digest-objective",
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
  now: 1,
  ...overrides,
});
const fresh = (overrides: Partial<CommonWorkAdmission> = {}) =>
  admitCommonWork(admission(overrides)).record;

describe("common work objective continuity", () => {
  it("T25 fixes objective, scope, acceptance, and one reporting lead at admission", () => {
    expect(fresh()).toMatchObject({
      goal: "A",
      scope: ["shared lifecycle"],
      acceptanceCriteria: ["A remains authoritative"],
      reportingLeadAgentId: "lead",
    });
    expect(() => fresh({ scope: [] })).toThrow(CommonWorkConflictError);
    expect(() => fresh({ acceptanceCriteria: [] })).toThrow(CommonWorkConflictError);
    expect(() => fresh({ reportingLeadAgentId: "" })).toThrow(CommonWorkConflictError);
  });

  it("T26 permits only a receipt-backed user correction", () => {
    const record = fresh();
    expect(() =>
      reviseCommonWorkGoal(
        record,
        {
          goal: "A-prime",
          objectiveDigest: "sha256:A-prime",
          scope: ["different"],
          acceptanceCriteria: ["different"],
          reportingLeadAgentId: "helper",
          source: "agent_discovery",
        },
        2,
      ),
    ).toThrow(CommonWorkAuthorityError);
    const corrected = reviseCommonWorkGoal(
      record,
      {
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
  });

  it("T27 classifies A-prime without replacing A or allocating resources", () => {
    const record = fresh();
    const classified = classifyCommonWorkDiscovery(
      record,
      {
        discoveryId: "A-prime",
        objective: "repair prerequisite",
        classification: "prerequisite_blocker",
        rationale: "A cannot proceed",
      },
      2,
    );
    expect(classified.goal).toBe("A");
    expect(classified.objectiveDigest).toBe("sha256:A");
    expect(classified.resources).toEqual([]);
    expect(classified.execution).toBeUndefined();
    expect(() => assertCommonWorkDiscoveryAllocation(classified, "A-prime")).toThrow(
      CommonWorkAuthorityError,
    );
    const approved = approveCommonWorkDiscovery(
      classified,
      { discoveryId: "A-prime", approvalReceipt: "approval:1" },
      3,
    );
    expect(() => assertCommonWorkDiscoveryAllocation(approved, "A-prime")).not.toThrow();
  });

  it("T28 rejects conflicting discovery replay and irrelevant approval", () => {
    const classified = classifyCommonWorkDiscovery(
      fresh(),
      {
        discoveryId: "noise",
        objective: "unrelated cleanup",
        classification: "irrelevant",
        rationale: "outside scope",
      },
      2,
    );
    expect(() =>
      classifyCommonWorkDiscovery(
        classified,
        {
          discoveryId: "noise",
          objective: "unrelated cleanup",
          classification: "separate_follow_up",
          rationale: "outside scope",
        },
        3,
      ),
    ).toThrow(CommonWorkConflictError);
    expect(() =>
      approveCommonWorkDiscovery(
        classified,
        { discoveryId: "noise", approvalReceipt: "approval:bad" },
        3,
      ),
    ).toThrow(CommonWorkConflictError);
  });

  it("T29 sends helpers once to lead while lead and direct requests report normally", () => {
    const record = fresh();
    const disposition = (
      agentId: string,
      assignment: "lead" | "helper" | "specialist",
      messageKind: "ack" | "progress" | "terminal",
      directlyUserRequested = false,
    ) =>
      commonWorkReportingDisposition(record, {
        agentId,
        assignment,
        messageKind,
        directlyUserRequested,
      });
    expect(disposition("helper", "helper", "progress")).toBe("suppress_user_flow");
    expect(disposition("helper", "helper", "terminal")).toBe("return_once_to_lead");
    expect(disposition("lead", "lead", "progress")).toBe("report_normally");
    expect(disposition("specialist", "specialist", "progress", true)).toBe("report_normally");
    expect(() => disposition("other", "lead", "progress")).toThrow(CommonWorkAuthorityError);
    const returned = recordCommonWorkHelperReturn(
      record,
      { helperAgentId: "helper", targetAgentId: "lead", receipt: "return:1" },
      2,
    );
    expect(
      recordCommonWorkHelperReturn(
        returned,
        { helperAgentId: "helper", targetAgentId: "lead", receipt: "return:1" },
        3,
      ),
    ).toBe(returned);
    expect(() =>
      recordCommonWorkHelperReturn(
        returned,
        { helperAgentId: "helper", targetAgentId: "lead", receipt: "return:2" },
        3,
      ),
    ).toThrow(CommonWorkConflictError);
  });

  it("T30 routes every non-lead, non-direct specialist through the admitted lead", () => {
    const disposition = (messageKind: "ack" | "progress" | "terminal") =>
      commonWorkReportingDisposition(fresh(), {
        agentId: "specialist",
        directlyUserRequested: false,
        assignment: "specialist",
        messageKind,
      });
    expect(disposition("ack")).toBe("suppress_user_flow");
    expect(disposition("progress")).toBe("suppress_user_flow");
    expect(disposition("terminal")).toBe("return_once_to_lead");
  });

  it("T31 requires review and discussion terminal output", () => {
    expect(() =>
      assertCommonWorkInteractionTerminal({ kind: "review", objective: "check design" }),
    ).toThrow(CommonWorkConflictError);
    expect(() =>
      assertCommonWorkInteractionTerminal({
        kind: "discussion",
        objective: "choose route",
        terminalOutput: { decision: "keep canonical route" },
      }),
    ).not.toThrow();
    expect(() =>
      assertCommonWorkInteractionTerminal({
        kind: "review",
        objective: "",
        terminalOutput: { conclusion: "looks good" },
      }),
    ).toThrow(CommonWorkConflictError);
  });
});

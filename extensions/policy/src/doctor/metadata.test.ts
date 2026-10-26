import { describe, expect, it } from "vitest";
import { scanPolicyDataHandling } from "../policy-state-data.js";
import { CHECK_IDS, POLICY_CHECK_IDS } from "./check-ids.js";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";
import { POLICY_RULE_METADATA } from "./metadata.js";

describe("policy doctor metadata", () => {
  it("classifies every policy finding for fix recommendation coverage", () => {
    expect([...POLICY_FIX_METADATA_BY_CHECK_ID.keys()].toSorted()).toEqual(
      [...POLICY_CHECK_IDS].toSorted(),
    );
  });

  it("points required-deny repair metadata at OpenClaw deny config paths", () => {
    expect(
      POLICY_FIX_METADATA_BY_CHECK_ID.get(CHECK_IDS.policyToolsRequiredDenyMissing)?.configTargets,
    ).toEqual(["tools.deny", "agents.entries.<id>.tools.deny"]);
  });

  it("limits automatic repairs to narrowing operations", () => {
    expect(
      [...POLICY_FIX_METADATA_BY_CHECK_ID.values()]
        .filter((rule) => rule.fixClass === "automatic")
        .map((rule) => rule.checkId)
        .toSorted(),
    ).toEqual(
      `agents-tool-not-denied channels-denied-provider
      data-handling-telemetry-content-capture gateway-control-ui-insecure
      gateway-http-endpoint-enabled gateway-remote-enabled
      ingress-group-mention-required ingress-open-groups-denied
      tools-elevated-enabled tools-required-deny-missing`
        .split(/\s+/)
        .map((id) => `policy/${id}`),
    );
  });

  it.each([CHECK_IDS.policyGatewayNonLoopbackBind, CHECK_IDS.policyGatewayNodeCommandDenied])(
    "requires review for the %s repair preview",
    (id) => expect(POLICY_FIX_METADATA_BY_CHECK_ID.get(id)?.fixClass).toBe("reviewRequired"),
  );

  it("declares how every policy rule is enforced", () => {
    expect(
      POLICY_RULE_METADATA.filter((rule) => rule.checkIds.length === 0).map((rule) =>
        rule.policyPath.join("."),
      ),
    ).toEqual(["dataHandling.sensitiveLogging.requireRedaction"]);
    expect(scanPolicyDataHandling({})).toContainEqual({
      id: "logging-redaction",
      kind: "sensitiveLoggingRedaction",
      source: "oc://openclaw.invariant/logging/redaction",
      scope: "global",
      value: true,
      explicit: true,
    });
  });
});

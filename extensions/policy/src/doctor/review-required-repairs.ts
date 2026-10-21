// Policy review-required repairs surface proposed config changes without applying them.
import type {
  HealthFinding,
  HealthRepairContext,
  HealthRepairEffect,
  HealthRepairResult,
} from "openclaw/plugin-sdk/health";
import { CHECK_IDS, type POLICY_CHECK_IDS } from "./check-ids.js";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";

type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

export const REVIEW_REQUIRED_REPAIR_CHECK_IDS = new Set<PolicyCheckId>([
  CHECK_IDS.policyGatewayNonLoopbackBind,
  CHECK_IDS.policyGatewayNodeCommandDenied,
]);

export function previewPolicyReviewRequiredRepair(
  _ctx: HealthRepairContext,
  findings: readonly HealthFinding[],
  checkId: PolicyCheckId,
): Promise<HealthRepairResult> {
  const metadata = POLICY_FIX_METADATA_BY_CHECK_ID.get(checkId);
  if (!REVIEW_REQUIRED_REPAIR_CHECK_IDS.has(checkId) || metadata?.fixClass !== "reviewRequired") {
    return Promise.resolve({
      status: "skipped",
      reason: "policy finding does not have a review-required repair preview",
      changes: [],
    });
  }
  if (findings.length === 0 || findings.some((finding) => finding.checkId !== checkId)) {
    return Promise.resolve({
      status: "skipped",
      reason: "policy finding is not classified as review-required",
      changes: [],
    });
  }

  const previews = new Map(
    findings
      .flatMap((finding) => previewForFinding(finding, checkId))
      .map((preview) => [preview.change, preview.effect]),
  );
  if (previews.size === 0) {
    return Promise.resolve({
      status: "skipped",
      reason: "policy review-required repair had no previewable config changes",
      changes: [],
    });
  }

  return Promise.resolve({
    status: "skipped",
    reason: "policy repair requires review before changing config",
    changes: [...previews.keys()],
    warnings: [...previews.keys()],
    effects: [...previews.values()],
  });
}

function previewForFinding(
  finding: HealthFinding,
  checkId: PolicyCheckId,
): readonly { readonly change: string; readonly effect: HealthRepairEffect }[] {
  let change: string;
  let action: string;
  let target: string;
  switch (checkId) {
    case CHECK_IDS.policyGatewayNonLoopbackBind:
      if (
        finding.ocPath !== "oc://openclaw.config/gateway/bind" &&
        finding.ocPath !== "oc://openclaw.config/gateway/customBindHost"
      ) {
        return [];
      }
      change = "Review required: set gateway.bind=loopback for policy conformance.";
      action = "would-set-after-review";
      target = "gateway.bind=loopback";
      break;
    case CHECK_IDS.policyGatewayNodeCommandDenied: {
      const command = finding.message.match(/Gateway node command '([^']+)'/)?.[1]?.trim();
      if (
        command === undefined ||
        command === "" ||
        finding.ocPath !== "oc://openclaw.config/gateway/nodes/commands/deny"
      ) {
        return [];
      }
      change = `Review required: add ${command} to gateway.nodes.commands.deny for policy conformance.`;
      action = "would-append-after-review";
      target = `gateway.nodes.commands.deny += ${command}`;
      break;
    }
    default:
      return [];
  }
  return [{ change, effect: { kind: "config", action, target, dryRunSafe: true } }];
}

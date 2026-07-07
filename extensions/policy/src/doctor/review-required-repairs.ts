// Policy review-required repairs surface proposed config changes without applying them.
import type {
  HealthFinding,
  HealthRepairContext,
  HealthRepairEffect,
  HealthRepairResult,
} from "openclaw/plugin-sdk/health";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";
import { CHECK_IDS, type POLICY_CHECK_IDS } from "./metadata.js";

type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

const REVIEW_REQUIRED_REPAIR_CHECK_IDS = new Set<PolicyCheckId>([
  CHECK_IDS.policyGatewayNonLoopbackBind,
  CHECK_IDS.policyGatewayNodeCommandDenied,
  CHECK_IDS.policyAgentsWorkspaceAccessDenied,
  CHECK_IDS.policyToolsProfileUnapproved,
  CHECK_IDS.policyToolsFsWorkspaceOnlyRequired,
  CHECK_IDS.policyToolsExecSecurityUnapproved,
  CHECK_IDS.policyToolsExecAskUnapproved,
  CHECK_IDS.policyToolsExecHostUnapproved,
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
  if (
    findings.length === 0 ||
    findings.some(
      (finding) =>
        finding.checkId !== checkId ||
        POLICY_FIX_METADATA_BY_CHECK_ID.get(finding.checkId)?.fixClass !== "reviewRequired",
    )
  ) {
    return Promise.resolve({
      status: "skipped",
      reason: "policy finding is not classified as review-required",
      changes: [],
    });
  }

  const previews = findings.flatMap((finding) => previewForFinding(finding, checkId));
  if (previews.length === 0) {
    return Promise.resolve({
      status: "skipped",
      reason: "policy review-required repair had no previewable config changes",
      changes: [],
    });
  }

  return Promise.resolve({
    status: "skipped",
    reason: "policy repair requires review before changing config",
    changes: uniqueStrings(previews.map((preview) => preview.change)),
    warnings: uniqueStrings(previews.map((preview) => preview.change)),
    effects: uniqueEffects(previews.map((preview) => preview.effect)),
  });
}

function previewForFinding(
  finding: HealthFinding,
  checkId: PolicyCheckId,
): readonly { readonly change: string; readonly effect: HealthRepairEffect }[] {
  switch (checkId) {
    case CHECK_IDS.policyGatewayNonLoopbackBind:
      return previewGatewayLoopbackBind(finding);
    case CHECK_IDS.policyGatewayNodeCommandDenied:
      return previewGatewayNodeDenyCommand(finding);
    case CHECK_IDS.policyAgentsWorkspaceAccessDenied:
      return previewAgentWorkspaceAccess(finding);
    case CHECK_IDS.policyToolsProfileUnapproved:
      return previewConfigPathSet(
        finding,
        "/tools/profile",
        "set tools.profile to an approved policy value",
        "approved value",
      );
    case CHECK_IDS.policyToolsFsWorkspaceOnlyRequired:
      return previewConfigPathSet(
        finding,
        "/tools/fs/workspaceOnly",
        "set tools.fs.workspaceOnly=true",
        "true",
      );
    case CHECK_IDS.policyToolsExecSecurityUnapproved:
      return previewConfigPathSet(
        finding,
        "/tools/exec/security",
        "set tools.exec.security to an approved policy value",
        "approved value",
      );
    case CHECK_IDS.policyToolsExecAskUnapproved:
      return previewConfigPathSet(
        finding,
        "/tools/exec/ask",
        "set tools.exec.ask to an approved policy value",
        "approved value",
      );
    case CHECK_IDS.policyToolsExecHostUnapproved:
      return previewConfigPathSet(
        finding,
        "/tools/exec/host",
        "set tools.exec.host to an approved policy value",
        "approved value",
      );
    default:
      return [];
  }
}

function previewGatewayLoopbackBind(
  finding: HealthFinding,
): readonly { readonly change: string; readonly effect: HealthRepairEffect }[] {
  if (
    finding.ocPath !== "oc://openclaw.config/gateway/bind" &&
    finding.ocPath !== "oc://openclaw.config/gateway/customBindHost"
  ) {
    return [];
  }
  return [
    {
      change: "Review required: set gateway.bind=loopback for policy conformance.",
      effect: {
        kind: "config",
        action: "would-set-after-review",
        target: "gateway.bind=loopback",
        dryRunSafe: true,
      },
    },
  ];
}

function previewGatewayNodeDenyCommand(
  finding: HealthFinding,
): readonly { readonly change: string; readonly effect: HealthRepairEffect }[] {
  const command = finding.message.match(/Gateway node command '([^']+)'/)?.[1]?.trim();
  if (
    command === undefined ||
    command === "" ||
    finding.ocPath !== "oc://openclaw.config/gateway/nodes/denyCommands"
  ) {
    return [];
  }
  return [
    {
      change: `Review required: add ${command} to gateway.nodes.denyCommands for policy conformance.`,
      effect: {
        kind: "config",
        action: "would-append-after-review",
        target: `gateway.nodes.denyCommands += ${command}`,
        dryRunSafe: true,
      },
    },
  ];
}

function previewAgentWorkspaceAccess(
  finding: HealthFinding,
): readonly { readonly change: string; readonly effect: HealthRepairEffect }[] {
  const target = configTargetFromOcPath(finding.ocPath);
  if (
    target === undefined ||
    !finding.ocPath.includes("/agents/") ||
    !finding.ocPath.includes("/sandbox/") ||
    !(finding.ocPath.endsWith("/workspaceAccess") || finding.ocPath.endsWith("/mode"))
  ) {
    return [];
  }
  return [
    {
      change:
        "Review required: set agent sandbox workspace access to an allowed policy value for policy conformance.",
      effect: {
        kind: "config",
        action: "would-set-after-review",
        target: `${target} -> allowed value`,
        dryRunSafe: true,
      },
    },
  ];
}

function previewConfigPathSet(
  finding: HealthFinding,
  suffix: string,
  changeText: string,
  targetValue: string,
): readonly { readonly change: string; readonly effect: HealthRepairEffect }[] {
  const target = configTargetFromOcPath(finding.ocPath);
  if (target === undefined || !finding.ocPath.endsWith(suffix)) {
    return [];
  }
  return [
    {
      change: `Review required: ${changeText} for policy conformance.`,
      effect: {
        kind: "config",
        action: "would-set-after-review",
        target: `${target} -> ${targetValue}`,
        dryRunSafe: true,
      },
    },
  ];
}

function configTargetFromOcPath(ocPath: string | undefined): string | undefined {
  const prefix = "oc://openclaw.config/";
  if (ocPath === undefined || !ocPath.startsWith(prefix)) {
    return undefined;
  }
  return ocPath.slice(prefix.length).replaceAll("/", ".");
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueEffects(values: readonly HealthRepairEffect[]): readonly HealthRepairEffect[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

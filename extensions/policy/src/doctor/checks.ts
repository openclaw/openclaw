import type {
  HealthCheck,
  HealthFinding,
  HealthRepairContext,
  HealthRepairEffect,
  HealthRepairResult,
} from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "./automatic-repairs.js";
import { CHECK_IDS, type POLICY_CHECK_IDS } from "./check-ids.js";
import { evaluatePolicy } from "./evaluation.js";
import { POLICY_CHECK_METADATA, POLICY_FIX_METADATA_BY_CHECK_ID } from "./fix-metadata.js";
import {
  channelIdsFromFindings,
  disableChannels,
  workspaceRepairsEnabled,
} from "./policy-runtime.js";

// Policy review-required repairs surface proposed config changes without applying them.
type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

const REVIEW_REQUIRED_REPAIR_CHECK_IDS = new Set<PolicyCheckId>([
  CHECK_IDS.policyGatewayNonLoopbackBind,
  CHECK_IDS.policyGatewayNodeCommandDenied,
]);

function previewPolicyReviewRequiredRepair(
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

export function createPolicyDoctorChecks(): readonly HealthCheck[] {
  return POLICY_CHECK_METADATA.map(({ description, fix }) => {
    const id = fix.checkId;
    const check: HealthCheck = {
      id,
      kind: "plugin",
      description,
      source: "policy",
      async detect(ctx) {
        const evaluation = await evaluatePolicy(ctx);
        return evaluation.findings.filter((finding) => finding.checkId === id);
      },
    };
    const repair =
      id === CHECK_IDS.policyDeniedChannelProvider
        ? repairDeniedChannels
        : fix.fixClass === "automatic"
          ? repairPolicyAutomaticNarrower
          : REVIEW_REQUIRED_REPAIR_CHECK_IDS.has(id)
            ? previewPolicyReviewRequiredRepair
            : undefined;
    if (repair) {
      check.repair = (ctx, findings) => repair(ctx, findings, id);
    }
    return check;
  });
}

async function repairDeniedChannels(
  ctx: HealthRepairContext,
  findings: readonly HealthFinding[],
): Promise<HealthRepairResult> {
  if (!workspaceRepairsEnabled(ctx)) {
    return {
      status: "skipped",
      reason: "workspace repairs are disabled",
      changes: [],
      warnings: [
        "Skipped channel config repair. Enable plugins.entries.policy.config.workspaceRepairs to let doctor --fix edit workspace files.",
      ],
    };
  }
  const channelIds = channelIdsFromFindings(findings);
  if (channelIds.length === 0) {
    return {
      status: "skipped",
      reason: "no channel findings matched a configurable channel",
      changes: [],
    };
  }
  const next = disableChannels(ctx.cfg, channelIds);
  if (next.changed.length === 0) {
    return {
      status: "skipped",
      reason: "matching channels were already disabled or missing",
      changes: [],
    };
  }
  return {
    config: next.config,
    changes: next.changed.map((id) => `Disabled channels.${id}.enabled for policy conformance.`),
  };
}

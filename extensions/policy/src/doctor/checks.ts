import type {
  HealthCheck,
  HealthFinding,
  HealthRepairContext,
  HealthRepairResult,
} from "openclaw/plugin-sdk/health";
import { repairPolicyAutomaticNarrower } from "./automatic-repairs.js";
import { CHECK_IDS } from "./check-ids.js";
import { evaluatePolicy } from "./evaluation.js";
import { POLICY_CHECK_METADATA } from "./fix-metadata.js";
import {
  channelIdsFromFindings,
  disableChannels,
  workspaceRepairsEnabled,
} from "./policy-runtime.js";
import {
  previewPolicyReviewRequiredRepair,
  REVIEW_REQUIRED_REPAIR_CHECK_IDS,
} from "./review-required-repairs.js";

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

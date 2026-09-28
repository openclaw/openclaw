#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "./record-shared.mjs";
import { resolveReleasePublishInputs } from "./release-publish-inputs.mjs";
import { parseReleaseVersion } from "./release-version.mjs";

export type ReleasePublishGate = {
  id: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
  remediation: string;
};

type ReleasePublishConsumer = "publisher" | "core-npm" | "stable-closeout";

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function scalar(value: unknown): string {
  return value === null || value === undefined || value === false
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}

export function evaluateReleasePublishGates(input: {
  manifest: unknown;
  releaseTag: string;
  npmDistTag: string;
  consumer: ReleasePublishConsumer;
  expectedSha?: string;
  expectedReleaseProfile?: string;
}): ReleasePublishGate[] {
  const { manifest, consumer } = input;
  const gates: ReleasePublishGate[] = [];
  const add = (id: string, pass: boolean, message: string, remediation: string) => {
    gates.push({
      id: `${consumer}.${id}`,
      status: pass ? "PASS" : "FAIL",
      message: pass ? `${id} requirement satisfied.` : message,
      remediation: pass ? "" : remediation,
    });
  };
  const profile = scalar(field(manifest, "releaseProfile"));
  try {
    resolveReleasePublishInputs(manifest, {
      targetSha: input.expectedSha,
      npmDistTag: input.npmDistTag,
    });
  } catch (error) {
    add(
      "publish-inputs",
      false,
      error instanceof Error ? error.message : String(error),
      "Reseal publication inputs for the exact release source and npm selector without waivers.",
    );
  }
  const rerunGroup = scalar(field(manifest, "rerunGroup"));
  const soak = field(manifest, "runReleaseSoak");
  if (consumer === "publisher") {
    const workflow = scalar(field(manifest, "workflowName"));
    add(
      "workflow",
      workflow === "Full Release Validation",
      `Full release validation manifest workflow mismatch: ${workflow}`,
      "Select a Full Release Validation manifest.",
    );
    if (input.expectedSha !== undefined) {
      const target = scalar(field(manifest, "targetSha"));
      add(
        "target",
        target === input.expectedSha,
        `Full release validation target SHA mismatch: expected ${input.expectedSha}, got ${target}`,
        "Select validation evidence for the exact release tag commit.",
      );
    }
    if (input.expectedReleaseProfile && input.expectedReleaseProfile !== "from-validation") {
      add(
        "profile",
        profile === input.expectedReleaseProfile,
        `Full release validation profile mismatch: expected ${input.expectedReleaseProfile}, got ${profile}`,
        "Use release_profile=from-validation or select matching validation evidence.",
      );
    }
  }
  add(
    "rerun-group",
    rerunGroup === "all",
    `Full release validation must run rerun_group=all before npm publish; got ${rerunGroup}`,
    "Seal successful Full Release Validation with rerun_group=all using pnpm frv continue.",
  );
  const stableTag = !input.releaseTag.includes("-alpha.") && !input.releaseTag.includes("-beta.");
  const soaked = consumer === "stable-closeout" ? soak === "true" : scalar(soak) === "true";
  const soakRequired = consumer === "stable-closeout" || stableTag;
  const performance = field(field(manifest, "controls"), "performanceBlocking");
  const blocking =
    consumer === "stable-closeout" ? performance === true : scalar(performance) === "true";
  const blockingRequired =
    soakRequired || (consumer === "publisher" ? profile !== "beta" : input.npmDistTag !== "beta");
  add(
    "performance",
    !blockingRequired || blocking,
    "Full release validation manifest does not record blocking product performance evidence.",
    "Rerun Full Release Validation with blocking product performance validation.",
  );
  if (soakRequired) {
    add(
      "stable-profile",
      profile === "stable" || profile === "full",
      `Stable releases require stable/full validation; got ${profile}`,
      "Rerun Full Release Validation with release_profile=stable or full.",
    );
  }
  add(
    "soak",
    !soakRequired || soaked,
    "Stable releases require Full Release Validation with runReleaseSoak=true.",
    "Rerun Full Release Validation with release soak.",
  );
  const waived =
    field(field(manifest, "validationInputs"), "laneWaiver") ||
    field(field(manifest, "publishInputs"), "stableSoakWaiver");
  const advisory = field(manifest, "advisoryJobs");
  add(
    "selected-lanes",
    !waived && (advisory === undefined || (Array.isArray(advisory) && advisory.length === 0)),
    "Waived or advisory release evidence is no longer accepted.",
    "Fix failed selected lanes and rerun Full Release Validation without waivers.",
  );
  if (consumer === "stable-closeout") {
    for (const gate of gates) {
      if (gate.status === "FAIL") {
        gate.remediation =
          "Use the original strict published evidence. Historical waiver-bearing closeout replay is unsupported; a fresh validation run cannot replace its published binding.";
        gate.message += ` ${gate.remediation}`;
      }
    }
  }
  return gates;
}

export function evaluateReleaseBootstrapGate(input: {
  releaseTag?: unknown;
  publishTag?: unknown;
  releaseProfile?: unknown;
  packageVersion?: string;
}): ReleasePublishGate {
  const version = typeof input.releaseTag === "string" ? input.releaseTag.slice(1) : "";
  const parsed = parseReleaseVersion(version);
  const eligible =
    input.releaseTag === `v${version}` &&
    parsed?.channel === "stable" &&
    parsed.patch < 33 &&
    input.publishTag === "latest" &&
    (input.packageVersion === undefined || input.packageVersion === version) &&
    (input.releaseProfile === "stable" || input.releaseProfile === "full");
  return {
    id: "plugin-npm.stable-bootstrap",
    status: eligible ? "PASS" : "FAIL",
    message: eligible
      ? "Stable npm bootstrap approval is eligible for this release."
      : "Stable npm bootstrap requires a regular stable tag matching the package version, latest, and stable/full validation.",
    remediation:
      "Select stable/full validation for the regular stable/latest release. The parent must attest the exact selected package set before bootstrap publication.",
  };
}

export function evaluateStableRollbackDrill(input: {
  rollbackDrillId?: string;
  rollbackDrillDate?: string;
  nowMs: number;
  allowStaleRollbackDrill?: boolean;
}): ReleasePublishGate[] {
  const gates: ReleasePublishGate[] = [
    {
      id: "stable-closeout.rollback-drill-id",
      status: input.rollbackDrillId?.trim() ? "PASS" : "FAIL",
      message: input.rollbackDrillId?.trim()
        ? "Rollback drill identifier is recorded."
        : "rollback drill id is required.",
      remediation:
        "Record the private drill identifier in RELEASE_ROLLBACK_DRILL_ID or supply rollback_drill_id to stable closeout.",
    },
  ];
  const date = input.rollbackDrillDate;
  let dateError = "";
  const drillDateMs =
    typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date)
      ? new Date(`${date}T00:00:00.000Z`).getTime()
      : Number.NaN;
  if (!Number.isFinite(drillDateMs) || new Date(drillDateMs).toISOString().slice(0, 10) !== date) {
    dateError = `rollback drill date is invalid: ${date ?? "<missing>"}.`;
  } else if (input.nowMs - drillDateMs < 0) {
    dateError = `rollback drill date is in the future: ${date}.`;
  } else if (
    !input.allowStaleRollbackDrill &&
    input.nowMs - drillDateMs > 90 * 24 * 60 * 60 * 1000
  ) {
    dateError = `rollback drill is older than 90 days: ${date}. Run the private rollback drill before stable closeout.`;
  }
  gates.push({
    id: "stable-closeout.rollback-drill-date",
    status: dateError ? "FAIL" : "PASS",
    message:
      dateError || "Rollback drill date satisfies the stable closeout freshness requirement.",
    remediation:
      "Run the private rollback drill and record its UTC date in RELEASE_ROLLBACK_DRILL_DATE or supply rollback_drill_date to stable closeout.",
  });
  return gates;
}

function main() {
  const { values } = parseArgs({
    options: { consumer: { type: "string" }, manifest: { type: "string" } },
  });
  const consumer = values.consumer;
  if (consumer !== "publisher" && consumer !== "core-npm" && consumer !== "stable-closeout") {
    throw new Error("--consumer must be publisher, core-npm, or stable-closeout.");
  }
  if (!values.manifest) {
    throw new Error("--manifest is required.");
  }
  const manifest: unknown = JSON.parse(readFileSync(values.manifest, "utf8"));
  const env = process.env;
  const resolved = resolveReleasePublishInputs(manifest, {
    pluginSdkApiAcknowledgement: env.PLUGIN_SDK_API_ACKNOWLEDGEMENT,
    targetSha: env.EXPECTED_SHA,
    npmDistTag: env.RELEASE_NPM_DIST_TAG,
  });
  const gates = evaluateReleasePublishGates({
    manifest,
    consumer,
    releaseTag: env.RELEASE_TAG ?? "",
    npmDistTag: env.RELEASE_NPM_DIST_TAG ?? "",
    expectedSha: env.EXPECTED_SHA,
    expectedReleaseProfile: env.EXPECTED_RELEASE_PROFILE,
  });
  for (const gate of gates) {
    if (gate.status === "FAIL") {
      throw new Error(gate.message);
    }
  }
  if (consumer !== "stable-closeout" && env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `plugin_sdk_api_acknowledgement=${resolved.pluginSdkApiAcknowledgement}\nnpm_decisions=${JSON.stringify(resolved.npmDecisions ?? [])}\n`,
    );
  }
  if (consumer === "publisher" && env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `release_profile=${scalar(field(manifest, "releaseProfile"))}\ncoverage_policy=${scalar(field(field(manifest, "validationInputs"), "coveragePolicy"))}\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[release-publish-gates] FAILED (exit 1)");
    process.exitCode = 1;
  }
}

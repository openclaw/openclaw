#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { validateReleaseApprovalReceipt } from "./release-approval-receipt.mjs";
import {
  runReleaseToolingGh,
  verifyReleaseToolingIdentity,
  verifyReleaseWorkflowRun,
} from "./release-tooling-identity.mjs";

const INSTALLERS = ["OpenClawCompanion-Setup-arm64.exe", "OpenClawCompanion-Setup-x64.exe"];
const MANIFEST = "OpenClawCompanion-SHA256SUMS.txt";
const WORKFLOW = ".github/workflows/windows-node-release.yml";
const env = process.env;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function source() {
  requireValue(
    /^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/u.test(
      env.WINDOWS_NODE_TAG ?? "",
    ),
    "Windows source must use an exact release tag.",
  );
  const digests = JSON.parse(env.WINDOWS_NODE_INSTALLER_DIGESTS ?? "null");
  requireValue(
    digests !== null &&
      isDeepStrictEqual(Object.keys(digests).toSorted(), INSTALLERS) &&
      INSTALLERS.every((name) => /^sha256:[a-f0-9]{64}$/iu.test(digests[name])),
    "Windows approval requires exactly the two pinned installer digests.",
  );
  return {
    repository: "openclaw/openclaw-windows-node",
    tag: env.WINDOWS_NODE_TAG,
    installerDigests: Object.fromEntries(
      INSTALLERS.map((name) => [name, digests[name].toLowerCase()]),
    ),
  };
}

function readApproval(path) {
  const selectedSource = source();
  const approval = JSON.parse(readFileSync(path, "utf8"));
  validateReleaseApprovalReceipt(approval.release);
  requireValue(
    isDeepStrictEqual(Object.keys(approval).toSorted(), [
      "release",
      "signedTagObjectSha",
      "source",
      "version",
    ]) &&
      approval.version === 1 &&
      /^[a-f0-9]{40}$/u.test(approval.signedTagObjectSha) &&
      (approval.source === null
        ? env.DIRECT_RELEASE_RECOVERY === "true"
        : isDeepStrictEqual(approval.source, selectedSource)),
    "Windows approval source or fields do not match this promotion.",
  );
  const expected = {
    repository: env.GITHUB_REPOSITORY,
    parentRunId: env.RELEASE_PUBLISH_RUN_ID,
    parentRunAttempt: env.RELEASE_PUBLISH_RUN_ATTEMPT,
    toolingRef: env.GITHUB_REF_NAME,
    toolingFullRef: env.GITHUB_REF,
    toolingSha: env.GITHUB_WORKFLOW_SHA,
    releaseTag: env.RELEASE_TAG,
  };
  for (const [key, value] of Object.entries(expected)) {
    requireValue(approval.release[key] === value, `Windows approval ${key} mismatch.`);
  }
  requireValue(
    approval.release.npmDistTag !== "extended-stable",
    "Windows promotion excludes extended-stable.",
  );
  requireValue(
    env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${WORKFLOW}@${env.GITHUB_REF}`,
    "Executing Windows workflow does not match approved tooling.",
  );
  return approval;
}

function verifyAuthority(approval) {
  const release = approval.release;
  const target = JSON.parse(
    runReleaseToolingGh([
      "release",
      "view",
      release.releaseTag,
      "--repo",
      release.repository,
      "--json",
      "tagName,isPrerelease",
    ]),
  );
  requireValue(
    target.tagName === release.releaseTag &&
      target.isPrerelease === release.releaseTag.includes("-beta."),
    "Windows target release does not match the approved release channel.",
  );
  const tagRef = `refs/tags/${release.releaseTag}`;
  const refs = new Map(
    execFileSync("git", ["ls-remote", "--tags", "origin", tagRef, `${tagRef}^{}`], {
      encoding: "utf8",
      timeout: 60_000,
    })
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/u);
        return [ref, sha];
      }),
  );
  requireValue(
    refs.get(tagRef) === approval.signedTagObjectSha &&
      (refs.get(`${tagRef}^{}`) ?? refs.get(tagRef)) === release.targetSha,
    "Windows release tag moved, disappeared, or changed after signature verification.",
  );
  verifyReleaseToolingIdentity({
    repository: release.repository,
    workflowFullRef: release.toolingFullRef,
    workflowRef: release.toolingRef,
    workflowSha: release.toolingSha,
    releasePublishFullRef: release.toolingFullRef,
    releasePublishRef: release.toolingRef,
    releasePublishRunId: release.parentRunId,
    releasePublishRunAttempt: release.parentRunAttempt,
    releasePublishParentStatePolicy:
      env.DIRECT_RELEASE_RECOVERY === "true" ? "manual-recovery" : "active-or-success",
  });
  verifyReleaseWorkflowRun({
    repository: release.repository,
    workflowFullRef: env.GITHUB_REF,
    workflowRef: env.GITHUB_REF_NAME,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    workflowPath: WORKFLOW,
    workflowEvent: "workflow_dispatch",
    runStatePolicy: "active",
  });
}

function verifyWriter() {
  const inventory = JSON.parse(
    runReleaseToolingGh([
      "api",
      `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
      "--method",
      "GET",
    ]),
  );
  const writers = inventory.jobs?.filter((job) => job.name === "Promote signed Windows installers");
  // GitHub starts this job only after its npm-release environment gate admits it.
  // Historical approvals cannot authorize a waiting, rejected, or superseded writer.
  requireValue(
    Array.isArray(inventory.jobs) &&
      inventory.total_count === inventory.jobs.length &&
      writers.length === 1 &&
      String(writers[0].run_id) === env.GITHUB_RUN_ID &&
      writers[0].head_sha === env.GITHUB_WORKFLOW_SHA &&
      writers[0].status === "in_progress" &&
      writers[0].conclusion === null,
    "The protected Windows writer is not active for this attempt.",
  );
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    approval: { type: "string" },
    receipt: { type: "string" },
    output: { type: "string" },
    assets: { type: "string" },
  },
});
if (positionals.length === 1 && positionals[0] === "create" && values.receipt && values.output) {
  const release = validateReleaseApprovalReceipt(JSON.parse(readFileSync(values.receipt, "utf8")));
  requireValue(
    /^[a-f0-9]{40}$/u.test(env.SIGNED_RELEASE_TAG_OBJECT_SHA ?? ""),
    "Windows approval needs the verified signed tag object.",
  );
  mkdirSync(dirname(values.output), { recursive: true });
  writeFileSync(
    values.output,
    `${JSON.stringify({ version: 1, release, signedTagObjectSha: env.SIGNED_RELEASE_TAG_OBJECT_SHA, source: !env.WINDOWS_NODE_TAG && !env.WINDOWS_NODE_INSTALLER_DIGESTS ? null : source() })}\n`,
  );
} else if (
  positionals.length === 1 &&
  ["verify", "publish"].includes(positionals[0]) &&
  values.approval
) {
  const approval = readApproval(values.approval);
  const release = approval.release;
  runReleaseToolingGh([
    "attestation",
    "verify",
    values.approval,
    "--repo",
    release.repository,
    "--signer-workflow",
    `${release.repository}/${release.parentWorkflow}`,
    "--signer-digest",
    release.toolingSha,
    "--source-ref",
    release.toolingFullRef,
    "--source-digest",
    release.toolingSha,
    "--deny-self-hosted-runners",
  ]);
  if (positionals[0] === "verify") {
    verifyAuthority(approval);
  } else {
    requireValue(
      Boolean(values.assets),
      "Windows publication requires the verified asset directory.",
    );
    for (const name of [...INSTALLERS, MANIFEST]) {
      // Recheck after the environment wait and after every preceding upload.
      verifyAuthority(approval);
      verifyWriter();
      runReleaseToolingGh([
        "release",
        "upload",
        approval.release.releaseTag,
        join(values.assets, name),
        "--repo",
        approval.release.repository,
        "--clobber",
      ]);
    }
  }
} else {
  throw new Error(
    "Expected create --receipt <path> --output <path>, verify --approval <path>, or publish --approval <path> --assets <directory>.",
  );
}

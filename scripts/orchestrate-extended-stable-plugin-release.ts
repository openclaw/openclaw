#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { loadExtendedStablePluginCohort } from "../src/plugins/extended-stable-plugin-cohort.js";
import {
  collectAllPublishablePluginPackageNames,
  collectExtendedStableCohortPackageNames,
  parseEligibleCohortEvidence,
} from "./generate-extended-stable-plugin-cohort.js";
import { loadExtendedStablePluginSupport } from "./lib/extended-stable-plugin-support.js";
import { verifyNpmPackage } from "./lib/npm-package-readback.js";
import { verifySelectorHandoff } from "./verify-extended-stable-selector-handoff.js";

type Args = {
  releaseTag: string;
  sourceSha: string;
  workflowRef: string;
  preflightRunId: string;
  validationRunId: string;
  output: string;
};

type Run = {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  event: string;
  head_sha: string;
  head_branch: string;
  path: string;
  html_url: string;
  created_at: string;
};

type Artifact = {
  id: number;
  name: string;
  expired: boolean;
  digest: string;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new Error("Orchestrator requires unique --key value arguments.");
    }
    values.set(key, value);
  }
  const names = [
    "release-tag",
    "source-sha",
    "workflow-ref",
    "preflight-run-id",
    "validation-run-id",
    "output",
  ];
  if (values.size !== names.length || names.some((name) => !values.has(`--${name}`))) {
    throw new Error(`Orchestrator requires exactly: ${names.join(", ")}.`);
  }
  return Object.fromEntries(
    names.map((name) => [
      name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      values.get(`--${name}`)!,
    ]),
  ) as Args;
}

function command(
  executable: string,
  args: string[],
  options: { encoding?: null | "utf8"; env?: NodeJS.ProcessEnv } = {},
): Buffer | string {
  const encoding = Object.hasOwn(options, "encoding") ? options.encoding : "utf8";
  return execFileSync(executable, args, {
    encoding,
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60 * 1000,
  });
}

function ghJson(args: string[]): unknown {
  return JSON.parse(String(command("gh", args))) as unknown;
}

async function dispatchWorkflow(
  repository: string,
  workflow: string,
  ref: string,
  inputs: string[],
  expectedHeadSha?: string,
): Promise<number> {
  const dispatchStartedAt = Date.now() - 1_000;
  command("gh", ["workflow", "run", "--repo", repository, workflow, "--ref", ref, ...inputs]);
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = ghJson([
      "api",
      "--method",
      "GET",
      `repos/${repository}/actions/workflows/${workflow}/runs`,
      "-f",
      "event=workflow_dispatch",
      "-f",
      `branch=${ref}`,
      "-f",
      "per_page=100",
    ]) as { workflow_runs: Run[] };
    const matches = response.workflow_runs.filter((run) => {
      const createdAt = Date.parse(run.created_at);
      return (
        Number.isFinite(createdAt) &&
        createdAt >= dispatchStartedAt &&
        run.event === "workflow_dispatch" &&
        run.head_branch === ref &&
        (expectedHeadSha === undefined || run.head_sha === expectedHeadSha)
      );
    });
    if (matches.length > 1) {
      throw new Error(`${workflow} dispatch matched multiple new runs; refusing to guess.`);
    }
    if (matches.length === 1) {
      const run = matches[0]!;
      console.log(`Dispatched ${workflow}: ${run.html_url}`);
      return run.id;
    }
    await sleep(2_000);
  }
  throw new Error(`${workflow} dispatch could not be correlated to exactly one new run.`);
}

async function approvePendingDeployments(repository: string, runId: number): Promise<void> {
  let deployments: Array<{
    current_user_can_approve: boolean;
    environment: { id: number; name: string };
  }>;
  try {
    deployments = ghJson([
      "api",
      `repos/${repository}/actions/runs/${runId}/pending_deployments`,
    ]) as Array<{
      current_user_can_approve: boolean;
      environment: { id: number; name: string };
    }>;
  } catch {
    // A child without an environment gate can reject this endpoint while it starts.
    return;
  }
  for (const deployment of deployments) {
    if (!deployment.current_user_can_approve) {
      continue;
    }
    command("gh", [
      "api",
      "-X",
      "POST",
      `repos/${repository}/actions/runs/${runId}/pending_deployments`,
      "-F",
      `environment_ids[]=${deployment.environment.id}`,
      "-f",
      "state=approved",
      "-f",
      "comment=Approve child release gate after parent release approval",
    ]);
    console.log(`Approved ${deployment.environment.name} for run ${runId}.`);
  }
}

async function waitForRun(repository: string, runId: number): Promise<Run> {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const run = ghJson(["api", `repos/${repository}/actions/runs/${runId}`]) as Run;
    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`Actions run ${run.html_url} completed with ${run.conclusion}.`);
      }
      return run;
    }
    await approvePendingDeployments(repository, runId);
    await sleep(15_000);
  }
  throw new Error(`Actions run ${runId} did not complete within two hours.`);
}

function artifactForRun(repository: string, runId: number, expectedName: string): Artifact {
  const response = ghJson([
    "api",
    `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  ]) as { artifacts: Artifact[] };
  const matches = response.artifacts.filter(
    (artifact) => artifact.name === expectedName && !artifact.expired,
  );
  if (matches.length !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(matches[0]!.digest)) {
    throw new Error(`Run ${runId} must have one unexpired ${expectedName} artifact with a digest.`);
  }
  return matches[0]!;
}

function downloadVerifiedArtifact(
  repository: string,
  artifact: Artifact,
  expectedFilename: string,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const archive = command(
    "gh",
    ["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`],
    { encoding: null },
  ) as Buffer;
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  if (digest !== artifact.digest) {
    throw new Error(`Artifact ${artifact.name} bytes do not match its Actions API digest.`);
  }
  const archivePath = join(outputDir, "artifact.zip");
  writeFileSync(archivePath, archive);
  const listing = String(command("unzip", ["-Z1", archivePath]))
    .split(/\r?\n/u)
    .filter(Boolean);
  if (listing.length !== 1 || listing[0] !== expectedFilename) {
    throw new Error(`Artifact ${artifact.name} must contain exactly ${expectedFilename}.`);
  }
  const resultPath = join(outputDir, expectedFilename);
  writeFileSync(
    resultPath,
    command("unzip", ["-p", archivePath, expectedFilename], { encoding: null }),
  );
  return resultPath;
}

function selectorSnapshot(packageName: string): {
  latest: string | null;
  extendedStable: string | null;
} {
  const value: unknown = JSON.parse(
    String(
      command("npm", [
        "view",
        packageName,
        "dist-tags",
        "--json",
        "--registry=https://registry.npmjs.org/",
      ]),
    ),
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${packageName} dist-tag readback is invalid.`);
  }
  const tags = value as Record<string, unknown>;
  const read = (tag: "latest" | "extended-stable"): string | null => {
    const selected = tags[tag];
    if (selected === undefined) {
      return null;
    }
    if (typeof selected !== "string" || selected.length === 0) {
      throw new Error(`${packageName} ${tag} selector readback is invalid.`);
    }
    return selected;
  };
  return {
    latest: read("latest"),
    extendedStable: read("extended-stable"),
  };
}

function assertRunIdentity(run: Run, params: { path: string; sha?: string; event?: string }): void {
  if (
    !run.path.startsWith(params.path) ||
    (params.sha !== undefined && run.head_sha !== params.sha) ||
    (params.event !== undefined && run.event !== params.event)
  ) {
    throw new Error(`Actions run ${run.id} identity does not match ${params.path}.`);
  }
}

function verifyJsonScript(script: string, args: string[], env?: NodeJS.ProcessEnv): unknown {
  return JSON.parse(
    String(command(process.execPath, ["--import", "tsx", script, ...args], { env })),
  );
}

async function verifyMonthlyCohortProof(params: {
  repository: string;
  releaseVersion: string;
  rootDir: string;
  outputDir: string;
}) {
  const cohort = loadExtendedStablePluginCohort(params.rootDir);
  const [releaseYear, releaseMonth] = params.releaseVersion.split(".");
  if (cohort.releaseLine !== `${releaseYear}.${releaseMonth}`) {
    throw new Error("Packaged monthly cohort release line does not match the candidate release.");
  }
  const evidenceAsset = `openclaw-${cohort.baselineVersion}-postpublish-evidence.json`;
  const checksumAsset = `${evidenceAsset}.sha256`;
  const evidenceDir = join(params.outputDir, "monthly-cohort-evidence");
  rmSync(evidenceDir, { force: true, recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  command("gh", [
    "release",
    "download",
    `v${cohort.baselineVersion}`,
    "--repo",
    params.repository,
    "--pattern",
    evidenceAsset,
    "--pattern",
    checksumAsset,
    "--dir",
    evidenceDir,
  ]);
  const evidenceBytes = readFileSync(join(evidenceDir, evidenceAsset));
  const evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
  const checksum = readFileSync(join(evidenceDir, checksumAsset), "utf8").trim();
  if (checksum !== `${evidenceSha256}  ${evidenceAsset}`) {
    throw new Error("Monthly cohort source evidence does not match its immutable checksum asset.");
  }
  const evidence = parseEligibleCohortEvidence({
    value: JSON.parse(evidenceBytes.toString("utf8")) as unknown,
    releaseLine: cohort.releaseLine,
    expectedPackageNames: collectAllPublishablePluginPackageNames(params.rootDir),
  });
  if (!evidence || evidence.releaseVersion !== cohort.baselineVersion) {
    throw new Error("Monthly cohort source evidence is not an eligible full regular release.");
  }
  const evidenceByPackage = new Map(
    evidence.pluginNpmPackages.map((plugin) => [plugin.packageName, plugin.npmIntegrity]),
  );
  const packages: Array<{ packageName: string; version: string; npmIntegrity: string }> = [];
  for (const packageName of collectExtendedStableCohortPackageNames(params.rootDir)) {
    const readback = await verifyNpmPackage(packageName, cohort.baselineVersion);
    const npmIntegrity = readback.integrity;
    if (!npmIntegrity || npmIntegrity !== evidenceByPackage.get(packageName)) {
      throw new Error(
        `${packageName}@${cohort.baselineVersion} integrity differs from cohort evidence.`,
      );
    }
    packages.push({ packageName, version: cohort.baselineVersion, npmIntegrity });
  }
  return {
    releaseLine: cohort.releaseLine,
    baselineVersion: cohort.baselineVersion,
    sourceReleaseTag: evidence.releaseTag,
    sourceEvidenceSha256: evidenceSha256,
    packages,
  };
}

export async function orchestrate(args: Args, rootDir = resolve(".")): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const parentRunId = process.env.GITHUB_RUN_ID;
  if (!repository || !parentRunId) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_RUN_ID are required.");
  }
  const releaseVersion = args.releaseTag.replace(/^v/u, "");
  const support = loadExtendedStablePluginSupport(rootDir);
  const monthlyCohort = await verifyMonthlyCohortProof({
    repository,
    releaseVersion,
    rootDir,
    outputDir: dirname(args.output),
  });
  const packageNames = ["openclaw", ...support.plugins.map((plugin) => plugin.packageName)];
  const selectorsBefore = Object.fromEntries(
    packageNames.map((packageName) => [packageName, selectorSnapshot(packageName)]),
  );

  const pluginRunId = await dispatchWorkflow(
    repository,
    "plugin-npm-release.yml",
    args.workflowRef,
    [
      "-f",
      "publish_scope=extended-stable",
      "-f",
      `ref=${args.sourceSha}`,
      "-f",
      `release_publish_run_id=${parentRunId}`,
    ],
    args.sourceSha,
  );
  const pluginRun = await waitForRun(repository, pluginRunId);
  assertRunIdentity(pluginRun, {
    path: ".github/workflows/plugin-npm-release.yml",
    sha: args.sourceSha,
    event: "workflow_dispatch",
  });
  const pluginArtifact = artifactForRun(
    repository,
    pluginRunId,
    `extended-stable-plugin-publication-${pluginRunId}-${pluginRun.run_attempt}`,
  );
  const pluginResultPath = downloadVerifiedArtifact(
    repository,
    pluginArtifact,
    "extended-stable-plugin-publication.json",
    join(dirname(args.output), "plugin-publication"),
  );
  const pluginProof = verifyJsonScript(
    join(rootDir, "scripts/verify-extended-stable-plugin-publication.ts"),
    [
      "--result",
      pluginResultPath,
      "--root",
      rootDir,
      "--release-version",
      releaseVersion,
      "--source-sha",
      args.sourceSha,
      "--repository",
      repository,
      "--workflow-ref",
      `refs/heads/${args.workflowRef}`,
      "--run-id",
      String(pluginRunId),
      "--run-attempt",
      String(pluginRun.run_attempt),
      "--artifact-digest",
      pluginArtifact.digest,
    ],
  ) as { plugins: Array<{ packageName: string; npmIntegrity: string; candidateTag: string }> };

  const coreRunId = await dispatchWorkflow(
    repository,
    "openclaw-npm-release.yml",
    args.workflowRef,
    [
      "-f",
      `tag=${args.releaseTag}`,
      "-f",
      "preflight_only=false",
      "-f",
      `preflight_run_id=${args.preflightRunId}`,
      "-f",
      `full_release_validation_run_id=${args.validationRunId}`,
      "-f",
      `release_publish_run_id=${parentRunId}`,
      "-f",
      "npm_dist_tag=extended-stable",
    ],
    args.sourceSha,
  );
  const coreRun = await waitForRun(repository, coreRunId);
  assertRunIdentity(coreRun, {
    path: ".github/workflows/openclaw-npm-release.yml",
    sha: args.sourceSha,
    event: "workflow_dispatch",
  });
  const coreArtifact = artifactForRun(
    repository,
    coreRunId,
    `extended-stable-core-publication-${coreRunId}-${coreRun.run_attempt}`,
  );
  const coreResultPath = downloadVerifiedArtifact(
    repository,
    coreArtifact,
    "extended-stable-core-publication.json",
    join(dirname(args.output), "core-publication"),
  );
  command(
    process.execPath,
    [
      join(rootDir, "scripts/openclaw-npm-extended-stable-release.mjs"),
      "verify-publication-result",
    ],
    {
      env: {
        CORE_PUBLICATION_RESULT_FILE: coreResultPath,
        EXPECTED_VERSION: releaseVersion,
        EXPECTED_SOURCE_SHA: args.sourceSha,
        EXPECTED_WORKFLOW_REF: `refs/heads/${args.workflowRef}`,
        EXPECTED_RUN_ID: String(coreRunId),
        EXPECTED_RUN_ATTEMPT: String(coreRun.run_attempt),
        EXPECTED_REPOSITORY: repository,
      },
    },
  );
  const coreResult = JSON.parse(readFileSync(coreResultPath, "utf8")) as {
    package: { candidateTag: string; integrity: string; version: string };
  };

  const acceptanceProofs = [];
  for (const plugin of support.plugins) {
    const acceptanceRunId = await dispatchWorkflow(
      repository,
      "extended-stable-plugin-acceptance.yml",
      "main",
      [
        "-f",
        `release_version=${releaseVersion}`,
        "-f",
        `plugin_package_name=${plugin.packageName}`,
      ],
    );
    const acceptanceRun = await waitForRun(repository, acceptanceRunId);
    assertRunIdentity(acceptanceRun, {
      path: ".github/workflows/extended-stable-plugin-acceptance.yml",
      event: "workflow_dispatch",
    });
    const artifact = artifactForRun(
      repository,
      acceptanceRunId,
      `extended-stable-plugin-acceptance-${acceptanceRunId}-${acceptanceRun.run_attempt}`,
    );
    const resultPath = downloadVerifiedArtifact(
      repository,
      artifact,
      "extended-stable-plugin-acceptance.json",
      join(dirname(args.output), `acceptance-${plugin.pluginId}`),
    );
    acceptanceProofs.push(
      verifyJsonScript(join(rootDir, "scripts/verify-extended-stable-plugin-acceptance.ts"), [
        "--result",
        resultPath,
        "--root",
        rootDir,
        "--release-version",
        releaseVersion,
        "--plugin-package-name",
        plugin.packageName,
        "--repository",
        repository,
        "--workflow-sha",
        acceptanceRun.head_sha,
        "--run-id",
        String(acceptanceRunId),
        "--run-attempt",
        String(acceptanceRun.run_attempt),
        "--artifact-digest",
        artifact.digest,
      ]),
    );
  }

  const selectorsAfter = Object.fromEntries(
    packageNames.map((packageName) => [packageName, selectorSnapshot(packageName)]),
  );
  if (JSON.stringify(selectorsAfter) !== JSON.stringify(selectorsBefore)) {
    throw new Error("Candidate publication moved one or more shared selectors; refusing handoff.");
  }

  const handoff = {
    schemaVersion: 1,
    handoffId: `${repository}:${parentRunId}:${releaseVersion}`,
    releaseVersion,
    sourceSha: args.sourceSha,
    monthlyCohort,
    core: {
      publicationRunId: String(coreRunId),
      publicationRunAttempt: String(coreRun.run_attempt),
      publicationArtifactDigest: coreArtifact.digest,
      version: coreResult.package.version,
      npmIntegrity: coreResult.package.integrity,
      candidateTag: coreResult.package.candidateTag,
    },
    pluginPublication: pluginProof,
    acceptances: acceptanceProofs,
    selectorsBefore,
    selectorsAfter,
    selectorOrder: ["plugins", "core"],
    conclusion: "ready_for_protected_selector_promotion",
  };
  verifySelectorHandoff(handoff, rootDir);
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(handoff, null, 2)}\n`);
}

function isMain(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMain()) {
  await orchestrate(parseArgs(process.argv.slice(2)));
}

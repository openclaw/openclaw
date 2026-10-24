import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { classifyReleaseTrain, parseReleaseVersion } from "./lib/release-version.mjs";

const core = "openclaw/openclaw";
const packaging = "openclaw/openclaw-windows-packaging";
const requestWorkflow = "windows-gateway-store.yml";
const buildWorkflow = "gateway-msix.yml";
const storeWorkflow = "submit-microsoft-store.yml";
const { RELEASE_TAG: tag = "", RELEASE_SHA: sha = "", GITHUB_RUN_ID: currentId } = process.env;
const titlePrefix = `Windows Gateway Store Request [${tag}] source=`;
const title = `${titlePrefix}${sha}`;
const evidencePath = process.env.WINDOWS_GATEWAY_STORE_EVIDENCE;
const runUrl = (repository, id) => `https://github.com/${repository}/actions/runs/${id}`;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function gh(args, input) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw new Error(
      `GitHub operation failed (${args[0]}). Inspect retained dispatch evidence and existing runs before retrying.`,
    );
  }
}

function api(endpoint, body, selection) {
  return JSON.parse(
    gh(
      [
        "api",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
        endpoint,
        ...(selection ? ["--jq", selection] : []),
        ...(body ? ["--method", "POST", "--input", "-"] : []),
      ],
      body ? JSON.stringify(body) : undefined,
    ),
  );
}

function collection(endpoint, key) {
  const fields = {
    workflow_runs: "{id,run_number,event,head_branch,display_title,status,conclusion}",
    artifacts: "{name,expired}",
    variables: '{name,value:(if .name == "MSSTORE_ENABLED" then .value else null end)}',
  };
  const values = [];
  // Bound each subprocess response, not just the number of records: full run
  // metadata can exhaust Node's stdout buffer long before history is complete.
  for (let page = 1; ; page += 1) {
    const result = api(
      `${endpoint}?per_page=100&page=${page}`,
      undefined,
      `{total_count,items:[.${key}[]|${fields[key]}]}`,
    );
    requireValue(
      Array.isArray(result.items) &&
        Number.isSafeInteger(result.total_count) &&
        result.total_count >= 0,
      "GitHub history or artifact inventory is invalid.",
    );
    values.push(...result.items);
    if (values.length >= result.total_count) {
      return values;
    }
    requireValue(
      result.items.length > 0,
      "GitHub history or artifact inventory is incomplete; refusing a potentially duplicate dispatch.",
    );
  }
}

function record(fields) {
  requireValue(evidencePath, "WINDOWS_GATEWAY_STORE_EVIDENCE is required.");
  const previous = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : {};
  writeFileSync(
    evidencePath,
    `${JSON.stringify({ schemaVersion: 1, tag, releaseSha: sha, ...previous, ...fields }, null, 2)}\n`,
  );
}

function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}

function authorize(workflow) {
  const workflows = [workflow].flat();
  const current = api(`repos/${core}/actions/runs/${currentId}`);
  requireValue(
    process.env.GITHUB_REPOSITORY === core &&
      current.repository.full_name === core &&
      current.head_repository.full_name === core &&
      current.event === "workflow_dispatch" &&
      workflows.some((name) => current.path === `.github/workflows/${name}`) &&
      current.head_sha === process.env.GITHUB_SHA &&
      current.status === "in_progress" &&
      String(current.run_attempt) === process.env.GITHUB_RUN_ATTEMPT &&
      (workflow !== requestWorkflow || current.head_branch === "main"),
    "The executing release request is no longer current or does not use the canonical workflow.",
  );
  const release = api(`repos/${core}/releases/tags/${tag}`);
  requireValue(
    release.tag_name === tag && !release.draft && !release.prerelease,
    "The Gateway release must already be public and stable.",
  );
  const ref = api(`repos/${core}/git/ref/tags/${tag}`);
  requireValue(ref.object.type === "tag", "The Gateway release needs an annotated signed tag.");
  const annotated = api(`repos/${core}/git/tags/${ref.object.sha}`);
  requireValue(
    annotated.tag === tag &&
      annotated.object.type === "commit" &&
      annotated.object.sha === sha &&
      annotated.verification.verified === true,
    "The signed Gateway release tag does not match the requested source.",
  );
  return current;
}

function previousRequests() {
  return collection(
    `repos/${core}/actions/workflows/${requestWorkflow}/runs`,
    "workflow_runs",
  ).filter(
    (run) =>
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.display_title.startsWith(titlePrefix),
  );
}

function dispatch(repository, workflow, inputs) {
  const result = api(`repos/${repository}/actions/workflows/${workflow}/dispatches`, {
    ref: "main",
    inputs,
  });
  const id = String(result.workflow_run_id);
  requireValue(
    /^[1-9][0-9]*$/.test(id),
    "Dispatch acceptance is unconfirmed. Inspect existing runs; do not blindly redispatch.",
  );
  return id;
}

function requireManualStoreMode() {
  // Repository values override shared organization variables in the publisher.
  const variables = new Map(
    [
      ...collection(`repos/${packaging}/actions/organization-variables`, "variables"),
      ...collection(`repos/${packaging}/actions/variables`, "variables"),
    ].map(({ name, value }) => [name, value]),
  );
  // Match the automatic publisher's case-insensitive GitHub expression.
  requireValue(
    variables.get("MSSTORE_ENABLED")?.toLowerCase() !== "true",
    "Packaging MSSTORE_ENABLED must remain disabled for the exact-source handoff; its automatic publisher would duplicate this request.",
  );
}

function verifyBuild(run, expectedHead) {
  requireValue(
    run.repository.full_name === packaging &&
      run.head_repository.full_name === packaging &&
      run.path === `.github/workflows/${buildWorkflow}` &&
      run.event === "workflow_dispatch" &&
      run.head_branch === "main" &&
      run.head_sha === expectedHead,
    "The packaging run does not match the selected main workflow.",
  );
}

async function awaitBuild(id, expectedHead) {
  const deadline = Date.now() + 45 * 60_000;
  for (;;) {
    const run = api(`repos/${packaging}/actions/runs/${id}`);
    verifyBuild(run, expectedHead);
    if (run.status === "completed") {
      requireValue(
        run.conclusion === "success",
        `Gateway MSIX build did not succeed: ${runUrl(packaging, id)}. Recover this build without republishing npm.`,
      );
      return run;
    }
    requireValue(
      Date.now() < deadline,
      `Gateway MSIX build is still pending: ${runUrl(packaging, id)}. Follow this run; do not start another build.`,
    );
    await delay(15_000);
  }
}

function verifySource(id, run) {
  const artifacts = collection(`repos/${packaging}/actions/runs/${id}/artifacts`, "artifacts");
  for (const name of ["openclaw-source-resolution", "openclaw-gateway-msix-store-submission"]) {
    const matches = artifacts.filter((artifact) => artifact.name === name);
    requireValue(
      matches.length === 1 && !matches[0].expired,
      `The successful build needs one retained ${name} artifact.`,
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "openclaw-gateway-store-"));
  try {
    gh([
      "run",
      "download",
      id,
      "--repo",
      packaging,
      "--name",
      "openclaw-source-resolution",
      "--dir",
      directory,
    ]);
    const source = JSON.parse(readFileSync(join(directory, "source-resolution.json"), "utf8"));
    const identity = source.releaseIdentitySource;
    requireValue(
      source.repository === `https://github.com/${core}` &&
        source.requestedRef === sha &&
        source.resolvedCommit === sha &&
        source.packageVersion === tag.slice(1) &&
        source.workflowRunId === id &&
        source.packagingCommit === run.head_sha &&
        source.workflowRef === `${packaging}/.github/workflows/${buildWorkflow}@refs/heads/main` &&
        source.githubRef === "refs/heads/main" &&
        source.eventName === "workflow_dispatch" &&
        source.signingMode === "store" &&
        identity?.repository === source.repository &&
        identity.resolvedCommit === sha &&
        identity.packageVersion === tag.slice(1) &&
        identity.releaseTag === tag &&
        identity.channel === "stable",
      "The MSIX payload or separately selected release identity differs from the published Gateway. Do not submit this build.",
    );
    record({ source });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const version = tag.startsWith("v") ? parseReleaseVersion(tag.slice(1)) : null;
  requireValue(
    version && classifyReleaseTrain(version) === "stable" && /^[a-f0-9]{40}$/.test(sha),
    "An exact regular stable Gateway tag and full source SHA are required; beta and extended-stable are excluded.",
  );
  requireValue(/^[1-9][0-9]*$/.test(currentId ?? ""), "GITHUB_RUN_ID is required.");
  const mode = process.argv[2];
  requireValue(mode === "request" || mode === "publish", "Use request or publish.");
  if (mode === "request") {
    const existing = previousRequests();
    requireValue(
      existing.every((run) => run.display_title === title),
      "A Gateway Store request already exists for this tag with a different source.",
    );
    if (existing.length) {
      record({ state: "existing-request", requestRunId: String(existing[0].id) });
      report(
        `Gateway Store request already exists: ${runUrl(core, existing[0].id)} (${existing[0].status}/${existing[0].conclusion ?? "pending"}). Recover that request; npm remains complete.`,
      );
      return;
    }
    authorize(["openclaw-release-publish.yml", "openclaw-release-promote.yml"]);
    record({ state: "request-dispatch-attempted" });
    const id = dispatch(core, requestWorkflow, { tag, release_sha: sha });
    record({ state: "requested", requestRunId: id });
    report(
      `Gateway Store publication requested: ${runUrl(core, id)}. MSIX build and Store acceptance remain pending.`,
    );
    return;
  }

  const current = authorize(requestWorkflow);
  // Workflow history is the replay record, including failed/uncertain dispatches.
  // Recover the original downstream run instead of repeating a Store mutation.
  requireValue(
    current.run_attempt === 1,
    "Do not rerun a Gateway Store request. Recover the packaging/Store run IDs in its retained evidence.",
  );
  const previous = previousRequests().find((run) => run.run_number < current.run_number);
  requireValue(
    !previous,
    `A prior request owns this Gateway release: ${runUrl(core, previous?.id)}. Recover its downstream runs instead.`,
  );
  requireManualStoreMode();
  const packagingHead = api(`repos/${packaging}/git/ref/heads/main`).object.sha;
  authorize(requestWorkflow);
  record({ state: "build-dispatch-attempted", packagingHead });
  const buildId = dispatch(packaging, buildWorkflow, {
    openclaw_ref: sha,
    signing_mode: "store",
    publish_release: "false",
  });
  record({ state: "building", buildRunId: buildId });
  report(`Gateway MSIX build: ${runUrl(packaging, buildId)}`);
  const run = await awaitBuild(buildId, packagingHead);
  verifySource(buildId, run);
  requireManualStoreMode();
  authorize(requestWorkflow);
  record({ state: "store-dispatch-attempted" });
  const storeId = dispatch(packaging, storeWorkflow, { run_id: buildId });
  record({ state: "store-requested", storeRunId: storeId });
  report(
    `Gateway Store publisher: ${runUrl(packaging, storeId)}. Follow its commit receipt; certification and public availability are not yet verified.`,
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `::error::${error instanceof Error ? error.message : "Gateway Store handoff failed."}`,
  );
  process.exitCode = 1;
}

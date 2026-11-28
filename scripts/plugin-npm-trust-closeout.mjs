#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { parseReleaseVersion } from "./lib/release-version.mjs";

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// Successful bootstrap jobs, not today's registry state, own this outstanding work.
export function planPluginNpmTrustCloseout(input) {
  const {
    repository,
    sourceSha,
    toolingSha,
    toolingRef,
    parentRunId,
    parentRunAttempt,
    releaseTag,
    parentRun,
    dispatch,
    pluginRun,
    jobs,
  } = input;
  const version = parseReleaseVersion(releaseTag.replace(/^v/u, ""));
  requireValue(
    releaseTag.startsWith("v") && version?.channel === "beta" && version.betaNumber === 1,
    "Plugin trust closeout requires an exact beta.1 release tag.",
  );
  requireValue(
    /^[a-f0-9]{40}$/u.test(sourceSha) &&
      /^[a-f0-9]{40}$/u.test(toolingSha) &&
      new RegExp("^release-publish/[a-f0-9]{12}-[1-9][0-9]*$", "u").test(toolingRef) &&
      toolingRef.startsWith("release-publish/" + toolingSha.slice(0, 12)) &&
      Number.isSafeInteger(parentRunId) &&
      parentRunId > 0 &&
      Number.isSafeInteger(parentRunAttempt) &&
      parentRunAttempt > 0,
    "Plugin trust closeout requires the original source and protected tooling identity.",
  );
  const matchesRun = (run, workflow) =>
    run?.repository?.full_name === repository &&
    run.head_repository?.full_name === repository &&
    run.event === "workflow_dispatch" &&
    run.path?.split("@")[0] === workflow &&
    run.head_sha === toolingSha &&
    run.head_branch === toolingRef;
  requireValue(
    matchesRun(parentRun, ".github/workflows/openclaw-release-publish.yml") &&
      parentRun.id === parentRunId &&
      parentRun.run_attempt === parentRunAttempt,
    "Original release parent does not match the closeout request.",
  );
  requireValue(
    dispatch?.schemaVersion === 1 &&
      dispatch.repository === repository &&
      dispatch.parentWorkflow === ".github/workflows/openclaw-release-publish.yml" &&
      String(dispatch.parentRunId) === String(parentRunId) &&
      String(dispatch.parentRunAttempt) === String(parentRunAttempt) &&
      dispatch.candidateSha === sourceSha &&
      dispatch.toolingSha === toolingSha &&
      dispatch.toolingRef === toolingRef &&
      dispatch.toolingFullRef === "refs/tags/" + toolingRef &&
      (dispatch.npmRunId === null ||
        (Number.isSafeInteger(dispatch.npmRunId) && dispatch.npmRunId > 0)),
    "Original npm child dispatch record does not match the release.",
  );
  if (dispatch.npmRunId === null) {
    return [];
  }
  requireValue(
    matchesRun(pluginRun, ".github/workflows/plugin-npm-release.yml") &&
      pluginRun.id === dispatch.npmRunId &&
      pluginRun.status === "completed" &&
      pluginRun.display_title?.endsWith(" " + sourceSha),
    "Original plugin npm publication has not completed for this source.",
  );
  requireValue(
    Array.isArray(jobs.jobs) &&
      jobs.jobs.length > 0 &&
      jobs.jobs.length === jobs.total_count &&
      new Set(jobs.jobs.map((job) => job.id)).size === jobs.jobs.length,
    "Original plugin npm job inventory is missing, truncated, or duplicated.",
  );
  const packages = new Set();
  for (const job of jobs.jobs) {
    requireValue(
      job.run_id === pluginRun.id && job.head_sha === toolingSha,
      "Plugin job belongs to a different publication.",
    );
    if (
      !job.steps?.some(
        (step) =>
          step.name === "Publish approved bootstrap tarball" && step.conclusion === "success",
      )
    ) {
      continue;
    }
    const packageName = new RegExp(
      "^Publish plugin npm package [(](@openclaw/[a-z0-9][a-z0-9._-]*)[)]$",
      "u",
    ).exec(job.name)?.[1];
    requireValue(
      packageName && job.status === "completed" && job.conclusion === "success",
      "A bootstrapped plugin is missing successful publication evidence.",
    );
    packages.add(packageName);
  }
  return [...packages].toSorted((a, b) => a.localeCompare(b));
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const env = process.env;
    const read = (name) => JSON.parse(readFileSync(join(env.CLOSEOUT_DIR, name), "utf8"));
    const packages = planPluginNpmTrustCloseout({
      repository: env.GITHUB_REPOSITORY,
      sourceSha: env.SOURCE_SHA,
      toolingSha: env.TOOLING_SHA,
      toolingRef: env.TOOLING_REF,
      parentRunId: Number(env.RELEASE_RUN_ID),
      parentRunAttempt: Number(env.RELEASE_RUN_ATTEMPT),
      releaseTag: env.RELEASE_TAG,
      parentRun: read("parent.json"),
      dispatch: read("dispatch.json"),
      pluginRun: read("plugin-run.json"),
      jobs: read("jobs.json"),
    });
    appendFileSync(env.GITHUB_OUTPUT, "plugins=" + packages.join(",") + "\n");
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      "## Beta.1 plugin npm trust closeout\n\nCore publication is already complete. " +
        "This check cannot publish packages or change npm trust.\n\n" +
        (packages.length
          ? packages.map((name) => "- Verify OIDC: \u0060" + name + "\u0060").join("\n")
          : "No plugins used token bootstrap in the original publication.") +
        "\n",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Plugin trust closeout failed.");
    process.exitCode = 1;
  }
}

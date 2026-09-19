import { execFileSync } from "node:child_process";
import { runTasksWithConcurrency } from "../../src/utils/run-with-concurrency.js";
import { validateNpmPublishBoundary } from "../openclaw-npm-extended-stable-release.mjs";
import corePackagePolicy from "./npm-core-release-packages.json" with { type: "json" };
import {
  fetchNpmRegistryPackumentWithRetry,
  resolveNpmPublishPlan,
  resolvePublishedNpmVersionRoute,
} from "./npm-publish-plan.mjs";
import {
  collectPluginReleaseVersionFloorErrors,
  parsePluginReleaseSelection,
  resolveSelectedPublishablePluginPackages,
} from "./plugin-npm-release.ts";
import {
  collectPublishablePluginPackagesFromCandidates,
  type PluginPackageJson,
  type PublishablePluginPackage,
} from "./plugin-publication-collector.ts";
import { isRecord } from "./record-shared.mjs";
import type { ReleasePublishGate } from "./release-publish-gates.mts";
import { readPublishPreflightRelease } from "./release-publish-preflight-evidence.mts";
import { collectReleaseVersionFloorErrors } from "./release-version.mjs";

export function readReleasePublicationPackages(input: {
  rootDir: string;
  sourceSha: string;
  npmDistTag: string;
  pluginPublishScope: "selected" | "all-publishable";
  plugins?: string;
}) {
  if (!/^[a-f0-9]{40}$/u.test(input.sourceSha)) {
    throw new Error("Package inventory requires an exact lowercase 40-character source SHA.");
  }
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: input.rootDir,
      encoding: "utf8",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  try {
    git(["cat-file", "-e", `${input.sourceSha}^{commit}`]);
  } catch {
    throw new Error(
      `Release source ${input.sourceSha} is not available locally. Run git fetch --no-tags origin ${input.sourceSha}, then repeat preflight.`,
    );
  }
  const paths = new Set(
    git([
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      input.sourceSha,
      "--",
      "extensions",
      "packages",
    ]).split("\0"),
  );
  const read = (path: string) => git(["show", `${input.sourceSha}:${path}`]);
  const root: unknown = JSON.parse(read("package.json"));
  if (!isRecord(root) || typeof root.version !== "string") {
    throw new Error("Release source package.json is missing its version.");
  }
  const version = root.version;
  const dependencies = isRecord(root.dependencies) ? root.dependencies : {};
  const corePackages = corePackagePolicy.flatMap((policy) => {
    const path = `${policy.path}/package.json`;
    const requiredDependency =
      policy.dependency && typeof dependencies[policy.dependency] === "string";
    if (!paths.has(path)) {
      if (requiredDependency) {
        throw new Error(`Publishable core package manifest is missing: ${path}`);
      }
      return [];
    }
    const manifest = JSON.parse(read(path)) as PluginPackageJson;
    if (
      policy.dependency ? !requiredDependency : manifest.openclaw?.release?.publishToNpm !== true
    ) {
      return [];
    }
    if (manifest.name !== policy.name || manifest.version !== version) {
      throw new Error(`${path} must publish ${policy.name}@${version}.`);
    }
    return [{ packageName: policy.name, version }];
  });
  const candidates = [...paths]
    .filter((path) => /^extensions\/[^/]+\/package\.json$/u.test(path))
    .map((path) => {
      const packageDir = path.slice(0, -"/package.json".length);
      return {
        extensionId: packageDir.slice("extensions/".length),
        packageDir,
        packageJson: JSON.parse(read(path)) as PluginPackageJson,
        readmeText: paths.has(`${packageDir}/README.md`)
          ? read(`${packageDir}/README.md`)
          : undefined,
      };
    });
  const selection = parsePluginReleaseSelection(input.plugins);
  if (input.pluginPublishScope === "selected" && selection.length === 0) {
    throw new Error("plugin_publish_scope=selected requires a nonempty plugins selection.");
  }
  const select = (target: "npm" | "clawhub") => {
    const plugins = collectPublishablePluginPackagesFromCandidates(candidates, target, {
      ...(input.pluginPublishScope === "selected" ? { packageNames: selection } : {}),
      ...(target === "npm" && input.npmDistTag === "extended-stable"
        ? { npmDistTag: "extended-stable", rootVersion: version }
        : {}),
    });
    return input.pluginPublishScope === "selected"
      ? resolveSelectedPublishablePluginPackages({ plugins, selection })
      : plugins;
  };
  return { version, corePackages, npmPlugins: select("npm"), clawhubPlugins: select("clawhub") };
}

export async function observeReleaseNpmState(input: {
  version: string;
  npmDistTag: string;
  plugins: readonly PublishablePluginPackage[];
  corePackages?: readonly { packageName: string; version: string }[];
  publishOpenclawNpm?: boolean;
}) {
  const gates: ReleasePublishGate[] = [];
  const corePackages = input.publishOpenclawNpm === false ? [] : (input.corePackages ?? []);
  const coreNames = new Set(["openclaw", ...corePackages.map((pkg) => pkg.packageName)]);
  const floorErrors = [
    ...(input.publishOpenclawNpm === false ? [] : collectReleaseVersionFloorErrors(input.version)),
    ...collectPluginReleaseVersionFloorErrors(input.plugins),
    ...collectPluginReleaseVersionFloorErrors(corePackages),
  ];
  gates.push({
    id: "npm.version-floors",
    status: floorErrors.length ? "FAIL" : "PASS",
    message: floorErrors.length
      ? floorErrors.join(" ")
      : "Selected packages satisfy release version floors.",
    remediation: floorErrors.length
      ? "Select a release candidate whose package versions satisfy the canonical release floors."
      : "",
  });
  const packages = [
    ...(input.publishOpenclawNpm === false
      ? []
      : [{ packageName: "openclaw", version: input.version }]),
    ...corePackages,
    ...input.plugins,
  ];
  const observed = await runTasksWithConcurrency({
    limit: 8,
    tasks: packages.map((pkg) => async () => {
      const id = `npm.package.${pkg.packageName}`;
      try {
        const registry = await fetchNpmRegistryPackumentWithRetry({
          packageName: pkg.packageName,
          packageUrl: `https://registry.npmjs.org/${encodeURIComponent(pkg.packageName)}`,
          maxBytes: 16 * 1024 * 1024,
          timeoutMs: 15_000,
          attempts: 2,
          redirect: "manual",
        });
        if (
          registry.status !== 404 &&
          (!registry.ok || !isRecord(registry.packument) || !isRecord(registry.packument.versions))
        ) {
          throw new Error(`npm returned HTTP ${registry.status} or an invalid package inventory.`);
        }
        const packument = isRecord(registry.packument) ? registry.packument : {};
        const versions = isRecord(packument.versions) ? packument.versions : {};
        const published = Object.hasOwn(versions, pkg.version);
        const bootstrap = registry.status === 404;
        const core = coreNames.has(pkg.packageName);
        const tags = isRecord(packument["dist-tags"]) ? packument["dist-tags"] : {};
        const plan = resolveNpmPublishPlan(
          pkg.version,
          typeof tags.beta === "string" ? tags.beta : undefined,
          input.npmDistTag === "extended-stable" ? input.npmDistTag : undefined,
        );
        if (core) {
          validateNpmPublishBoundary(pkg.version, input.npmDistTag);
          if (input.npmDistTag === "beta") {
            plan.publishTag = "beta";
            plan.mirrorDistTags = [];
          }
        }
        if (!bootstrap && Object.keys(versions).length === 0) {
          throw new Error(
            "The package exists with empty version history; missing-package bootstrap cannot be inferred.",
          );
        }
        if (bootstrap && core) {
          throw new Error(
            "Core publication requires an existing package configured for trusted publishing; plugin token-bootstrap approval does not apply.",
          );
        }
        const route = published
          ? resolvePublishedNpmVersionRoute({
              packageVersion: pkg.version,
              publishPlan: plan,
              distTags: tags,
            })
          : undefined;
        // Existing plugin versions take the readback path; this workflow does
        // not repair selectors with its OIDC identity. Surface that owner action.
        const pluginSelectorRepair = !core && route && route !== "npm-readback";
        const gate: ReleasePublishGate = {
          id,
          status: pluginSelectorRepair ? "FAIL" : bootstrap || published ? "WARN" : "PASS",
          message: `${pkg.packageName}@${pkg.version}: ${bootstrap ? "not visible in npm; possible token bootstrap" : published ? `already published${route ? ` (${route})` : `; ${core ? "core subpackage" : "plugin"} publication skips this version`}` : `not published; ${plan.publishTag} publication planned`}.`,
          remediation: pluginSelectorRepair
            ? "Repair the reported npm dist-tag through credential-isolated release tooling, then repeat preflight; this plugin publisher only reads back existing versions."
            : bootstrap
              ? "If a recent run may have published this package, reconcile its registry readback first. Otherwise verify bootstrap approval eligibility and run the documented read-only whoami probe against the workflow's NPM_TOKEN before dispatch."
              : published && pkg.packageName === "openclaw"
                ? "Supply openclaw_npm_resume_run_id for the verified original successful publisher; resume rechecks immutable tarball identity."
                : published
                  ? "Retain the exact selection; published package versions are reused."
                  : "",
        };
        return { gate, pkg, bootstrap, published, known: true };
      } catch (error) {
        return {
          gate: {
            id,
            status: "FAIL",
            message: `${pkg.packageName}@${pkg.version}: ${error instanceof Error ? error.message : String(error)}`,
            remediation:
              "Resolve the registry or canonical publication-route error and repeat preflight before dispatch.",
          } satisfies ReleasePublishGate,
          pkg,
          bootstrap: false,
          published: false,
          known: false,
        };
      }
    }),
  });
  if (observed.hasError) {
    throw observed.firstError;
  }
  gates.push(...observed.results.map((result) => result.gate));
  return {
    gates,
    bootstrapCandidates: observed.results
      .filter((result) => result.bootstrap)
      .map((result) => result.pkg),
    publishedPackages: observed.results
      .filter((result) => result.published)
      .map((result) => result.pkg),
    unknownPackages: observed.results.filter((result) => !result.known).map((result) => result.pkg),
    corePublished: observed.results.some(
      (result) => result.pkg.packageName === "openclaw" && result.published,
    ),
  };
}

type Run = {
  id: number;
  run_attempt: number;
  status: string;
  event: string;
  display_title: string;
  html_url: string;
};

export function observeReleaseGitHubState(input: {
  repository: string;
  releaseTag: string;
  sourceSha: string;
  npmDistTag: string;
  runGh?: (args: string[]) => string;
}) {
  const gates: ReleasePublishGate[] = [];
  const runGh =
    input.runGh ??
    ((args: string[]) =>
      execFileSync("gh", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      }));
  const cache = new Map<string, string>();
  const raw = (endpoint: string) => {
    const cached = cache.get(endpoint);
    if (cached !== undefined) {
      return cached;
    }
    const value = runGh([
      "api",
      `repos/${input.repository}/${endpoint}`,
      "--method",
      "GET",
      ...(endpoint.endsWith("/logs") ? ["--allow-escape-sequences"] : []),
    ]);
    cache.set(endpoint, value);
    return value;
  };
  const api = (endpoint: string): unknown => JSON.parse(raw(endpoint));
  let release: Record<string, unknown> | undefined;
  try {
    const lookup = readPublishPreflightRelease(runGh, input.repository, input.releaseTag);
    release = lookup.state === "found" ? lookup.release : undefined;
    gates.push({
      id: "github.release",
      status: lookup.state === "absent" ? "PASS" : "WARN",
      message:
        lookup.state === "found"
          ? `${lookup.release.draft ? "Draft" : "Published"} GitHub release already exists: ${lookup.release.html_url}`
          : lookup.state === "unresolved"
            ? lookup.message
            : "No GitHub release exists for the tag.",
      remediation: release
        ? "Resume the existing release and preserve its assets and publication evidence."
        : lookup.state === "unresolved"
          ? "Inspect the release with credentials that can view drafts before dispatch."
          : "",
    });
  } catch {
    gates.push({
      id: "github.release",
      status: "WARN",
      message: "GitHub release state could not be read.",
      remediation: `Inspect authenticated release visibility and exact tag ${input.releaseTag}: gh api 'repos/${input.repository}/releases?per_page=100&page=1' --method GET`,
    });
  }
  for (const workflow of [
    "openclaw-release-publish.yml",
    "plugin-npm-release.yml",
    "plugin-clawhub-release.yml",
    "plugin-clawhub-new.yml",
  ]) {
    const runs = new Map<number, Run>();
    let complete = true;
    for (const status of [
      "in_progress",
      "queued",
      "waiting",
      "pending",
      "requested",
      "action_required",
    ]) {
      const endpoint = `actions/workflows/${workflow}/runs?status=${status}&per_page=100`;
      try {
        const response = api(endpoint);
        if (
          !isRecord(response) ||
          !Array.isArray(response.workflow_runs) ||
          typeof response.total_count !== "number"
        ) {
          throw new Error("Invalid run inventory.");
        }
        for (const run of response.workflow_runs) {
          if (
            !isRecord(run) ||
            typeof run.id !== "number" ||
            typeof run.run_attempt !== "number" ||
            typeof run.status !== "string" ||
            typeof run.event !== "string" ||
            typeof run.display_title !== "string" ||
            typeof run.html_url !== "string"
          ) {
            throw new Error("Invalid workflow run record.");
          }
          runs.set(run.id, run as Run);
        }
        if (response.total_count > 100) {
          complete = false;
        }
      } catch {
        complete = false;
      }
    }
    if (!complete) {
      gates.push({
        id: `concurrency.${workflow}.inventory`,
        status: "WARN",
        message:
          "Active-run inventory is unavailable or exceeds the bounded first page; concurrency is unresolved.",
        remediation: `gh api 'repos/${input.repository}/actions/workflows/${workflow}/runs?status=waiting&per_page=100' --method GET`,
      });
    }
    let candidates = 0;
    for (const run of runs.values()) {
      if (run.event !== "workflow_dispatch") {
        continue;
      }
      const parent = workflow === "openclaw-release-publish.yml";
      const npm = workflow === "plugin-npm-release.yml";
      const titleSha = npm
        ? /^Plugin NPM (?:Release|Artifact Preflight|Trusted Publisher Preflight) \[(?:default|extended-stable)\] ([a-f0-9]{40})$/u.exec(
            run.display_title,
          )?.[1]
        : undefined;
      if (titleSha && titleSha !== input.sourceSha) {
        continue;
      }
      let match = titleSha === input.sourceSha;
      let evidence = match ? "exact workflow run title" : "dispatch inputs unavailable";
      let parentRunId: string | undefined;
      if (!match && candidates++ < 10) {
        try {
          const jobs = api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
          const job =
            isRecord(jobs) && Array.isArray(jobs.jobs)
              ? jobs.jobs.find(
                  (entry) =>
                    isRecord(entry) && entry.status === "completed" && typeof entry.id === "number",
                )
              : undefined;
          if (isRecord(job) && typeof job.id === "number") {
            const log = raw(`actions/jobs/${job.id}/logs`);
            const env = (key: string) => {
              const values = [
                ...log.matchAll(new RegExp(`^\\S+ +${key}: ([^\\r\\n]*)$`, "gmu")),
              ].map((value) => value[1]);
              return values.length && new Set(values).size === 1 ? values[0] : undefined;
            };
            const value = env(parent ? "RELEASE_NPM_DIST_TAG" : "TARGET_REF");
            const dryRun = env("DRY_RUN");
            if (value !== undefined && value !== (parent ? input.npmDistTag : input.sourceSha)) {
              continue;
            }
            if (!parent && !npm && dryRun === "true") {
              continue;
            }
            match =
              value === (parent ? input.npmDistTag : input.sourceSha) &&
              (parent || npm || dryRun === "false");
            evidence = match
              ? `exact job ${job.id} dispatch environment`
              : "dispatch inputs incomplete in available job log";
            parentRunId = env("RELEASE_PUBLISH_RUN_ID");
          }
        } catch {
          evidence = "dispatch inputs unavailable from completed job logs";
        }
      }
      let orphan = "";
      if (match && parentRunId && /^[1-9][0-9]*$/u.test(parentRunId)) {
        try {
          const producer = api(`actions/runs/${parentRunId}`);
          if (isRecord(producer) && producer.status === "completed") {
            orphan = ` Parent ${parentRunId} is terminal (${String(producer.conclusion)}); this may be a detached child or orphan.`;
          }
        } catch {
          /* An unavailable parent cannot establish an orphan. */
        }
      }
      gates.push({
        id: `concurrency.${workflow}.${run.id}`,
        status: match ? "FAIL" : "WARN",
        message: `${run.status} run ${run.id}: ${match ? "same concurrency group" : "possible concurrency blocker"} (${evidence}).${orphan} ${run.html_url}`,
        remediation: match
          ? `Inspect and reconcile run ${run.id} before dispatch; do not cancel without checking parent ownership. gh api repos/${input.repository}/actions/runs/${run.id} --method GET`
          : `Resolve the run's exact ${parent ? "npm_dist_tag" : "ref and dry_run"} inputs before dispatch: gh api 'repos/${input.repository}/actions/runs/${run.id}/jobs?per_page=100' --method GET`,
      });
    }
    if (complete && !gates.some((gate) => gate.id.startsWith(`concurrency.${workflow}.`))) {
      gates.push({
        id: `concurrency.${workflow}.clear`,
        status: "PASS",
        message: "No matching active dispatch runs found in the current concurrency inventory.",
        remediation: "",
      });
    }
  }
  return { gates, release };
}

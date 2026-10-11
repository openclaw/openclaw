import { resolve } from "node:path";
import { resolvePreparedClawHubMatrix } from "../clawhub-prepared-artifact.mjs";
import {
  collectPluginClawHubReleasePlan,
  type PublishablePluginPackage,
} from "./plugin-clawhub-release.ts";
import {
  parsePluginReleaseSelection,
  parsePluginReleaseSelectionMode,
  type NpmLatestVersionResolver,
  type PluginReleaseSelectionMode,
} from "./plugin-npm-release.ts";

type ClawHubPlanPackage = Pick<PublishablePluginPackage, "packageName">;

type ClawHubDispatchInputs = Record<string, string>;

type ClawHubDispatchTarget = {
  workflow: "plugin-clawhub-release.yml" | "plugin-clawhub-new.yml";
  ref: string;
  shouldDispatch: boolean;
  packages: string[];
  inputs: ClawHubDispatchInputs;
};

type OpenClawReleaseClawHubPlanArgs = {
  bootstrapWorkflowRef: string;
  bootstrapWorkflowSha: string;
  releaseTag: string;
  releaseSha: string;
  releasePublishBranch: string;
  releasePublishFullRef: string;
  releasePublishRunAttempt: string;
  releasePublishRunId: string;
  pluginPublishScope: PluginReleaseSelectionMode;
  plugins: string[];
  skipClawHub?: boolean;
  preparedArtifact?: string;
};

type OpenClawReleaseClawHubPlan = {
  warnings: string[];
  bootstrapWorkflowSha: string;
  clawHubWorkflowRef: string;
  releasePublishBranch: string;
  normal: ClawHubDispatchTarget;
  bootstrap: ClawHubDispatchTarget;
  summary: {
    normalCount: number;
    bootstrapCount: number;
    missingTrustedPublisherCount: number;
    normalPlugins: string;
    bootstrapPlugins: string;
    missingTrustedPlugins: string;
  };
  verifier: {
    clawHubWorkflowRef: string;
  };
};

function requireArg(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function packageNames(packages: readonly ClawHubPlanPackage[]): string[] {
  return packages.map((plugin) => plugin.packageName);
}

function requireCommitSha(value: string | undefined, label: string): string {
  const sha = requireArg(value, label);
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error(`${label} must be a full 40-character lowercase commit SHA.`);
  }
  return sha;
}

function requireBootstrapWorkflowRef(value: string | undefined): string {
  const ref = requireArg(value, "--bootstrap-workflow-ref");
  if (ref !== "main" && !/^release-publish\/[a-f0-9]{12}-[1-9][0-9]*$/u.test(ref)) {
    throw new Error("--bootstrap-workflow-ref must be main or a SHA-pinned release-publish tag.");
  }
  return ref;
}

function requirePositiveInteger(value: string | undefined, label: string): string {
  const result = requireArg(value, label);
  if (!/^[1-9][0-9]*$/u.test(result)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return result;
}

function assertNoPackageOverlap(
  normalPackages: readonly string[],
  bootstrapPackages: readonly string[],
) {
  const normalPackageSet = new Set(normalPackages);
  const overlap = bootstrapPackages.filter((packageName) => normalPackageSet.has(packageName));
  if (overlap.length > 0) {
    throw new Error(
      `ClawHub release plan routed package(s) to both normal and bootstrap workflows: ${overlap.join(", ")}.`,
    );
  }
}

export function parseOpenClawReleaseClawHubPlanArgs(
  argv: string[],
): OpenClawReleaseClawHubPlanArgs {
  const values = [...argv];
  if (values[0] === "--") {
    values.shift();
  }

  const stringFlags = new Set([
    "--prepared-artifact",
    "--bootstrap-workflow-ref",
    "--bootstrap-workflow-sha",
    "--release-tag",
    "--release-sha",
    "--release-publish-branch",
    "--release-publish-full-ref",
    "--release-publish-run-attempt",
    "--release-publish-run-id",
  ]);
  const strings = new Map<string, string>();
  let pluginPublishScope: PluginReleaseSelectionMode | undefined;
  let plugins: string[] = [];
  let pluginsFlagProvided = false;
  let skipClawHub = false;

  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      const value = values[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    if (arg && stringFlags.has(arg)) {
      strings.set(arg, next());
      continue;
    }
    switch (arg) {
      case "--plugin-publish-scope":
        pluginPublishScope = parsePluginReleaseSelectionMode(next());
        break;
      case "--plugins":
        plugins = parsePluginReleaseSelection(next());
        pluginsFlagProvided = true;
        break;
      case "--skip-clawhub":
        skipClawHub = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const resolvedPluginPublishScope = pluginPublishScope ?? "all-publishable";
  if (pluginsFlagProvided && plugins.length === 0) {
    throw new Error("--plugins must include at least one package name.");
  }
  if (resolvedPluginPublishScope === "selected" && !pluginsFlagProvided) {
    throw new Error("plugin-publish-scope=selected requires --plugins.");
  }
  if (resolvedPluginPublishScope === "all-publishable" && pluginsFlagProvided) {
    throw new Error("plugin-publish-scope=all-publishable must not be combined with --plugins.");
  }

  const preparedArtifact = strings.get("--prepared-artifact");
  return {
    bootstrapWorkflowRef: requireBootstrapWorkflowRef(strings.get("--bootstrap-workflow-ref")),
    bootstrapWorkflowSha: requireCommitSha(
      strings.get("--bootstrap-workflow-sha"),
      "--bootstrap-workflow-sha",
    ),
    releaseTag: requireArg(strings.get("--release-tag"), "--release-tag"),
    releaseSha: requireCommitSha(strings.get("--release-sha"), "--release-sha"),
    releasePublishBranch: requireArg(
      strings.get("--release-publish-branch"),
      "--release-publish-branch",
    ),
    releasePublishFullRef: requireArg(
      strings.get("--release-publish-full-ref"),
      "--release-publish-full-ref",
    ),
    releasePublishRunAttempt: requirePositiveInteger(
      strings.get("--release-publish-run-attempt"),
      "--release-publish-run-attempt",
    ),
    releasePublishRunId: requireArg(
      strings.get("--release-publish-run-id"),
      "--release-publish-run-id",
    ),
    pluginPublishScope: resolvedPluginPublishScope,
    plugins,
    skipClawHub,
    ...(preparedArtifact ? { preparedArtifact } : {}),
  };
}

export async function buildOpenClawReleaseClawHubPlan(
  args: OpenClawReleaseClawHubPlanArgs,
  options: {
    rootDir?: string;
    fetchImpl?: typeof fetch;
    registryBaseUrl?: string;
    resolveLatestVersion?: NpmLatestVersionResolver;
  } = {},
): Promise<OpenClawReleaseClawHubPlan> {
  const bootstrapWorkflowRef = requireBootstrapWorkflowRef(args.bootstrapWorkflowRef);
  const bootstrapWorkflowSha = requireCommitSha(args.bootstrapWorkflowSha, "bootstrapWorkflowSha");
  const releaseTag = requireArg(args.releaseTag, "releaseTag");
  const releaseSha = requireCommitSha(args.releaseSha, "releaseSha");
  const releasePublishBranch = requireArg(args.releasePublishBranch, "releasePublishBranch");
  const releasePublishFullRef = requireArg(args.releasePublishFullRef, "releasePublishFullRef");
  const releasePublishRunAttempt = requirePositiveInteger(
    args.releasePublishRunAttempt,
    "releasePublishRunAttempt",
  );
  const releasePublishRunId = requireArg(args.releasePublishRunId, "releasePublishRunId");
  const prepared =
    !args.skipClawHub && args.preparedArtifact
      ? await resolvePreparedClawHubMatrix({
          descriptor: JSON.parse(args.preparedArtifact),
          candidateSha: releaseSha,
          toolingSha: bootstrapWorkflowSha,
          selectionMode: args.pluginPublishScope,
          plugins: args.plugins,
          sourceRoot: options.rootDir ?? resolve("."),
          token: process.env.GH_TOKEN,
          fetchImpl: options.fetchImpl,
        })
      : undefined;
  // Prepared publication requires established normal trusted publishers;
  // the resolver rejects bootstrap/repair needs before this routing.
  const plan =
    args.skipClawHub || prepared
      ? {
          candidates: prepared ?? [],
          bootstrapCandidates: [],
          missingTrustedPublisher: [],
          warnings: [],
        }
      : await collectPluginClawHubReleasePlan({
          rootDir: options.rootDir ?? resolve("."),
          selection: args.plugins,
          selectionMode: args.pluginPublishScope,
          fetchImpl: options.fetchImpl,
          registryBaseUrl: options.registryBaseUrl,
          resolveLatestVersion: options.resolveLatestVersion,
        });

  const normalPackages = packageNames(plan.candidates);
  const bootstrapPackages = [
    ...packageNames(plan.bootstrapCandidates),
    ...packageNames(plan.missingTrustedPublisher),
  ];
  const missingTrustedPlugins = packageNames(plan.missingTrustedPublisher);
  assertNoPackageOverlap(normalPackages, bootstrapPackages);

  const dispatchTarget = (
    kind: "normal" | "bootstrap",
    packages: readonly string[],
  ): ClawHubDispatchTarget => ({
    workflow: kind === "normal" ? "plugin-clawhub-release.yml" : "plugin-clawhub-new.yml",
    ref: bootstrapWorkflowRef,
    shouldDispatch: packages.length > 0,
    packages: [...packages],
    inputs: packages.length
      ? {
          ...(kind === "normal" ? { publish_scope: "selected" } : {}),
          ref: releaseSha,
          ...(kind === "bootstrap" ? { bootstrap_workflow_sha: bootstrapWorkflowSha } : {}),
          release_tag: releaseTag,
          release_publish_run_attempt: releasePublishRunAttempt,
          ...(kind === "normal"
            ? {
                release_publish_full_ref: releasePublishFullRef,
                release_publish_workflow_sha: bootstrapWorkflowSha,
              }
            : {}),
          plugins: packages.join(","),
          release_publish_run_id: releasePublishRunId,
          release_publish_branch: releasePublishBranch,
        }
      : {},
  });
  const result = {
    warnings: plan.warnings,
    bootstrapWorkflowSha,
    clawHubWorkflowRef: bootstrapWorkflowRef,
    releasePublishBranch,
    normal: dispatchTarget("normal", normalPackages),
    bootstrap: dispatchTarget("bootstrap", bootstrapPackages),
    summary: {
      normalCount: normalPackages.length,
      bootstrapCount: bootstrapPackages.length,
      missingTrustedPublisherCount: missingTrustedPlugins.length,
      normalPlugins: normalPackages.join(","),
      bootstrapPlugins: bootstrapPackages.join(","),
      missingTrustedPlugins: missingTrustedPlugins.join(","),
    },
    verifier: {
      clawHubWorkflowRef: bootstrapWorkflowRef,
    },
  };
  if (args.preparedArtifact && result.normal.shouldDispatch) {
    // The receipt authorizes the whole frozen roster, including exact versions
    // already present. Mutable registry candidates must not narrow that set.
    result.normal.inputs.publish_scope = args.pluginPublishScope;
    delete result.normal.inputs.plugins;
    if (args.plugins.length > 0) {
      result.normal.inputs.plugins = args.plugins.join(",");
    }
    result.normal.inputs.prepared_artifact = args.preparedArtifact;
  }
  return result;
}

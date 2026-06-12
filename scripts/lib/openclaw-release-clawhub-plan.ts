// OpenClaw release ClawHub plan script supports release workflow routing.
import { resolve } from "node:path";
import {
  collectPluginClawHubReleasePlan,
  type PublishablePluginPackage,
} from "./plugin-clawhub-release.ts";
import {
  parsePluginReleaseSelection,
  parsePluginReleaseSelectionMode,
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

export type OpenClawReleaseClawHubPlanArgs = {
  releaseTag: string;
  releasePublishBranch: string;
  releasePublishRunId: string;
  pluginPublishScope: PluginReleaseSelectionMode;
  plugins: string[];
};

export type OpenClawReleaseClawHubPlan = {
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

function joinPackageNames(packages: readonly string[]): string {
  return packages.join(",");
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

function createDispatchTarget(params: {
  workflow: ClawHubDispatchTarget["workflow"];
  ref: string;
  packages: readonly string[];
  releasePublishRunId: string;
  releasePublishBranch: string;
  includePublishScope: boolean;
}): ClawHubDispatchTarget {
  if (params.packages.length === 0) {
    return {
      workflow: params.workflow,
      ref: params.ref,
      shouldDispatch: false,
      packages: [],
      inputs: {},
    };
  }

  const plugins = joinPackageNames(params.packages);
  return {
    workflow: params.workflow,
    ref: params.ref,
    shouldDispatch: true,
    packages: [...params.packages],
    inputs: {
      ...(params.includePublishScope ? { publish_scope: "selected" } : {}),
      plugins,
      release_publish_run_id: params.releasePublishRunId,
      release_publish_branch: params.releasePublishBranch,
    },
  };
}

export function parseOpenClawReleaseClawHubPlanArgs(
  argv: string[],
): OpenClawReleaseClawHubPlanArgs {
  const values = [...argv];
  if (values[0] === "--") {
    values.shift();
  }

  let releaseTag: string | undefined;
  let releasePublishBranch: string | undefined;
  let releasePublishRunId: string | undefined;
  let pluginPublishScope: PluginReleaseSelectionMode | undefined;
  let plugins: string[] = [];
  let pluginsFlagProvided = false;

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

    switch (arg) {
      case "--release-tag":
        releaseTag = next();
        break;
      case "--release-publish-branch":
        releasePublishBranch = next();
        break;
      case "--release-publish-run-id":
        releasePublishRunId = next();
        break;
      case "--plugin-publish-scope":
        pluginPublishScope = parsePluginReleaseSelectionMode(next());
        break;
      case "--plugins":
        plugins = parsePluginReleaseSelection(next());
        pluginsFlagProvided = true;
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

  return {
    releaseTag: requireArg(releaseTag, "--release-tag"),
    releasePublishBranch: requireArg(releasePublishBranch, "--release-publish-branch"),
    releasePublishRunId: requireArg(releasePublishRunId, "--release-publish-run-id"),
    pluginPublishScope: resolvedPluginPublishScope,
    plugins,
  };
}

export async function buildOpenClawReleaseClawHubPlan(
  args: OpenClawReleaseClawHubPlanArgs,
  options: {
    rootDir?: string;
    fetchImpl?: typeof fetch;
    registryBaseUrl?: string;
  } = {},
): Promise<OpenClawReleaseClawHubPlan> {
  const releaseTag = requireArg(args.releaseTag, "releaseTag");
  const releasePublishBranch = requireArg(args.releasePublishBranch, "releasePublishBranch");
  const releasePublishRunId = requireArg(args.releasePublishRunId, "releasePublishRunId");
  const plan = await collectPluginClawHubReleasePlan({
    rootDir: options.rootDir ?? resolve("."),
    selection: args.plugins,
    selectionMode: args.pluginPublishScope,
    fetchImpl: options.fetchImpl,
    registryBaseUrl: options.registryBaseUrl,
  });

  const normalPackages = packageNames(plan.candidates);
  const bootstrapPackages = [
    ...packageNames(plan.bootstrapCandidates),
    ...packageNames(plan.missingTrustedPublisher),
  ];
  const missingTrustedPlugins = packageNames(plan.missingTrustedPublisher);
  assertNoPackageOverlap(normalPackages, bootstrapPackages);

  return {
    clawHubWorkflowRef: releaseTag,
    releasePublishBranch,
    normal: createDispatchTarget({
      workflow: "plugin-clawhub-release.yml",
      ref: releaseTag,
      packages: normalPackages,
      releasePublishRunId,
      releasePublishBranch,
      includePublishScope: true,
    }),
    bootstrap: createDispatchTarget({
      workflow: "plugin-clawhub-new.yml",
      ref: releaseTag,
      packages: bootstrapPackages,
      releasePublishRunId,
      releasePublishBranch,
      includePublishScope: false,
    }),
    summary: {
      normalCount: normalPackages.length,
      bootstrapCount: bootstrapPackages.length,
      missingTrustedPublisherCount: missingTrustedPlugins.length,
      normalPlugins: joinPackageNames(normalPackages),
      bootstrapPlugins: joinPackageNames(bootstrapPackages),
      missingTrustedPlugins: joinPackageNames(missingTrustedPlugins),
    },
    verifier: {
      clawHubWorkflowRef: releaseTag,
    },
  };
}

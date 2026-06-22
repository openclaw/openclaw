// Dry-run planner for stable core/plugin backports.
import {
  computeStablePluginSupportManifestSha256,
  parseStablePluginSupportManifest,
  type StablePluginSupportEntry,
  type StablePluginSupportManifest,
} from "../../src/plugins/plugin-version-drift.ts";

export type StablePluginBackportSource = {
  sourcePr?: string;
  sourceSha?: string;
  eligibilityReason: string;
};

export type StablePluginBackportTarget = {
  targetType: "core" | "plugin";
  targetRepository: string;
  sourceRepository: string;
  targetBranch: string;
  expectedBaseSha: null;
  branchProtectionStatus: "not_checked_dry_run";
  changeKind: "core_only" | "plugin_only" | "coordinated";
  packageName: string;
  pluginId?: string;
  packageDir?: string;
  targetVersion?: string;
  targetNpmSpec?: string;
  publishOrder: number;
  validationPlan: StablePluginBackportValidationStep[];
  rollback: {
    partialFailureState: string;
    command: string;
  };
  retry: {
    command: string;
    requiresProof: string[];
  };
};

export type StablePluginBackportValidationStep = {
  name: string;
  command: string;
  required: boolean;
};

export type StablePluginBackportPlan = {
  schemaVersion: 1;
  dryRun: true;
  stableLine: string;
  stableBranch: string;
  source: StablePluginBackportSource & {
    sourceReviewState: "reviewed_source_required";
  };
  manifest: {
    path?: string;
    sha256: string;
    coveredPackageCount: number;
  };
  affectedPluginIds: string[];
  targets: StablePluginBackportTarget[];
  orderedOperations: {
    order: number;
    targetRepository: string;
    targetBranch: string;
    packageName: string;
    operation: string;
  }[];
  partialFailureStates: {
    state: string;
    recovery: string;
  }[];
};

export type StablePluginBackportPlanInput = {
  sourcePr?: string;
  sourceSha?: string;
  stableLine: string;
  eligibilityReason: string;
  affectedPluginIds?: readonly string[];
  manifest: StablePluginSupportManifest;
  manifestPath?: string;
  coreRepository?: string;
  corePackageName?: string;
};

function normalizeString(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function affectedPluginSet(input: readonly string[] | undefined): Set<string> {
  return new Set((input ?? []).map((entry) => entry.trim()).filter(Boolean));
}

function stableBranchFor(input: StablePluginBackportPlanInput): string {
  return input.manifest.coveredPlugins[0]?.targetBranch ?? `stable/${input.stableLine}`;
}

function pluginValidationPlan(params: {
  stableLine: string;
  packageName: string;
  targetNpmSpec: string;
}): StablePluginBackportValidationStep[] {
  return [
    {
      name: "stable-plugin-drift-dry-run",
      command:
        `node --import tsx scripts/stable-plugin-drift-report.ts --stable-line ${params.stableLine} ` +
        "--manifest <stable-plugin-support.json> --registry-proof <registry-proof.json> " +
        "--package-acceptance <stable-plugin-acceptance.json> --json",
      required: true,
    },
    {
      name: "package-acceptance-stable-plugin",
      command:
        `package-acceptance suite_profile=stable-plugin package=${params.targetNpmSpec} ` +
        `stable_line=${params.stableLine}`,
      required: true,
    },
    {
      name: "plugin-publish-proof",
      command: `npm view ${params.packageName} version dist.integrity dist.tarball time --json`,
      required: true,
    },
  ];
}

function coreValidationPlan(stableLine: string): StablePluginBackportValidationStep[] {
  return [
    {
      name: "core-stable-branch-tests",
      command: "node scripts/run-vitest.mjs test/stable-release-closeout.test.ts",
      required: true,
    },
    {
      name: "stable-plugin-proof-gate",
      command:
        `node --import tsx scripts/stable-plugin-drift-report.ts --stable-line ${stableLine} ` +
        "--manifest <stable-plugin-support.json> --registry-proof <registry-proof.json> " +
        "--package-acceptance <stable-plugin-acceptance.json> --json",
      required: true,
    },
  ];
}

function buildPluginTarget(params: {
  entry: StablePluginSupportEntry;
  stableLine: string;
  order: number;
  coordinated: boolean;
}): StablePluginBackportTarget {
  const retryCommand =
    `node --import tsx scripts/stable-plugin-backport-plan.ts --stable-line ${params.stableLine} ` +
    `--affected-plugin-ids ${params.entry.pluginId} --source-sha <source-sha> ` +
    '--eligibility-reason "<reason>" --manifest <stable-plugin-support.json>';
  return {
    targetType: "plugin",
    targetRepository: params.entry.sourceRepository,
    sourceRepository: params.entry.sourceRepository,
    targetBranch: params.entry.targetBranch,
    expectedBaseSha: null,
    branchProtectionStatus: "not_checked_dry_run",
    changeKind: params.coordinated ? "coordinated" : "plugin_only",
    packageName: params.entry.packageName,
    pluginId: params.entry.pluginId,
    packageDir: params.entry.packageDir,
    targetVersion: params.entry.targetVersion,
    targetNpmSpec: params.entry.targetNpmSpec,
    publishOrder: params.order,
    validationPlan: pluginValidationPlan({
      stableLine: params.stableLine,
      packageName: params.entry.packageName,
      targetNpmSpec: params.entry.targetNpmSpec,
    }),
    rollback: {
      partialFailureState: "partial_plugin_publish",
      command:
        `block stable activation for ${params.entry.packageName}; verify any existing npm package ` +
        "identity before retrying or superseding with a higher stable patch",
    },
    retry: {
      command: retryCommand,
      requiresProof: [
        "registry identity for already-published package",
        "stable-plugin package acceptance proof",
        "stable support manifest digest match",
      ],
    },
  };
}

function buildCoreTarget(params: {
  repository: string;
  packageName: string;
  stableLine: string;
  targetBranch: string;
  order: number;
  coordinated: boolean;
}): StablePluginBackportTarget {
  const retryCommand =
    `node --import tsx scripts/stable-plugin-backport-plan.ts --stable-line ${params.stableLine} ` +
    '--source-sha <source-sha> --eligibility-reason "<reason>" --manifest <stable-plugin-support.json>';
  return {
    targetType: "core",
    targetRepository: params.repository,
    sourceRepository: params.repository,
    targetBranch: params.targetBranch,
    expectedBaseSha: null,
    branchProtectionStatus: "not_checked_dry_run",
    changeKind: params.coordinated ? "coordinated" : "core_only",
    packageName: params.packageName,
    publishOrder: params.order,
    validationPlan: coreValidationPlan(params.stableLine),
    rollback: {
      partialFailureState: params.coordinated
        ? "core_published_plugin_missing"
        : "activation_blocked",
      command:
        "keep previous stable metadata active; do not move selectors until postpublish and " +
        "stable-plugin proof are complete",
    },
    retry: {
      command: retryCommand,
      requiresProof: [
        "stable branch tests",
        "core package postpublish evidence",
        "covered plugin drift report with no blocking drift",
      ],
    },
  };
}

export function generateStablePluginBackportPlan(
  input: StablePluginBackportPlanInput,
): StablePluginBackportPlan {
  const stableLine = normalizeString(input.stableLine, "stableLine");
  const eligibilityReason = normalizeString(input.eligibilityReason, "eligibilityReason");
  const sourcePr = normalizeOptionalString(input.sourcePr);
  const sourceSha = normalizeOptionalString(input.sourceSha);
  if (!sourcePr && !sourceSha) {
    throw new Error("sourcePr or sourceSha is required.");
  }

  const selectedPluginIds = affectedPluginSet(input.affectedPluginIds);
  const pluginsById = new Map(
    input.manifest.coveredPlugins.map((entry) => [entry.pluginId, entry]),
  );
  const missingPluginIds = [...selectedPluginIds].filter((pluginId) => !pluginsById.has(pluginId));
  if (missingPluginIds.length > 0) {
    throw new Error(
      `Affected plugin ids are not covered by the stable support manifest: ${missingPluginIds.join(", ")}.`,
    );
  }

  const stableBranch = stableBranchFor(input);
  const pluginEntries = [...selectedPluginIds].map((pluginId) => pluginsById.get(pluginId)!);
  const targets: StablePluginBackportTarget[] = pluginEntries.map((entry, index) =>
    buildPluginTarget({
      entry,
      stableLine,
      order: index + 1,
      coordinated: true,
    }),
  );
  targets.push(
    buildCoreTarget({
      repository: input.coreRepository ?? "openclaw/openclaw",
      packageName: input.corePackageName ?? "openclaw",
      stableLine,
      targetBranch: stableBranch,
      order: targets.length + 1,
      coordinated: targets.length > 0,
    }),
  );

  return {
    schemaVersion: 1,
    dryRun: true,
    stableLine,
    stableBranch,
    source: {
      ...(sourcePr ? { sourcePr } : {}),
      ...(sourceSha ? { sourceSha } : {}),
      eligibilityReason,
      sourceReviewState: "reviewed_source_required",
    },
    manifest: {
      ...(input.manifestPath ? { path: input.manifestPath } : {}),
      sha256: computeStablePluginSupportManifestSha256(input.manifest),
      coveredPackageCount: input.manifest.coveredPlugins.length,
    },
    affectedPluginIds: [...selectedPluginIds].toSorted(),
    targets,
    orderedOperations: targets.map((target) => ({
      order: target.publishOrder,
      targetRepository: target.targetRepository,
      targetBranch: target.targetBranch,
      packageName: target.packageName,
      operation:
        target.targetType === "plugin"
          ? "backport plugin fix, validate, publish/prove package, then hold core activation"
          : "backport core fix, publish only after covered plugin proof is available",
    })),
    partialFailureStates: [
      {
        state: "planned",
        recovery: "rerun plan after source or evidence fixes; no publish mutation has happened",
      },
      {
        state: "plugin_published_core_pending",
        recovery: "verify plugin registry identity, then resume core publish or supersede patch",
      },
      {
        state: "core_published_plugin_missing",
        recovery: "block activation and repair plugin proof before selector movement",
      },
      {
        state: "partial_plugin_publish",
        recovery: "retry only missing packages after registry proof for succeeded packages",
      },
      {
        state: "activation_blocked",
        recovery: "keep previous stable active and rerun closeout after evidence repair",
      },
    ],
  };
}

export function parseAffectedPluginIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .toSorted();
}

export function parseStablePluginBackportPlanManifest(raw: unknown): StablePluginSupportManifest {
  return parseStablePluginSupportManifest(raw);
}

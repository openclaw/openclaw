import path from "node:path";
import { listAvailableExtensionIds } from "./changed-extensions.mts";
import { selectAffectedBoundaryPackages } from "./extension-boundary-selection.mts";

/** Share PR package ownership with boundary checks; transitive fan-out runs hourly. */
export async function resolveCiExtensionLintSelection(
  changedFiles: readonly string[],
  cwd = process.cwd(),
  { forceFull = false, baseRef }: { forceFull?: boolean; baseRef?: string } = {},
) {
  const available = listAvailableExtensionIds(cwd);
  const fullReasons: string[] = [];
  if (forceFull) {
    fullReasons.push("OPENCLAW_CI_EXTENSION_LINT_FULL");
  }
  for (const file of [...new Set(changedFiles)].toSorted()) {
    if (path.isAbsolute(file) || file.split("/").some((part) => part === ".." || !part)) {
      throw new Error(`Invalid changed extension lint path: ${file}`);
    }
    if (
      file.startsWith("extensions/") &&
      /\.[cm]?[jt]sx?$/u.test(file) &&
      !available.includes(file.split("/")[1] ?? "")
    ) {
      fullReasons.push(`direct shared extension source: ${file}`);
    }
    // These inputs can change type discovery or rules without a source import edge.
    if (
      /(^|\/)tsconfig[^/]*\.json$/u.test(file) ||
      /(^|\/)\.oxlintrc(?:\.json)?$/u.test(file) ||
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"].includes(file) ||
      file.startsWith("config/oxlint/") ||
      file.startsWith("config/tsconfig/") ||
      file.startsWith("patches/") ||
      file.startsWith(".github/actions/setup-node-env/") ||
      file.startsWith(".github/actions/setup-pnpm-store-cache/") ||
      /^scripts\/(?:run-oxlint|oxlint|check-changed|ci-check-plan|changed-lanes)(?:[./-]|$)/u.test(
        file,
      ) ||
      /^scripts\/lib\/(?:oxlint|ci-extension-lint|local-oxlint|extension-import|native-typescript)/u.test(
        file,
      ) ||
      [
        "scripts/lib/local-check-runtime.mts",
        "scripts/generate-kysely-types.mts",
        "scripts/prepare-extension-package-boundary-artifacts.mts",
        "scripts/test-projects.test-support.mts",
        ".github/workflows/ci.yml",
        "scripts/ci-build-manifest.mjs",
        "scripts/ci-static-step.sh",
        "scripts/lib/plugin-sdk-entrypoints.json",
        "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
        "src/state/openclaw-state-schema.sql",
        "src/state/openclaw-agent-schema.sql",
      ].includes(file)
    ) {
      fullReasons.push(`lint or type policy: ${file}`);
      continue;
    }
  }
  let selection: ReturnType<typeof selectAffectedBoundaryPackages> | undefined;
  if (!fullReasons.length) {
    try {
      selection = selectAffectedBoundaryPackages(
        cwd,
        available,
        [...new Set(changedFiles)].map((file) => ({ path: file, status: "M" })),
        baseRef,
        { includeTestSources: true },
      );
    } catch {
      fullReasons.push("direct public-entry inventory unavailable");
    }
  }
  const reasons = Object.fromEntries(
    (selection?.selected ?? []).map(({ package: id, reason }) => [`extensions/${id}`, [reason]]),
  );

  return {
    mode: fullReasons.length ? ("full" as const) : ("selected" as const),
    extensionRoots: Object.keys(reasons).toSorted(),
    reasons,
    fullReasons,
  };
}

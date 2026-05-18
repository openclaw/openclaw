import path from "node:path";

function normalizePath(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function uniqueNormalized(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const normalized = normalizePath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result.sort();
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegExp(glob) {
  const normalized = normalizePath(glob);
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    pattern += escapeRegExp(char);
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAny(pathValue, patterns) {
  const normalized = normalizePath(pathValue);
  return (patterns ?? []).some((pattern) => {
    const normalizedPattern = normalizePath(pattern);
    if (!normalizedPattern) {
      return false;
    }
    if (normalized === normalizedPattern) {
      return true;
    }
    return globToRegExp(normalizedPattern).test(normalized);
  });
}

function relativeStatePath(value, root) {
  const normalized = normalizePath(value);
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot || !path.isAbsolute(value)) {
    return normalized;
  }
  const rel = path.relative(root, value).replaceAll("\\", "/");
  return rel && !rel.startsWith("../") && rel !== ".." ? rel : normalized;
}

export function evaluateDirtyManifestScope(params = {}) {
  const root = typeof params.root === "string" ? params.root : process.cwd();
  const baselineDirtyPaths = uniqueNormalized(
    (params.baselineDirtyPaths ?? []).map((entry) => relativeStatePath(entry, root)),
  );
  const currentDirtyPaths = uniqueNormalized(
    (params.currentDirtyPaths ?? []).map((entry) => relativeStatePath(entry, root)),
  );
  const baseline = new Set(baselineDirtyPaths);
  const current = new Set(currentDirtyPaths);
  const newlyDirtyPaths = currentDirtyPaths.filter((entry) => !baseline.has(entry));
  const preservedBaselineDirtyPaths = baselineDirtyPaths.filter((entry) => current.has(entry));
  const missingBaselineDirtyPaths = baselineDirtyPaths.filter((entry) => !current.has(entry));

  const expectedChangedPaths = uniqueNormalized([
    ...(params.expectedChangedPaths ?? []),
    ...(params.expectedReportPaths ?? []),
    ...(params.allowedArtifactPaths ?? []),
  ]);
  const expectedChangedGlobs = uniqueNormalized(params.expectedChangedGlobs ?? []);
  const derivedStateGlobs = uniqueNormalized(params.derivedStateGlobs ?? []);
  const liveControlPlaneGlobs = uniqueNormalized(params.liveControlPlaneGlobs ?? []);

  const derivedStateDrift = newlyDirtyPaths.filter((entry) => matchesAny(entry, derivedStateGlobs));
  const liveControlPlaneDrift = newlyDirtyPaths.filter((entry) =>
    matchesAny(entry, liveControlPlaneGlobs),
  );
  const reconciliationPathSet = new Set([...derivedStateDrift, ...liveControlPlaneDrift]);
  const implementationEvidencePaths = newlyDirtyPaths.filter(
    (entry) =>
      !reconciliationPathSet.has(entry) &&
      (expectedChangedPaths.includes(entry) || matchesAny(entry, expectedChangedGlobs)),
  );
  const unexpectedChangedPaths = newlyDirtyPaths.filter(
    (entry) =>
      !reconciliationPathSet.has(entry) &&
      !expectedChangedPaths.includes(entry) &&
      !matchesAny(entry, expectedChangedGlobs),
  );

  const splitStateDifferences = uniqueNormalized(params.splitStateDifferences ?? []);
  const reconciliationItems = [];
  if (derivedStateDrift.length > 0) {
    reconciliationItems.push({ kind: "derived-state-drift", paths: derivedStateDrift });
  }
  if (liveControlPlaneDrift.length > 0) {
    reconciliationItems.push({ kind: "live-control-plane-drift", paths: liveControlPlaneDrift });
  }
  if (splitStateDifferences.length > 0) {
    reconciliationItems.push({ kind: "split-main-worktree-state", paths: splitStateDifferences });
  }

  const accepted = unexpectedChangedPaths.length === 0 && missingBaselineDirtyPaths.length === 0;
  return {
    accepted,
    status: accepted
      ? reconciliationItems.length > 0
        ? "PASS_WITH_RECONCILIATION"
        : "PASS"
      : "REJECTED_SCOPE_DRIFT",
    baselineDirtyPaths,
    currentDirtyPaths,
    preservedBaselineDirtyPaths,
    missingBaselineDirtyPaths,
    newlyDirtyPaths,
    implementationEvidencePaths,
    unexpectedChangedPaths,
    derivedStateDrift,
    liveControlPlaneDrift,
    reconciliationItems,
  };
}

const sizeLabels = ["size: XS", "size: S", "size: M", "size: L", "size: XL"];

export async function ensureSizeLabels({ github, owner, repo }) {
  for (const name of sizeLabels) {
    try {
      await github.rest.issues.getLabel({ owner, repo, name });
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
      await github.rest.issues.createLabel({ owner, repo, name, color: "b76e79" });
    }
  }
}

export async function applySizeLabel({
  github,
  core,
  owner,
  repo,
  issueNumber,
  files,
  labelNames,
}) {
  const excludedLockfiles = new Set(["pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
  const totalChangedLines = files.reduce((total, file) => {
    const path = file.filename ?? "";
    return path.startsWith("docs/") || excludedLockfiles.has(path)
      ? total
      : total + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);
  let targetSizeLabel = "size: XL";
  if (totalChangedLines < 50) {
    targetSizeLabel = "size: XS";
  } else if (totalChangedLines < 200) {
    targetSizeLabel = "size: S";
  } else if (totalChangedLines < 500) {
    targetSizeLabel = "size: M";
  } else if (totalChangedLines < 1000) {
    targetSizeLabel = "size: L";
  }

  // Remove stale sizes first to free a slot at the cap. Update the shared facts only
  // after each successful write so later backfill steps see the labels that exist.
  for (const name of labelNames) {
    if (sizeLabels.includes(name) && name !== targetSizeLabel) {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
      labelNames.delete(name);
    }
  }
  if (!labelNames.has(targetSizeLabel)) {
    const added = await addLabelsWithinCap({
      github,
      core,
      owner,
      repo,
      issueNumber,
      labels: [targetSizeLabel],
    });
    if (added) {
      labelNames.add(targetSizeLabel);
    }
  }
}

// One owner for GitHub's 100-labels-per-issue cap. Labeler steps are cosmetic: hitting the cap
// is a visible warning naming the skipped label, never a red check. Unrelated errors still throw.
export async function addLabelsWithinCap({ github, core, owner, repo, issueNumber, labels }) {
  try {
    await github.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
    return true;
  } catch (error) {
    if (error?.status !== 422 || !/cannot have more than 100 labels/i.test(error.message ?? "")) {
      throw error;
    }
    core.warning(
      `Skipping label ${labels.map((label) => JSON.stringify(label)).join(", ")} on #${issueNumber}: GitHub caps issues at 100 labels.`,
    );
    return false;
  }
}

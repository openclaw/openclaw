import { execFileSync } from "node:child_process";

/** Conservative owner classification: unknown runtime paths still require a disposition. */
export function classifyUpgradeChangedContracts(paths: readonly string[]): string[] {
  const contracts = new Set<string>();
  for (const filename of paths) {
    if (/^(src|packages|extensions|native|scripts)\//.test(filename)) {
      contracts.add("runtime");
    }
    if (/^src\/(config|commands\/doctor)/.test(filename)) {
      contracts.add("configuration");
    }
    if (/^src\/(state|infra\/.*(?:sqlite|database|state))/.test(filename)) {
      contracts.add("state-db");
      contracts.add("agent-db");
    }
    if (/^(extensions\/|src\/(plugins|plugin-sdk)\/)/.test(filename)) {
      contracts.add("plugin-registry");
      contracts.add("plugin-data");
    }
    if (/^src\/(daemon|gateway|process)\//.test(filename)) {
      contracts.add("service-definition");
    }
    if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(filename)) {
      contracts.add("package");
      contracts.add("runtime");
    }
    if (
      /^src\/(infra\/(upgrade-recipes|update-|package-update)|cli\/update-cli)/.test(filename) ||
      filename.startsWith("native/update-bootstrap/") ||
      /^scripts\/(?:.*upgrade|lib\/managed-handoff)/.test(filename)
    ) {
      contracts.add("upgrade-control-plane");
    }
  }
  return [...contracts].toSorted();
}

/** Release callers pin both revisions; no moving ref or hand-selected path list can omit changes. */
export function deriveUpgradeChangedContracts(base: string, head: string, cwd?: string): string[] {
  const exactCommit = /^[a-f0-9]{40}$/;
  if (!exactCommit.test(base) || !exactCommit.test(head)) {
    throw new Error("Upgrade qualification requires full immutable base and head commit SHAs.");
  }
  for (const revision of [base, head]) {
    const resolved = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      cwd,
    }).trim();
    if (resolved !== revision) {
      throw new Error("Upgrade qualification commit identity differs from its pinned SHA.");
    }
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], { cwd, stdio: "pipe" });
  } catch {
    throw new Error("Upgrade qualification baseline must be an ancestor of the target commit.");
  }
  const paths = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, head, "--"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      cwd,
    },
  )
    .split("\0")
    .filter(Boolean);
  return classifyUpgradeChangedContracts(paths);
}

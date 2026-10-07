import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Explicit operator recovery qualifies this historical evidence; matching text
// alone never authorizes retry. gh v2.98 canMerge returns before mergePullRequest
// for this complete DIRTY refusal (cli/cli:pkg/cmd/pr/merge/merge.go).
const [directory, captureOid, repo, pr, repoUrl] = process.argv.slice(2);
const names = ["gates.env", "merge-output.log", "prep.env", "prep.md"];
const oid = /^[0-9a-f]{40}$/u;
const hash = (path) => {
  if (!lstatSync(path).isFile()) {
    throw new Error("legacy evidence must be regular files");
  }
  return execFileSync(
    process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git",
    ["hash-object", "--no-filters", "--", path],
    {
      encoding: "utf8",
    },
  ).trim();
};

try {
  const captures = readdirSync(".local").filter((name) =>
    /^merge-output(?:\..+)?\.log$/u.test(name),
  );
  if (captures.length !== 1 || captures[0] !== "merge-output.log") {
    throw new Error("require the sole original legacy capture; other attempts remain unresolved");
  }
  const files = Object.fromEntries(names.map((name) => [name, hash(join(directory, name))]));
  if (
    !oid.test(captureOid) ||
    files["merge-output.log"] !== captureOid ||
    hash(".local/merge-output.log") !== captureOid
  ) {
    throw new Error("legacy capture differs from the operator-pinned original");
  }
  const expected = `X Pull request ${repo}#${pr} is not mergeable: the merge commit cannot be cleanly created.
To have the pull request merged after all the requirements have been met, add the \`--auto\` flag.
Run the following to resolve the merge conflicts locally:
  gh pr checkout ${pr} && git fetch origin main && git merge origin/main
`;
  if (readFileSync(join(directory, "merge-output.log"), "utf8") !== expected) {
    throw new Error("capture is not the qualified complete gh pre-dispatch refusal");
  }
  // Historical shell artifacts are data: never source them during recovery.
  const prep = readFileSync(join(directory, "prep.env"), "utf8");
  const field = (name) => {
    const rows = prep.split("\n").filter((line) => line.startsWith(`${name}=`));
    if (rows.length !== 1) {
      throw new Error("missing or duplicate legacy preparation identity");
    }
    return rows[0].slice(name.length + 1);
  };
  const head = field("PREP_HEAD_SHA");
  const preparedBase = field("PREP_MAINLINE_BASE_SHA");
  if (field("PR_NUMBER") !== pr || !oid.test(head) || !oid.test(preparedBase)) {
    throw new Error("invalid legacy PR/head/prepared-base identity");
  }
  const urls = prep.split("\n").filter((line) => line.startsWith("PR_URL="));
  if (urls.length && (urls.length !== 1 || urls[0] !== `PR_URL=${repoUrl}/pull/${pr}`)) {
    throw new Error("legacy preparation belongs to a different PR");
  }
  process.stdout.write(
    JSON.stringify({ kind: "gh-2.98-pre-dispatch-refusal", head, preparedBase, files }),
  );
} catch (error) {
  console.error(
    `Legacy refusal recovery: ${error.message}; preserve the evidence for investigation.`,
  );
  process.exitCode = 1;
}

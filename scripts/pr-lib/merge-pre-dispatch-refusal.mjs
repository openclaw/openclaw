import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// This is explicit operator qualification of an inspected invocation, never an
// automatic retry based on stderr. Keep the historical exception source-bound.
const [directory, outcome, recordJson] = process.argv.slice(2);
const retained = directory.startsWith("git:") ? directory.slice(4) : "";
const git = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const read = (name) =>
  retained
    ? execFileSync(git, ["show", `${retained}:pre-dispatch-refusal/${name}`], {
        encoding: "utf8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      })
    : readFileSync(join(directory, name), "utf8");
const hash = (path) => {
  if (!lstatSync(path).isFile()) {
    throw new Error("refusal evidence must be regular files");
  }
  return execFileSync(git, ["hash-object", "--no-filters", "--", path], {
    encoding: "utf8",
  }).trim();
};
const evidenceHash = (name) =>
  retained
    ? execFileSync(git, ["rev-parse", `${retained}:pre-dispatch-refusal/${name}`], {
        encoding: "utf8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      }).trim()
    : hash(join(directory, name));
try {
  const record = JSON.parse(recordJson);
  if (
    record.phase !== "intent" ||
    record.accepted !== false ||
    record.route !== "auto" ||
    record.method !== "squash"
  ) {
    throw new Error("require the retained unaccepted auto squash intent");
  }
  const capture = `merge-output.${record.attempt}.log`;
  const captures = retained
    ? [capture]
    : readdirSync(".local").filter((name) => /^merge-output(?:\..+)?\.log$/u.test(name));
  if (captures.length !== 1 || captures[0] !== capture) {
    throw new Error("require the sole original attempt capture; other attempts remain unresolved");
  }
  const entries = retained
    ? execFileSync(git, ["ls-tree", "--name-only", `${retained}:pre-dispatch-refusal`], {
        encoding: "utf8",
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
      })
        .trim()
        .split("\n")
    : readdirSync(directory);
  if (
    entries.length !== 2 ||
    !entries.includes(capture) ||
    !entries.includes("qualification.json")
  ) {
    throw new Error(
      "require exactly the original capture and qualification.json; extra evidence remains unresolved",
    );
  }
  const qualification = evidenceHash("qualification.json");
  const proof = JSON.parse(read("qualification.json"));
  const captureOid = evidenceHash(capture);
  if (
    proof.outcome !== outcome ||
    proof.capture !== captureOid ||
    (!retained && hash(join(".local", capture)) !== captureOid) ||
    proof.inspected !== true
  ) {
    throw new Error("qualification does not pin the inspected original outcome and capture");
  }
  const contents = read(capture);
  if (proof.kind === "octopool-0.6.10-auto-refusal") {
    const expected = [
      "pr",
      "merge",
      String(record.pr),
      "--repo",
      record.repo.url,
      "--squash",
      "--auto",
      "--match-head-commit",
      record.head,
      "--body-file",
    ];
    if (
      proof.version !== "0.6.10" ||
      proof.sourceRevision !== "00c442d8084ad26eb5a5003f7372170e75a20c8a" ||
      proof.parserSha256 !== "f6ff8cd7e59503f71f94fefd561b671193df11b3aac9ba0986a0dc3ba91ca32b" ||
      !Array.isArray(proof.args) ||
      proof.args.length !== expected.length + 1 ||
      !expected.every((arg, index) => proof.args[index] === arg) ||
      typeof proof.args.at(-1) !== "string" ||
      !/^\.local\/merge-body\.[A-Za-z0-9]+$/u.test(proof.args.at(-1)) ||
      contents !== "error: string rewrite protection blocked unsafe input\n"
    ) {
      throw new Error("require the source-qualified complete Octopool 0.6.10 auto refusal");
    }
  } else if (proof.kind === "octopool-merge-diagnostics") {
    const diagnostics = contents
      .split("\n")
      .filter((line) => line.startsWith("octopool: merge_diagnostics "));
    // Octopool prints the returned error after its deferred diagnostic. No
    // started child, mutation exit status, or ambiguous diagnostic is admitted.
    const receipt =
      /^octopool: merge_diagnostics attempt_utc=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z elapsed_ms=\d+ child_started=false outcome=(?:preparation_failed|start_failed|canceled_before_start)(?: route=(?:native|rest_put))?(?: server_policy_revision=\d+ effective_rule_count=\d+)? headers=unavailable$/u;
    if (
      proof.diagnosticsEnabled !== true ||
      proof.producer !== "octopool" ||
      diagnostics.length !== 1 ||
      !receipt.test(diagnostics[0])
    ) {
      throw new Error(
        "require one inspected Octopool diagnostic proving no mutation child started",
      );
    }
  } else {
    throw new Error("unsupported pre-dispatch qualification");
  }
  process.stdout.write(
    JSON.stringify({
      kind: proof.kind,
      capture,
      files: { [capture]: captureOid, "qualification.json": qualification },
    }),
  );
} catch (error) {
  console.error(
    `Pre-dispatch refusal recovery: ${error.message}; preserve the original outcome and evidence.`,
  );
  process.exitCode = 1;
}

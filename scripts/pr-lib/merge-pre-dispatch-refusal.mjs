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
  if (
    proof.kind === "octopool-0.6.10-auto-refusal" ||
    proof.kind === "octopool-0.7.1-missing-subject-refusal"
  ) {
    const source =
      proof.kind === "octopool-0.6.10-auto-refusal"
        ? {
            version: "0.6.10",
            revision: "00c442d8084ad26eb5a5003f7372170e75a20c8a",
            parserSha256: "f6ff8cd7e59503f71f94fefd561b671193df11b3aac9ba0986a0dc3ba91ca32b",
          }
        : {
            version: "0.7.1",
            revision: "7ab9b348c99a7be4fdc82c75cb06ebce44e0007e",
            parserSha256: "b32cb960537f5ffa1336a7689674afba9b4a2485b05e449acd2684a251ff8970",
          };
    // The 0.7.1 parser rejects this exact missing-subject shape before starting gh.
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
      proof.version !== source.version ||
      proof.sourceRevision !== source.revision ||
      proof.parserSha256 !== source.parserSha256 ||
      !Array.isArray(proof.args) ||
      proof.args.length !== expected.length + 1 ||
      !expected.every((arg, index) => proof.args[index] === arg) ||
      typeof proof.args.at(-1) !== "string" ||
      !/^\.local\/merge-body\.[A-Za-z0-9]+$/u.test(proof.args.at(-1)) ||
      contents !== "error: string rewrite protection blocked unsafe input\n"
    ) {
      throw new Error(
        `require the source-qualified complete Octopool ${source.version} auto refusal`,
      );
    }
  } else if (proof.kind === "octopool-0.7.1-policy-timeout-refusal") {
    const sourceHashes = {
      "cmd/octopool/main.go": "4f953ba8def54614a5baf99f3747f0786996225f12a0d7cb4ad7d7bb4e817ef3",
      "cmd/octopool/gh.go": "0e22e7631e3b363689709dc5216e94ceb9177f8e4e539e40433d36b80d14a53d",
      "cmd/octopool/gh_fallback.go":
        "a23e05a735e8f2ed2c8fd6432c4983947dffc9d7b04c1c9e2acd680b45325605",
      "cmd/octopool/string_rewrites_guard.go":
        "2b5e768575554582c41f076401e0408b082b44dcf09b5fc5e040c9c66adafdec",
      "cmd/octopool/string_rewrites_policy.go":
        "ab422f237f06ea9f1b24b5342dced2aae80f59aaa782aaef6c3dd300275bcc41",
      "cmd/octopool/string_rewrites_diagnostic.go":
        "a7b1cce841174517f9e42cb8d8ec3d6f156420c4743b1a5b5f9c9b3c30b4bcbd",
      "cmd/octopool/gh_merge_diagnostics.go":
        "611c1e0bce036778b635b801192230af33d940fafcf923803ca643a21e68cf93",
      "cmd/octopool/string_rewrites_pr.go":
        "b32cb960537f5ffa1336a7689674afba9b4a2485b05e449acd2684a251ff8970",
    };
    // This revision returns the initial policy error before preparing merge diagnostics
    // or starting a child. A later preparation failure emits a separate diagnostic.
    const timeout =
      /^error: string rewrite policy unavailable or invalid \(class=timeout attempt_utc=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z elapsed_ms=(?:0|[1-9]\d{0,12})\)\n$/u.exec(
        contents,
      );
    if (
      proof.producer !== "octopool" ||
      proof.command !== "pr merge" ||
      proof.version !== "0.7.1" ||
      proof.sourceRevision !== "7ab9b348c99a7be4fdc82c75cb06ebce44e0007e" ||
      proof.executableSha256 !==
        "2d732a74133cc68481b453afc630c7ca6651ad5a613931ad777c3bc6b1b17d7e" ||
      proof.diagnosticsEnabled !== true ||
      Object.keys(proof.sourceSha256 ?? {}).length !== Object.keys(sourceHashes).length ||
      !Object.entries(sourceHashes).every(
        ([path, digest]) => proof.sourceSha256?.[path] === digest,
      ) ||
      !timeout ||
      timeout[0] !== contents
    ) {
      throw new Error("require the source-qualified complete Octopool 0.7.1 policy timeout");
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

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { baselineRefreshCandidate } from "./baseline-refresh.mjs";
import { validateCorrectionReview } from "./correction-review-policy.mjs";
import { incomingReview } from "./incoming-review.mjs";
import { createReviewArtifactTemplate, renderReviewMarkdown } from "./review-artifacts.mjs";

const gitExecutable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const git = (...args) => execFileSync(gitExecutable, args, { encoding: "utf8" }).trim();

function readRegular(path) {
  if (!lstatSync(path).isFile()) {
    throw new Error(`Expected a regular review file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function candidateMetadata(prMeta, incoming, head, jsonOid, anchor, bindingOid, localPreflight) {
  if (lstatSync(".local/review-transition.json", { throwIfNoEntry: false })) {
    throw new Error(
      "Complete the retained native transition before correction review or publication.",
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(head) || head === incoming || git("rev-parse", "HEAD") !== head) {
    throw new Error("Review a committed correction, not the unchanged incoming head.");
  }
  execFileSync(gitExecutable, ["merge-base", "--is-ancestor", incoming, head]);
  execFileSync(gitExecutable, ["diff", "--quiet", "HEAD", "--"]);
  if (git("ls-files", "--others", "--exclude-standard")) {
    throw new Error("Commit or preserve untracked source before reviewing the correction.");
  }
  // Include both the incoming scope and every fixup path. Candidate metadata is
  // derived in memory; the live incoming-head metadata is never rewritten.
  const baseline = baselineRefreshCandidate({
    pr: prMeta.number,
    incoming,
    incomingReviewOid: jsonOid,
    head,
    anchor,
    bindingOid,
    main: process.env.OPENCLAW_PR_CAPTURED_MAIN,
    localPreflight,
  });
  const paths = new Set([...prMeta.files.map((file) => file.path), ...baseline.paths]);
  return {
    metadata: { ...prMeta, headRefOid: head, files: [...paths].map((path) => ({ path })) },
    baselineHead: baseline.baselineHead,
  };
}

function runCorrectionReview(
  command,
  pr,
  incoming,
  head,
  jsonOid,
  anchor,
  bindingOid,
  source,
  workflowBinding,
) {
  const forProof = command === "proof-publication" || command === "proof-publication-baseline";
  if (
    ![
      "init",
      "validate",
      "validate-preflight",
      "publication-baseline",
      "proof-publication",
      "proof-publication-baseline",
    ].includes(command) ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !/^[0-9a-f]{40}$/u.test(incoming)
  ) {
    throw new Error("Invalid correction-review command or PR number.");
  }
  const { prMeta, findings } = incomingReview(pr, incoming, jsonOid);
  const candidate = candidateMetadata(
    prMeta,
    incoming,
    head,
    jsonOid,
    anchor,
    bindingOid,
    command === "validate-preflight",
  );
  const jsonPath = ".local/correction-review.json";
  const incomingJsonPath = ".local/correction-incoming-review.json";
  if (command === "init") {
    const existing = [jsonPath, incomingJsonPath].filter((path) =>
      lstatSync(path, { throwIfNoEntry: false }),
    );
    for (const path of existing) {
      readRegular(path);
    }
    if (existing.length) {
      const archive = mkdtempSync(".local/correction-review-retained.");
      for (const path of existing) {
        copyFileSync(path, join(archive, path.split("/").at(-1)));
      }
    }
    const review = createReviewArtifactTemplate({ number: pr, headSha: head });
    review.correction = {
      incomingHeadSha: incoming,
      incomingReviewJsonOid: jsonOid,
      resolvedFindings: findings.map(({ id }) => ({ id, resolution: "" })),
    };
    copyFileSync(".local/review.json", incomingJsonPath);
    writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`);
    return;
  }
  const review = JSON.parse(readRegular(jsonPath));
  readRegular(incomingJsonPath);
  const proof = validateCorrectionReview({
    review,
    prMeta: candidate.metadata,
    findings,
    incoming,
    head,
    jsonOid,
    incomingCopyOid: git("hash-object", "--no-filters", incomingJsonPath),
    forProof,
    source,
    workflowBinding,
    reviewOid: git("hash-object", "--no-filters", jsonPath),
  });
  process.stdout.write(
    command.endsWith("publication-baseline")
      ? (candidate.baselineHead ?? "")
      : proof
        ? JSON.stringify(proof)
        : renderReviewMarkdown(review),
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [command, pr, incoming, head, jsonOid, anchor, bindingOid, ...extra] =
      process.argv.slice(2);
    const forProof = command === "proof-publication" || command === "proof-publication-baseline";
    if (extra.length !== (forProof ? 2 : 0) || !jsonOid) {
      throw new Error(
        "Expected command, PR, incoming/candidate heads and incoming review JSON object ID.",
      );
    }
    runCorrectionReview(command, Number(pr), incoming, head, jsonOid, anchor, bindingOid, ...extra);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

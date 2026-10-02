import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { validateReviewArtifacts } from "./review-artifacts.mjs";

const gitExecutable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const git = (...args) => execFileSync(gitExecutable, args, { encoding: "utf8" }).trim();

function readRegular(path) {
  if (!lstatSync(path).isFile()) {
    throw new Error(`Expected a regular review file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

export function incomingReview(pr, incoming, jsonOid) {
  const reviewPath = ".local/review.json";
  const review = JSON.parse(readRegular(reviewPath));
  const prMeta = JSON.parse(readRegular(".local/pr-meta.json"));
  const violations = validateReviewArtifacts({ review, prMeta });
  if (violations.length) {
    throw new Error(violations.join("\n"));
  }
  if (prMeta.number !== pr || prMeta.headRefOid !== incoming) {
    throw new Error("Correction preparation does not match the incoming PR review.");
  }
  if (git("hash-object", "--no-filters", reviewPath) !== jsonOid) {
    throw new Error(
      "Incoming review changed after correction admission. Retain evidence and re-review.",
    );
  }
  const findings = review.findings.filter((item) =>
    ["BLOCKER", "IMPORTANT"].includes(item.severity),
  );
  if (review.recommendation !== "NEEDS WORK" || findings.length === 0) {
    throw new Error("Correction admission requires NEEDS WORK with actionable findings.");
  }
  if (new Set(findings.map((item) => item.id)).size !== findings.length) {
    throw new Error("Correction admission requires distinct finding IDs.");
  }
  return { prMeta, findings };
}

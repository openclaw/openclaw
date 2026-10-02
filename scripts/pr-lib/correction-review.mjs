#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import {
  createReviewArtifactTemplate,
  renderReviewMarkdown,
  validateReviewArtifacts,
} from "./review-artifacts.mjs";

const gitExecutable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const git = (...args) => execFileSync(gitExecutable, args, { encoding: "utf8" }).trim();

function readRegular(path) {
  if (!lstatSync(path).isFile()) {
    throw new Error(`Expected a regular review file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function incomingReview(pr, incoming, jsonOid) {
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

function candidateMetadata(prMeta, incoming, head) {
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
  const changed = execFileSync(gitExecutable, ["diff", "--name-only", "-z", incoming, head], {
    encoding: "utf8",
    // The complete path set is required; a fixed capture cap rejects large corrections.
    maxBuffer: Infinity,
  })
    .split("\0")
    .filter(Boolean);
  const paths = new Set([...prMeta.files.map((file) => file.path), ...changed]);
  return { ...prMeta, headRefOid: head, files: [...paths].map((path) => ({ path })) };
}

function runCorrectionReview(command, pr, incoming, head, jsonOid) {
  if (
    !["init", "validate"].includes(command) ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !/^[0-9a-f]{40}$/u.test(incoming)
  ) {
    throw new Error("Invalid correction-review command or PR number.");
  }
  const { prMeta, findings } = incomingReview(pr, incoming, jsonOid);
  const candidate = candidateMetadata(prMeta, incoming, head);
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
  const violations = validateReviewArtifacts({
    review,
    prMeta: candidate,
  });
  if (violations.length) {
    throw new Error(violations.join("\n"));
  }
  readRegular(incomingJsonPath);
  if (
    review.correction?.incomingReviewJsonOid !== jsonOid ||
    git("hash-object", "--no-filters", incomingJsonPath) !== jsonOid
  ) {
    throw new Error("Correction approval does not bind these exact incoming review bytes.");
  }
  if (review.recommendation !== "READY FOR /prepare-pr") {
    throw new Error(
      "The exact correction needs an independent READY review before gates or publication.",
    );
  }
  const resolved = review.correction?.resolvedFindings;
  if (
    review.correction?.incomingHeadSha !== incoming ||
    !Array.isArray(resolved) ||
    resolved.length !== findings.length ||
    new Set(resolved.map((item) => item?.id)).size !== findings.length ||
    !findings.every(({ id }) =>
      resolved.some(
        (item) =>
          item?.id === id &&
          typeof item.resolution === "string" &&
          item.resolution.trim().length > 0,
      ),
    )
  ) {
    throw new Error("The correction review must resolve every incoming BLOCKER/IMPORTANT finding.");
  }
  process.stdout.write(renderReviewMarkdown(review));
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [command, pr, incoming, head, jsonOid, ...extra] = process.argv.slice(2);
    if (extra.length || !jsonOid) {
      throw new Error(
        "Expected command, PR, incoming/candidate heads and incoming review JSON object ID.",
      );
    }
    runCorrectionReview(command, Number(pr), incoming, head, jsonOid);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

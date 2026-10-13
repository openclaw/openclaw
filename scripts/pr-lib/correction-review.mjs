#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { baselineCorrectionAuthority } from "./baseline-refresh.mjs";
import { incomingHash, readIncomingFile, retainIncoming } from "./correction-incoming.mjs";
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

function candidateMetadata(prMeta, incoming, head, changed) {
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
  const paths = new Set([...prMeta.files.map((file) => file.path), ...changed]);
  return { ...prMeta, headRefOid: head, files: [...paths].map((path) => ({ path })) };
}

function runCorrectionReview(
  command,
  pr,
  incoming,
  head,
  jsonOid,
  anchor,
  bindingOid,
  metaOid,
  envOid,
  incomingFiles,
) {
  if (
    !["init", "validate"].includes(command) ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !/^[0-9a-f]{40}$/u.test(incoming)
  ) {
    throw new Error("Invalid correction-review command or PR number.");
  }
  if (incomingFiles && command !== "init") {
    throw new Error("Incoming recovery only initializes fresh review.");
  }
  const { scope, original } = baselineCorrectionAuthority({
    pr,
    incoming,
    incomingReviewOid: jsonOid,
    head,
    anchor,
    bindingOid,
    metaOid,
    envOid,
    incomingFiles,
  });
  const { meta: prMeta, findings } = original;
  const candidate = candidateMetadata(prMeta, incoming, head, scope);
  const liveMeta = JSON.parse(readIncomingFile(".local/pr-meta.json"));
  const liveReviewBytes = readIncomingFile(".local/review.json");
  const liveReview = JSON.parse(liveReviewBytes);
  const identity = (meta) =>
    JSON.stringify([
      meta.number,
      meta.url,
      meta.baseRefName,
      meta.headRefName,
      meta.baseRepository?.id,
      meta.baseRepository?.nameWithOwner,
      meta.baseRepository?.url,
      meta.headRepository?.id,
      meta.headRepository?.nameWithOwner,
      meta.headRepository?.url,
      meta.headRepositoryOwner?.login,
    ]);
  if (identity(liveMeta) !== identity(prMeta)) {
    throw new Error("Published review changed PR repository or branch identity.");
  }
  const liveViolations = validateReviewArtifacts({ review: liveReview, prMeta: liveMeta });
  if (liveViolations.length) {
    throw new Error(liveViolations.join("\n"));
  }
  const published = liveMeta.headRefOid !== incoming;
  if (
    !published &&
    (incomingHash(liveReviewBytes) !== jsonOid ||
      incomingHash(readIncomingFile(".local/pr-meta.json")) !== original.oids[0] ||
      incomingHash(readIncomingFile(".local/pr-meta.env")) !== original.oids[1])
  ) {
    throw new Error(
      "Incoming review changed after correction admission. Retain evidence and re-review.",
    );
  }
  const publishedFindings = published
    ? liveReview.findings.filter(({ severity }) => ["BLOCKER", "IMPORTANT"].includes(severity))
    : [];
  if (
    published &&
    (!["NEEDS WORK", "READY FOR /prepare-pr"].includes(liveReview.recommendation) ||
      new Set(publishedFindings.map(({ id }) => id)).size !== publishedFindings.length)
  ) {
    throw new Error("Published review does not admit a correction round.");
  }
  // The shell caller validates the native local/hosted receipt. An identical-tree
  // GraphQL alias need not be a local ancestor; later changed fixups must be.
  if (
    published &&
    git("rev-parse", `${liveMeta.headRefOid}^{tree}`) !== git("rev-parse", `${head}^{tree}`)
  ) {
    execFileSync(gitExecutable, ["merge-base", "--is-ancestor", liveMeta.headRefOid, head]);
  }
  const jsonPath = ".local/correction-review.json";
  const incomingJsonPath = ".local/correction-incoming-review.json";
  if (command === "init") {
    const existing = [jsonPath, incomingJsonPath].filter((path) =>
      lstatSync(path, { throwIfNoEntry: false }),
    );
    for (const path of existing) {
      readRegular(path);
    }
    if (existing.includes(jsonPath)) {
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
    if (published) {
      review.correction.publishedReview = {
        headSha: liveMeta.headRefOid,
        jsonOid: incomingHash(liveReviewBytes),
        resolvedFindings: publishedFindings.map(({ id }) => ({ id, resolution: "" })),
      };
    }
    if (incomingFiles) {
      retainIncoming(original);
    }
    writeFileSync(incomingJsonPath, original.bytes[2]);
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
  if (published) {
    const bound = review.correction?.publishedReview;
    if (
      bound?.headSha !== liveMeta.headRefOid ||
      bound?.jsonOid !== incomingHash(liveReviewBytes) ||
      !Array.isArray(bound.resolvedFindings) ||
      bound.resolvedFindings.length !== publishedFindings.length ||
      new Set(bound.resolvedFindings.map((item) => item?.id)).size !== publishedFindings.length ||
      !publishedFindings.every(({ id }) =>
        bound.resolvedFindings.some(
          (item) =>
            item?.id === id && typeof item.resolution === "string" && item.resolution.trim(),
        ),
      )
    ) {
      throw new Error(
        "Correction review must bind and resolve the current published review findings.",
      );
    }
  }
  process.stdout.write(renderReviewMarkdown(review));
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [command, pr, incoming, head, jsonOid, anchor, bindingOid, metaOid, envOid, ...files] =
      process.argv.slice(2);
    if (![0, 3].includes(files.length) || !jsonOid) {
      throw new Error(
        "Expected command, PR, incoming/candidate heads and incoming review JSON object ID.",
      );
    }
    runCorrectionReview(
      command,
      Number(pr),
      incoming,
      head,
      jsonOid,
      anchor,
      bindingOid,
      metaOid,
      envOid,
      files.length ? files : undefined,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

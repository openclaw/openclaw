#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { baselineRefreshCandidate } from "./baseline-refresh.mjs";
import { incomingReview } from "./incoming-review.mjs";
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

function candidateMetadata(prMeta, incoming, head, jsonOid, anchor, bindingOid) {
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
  });
  const paths = new Set([...prMeta.files.map((file) => file.path), ...baseline.paths]);
  return {
    metadata: { ...prMeta, headRefOid: head, files: [...paths].map((path) => ({ path })) },
    baselineHead: baseline.baselineHead,
  };
}

function proofPublication(review, findings, head, source, binding) {
  const proof = review.correction?.proofPublication;
  const keys = [
    "expectedHostedHead",
    "headSha",
    "kind",
    "pendingFindings",
    "treeOid",
    "version",
    "workflowBinding",
    "workflowSource",
  ];
  const oid = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
  if (
    !proof ||
    JSON.stringify(Object.keys(proof).toSorted()) !== JSON.stringify(keys) ||
    proof.version !== 1 ||
    proof.kind !== "published-candidate-proof" ||
    review.recommendation !== "NEEDS WORK" ||
    review.issueValidation.performed !== true ||
    review.issueValidation.status !== "valid" ||
    proof.headSha !== head ||
    proof.treeOid !== git("rev-parse", `${head}^{tree}`) ||
    proof.workflowSource !== source ||
    ![source, binding, proof.workflowBinding, proof.expectedHostedHead].every(oid)
  ) {
    throw new Error(
      "Proof publication requires an exact typed candidate and workflow authorization.",
    );
  }
  // A successor retains the old binding and this exact review. Binding the new
  // OID inside the review would make the review/successor hashes circular.
  if (binding !== proof.workflowBinding) {
    const successor = JSON.parse(git("show", `${binding}:binding.json`));
    if (
      successor.version !== 2 ||
      successor.source !== source ||
      successor.predecessor !== proof.workflowBinding ||
      successor.continuation?.head !== head ||
      successor.continuation?.tree !== proof.treeOid ||
      successor.continuation?.hostedHead !== proof.expectedHostedHead ||
      successor.continuation?.review !==
        git("hash-object", "--no-filters", ".local/correction-review.json")
    ) {
      throw new Error("Proof publication workflow continuation changed.");
    }
  }
  const required = review.findings.filter(({ severity }) => severity !== "NIT");
  const unresolved = findings.filter(
    ({ id }) =>
      !review.correction.resolvedFindings.find((item) => item.id === id).resolution.trim(),
  );
  const pending = proof.pendingFindings;
  if (
    !Array.isArray(pending) ||
    pending.length === 0 ||
    pending.length !== required.length ||
    new Set(pending.map((item) => item?.id)).size !== pending.length ||
    required.some(({ severity }) => severity !== "IMPORTANT") ||
    unresolved.some(
      ({ id, severity }) => severity !== "IMPORTANT" || !required.some((item) => item.id === id),
    ) ||
    !pending.every(
      (item) =>
        item &&
        JSON.stringify(Object.keys(item).toSorted()) === '["evidence","id"]' &&
        typeof item.id === "string" &&
        /^[A-Za-z0-9_.-]+$/u.test(item.id) &&
        typeof item.evidence === "string" &&
        item.evidence.trim().length > 0 &&
        !review.correction.resolvedFindings.some(
          ({ id, resolution }) => id === item.id && resolution.trim().length > 0,
        ) &&
        required.some(({ id }) => id === item.id),
    )
  ) {
    throw new Error(
      "Proof authorization must enumerate every unresolved IMPORTANT finding and its required evidence; BLOCKER findings remain blocking.",
    );
  }
  return proof;
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
  const candidate = candidateMetadata(prMeta, incoming, head, jsonOid, anchor, bindingOid);
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
    prMeta: candidate.metadata,
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
  if (!forProof && review.recommendation !== "READY FOR /prepare-pr") {
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
          (forProof || item.resolution.trim().length > 0),
      ),
    )
  ) {
    throw new Error("The correction review must resolve every incoming BLOCKER/IMPORTANT finding.");
  }
  const proof = forProof ? proofPublication(review, findings, head, source, workflowBinding) : null;
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

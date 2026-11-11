import { execFileSync } from "node:child_process";
import { validateReviewArtifacts } from "./review-artifacts.mjs";
const executable = process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git";
const git = (...args) => execFileSync(executable, args, { encoding: "utf8" }).trim();

function proofPublication(review, findings, head, source, binding, reviewOid) {
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
      successor.continuation?.review !== reviewOid
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

// One typed correction policy serves current candidate review and immutable
// historical baseline-source admission. Callers own checkout and file custody.
export function validateCorrectionReview({
  review,
  prMeta,
  findings,
  incoming,
  head,
  jsonOid,
  incomingCopyOid,
  forProof = false,
  source,
  workflowBinding,
  reviewOid,
}) {
  const violations = validateReviewArtifacts({
    review,
    prMeta,
  });
  if (violations.length) {
    throw new Error(violations.join("\n"));
  }
  if (review.correction?.incomingReviewJsonOid !== jsonOid || incomingCopyOid !== jsonOid) {
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
  const proof = forProof
    ? proofPublication(review, findings, head, source, workflowBinding, reviewOid)
    : null;
  return proof;
}

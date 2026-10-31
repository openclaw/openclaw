#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { execPlainGh } from "./lib/plain-gh.mjs";
import { isRecord } from "./lib/record-shared.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const CANONICAL_RELEASE_BRANCH =
  /^(?:release\/[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*|extended-stable\/[0-9]{4}\.[1-9][0-9]*\.33)$/u;
const PROVENANCE_KINDS = new Set([
  "main-ancestor",
  "release-branch",
  "release-tag",
  "frozen-release-branch-head",
]);

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function candidateCommitMetadata(targetSha, metadata) {
  requireValue(isRecord(metadata), `Candidate ${targetSha} signing metadata is missing`);
  const repository = metadata.data;
  const object =
    isRecord(repository) && isRecord(repository.repository)
      ? repository.repository.object
      : undefined;
  requireValue(
    isRecord(object) && object.oid === targetSha,
    `Candidate ${targetSha} signing metadata does not match the requested commit`,
  );
  const associatedPullRequests = isRecord(object.associatedPullRequests)
    ? object.associatedPullRequests.nodes
    : undefined;
  requireValue(
    Array.isArray(associatedPullRequests),
    `Candidate ${targetSha} merged pull request metadata is missing`,
  );
  return { object, associatedPullRequests };
}

function validateCandidateSigningProvenance(targetSha, metadata) {
  const { object, associatedPullRequests } = candidateCommitMetadata(targetSha, metadata);
  const signature = object.signature;
  const signer =
    isRecord(signature) && isRecord(signature.signer) ? signature.signer.login : undefined;
  requireValue(
    signature !== null,
    `Release candidate ${targetSha} requires a valid maintainer signature`,
  );
  requireValue(
    isRecord(signature) &&
      signature.isValid === true &&
      signature.state === "VALID" &&
      typeof signer === "string" &&
      signer.length > 0,
    `Release candidate ${targetSha} has an invalid commit signature`,
  );
  return {
    signer,
    associatedPullRequests,
  };
}

function validateCandidateActorPermission(actor, permission) {
  requireValue(
    isRecord(permission) &&
      (permission.permission === "admin" || permission.role_name === "maintain"),
    `Release candidate actor ${actor} lacks maintain/admin access`,
  );
  return actor;
}

function verifyCandidateProvenance({
  repository,
  targetSha,
  provenanceKind,
  metadata,
  resolvePermission,
}) {
  const { associatedPullRequests } = candidateCommitMetadata(targetSha, metadata);
  requireValue(
    !associatedPullRequests.some(
      (pullRequest) =>
        isRecord(pullRequest) &&
        pullRequest.state === "OPEN" &&
        pullRequest.headRefOid === targetSha &&
        isRecord(pullRequest.headRepository) &&
        pullRequest.headRepository.nameWithOwner === repository,
    ),
    `Release candidate ${targetSha} is an open same-repository PR head`,
  );
  if (provenanceKind === "main-ancestor") {
    return undefined;
  }
  const provenance = validateCandidateSigningProvenance(targetSha, metadata);
  if (provenance.signer === "web-flow") {
    const exactReleaseMerges = provenance.associatedPullRequests.filter(
      (pullRequest) =>
        isRecord(pullRequest) &&
        pullRequest.state === "MERGED" &&
        typeof pullRequest.baseRefName === "string" &&
        CANONICAL_RELEASE_BRANCH.test(pullRequest.baseRefName) &&
        isRecord(pullRequest.baseRepository) &&
        pullRequest.baseRepository.nameWithOwner === repository &&
        isRecord(pullRequest.mergeCommit) &&
        pullRequest.mergeCommit.oid === targetSha,
    );
    requireValue(
      exactReleaseMerges.length === 1,
      `GitHub web-flow candidate ${targetSha} requires one exact merge into a canonical release branch`,
    );
    return provenance.signer;
  }
  return validateCandidateActorPermission(provenance.signer, resolvePermission(provenance.signer));
}

function repositoryParts(repository) {
  requireValue(REPOSITORY.test(repository), "--repository must be owner/name");
  return repository.split("/");
}

export function verifyCandidateProvenanceWithGithub({
  repository,
  targetSha,
  provenanceKind,
  request,
}) {
  const [owner, name] = repositoryParts(repository);
  const metadata = request([
    "api",
    "graphql",
    "-H",
    "Cache-Control: max-age=0",
    "-f",
    "query=query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{oid signature{isValid state signer{login}} associatedPullRequests(first:100){nodes{state headRefOid headRepository{nameWithOwner} baseRefName baseRepository{nameWithOwner} mergeCommit{oid}}}}}}}",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `oid=${targetSha}`,
  ]);
  return verifyCandidateProvenance({
    repository,
    targetSha,
    provenanceKind,
    metadata,
    resolvePermission: (actor) =>
      request([
        "api",
        "-H",
        "Cache-Control: max-age=0",
        `repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
      ]),
  });
}

export function validateCandidateActorPermissionWithGithub({ repository, actor, request }) {
  repositoryParts(repository);
  return validateCandidateActorPermission(
    actor,
    request([
      "api",
      "-H",
      "Cache-Control: max-age=0",
      `repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
    ]),
  );
}

function gh(args) {
  return JSON.parse(execPlainGh([...args, "--hostname", "github.com"], { encoding: "utf8" }));
}

function option(args, name) {
  const index = args.indexOf(name);
  requireValue(index >= 0 && typeof args[index + 1] === "string", `${name} is required`);
  return args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const repository = option(args, "--repository");
  const targetSha = option(args, "--sha");
  const provenanceKind = option(args, "--provenance-kind");
  requireValue(SHA.test(targetSha), "--sha must be a lowercase 40-character SHA");
  requireValue(PROVENANCE_KINDS.has(provenanceKind), "--provenance-kind is unsupported");
  const actor = verifyCandidateProvenanceWithGithub({
    repository,
    targetSha,
    provenanceKind,
    request: gh,
  });
  console.log(
    `Release candidate provenance verified for ${targetSha}${actor ? ` (${actor})` : ""}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

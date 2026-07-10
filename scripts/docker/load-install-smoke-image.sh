#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${1:?artifact directory is required}"
target_sha="${2:?target SHA is required}"
image_ref="${3:?image ref is required}"
archive_name="${4:?archive name is required}"

evidence_path="${artifact_dir}/install-smoke-root-image-evidence.json"
archive_path="${artifact_dir}/${archive_name}"

mapfile -t evidence < <(
  node - "$evidence_path" "$target_sha" "$image_ref" "$archive_name" <<'NODE'
const fs = require("node:fs");

const [path, targetSha, imageRef, archiveName] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`invalid install-smoke image evidence: ${message}`);
};

if (value.schema !== "openclaw.install-smoke-root-image-evidence/v1") fail("schema");
if (value.schemaVersion !== 1) fail("schemaVersion");
if (value.workflowPath !== ".github/workflows/install-smoke.yml") fail("workflow path");
if (value.workflowSha !== process.env.WORKFLOW_SHA) fail("workflow SHA");
if (value.rootImageTransport !== "artifact") fail("root image transport");
if (value.targetSha !== targetSha) fail("targetSha");
if (!/^[a-f0-9]{40}$/.test(value.buildContext?.gitTreeSha ?? "")) fail("context tree SHA");
if (value.buildContext?.path !== ".") fail("context path");
if (!/^[a-f0-9]{40}$/.test(value.dockerfile?.gitBlobSha ?? "")) fail("Dockerfile blob SHA");
if (!/^[a-f0-9]{64}$/.test(value.dockerfile?.sha256 ?? "")) fail("Dockerfile sha256");
if (value.dockerfile?.path !== "Dockerfile") fail("Dockerfile path");
if (value.imageRef !== imageRef || value.imageTag !== targetSha) fail("image identity");
if (value.conclusion !== "success") fail("conclusion");
if (value.runId !== Number(process.env.GITHUB_RUN_ID)) fail("runId");
if (value.runAttempt !== Number(process.env.GITHUB_RUN_ATTEMPT)) fail("runAttempt");
if (value.runAttempt !== 1) fail("runAttempt must be 1");
if (value.archive?.filename !== archiveName) fail("archive filename");
if (!/^[a-f0-9]{64}$/.test(value.archive?.sha256 ?? "")) fail("archive sha256");
if (!Number.isSafeInteger(value.archive?.sizeBytes) || value.archive.sizeBytes <= 0) {
  fail("archive size");
}
if (!/^sha256:[a-f0-9]{64}$/.test(value.imageConfigDigest ?? "")) {
  fail("image config digest");
}
if (!/^sha256:[a-f0-9]{64}$/.test(value.containerImageDigest ?? "")) {
  fail("container image digest");
}
if (!/^[a-f0-9]{64}$/.test(value.buildMetadataSha256 ?? "")) {
  fail("build metadata sha256");
}
if (value.dockerImageId !== value.imageConfigDigest) fail("docker image id");
if (value.archive?.format !== "docker-tar+zstd") fail("archive format");

process.stdout.write(
  `${value.archive.sha256}\n${value.archive.sizeBytes}\n${value.imageConfigDigest}\n`,
);
NODE
)

[ "${#evidence[@]}" -eq 3 ]
[ "$(sha256sum "$archive_path" | awk '{print $1}')" = "${evidence[0]}" ]
[ "$(wc -c < "$archive_path" | tr -d '[:space:]')" = "${evidence[1]}" ]
zstd -t "$archive_path"
zstd -d --stdout "$archive_path" | docker image load
[ "$(docker image inspect --format '{{.Id}}' "$image_ref")" = "${evidence[2]}" ]

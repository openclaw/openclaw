#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?missing GH_TOKEN}"
: "${GITHUB_REPOSITORY:?missing GITHUB_REPOSITORY}"
: "${GITHUB_RUN_ID:?missing GITHUB_RUN_ID}"
: "${GITHUB_RUN_ATTEMPT:?missing GITHUB_RUN_ATTEMPT}"
: "${PACKAGE_ARTIFACT_ID:?missing PACKAGE_ARTIFACT_ID}"
: "${PACKAGE_ARTIFACT_NAME:?missing PACKAGE_ARTIFACT_NAME}"
: "${PACKAGE_ARTIFACT_DIGEST:?missing PACKAGE_ARTIFACT_DIGEST}"
: "${PACKAGE_SHA256:?missing PACKAGE_SHA256}"
: "${PACKAGE_VERSION:?missing PACKAGE_VERSION}"
: "${PACKAGE_AI_SHA256:?missing PACKAGE_AI_SHA256}"
: "${PACKAGE_AI_VERSION:?missing PACKAGE_AI_VERSION}"
: "${PACKAGE_SET_MANIFEST_SHA256:?missing PACKAGE_SET_MANIFEST_SHA256}"
: "${NPM_PREFLIGHT_RUN_ID:?missing NPM_PREFLIGHT_RUN_ID}"
: "${NPM_PREFLIGHT_ARTIFACT_ID:?missing NPM_PREFLIGHT_ARTIFACT_ID}"
: "${NPM_PREFLIGHT_ARTIFACT_NAME:?missing NPM_PREFLIGHT_ARTIFACT_NAME}"
: "${NPM_PREFLIGHT_ARTIFACT_DIGEST:?missing NPM_PREFLIGHT_ARTIFACT_DIGEST}"
: "${NPM_PREFLIGHT_MANIFEST_SHA256:?missing NPM_PREFLIGHT_MANIFEST_SHA256}"
: "${TARGET_SHA:?missing TARGET_SHA}"
: "${TRUSTED_WORKFLOW_SHA:?missing TRUSTED_WORKFLOW_SHA}"

[[ "$GITHUB_RUN_ATTEMPT" == "1" ]] || {
  echo "Exact package verification requires workflow run attempt 1." >&2
  exit 1
}

output_dir="${OPENCLAW_EXACT_PACKAGE_OUTPUT_DIR:-.artifacts/docker-e2e-package}"
github_output="${GITHUB_OUTPUT:-/dev/null}"
archive="${RUNNER_TEMP:-/tmp}/openwebui-package-${PACKAGE_ARTIFACT_ID}.zip"

artifact_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${PACKAGE_ARTIFACT_ID}")"
jq -e \
  --argjson artifact_id "$PACKAGE_ARTIFACT_ID" \
  --argjson run_id "$GITHUB_RUN_ID" \
  --arg digest "$PACKAGE_ARTIFACT_DIGEST" \
  --arg name "$PACKAGE_ARTIFACT_NAME" \
  --arg trusted_workflow_sha "$TRUSTED_WORKFLOW_SHA" \
  '
    .id == $artifact_id and
    .name == $name and
    .expired == false and
    .digest == $digest and
    .workflow_run.id == $run_id and
    .workflow_run.head_sha == $trusted_workflow_sha
  ' <<<"$artifact_json" >/dev/null || {
  echo "Exact package artifact identity, digest, name, or run differs." >&2
  exit 1
}

gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${PACKAGE_ARTIFACT_ID}/zip" >"$archive"
[[ "sha256:$(sha256sum "$archive" | awk '{print $1}')" == "$PACKAGE_ARTIFACT_DIGEST" ]] || {
  echo "Exact package artifact ZIP digest mismatch." >&2
  exit 1
}

mapfile -t entries < <(unzip -Z1 "$archive")
for expected in \
  openclaw-current.tgz \
  openclaw-ai-current.tgz \
  package-candidate.json \
  exact-package-set.json; do
  count=0
  for entry in "${entries[@]}"; do
    [[ "$entry" == "$expected" ]] && count=$((count + 1))
  done
  [[ "$count" == "1" ]] || {
    echo "Exact package artifact must contain one ${expected}; found ${count}." >&2
    exit 1
  }
done
[[ "${#entries[@]}" == "4" ]] || {
  echo "Exact package artifact must contain only the four normalized package-set files." >&2
  exit 1
}

rm -rf "$output_dir"
mkdir -p "$output_dir"
for entry in "${entries[@]}"; do
  unzip -p "$archive" "$entry" >"$output_dir/$entry"
done

root_tgz="$output_dir/openclaw-current.tgz"
ai_tgz="$output_dir/openclaw-ai-current.tgz"
package_set="$output_dir/exact-package-set.json"
root_entry_sha256="$(tar -xOf "$root_tgz" package/dist/index.js | sha256sum | awk '{print $1}')"
ai_runtime_sha256="$(
  tar -xOf "$ai_tgz" package/dist/internal/runtime.mjs |
    sha256sum |
    awk '{print $1}'
)"
[[ "$(sha256sum "$root_tgz" | awk '{print $1}')" == "$PACKAGE_SHA256" ]] || {
  echo "Exact package root tarball digest mismatch." >&2
  exit 1
}
[[ "$(sha256sum "$ai_tgz" | awk '{print $1}')" == "$PACKAGE_AI_SHA256" ]] || {
  echo "Exact package @openclaw/ai tarball digest mismatch." >&2
  exit 1
}
[[ "$(sha256sum "$package_set" | awk '{print $1}')" == "$PACKAGE_SET_MANIFEST_SHA256" ]] || {
  echo "Exact package-set manifest digest mismatch." >&2
  exit 1
}

jq -e \
  --arg targetSha "$TARGET_SHA" \
  --arg trustedWorkflowSha "$TRUSTED_WORKFLOW_SHA" \
  --argjson trustedWorkflowRunId "$GITHUB_RUN_ID" \
  --argjson npmPreflightRunId "$NPM_PREFLIGHT_RUN_ID" \
  --argjson npmPreflightArtifactId "$NPM_PREFLIGHT_ARTIFACT_ID" \
  --arg npmPreflightArtifactName "$NPM_PREFLIGHT_ARTIFACT_NAME" \
  --arg npmPreflightArtifactDigest "$NPM_PREFLIGHT_ARTIFACT_DIGEST" \
  --arg npmPreflightManifestSha256 "$NPM_PREFLIGHT_MANIFEST_SHA256" \
  --arg rootVersion "$PACKAGE_VERSION" \
  --arg rootSha256 "$PACKAGE_SHA256" \
  --arg aiVersion "$PACKAGE_AI_VERSION" \
  --arg aiSha256 "$PACKAGE_AI_SHA256" \
  '
    .schema == "openclaw.openwebui-package-set/v1" and
    .targetSha == $targetSha and
    .trustedWorkflow.path == ".github/workflows/package-acceptance.yml" and
    .trustedWorkflow.sha == $trustedWorkflowSha and
    .trustedWorkflow.runId == $trustedWorkflowRunId and
    .trustedWorkflow.runAttempt == 1 and
    .npmPreflightArtifact.runId == $npmPreflightRunId and
    .npmPreflightArtifact.id == $npmPreflightArtifactId and
    .npmPreflightArtifact.name == $npmPreflightArtifactName and
    .npmPreflightArtifact.digest == $npmPreflightArtifactDigest and
    .npmPreflightArtifact.manifestSha256 == $npmPreflightManifestSha256 and
    .root == {
      file: "openclaw-current.tgz",
      name: "openclaw",
      version: $rootVersion,
      sha256: $rootSha256
    } and
    .ai == {
      file: "openclaw-ai-current.tgz",
      name: "@openclaw/ai",
      version: $aiVersion,
      sha256: $aiSha256
    }
  ' "$package_set" >/dev/null || {
  echo "Exact package-set manifest does not bind the requested source and package identities." >&2
  exit 1
}

jq -e \
  --arg targetSha "$TARGET_SHA" \
  --arg rootVersion "$PACKAGE_VERSION" \
  --arg rootSha256 "$PACKAGE_SHA256" \
  '
    .name == "openclaw" and
    .packageSourceSha == $targetSha and
    .version == $rootVersion and
    .sha256 == $rootSha256
  ' "$output_dir/package-candidate.json" >/dev/null || {
  echo "Package candidate metadata does not bind the exact root tarball." >&2
  exit 1
}

node - "$root_tgz" "$ai_tgz" "$PACKAGE_VERSION" <<'NODE'
const childProcess = require("node:child_process");
const [rootTarball, aiTarball, expectedVersion] = process.argv.slice(2);
const readPackage = (tarball) =>
  JSON.parse(
    childProcess.execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
const root = readPackage(rootTarball);
const ai = readPackage(aiTarball);
if (root.name !== "openclaw" || root.version !== expectedVersion) {
  throw new Error("root package identity differs");
}
if (ai.name !== "@openclaw/ai" || ai.version !== expectedVersion) {
  throw new Error("@openclaw/ai package identity differs");
}
for (const [tarball, entry] of [
  [rootTarball, "package/dist/index.js"],
  [aiTarball, "package/dist/internal/runtime.mjs"],
]) {
  childProcess.execFileSync("tar", ["-xOf", tarball, entry], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}
NODE

[[ "$(git -C .release-harness rev-parse HEAD)" == "$TRUSTED_WORKFLOW_SHA" ]] || {
  echo "Trusted release harness checkout differs from the package-set workflow SHA." >&2
  exit 1
}

{
  echo "ai_runtime_sha256=$ai_runtime_sha256"
  echo "ai_sha256=$PACKAGE_AI_SHA256"
  echo "ai_version=$PACKAGE_AI_VERSION"
  echo "package_set_sha256=$PACKAGE_SET_MANIFEST_SHA256"
  echo "root_sha256=$PACKAGE_SHA256"
  echo "root_entry_sha256=$root_entry_sha256"
  echo "root_version=$PACKAGE_VERSION"
} >>"$github_output"

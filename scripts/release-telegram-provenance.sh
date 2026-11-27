#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

gh_with_retry() {
  local stdout stderr_file stderr_output output status attempt
  for attempt in 1 2 3 4 5; do
    stderr_file="$(mktemp)"
    set +e
    stdout="$(gh "$@" 2>"$stderr_file")"
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      if [[ -s "$stderr_file" ]]; then
        cat "$stderr_file" >&2
      fi
      rm -f "$stderr_file"
      printf '%s\n' "$stdout"
      return 0
    fi
    stderr_output="$(cat "$stderr_file")"
    rm -f "$stderr_file"
    output="$stdout"
    if [[ -n "$stderr_output" ]]; then
      output+="${output:+$'\n'}${stderr_output}"
    fi
    if [[ "$output" =~ $GH_TRANSIENT_SERVER_OR_NETWORK_PATTERN ]]; then
      echo "::warning::Transient GitHub response from gh $* on attempt ${attempt}; retrying." >&2
      sleep $((attempt * 3))
      continue
    fi
    printf '%s\n' "$output" >&2
    return "$status"
  done
  printf '%s\n' "$output" >&2
  return "$status"
}

candidate_root="${CANDIDATE_ROOT:?}"
candidate_git_dir="${CANDIDATE_GIT_DIR:-}"
remote_git_dir="${candidate_git_dir:-.}"
candidate_sha="$TARGET_SHA"
if [[ -n "$candidate_git_dir" ]]; then
  [[ "$(git -C "$candidate_git_dir" rev-parse HEAD)" == "$candidate_sha" ]]
fi

normalized_context_ref="${TARGET_CONTEXT_REF:-}"
normalized_context_ref="${normalized_context_ref#refs/heads/}"
normalized_context_ref="${normalized_context_ref#refs/tags/}"
context_release_branch=""
context_release_tag=""
frozen_release_branch_pattern=""
if [[ "$normalized_context_ref" =~ ^release/([0-9]{4}\.[0-9]+\.[0-9]+)$ ]]; then
  release_version="${BASH_REMATCH[1]}"
  release_version_pattern="${release_version//./\.}"
  candidate_version="$(jq -er '.version' "${candidate_root}/package.json")"
  if [[ "$candidate_version" == "$release_version" ]]; then
    context_release_branch="$normalized_context_ref"
  elif [[ "$candidate_version" =~ ^${release_version_pattern}-beta\.[0-9]+$ ]]; then
    context_release_branch="$normalized_context_ref"
    candidate_version_pattern="${candidate_version//./\.}"
    frozen_release_branch_pattern="^release/${candidate_version_pattern}-code-frozen(-r[1-9][0-9]*)?$"
  else
    echo "Telegram candidate version ${candidate_version} does not belong to release ${release_version}." >&2
    exit 1
  fi
elif [[ "$normalized_context_ref" =~ ^extended-stable/([0-9]{4}\.([1-9]|1[0-2])\.33)$ ]]; then
  context_version="${BASH_REMATCH[1]}"
  context_line="${context_version%.33}"
  candidate_version="$(jq -er '.version' "${candidate_root}/package.json")"
  if [[ ! "$candidate_version" =~ ^([0-9]{4}\.([1-9]|1[0-2]))\.([1-9][0-9]*)$ ]] ||
     [[ "${BASH_REMATCH[1]}" != "$context_line" ]] ||
     (( 10#${BASH_REMATCH[3]} < 33 )); then
    echo "Telegram candidate version ${candidate_version} does not belong to context ${normalized_context_ref}; expected a final ${context_line}.PATCH version with PATCH >= 33." >&2
    exit 1
  fi
  context_release_branch="$normalized_context_ref"
elif [[ "$normalized_context_ref" =~ ^v([0-9]{4}\.[0-9]+\.[0-9]+(-(alpha|beta)\.[0-9]+)?)$ ]]; then
  context_version="${BASH_REMATCH[1]}"
  candidate_version="$(jq -er '.version' "${candidate_root}/package.json")"
  if [[ "$candidate_version" != "$context_version" ]]; then
    echo "Telegram candidate version ${candidate_version} does not match context ${normalized_context_ref}." >&2
    exit 1
  fi
  context_release_tag="$normalized_context_ref"
fi

compare_status="$(
  gh_with_retry api \
    "repos/${GITHUB_REPOSITORY}/compare/${candidate_sha}...main" \
    --jq '.status'
)"
trusted_reason=""
trusted_release_branch=""
release_ref="${context_release_branch:-$context_release_tag}"
relationship=exact
if [[ -n "$release_ref" ]]; then
  if [[ "$TARGET_REF" =~ ^[a-f0-9]{40}$ && "$TARGET_REF" == "$candidate_sha" ]]; then
    relationship=ancestor
  fi
elif [[ "$compare_status" == "ahead" || "$compare_status" == "identical" ]]; then
  trusted_reason="main-ancestor"
else
  release_ref="${TARGET_REF#refs/heads/}"
  release_ref="${release_ref#refs/tags/}"
  if [[ "$TARGET_REF" =~ ^[a-f0-9]{40}$ && "$TARGET_REF" == "$candidate_sha" ]]; then
    release_ref="$(
      gh_with_retry api --paginate \
        "repos/${GITHUB_REPOSITORY}/commits/${candidate_sha}/branches-where-head" \
        --jq '.[].name' |
        awk '$0 ~ /^release\/[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*$/ ||
             $0 ~ /^extended-stable\/[0-9]{4}\.[1-9][0-9]*\.33$/ { refs[++n] = $0 }
             END { if (n == 1) print refs[1] }'
    )"
    if [[ -z "$release_ref" ]]; then
      release_ref="$(
        git -C "$remote_git_dir" ls-remote origin 'refs/tags/v*' |
          awk -v sha="$candidate_sha" '$1 == sha { sub(/\^\{\}$/, "", $2); print $2 }' |
          sort -u | head -n 1
      )"
      release_ref="${release_ref#refs/tags/}"
    fi
  fi
fi

fetch_ref=""
if [[ "$release_ref" =~ ^(release/[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*|extended-stable/[0-9]{4}\.[1-9][0-9]*\.33)$ ]]; then
  fetch_ref="refs/heads/${release_ref}"
  reason=release-branch
elif [[ "$release_ref" == v* ]]; then
  fetch_ref="refs/tags/${release_ref}"
  reason=release-tag
fi
if [[ -n "$fetch_ref" ]] && bash "${GITHUB_WORKSPACE}/scripts/release-context-contains.sh" \
  "https://github.com/${GITHUB_REPOSITORY}.git" "$fetch_ref" "$candidate_sha" "$relationship" 2>/dev/null; then
  trusted_reason="$reason"
  trusted_release_branch="$release_ref"
fi

if [[ -z "$trusted_reason" && -n "$frozen_release_branch_pattern" &&
      "$TARGET_REF" =~ ^[a-f0-9]{40}$ && "$TARGET_REF" == "$candidate_sha" ]]; then
  matching_frozen_release_branches="$(
    gh_with_retry api --paginate \
      "repos/${GITHUB_REPOSITORY}/commits/${candidate_sha}/branches-where-head" \
      --jq '.[].name' |
      awk -v frozen="$frozen_release_branch_pattern" '$0 ~ frozen { print }'
  )"
  if [[ "$(wc -l <<<"$matching_frozen_release_branches" | tr -d ' ')" == "1" &&
        -n "$matching_frozen_release_branches" ]]; then
    trusted_reason="frozen-release-branch-head"
    trusted_release_branch="$matching_frozen_release_branches"
  fi
fi

if [[ -z "$trusted_reason" ]]; then
  echo "Telegram candidate ${candidate_sha} is not trusted release provenance." >&2
  exit 1
fi

node "${GITHUB_WORKSPACE}/scripts/release-candidate-provenance.mjs" \
  --repository "$GITHUB_REPOSITORY" \
  --sha "$candidate_sha" \
  --provenance-kind "$trusted_reason"

echo "Telegram candidate trust reason: ${trusted_reason}"

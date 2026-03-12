#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OWNERSHIP_FILE_DEFAULT="${SCRIPT_DIR}/repo-ownership.json"

usage() {
  cat <<'EOF'
Usage:
  change-plan-check.sh --plan <file> [--ownership-file <file>]

Validates and normalizes a change plan.
Prints normalized JSON to stdout on success.
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

for cmd in jq sed awk; do
  require_cmd "$cmd"
done

PLAN_FILE=""
OWNERSHIP_FILE="$OWNERSHIP_FILE_DEFAULT"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --plan)
      PLAN_FILE="${2:-}"
      shift 2
      ;;
    --ownership-file)
      OWNERSHIP_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
done

[[ -n "$PLAN_FILE" && -f "$PLAN_FILE" ]] || {
  printf '--plan file required\n' >&2
  exit 1
}
[[ -f "$OWNERSHIP_FILE" ]] || {
  printf 'ownership file not found: %s\n' "$OWNERSHIP_FILE" >&2
  exit 1
}

jq -n \
  --slurpfile plan "$PLAN_FILE" \
  --slurpfile ownership "$OWNERSHIP_FILE" '
  def err($msg): error($msg);
  def nonempty_string($value; $label):
    ($value // "" | tostring | gsub("^\\s+|\\s+$"; "")) as $trimmed
    | if $trimmed == "" then err($label + " required") else $trimmed end;
  def optional_string($value):
    ($value // "" | tostring | gsub("^\\s+|\\s+$"; "")) as $trimmed
    | if $trimmed == "" then null else $trimmed end;
  def string_array($value; $label):
    (($value // []) | if type == "array" then . else [.] end
      | map(select(type == "string") | gsub("^\\s+|\\s+$"; "") | select(length > 0))) as $items
    | if ($items | length) == 0 then err($label + " required") else $items end;
  def optional_string_array($value):
    (($value // []) | if type == "array" then . else [.] end
      | map(select(type == "string") | gsub("^\\s+|\\s+$"; "") | select(length > 0)));
  def validation_commands_for($owned; $repo):
    optional_string(($repo.validation_profile // $repo.validationProfile)) as $profile
    | if $profile != null and (($owned.validationProfiles // {})[$profile] | type) == "array" and ((($owned.validationProfiles // {})[$profile]) | length) > 0 then
        string_array((($owned.validationProfiles // {})[$profile]); "expected_validations")
      else
        string_array($owned.validationCommands; "expected_validations")
      end;
  def relative_files($value):
    string_array($value; "repo files")
    | if any(.[]; startswith("/") or contains("..")) then
        err("repo files must be relative paths inside owned roots")
      else
        .
      end;
  def ownership_for($repo_id):
    (($ownership[0].repos // []) | map(select(.repoId == $repo_id)) | .[0]) as $repo
    | if $repo == null then err("repo not in ownership map: " + $repo_id) else $repo end;
  def normalize_repo($repo):
    nonempty_string(($repo.repo_id // $repo.repoId); "repo_id") as $repo_id
    | ownership_for($repo_id) as $owned
    | if ($repo | has("expected_validations") or has("validation_commands")) then
        err("repo validation commands must come from ownership map: " + $repo_id)
      else
        {
        repo_id: $repo_id,
        repo_slug: nonempty_string($owned.githubRepo; "repo_slug"),
        local_path: nonempty_string($owned.localPath; "local_path"),
        base_sha: optional_string($repo.base_sha // $repo.baseSha),
        change_type: optional_string($repo.change_type // $repo.changeType),
        validation_profile: optional_string($repo.validation_profile // $repo.validationProfile),
        impacted_apps: optional_string_array($repo.impacted_apps // $repo.impactedApps),
        rationale: nonempty_string(($repo.rationale // $repo.summary); "rationale"),
        files: relative_files($repo.files),
        expected_validations:
          validation_commands_for($owned; $repo),
        rollback:
          string_array(($repo.rollback // $owned.rollbackHints); "rollback"),
        pr: {
          title: nonempty_string(($repo.pr.title // $repo.pr_metadata.title); "pr.title"),
          commit: nonempty_string(($repo.pr.commit // $repo.pr_metadata.commit // $repo.summary); "pr.commit"),
          body: optional_string($repo.pr.body // $repo.pr_metadata.body),
          body_file: optional_string($repo.pr.body_file // $repo.pr_metadata.body_file),
          base: nonempty_string(($repo.pr.base // $repo.pr_metadata.base // "main"); "pr.base"),
          branch: optional_string($repo.pr.branch // $repo.pr_metadata.branch),
          draft: (($repo.pr.draft // $repo.pr_metadata.draft) == true)
        },
        depends_on_repos:
          optional_string_array($repo.depends_on_repos // $repo.dependsOnRepos // $repo.dependsOn),
        ownership: {
          owned_globs: ($owned.ownedGlobs // []),
          source_of_truth_domains: ($owned.sourceOfTruthDomains // [])
        }
      }
      end;
  ($plan[0]) as $root
  | if ($root.version // "") != "sre.change-plan.v1" then
      err("unsupported change plan version: " + (($root.version // "missing") | tostring))
    else
      .
    end
  | {
      version: "sre.change-plan.v1",
      incident_id: nonempty_string(($root.incident_id // $root.incidentId); "incident_id"),
      request_id: optional_string($root.request_id // $root.requestId),
      root_cause_summary:
        nonempty_string(($root.root_cause_summary // $root.summary // $root.rootCauseSummary); "root_cause_summary"),
      repos:
        ((if (($root.repos // []) | type) == "array" and (($root.repos // []) | length) > 0
          then $root.repos
          elif (($root.steps // []) | type) == "array" and (($root.steps // []) | length) > 0
          then $root.steps
          else err("repos or steps required")
          end) | map(normalize_repo(.)))
    }
  | . as $normalized
  | ($normalized.repos | map(.repo_id)) as $repo_ids
  | if ($repo_ids | unique | length) != ($repo_ids | length) then
      err("duplicate repo_id in change plan")
    else
      .
    end
  | if ([
      $normalized.repos[] as $repo
      | ($repo.depends_on_repos[]? // empty)
      | select(($repo_ids | index(.)) == null or . == $repo.repo_id)
    ] | length) > 0 then
      err("depends_on_repos must reference other repos present in the plan")
    else
      $normalized
    end
' 

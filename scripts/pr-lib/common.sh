# shellcheck source=scripts/pr-lib/github.sh
source "$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)/github.sh" || return 1

# shellcheck source=scripts/pr-lib/host-tools.sh
source "${BASH_SOURCE[0]%/*}/host-tools.sh" || return 1

# Load receipt helpers for the invocation before cleanup can delete this module's worktree.
# shellcheck source=scripts/pr-lib/merge-outcome.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/merge-outcome.sh" || return 1

require_artifact() {
  local path="$1"
  if [ ! -s "$path" ]; then
    echo "Missing required artifact: $path"
    exit 1
  fi
}

validate_pr_temp_storage() {
  local temp_dir="${TMPDIR:-/tmp}"
  local probe=""
  if ! probe=$(mktemp "${temp_dir%/}/openclaw-pr.XXXXXX"); then
    :
  elif ! printf 'openclaw-pr-temp-probe\n' >"$probe"; then
    rm -f "$probe" 2>/dev/null || true
  elif rm -f "$probe"; then
    return 0
  fi

  echo "scripts/pr temporary-storage preflight failed under TMPDIR=$temp_dir." >&2
  echo "Free disk space or set TMPDIR to a writable filesystem, then retry." >&2
  return 1
}

path_is_docsish() {
  local path="$1"
  case "$path" in
    CHANGELOG.md|AGENTS.md|CLAUDE.md|README*.md|docs/*|*.md|*.mdx|docs.json)
      return 0
      ;;
  esac
  return 1
}

file_list_is_docsish_only() {
  local files="$1"
  local saw_any=false
  local path
  while [ -n "$files" ]; do
    path="${files%%$'\n'*}"
    if [ "$path" = "$files" ]; then
      files=""
    else
      files="${files#*$'\n'}"
    fi
    [ -n "$path" ] || continue
    saw_any=true
    if ! path_is_docsish "$path"; then
      return 1
    fi
  done

  [ "$saw_any" = "true" ]
}

changelog_required_for_changed_files() {
  # Changelog artifacts are release-owned. Normal PRs carry release-note
  # context in PR bodies and commit messages.
  return 1
}

release_changelog_file_list_mode() {
  local helper_root
  helper_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd) || return 1
  node --input-type=module - "$helper_root" "$1" <<'EOF_NODE'
import { pathToFileURL } from "node:url";
const [root, files] = process.argv.slice(2);
const { isReleaseChangelogPath } = await import(pathToFileURL(`${root}/scripts/lib/release-changelog.mjs`));
const paths = files.split("\n").filter(Boolean);
const count = paths.filter((file) => isReleaseChangelogPath(file)).length;
console.log(count === 0 ? "none" : count === paths.length ? "only" : "mixed");
EOF_NODE
}

root_changelog_update_allowed_for_pr() {
  case "${OPENCLAW_ALLOW_ROOT_CHANGELOG_PR:-}" in
    1|true|TRUE|yes|YES|on|ON)
      printf 'override\n'
      return 0
      ;;
  esac
  local record="${1:-}" branch version helper_root
  branch=$(printf '%s\n' "$record" | jq -r '.headRefName // ""') || return 1
  [[ "$branch" =~ ^release/([0-9]{4}\.[0-9]+\.[0-9]+(-[0-9]+)?)-main-closeout$ ]] || return 1
  version="${BASH_REMATCH[1]}"
  printf '%s\n' "$record" | jq -e --arg title "chore(release): close out $version on main" \
    '.title == $title and .baseRefName == "main" and .isCrossRepository == false' >/dev/null || return 1
  pr_git ls-remote --exit-code --tags origin "refs/tags/v$version" >/dev/null 2>&1 || return 1
  helper_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd) || return 1
  # Compare complete sections, not just added lines: a closeout must preserve
  # every byte outside its released version, including removed historical text.
  node --input-type=module - "$version" "$PR_MAIN_SHA" "$helper_root" <<'EOF_NODE' || return 1
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const [version, base, root] = process.argv.slice(2);
const { loadReleaseChangelog, checkChangelogLayout, changelogEntryPath, isReleaseChangelogPath } =
  await import(pathToFileURL(`${root}/scripts/lib/release-changelog.mjs`));
const git = (...args) => execFileSync(process.env.OPENCLAW_PR_GIT || process.env.GIT_EXEC || "git", args, { encoding: "utf8", maxBuffer: Infinity });
const read = (ref) => git("show", `${ref}:CHANGELOG.md`);
const changed = git("diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--", "CHANGELOG.md", "CHANGELOG/").split("\0").filter(Boolean);
const release = loadReleaseChangelog({ rootDir: process.cwd(), ref: "HEAD", version });
if (release.layout === "split") {
  // The migration itself requires the existing explicit release override.
  checkChangelogLayout({ rootDir: process.cwd(), ref: base });
  checkChangelogLayout({ rootDir: process.cwd(), ref: "HEAD" });
  if (changed.some((file) => !isReleaseChangelogPath(file, { version }))) process.exit(1);
  const entry = changelogEntryPath(version);
  const indexLine = `- [${version}](${entry}) · [Raw](https://github.com/openclaw/openclaw/raw/refs/heads/main/${entry})\n`;
  const outside = (text) => text.replace(indexLine, "");
  if (outside(read(base)) !== outside(read("HEAD"))) process.exit(1);
  process.exit(0);
}
// Historical refs and fixtures still contain monolithic release sections.
if (changed.some((file) => file !== "CHANGELOG.md")) process.exit(1);
const heading = `## ${version}\n`;
function split(text, allowUnreleased = false) {
  const parts = text.split(/(?=^## )/m);
  let matches = parts.filter((part) => part.startsWith(heading));
  if (!matches.length && allowUnreleased) {
    // Older draft headings can be placeholders; newer trains remain outside this closeout.
    matches = parts.filter((part) => {
      const draft = /^## (?:Unreleased|([0-9]{4}\.[0-9]+\.[0-9]+(?:-[0-9]+)?) \(Unreleased\))\n/i.exec(part);
      return draft && (!draft[1] || draft[1].localeCompare(version, "en", { numeric: true }) <= 0);
    });
  }
  if (matches.length > 1) process.exit(1);
  const index = parts.indexOf(matches[0]);
  return index < 0 ? { rest: text } : {
    prefix: parts.slice(0, index).join(""),
    suffix: parts.slice(index + 1).join(""),
  };
}
const before = split(read(base), true);
const after = split(read("HEAD"));
if (after.rest !== undefined || (before.rest !== undefined
  ? before.rest !== after.prefix + after.suffix
  : before.prefix !== after.prefix || before.suffix !== after.suffix)) process.exit(1);
EOF_NODE
  printf 'closeout\n'
}

print_review_stdout_summary() {
  require_artifact .local/review.json
  require_artifact .local/pr-meta.env

  # shellcheck disable=SC1091
  source .local/pr-meta.env

  local recommendation
  recommendation=$(jq -r '.recommendation // ""' .local/review.json)
  local finding_count
  finding_count=$(jq '[.findings[]?] | length' .local/review.json)

  echo "review summary:"
  echo "pr_url=${PR_URL:-}"
  echo "recommendation: $recommendation"
  echo "findings: $finding_count"
  node "$(review_artifacts_helper_path)" render .local/review.json
}

print_relevant_log_excerpt() {
  local log_file="$1"
  if [ ! -s "$log_file" ]; then
    echo "(no output captured)"
    return 0
  fi

  local filtered_log
  filtered_log=$(mktemp)
  if rg -n -i 'error|err|failed|fail|fatal|panic|exception|TypeError|ReferenceError|SyntaxError|ELIFECYCLE|ERR_' "$log_file" >"$filtered_log"; then
    echo "Relevant log lines:"
    tail -n 120 "$filtered_log"
  else
    echo "No focused error markers found; showing last 120 lines:"
    tail -n 120 "$log_file"
  fi
  rm -f "$filtered_log"
}

print_unrelated_gate_failure_guidance() {
  local label="$1"
  case "$label" in
    pnpm\ build*|pnpm\ check*|pnpm\ test*)
      cat <<'EOF_GUIDANCE'
If this local gate failure already reproduces on latest origin/main and is clearly unrelated to the PR:
- treat it as baseline repo noise
- document it explicitly
- report the scoped verification that validates the PR itself
- do not use this to ignore plausibly related failures
EOF_GUIDANCE
      ;;
  esac
}

run_quiet_logged() {
  local label="$1"
  local log_file="$2"
  shift 2

  mkdir -p .local
  if "$@" >"$log_file" 2>&1; then
    echo "$label passed"
    return 0
  fi

  echo "$label failed (log: $log_file)"
  print_relevant_log_excerpt "$log_file"
  print_unrelated_gate_failure_guidance "$label"
  return 1
}

bootstrap_deps_if_needed() {
  if [ ! -x node_modules/.bin/vitest ]; then
    run_quiet_logged "pnpm install --frozen-lockfile" ".local/bootstrap-install.log" pnpm install --frozen-lockfile
  fi
}

read_pr_view_json() {
  local pr="$1"
  local fields="$2"
  local max_attempts=3
  local temp_dir
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-pr-view.XXXXXX") || {
    echo "Unable to create temporary storage for GitHub PR metadata." >&2
    return 1
  }
  local stdout_file="$temp_dir/stdout"
  local stderr_file="$temp_dir/stderr"
  local attempt exit_code reason

  for attempt in $(seq 1 "$max_attempts"); do
    exit_code=0
    if pr_gh pr view "$pr" --json "$fields" >"$stdout_file" 2>"$stderr_file"; then
      if [ -s "$stdout_file" ] && jq -se 'length == 1 and (.[0] | type == "object")' "$stdout_file" >/dev/null 2>&1; then
        cat "$stdout_file"
        rm -rf "$temp_dir"
        return 0
      fi
      if [ ! -s "$stdout_file" ]; then
        reason="gh pr view returned empty stdout"
      else
        reason="gh pr view did not return one JSON object"
      fi
    else
      exit_code=$?
      reason="gh pr view exited with status $exit_code"
      if [ "$exit_code" -eq 65 ] || [ "$exit_code" -eq 75 ] || [ "$exit_code" -eq 77 ]; then
        cat "$stderr_file" >&2
        rm -rf "$temp_dir"
        return 1
      fi
    fi
    [ "$attempt" -eq "$max_attempts" ] || sleep "$attempt"
  done

  echo "GitHub API failure while reading PR #$pr: $reason after $max_attempts attempts." >&2
  [ ! -s "$stderr_file" ] || cat "$stderr_file" >&2
  rm -rf "$temp_dir"
  return 1
}

read_pr_observation() {
  read_pr_view_json "$1" "number,url,title,state,isDraft,author,baseRefName,baseRefOid,baseRepository,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository"
}

use_pr_observation() {
  local pr="$1" observation="$2" repository_url
  repository_url=$(printf '%s\n' "$observation" | jq -er --argjson pr "$pr" '
    .baseRepository as $repo |
    select(.number == $pr and
      ($repo.id | type == "string" and length > 0) and
      ($repo.databaseId | type == "number" and . > 0 and floor == .) and
      ($repo.nameWithOwner | type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
      ($repo.url | type == "string" and test("^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") and endswith("/" + $repo.nameWithOwner)) and
      .url == ($repo.url + "/pull/" + ($pr | tostring))) |
    $repo.url') || {
      echo "Invalid base repository identity for PR #$pr." >&2
      return 1
    }
  PR_OBSERVATION="$observation"
  PR_REPOSITORY_URL="$repository_url"
  PR_REPOSITORY_SELECTOR="${GH_REPO:-}"
  PR_REPOSITORY_HOST="${GH_HOST:-}"
}

pr_observe() {
  local observation
  observation=$(read_pr_observation "$1") || return 1
  use_pr_observation "$1" "$observation"
}

pr_view_string_field() {
  local json="$1" field="$2" pr="$3" remedy="${4:-Retry the command.}" label value
  case "$field" in
    headRefOid) label="a head SHA" ;;
    baseRefName) label="a base branch" ;;
    headRefName) label="a head branch" ;;
    *) label="a non-empty .$field string" ;;
  esac
  if ! value=$(printf '%s\n' "$json" | jq -er --arg field "$field" '.[$field] | if type == "string" and length > 0 then . else error("missing string field") end' 2>/dev/null); then
    echo "GitHub PR metadata for #$pr did not include $label. $remedy" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

wait_for_pr_head_sha() {
  local pr="$1"
  local expected_sha="$2"
  local max_attempts="${3:-6}"
  local sleep_seconds="${4:-2}"

  local attempt
  for attempt in $(seq 1 "$max_attempts"); do
    local observed_sha
    pr_observe "$pr" || return 1
    observed_sha=$(pr_view_string_field "$PR_OBSERVATION" headRefOid "$pr") || return 1
    if [ "$observed_sha" = "$expected_sha" ]; then
      return 0
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep "$sleep_seconds"
    fi
  done

  return 1
}

pr_contributor_allows_human_trailers() {
  local contrib="${1:-}"
  local normalized
  normalized=$(printf '%s' "$contrib" | tr '[:upper:]' '[:lower:]')

  case "$normalized" in
    ""|"null"|"app/"*|"codex"|"openclaw"|"clawsweeper"|"openclaw-clawsweeper"|"clawsweeper[bot]"|"openclaw-clawsweeper[bot]"|"steipete")
      return 1
      ;;
  esac

  return 0
}

resolve_contributor_coauthor_email() {
  local contrib="${1:-}"

  if ! pr_contributor_allows_human_trailers "$contrib"; then
    return 1
  fi

  local contrib_id
  contrib_id=$(pr_gh api "users/$contrib" --jq .id) || return 1
  printf '%s+%s@users.noreply.github.com\n' "$contrib_id" "$contrib"
}

common_repo_root() {
  if command -v repo_root >/dev/null 2>&1; then
    repo_root
    return
  fi

  local base_dir
  base_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  pr_git -C "$base_dir" rev-parse --show-toplevel
}

worktree_path_for_branch() (
  set -o pipefail
  local branch="$1"
  local ref="refs/heads/$branch"
  local field worktree="" match="" records=0 pipeline_status
  # Drain foreground Git before the supervisor checks for leftover children.
  pr_git worktree list --porcelain -z | {
    while IFS= read -r -d '' field; do
      case "$field" in
        worktree\ *) worktree="${field#worktree }"; records=$((records + 1)) ;;
        "branch $ref") match="$worktree" ;;
        "") worktree="" ;;
      esac
    done
    [ -z "$field" ] && [ -z "$worktree" ] && [ "$records" -gt 0 ] || return 1
    [ -z "$match" ] || printf '%s\n' "$match"
  } || {
    pipeline_status=("${PIPESTATUS[@]}")
    [ "${pipeline_status[0]}" -eq 0 ] || return "${pipeline_status[0]}"
    return "${pipeline_status[1]}"
  }
)

worktree_registration_state() (
  set -o pipefail
  local path="$1"
  local field found=0 records=0 open=false pipeline_status
  # Git must finish before a successful operation can release its lock.
  pr_git worktree list --porcelain -z | {
    while IFS= read -r -d '' field; do
      case "$field" in
        worktree\ *)
          records=$((records + 1)); open=true
          [ "${field#worktree }" != "$path" ] || found=$((found + 1))
          ;;
        "") open=false ;;
      esac
    done
    [ -z "$field" ] && [ "$open" = false ] && [ "$records" -gt 0 ] && [ "$found" -le 1 ] || return 1
    if [ "$found" -eq 1 ]; then printf 'registered\n'; else printf 'absent\n'; fi
  } || {
    pipeline_status=("${PIPESTATUS[@]}")
    [ "${pipeline_status[0]}" -eq 0 ] || return "${pipeline_status[0]}"
    return "${pipeline_status[1]}"
  }
)

resolve_existing_dir_path() {
  local path="$1"
  if [ ! -d "$path" ]; then
    return 1
  fi

  (
    cd "$path" >/dev/null 2>&1 &&
      pwd -P
  )
}

pr_worktree_state() {
  local root common_dir
  root=$(common_repo_root) || return $?
  common_dir=$(pr_git -C "$root" rev-parse --path-format=absolute --git-common-dir) || return $?
  # Git omits damaged admin entries from its listing. Bind the exact backlink
  # separately, and distinguish genuine absence from an unreadable path.
  node - "$root" "$common_dir" "$1" "${2:-}" "${3:-cleanup}" <<'EOF_NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, common, requested, previousAdmin, purpose] = process.argv.slice(2);
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function read(file) {
  if (!stat(file)?.isFile()) throw new Error("damaged worktree metadata");
  return fs.readFileSync(file, "utf8").trimEnd();
}
try {
  const canonicalParent = path.join(fs.realpathSync(root), ".worktrees");
  const parent = stat(canonicalParent) ? fs.realpathSync(canonicalParent) : canonicalParent;
  const input = path.resolve(requested);
  const inputParent = path.dirname(input);
  const resolvedParent = stat(inputParent) ? fs.realpathSync(inputParent) : inputParent;
  const leaf = path.basename(input);
  if (!/^pr-[1-9][0-9]*$/.test(leaf) || resolvedParent !== parent) {
    throw new Error("non-canonical PR-worktree path");
  }
  const target = path.join(parent, leaf);
  const targetStat = stat(target);
  if (targetStat && !targetStat.isDirectory()) throw new Error("non-canonical PR-worktree path");
  const commonDir = fs.realpathSync(common);
  const adminRoot = path.join(commonDir, "worktrees");
  const adminStat = stat(adminRoot);
  if (adminStat && !adminStat.isDirectory()) throw new Error("damaged worktree metadata");
  const matches = [];
  let ids;
  // Reusing a healthy worktree needs its own identity, not proof that unrelated
  // admin entries are readable. Destruction still requires the complete scan.
  if (purpose === "entry" && targetStat) {
    const gitfile = path.join(target, ".git");
    if (!stat(gitfile)?.isFile()) {
      throw new Error("unregistered or ambiguous PR worktree; scripts/pr refuses to mutate the shared canonical checkout");
    }
    const pointer = read(gitfile);
    if (!pointer.startsWith("gitdir: ")) throw new Error("damaged worktree metadata");
    const admin = path.resolve(target, pointer.slice(8));
    if (path.dirname(admin) !== adminRoot) throw new Error("damaged worktree metadata");
    ids = [path.basename(admin)];
  } else {
    ids = adminStat ? fs.readdirSync(adminRoot) : [];
  }
  // Git preserves admin IDs across moves. Only readable, valid backlinks can
  // attribute entries; an unknown backlink cannot establish target absence.
  for (const id of ids) {
    const admin = path.join(adminRoot, id);
    if (!stat(admin)?.isDirectory()) throw new Error("damaged worktree metadata");
    const backlink = read(path.join(admin, "gitdir"));
    if (!backlink.endsWith("/.git")) throw new Error("damaged worktree metadata");
    if (path.resolve(admin, backlink) !== path.join(target, ".git")) continue;
    if (path.resolve(admin, read(path.join(admin, "commondir"))) !== commonDir) {
      throw new Error("damaged worktree metadata");
    }
    matches.push(admin);
  }
  if (matches.length > 1 || (purpose === "entry" && targetStat && matches.length !== 1)) {
    throw new Error("ambiguous worktree metadata");
  }
  process.stdout.write(JSON.stringify({
    path: target, present: Boolean(targetStat), admin: matches[0] ?? "", common: commonDir,
    previousAdminPresent: previousAdmin ? Boolean(stat(previousAdmin)) : false,
  }) + "\n");
} catch (error) {
  console.error(`Refusing PR worktree cleanup: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
EOF_NODE
}

has_worktree_merge_output() {
  local path="$1" capture
  for capture in "$path/.local/merge-output.log" "$path"/.local/merge-output.*.log; do
    if [ -e "$capture" ] || [ -L "$capture" ]; then return 0; fi
  done
  return 1
}

require_worktree_cleanup_evidence() (
  local path="$1" pr
  has_worktree_merge_output "$path" || return 0
  # Keep loader state separate from an uninterrupted merge's live outcome owner.
  # Even an empty capture can be the only evidence of an earlier dispatch.
  if pr=$(pr_number_from_worktree_dir "$path") &&
    merge_outcome_load_local "$pr" && [ -n "$MERGE_OUTCOME_OID" ]; then
    return 0
  fi
  echo "Preserving $path: merge output has no valid retained merge outcome. Keep the worktree, metadata, and local branches; reconcile the earlier request manually before cleanup." >&2
  return 1
)

remove_worktree_if_present() {
  local path="$1" state registered_path registration admin dirty
  state=$(pr_worktree_state "$path") || return $?
  registered_path=$(printf '%s\n' "$state" | jq -r '.path') || return $?
  admin=$(printf '%s\n' "$state" | jq -r '.admin') || return $?
  registration=$(worktree_registration_state "$registered_path") || return $?
  require_worktree_cleanup_evidence "$path" || return $?
  if [ "$registration" = absent ] &&
    printf '%s\n' "$state" | jq -e '.present == false and .admin == ""' >/dev/null; then
    return 0
  fi
  if [ "$registration" != registered ] || [ -z "$admin" ]; then
    echo "Preserving $path: unregistered or ambiguous PR worktree; scripts/pr refuses to mutate the shared canonical checkout." >&2
    return 1
  fi
  if [ -d "$path" ]; then
    dirty=$(pr_git -C "$path" status --porcelain --untracked-files=all --ignore-submodules=none) || return $?
    if [ -n "$dirty" ] || [ -e "$admin/locked" ]; then
      echo "Preserving $path: worktree has local changes or is locked. Review its contents and ownership before cleanup." >&2
      return 1
    fi
  fi
  [ "${2:-false}" != true ] || return 0
  # One native removal owns both the path and its exact admin entry. A partial
  # deletion still fails; neither repository-wide prune nor orphan trash is safe.
  pr_git worktree remove -- "$registered_path" || return $?
  state=$(pr_worktree_state "$path" "$admin") || return $?
  registration=$(worktree_registration_state "$registered_path") || return $?
  if [ "$registration" != absent ] ||
    ! printf '%s\n' "$state" | jq -e --arg path "$registered_path" \
      '.path == $path and .present == false and .admin == "" and .previousAdminPresent == false' >/dev/null; then
    echo "Preserving cleanup state for $path: worktree removal is incomplete." >&2
    return 1
  fi
}

delete_local_branch_if_safe() {
  local branch="$1" retained="${2:-}"
  local ref="refs/heads/$branch"

  local existing status
  # for-each-ref can warn about a broken ref with status zero. Such a warning
  # is not proof of absence, so retain diagnostics in the validated result.
  existing=$(pr_git for-each-ref --format="%(if:equals=$ref)%(refname)%(then)%(refname)%(end)" -- "$ref" 2>&1) || {
    status=$?; printf '%s\n' "$existing" >&2; return "$status"
  }
  [ -n "$existing" ] || return 0
  [ "$existing" = "$ref" ] || { printf '%s\n' "$existing" >&2; return 1; }

  local branch_worktree=""
  branch_worktree=$(worktree_path_for_branch "$branch") || return $?
  if [ -n "$branch_worktree" ]; then
    echo "Skipping local branch delete for $branch; checked out in worktree $branch_worktree"
    return 1
  fi

  local config=()
  # A confirmed squash receipt retains the reviewed source as ancestry even
  # though main does not. Use it only for this command's non-force merge check.
  # Git still rejects advanced tips and branches checked out in another worktree.
  if [ -n "$retained" ]; then
    # merge is multi-valued: appending must not redirect an existing upstream.
    if pr_git config --get-all "branch.$branch.merge" >/dev/null; then
      :
    else
      status=$?
      [ "$status" -eq 1 ] || return "$status"
      config=(-c "branch.$branch.remote=." -c "branch.$branch.merge=$retained")
    fi
  fi
  pr_git ${config[@]+"${config[@]}"} branch -d -- "$branch" || return $?
  existing=$(pr_git for-each-ref --format="%(if:equals=$ref)%(refname)%(then)%(refname)%(end)" -- "$ref" 2>&1) || {
    status=$?; printf '%s\n' "$existing" >&2; return "$status"
  }
  [ -z "$existing" ] || { printf 'Branch cleanup incomplete: %s\n' "$existing" >&2; return 1; }
}

cleanup_pr_worktree() {
  local path="$1" pr branch retained=""
  # Preserve the uninterrupted merge's live receipt while validating cleanup proof.
  local MERGE_OUTCOME_REF="" MERGE_OUTCOME_OID="" MERGE_OUTCOME_RECORD=""
  pr=$(pr_number_from_worktree_dir "$path") || return 1
  merge_outcome_load_local "$pr" || return 1
  if [ -n "$MERGE_OUTCOME_OID" ] &&
    printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e '.phase != "intent"' >/dev/null; then
    retained="$MERGE_OUTCOME_REF"
  fi
  remove_worktree_if_present "$path" || return $?
  # Refusal or incomplete removal preserves the branches with the worktree.
  [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
  for branch in "temp/pr-$pr" "pr-$pr" "pr-$pr-prep"; do
    delete_local_branch_if_safe "$branch" "$retained" || return $?
  done
}

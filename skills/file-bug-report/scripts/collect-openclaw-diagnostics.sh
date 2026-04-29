#!/usr/bin/env bash
set -uo pipefail

OUTPUT_DIR=""
SINCE_MINUTES="30"
MAX_LOG_LINES="500"
COMMAND_TIMEOUT="10"
INCLUDE_PRIVATE_CONFIG="0"
INCLUDE_TMP_LOGS="0"
INCLUDE_GIT_DETAILS="0"

OPENCLAW_HOME_DEFAULT="${OPENCLAW_HOME:-$HOME/.openclaw}"
WORKSPACE_DEFAULT="$(pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

usage() {
  cat <<'USAGE'
Usage: collect-openclaw-diagnostics.sh [options]

Creates a conservative local diagnostics bundle for OpenClaw issue reports.
The default bundle is meant to support a public-safe issue draft, not to be
uploaded blindly.

Options:
  --output DIR              Directory to write. Defaults to ./openclaw-diagnostics-<UTC>.
  --since-minutes N         Collect log files modified in the last N minutes. Default: 30.
  --max-log-lines N         Tail at most N lines per matching log file. Default: 500.
  --command-timeout N       Seconds before diagnostic commands time out. Default: 10.
  --include-private-config  Copy small redacted config/AGENTS files. Default: metadata only.
  --include-tmp-logs        Include matching logs under TMPDIR/tmp. Default: off.
  --include-git-details     Include raw redacted git status/remotes. Default: summary only.
  -h, --help                Show this help.

Review every generated file before sharing anything publicly.
USAGE
}

require_value() {
  local flag="$1"
  local value="${2-}"
  if [ -z "$value" ] || [ "${value#-}" != "$value" ]; then
    echo "Missing value for $flag" >&2
    usage >&2
    exit 2
  fi
}

require_positive_int() {
  local name="$1"
  local value="$2"
  if ! printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then
    echo "$name must be a positive integer: $value" >&2
    exit 2
  fi
}

require_command() {
  local command_name="$1"
  local purpose="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name ($purpose)" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      require_value "$1" "${2-}"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --since-minutes)
      require_value "$1" "${2-}"
      SINCE_MINUTES="$2"
      shift 2
      ;;
    --max-log-lines)
      require_value "$1" "${2-}"
      MAX_LOG_LINES="$2"
      shift 2
      ;;
    --command-timeout)
      require_value "$1" "${2-}"
      COMMAND_TIMEOUT="$2"
      shift 2
      ;;
    --include-private-config)
      INCLUDE_PRIVATE_CONFIG="1"
      shift
      ;;
    --include-tmp-logs)
      INCLUDE_TMP_LOGS="1"
      shift
      ;;
    --include-git-details)
      INCLUDE_GIT_DETAILS="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_positive_int "--since-minutes" "$SINCE_MINUTES"
require_positive_int "--max-log-lines" "$MAX_LOG_LINES"
require_positive_int "--command-timeout" "$COMMAND_TIMEOUT"
require_command perl "redacting secrets and local identifiers from diagnostics output"

if [ -z "$OUTPUT_DIR" ]; then
  OUTPUT_DIR="./openclaw-diagnostics-$(date -u +%Y%m%dT%H%M%SZ)"
fi

if [ -e "$OUTPUT_DIR" ] && [ ! -d "$OUTPUT_DIR" ]; then
  echo "Output path exists but is not a directory: $OUTPUT_DIR" >&2
  exit 1
fi
if ! mkdir -p "$OUTPUT_DIR"/{commands,configs,logs,plugins}; then
  echo "Could not create diagnostics output directory: $OUTPUT_DIR" >&2
  exit 1
fi
COMMAND_INDEX="$OUTPUT_DIR/commands/command-index.tsv"
FILE_INDEX="$OUTPUT_DIR/file-index.tsv"
if ! printf 'name\tstatus\toutput\n' > "$COMMAND_INDEX"; then
  echo "Could not write command index: $COMMAND_INDEX" >&2
  exit 1
fi
if ! printf 'kind\tstatus\tsize_bytes\tmtime\tsha256\tpath\treason\n' > "$FILE_INDEX"; then
  echo "Could not write file index: $FILE_INDEX" >&2
  exit 1
fi

sanitize_stream() {
  local host_short=""
  local host_full=""
  host_short="$(hostname -s 2>/dev/null || true)"
  host_full="$(hostname 2>/dev/null || true)"
  PERL_HOME="${HOME:-}" PERL_USER="${USER:-}" PERL_HOST_SHORT="$host_short" PERL_HOST_FULL="$host_full" \
    perl -0777 -pe '
      s#([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@#$1[USER]:[REDACTED]@#gi;
      s/(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{10,}/$1 [REDACTED]/g;
      s/sk-[A-Za-z0-9_-]{16,}/sk-[REDACTED]/g;
      s/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/$1[REDACTED]/g;
      s/(glpat-|hf_|npm_|pypi-)[A-Za-z0-9._-]{16,}/$1[REDACTED]/g;
      s/xox[baprs]-[A-Za-z0-9-]{10,}/xox-[REDACTED]/g;
      s/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/[AWS_ACCESS_KEY_REDACTED]/g;
      s/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/[JWT_REDACTED]/g;
      s/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/[PRIVATE_KEY_BLOCK_REDACTED]/gs;
      s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[EMAIL_REDACTED]/g;
      s/([A-Za-z0-9_.-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|REFRESH[_-]?TOKEN|ACCESS[_-]?TOKEN|AWS[_-]?ACCESS[_-]?KEY[_-]?ID)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'\''[^'\'']*'\''|[^,;\s}]+)/$1$2[REDACTED]/ig;
      for my $name (qw(PERL_HOME PERL_HOST_SHORT PERL_HOST_FULL)) {
        my $value = $ENV{$name} // "";
        next unless length($value) > 1;
        my $safe = quotemeta($value);
        my $replacement = $name eq "PERL_HOME" ? "~" : "[LOCAL_ID_REDACTED]";
        s/$safe/$replacement/g;
      }
      my $user = $ENV{PERL_USER} // "";
      if (length($user) > 1) {
        my $safe_user = quotemeta($user);
        s/(?<![A-Za-z0-9._-])$safe_user(?![A-Za-z0-9._-])/[LOCAL_ID_REDACTED]/g;
      }
    '
}

safe_name() {
  printf '%s' "$1" | sanitize_stream | sed -E 's#^/##; s#[/: ]+#_#g; s#[^A-Za-z0-9._-]#_#g' | cut -c 1-180
}

path_scope() {
  local label="$1"
  local path="$2"
  local scope="outside HOME/XDG"
  if [ -z "$path" ]; then
    printf -- '- %s path: unset\n' "$label"
    return 0
  fi
  if [ -n "${HOME:-}" ] && { [ "$path" = "$HOME" ] || [[ "$path" == "$HOME/"* ]]; }; then
    scope="under HOME"
  elif [ -n "${XDG_CONFIG_HOME:-}" ] && { [ "$path" = "$XDG_CONFIG_HOME" ] || [[ "$path" == "$XDG_CONFIG_HOME/"* ]]; }; then
    scope="under XDG_CONFIG_HOME"
  elif [ -n "${XDG_STATE_HOME:-}" ] && { [ "$path" = "$XDG_STATE_HOME" ] || [[ "$path" == "$XDG_STATE_HOME/"* ]]; }; then
    scope="under XDG_STATE_HOME"
  fi
  printf -- '- %s path: [LOCAL_PATH_REDACTED]\n' "$label"
  printf -- '- %s path scope: %s\n' "$label" "$scope"
}

file_size() {
  wc -c < "$1" 2>/dev/null | tr -d ' ' || printf 'unknown'
}

file_mtime() {
  stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S%z' "$1" 2>/dev/null ||
    stat -c '%y' "$1" 2>/dev/null ||
    printf 'unknown'
}

file_sha256() {
  shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' ||
    sha256sum "$1" 2>/dev/null | awk '{print $1}' ||
    printf 'unknown'
}

record_file() {
  local kind="$1"
  local status="$2"
  local path="$3"
  local reason="$4"
  local size="unknown"
  local mtime="unknown"
  local sha="unknown"
  if [ -f "$path" ]; then
    size="$(file_size "$path")"
    mtime="$(file_mtime "$path")"
    sha="$(file_sha256 "$path")"
  fi
  {
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$status" "$size" "$mtime" "$sha" "$path" "$reason"
  } | sanitize_stream >> "$FILE_INDEX"
}

run_limited() {
  local timeout_bin=""
  timeout_bin="$(command -v gtimeout 2>/dev/null || command -v timeout 2>/dev/null || true)"
  if [ -n "$timeout_bin" ] && "$timeout_bin" --help 2>&1 | grep -q -- '--kill-after'; then
    "$timeout_bin" --kill-after=2s "${COMMAND_TIMEOUT}s" "$@"
    return $?
  fi

  perl -e 'setpgrp(0, 0); exec @ARGV or die "exec failed: $!\n"' "$@" &
  local cmd_pid=$!
  local elapsed=0
  while kill -0 "$cmd_pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$COMMAND_TIMEOUT" ]; then
      echo "[timeout after ${COMMAND_TIMEOUT}s]" >&2
      kill -TERM "-$cmd_pid" 2>/dev/null || kill -TERM "$cmd_pid" 2>/dev/null || true
      sleep 1
      kill -KILL "-$cmd_pid" 2>/dev/null || kill -KILL "$cmd_pid" 2>/dev/null || true
      wait "$cmd_pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$cmd_pid"
}

run_cmd() {
  local name="$1"
  shift
  local outfile="$OUTPUT_DIR/commands/${name}.txt"
  local status=0
  {
    printf '$'
    printf ' %q' "$@"
    printf '\n\n'
    run_limited "$@"
    status=$?
    printf '\n[exit=%s]\n' "$status"
    printf '%s\t%s\t%s\n' "$name" "$status" "commands/${name}.txt" >> "$COMMAND_INDEX"
  } 2>&1 | sanitize_stream > "$outfile"
}

copy_redacted_file() {
  local kind="$1"
  local src="$2"
  local dest_dir="$3"
  [ -f "$src" ] || return 0
  local size
  size="$(file_size "$src")"
  if [ "$size" = "unknown" ] || [ "$size" -gt 524288 ]; then
    record_file "$kind" "skipped" "$src" "file too large for redacted copy"
    return 0
  fi
  local dest="$dest_dir/$(safe_name "$src").txt"
  {
    printf '# Source: %s\n\n' "$src"
    cat "$src"
  } 2>&1 | sanitize_stream > "$dest"
  record_file "$kind" "copied-redacted" "$src" "$dest"
}

record_metadata_only() {
  local kind="$1"
  local src="$2"
  local reason="$3"
  [ -f "$src" ] || return 0
  record_file "$kind" "metadata-only" "$src" "$reason"
}

tail_redacted_file() {
  local src="$1"
  [ -f "$src" ] || return 0
  local size
  size="$(file_size "$src")"
  if [ "$size" = "unknown" ] || [ "$size" -gt 10485760 ]; then
    record_file "log" "skipped" "$src" "file too large for tail"
    return 0
  fi
  local dest="$OUTPUT_DIR/logs/$(safe_name "$src").tail.txt"
  {
    printf '# Source: %s\n' "$src"
    printf '# Last %s lines from files modified within the last %s minutes.\n\n' "$MAX_LOG_LINES" "$SINCE_MINUTES"
    tail -n "$MAX_LOG_LINES" "$src"
  } 2>&1 | sanitize_stream > "$dest"
  record_file "log" "copied-redacted-tail" "$src" "$dest"
}

find_supports_mmin() {
  local root="$1"
  find "$root" -maxdepth 0 -mmin -1 -print >/dev/null 2>&1
}

file_mtime_epoch() {
  stat -c '%Y' "$1" 2>/dev/null ||
    stat -f '%m' "$1" 2>/dev/null
}

find_recent_logs() {
  local root="$1"
  [ -d "$root" ] || return 0
  if find_supports_mmin "$root"; then
    find "$root" -maxdepth 3 -type f \
      \( -iname '*.log' -o -iname '*openclaw*' -o -iname '*gateway*' \) \
      -mmin "-$SINCE_MINUTES" \
      ! -path '*/node_modules/*' ! -path '*/.git/*' 2>/dev/null
    return 0
  fi

  local now
  now="$(date +%s 2>/dev/null || printf '0')"
  local cutoff=$((now - SINCE_MINUTES * 60))
  local src
  local mtime
  find "$root" -maxdepth 3 -type f \
    \( -iname '*.log' -o -iname '*openclaw*' -o -iname '*gateway*' \) \
    ! -path '*/node_modules/*' ! -path '*/.git/*' 2>/dev/null |
    while IFS= read -r src; do
      mtime="$(file_mtime_epoch "$src" || true)"
      case "$mtime" in
        ''|*[!0-9]*) continue ;;
      esac
      [ "$mtime" -ge "$cutoff" ] && printf '%s\n' "$src"
    done
}

write_env_summary() {
  local outfile="$OUTPUT_DIR/commands/environment-summary.txt"
  {
    echo "# Environment Summary"
    echo
    for var in OPENCLAW_HOME OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR XDG_CONFIG_HOME XDG_STATE_HOME CODEX_HOME SHELL TERM; do
      if [ -n "${!var-}" ]; then
        printf -- '- %s: set\n' "$var"
      else
        printf -- '- %s: unset\n' "$var"
      fi
    done
    printf -- '- PATH entries: %s\n' "$(printf '%s' "${PATH:-}" | awk -F: '{print NF}')"
    printf -- '- PATH contains openclaw: %s\n' "$(printf '%s' "${PATH:-}" | grep -qi openclaw && echo yes || echo no)"
    for prefix in OPENAI ANTHROPIC CLAUDE CODEX; do
      local count
      count="$(env | awk -F= -v p="$prefix" 'index($1, p) == 1 { n += 1 } END { print n + 0 }')"
      printf -- '- %s_* variables present: %s\n' "$prefix" "$count"
    done
  } | sanitize_stream > "$outfile"
  printf '%s\t%s\t%s\n' "environment-summary" "0" "commands/environment-summary.txt" >> "$COMMAND_INDEX"
}

write_git_summary() {
  local outfile="$OUTPUT_DIR/commands/git-summary.txt"
  {
    echo "# Git Summary"
    echo
    if ! command -v git >/dev/null 2>&1; then
      echo "- git: not found"
      return 0
    fi
    git --version
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "- inside git repository: yes"
      printf -- '- dirty entries: %s\n' "$(git status --porcelain=v1 2>/dev/null | wc -l | tr -d ' ')"
      printf -- '- remotes configured: %s\n' "$(git remote 2>/dev/null | wc -l | tr -d ' ')"
      printf -- '- current branch present: %s\n' "$(git branch --show-current >/dev/null 2>&1 && echo yes || echo unknown)"
    else
      echo "- inside git repository: no"
    fi
  } 2>&1 | sanitize_stream > "$outfile"
  printf '%s\t%s\t%s\n' "git-summary" "0" "commands/git-summary.txt" >> "$COMMAND_INDEX"

  if [ "$INCLUDE_GIT_DETAILS" = "1" ] && command -v git >/dev/null 2>&1; then
    run_cmd git-status git status --short
    run_cmd git-remote git remote -v
  fi
}

{
  echo "# OpenClaw Diagnostics Summary"
  echo
  echo "- Generated UTC: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "- Local time: $(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || date)"
  path_scope "Working directory" "$WORKSPACE_DEFAULT"
  path_scope "OPENCLAW_HOME" "$OPENCLAW_HOME_DEFAULT"
  echo "- Incident window requested: last $SINCE_MINUTES minutes"
  echo "- Per-command timeout: ${COMMAND_TIMEOUT}s"
  echo "- Private config copied: $INCLUDE_PRIVATE_CONFIG"
  echo "- TMP log scan enabled: $INCLUDE_TMP_LOGS"
  echo "- Raw git details enabled: $INCLUDE_GIT_DETAILS"
  echo
  echo "Default output is conservative, but it can still contain local identifiers or log excerpts."
  echo "Review every generated file before attaching output to a public issue."
} | sanitize_stream > "$OUTPUT_DIR/diagnostics-summary.md"

run_cmd system-uname uname -a
write_env_summary

if command -v sw_vers >/dev/null 2>&1; then
  run_cmd system-macos sw_vers
fi
if command -v node >/dev/null 2>&1; then
  run_cmd node-version node --version
fi
if command -v npm >/dev/null 2>&1; then
  run_cmd npm-version npm --version
fi
if command -v pnpm >/dev/null 2>&1; then
  run_cmd pnpm-version pnpm --version
fi
write_git_summary

if command -v openclaw >/dev/null 2>&1; then
  run_cmd openclaw-version openclaw --version
  run_cmd openclaw-status openclaw status
  run_cmd openclaw-gateway-status-deep openclaw gateway status --deep
  run_cmd openclaw-plugins-list openclaw plugins list
  run_cmd openclaw-plugins-list-json openclaw plugins list --json
  run_cmd openclaw-config-file openclaw config file
  run_cmd openclaw-config-validate openclaw config validate
else
  echo "openclaw command not found on PATH." > "$OUTPUT_DIR/commands/openclaw-not-found.txt"
  printf '%s\t%s\t%s\n' "openclaw-not-found" "127" "commands/openclaw-not-found.txt" >> "$COMMAND_INDEX"
fi

for root in "$OPENCLAW_HOME_DEFAULT" "$WORKSPACE_DEFAULT/.openclaw" "${XDG_CONFIG_HOME:-$HOME/.config}/openclaw" "${XDG_STATE_HOME:-$HOME/.local/state}/openclaw"; do
  [ -d "$root" ] || continue
  find "$root" -maxdepth 4 -type f \
    \( -iname '*config*' -o -iname '*settings*' -o -iname '*preference*' -o -iname 'AGENTS.md' \) \
    ! -iname '*.db' ! -iname '*.sqlite' ! -path '*/node_modules/*' ! -path '*/.git/*' \
    2>/dev/null | while IFS= read -r file; do
      if [ "$INCLUDE_PRIVATE_CONFIG" = "1" ]; then
        copy_redacted_file "config" "$file" "$OUTPUT_DIR/configs"
      else
        record_metadata_only "config" "$file" "content skipped by default; rerun with --include-private-config after user approval"
      fi
    done
done

find "$WORKSPACE_DEFAULT" -maxdepth 3 -type f \
  \( -iname 'AGENTS.md' -o -iname 'CLAUDE.md' -o -iname 'SUBAGENTS.md' -o -path '*/.agents/*' \) \
  ! -path '*/node_modules/*' ! -path '*/.git/*' \
  2>/dev/null | while IFS= read -r file; do
    record_metadata_only "workspace-agent-instructions" "$file" "instruction content skipped by default; describe relevant overlays manually"
  done

for root in "$OPENCLAW_HOME_DEFAULT/plugins" "$OPENCLAW_HOME_DEFAULT/skills" "$WORKSPACE_DEFAULT/plugins" "$WORKSPACE_DEFAULT/skills" "$WORKSPACE_DEFAULT/.agents/plugins"; do
  [ -d "$root" ] || continue
  {
    echo "# Plugin or skill directory: $root"
    find "$root" -maxdepth 3 -type f \
      \( -iname 'plugin.json' -o -iname 'manifest.json' -o -iname 'openclaw-plugin.json' -o -iname 'SKILL.md' -o -iname 'openai.yaml' \) \
      ! -path '*/node_modules/*' ! -path '*/.git/*' 2>/dev/null
  } | sanitize_stream > "$OUTPUT_DIR/plugins/$(safe_name "$root").index.txt"

  find "$root" -maxdepth 3 -type f \
    \( -iname 'plugin.json' -o -iname 'manifest.json' -o -iname 'openclaw-plugin.json' -o -iname 'openai.yaml' \) \
    ! -path '*/node_modules/*' ! -path '*/.git/*' \
    2>/dev/null | while IFS= read -r file; do
      if [ "$INCLUDE_PRIVATE_CONFIG" = "1" ]; then
        copy_redacted_file "plugin-manifest" "$file" "$OUTPUT_DIR/plugins"
      else
        record_metadata_only "plugin-manifest" "$file" "manifest content skipped by default; rerun with --include-private-config after user approval"
      fi
    done
done

log_roots=(
  "$OPENCLAW_HOME_DEFAULT/logs"
  "$OPENCLAW_HOME_DEFAULT/.logs"
  "$WORKSPACE_DEFAULT/.openclaw/logs"
  "${XDG_STATE_HOME:-$HOME/.local/state}/openclaw/logs"
  "${XDG_CONFIG_HOME:-$HOME/.config}/openclaw/logs"
  "$HOME/Library/Logs/OpenClaw"
)

if [ "$INCLUDE_TMP_LOGS" = "1" ]; then
  log_roots+=("${TMPDIR:-/tmp}/openclaw" "${TMPDIR:-/tmp}/OpenClaw" "/tmp")
fi

for root in "${log_roots[@]}"; do
  [ -d "$root" ] || continue
  find_recent_logs "$root" | head -n 40 | while IFS= read -r file; do
    tail_redacted_file "$file"
  done
done

if command -v systemctl >/dev/null 2>&1; then
  run_cmd systemd-user-openclaw sh -c 'systemctl --user status openclaw* --no-pager'
fi
if command -v launchctl >/dev/null 2>&1; then
  run_cmd launchctl-openclaw sh -c 'launchctl list | grep -i openclaw'
fi

cat > "$OUTPUT_DIR/next-steps.md" <<'NEXT'
# Next Steps

1. Review every file in this diagnostics bundle for secrets and unrelated private data.
2. Fill out issue-template.md.
3. Search existing openclaw/openclaw issues with exact errors, symptom terms, provider/model names, plugin names, and log phrases.
4. Draft the issue first. Post only the issue body and selected reviewed excerpts after explicit user approval.
5. Do not upload the whole diagnostics directory to a public issue.
NEXT

if [ -f "$SKILL_DIR/references/issue-template.md" ]; then
  cp "$SKILL_DIR/references/issue-template.md" "$OUTPUT_DIR/issue-template.md"
fi
if [ -f "$SKILL_DIR/references/similar-issue-search.md" ]; then
  cp "$SKILL_DIR/references/similar-issue-search.md" "$OUTPUT_DIR/similar-issue-search.md"
fi

echo "Diagnostics written to: $OUTPUT_DIR"
echo "Review output before sharing publicly. Do not upload the full bundle to a public issue."

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_MODULE="${SCRIPT_DIR}/lib/telegram-live-runtime-helpers.mjs"
BASE_CONFIG_PATH="${OPENCLAW_TELEGRAM_BASE_CONFIG_PATH:-${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}}"

# Trim leading/trailing whitespace for robust .env parsing.
trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove one pair of matching outer quotes if present.
strip_outer_quotes() {
  local value="$1"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then
    printf '%s' "${value:1:${#value}-2}"
    return
  fi
  printf '%s' "$value"
}

# Parse KEY=value (with optional "export") and return the normalized value.
parse_env_assignment() {
  local key="$1"
  local line="$2"
  local parsed=""
  if [[ "$line" =~ ^(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*(.*)$ ]]; then
    parsed="$(trim "${BASH_REMATCH[2]}")"
    parsed="$(strip_outer_quotes "$parsed")"
  fi
  printf '%s' "$parsed"
}

# Return the last occurrence of KEY from an env-style file.
read_last_env_value() {
  local file_path="$1"
  local key="$2"
  local line=""
  local trimmed=""
  local parsed=""
  local last_value=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(trim "$line")"
    if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
      continue
    fi
    parsed="$(parse_env_assignment "$key" "$trimmed")"
    if [[ -n "$parsed" ]]; then
      last_value="$parsed"
    fi
  done < "$file_path"

  printf '%s' "$last_value"
}

# Mask token output so logs never leak full credentials.
mask_token() {
  local token="$1"
  local len=${#token}
  if (( len <= 4 )); then
    printf '****'
    return
  fi
  if (( len <= 8 )); then
    printf '%s...%s' "${token:0:1}" "${token:len-1:1}"
    return
  fi
  printf '%s...%s' "${token:0:4}" "${token:len-4:4}"
}

upsert_telegram_token_in_env_local() {
  local token="$1"
  local env_local=".env.local"
  local tmp_file="${env_local}.tmp.$$"

  if [[ -f "$env_local" ]]; then
    awk -v token="$token" '
      BEGIN { replaced = 0 }
      /^[[:space:]]*(export[[:space:]]+)?TELEGRAM_BOT_TOKEN[[:space:]]*=/ {
        if (replaced == 0) {
          print "TELEGRAM_BOT_TOKEN=" token;
          replaced = 1;
        }
        next;
      }
      { print }
      END {
        if (replaced == 0) {
          print "TELEGRAM_BOT_TOKEN=" token;
        }
      }
    ' "$env_local" > "$tmp_file"
    mv "$tmp_file" "$env_local"
  else
    printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" > "$env_local"
  fi
}

if [[ ! -f "$HELPER_MODULE" ]]; then
  echo "Error: helper module missing: $HELPER_MODULE" >&2
  exit 1
fi

if [[ ! -r ".env.bots" ]]; then
  echo "Error: .env.bots not found or not readable in $(pwd)." >&2
  echo "Create it from .env.bots.example and add BOT_TOKEN entries." >&2
  exit 1
fi

bot_tokens=()
line=""
trimmed=""
parsed=""
while IFS= read -r line || [[ -n "$line" ]]; do
  trimmed="$(trim "$line")"
  if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
    continue
  fi
  parsed="$(parse_env_assignment "BOT_TOKEN" "$trimmed")"
  if [[ -n "$parsed" ]]; then
    bot_tokens+=("$parsed")
  fi
done < ".env.bots"

if (( ${#bot_tokens[@]} == 0 )); then
  echo "Error: no valid BOT_TOKEN entries found in .env.bots." >&2
  exit 1
fi

worktree_paths=()
worktree_list_output=""
if ! worktree_list_output="$(git worktree list --porcelain 2>/dev/null)"; then
  echo "Error: unable to list git worktrees from $(pwd)." >&2
  echo "Run this script from within a git worktree." >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == worktree\ * ]]; then
    worktree_paths+=("${line#worktree }")
  fi
done <<< "$worktree_list_output"

current_worktree="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
if [[ -d "$current_worktree" ]]; then
  current_worktree="$(cd "$current_worktree" && pwd -P)"
fi
current_token=""
claimed_tokens_other_worktrees=()
reserved_tokens=()
worktree_path=""
env_local_path=""
claimed=""
for worktree_path in "${worktree_paths[@]-}"; do
  normalized_worktree="$worktree_path"
  if [[ -d "$worktree_path" ]]; then
    normalized_worktree="$(cd "$worktree_path" && pwd -P)"
  fi

  env_local_path="$normalized_worktree/.env.local"
  if [[ ! -f "$env_local_path" ]]; then
    continue
  fi

  claimed="$(read_last_env_value "$env_local_path" "TELEGRAM_BOT_TOKEN")"
  if [[ -z "$claimed" ]]; then
    continue
  fi

  if [[ "$normalized_worktree" == "$current_worktree" ]]; then
    current_token="$claimed"
  else
    claimed_tokens_other_worktrees+=("$claimed")
  fi
done

if [[ -f "$BASE_CONFIG_PATH" ]]; then
  reserved_lines="$(
    BASE_CONFIG_PATH="$BASE_CONFIG_PATH" node --input-type=module - <<'NODE'
import fs from "node:fs";

const configPath = process.env.BASE_CONFIG_PATH;
if (!configPath || !fs.existsSync(configPath)) {
  process.exit(0);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.exit(0);
}

const tokens = new Set();
const telegram = parsed?.channels?.telegram;
const pushToken = (value) => {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  tokens.add(trimmed);
};

if (telegram && typeof telegram === "object") {
  pushToken(telegram.botToken);
  const accounts = telegram.accounts;
  if (accounts && typeof accounts === "object") {
    for (const account of Object.values(accounts)) {
      if (account && typeof account === "object") {
        pushToken(account.botToken);
      }
    }
  }
}

for (const token of tokens) {
  process.stdout.write(`${token}\n`);
}
NODE
  )"

  while IFS= read -r token || [[ -n "$token" ]]; do
    token="$(trim "$token")"
    if [[ -n "$token" ]]; then
      reserved_tokens+=("$token")
    fi
  done <<< "$reserved_lines"
fi

if (( ${#reserved_tokens[@]} > 0 )); then
  claimed_tokens_other_worktrees+=("${reserved_tokens[@]}")
fi

tmp_dir="$(mktemp -d -t openclaw-assign-bot.XXXXXX)"
pool_file="${tmp_dir}/pool.txt"
claimed_file="${tmp_dir}/claimed.txt"
current_file="${tmp_dir}/current.txt"

cleanup_tmp() {
  rm -rf "$tmp_dir"
}
trap cleanup_tmp EXIT

printf '%s\n' "${bot_tokens[@]}" > "$pool_file"
printf '%s\n' "${claimed_tokens_other_worktrees[@]-}" > "$claimed_file"
printf '%s' "$current_token" > "$current_file"

selection_lines="$(
  node --input-type=module - "$HELPER_MODULE" "$pool_file" "$claimed_file" "$current_file" <<'NODE'
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [helperPath, poolPath, claimedPath, currentPath] = process.argv.slice(2);
const helpers = await import(pathToFileURL(helperPath).href);

const readLines = (filePath) =>
  fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

const result = helpers.selectTelegramTesterToken({
  poolTokens: readLines(poolPath),
  claimedTokens: readLines(claimedPath),
  currentToken: fs.readFileSync(currentPath, "utf8").trim(),
});

process.stdout.write(
  `${result.ok ? "1" : "0"}\n${String(result.action ?? "")}\n${String(result.reason ?? "")}\n${String(
    result.selectedToken ?? "",
  )}\n`,
);
NODE
)"

selection_ok="$(printf '%s\n' "$selection_lines" | sed -n '1p')"
selection_action="$(printf '%s\n' "$selection_lines" | sed -n '2p')"
selection_reason="$(printf '%s\n' "$selection_lines" | sed -n '3p')"
selected_token="$(printf '%s\n' "$selection_lines" | sed -n '4p')"

if [[ "$selection_ok" != "1" || -z "$selected_token" ]]; then
  echo "Error: no tester bot token available for this worktree." >&2
  echo "Reason: ${selection_reason:-unknown}" >&2
  echo "Claimed by other worktrees: ${#claimed_tokens_other_worktrees[@]} / Pool size: ${#bot_tokens[@]}" >&2
  if (( ${#reserved_tokens[@]} > 0 )); then
    echo "Reserved by stable config: ${#reserved_tokens[@]} token(s) from ${BASE_CONFIG_PATH}" >&2
  fi
  echo "No fallback to stable/main bot token is allowed." >&2
  exit 1
fi

selected_index=0
idx=0
for idx in "${!bot_tokens[@]}"; do
  if [[ "${bot_tokens[$idx]}" == "$selected_token" ]]; then
    selected_index=$((idx + 1))
    break
  fi
done

if [[ "$selection_action" == "retain" && -n "$current_token" && "$current_token" == "$selected_token" ]]; then
  echo "Retained Telegram tester bot token #$selected_index for worktree: $current_worktree"
  echo "Token fingerprint: $(mask_token "$selected_token")"
  exit 0
fi

upsert_telegram_token_in_env_local "$selected_token"

if [[ -n "$current_token" ]]; then
  echo "Reassigned Telegram tester bot token #$selected_index to worktree: $current_worktree"
else
  echo "Assigned Telegram tester bot token #$selected_index to worktree: $current_worktree"
fi
echo "Token fingerprint: $(mask_token "$selected_token")"

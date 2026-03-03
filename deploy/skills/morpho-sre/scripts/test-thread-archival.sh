#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-thread-archival.sh
source "${SCRIPT_DIR}/lib-thread-archival.sh"

PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$msg"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
COMMENTS_DIR="${TMP_DIR}/comments"
mkdir -p "$COMMENTS_DIR"
COMMENT_SEQ_FILE="${TMP_DIR}/comment-seq"
printf '0\n' >"$COMMENT_SEQ_FILE"

thread_archival_fetch_messages() {
  local _thread="$1"
  printf '1700\talice\tfalse\trollback done\n'
  printf '1701\tbot-user\ttrue\tauto message\n'
  printf '1702\tbob\t0\tcache flushed\n'
}

thread_archival_summarizer() {
  local _messages="$1"
  printf '### Human debugging insights\n- rollback done\n- cache flushed\n'
}

thread_archival_list_comments() {
  local _ticket="$1"
  local id
  for id in "$COMMENTS_DIR"/*.txt; do
    [[ -e "$id" ]] || continue
    local cid
    cid="$(basename "$id" .txt)"
    local body
    body="$(tr '\n' ' ' <"$id")"
    printf '%s\t%s\n' "$cid" "$body"
  done | sort -n
}

thread_archival_create_comment() {
  local _ticket="$1"
  local body="$2"
  local seq
  seq="$(cat "$COMMENT_SEQ_FILE")"
  seq=$((seq + 1))
  printf '%s\n' "$seq" >"$COMMENT_SEQ_FILE"
  printf '%s\n' "$body" >"${COMMENTS_DIR}/${seq}.txt"
}

thread_archival_update_comment() {
  local comment_id="$1"
  local body="$2"
  printf '%s\n' "$body" >"${COMMENTS_DIR}/${comment_id}.txt"
}

thread_archival_get_comment() {
  local comment_id="$1"
  cat "${COMMENTS_DIR}/${comment_id}.txt"
}

HUMAN_MSGS="$(collect_human_messages 1711111111.000100)"
assert_contains "$HUMAN_MSGS" "alice" "human message kept"
if [[ "$HUMAN_MSGS" == *"bot-user"* ]]; then
  fail "bot message should be filtered"
fi
pass "collect human-only messages"

SUMMARY="$(summarize_thread "$HUMAN_MSGS")"
assert_contains "$SUMMARY" "rollback done" "summary content"
pass "summary generation"

ARCHIVE_INTERIM="$(archive_thread 1711111111.000100 inc-1 PLA-1 interim)"
assert_contains "$ARCHIVE_INTERIM" $'archived\tinterim' "interim archive result"
COUNT_AFTER_INTERIM="$(ls -1 "$COMMENTS_DIR" | wc -l | tr -d ' ')"
[[ "$COUNT_AFTER_INTERIM" == "1" ]] || fail "interim should create one comment"
pass "interim archival comment"

archive_thread 1711111111.000100 inc-1 PLA-1 interim >/dev/null
COUNT_AFTER_RETRY="$(ls -1 "$COMMENTS_DIR" | wc -l | tr -d ' ')"
[[ "$COUNT_AFTER_RETRY" == "1" ]] || fail "idempotent interim update should not duplicate"
pass "idempotent marker update"

archive_thread 1711111111.000100 inc-1 PLA-1 final >/dev/null
COUNT_AFTER_FINAL="$(ls -1 "$COMMENTS_DIR" | wc -l | tr -d ' ')"
[[ "$COUNT_AFTER_FINAL" == "2" ]] || fail "final should add/update comments"
INTERIM_BODY="$(cat "${COMMENTS_DIR}/1.txt")"
assert_contains "$INTERIM_BODY" "Superseded by final resolution context" "interim superseded on final"
pass "final pass supersedes interim"

printf 'all tests passed (%d)\n' "$PASS_COUNT"

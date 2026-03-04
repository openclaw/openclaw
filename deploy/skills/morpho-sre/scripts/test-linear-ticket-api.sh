#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
API_SCRIPT="${SCRIPT_DIR}/linear-ticket-api.sh"

PASS_COUNT=0
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'ok %d - %s\n' "$PASS_COUNT" "$1"
}

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  [[ "$expected" == "$actual" ]] || fail "${message} (expected=${expected}, got=${actual})"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "${message} (missing: ${needle})"
}

cat >"${TMP_DIR}/mock-curl.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

payload=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --data)
      payload="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

query="$(printf '%s\n' "$payload" | jq -r '.query // ""')"
vars="$(printf '%s\n' "$payload" | jq -c '.variables // {}')"

case "$query" in
  *"teams(filter:{name:{eq:\$name}})"*)
    name="$(printf '%s\n' "$vars" | jq -r '.name // ""')"
    if [[ "$name" == "Platform" ]]; then
      jq -nc '{data:{teams:{nodes:[{id:"team-1",name:"Platform"}]}}}'
    else
      jq -nc '{data:{teams:{nodes:[]}}}'
    fi
    ;;
  *"issueLabels(filter:{name:{eq:\$name}})"*)
    name="$(printf '%s\n' "$vars" | jq -r '.name // ""')"
    if [[ "$name" == "openclaw-sre" ]]; then
      jq -nc '{data:{issueLabels:{nodes:[]}}}'
    else
      jq -nc '{data:{issueLabels:{nodes:[{id:"label-generic",name:"generic"}]}}}'
    fi
    ;;
  *"issue(id:\$id){ id identifier title description labels { nodes { id name } } }"*)
    issue_ref="$(printf '%s\n' "$vars" | jq -r '.id // ""')"
    if [[ "$issue_ref" == "PLA-318" ]]; then
      jq -nc '{data:{issue:{id:"issue-uuid-1",identifier:"PLA-318",title:"Old title",description:"Old description",labels:{nodes:[{id:"label-bug",name:"Bug"}]}}}}'
    else
      jq -nc '{data:{issue:null}}'
    fi
    ;;
  *"issueLabelCreate(input:{name:\$name,color:\$color})"*)
    jq -nc '{data:{issueLabelCreate:{success:true,issueLabel:{id:"label-openclaw-sre",name:"openclaw-sre"}}}}'
    ;;
  *"issueUpdate(id:\$id,input:{description:\$description})"*)
    jq -nc '{data:{issueUpdate:{success:true,issue:{identifier:"PLA-318"}}}}'
    ;;
  *"commentCreate(input:{issueId:\$issueId,body:\$body})"*)
    jq -nc '{data:{commentCreate:{success:true,comment:{id:"comment-1"}}}}'
    ;;
  *"issueUpdate(id:\$id,input:{title:\$title})"*)
    jq -nc '{data:{issueUpdate:{success:true,issue:{identifier:"PLA-318"}}}}'
    ;;
  *"issueUpdate(id:\$id,input:{labelIds:\$labelIds})"*)
    jq -nc '{data:{issueUpdate:{success:true,issue:{identifier:"PLA-318",labels:{nodes:[{id:"label-bug",name:"Bug"},{id:"label-openclaw-sre",name:"openclaw-sre"}]}}}}}'
    ;;
  *)
    jq -nc '{errors:[{message:"unexpected query"}]}'
    ;;
esac
EOF
chmod +x "${TMP_DIR}/mock-curl.sh"

export LINEAR_CURL_BIN="${TMP_DIR}/mock-curl.sh"
export LINEAR_API_KEY="lin_api_test"
export LINEAR_API_URL="https://linear.example.test/graphql"

LOOKUP_OUT="$(bash "$API_SCRIPT" lookup team Platform)"
assert_eq "team-1" "$LOOKUP_OUT" "lookup team id"
pass "lookup team"

GET_OUT="$(bash "$API_SCRIPT" issue get PLA-318)"
assert_contains "$GET_OUT" '"identifier":"PLA-318"' "issue get output"
pass "issue get"

UPD_OUT="$(bash "$API_SCRIPT" issue update-description PLA-318 --text "new detailed spec")"
assert_eq $'updated\tPLA-318' "$UPD_OUT" "issue update-description output"
pass "issue update-description"

COMMENT_OUT="$(bash "$API_SCRIPT" issue add-comment PLA-318 --text "follow-up comment")"
assert_eq $'commented\tPLA-318\tcomment-1' "$COMMENT_OUT" "issue add-comment output"
pass "issue add-comment"

LABEL_OUT="$(bash "$API_SCRIPT" issue ensure-label PLA-318 openclaw-sre)"
assert_eq $'labeled\tPLA-318\topenclaw-sre' "$LABEL_OUT" "issue ensure-label output"
pass "issue ensure-label"

PROBE_OUT="$(bash "$API_SCRIPT" probe-write PLA-318)"
assert_eq $'probe_ok\tPLA-318' "$PROBE_OUT" "probe-write output"
pass "probe-write"

if env -i PATH="$PATH" LINEAR_CURL_BIN="$LINEAR_CURL_BIN" LINEAR_API_URL="$LINEAR_API_URL" \
  bash "$API_SCRIPT" lookup team Platform >/dev/null 2>&1; then
  fail "lookup should fail without token"
fi
pass "missing token fails"

printf 'all tests passed (%d)\n' "$PASS_COUNT"

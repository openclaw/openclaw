#!/usr/bin/env bash
# Fetch open security issues from openclaw/openclaw, dedupe, and rank by
# importance per references/ranking.md. Emits a JSON array on stdout.
#
# Usage:
#   rank_security_issues.sh [--limit N] [--repo owner/name]
#
# Requires: gh (authenticated), jq

set -euo pipefail

LIMIT=100
REPO="openclaw/openclaw"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2 ;;
    --repo)  REPO="$2";  shift 2 ;;
    -h|--help)
      sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Label variants we treat as "security-related". Pass 1 is intentionally wide;
# Pass 2 (the deep read in the skill) handles demotion and skip decisions.
LABELS=(
  "security"
  "type:security"
  "severity:critical"
  "severity:high"
  "severity:medium"
  "severity:low"
  "ghsa"
  "CVSS"
  "vuln"
  "hardening"
  "auth"
  "crypto"
  "pairing"
)

# Keyword queries — cover terms that commonly appear in security reports whose
# labels do not include "security". Each line is one search query; the helper
# unions the results. Keep queries targeted so the body-match stays precise.
KEYWORD_QUERIES=(
  "security OR vulnerability OR GHSA OR CVSS OR CVE"
  "RCE OR \"remote code execution\" OR \"arbitrary code\""
  "\"auth bypass\" OR \"authentication bypass\" OR \"authorization bypass\""
  "\"privilege escalation\" OR \"privesc\" OR \"sandbox escape\""
  "SSRF OR CSRF OR \"path traversal\" OR \"directory traversal\""
  "\"prototype pollution\" OR deserialization OR \"insecure deserialization\""
  "\"signature\" OR HMAC OR \"token leak\" OR \"secret leak\""
  "\"impersonate\" OR \"spoof\" OR replay OR MITM OR \"man-in-the-middle\""
  "injection AND (command OR shell OR SQL OR header)"
  "TOCTOU OR \"race condition\" AND (auth OR token OR pairing)"
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Source 1: label-driven candidates. gh issue list supports one --label per
# call; union via loop.
: > "$tmp/raw.ndjson"
for label in "${LABELS[@]}"; do
  gh issue list \
    --repo "$REPO" \
    --state open \
    --label "$label" \
    --limit "$LIMIT" \
    --json number,title,body,labels,url,createdAt,updatedAt,author \
    --jq '.[] | @json' >> "$tmp/raw.ndjson" 2>/dev/null || true
done

# Source 2: title+body keyword search for issues the label query would miss.
# This is where reports filed as "bug" or "question" that are actually security
# issues get picked up.
for q in "${KEYWORD_QUERIES[@]}"; do
  gh search issues \
    --repo "$REPO" \
    --state open \
    --match title,body \
    --limit "$LIMIT" \
    --json number,title,body,labels,url,createdAt,updatedAt,author \
    -- "$q" \
    --jq '.[] | @json' >> "$tmp/raw.ndjson" 2>/dev/null || true
done

# Source 3: comment-match pass for long-running threads where the security
# framing only appears after the reporter's first message. Narrower query to
# avoid pulling everything with the word "token."
gh search issues \
  --repo "$REPO" \
  --state open \
  --match comments \
  --limit "$LIMIT" \
  --json number,title,body,labels,url,createdAt,updatedAt,author \
  -- "\"auth bypass\" OR \"signature verification\" OR \"trust boundary\" OR GHSA" \
  --jq '.[] | @json' >> "$tmp/raw.ndjson" 2>/dev/null || true

# Source 4: GHSA cross-reference — advisories that may not have a public issue.
# Emit a synthetic record per advisory so Pass 2 can load it the same way.
gh api "/repos/$REPO/security-advisories?state=triage&per_page=100" --jq '
  .[] | {
    number: (.ghsa_id | ltrimstr("GHSA-") | gsub("-"; "") | ("9"+.)[0:9] | tonumber? // 900000000),
    title: ("[GHSA] " + .summary),
    body:  (.description // ""),
    labels: [{ name: "ghsa" }],
    url:   .html_url,
    createdAt: .published_at,
    updatedAt: .updated_at,
    author: { login: (.credits[0].user.login // "unknown") },
    ghsaId: .ghsa_id
  } | @json
' >> "$tmp/raw.ndjson" 2>/dev/null || true

# Dedupe by number, then score. Scoring is intentionally simple and readable;
# the skill can refine per references/ranking.md before presenting.
jq -s '
  unique_by(.number)
  | map(
      . as $i
      | ($i.labels // []) as $labels
      | ($labels | map(.name) | join(" ")) as $labelstr
      | (
          if ($labelstr | test("severity:critical";"i")) then 9
          elif ($labelstr | test("severity:high";"i")) then 7
          elif ($labelstr | test("severity:medium";"i")) then 5
          elif ($labelstr | test("severity:low";"i")) then 3
          elif (($i.title + " " + ($i.body // "")) | test("RCE|auth bypass|privilege escalation|secret leak";"i")) then 8
          elif (($i.title + " " + ($i.body // "")) | test("DoS|info leak";"i")) then 5
          else 2
          end
        ) as $severity
      | (
          if (($i.body // "") | test("unauth|public (ingress|endpoint)";"i")) then 5
          elif (($i.body // "") | test("paired|operator token";"i")) then 4
          elif (($i.body // "") | test("LAN|loopback";"i")) then 3
          else 2
          end
        ) as $exploit
      | (
          if (($i.title + " " + ($i.body // "")) | test("gateway|all channels|core";"i")) then 5
          elif (($i.title + " " + ($i.body // "")) | test("whatsapp|telegram|slack|discord|imessage";"i")) then 4
          elif (($i.title + " " + ($i.body // "")) | test("matrix|signal|feishu";"i")) then 3
          else 2
          end
        ) as $blast
      | ((now - ($i.createdAt | fromdateiso8601)) / 86400) as $ageDays
      | (
          if $ageDays > 60 then 3
          elif $ageDays > 30 then 2
          elif $ageDays > 0  then 1
          else 0
          end
        ) as $recency
      | (
          if ($labelstr | test("auth|pairing|identity|signature|secret";"i")) then 5
          elif ($labelstr | test("gateway|protocol|trusted-proxy|webhook";"i")) then 4
          elif ($labelstr | test("sandbox|approval|policy";"i")) then 3
          elif ($labelstr | test("channel|outbound|reply";"i")) then 2
          elif ($labelstr | test("provider|usage";"i")) then 1
          else 0
          end
        ) as $surface
      | . + {
          score: {
            total:              ($severity + $exploit + $blast + $recency + $surface),
            severity:           $severity,
            exploitability:     $exploit,
            blastRadius:        $blast,
            recency:            $recency,
            surfaceSensitivity: $surface
          }
        }
    )
  | sort_by(-.score.total, -.score.surfaceSensitivity, -.score.severity, .createdAt)
  | .[:'"$LIMIT"']
' "$tmp/raw.ndjson"

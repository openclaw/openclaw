#!/usr/bin/env bash

rca_prompt_vocab_file() {
  if [[ -n "${RCA_HYPOTHESIS_VOCAB_FILE:-}" ]]; then
    printf '%s\n' "$RCA_HYPOTHESIS_VOCAB_FILE"
    return 0
  fi
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  printf '%s\n' "${script_dir%/}/../rca_hypothesis_ids.v1.json"
}

_rca_prompt_scrub() {
  local raw="${1:-}"
  printf '%s\n' "$raw" \
    | sed -E 's/(authorization:[[:space:]]*bearer[[:space:]]+)[A-Za-z0-9._=-]+/\1<redacted>/Ig' \
    | sed -E 's/(xox[baprs]-)[A-Za-z0-9-]+/\1<redacted>/Ig' \
    | sed -E 's/(xapp-[0-9]+-)[A-Za-z0-9-]+/\1<redacted>/Ig' \
    | sed -E 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/\1<redacted>/Ig' \
    | sed -E 's/AKIA[0-9A-Z]{16}/<redacted-aws-key>/g' \
    | sed -E 's/ASIA[0-9A-Z]{16}/<redacted-aws-sts-key>/g' \
    | sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-<redacted>/g' \
    | sed -E 's/hvs\.[A-Za-z0-9._-]+/hvs.<redacted>/g' \
    | sed -E 's/s\.[A-Za-z0-9._-]+/s.<redacted>/g'
}

# Strip instruction-like tokens from untrusted evidence/memory text.
# Any line containing one of the tokens is dropped.
_strip_instruction_tokens() {
  local text="${1:-}"
  printf '%s\n' "$text" \
    | awk 'BEGIN { IGNORECASE = 1 } !/(You are|Ignore previous|System:|Assistant:|<\||\[INST\]|<\/s>)/'
}

# Truncate large step output using head+tail strategy.
# First 3/4 + last 1/4, marker in the middle.
truncate_step_output() {
  local text="${1:-}"
  local max_bytes="${2:-4096}"
  local len="${#text}"

  if (( len <= max_bytes )); then
    printf '%s\n' "$text"
    return 0
  fi

  local head_bytes tail_bytes
  head_bytes=$(( max_bytes * 3 / 4 ))
  tail_bytes=$(( max_bytes / 4 ))
  local head tail
  head="${text:0:head_bytes}"
  tail="${text:len-tail_bytes:tail_bytes}"
  printf '%s\n[...truncated middle...]\n%s\n' "$head" "$tail"
}

_rca_vocab_json() {
  local vocab_file
  vocab_file="$(rca_prompt_vocab_file)"
  if [[ -f "$vocab_file" ]]; then
    cat "$vocab_file"
  else
    printf '{}\n'
  fi
}

build_rca_prompt() {
  local evidence_bundle="${1:-}"
  local linear_matches="${2:-}"
  local skill_snippets="${3:-}"

  local scrubbed_evidence scrubbed_matches scrubbed_snippets service_context vocab
  scrubbed_evidence="$(_rca_prompt_scrub "$evidence_bundle")"
  scrubbed_matches="$(_rca_prompt_scrub "$linear_matches")"
  scrubbed_snippets="$(_rca_prompt_scrub "$skill_snippets")"

  # Layer 1 context is optional; only include when service-context lib is loaded.
  service_context=""
  if declare -F assemble_service_context >/dev/null 2>&1; then
    service_context="$(assemble_service_context \
      "${K8S_CONTEXT:-unknown}" \
      "${step11_dedup_namespace:-unknown}" \
      "${step11_primary_service:-unknown}")"
    service_context="$(_rca_prompt_scrub "$service_context")"
    service_context="$(_strip_instruction_tokens "$service_context")"
  fi

  vocab="$(_rca_vocab_json)"

  cat <<EOF_PROMPT
You are an SRE incident investigator.

Evidence Bundle:
${scrubbed_evidence}

Service Context:
${service_context}

Similar Past Incidents:
${scrubbed_matches}

Relevant Skill Snippets:
${scrubbed_snippets}

Canonical Taxonomy:
resource_exhaustion, bad_deploy, config_drift, network_connectivity, dependency_failure, cert_or_secret_expiry, scaling_issue, data_issue, unknown

Controlled Vocabulary (JSON):
${vocab}

Return strict JSON with this schema:
{
  "severity": "low|medium|high|critical",
  "canonical_category": "...",
  "summary": "...",
  "root_cause": "...",
  "hypotheses": [
    {
      "canonical_category": "...",
      "hypothesis_id": "category:variant",
      "confidence": 0,
      "description": "...",
      "evidence_keys": ["step01:..."],
      "diagnostic_commands": ["kubectl ..."],
      "remediation": "..."
    }
  ]
}
EOF_PROMPT
}

validate_rca_output() {
  local json_output="${1:-}"

  if ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$json_output"
    return 0
  fi

  local vocab_json
  vocab_json="$(_rca_vocab_json)"

  printf '%s\n' "$json_output" | jq -c --argjson vocab "$vocab_json" '
    def valid_cat($c): ($vocab[$c] != null);
    def norm_cat($c):
      if ($c|type) != "string" or $c == "" then "unknown"
      elif valid_cat($c) then $c
      else "unknown"
      end;

    def norm_h($root_cat):
      . as $h
      | .canonical_category = norm_cat((.canonical_category // $root_cat))
      | if .canonical_category == "unknown" then
          .hypothesis_id = "unknown:insufficient_evidence"
        else
          ((.hypothesis_id // "") | tostring) as $hid
          | ($hid | split(":")) as $parts
          | ($parts[0] // .canonical_category) as $id_cat
          | ($parts[1] // "") as $id_var
          | if $id_cat != .canonical_category then
              .variant_note = $hid
              | .hypothesis_id = (.canonical_category + ":other")
            elif (($vocab[.canonical_category] // []) | index($id_var)) != null then
              .hypothesis_id = (.canonical_category + ":" + $id_var)
            else
              .variant_note = (if $id_var == "" then $hid else $id_var end)
              | .hypothesis_id = (.canonical_category + ":other")
            end
        end;

    .canonical_category = norm_cat(.canonical_category)
    | (.canonical_category) as $root_cat
    | .hypotheses = ((.hypotheses // [])
      | if length == 0 then
          [{
            "canonical_category": $root_cat,
            "hypothesis_id": ($root_cat + ":other"),
            "confidence": (.confidence // 0),
            "description": (.root_cause // "[NEEDS REVIEW]"),
            "evidence_keys": []
          }]
        else . end
      | map(norm_h($root_cat))
    )
  '
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi

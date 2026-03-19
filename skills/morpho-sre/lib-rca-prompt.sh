#!/usr/bin/env bash

rca_prompt_vocab_file() {
  if [[ -n "${RCA_HYPOTHESIS_VOCAB_FILE:-}" ]]; then
    printf '%s\n' "$RCA_HYPOTHESIS_VOCAB_FILE"
    return 0
  fi
  local script_dir
  local candidate
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  for candidate in \
    "${script_dir%/}/rca_hypothesis_ids.v1.json" \
    "${script_dir%/}/../rca_hypothesis_ids.v1.json"; do
    if [[ -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  printf '%s\n' "${script_dir%/}/rca_hypothesis_ids.v1.json"
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

# Extract one named bundle section from the line-delimited evidence bundle.
# Sections end only when the next known section header begins.
_rca_extract_bundle_section() {
  local raw="${1:-}"
  local section="${2:-}"
  [[ -n "$raw" && -n "$section" ]] || {
    printf '\n'
    return 0
  }

  printf '%s\n' "$raw" | awk -v section="$section" '
    BEGIN {
      in_section = 0
      # Keep this header list in sync with sentinel-triage.sh evidence_bundle output.
      split("changes_in_window_summary config_drift config_lineage linear_memory raw_step_outputs reported_context", headers, " ")
      for (i in headers) section_header[headers[i]] = 1
    }
    $0 == section {
      in_section = 1
      next
    }
    in_section && $0 != section && ($0 in section_header) { exit }
    in_section { print }
  '
}

# Classify reported-context lines into a primary symptom plus secondary,
# uncertain, and explicit human-correction lists for the RCA prompt.
_rca_symptom_lists() {
  local raw="${1:-}"
  [[ -n "$raw" ]] || {
    printf 'primary=\nsecondary=\nuncertain=\ncorrections=\n'
    return 0
  }

  printf '%s\n' "$raw" | awk '
    function trim(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      return s
    }
    function add_unique(kind, value,    key) {
      value = trim(value)
      if (value == "") return
      key = kind SUBSEP value
      if (seen[key]++) return
      if (kind == "secondary") secondary[++secondary_count] = value
      else if (kind == "uncertain") uncertain[++uncertain_count] = value
      else if (kind == "corrections") corrections[++correction_count] = value
    }
    BEGIN {
      primary = ""
      correction_primary = ""
    }
    {
      line = trim($0)
      if (line == "") next
      lower = tolower(line)
      # Keep uncertainty narrower than generic "maybe"/"i think" so we do not
      # demote direct symptom reports that happen to contain conversational filler.
      is_uncertain = (lower ~ /(not 100% sure|not sure|uncertain|might be related|maybe related|possibly related|potentially related|seems like|i think it|i guess|query could be wrong|could be wrong)/)
      is_main_issue_correction = (lower ~ /^the (main|actual|real|primary|core) issue([[:space:][:punct:]]|$)/ || lower ~ /^(main|actual|real|primary|core) issue([[:space:][:punct:]]|$)/)
      is_scope_correction = (lower ~ /^the issue is([[:space:][:punct:]]|$)/ || lower ~ /^focus on([[:space:][:punct:]]|$)/ || lower ~ /^correction:/ || lower ~ /^to clarify:/ || lower ~ /^what i meant:/ || lower ~ /^actually([[:space:][:punct:]]|$)/)
      is_problem_statement_correction = (lower ~ /^the (real|primary) problem is([[:space:][:punct:]]|$)/ || lower ~ /^the root cause is([[:space:][:punct:]]|$)/)
      is_apr_correction = (lower ~ /^it should be around([[:space:][:punct:]]|$)/ || lower ~ /^the apr should( actually)? be([[:space:][:punct:]]|$)/ || lower ~ /^expected apr (is|should be)([[:space:][:punct:]]|$)/ || lower ~ /^the apr (is |looks )?(overestimated|underestimated)([[:space:][:punct:]]|$)/ || lower ~ /^apr (is |looks )?(overestimated|underestimated)([[:space:][:punct:]]|$)/)
      is_correction = (is_main_issue_correction || is_scope_correction || is_problem_statement_correction || is_apr_correction)

      if (is_correction) {
        add_unique("corrections", line)
        correction_primary = line
        next
      }

      if (is_uncertain) {
        add_unique("uncertain", line)
        next
      }

      if (primary == "") {
        primary = line
      } else {
        add_unique("secondary", line)
      }
    }
    END {
      if (correction_primary != "" && primary != "" && primary != correction_primary) {
        add_unique("secondary", primary)
      }
      if (correction_primary != "") primary = correction_primary

      printf "primary=%s\n", primary

      printf "secondary="
      for (i = 1; i <= secondary_count; i++) {
        if (i > 1) printf " | "
        printf "%s", secondary[i]
      }
      printf "\n"

      printf "uncertain="
      for (i = 1; i <= uncertain_count; i++) {
        if (i > 1) printf " | "
        printf "%s", uncertain[i]
      }
      printf "\n"

      printf "corrections="
      for (i = 1; i <= correction_count; i++) {
        if (i > 1) printf " | "
        printf "%s", corrections[i]
      }
      printf "\n"
    }
  '
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
  local reported_context symptom_lists primary_reported_symptom secondary_clues uncertain_clues explicit_human_corrections
  scrubbed_evidence="$(_rca_prompt_scrub "$evidence_bundle")"
  scrubbed_evidence="$(_strip_instruction_tokens "$scrubbed_evidence")"
  scrubbed_matches="$(_rca_prompt_scrub "$linear_matches")"
  scrubbed_snippets="$(_rca_prompt_scrub "$skill_snippets")"
  reported_context="$(_rca_extract_bundle_section "$scrubbed_evidence" "reported_context")"
  reported_context="$(_strip_instruction_tokens "$reported_context")"
  symptom_lists="$(_rca_symptom_lists "$reported_context")"
  primary_reported_symptom="$(printf '%s\n' "$symptom_lists" | awk -F= '$1=="primary"{sub(/^[^=]*=/,""); print $0; exit}')"
  secondary_clues="$(printf '%s\n' "$symptom_lists" | awk -F= '$1=="secondary"{sub(/^[^=]*=/,""); print $0; exit}')"
  uncertain_clues="$(printf '%s\n' "$symptom_lists" | awk -F= '$1=="uncertain"{sub(/^[^=]*=/,""); print $0; exit}')"
  explicit_human_corrections="$(printf '%s\n' "$symptom_lists" | awk -F= '$1=="corrections"{sub(/^[^=]*=/,""); print $0; exit}')"

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

Primary Reported Symptom:
${primary_reported_symptom:-unknown}

Secondary Clues:
${secondary_clues:-none}

Uncertain Clues:
${uncertain_clues:-none}

Explicit Human Corrections:
${explicit_human_corrections:-none}

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

Rules:
- Identify the primary reported symptom first; keep adjacent errors and uncertain clues as secondary until they explain that symptom.
- Treat uncertain clues as secondary until they explain the primary reported symptom.
- If a human correction conflicts with an earlier clue, prefer the human correction and record the old theory as disproved or secondary.
- For rewards/provider incidents, do not elevate stale-row cleanup to root cause unless the provider entity liveness and the active code path both match.

Return strict JSON with this schema:
{
  "severity": "low|medium|high|critical",
  "canonical_category": "...",
  "summary": "...",
  "root_cause": "...",
  "primary_reported_symptom": "...",
  "secondary_clues": ["..."],
  "uncertain_clues": ["..."],
  "explicit_human_corrections": ["..."],
  "explains_primary_symptom": true,
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
    def norm_arr($v):
      if $v == null then []
      elif ($v|type) == "array" then
        $v
        | map(
            if type == "string" then .
            else tostring
            end
          )
        | map(select(. != ""))
      elif ($v|type) == "string" then
        if $v == "" then [] else [$v] end
      else
        [($v|tostring)]
      end;
    def norm_bool($v):
      if $v == true then true
      elif $v == false or $v == null then false
      elif ($v|type) == "string" then
        (($v | ascii_downcase) as $s | ($s == "true" or $s == "yes" or $s == "1"))
      elif ($v|type) == "number" then
        ($v != 0)
      else false
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

    (.chain_metadata // {}) as $cm
    | ($cm.evidence_triage // {}) as $et
    | ($cm.cross_review // {}) as $cr
    | .canonical_category = norm_cat(.canonical_category)
    | .primary_reported_symptom = ((.primary_reported_symptom // $et.primary_reported_symptom // "") | tostring)
    | .secondary_clues = norm_arr(.secondary_clues // $et.secondary_clues)
    | .uncertain_clues = norm_arr(.uncertain_clues // $et.uncertain_clues)
    | .explicit_human_corrections = norm_arr(.explicit_human_corrections // $et.explicit_human_corrections)
    | .explains_primary_symptom = norm_bool(
        if .explains_primary_symptom != null then .explains_primary_symptom
        elif $cr.explains_primary_symptom != null then $cr.explains_primary_symptom
        elif $et.explains_primary_symptom != null then $et.explains_primary_symptom
        else false
        end
      )
    | . as $root
    | (.canonical_category) as $root_cat
    | .hypotheses = (((.hypotheses // [])) as $hyps
      | if ($hyps | length) == 0 then
          [{
            "canonical_category": $root_cat,
            "hypothesis_id": ($root_cat + ":other"),
            "confidence": ($root.confidence // 0),
            "description": ($root.root_cause // "[NEEDS REVIEW]"),
            "evidence_keys": []
          }]
        else $hyps end
      | map(norm_h($root_cat))
    )
  '
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  printf 'library script; source this file\n' >&2
fi

#!/usr/bin/env bash
set -euo pipefail
# GO/NO-GO Gate: health + alpha (repo portable)
# Behavior:
# - Always run health first.
# - Run alpha once with defaults.
# - If alpha FAILs due to Anthropic unavailability, retry alpha once with a Codex reviewer override.
# - Never mask other failures.

export KEEP_TMP="${KEEP_TMP:-1}"

echo "== gate: health =="
bash ops/scripts/cyborg-run health

echo "== gate: alpha (default) =="
alpha_log="$(mktemp /tmp/gate-alpha.XXXXXX.log)"
set +e
bash ops/scripts/cyborg-run alpha 2>&1 | tee "$alpha_log"
alpha_rc=${PIPESTATUS[0]}
set -e

if [[ "$alpha_rc" -eq 0 ]]; then
  exit 0
fi

# If operator already set reviewer overrides, do not retry (respect explicit intent).
if [[ -n "${ALPHA_REVIEWER_AGENT:-}" || -n "${ALPHA_REVIEWER_PROVIDER:-}" || -n "${ALPHA_REVIEWER_MODEL:-}" ]]; then
  echo "[gate][FAIL] alpha failed (rc=$alpha_rc) with explicit ALPHA_REVIEWER_* set; no auto-retry"
  exit "$alpha_rc"
fi

# Retry only on clear Anthropic-unavailable signals.
anthropic_down_patterns='No available auth profile for anthropic|Provider anthropic is in cooldown|cooldown|rate_limit|temporarily overloaded|model_not_found|FailoverError.*anthropic|provider:anthropic'
if rg -n -i "$anthropic_down_patterns" "$alpha_log" >/dev/null 2>&1; then
  echo "[gate][WARN] alpha failed due to Anthropic unavailability; retrying once with Codex reviewer override"
  export ALPHA_REVIEWER_AGENT="exec-04"
  export ALPHA_REVIEWER_PROVIDER="openai-codex"
  export ALPHA_REVIEWER_MODEL="gpt-5.3-codex"
  echo "== gate: alpha (retry with codex reviewer) =="
  bash ops/scripts/cyborg-run alpha
  exit 0
fi

echo "[gate][FAIL] alpha failed (rc=$alpha_rc); not an Anthropic-unavailable case; no auto-retry"
exit "$alpha_rc"

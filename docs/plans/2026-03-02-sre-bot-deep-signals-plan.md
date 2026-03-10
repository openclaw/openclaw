# SRE Bot "Deep Signals" Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the SRE bot from 7 to 12 evidence pipeline steps, add persistent incident identity, LLM-synthesized RCA, Linear incident memory, and a cron fallback trigger — making it a context-aware on-call assistant.

**Architecture:** The existing `sentinel-triage.sh` gains per-step timeouts, new signal scripts (Prometheus, ArgoCD, certs, AWS), and a PVC-backed incident state file (`active-incidents.tsv`). A cron CronJob runs triage independently of Slack. Step 11 replaces heuristic scoring with Codex LLM synthesis (single-model default), with optional dual-model (Codex+Claude) cross-review. Linear tickets follow the Eng Post-Mortem template with pattern detection.

**Tech Stack:** Bash (triage scripts), Kubernetes/Helm (deployment), Linear API (ticketing), OpenAI Codex API (RCA), Anthropic Claude API (dual-mode RCA), Prometheus PromQL, ArgoCD API, AWS CLI

**Design doc:** `docs/plans/2026-03-02-sre-bot-deep-signals-design.md` (v34) — all behavioral details, edge cases, and invariants are defined there. This plan references section names from the design doc rather than duplicating spec text.

**Phase dependency graph:**

```
Phase 1 (foundation: timeouts, Prometheus, cron, spool, redaction)
  ├── Phase 2 (ArgoCD — independent)
  ├── Phase 3 (Certs — independent)
  ├── Phase 4 (AWS — independent)
  └── Phase 5 (Incident identity, Linear memory — depends on Phase 1 PVC/spool)
        ├── Phase 6a (Single-model LLM RCA — depends on Phase 5 incident_id)
        │     └── Phase 6b (Dual-model RCA — conditional, depends on 6a data)
        ├── Phase 7 (Slack thread archival — depends on Phase 5 incident_id)
        └── Phase 8 (Metrics dashboard — depends on Phase 5+6a)
```

---

## Phase 1: Per-Step Timeout Infrastructure + Prometheus Metric Trends + Cron Trigger Fallback

**Ref:** Design doc sections "Per-Step Timeout Budget", "New Step 3: Prometheus Metric Trends", Phase 1 implementation notes, "Redaction Contract"

Phase 1 introduces three foundational capabilities that all later phases reuse: (1) per-step timeout+skip framework in sentinel-triage.sh, (2) Prometheus trend signals as a new Step 3, (3) a Kubernetes CronJob that runs triage independently of Slack with spool-based dedup.

---

### Task 1.1: Add per-step timeout helper function to sentinel-triage.sh

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh` (add helper near top, after variable declarations ~line 80)

**Step 1: Write the timeout helper function**

Add a `run_step` function that wraps each pipeline step with a configurable timeout. On timeout, it sets the step's output to a `status: timeout` marker and continues.

```bash
# --- Per-step timeout infrastructure (Phase 1) ---
# Usage: run_step <step_number> <step_name> <timeout_seconds> <required: yes|no> <command...>
# Sets STEP_STATUS_<N>=ok|timeout|error and captures output in STEP_OUTPUT_<N>
run_step() {
  local step_num="$1" step_name="$2" timeout_sec="$3" required="$4"
  shift 4
  local output_var="STEP_OUTPUT_${step_num}"
  local status_var="STEP_STATUS_${step_num}"
  local start_ms
  start_ms=$(date +%s%3N 2>/dev/null || echo 0)

  local output=""
  local exit_code=0
  output=$(timeout "${timeout_sec}s" bash -c "$*" 2>&1) || exit_code=$?

  local end_ms
  end_ms=$(date +%s%3N 2>/dev/null || echo 0)
  local elapsed_ms=$(( end_ms - start_ms ))

  if [[ $exit_code -eq 124 ]]; then
    # timeout(1) returns 124 on timeout
    eval "${status_var}=timeout"
    eval "${output_var}=''"
    log "Step ${step_num} (${step_name}): TIMEOUT after ${timeout_sec}s"
    STEP_LATENCY["${step_num}"]="${elapsed_ms}"
    if [[ "$required" == "yes" ]]; then
      log "Step ${step_num} (${step_name}): REQUIRED step timed out — aborting pipeline"
      return 1
    fi
    return 0
  elif [[ $exit_code -ne 0 ]]; then
    eval "${status_var}=error"
    eval "${output_var}=''"
    log "Step ${step_num} (${step_name}): ERROR (exit ${exit_code})"
    STEP_LATENCY["${step_num}"]="${elapsed_ms}"
    if [[ "$required" == "yes" ]]; then
      log "Step ${step_num} (${step_name}): REQUIRED step failed — aborting pipeline"
      return 1
    fi
    return 0
  else
    eval "${status_var}=ok"
    printf -v "${output_var}" '%s' "$output"
    STEP_LATENCY["${step_num}"]="${elapsed_ms}"
    return 0
  fi
}

# Associative array for step latency tracking
declare -A STEP_LATENCY
```

**Step 2: Write a local test for the timeout helper**

Create `deploy/skills/morpho-sre/scripts/test-run-step.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Source just the function (extract it or source the whole script with a guard)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Minimal log function for testing
log() { echo "[test] $*"; }

# Paste or source the run_step function here for isolated testing
declare -A STEP_LATENCY
# ... (function body from above)

# Test 1: Successful step
run_step 1 "fast_step" 5 no 'echo "hello"'
[[ "$STEP_STATUS_1" == "ok" ]] || { echo "FAIL: expected ok, got $STEP_STATUS_1"; exit 1; }
[[ "$STEP_OUTPUT_1" == "hello" ]] || { echo "FAIL: expected 'hello', got '$STEP_OUTPUT_1'"; exit 1; }
echo "PASS: successful step"

# Test 2: Timeout step
run_step 2 "slow_step" 1 no 'sleep 10; echo "late"'
[[ "$STEP_STATUS_2" == "timeout" ]] || { echo "FAIL: expected timeout, got $STEP_STATUS_2"; exit 1; }
[[ -z "$STEP_OUTPUT_2" ]] || { echo "FAIL: expected empty output on timeout"; exit 1; }
echo "PASS: timeout step"

# Test 3: Error step (non-required)
run_step 3 "error_step" 5 no 'exit 1'
[[ "$STEP_STATUS_3" == "error" ]] || { echo "FAIL: expected error, got $STEP_STATUS_3"; exit 1; }
echo "PASS: error step (non-required)"

# Test 4: Required step failure aborts
if run_step 4 "required_fail" 5 yes 'exit 1'; then
  echo "FAIL: required step failure should return non-zero"
  exit 1
fi
echo "PASS: required step failure aborts"

# Test 5: Required step timeout aborts
if run_step 5 "required_timeout" 1 yes 'sleep 10'; then
  echo "FAIL: required step timeout should return non-zero"
  exit 1
fi
echo "PASS: required step timeout aborts"

echo ""
echo "All run_step tests passed."
```

**Step 3: Run the test**

Run: `bash deploy/skills/morpho-sre/scripts/test-run-step.sh`
Expected: All 5 tests pass

**Step 4: Commit**

```bash
scripts/committer "feat(sre): add per-step timeout infrastructure to sentinel-triage" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh \
  deploy/skills/morpho-sre/scripts/test-run-step.sh
```

---

### Task 1.2: Wrap existing triage steps with run_step timeouts

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Context:** The existing script runs steps sequentially as inline bash blocks. Each step needs to be wrapped with `run_step` using the timeout budget from the design doc:

| Step               | Timeout | Required |
| ------------------ | ------- | -------- |
| 1: Pod & Deploy    | 8s      | yes      |
| 2: Events & Alerts | 8s      | yes      |
| 5: Log Signals     | 10s     | no       |
| 8: Image-to-Repo   | 5s      | no       |
| 9: Revisions       | 5s      | no       |
| 10: CI/CD          | 5s      | no       |

**Step 1: Identify existing step boundaries in sentinel-triage.sh**

Read the script and locate the code blocks for each existing step. The script currently runs inline kubectl/API calls without timeout wrappers. Identify the start/end of each logical step.

**Step 2: Refactor each existing step into a callable function**

Extract each step's logic into a named function (e.g., `step_01_pod_deploy()`, `step_02_events_alerts()`, etc.) and wrap the call with `run_step`:

```bash
step_01_pod_deploy() {
  # ... existing pod & deploy state collection logic ...
}

step_02_events_alerts() {
  # ... existing events & prometheus alerts logic ...
}

step_05_log_signals() {
  # ... existing log signals logic ...
}

step_08_image_repo() {
  # ... existing image-to-repo mapping logic ...
}

step_09_revisions() {
  # ... existing deployed revisions logic ...
}

step_10_ci_signals() {
  # ... existing CI/CD signals logic ...
}
```

Then in the main pipeline:

```bash
# Required steps — abort on failure
run_step 01 "pod_deploy" 8 yes 'step_01_pod_deploy' || {
  emit_abort_output "Core cluster signals unavailable (Step 1)"
  exit 0
}
run_step 02 "events_alerts" 8 yes 'step_02_events_alerts' || {
  emit_abort_output "Core cluster signals unavailable (Step 2)"
  exit 0
}

# Optional enrichment steps — skip on timeout/error
run_step 05 "log_signals" 10 no 'step_05_log_signals'
run_step 08 "image_repo" 5 no 'step_08_image_repo'
run_step 09 "revisions" 5 no 'step_09_revisions'
run_step 10 "ci_signals" 5 no 'step_10_ci_signals'
```

**Step 3: Add step status to the meta output section**

Append step execution status to the `=== meta ===` output section:

```bash
echo "=== step_status ==="
echo -e "step\tstatus\tlatency_ms"
for step_num in 01 02 05 08 09 10; do
  local svar="STEP_STATUS_${step_num}"
  echo -e "${step_num}\t${!svar:-skipped}\t${STEP_LATENCY[${step_num}]:-0}"
done
```

**Step 4: Test that existing triage output is unchanged for healthy clusters**

Run: `bash deploy/skills/morpho-sre/scripts/sentinel-triage.sh 2>/dev/null | head -60`
Expected: Same output sections as before, plus new `=== step_status ===` section

**Step 5: Commit**

```bash
scripts/committer "refactor(sre): wrap existing triage steps with per-step timeouts" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 1.3: Create prometheus-trends.sh (Step 3)

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/prometheus-trends.sh`

**Ref:** Design doc "New Step 3: Prometheus Metric Trends"

**Step 1: Write a test script that validates expected output format**

Create `deploy/skills/morpho-sre/scripts/test-prometheus-trends.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Test: output format validation
# Run prometheus-trends.sh with a mock/real Prometheus and verify TSV columns

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Test 1: Missing PROMETHEUS_URL → empty output, exit 0
unset PROMETHEUS_URL
output=$("$SCRIPT_DIR/prometheus-trends.sh" 2>/dev/null) || true
if [[ -n "$output" ]]; then
  echo "FAIL: expected empty output when PROMETHEUS_URL unset"
  exit 1
fi
echo "PASS: empty output when PROMETHEUS_URL unset"

# Test 2: With PROMETHEUS_URL set, verify TSV header
export PROMETHEUS_URL="http://prometheus-stack-kube-prom-prometheus.monitoring:9090"
export SCOPE_NAMESPACES="morpho-dev"
output=$("$SCRIPT_DIR/prometheus-trends.sh" 2>/dev/null) || true
if [[ -n "$output" ]]; then
  header=$(echo "$output" | head -1)
  expected_header=$'metric_name\tpod\tcurrent_value\t6h_trend\t24h_trend\tthreshold_proximity\tstatus'
  if [[ "$header" != "$expected_header" ]]; then
    echo "FAIL: unexpected header: $header"
    exit 1
  fi
  echo "PASS: correct TSV header"
else
  echo "SKIP: no Prometheus data available (expected in non-cluster env)"
fi

echo ""
echo "All prometheus-trends tests passed."
```

**Step 2: Write prometheus-trends.sh**

```bash
#!/usr/bin/env bash
# Step 3: Prometheus Metric Trends
# Queries key metrics over 1h/6h/24h windows via PromQL.
# Output: TSV with columns: metric_name, pod, current_value, 6h_trend, 24h_trend, threshold_proximity, status
set -euo pipefail

PROMETHEUS_URL="${PROMETHEUS_URL:-}"
SCOPE_NAMESPACES="${SCOPE_NAMESPACES:-morpho-dev}"

if [[ -z "$PROMETHEUS_URL" ]]; then
  exit 0
fi

# Convert comma-separated namespaces to regex alternation
ns_regex=$(echo "$SCOPE_NAMESPACES" | tr ',' '|')

query_prometheus() {
  local query="$1"
  local timeout="${2:-10}"
  curl -sf --max-time "$timeout" \
    "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode "query=${query}" 2>/dev/null | \
    jq -r '.data.result[]? | [.metric.pod // .metric.instance // "cluster", (.value[1] // "0")] | @tsv' 2>/dev/null || true
}

query_prometheus_range() {
  local query="$1" duration="$2" step="$3"
  local end
  end=$(date +%s)
  local start=$(( end - duration ))
  curl -sf --max-time 10 \
    "${PROMETHEUS_URL}/api/v1/query_range" \
    --data-urlencode "query=${query}" \
    --data-urlencode "start=${start}" \
    --data-urlencode "end=${end}" \
    --data-urlencode "step=${step}" 2>/dev/null || true
}

# Header
echo -e "metric_name\tpod\tcurrent_value\t6h_trend\t24h_trend\tthreshold_proximity\tstatus"

# Container memory working set vs limit
while IFS=$'\t' read -r pod current; do
  [[ -z "$pod" ]] && continue
  # Get memory limit for this pod
  limit=$(curl -sf --max-time 5 \
    "${PROMETHEUS_URL}/api/v1/query" \
    --data-urlencode "query=container_spec_memory_limit_bytes{pod=\"${pod}\",namespace=~\"${ns_regex}\",container!=\"\"} > 0" 2>/dev/null | \
    jq -r '.data.result[0]?.value[1] // "0"' 2>/dev/null || echo "0")

  if [[ "$limit" != "0" && -n "$current" ]]; then
    # Calculate proximity as percentage
    proximity=$(awk "BEGIN { if ($limit > 0) printf \"%.1f\", ($current/$limit)*100; else print \"0\" }")
    status="ok"
    if (( $(awk "BEGIN { print ($proximity >= 90) }") )); then
      status="critical"
    elif (( $(awk "BEGIN { print ($proximity >= 80) }") )); then
      status="warning"
    fi
    # 6h trend: check if memory grew >10%
    echo -e "container_memory_working_set\t${pod}\t${current}\t-\t-\t${proximity}%\t${status}"
  fi
done < <(query_prometheus "sum by (pod) (container_memory_working_set_bytes{namespace=~\"${ns_regex}\",container!=\"\"})")

# Pod restart rate
while IFS=$'\t' read -r pod restarts; do
  [[ -z "$pod" ]] && continue
  status="ok"
  if (( $(awk "BEGIN { print ($restarts >= 5) }") )); then
    status="critical"
  elif (( $(awk "BEGIN { print ($restarts >= 2) }") )); then
    status="warning"
  fi
  [[ "$status" != "ok" ]] && echo -e "pod_restart_rate_1h\t${pod}\t${restarts}\t-\t-\t-\t${status}"
done < <(query_prometheus "increase(kube_pod_container_status_restarts_total{namespace=~\"${ns_regex}\"}[1h])")

# CPU throttling
while IFS=$'\t' read -r pod throttled; do
  [[ -z "$pod" ]] && continue
  status="ok"
  if (( $(awk "BEGIN { print ($throttled >= 50) }") )); then
    status="critical"
  elif (( $(awk "BEGIN { print ($throttled >= 25) }") )); then
    status="warning"
  fi
  [[ "$status" != "ok" ]] && echo -e "cpu_throttle_pct\t${pod}\t${throttled}%\t-\t-\t-\t${status}"
done < <(query_prometheus "sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace=~\"${ns_regex}\"}[5m]) / rate(container_cpu_cfs_periods_total{namespace=~\"${ns_regex}\"}[5m]) * 100)")

# HTTP 5xx error rate (if available)
while IFS=$'\t' read -r pod rate; do
  [[ -z "$pod" ]] && continue
  status="ok"
  if (( $(awk "BEGIN { print ($rate >= 5) }") )); then
    status="critical"
  elif (( $(awk "BEGIN { print ($rate >= 1) }") )); then
    status="warning"
  fi
  [[ "$status" != "ok" ]] && echo -e "http_5xx_rate_pct\t${pod}\t${rate}%\t-\t-\t-\t${status}"
done < <(query_prometheus "sum by (pod) (rate(http_requests_total{namespace=~\"${ns_regex}\",code=~\"5..\"}[1h]) / rate(http_requests_total{namespace=~\"${ns_regex}\"}[1h]) * 100)" 2>/dev/null || true)
```

**Step 3: Run the format test**

Run: `bash deploy/skills/morpho-sre/scripts/test-prometheus-trends.sh`
Expected: PASS for unset URL; PASS or SKIP for header check

**Step 4: Make executable and commit**

```bash
chmod +x deploy/skills/morpho-sre/scripts/prometheus-trends.sh
chmod +x deploy/skills/morpho-sre/scripts/test-prometheus-trends.sh
scripts/committer "feat(sre): add prometheus-trends.sh (Step 3)" \
  deploy/skills/morpho-sre/scripts/prometheus-trends.sh \
  deploy/skills/morpho-sre/scripts/test-prometheus-trends.sh
```

---

### Task 1.4: Integrate Step 3 into sentinel-triage.sh

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Step 1: Add Step 3 invocation after Step 2**

```bash
# Step 3: Prometheus Metric Trends (NEW — Phase 1)
step_03_prometheus_trends() {
  "${SCRIPT_DIR}/prometheus-trends.sh"
}

run_step 03 "prometheus_trends" 10 no 'step_03_prometheus_trends'
```

**Step 2: Add Step 3 output to the evidence bundle**

After existing output sections, add:

```bash
if [[ "${STEP_STATUS_03}" == "ok" && -n "${STEP_OUTPUT_03}" ]]; then
  echo "=== prometheus_trends ==="
  echo "$STEP_OUTPUT_03"
fi
```

**Step 3: Wire Prometheus trend signals into severity scoring**

Add trend signals (critical/warning status from prometheus-trends.sh) as additional scoring inputs to the existing severity calculation:

```bash
# Count critical/warning Prometheus trend signals
prom_critical=$(echo "$STEP_OUTPUT_03" | awk -F'\t' '$7=="critical"' | wc -l)
prom_warning=$(echo "$STEP_OUTPUT_03" | awk -F'\t' '$7=="warning"' | wc -l)
# Add to severity: each critical trend +15, each warning +5
severity_score=$(( severity_score + prom_critical * 15 + prom_warning * 5 ))
```

**Step 4: Update step_status output to include Step 3**

Add `03` to the step_status loop.

**Step 5: Test with PROMETHEUS_URL set**

Run: `PROMETHEUS_URL=http://prometheus-stack-kube-prom-prometheus.monitoring:9090 bash deploy/skills/morpho-sre/scripts/sentinel-triage.sh 2>/dev/null | grep -A5 "prometheus_trends"`

Expected: Either `=== prometheus_trends ===` section with data, or step_status showing `03 timeout` or `03 ok`

**Step 6: Test without PROMETHEUS_URL (graceful skip)**

Run: `unset PROMETHEUS_URL; bash deploy/skills/morpho-sre/scripts/sentinel-triage.sh 2>/dev/null | grep "step_status" -A10`

Expected: Step 03 shows `ok` or `skipped` (empty output is valid)

**Step 7: Commit**

```bash
scripts/committer "feat(sre): integrate Prometheus trends as Step 3 in triage pipeline" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 1.5: Add PROMETHEUS_URL to deploy-dev.sh and Helm values

**Files:**

- Modify: `deploy/eks/deploy-dev.sh` (add PROMETHEUS_URL env var)
- Modify: `deploy/eks/openclaw-sre-dev.yaml` (add env var to deployment template)
- Modify: `deploy/eks/charts/openclaw-sre/templates/deployment.yaml` (add env var)

**Step 1: Add PROMETHEUS_URL to deploy-dev.sh**

Near the existing environment variable declarations:

```bash
PROMETHEUS_URL="${PROMETHEUS_URL:-http://prometheus-stack-kube-prom-prometheus.monitoring:9090}"
```

And in the secret/configmap creation section, add to the env injection.

**Step 2: Add to openclaw-sre-dev.yaml deployment template**

In the main container's env section:

```yaml
- name: PROMETHEUS_URL
  value: "http://prometheus-stack-kube-prom-prometheus.monitoring:9090"
```

**Step 3: Add to Helm deployment template**

In `deploy/eks/charts/openclaw-sre/templates/deployment.yaml`, add the env var.

**Step 4: Commit**

```bash
scripts/committer "feat(deploy): wire PROMETHEUS_URL into EKS deployment" \
  deploy/eks/deploy-dev.sh \
  deploy/eks/openclaw-sre-dev.yaml \
  deploy/eks/charts/openclaw-sre/templates/deployment.yaml
```

---

### Task 1.6: Extend redaction scrubber with new patterns

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh` (extend `sanitize_signal_line`)

**Ref:** Design doc "Redaction Contract"

**Step 1: Write redaction regression test**

Create `deploy/skills/morpho-sre/scripts/test-redaction.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source the sanitize_signal_line function from sentinel-triage.sh
# (We'll need to extract it or source with a test guard)

# Test cases: input → expected output pattern
declare -A tests
tests["Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6Ik"]="Bearer <redacted>"
tests["xoxb-1234567890-abcdef"]="xoxb-<redacted>"
tests["xapp-1-A234567890-abcdef"]="xapp-<redacted>"
tests["ghp_ABCDEFGHIJKLMNOPqrstuvwxyz0123"]="ghp_<redacted>" # pragma: allowlist secret
tests["github_pat_11AABBCC22ddeeffgg"]="github_pat_<redacted>"
tests["AKIAIOSFODNN7EXAMPLE"]="AKIA<redacted>" # pragma: allowlist secret
tests["sk-ant-api03-abcdefghijklmnop"]="sk-ant-<redacted>"
tests["hvs.CAESIJzGZ"]="hvs.<redacted>"
tests["password=mysecret123"]="password=<redacted>" # pragma: allowlist secret
tests['"token":"abc123xyz"']='"token":"<redacted>"'
tests["api_key: sk_live_abcdefgh"]="api_key: <redacted>"
tests["aws_secret_access_key=wJalrXUtnFEMI"]="aws_secret_access_key=<redacted>"

pass=0
fail=0
for input in "${!tests[@]}"; do
  expected="${tests[$input]}"
  actual=$(echo "$input" | sanitize_signal_line)
  if [[ "$actual" == *"$expected"* ]] || [[ "$actual" != *"$input"* ]]; then
    ((pass++))
  else
    echo "FAIL: input='$input' expected pattern='$expected' got='$actual'"
    ((fail++))
  fi
done

# False-positive tests: these must NOT be redacted
safe_inputs=(
  "pod/api-server-7b5f8c9d4-xk2lm"
  "namespace: morpho-dev"
  "container_memory_working_set_bytes 1234567890"
  "CrashLoopBackOff"
  "deployment.apps/redis-cache"
)
for input in "${safe_inputs[@]}"; do
  actual=$(echo "$input" | sanitize_signal_line)
  if [[ "$actual" != "$input" ]]; then
    echo "FAIL (false positive): input='$input' was modified to='$actual'"
    ((fail++))
  else
    ((pass++))
  fi
done

echo ""
echo "Redaction tests: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]] || exit 1
```

**Step 2: Verify existing scrubber patterns and extend**

Read the current `sanitize_signal_line` function in sentinel-triage.sh. Add missing patterns from the design doc:

- Anthropic keys: `sk-ant-<redacted>`
- Vault tokens: `hvs.<redacted>`, `s.<redacted>`
- Generic key-value patterns (JSON, YAML variants)
- Base64 cert material (>40 char base64 blobs in cert context)

**Step 3: Run the redaction tests**

Run: `bash deploy/skills/morpho-sre/scripts/test-redaction.sh`
Expected: All pass, 0 fail

**Step 4: Commit**

```bash
scripts/committer "feat(sre): extend redaction scrubber with Anthropic, Vault, and generic secret patterns" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh \
  deploy/skills/morpho-sre/scripts/test-redaction.sh
```

---

### Task 1.7: Create cron trigger CronJob manifest

**Files:**

- Create: `deploy/eks/charts/openclaw-sre/templates/cronjob.yaml`
- Modify: `deploy/eks/charts/openclaw-sre/values.yaml` (add cron config)

**Ref:** Design doc "Cron trigger fallback" in Phase 1

**Step 1: Write the CronJob template**

```yaml
{{- if .Values.cron.enabled }}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ include "openclaw-sre.fullname" . }}-heartbeat-cron
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "openclaw-sre.labels" . | nindent 4 }}
    component: heartbeat-cron
spec:
  schedule: "*/30 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      activeDeadlineSeconds: 120
      template:
        spec:
          serviceAccountName: {{ .Values.serviceAccount.name | default "incident-readonly-agent" }}
          restartPolicy: Never
          {{- if .Values.cron.nodeAffinity }}
          affinity:
            podAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    app: {{ include "openclaw-sre.fullname" . }}
                topologyKey: kubernetes.io/hostname
          {{- end }}
          containers:
          - name: heartbeat-cron
            image: {{ .Values.image.uri }}
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              INCIDENT_STATE_DIR="${INCIDENT_STATE_DIR:-/home/node/.openclaw/state/sentinel}"
              SPOOL_DIR="${INCIDENT_STATE_DIR}/spool"
              mkdir -p "$SPOOL_DIR"

              # Run triage
              output=$(/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh 2>/dev/null) || true

              # Extract dedup key components
              ns=$(echo "$output" | awk -F'\t' '/^namespace_scope/ {print $2}')
              cat_line=$(echo "$output" | awk -F'\t' '/^=== ranked_hypotheses ===/{found=1;next} found && NR>1{print $3;exit}')
              primary_category="${cat_line:-unknown}"
              # workload_hash8: first 8 hex of sha256 of sorted pod prefixes
              pods=$(echo "$output" | awk -F'\t' '/^=== top_pod_issues ===/{found=1;next} found && /^===/{exit} found{print $1}' | sort | tr '\n' '|')
              workload_hash8=$(printf '%s' "$pods" | sha256sum | cut -c1-8)
              [[ -z "$workload_hash8" ]] && workload_hash8="empty000"
              # date_hour_half: round to 30m bucket
              minute=$(date -u +%M)
              half=$(( minute < 30 ? 0 : 30 ))
              date_hour_half="$(date -u +%Y%m%d%H)$(printf '%02d' $half)"

              dedup_key=$(printf '%s' "${ns}${primary_category}${workload_hash8}${date_hour_half}" | sha256sum | cut -c1-64)
              ts=$(date -u +%Y%m%dT%H%M%S)
              spool_file="${SPOOL_DIR}/triage-${dedup_key}-${ts}.json"

              # Check if already acked for this key
              if [[ -f "${SPOOL_DIR}/${dedup_key}.ack" ]]; then
                echo "Spool already acked for dedup_key=${dedup_key}, skipping"
                exit 0
              fi

              # Write spool file
              echo "$output" > "$spool_file"
              sync "$spool_file"

              # Write cron healthcheck sentinel
              touch "${INCIDENT_STATE_DIR}/.cron-healthcheck-$(date -u +%s)"

              echo "Spool written: ${spool_file}"
            env:
            {{- include "openclaw-sre.env" . | nindent 12 }}
            volumeMounts:
            - name: openclaw-home
              mountPath: /home/node/.openclaw
          volumes:
          - name: openclaw-home
            persistentVolumeClaim:
              claimName: {{ include "openclaw-sre.fullname" . }}-pvc
{{- end }}
```

**Step 2: Add cron values**

In `values.yaml`:

```yaml
cron:
  enabled: true
  nodeAffinity: true # Pin to same node as main pod for RWO PVC
```

**Step 3: Validate template renders**

Run: `helm template test deploy/eks/charts/openclaw-sre/ --set cron.enabled=true --set image.uri=test:latest 2>&1 | grep -A5 "CronJob"`
Expected: CronJob manifest renders without errors

**Step 4: Commit**

```bash
scripts/committer "feat(sre): add CronJob for Slack-independent heartbeat fallback" \
  deploy/eks/charts/openclaw-sre/templates/cronjob.yaml \
  deploy/eks/charts/openclaw-sre/values.yaml
```

---

### Task 1.8: Add spool dedup + coalescing logic to sentinel-triage.sh

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Ref:** Design doc "Pre-Phase-5 dedup", "Spool posting atomicity", "Spool lifecycle"

**Step 1: Add spool directory management**

At the top of sentinel-triage.sh, add spool directory setup:

```bash
INCIDENT_STATE_DIR="${INCIDENT_STATE_DIR:-/home/node/.openclaw/state/sentinel}"
SPOOL_DIR="${INCIDENT_STATE_DIR}/spool"
mkdir -p "$SPOOL_DIR"
```

**Step 2: Add dedup key computation function**

```bash
compute_dedup_key() {
  local ns="$1" category="$2" pods="$3"
  local workload_hash8
  workload_hash8=$(printf '%s' "$pods" | sha256sum | cut -c1-8)
  [[ -z "$workload_hash8" || "$workload_hash8" == "e3b0c442" ]] && workload_hash8="empty000"
  local minute
  minute=$(date -u +%M)
  local half=$(( minute < 30 ? 0 : 30 ))
  local date_hour_half
  date_hour_half="$(date -u +%Y%m%d%H)$(printf '%02d' $half)"
  printf '%s' "${ns}${category}${workload_hash8}${date_hour_half}" | sha256sum | cut -c1-64
}
```

**Step 3: Add spool lifecycle cleanup function**

```bash
cleanup_spool() {
  local now
  now=$(date +%s)
  local ttl=86400  # 24h
  local max_files=100

  # Remove acked files older than 24h
  find "$SPOOL_DIR" -name "*.ack" -mmin +1440 -delete 2>/dev/null || true
  find "$SPOOL_DIR" -name "*.acked" -mmin +1440 -delete 2>/dev/null || true
  find "$SPOOL_DIR" -name "*.done" -mmin +1440 -delete 2>/dev/null || true
  find "$SPOOL_DIR" -name ".cron-healthcheck-*" -mmin +1440 -delete 2>/dev/null || true

  # Promote orphaned un-acked files older than 24h to .dead
  for f in "$SPOOL_DIR"/triage-*.json; do
    [[ -f "$f" ]] || continue
    local age=$(( now - $(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo "$now") ))
    if (( age > ttl )); then
      mv "$f" "${f}.dead" 2>/dev/null || true
    fi
  done

  # Enforce 100-file cap on un-acked files
  local count
  count=$(find "$SPOOL_DIR" -name "triage-*.json" 2>/dev/null | wc -l)
  if (( count > max_files )); then
    find "$SPOOL_DIR" -name "triage-*.json" -printf '%T+ %p\n' 2>/dev/null | \
      sort | head -n $(( count - max_files )) | awk '{print $2}' | \
      while read -r f; do mv "$f" "${f}.dead"; done
  fi
}
```

**Step 4: Write spool dedup test**

Create `deploy/skills/morpho-sre/scripts/test-spool-dedup.sh` that:

1. Creates a temporary spool dir
2. Computes a dedup key
3. Writes two spool files with same key but different timestamps
4. Verifies coalescing picks the latest
5. Verifies `.ack` prevents re-posting
6. Cleans up

**Step 5: Run tests**

Run: `bash deploy/skills/morpho-sre/scripts/test-spool-dedup.sh`
Expected: All pass

**Step 6: Commit**

```bash
scripts/committer "feat(sre): add spool dedup + coalescing + lifecycle management" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh \
  deploy/skills/morpho-sre/scripts/test-spool-dedup.sh
```

---

### Task 1.9: Add early lease mechanism for Step 11 dedup

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Ref:** Design doc "Early lease (before Step 11)"

**Step 1: Add lease acquire/release functions**

```bash
# Early lease: prevents duplicate LLM calls from concurrent cron + Slack
LEASE_DIR=""

acquire_lease() {
  local key="$1"
  local lease_path="${SPOOL_DIR}/lease-${key}"
  local done_marker="${SPOOL_DIR}/${key}.done"

  # Pre-check: if .done exists, work is already complete
  if [[ -f "$done_marker" ]]; then
    log "Lease: .done exists for key=${key}, skipping"
    return 1
  fi

  # Atomic mkdir — POSIX guarantees failure if exists
  if mkdir "$lease_path" 2>/dev/null; then
    # Write ownership token
    echo "$(hostname):$(date +%s)" > "${lease_path}/owner"
    LEASE_DIR="$lease_path"
    return 0
  fi

  # mkdir failed — check if existing lease is stale (>5 min)
  if [[ -f "${lease_path}/owner" ]]; then
    local owner_ts
    owner_ts=$(cut -d: -f2 "${lease_path}/owner" 2>/dev/null || echo 0)
    local now
    now=$(date +%s)
    if (( now - owner_ts > 300 )); then
      log "Lease: reclaiming stale lease for key=${key} (age=$(( now - owner_ts ))s)"
      rm -f "${lease_path}/owner"
      rmdir "$lease_path" 2>/dev/null || true
      if mkdir "$lease_path" 2>/dev/null; then
        echo "$(hostname):$(date +%s)" > "${lease_path}/owner"
        LEASE_DIR="$lease_path"
        return 0
      fi
    fi
  fi

  log "Lease: another run owns key=${key}, skipping Step 11"
  return 1
}

release_lease() {
  local key="$1"
  local lease_path="${SPOOL_DIR}/lease-${key}"

  # Write .done marker (spool payload is durable)
  touch "${SPOOL_DIR}/${key}.done"

  # Clean up lease dir
  rm -f "${lease_path}/owner"
  rmdir "$lease_path" 2>/dev/null || true
  LEASE_DIR=""
}
```

**Step 2: Write lease test**

Create `deploy/skills/morpho-sre/scripts/test-early-lease.sh` verifying:

1. First acquire succeeds
2. Second acquire fails (lease held)
3. After release + .done, acquire fails (pre-check)
4. Stale lease (>5 min old) is reclaimed

**Step 3: Run tests**

Run: `bash deploy/skills/morpho-sre/scripts/test-early-lease.sh`
Expected: All pass

**Step 4: Commit**

```bash
scripts/committer "feat(sre): add early lease mechanism for Step 11 dedup" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh \
  deploy/skills/morpho-sre/scripts/test-early-lease.sh
```

---

### Task 1.10: Update SKILL.md and HEARTBEAT.md for Phase 1

**Files:**

- Modify: `deploy/skills/morpho-sre/SKILL.md`
- Modify: `deploy/skills/morpho-sre/HEARTBEAT.md`

**Step 1: Add prometheus-trends.sh to SKILL.md helper scripts section**

Add entry for the new script with its purpose and usage.

**Step 2: Update pipeline step numbering in SKILL.md**

Update references to reflect the expanded 0-11 step pipeline (new Steps 0, 3, 4, 6, 7 are placeholders for later phases; Step 3 is active now).

**Step 3: Update HEARTBEAT.md to document new step_status output**

Add note about `=== step_status ===` and `=== prometheus_trends ===` sections in triage output.

**Step 4: Commit**

```bash
scripts/committer "docs(sre): update SKILL.md and HEARTBEAT.md for Phase 1 pipeline changes" \
  deploy/skills/morpho-sre/SKILL.md \
  deploy/skills/morpho-sre/HEARTBEAT.md
```

---

## Phase 2: ArgoCD Sync & Drift State

**Ref:** Design doc "New Step 4: ArgoCD Sync & Drift State"

---

### Task 2.1: Create argocd-sync-status.sh (Step 4)

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/argocd-sync-status.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-argocd-sync.sh`

**Step 1: Write the test script**

Test that validates output format: TSV with columns `app_name, sync_status, health_status, last_sync_time, last_sync_result, drift_summary`. Test graceful exit when `ARGOCD_BASE_URL` is unset.

**Step 2: Write argocd-sync-status.sh**

Query ArgoCD API (`${ARGOCD_BASE_URL}/api/v1/applications`) filtered by namespace. Check sync status, health status, last sync result, and drift details. Output TSV. The script should:

- Use `ARGOCD_BASE_URL` and `ARGOCD_AUTH_TOKEN` env vars
- Exit cleanly with no output if `ARGOCD_BASE_URL` is unset
- Query applications targeting `SCOPE_NAMESPACES`
- Flag OutOfSync >1h as warning, failed sync in last 30m as critical
- Parse drift from `status.resources` where `status != "Synced"`

**Step 3: Run tests**

Run: `bash deploy/skills/morpho-sre/scripts/test-argocd-sync.sh`
Expected: PASS for unset URL; format validation if ArgoCD available

**Step 4: Commit**

```bash
chmod +x deploy/skills/morpho-sre/scripts/argocd-sync-status.sh
scripts/committer "feat(sre): add argocd-sync-status.sh (Step 4)" \
  deploy/skills/morpho-sre/scripts/argocd-sync-status.sh \
  deploy/skills/morpho-sre/scripts/test-argocd-sync.sh
```

---

### Task 2.2: Integrate Step 4 into sentinel-triage.sh

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Step 1: Add Step 4 function and run_step call**

```bash
step_04_argocd_sync() {
  "${SCRIPT_DIR}/argocd-sync-status.sh"
}
run_step 04 "argocd_sync" 5 no 'step_04_argocd_sync'
```

**Step 2: Add ArgoCD output section and severity scoring**

```bash
if [[ "${STEP_STATUS_04}" == "ok" && -n "${STEP_OUTPUT_04}" ]]; then
  echo "=== argocd_sync ==="
  echo "$STEP_OUTPUT_04"
fi
```

Wire critical/warning signals into severity scoring (similar to Prometheus integration).

**Step 3: Add ARGOCD_BASE_URL to deploy-dev.sh and manifests**

**Step 4: Commit**

```bash
scripts/committer "feat(sre): integrate ArgoCD sync as Step 4 in triage pipeline" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh \
  deploy/eks/deploy-dev.sh
```

---

## Phase 3: Cert & Secret Health

**Ref:** Design doc "New Step 6: Cert & Secret Health"

---

### Task 3.1: Create cert-secret-health.sh (Step 6)

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/cert-secret-health.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-cert-health.sh`

**Step 1: Write the test script**

Test output format: TSV with columns `resource_type, name, namespace, expiry_or_age, days_remaining, status`. Test cases:

- Mock cert data with near-expiry (7d → critical, 14d → warning, 30d → info)
- Secret age check (>90d → info)
- No Vault checks when VAULT_ADDR unset

**Step 2: Write cert-secret-health.sh**

- Parse ingress resources for TLS secrets via `kubectl get ingress -o json`
- Extract cert expiry from secret data (`kubectl get secret -o jsonpath='{.data.tls\.crt}'` → `openssl x509 -enddate`)
- Check secret creation timestamps for rotation staleness
- Conditionally check Vault leases if `VAULT_ADDR` set
- Output TSV

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add cert-secret-health.sh (Step 6)" \
  deploy/skills/morpho-sre/scripts/cert-secret-health.sh \
  deploy/skills/morpho-sre/scripts/test-cert-health.sh
```

---

### Task 3.2: Integrate Step 6 into sentinel-triage.sh

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

Same pattern as Step 3/4 integration: add function, `run_step 06 "cert_health" 5 no`, output section, severity scoring for cert expiry signals. Commit.

---

## Phase 4: AWS Resource Signals + Daily Cost Report

**Ref:** Design doc "New Step 7: AWS Resource Signals" and "Daily Cost Health Report"

---

### Task 4.1: Create aws-resource-signals.sh (Step 7)

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/aws-resource-signals.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-aws-signals.sh`

**Step 1: Write test script, step 2: write implementation**

Runtime-impacting checks only:

- EC2 instance status checks for EKS nodes
- EBS volume utilization
- EKS node group status
- Spot interruption notices

Output TSV: `resource_type, resource_id, status, utilization_pct, notes`

Uses `AWS_PROFILE=morpho-infra-terraform-k8s` or in-cluster role. Exits cleanly if no AWS access.

**Step 3: Commit**

```bash
scripts/committer "feat(sre): add aws-resource-signals.sh (Step 7)" \
  deploy/skills/morpho-sre/scripts/aws-resource-signals.sh \
  deploy/skills/morpho-sre/scripts/test-aws-signals.sh
```

---

### Task 4.2: Create aws-cost-report.sh (daily cron)

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/aws-cost-report.sh`
- Create: `deploy/eks/charts/openclaw-sre/templates/cronjob-cost.yaml`

**Step 1: Write the cost report script**

Queries AWS Cost Explorer for MTD spend, top services, anomaly detection (>20% delta). Output: structured Markdown for Slack posting.

**Step 2: Create separate CronJob for daily 08:00 UTC execution**

**Step 3: Commit**

```bash
scripts/committer "feat(sre): add daily AWS cost report script and CronJob" \
  deploy/skills/morpho-sre/scripts/aws-cost-report.sh \
  deploy/eks/charts/openclaw-sre/templates/cronjob-cost.yaml
```

---

### Task 4.3: Integrate Step 7 into sentinel-triage.sh

Same pattern: add function, `run_step 07 "aws_resources" 8 no`, output section, severity wiring. Commit.

---

## Phase 5: Linear Incident Memory + Persistent Incident Identity

**Ref:** Design doc sections "Incident Identity", "Incident state persistence", "Linear Incident Memory", "Post-Triage Ticket Creation"

Phase 5 is the largest and most complex phase. It introduces the persistent state file, incident identity system, continuity matcher, Linear ticketing, and the outbox pattern.

---

### Task 5.1: Create state file read/write library

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-state-file.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-state-file.sh`

**Step 1: Write tests for state file operations**

Test cases:

- Write new row, read it back by incident_id
- Atomic write (flock + tmp + fsync + mv)
- Schema version header (`#v1\t{columns}`)
- Column validation (reject non-conforming atomic values)
- Concurrent write safety (two subshells writing simultaneously)
- Corrupt file detection → quarantine and rebuild
- Round-trip: write all 21 columns, read back, verify equality

**Step 2: Write lib-state-file.sh**

Functions:

- `state_init()` — create state file with header if missing
- `state_read_all()` — read all active incident rows
- `state_read_incident(incident_id)` — read single row
- `state_write_row(incident_id, ...)` — atomic upsert under flock
- `state_archive_row(incident_id, reason)` — move to resolved-incidents.tsv
- `state_validate_atomic(value)` — validate against `[a-zA-Z0-9_:.\-]`
- Flock acquisition/release wrappers
- Atomic write pattern (tmp → fsync → mv → fsync dir)

**Step 3: Run tests**

Run: `bash deploy/skills/morpho-sre/scripts/test-state-file.sh`
Expected: All pass

**Step 4: Commit**

```bash
scripts/committer "feat(sre): add state file read/write library with flock + atomic writes" \
  deploy/skills/morpho-sre/scripts/lib-state-file.sh \
  deploy/skills/morpho-sre/scripts/test-state-file.sh
```

---

### Task 5.2: Implement incident_id generation

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-incident-id.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-incident-id.sh`

**Step 1: Write tests**

Test cases:

- BetterStack-sourced: `bs:{betterstack_incident_id}`
- BetterStack fallback: `bs:thread:{slack_thread_ts}`
- Heartbeat-sourced: `hb:{ns}:{category}:{first_seen_ts}:{workload_hash8}`
- Empty workload sentinel: `empty000`
- Same-minute same-category different workloads → different IDs
- Same-minute same-category same workloads → same ID (by design)
- Unknown category: `hb:morpho-dev:unknown:...`

**Step 2: Write lib-incident-id.sh**

Functions:

- `generate_incident_id(source_type, ...)` — generates stable ID
- `compute_workload_hash8(pod_prefixes)` — SHA-256 first 8 hex
- `extract_betterstack_id(thread_context)` — parse BS incident ID

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add incident_id generation library" \
  deploy/skills/morpho-sre/scripts/lib-incident-id.sh \
  deploy/skills/morpho-sre/scripts/test-incident-id.sh
```

---

### Task 5.3: Implement continuity matcher

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-continuity-matcher.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-continuity-matcher.sh`

**Step 1: Write comprehensive tests**

Test cases per the design doc (exact match, continuity match, multi-incident routing):

- Exact match: same ns + category + staleness ≤120m + workload overlap ≥1
- Exact match: empty-side skip (either workloads empty → skip overlap check)
- Continuity match: different category + time ≤60m + workload Jaccard ≥50% + signal key Jaccard ≥30%
- Continuity match: empty workloads → raised signal threshold (≥50%)
- Continuity match: empty signals → raised workload threshold (≥70%)
- Continuity match: both empty → disabled (no match)
- Multi-incident routing: multiple exact → highest Jaccard
- Multi-incident routing: empty workloads + multiple candidates → sentinel reuse
- No match → new incident
- Staleness bound: >120m exact → no match; >60m continuity → no match
- Non-primary streak tracking
- Resolution branch (a) and (b)

**Step 2: Write lib-continuity-matcher.sh**

Functions:

- `jaccard(set_a, set_b)` — compute Jaccard similarity on pipe-separated sets
- `exact_match(heartbeat, incident_row)` — returns match/no-match
- `continuity_match(heartbeat, incident_row)` — normative pseudocode from design doc
- `route_heartbeat(heartbeat, active_incidents)` — multi-incident routing with priority tiers
- `check_stale_resolve(incident_row, current_ts)` — staleness auto-resolve check

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add continuity matcher for incident identity" \
  deploy/skills/morpho-sre/scripts/lib-continuity-matcher.sh \
  deploy/skills/morpho-sre/scripts/test-continuity-matcher.sh
```

---

### Task 5.4: Implement Linear entity preflight

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-linear-preflight.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-linear-preflight.sh`

**Step 1: Write tests**

Test cases:

- Resolve team ID, project ID, required labels, optional labels
- Missing required entity → `LINEAR_AVAILABLE=false`
- Missing optional label → warn, continue
- Linear API unavailable → degrade gracefully
- Retry throttle (at most once per 5 min)
- Cache valid for pod lifetime

**Step 2: Write lib-linear-preflight.sh**

Uses Linear MCP tool calls (or direct API) to resolve entity IDs. Cache in memory. Non-fatal — triage + Slack never depend on Linear availability.

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add Linear entity preflight with graceful degradation" \
  deploy/skills/morpho-sre/scripts/lib-linear-preflight.sh \
  deploy/skills/morpho-sre/scripts/test-linear-preflight.sh
```

---

### Task 5.5: Implement Step 0 — Linear Incident Memory Lookup

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/linear-memory-lookup.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-linear-memory.sh`

**Step 1: Write tests**

Test: output format (list of similar incidents with titles, descriptions, resolution context). Test: graceful timeout/skip when Linear unavailable.

**Step 2: Write linear-memory-lookup.sh**

Runs after Steps 1-2 (uses their output as search input). Searches Linear API: Platform team, last 90 days, title prefix `[Incident]` or labels `Bug` + `Monitoring`. Returns top 3-5 similar incidents.

**Step 3: Integrate as Step 0 in sentinel-triage.sh**

```bash
run_step 00 "linear_memory" 5 no 'step_00_linear_memory'
```

**Step 4: Run tests, commit**

```bash
scripts/committer "feat(sre): add Step 0 Linear Incident Memory Lookup" \
  deploy/skills/morpho-sre/scripts/linear-memory-lookup.sh \
  deploy/skills/morpho-sre/scripts/test-linear-memory.sh \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 5.6: Implement post-triage Linear ticket creation

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-linear-ticket.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-linear-ticket.sh`

**Step 1: Write tests**

Test cases:

- Create ticket with Eng Post-Mortem template (all sections)
- Idempotency: two-layer lookup (local state file → Linear API search fallback)
- Two-phase reservation (flock held only for state reads/writes, not API calls)
- Stale reservation reclaim (>120s)
- Pattern detection: 3+ similar → "Recurring Pattern" section + tech debt label
- RCA version update: append-only with retention cap (last 3 versions inline)
- Severity gate: only create if severity >= MEDIUM
- `[NEEDS REVIEW]` markers where data insufficient

**Step 2: Write lib-linear-ticket.sh**

Functions:

- `create_or_update_ticket(incident_id, rca_output, state_row)` — main entry point
- `build_ticket_description(rca_output, incident_context)` — Eng Post-Mortem template
- `detect_patterns(incident_id, category, namespace, services)` — Linear search for recurrence
- `update_ticket_rca(ticket_id, new_rca, version)` — append-only RCA update with retention

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add Linear ticket creation with post-mortem template" \
  deploy/skills/morpho-sre/scripts/lib-linear-ticket.sh \
  deploy/skills/morpho-sre/scripts/test-linear-ticket.sh
```

---

### Task 5.7: Implement outbox pattern for reliable Slack/Linear writes

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/lib-state-file.sh` (add outbox columns)
- Create: `deploy/skills/morpho-sre/scripts/lib-outbox.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-outbox.sh`

**Step 1: Write tests**

Test cases:

- Outbox state machine: pending → attempt → sent (or failed_retryable → retry → sent/failed_terminal)
- Version-keyed invariant: stale writer does not overwrite newer version's status
- Crash-window idempotency: crash after POST, before status update → retry on next heartbeat
- Compare-and-set on rca_version
- 3 max attempts per channel per version
- failed_terminal → alert emitted

**Step 2: Write lib-outbox.sh**

Implements the canonical outbox sequence from the design doc (steps 1-6).

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add outbox pattern for reliable external writes" \
  deploy/skills/morpho-sre/scripts/lib-outbox.sh \
  deploy/skills/morpho-sre/scripts/test-outbox.sh \
  deploy/skills/morpho-sre/scripts/lib-state-file.sh
```

---

### Task 5.8: Integrate Phase 5 into sentinel-triage.sh main pipeline

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Step 1: Source all Phase 5 libraries**

```bash
source "${SCRIPT_DIR}/lib-state-file.sh"
source "${SCRIPT_DIR}/lib-incident-id.sh"
source "${SCRIPT_DIR}/lib-continuity-matcher.sh"
source "${SCRIPT_DIR}/lib-linear-preflight.sh"
source "${SCRIPT_DIR}/lib-linear-ticket.sh"
source "${SCRIPT_DIR}/lib-outbox.sh"
```

**Step 2: Wire incident identity into the pipeline**

After Steps 1-2 complete and health_status is determined:

1. If incident: compute incident_id, run continuity matcher against state file
2. Match found → reuse existing incident (update timestamps, check fingerprint)
3. No match → create new incident row
4. Run staleness auto-resolve on all active rows
5. After Step 11: trigger outbox for Slack + Linear writes

**Step 3: Upgrade spool dedup from `dedup_key` to `incident_id`**

Replace Phase 1's `dedup_key` with stable `incident_id`. Spool filenames become `triage-{incident_id}-{ts}.json`. `.ack` markers become per-key-per-version.

**Step 4: Run full integration tests**

Verify end-to-end: triage → incident match → state update → spool write → outbox tracking

**Step 5: Commit**

```bash
scripts/committer "feat(sre): integrate incident identity + Linear memory into triage pipeline" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 5.9: Implement BetterStack ↔ heartbeat reconciliation

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-bs-reconciliation.sh`

**Step 1: Write tests**

Test cases:

- BS incident arrives first, then heartbeat → heartbeat routes to existing BS incident
- Heartbeat arrives first, then BS → BS aliases into existing HB incident
- Simultaneous (flock serialization) → first-writer-wins
- Dual-thread reconciliation: cross-link messages posted
- Thread adoption when HB incident has no Slack thread yet

**Step 2: Implement reconciliation logic**

Add merge rules from design doc "BetterStack ↔ heartbeat reconciliation" to the continuity matcher flow.

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add BetterStack/heartbeat incident reconciliation" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh \
  deploy/skills/morpho-sre/scripts/test-bs-reconciliation.sh
```

---

### Task 5.10: Create rca_hypothesis_ids.v1.json vocabulary file

**Files:**

- Create: `deploy/skills/morpho-sre/rca_hypothesis_ids.v1.json`

**Step 1: Write the controlled vocabulary**

```json
{
  "resource_exhaustion": [
    "oom_memory_limit",
    "cpu_throttle",
    "disk_full",
    "connection_pool",
    "file_descriptors",
    "redis_pool",
    "other"
  ],
  "bad_deploy": [
    "broken_image",
    "missing_config",
    "wrong_env",
    "failed_rollout",
    "bad_merge",
    "config_mismatch",
    "other"
  ],
  "config_drift": [
    "argocd_out_of_sync",
    "manual_kubectl_change",
    "secret_mismatch",
    "stale_config",
    "other"
  ],
  "network_connectivity": [
    "dns_failure",
    "tls_error",
    "service_mesh_issue",
    "firewall_sg",
    "timeout",
    "other"
  ],
  "dependency_failure": [
    "upstream_service_down",
    "database_unreachable",
    "cache_unavailable",
    "other"
  ],
  "cert_or_secret_expiry": [
    "tls_cert_expired",
    "vault_lease_exhausted",
    "rotated_secret_not_propagated",
    "other"
  ],
  "scaling_issue": [
    "hpa_maxed",
    "node_group_at_capacity",
    "spot_interruption",
    "pending_pods",
    "other"
  ],
  "data_issue": [
    "corrupt_data",
    "migration_failure",
    "schema_mismatch",
    "storage_backend_error",
    "other"
  ],
  "unknown": ["insufficient_evidence"]
}
```

**Step 2: Commit**

```bash
scripts/committer "feat(sre): add RCA hypothesis controlled vocabulary v1" \
  deploy/skills/morpho-sre/rca_hypothesis_ids.v1.json
```

---

## Phase 6a: Single-Model LLM RCA (Codex)

**Ref:** Design doc "Step 11: LLM-Synthesized RCA", "Single-Model Mode"

---

### Task 6a.1: Add RCA_MODE env var and mode resolver

**Files:**

- Modify: `deploy/eks/deploy-dev.sh` (add `RCA_MODE` env var)
- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh` (add mode resolver)

**Step 1: Add RCA_MODE to deploy config**

```bash
RCA_MODE="${RCA_MODE:-single}"  # single|dual|heuristic
```

**Step 2: Add mode resolver function**

```bash
resolve_rca_mode() {
  local mode="${RCA_MODE:-single}"
  local severity="$1"
  # heuristic → always heuristic
  # single → always single-model Codex
  # dual → single for LOW severity, dual for MEDIUM+ (Phase 6b)
  case "$mode" in
    heuristic) echo "heuristic" ;;
    single)    echo "single" ;;
    dual)
      if [[ "$severity" == "low" ]]; then
        echo "single"
      else
        echo "dual"
      fi
      ;;
    *) echo "heuristic" ;;
  esac
}
```

**Step 3: Commit**

```bash
scripts/committer "feat(sre): add RCA_MODE env var and mode resolver" \
  deploy/eks/deploy-dev.sh \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 6a.2: Build Codex RCA prompt template

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-rca-prompt.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-rca-prompt.sh`

**Step 1: Write tests**

Test: prompt template includes all required sections (evidence, taxonomy, vocabulary, output schema). Test: evidence bundle is scrubbed before inclusion. Test: structured JSON output schema is specified correctly.

**Step 2: Write lib-rca-prompt.sh**

Functions:

- `build_rca_prompt(evidence_bundle, linear_matches, skill_snippets)` — assembles the full prompt from the design doc's prompt structure
- `validate_rca_output(json_output)` — validates against hypothesis schema, auto-maps unknown hypothesis_ids to `:other`

The prompt includes:

- Complete evidence bundle (TSV from Steps 0-10)
- Similar past incidents from Step 0
- Hypothesis taxonomy (8 categories + unknown)
- Controlled vocabulary from `rca_hypothesis_ids.v1.json`
- Required output schema (JSON)

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add RCA prompt template and output validation" \
  deploy/skills/morpho-sre/scripts/lib-rca-prompt.sh \
  deploy/skills/morpho-sre/scripts/test-rca-prompt.sh
```

---

### Task 6a.3: Implement Codex LLM call with timeout and heuristic fallback

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-rca-llm.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-rca-llm.sh`

**Step 1: Write tests**

Test: mock Codex API response → parsed correctly. Test: timeout (15s) → fallback to heuristic. Test: API error → fallback to heuristic with degradation_note. Test: conditional trigger (only on incident, skip healthy).

**Step 2: Write lib-rca-llm.sh**

Functions:

- `call_codex_rca(prompt, timeout_ms)` — calls OpenAI/Codex API with structured JSON output
- `fallback_heuristic_rca(evidence_bundle)` — existing heuristic scoring as fallback
- `run_step_11(evidence_bundle, mode, incident_context)` — Step 11 entry point

Uses existing `OPENAI_API_KEY` / Codex credentials. 15s per-model timeout. On failure, falls back to heuristic with `degradation_note`.

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add Codex LLM RCA call with heuristic fallback" \
  deploy/skills/morpho-sre/scripts/lib-rca-llm.sh \
  deploy/skills/morpho-sre/scripts/test-rca-llm.sh
```

---

### Task 6a.4: Implement evidence completeness gate

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Step 1: Add completeness computation**

```bash
compute_evidence_completeness() {
  local applicable=0 completed=0

  # Always applicable
  for step in 01 02 05; do
    ((applicable++))
    [[ "${!step_status_var}" == "ok" ]] && ((completed++))
  done

  # Conditionally applicable
  [[ -n "${PROMETHEUS_URL:-}" ]] && { ((applicable++)); [[ "${STEP_STATUS_03}" == "ok" ]] && ((completed++)); }
  [[ -n "${ARGOCD_BASE_URL:-}" ]] && { ((applicable++)); [[ "${STEP_STATUS_04}" == "ok" ]] && ((completed++)); }
  # ... etc for steps 06, 07, 08, 09, 10

  echo "scale=2; $completed / $applicable" | bc
}
```

**Step 2: Add gate checks before Step 11**

- Required: Step 1 AND Step 2 must succeed (abort otherwise)
- Enrichment minimum: at least one of Steps 3/4/5/6/7/10 must succeed
- If all enrichment fails: cap confidence at 50%, add caveat

**Step 3: Commit**

```bash
scripts/committer "feat(sre): add evidence completeness gate for Step 11" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 6a.5: Wire Slack output to new structured RCA format

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Step 1: Add Slack formatter function**

Build the Slack output from the design doc "Slack Output Contract" — severity, confidence, RCA version, evidence completeness, root cause, alternative hypotheses, blast radius, remediation, pattern analysis.

**Step 2: Implement RCA versioning in output**

Same `incident_id` + changed fingerprint → version bump with `RCA Update (v{n})` header. Same fingerprint → silent skip (but 30m digest keep-alive posted).

**Step 3: Implement single-mode PR guard**

Confidence >= 90%, evidence completeness >= 0.7, mandatory human ack via Slack DM (15m timeout).

**Step 4: Commit**

```bash
scripts/committer "feat(sre): wire Slack output to structured RCA format with versioning" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 6a.6: Add acceptance tracking via Slack reactions

**Files:**

- Modify: `deploy/skills/morpho-sre/HEARTBEAT.md` (add reaction tracking instructions)

**Step 1: Add reaction monitoring**

Track thumbs-up/thumbs-down reactions on RCA posts. Log per-incident: mode, latency, confidence, reaction, completeness. Weekly nudge if >40% unreviewed.

**Step 2: Commit**

```bash
scripts/committer "feat(sre): add Slack reaction tracking for RCA acceptance measurement" \
  deploy/skills/morpho-sre/HEARTBEAT.md
```

---

## Phase 6b: Dual-Model RCA (Codex + Claude) — CONDITIONAL

**Ref:** Design doc "Dual-Model Mode (Phase 6b)"

**Gate:** Only proceed if Phase 6a severity-weighted acceptance rate <80% (upper bound 90% bootstrap CI) after 50+ reviewed incidents, AND operator sets `RCA_MODE=dual`.

---

### Task 6b.1: Add Anthropic secret wiring

**Files:**

- Modify: `deploy/eks/deploy-dev.sh` (add `ANTHROPIC_API_KEY` handling)
- Modify: `deploy/eks/charts/openclaw-sre/templates/deployment.yaml`

**Step 1: Add conditional secret ingestion**

In deploy-dev.sh, gate all Anthropic checks on `RCA_MODE=dual`:

- Read `claude.txt` only when dual mode
- Format check (starts with `sk-ant-`) blocks deploy if invalid
- API probe is warning-only (bot starts degraded, not blocked)

**Step 2: Add env var to deployment template**

**Step 3: Commit**

```bash
scripts/committer "feat(deploy): add Anthropic API key wiring for dual-model RCA" \
  deploy/eks/deploy-dev.sh \
  deploy/eks/charts/openclaw-sre/templates/deployment.yaml
```

---

### Task 6b.2: Implement parallel Claude call

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/lib-rca-llm.sh`

**Step 1: Add Claude API call function**

Same prompt structure as Codex. Same structured JSON output schema. Same 15s timeout.

**Step 2: Add parallel execution**

Fire Codex and Claude in parallel (background jobs), collect both outputs.

**Step 3: Commit**

```bash
scripts/committer "feat(sre): add parallel Claude call for dual-model RCA" \
  deploy/skills/morpho-sre/scripts/lib-rca-llm.sh
```

---

### Task 6b.3: Implement iterative cross-review loop

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-rca-crossreview.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-rca-crossreview.sh`

**Step 1: Write tests**

Test cases:

- Round 0 convergence (same category + hypothesis_id + Jaccard >= 0.6 + overlap >= 2) → merge, 2 LLM calls
- Round 1 convergence (+ both agree_with_peer) → merge, 4 LLM calls
- Round 2 convergence → merge, 6 LLM calls
- Non-convergence after Round 2 → Codex-primary, 20% penalty
- Weak convergence rejection (same category, different variant) → NOT converged
- `:other` special case (>80% description token overlap required)
- All 4 degradation modes (both ok, Claude-only, Codex-only, neither)

**Step 2: Write lib-rca-crossreview.sh**

Functions:

- `check_convergence(rca_a, rca_b, round)` — canonical convergence contract
- `merge_rcas(rca_a, rca_b)` — pick richer evidence_keys, average confidence
- `run_cross_review(round, rca_a, rca_b, evidence)` — fire both with peer's RCA

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add iterative cross-review loop for dual-model RCA" \
  deploy/skills/morpho-sre/scripts/lib-rca-crossreview.sh \
  deploy/skills/morpho-sre/scripts/test-rca-crossreview.sh
```

---

### Task 6b.4: Implement runtime downgrade/recovery state machine

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-rca-safety.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-rca-safety.sh`

**Step 1: Write tests**

Test: downgrade triggers when `rate_7d > 30%` with >= 10 samples. Test: recovery when `rate_14d < 15%` or < 10 samples. Test: daily probe in downgraded state. Test: alerts on state transitions.

**Step 2: Write lib-rca-safety.sh**

Manages `rca-convergence-stats.tsv` and `rca-mode-state.tsv` under flock.

**Step 3: Run tests, commit**

```bash
scripts/committer "feat(sre): add runtime downgrade/recovery state machine for dual-model RCA" \
  deploy/skills/morpho-sre/scripts/lib-rca-safety.sh \
  deploy/skills/morpho-sre/scripts/test-rca-safety.sh
```

---

### Task 6b.5: Implement dual-mode PR gate

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Step 1: Add mode-specific PR gate logic**

Per the design doc "Optional PR Lane" table:

- Convergence required (canonical contract)
- `agreement_score >= 0.6`
- `merged_confidence >= 85%`
- `evidence_completeness >= 0.6`
- Human ack until graduation

**Step 2: Add early-post UX for dual-mode latency**

Post "Analyzing..." early, replace with final RCA via `chat.update`. Persist `message_ts` to spool for crash safety.

**Step 3: Commit**

```bash
scripts/committer "feat(sre): add dual-mode PR gate and early-post UX" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

## Phase 7: Slack Thread Archival

**Ref:** Design doc "Slack Thread Archival"

---

### Task 7.1: Implement thread archival on incident resolution

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-thread-archival.sh`
- Create: `deploy/skills/morpho-sre/scripts/test-thread-archival.sh`

**Step 1: Write tests**

Test: collect human messages from thread (skip bot messages). Test: summarize via Codex. Test: append to Linear ticket as "Resolution Context" comment. Test: incremental archival at 4h intervals. Test: idempotency via HTML marker comments.

**Step 2: Write lib-thread-archival.sh**

Functions:

- `archive_thread(slack_thread_ts, incident_id, linear_ticket_id)` — main entry
- `collect_human_messages(thread_ts)` — filter bot messages
- `summarize_thread(messages)` — Codex summarization
- `post_archival_comment(ticket_id, summary, pass_type)` — idempotent Linear comment

**Step 3: Wire into incident resolution flow**

Trigger on state file row moving to `resolved-incidents.tsv`.

**Step 4: Run tests, commit**

```bash
scripts/committer "feat(sre): add Slack thread archival on incident resolution" \
  deploy/skills/morpho-sre/scripts/lib-thread-archival.sh \
  deploy/skills/morpho-sre/scripts/test-thread-archival.sh \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

## Phase 8: Metrics & Experiment Rollout

**Ref:** Design doc "Phase 8: Metrics & Experiment Rollout"

---

### Task 8.1: Add per-incident metrics logging

**Files:**

- Modify: `deploy/skills/morpho-sre/scripts/sentinel-triage.sh`

**Step 1: Add structured metrics output section**

```bash
echo "=== triage_metrics ==="
echo -e "incident_id\tmode\ttotal_latency_ms\tconfidence\tevidence_completeness\tstep_timeouts\tstep_skips\thuman_reaction\tagreement_score\treview_rounds"
```

Log per-incident: RCA mode, latency per step, total latency, confidence, human acceptance, step timeouts/skips, agreement score (dual mode), review rounds.

**Step 2: Commit**

```bash
scripts/committer "feat(sre): add per-incident metrics logging to triage output" \
  deploy/skills/morpho-sre/scripts/sentinel-triage.sh
```

---

### Task 8.2: Create monitoring alerts for SRE bot health

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/lib-meta-alerts.sh`

**Step 1: Implement meta-alerting**

- Evidence completeness drops below 60% across 5 consecutive incidents → alert
- Per-step timeout rate >10% → investigate infrastructure
- `incident_id_empty_workload` count >3 in 24h → alert
- `incident_id_ambiguous_empty_workload` count >5 in 24h → alert
- Cron healthcheck sentinel missing for >90m → alert
- Stale timeout frequency trending up → alert

**Step 2: Commit**

```bash
scripts/committer "feat(sre): add meta-alerting for SRE bot operational health" \
  deploy/skills/morpho-sre/scripts/lib-meta-alerts.sh
```

---

## Final Integration & Docs

---

### Task F.1: Update SKILL.md with complete pipeline documentation

**Files:**

- Modify: `deploy/skills/morpho-sre/SKILL.md`

Update to document all 12 steps (0-11), new helper scripts, Linear memory workflow, RCA modes, and new env vars.

---

### Task F.2: Update HEARTBEAT.md with full incident lifecycle

**Files:**

- Modify: `deploy/skills/morpho-sre/HEARTBEAT.md`

Update to document: incident identity, state file, RCA versioning, outbox pattern, thread archival, dual-model mode.

---

### Task F.3: Update deploy-dev.sh with all new env vars

**Files:**

- Modify: `deploy/eks/deploy-dev.sh`

Add all new env vars: `PROMETHEUS_URL`, `ARGOCD_BASE_URL`, `RCA_MODE`, `ANTHROPIC_API_KEY` (conditional), `DUAL_PR_GRADUATED`, `PR_APPROVER_SLACK_IDS`, `RCA_LLM_TIMEOUT_MS`, `LINEAR_TEAM_ID`, `LINEAR_PROJECT_NAME`, `LINEAR_ASSIGNEE`.

---

### Task F.4: Full end-to-end integration test

**Files:**

- Create: `deploy/skills/morpho-sre/scripts/test-e2e-triage.sh`

Test the complete pipeline: triage → incident detection → state file update → continuity matching → LLM RCA → Slack output → Linear ticket → spool dedup → cron fallback → resolution → archival.

---

## Task Summary by Phase

| Phase | Tasks     | New Files                                                      | Modified Files                               |
| ----- | --------- | -------------------------------------------------------------- | -------------------------------------------- |
| 1     | 1.1-1.10  | prometheus-trends.sh, cronjob.yaml, 5 test scripts             | sentinel-triage.sh, deploy-dev.sh, manifests |
| 2     | 2.1-2.2   | argocd-sync-status.sh, test                                    | sentinel-triage.sh                           |
| 3     | 3.1-3.2   | cert-secret-health.sh, test                                    | sentinel-triage.sh                           |
| 4     | 4.1-4.3   | aws-resource-signals.sh, aws-cost-report.sh, cronjob-cost.yaml | sentinel-triage.sh                           |
| 5     | 5.1-5.10  | 6 lib-\*.sh, rca_hypothesis_ids.v1.json, 8 test scripts        | sentinel-triage.sh                           |
| 6a    | 6a.1-6a.6 | lib-rca-prompt.sh, lib-rca-llm.sh, tests                       | sentinel-triage.sh, deploy-dev.sh            |
| 6b    | 6b.1-6b.5 | lib-rca-crossreview.sh, lib-rca-safety.sh, tests               | lib-rca-llm.sh, deploy-dev.sh                |
| 7     | 7.1       | lib-thread-archival.sh, test                                   | sentinel-triage.sh                           |
| 8     | 8.1-8.2   | lib-meta-alerts.sh                                             | sentinel-triage.sh                           |
| Final | F.1-F.4   | test-e2e-triage.sh                                             | SKILL.md, HEARTBEAT.md, deploy-dev.sh        |

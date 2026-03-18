---
name: sre-sentinel
description: "Use for heartbeat monitoring, sentinel triage runs, sentinel-snapshot.sh and sentinel-triage.sh execution, alert routing, incident state management, and cron-based health checks in Morpho SRE."
metadata: { "openclaw": { "emoji": "🛡️" } }
---

# SRE Sentinel

Companion skill to `morpho-sre`. Load `morpho-sre` for hard rules, paths, and knowledge surfaces.

Reply with conclusions only in ALL communications — Slack, DMs, PR comments, Linear comments, every output surface. No investigation steps, intermediate reasoning, or tool output summaries. All investigation work happens silently; only the final summary is sent.

## When to Use

- Heartbeat / cron-based health checks
- Sentinel triage runs (scheduled or on-demand)
- Quick cluster health snapshots
- Alert routing based on sentinel output
- Incident state management and dedup
- Subagent team orchestration for parallel investigation

## sentinel-snapshot.sh

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh`

Use this first during heartbeat/sentinel runs for a quick cluster health overview:

```bash
sentinel-snapshot.sh
```

Outputs:

- Pod anomalies (phase/restarts/reasons)
- Deployment readiness gaps
- Recent warning events
- Firing Prometheus alerts

## sentinel-triage.sh

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh`

Use this as the primary heartbeat mode entry point. Runs a full 12-step pipeline:

```bash
sentinel-triage.sh
```

### Pipeline Stages

| Step | Name                             | Required | Description                                                       |
| ---- | -------------------------------- | -------- | ----------------------------------------------------------------- |
| `00` | Linear memory lookup             | optional | `linear-memory-lookup.sh` for prior incident context              |
| `01` | Pod/deploy runtime signals       | required | Pod health, container states, restart counts                      |
| `02` | Events + alert signals           | required | K8s events, Prometheus firing alerts                              |
| `03` | Prometheus trends                | optional | Metric trend analysis                                             |
| `04` | ArgoCD sync drift                | optional | Application sync status                                           |
| `05` | Log signal enrichment            | optional | Pod log error extraction                                          |
| `06` | Cert/secret health               | optional | TLS cert expiry, secret staleness                                 |
| `07` | AWS resource signals             | optional | EC2, RDS, ELB health                                              |
| `08` | Image->repo mapping              | optional | Docker image to GitHub repo correlation                           |
| `09` | Deployed revision/PR correlation | optional | Image tag to commit to PR mapping                                 |
| `10` | Repo CI signal                   | optional | Latest GitHub Actions run per repo                                |
| `11` | RCA synthesis                    | required | `RCA_MODE=single\|dual\|heuristic`, fallback to ranked heuristics |

### Output Sections

The triage output includes these structured sections:

- `health_status` -- `state\tok|incident`
- `incident_gate` -- `should_alert`, `gate_reason`, `incident_id`, `rca_version`, `incident_fingerprint`
- `incident_routing` -- `severity_level`, `severity_score`, `recommended_target`
- `impact_scope` -- primary namespace impact vs supporting namespace noise
- `signal_summary` -- counters of signals collected
- `linear_incident_memory` -- step 0 status + rows
- `prometheus_trends` -- step 3 status + rows
- `argocd_sync` -- step 4 status + rows
- `cert_secret_health` -- step 6 status + rows
- `aws_resource_signals` -- step 7 status + rows
- `rca_result` -- mode/status/confidence/agreement/degradation + JSON
- `triage_metrics` -- `evidence_completeness_pct`, step timeout/error/skip counts
- `meta_alerts` -- bot-health alerts when `lib-meta-alerts.sh` available
- `top_container_failures` -- container-level state/reason/exit/message
- `top_log_signals` -- runtime error log snippets, token-redacted
- `impacted_repos` -- pod/image to GitHub repo correlation
- `image_revision_signal` -- image tag to commit hint to resolved commit
- `suspect_prs` -- auto-mapped PRs for resolved deployed commits
- `repo_ci_signal` -- latest workflow run per impacted repo
- `pr_candidates` -- repo + likely files for fix PRs
- `ranked_hypotheses` -- confidence + checks + rollback

## Key Toggles

| Toggle                                    | Default   | Description                                             |
| ----------------------------------------- | --------- | ------------------------------------------------------- |
| `INCLUDE_REPO_MAP`                        | 1         | Skip image->repo correlation when `0`                   |
| `INCLUDE_CI_SIGNAL`                       | 1         | Skip GitHub Actions enrichment when `0`                 |
| `INCLUDE_LOG_SNIPPETS`                    | 1         | Skip pod log enrichment when `0`                        |
| `INCLUDE_IMAGE_REVISION`                  | 1         | Skip image tag->commit->PR enrichment when `0`          |
| `CI_REPO_LIMIT`                           | varies    | Control API load for CI checks                          |
| `CI_RUN_LIMIT`                            | varies    | Control API load for CI run fetches                     |
| `LOG_SNIPPET_PODS_LIMIT`                  | varies    | Bound log scraping pod count                            |
| `LOG_SNIPPET_LINES`                       | varies    | Bound log lines per pod                                 |
| `LOG_SNIPPET_ERRORS_PER_CONTAINER`        | varies    | Bound error snippets per container                      |
| `ALERT_COOLDOWN_SECONDS`                  | varies    | Suppress duplicate alerts for unchanged incidents       |
| `ALERT_MIN_INTERVAL_SECONDS`              | varies    | Minimum spacing between any incident alerts             |
| `SEVERITY_*_SCORE`                        | varies    | Tune severity thresholds                                |
| `ROUTE_TARGET_{CRITICAL,HIGH,MEDIUM,LOW}` | varies    | Recommended routing targets                             |
| `PRIMARY_NAMESPACES`                      | varies    | Prioritize severity/routing for app-critical namespaces |
| `PROMETHEUS_URL`                          | unset     | Enable Prometheus trend step (03)                       |
| `ARGOCD_BASE_URL`                         | unset     | Enable ArgoCD sync step (04)                            |
| `RCA_MODE`                                | heuristic | `single\|dual\|heuristic` for step 11                   |
| `LINEAR_MEMORY_LIMIT`                     | varies    | Step 0 lookup row limit                                 |

## State and Delivery

- Active incident state row persists: `incident_id`, namespace/category, timestamps, workloads, `rca_version`, fingerprint
- Outbox-related columns are preserved in the state row for Slack/Linear delivery libraries
- Spool files (`triage-*.json`) are written for cron/heartbeat fallback and dedup
- State persistence directories controlled via: `INCIDENT_STATE_DIR`, `ACTIVE_INCIDENTS_FILE`, `RESOLVED_INCIDENTS_FILE`, `INCIDENT_LAST_ACTIVE_FILE`
- Spool directory: `SPOOL_DIR`

## Heartbeat Routing Directive

When triage says `incident_gate.should_alert=yes`:

- Prefix alert with `[[heartbeat_to:<recommended_target>]]`
- `recommended_target` comes from `incident_routing`
- Directive is stripped before delivery text is sent
- Delivery override applies only when target is in `agents.defaults.heartbeat.routeAllowlist`

## Subagent Team Pattern

Use specialized subagents for parallel investigation:

```bash
# Kubernetes health specialist
/subagents spawn sre-k8s "Inspect pod health/events for <ns>/<workload> and summarize top 3 failure signals."

# Observability specialist
/subagents spawn sre-observability "Check Prometheus alerts + Grafana panels for <service>, list anomaly windows."

# Release correlation specialist
/subagents spawn sre-release "Correlate image tag to repo commits and recent CI runs."
```

## Agent-Specific Modes

Use the runtime line in the system prompt to detect the active agent id (`agent=<id>`).

| Agent ID            | Mode       | Contract                                                                                |
| ------------------- | ---------- | --------------------------------------------------------------------------------------- |
| `sre-k8s`           | specialist | JSON-only: `findings`, `top_hypotheses`, `missing_data`, `next_checks`, `evidence_refs` |
| `sre-observability` | specialist | JSON-only: alerts, metrics windows, dashboards, trends, corroborating evidence          |
| `sre-release`       | specialist | JSON-only: image tags, commit ranges, CI runs, rollout sequencing, release provenance   |
| `sre-repo-runtime`  | fixer      | Touch only `openclaw-sre`; validated change plan required; precise reversible patches   |
| `sre-repo-helm`     | fixer      | Touch only `morpho-infra-helm` for `openclaw-sre` SOT; validated change plan required   |
| `sre-verifier`      | verifier   | Read-only; never write/edit/apply; validate change plans, CI, Helm render, Argo state   |

Specialist agents return a single JSON object (no markdown fences). Fixer agents require a validated change plan before any write and always list validations and rollback. Verifier agents are strictly read-only.

## Reference

See `morpho-sre/references/sentinel-operations.md` for the full sentinel operations playbook.

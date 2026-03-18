# Sentinel Operations

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Reference for sentinel snapshot and sentinel triage operations used in heartbeat/sentinel runs and incident detection.

## Sentinel Snapshot

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh
```

Use this first during heartbeat/sentinel runs. It emits:

- Pod anomalies (phase/restarts/reasons)
- Deployment readiness gaps
- Recent warning events
- Firing Prometheus alerts

## Sentinel Triage (Preferred for Heartbeat)

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh
```

Use this first in heartbeat mode. It is the comprehensive 12-step triage pipeline.

### Pipeline Steps (0-11)

| Step | Name                             | Required?    | Description                       |
| ---- | -------------------------------- | ------------ | --------------------------------- | ---- | ----------------------------------------- |
| `00` | Linear memory lookup             | Optional     | `linear-memory-lookup.sh`         |
| `01` | Pod/deploy runtime signals       | **Required** | Pod and deployment health         |
| `02` | Events + alert signals           | **Required** | Kubernetes events and alert state |
| `03` | Prometheus trends                | Optional     | Metric trend analysis             |
| `04` | ArgoCD sync drift                | Optional     | GitOps sync status                |
| `05` | Log signal enrichment            | Optional     | Pod log error extraction          |
| `06` | Cert/secret health               | Optional     | Certificate and secret expiry     |
| `07` | AWS resource signals             | Optional     | AWS-level resource health         |
| `08` | Image->repo mapping              | Optional     | Correlate images to source repos  |
| `09` | Deployed revision/PR correlation | Optional     | Map deployed commits to PRs       |
| `10` | Repo CI signal                   | Optional     | Latest workflow runs per repo     |
| `11` | RCA synthesis                    | --           | `RCA_MODE=single                  | dual | heuristic`, fallback to ranked heuristics |

### Output Sections

- `health_status` (`state\tok|incident`)
- `incident_gate` (`should_alert`, `gate_reason`, `incident_id`, `rca_version`, `incident_fingerprint`)
- `incident_routing` (`severity_level`, `severity_score`, `recommended_target`)
- `impact_scope` (primary namespace impact vs supporting namespace noise)
- `signal_summary` counters
- `linear_incident_memory` (step 0 status + rows)
- `prometheus_trends` (step 3 status + rows)
- `argocd_sync` (step 4 status + rows)
- `cert_secret_health` (step 6 status + rows)
- `aws_resource_signals` (step 7 status + rows)
- `rca_result` (mode/status/confidence/agreement/degradation + JSON)
- `triage_metrics` (`evidence_completeness_pct`, step timeout/error/skip counts)
- `meta_alerts` (bot-health alerts when `lib-meta-alerts.sh` available)
- `top_container_failures` (container-level state/reason/exit/message)
- `top_log_signals` (runtime error log snippets, token-redacted)
- `impacted_repos` (pod/image -> GitHub repo correlation)
- `image_revision_signal` (image tag -> commit hint -> resolved commit)
- `suspect_prs` (auto-mapped PRs for resolved deployed commits)
- `repo_ci_signal` (latest workflow run per impacted repo)
- `pr_candidates` (repo + likely files for fix PRs)
- `ranked_hypotheses` (confidence + checks + rollback)
- Compact top issue tables

### Optional Toggles

**Feature toggles:**

- `INCLUDE_REPO_MAP=0` -- skip image->repo correlation
- `INCLUDE_CI_SIGNAL=0` -- skip GitHub Actions enrichment
- `INCLUDE_LOG_SNIPPETS=0` -- skip pod log enrichment
- `INCLUDE_IMAGE_REVISION=0` -- skip image tag -> commit -> PR enrichment

**Limit controls:**

- `CI_REPO_LIMIT=<n>` and `CI_RUN_LIMIT=<n>` -- control API load
- `LOG_SNIPPET_PODS_LIMIT=<n>`, `LOG_SNIPPET_LINES=<n>`, `LOG_SNIPPET_ERRORS_PER_CONTAINER=<n>` -- bound log scraping

**Alert tuning:**

- `ALERT_COOLDOWN_SECONDS=<n>` -- suppress duplicate alerts for unchanged incidents
- `ALERT_MIN_INTERVAL_SECONDS=<n>` -- enforce minimum spacing between any incident alerts
- `SEVERITY_*_SCORE=<n>` -- tune severity thresholds

**Routing:**

- `ROUTE_TARGET_{CRITICAL,HIGH,MEDIUM,LOW}=<target>` -- recommended routing per severity
- `PRIMARY_NAMESPACES=<ns1,ns2>` -- prioritize severity/routing for app-critical namespaces

**Service URLs:**

- `PROMETHEUS_URL=<url>` and `ARGOCD_BASE_URL=<url>` -- enable steps `03/04`

**RCA mode:**

- `RCA_MODE=single|dual|heuristic` -- Step 11 execution mode

**Memory and state:**

- `LINEAR_MEMORY_LIMIT=<n>` -- Step 0 lookup rows
- `INCIDENT_STATE_DIR`, `ACTIVE_INCIDENTS_FILE`, `RESOLVED_INCIDENTS_FILE`, `INCIDENT_LAST_ACTIVE_FILE` -- incident identity/state persistence
- `SPOOL_DIR` -- cron fallback + dedup spool

## State and Delivery Notes

- Active incident state row persists `incident_id`, namespace/category, timestamps, workloads, `rca_version`, fingerprint.
- Outbox-related columns are preserved in the state row for Slack/Linear delivery libraries.
- Spool files (`triage-*.json`) are still written for cron/heartbeat fallback and dedup.

## Heartbeat Routing Directive

- If triage says `incident_gate.should_alert=yes`, prefix alert with `[[heartbeat_to:<recommended_target>]]`
- `recommended_target` comes from `incident_routing`
- Directive is stripped before delivery text is sent
- Delivery override applies only when target is in `agents.defaults.heartbeat.routeAllowlist`

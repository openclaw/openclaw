---
name: morpho-sre
description: Morpho infra SRE skill for AWS/EKS/Helm/Kubernetes/Prometheus/Grafana/Loki/Thanos/Tempo. Correlates running images with GitHub repos using morpho-infra commons mappings, clones repos for RCA, and drives evidence-first incident triage.
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# Morpho SRE

## Hard Rules

- Diagnose first. Never mutate cluster resources automatically.
- Auto-remediation pull requests are allowed when confidence gate passes (`AUTO_PR_*`) and evidence is attached.
- Default scope: `dev-morpho` + `monitoring` namespace.
- Print command target before execution: AWS identity, kube context, namespace.
- Always include explicit Kubernetes context in commands: `kubectl --context "$K8S_CONTEXT" ...`
- Retry on repeated asks: if same/near-identical question appears again in the same thread/session, re-run relevant live checks/tools (state may have changed); do not reuse a prior failure-only answer.

## Paths

- Infra: `/Users/florian/morpho/morpho-infra`
- Helm: `/Users/florian/morpho/morpho-infra-helm`
- Commons mapping: `/Users/florian/morpho/morpho-infra/projects/commons/variables.auto.tfvars`
- Clone cache: `/home/node/.openclaw/repos`
- Correlation script: `/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh`
- Repo clone helper: `/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh`
- CI status helper: `/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh`
- Auto PR helper: `/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh`
- Grafana API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh`
- BetterStack API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh`
- Sentinel snapshot helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh`
- Sentinel triage helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh`

## Incident Workflow

1. Scope incident: impact, first seen, affected namespace/workload.
2. Build image-to-repo correlation map.
3. Find affected image, app, repo, revision.
4. Clone related repo, inspect suspect commit/config, and check CI signal.
5. Cross-check k8s state + logs + metrics + traces.
6. If confidence is high and fix is scoped, create fix PR automatically.
7. Return evidence, hypotheses, confidence, and PR URL (or blocked reason).

## Slack BetterStack Alert Intake

- Monitored channels:
  - `#staging-infra-monitoring` (dev)
  - `#public-api-monitoring` (prod)
  - `#platform-monitoring` (prod)
- Trigger on BetterStack alert/update posts (including bot-authored messages).
- Always answer in the incident thread under alert root; never post RCA in channel root.
- Keep thread reply concise (8-16 lines, no prose wall).
- Use Slack mrkdwn only:
  - bold = `*text*`, inline code = `` `text` ``
  - never use Markdown `**text**` or heading syntax (`##`, `###`)
- For each incident thread, include:
  - incident summary + impact
  - concrete evidence (k8s/events/logs/metrics/traces)
  - ranked root-cause hypotheses + confidence
  - immediate mitigations + rollback
  - validation checks + next actions
- If fix is scoped/reversible and confidence >= `AUTO_PR_MIN_CONFIDENCE`, create PR via `autofix-pr.sh` and post PR URL in-thread.
- If a thread question is vague/underspecified:
  - Do not refuse with “insufficient context” only.
  - Infer likely intent from latest triage sections (`impact_scope`, `signal_summary`, `rca_result`, `top_*` tables).
  - State assumptions explicitly in one line (`Assumption: ...`).
  - Propose 2-3 concrete next actions/solutions with commands and rollback when relevant.
  - Ask at most one clarifying question only if it materially changes the recommendation.

## Mandatory First Commands

```bash
aws sts get-caller-identity
export K8S_CONTEXT="${K8S_CONTEXT:-$(kubectl config current-context)}"
kubectl --context "$K8S_CONTEXT" get ns | sed -n '1,20p'
```

## DB Query Guardrail (Slack Threads)

- Trigger: any request about DB rows/counts/listing/filtering (for example "markets", "whitelisted", "listed", "market_warnings", "query this table", "run SQL").
- Mandatory: run at least one successful live DB query before final answer. No SQL-only conceptual replies.
- Mandatory: verify reachable schema first (`information_schema`/`\dt`) before table-specific query.
- Mandatory response evidence line:
  - `db=<host:port/dbname> schema_check=<ok|failed> query_check=<ok|failed> rows=<n>`
- If live query cannot run:
  - include exact failing command + exact error text
  - include next unblock step
  - never claim "no DB access" without attempting connectivity + credential lookup.

Preferred runbook:

```bash
# 1) Find likely DB credential source
kubectl --context "$K8S_CONTEXT" -n morpho-dev get secret | rg -i 'blue|indexer|pg|postgres'

# 2) Decode candidate secret metadata/fields (do not paste sensitive values in final answer)
kubectl --context "$K8S_CONTEXT" -n morpho-dev get secret <secret> -o json \
  | jq -r '.data | to_entries[] | "\(.key)=<redacted>"'

# 3) Run schema + target query with psql or node pg client
# psql path (preferred when available)
PGPASSWORD="$PGPASSWORD" psql -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE" \
  -c 'select table_schema, table_name from information_schema.tables order by 1,2 limit 50;'

# node pg fallback (bootstrap path prepared in container)
node <<'NODE'
const { Client } = require('/tmp/pgclient/node_modules/pg');
const c = new Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: false,
});
await c.connect();
const r = await c.query("select now()");
console.log(JSON.stringify({ rows: r.rowCount, sample: r.rows[0] }, null, 2));
await c.end();
NODE
```

## Docker Image -> GitHub Repo Correlation

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh
```

The script writes:

- `/tmp/openclaw-image-repo/image-repo-map.tsv` (`image_repo`, `github_repo`, `clone_url`, `local_repo_path`, `mapping_source`, `definition_hit`)
- `/tmp/openclaw-image-repo/workload-image-repo.tsv` (`namespace`, `pod`, `image`, `image_repo`, `github_repo`, `clone_url`, `local_repo_path`, `mapping_source`, `definition_hit`)
- Primary mapping source: `morpho-infra/projects/commons` (`github_repositories` + `ecr_repository_mapping`).
- Non-ECR images default to `morpho-org/morpho-infra` (infra source-of-truth).

Filter by image substring:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh --image morpho-blue-api
```

## Clone Repo for RCA

```bash
# Resolve from image substring and clone/update local repo mirror
/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --image morpho-blue-api

# Or clone explicit repo
/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --repo morpho-org/morpho-blue-api
```

If clone returns `403`, token lacks org repo read. Keep investigating with `workload-image-repo.tsv` `local_repo_path` values until token is fixed.

## GitHub CI Signal

```bash
# Latest workflow runs for repo resolved from workload image
/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --image morpho-blue-api --limit 5

# Latest workflow runs for explicit repo
/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --repo morpho-org/morpho-blue-api --limit 10
```

For each RCA output, include latest failing/successful run references with run URL.

## RCA Checks

```bash
# failing pods + events
kubectl --context "$K8S_CONTEXT" -n <ns> get pods -o wide
kubectl --context "$K8S_CONTEXT" -n <ns> get events --sort-by=.lastTimestamp | tail -n 40

# rollout + images
kubectl --context "$K8S_CONTEXT" -n <ns> get deploy/<name> -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
kubectl --context "$K8S_CONTEXT" -n <ns> rollout history deploy/<name>

# logs + metrics
kubectl --context "$K8S_CONTEXT" -n <ns> logs deploy/<name> --since=30m | tail -n 200
curl -s 'http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090/api/v1/alerts' | jq '.data.alerts[] | select(.state=="firing")'
```

## Sentinel Snapshot

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh
```

Use this first during heartbeat/sentinel runs. It emits:

- pod anomalies (phase/restarts/reasons)
- deployment readiness gaps
- recent warning events
- firing Prometheus alerts

## Sentinel Triage (Preferred for Heartbeat)

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh
```

Use this first in heartbeat mode. It outputs:

- 12-step pipeline (0-11):
  - `00` linear memory lookup (`linear-memory-lookup.sh`, optional)
  - `01` pod/deploy runtime signals (required)
  - `02` events + alert signals (required)
  - `03` Prometheus trends (optional)
  - `04` ArgoCD sync drift (optional)
  - `05` log signal enrichment (optional)
  - `06` cert/secret health (optional)
  - `07` AWS resource signals (optional)
  - `08` image->repo mapping (optional)
  - `09` deployed revision/PR correlation (optional)
  - `10` repo CI signal (optional)
  - `11` RCA synthesis (`RCA_MODE=single|dual|heuristic`, fallback to ranked heuristics)
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
- compact top issue tables

Optional toggles:

- `INCLUDE_REPO_MAP=0` to skip image->repo correlation
- `INCLUDE_CI_SIGNAL=0` to skip GitHub Actions enrichment
- `INCLUDE_LOG_SNIPPETS=0` to skip pod log enrichment
- `INCLUDE_IMAGE_REVISION=0` to skip image tag -> commit -> PR enrichment
- `CI_REPO_LIMIT=<n>` and `CI_RUN_LIMIT=<n>` to control API load
- `LOG_SNIPPET_PODS_LIMIT=<n>`, `LOG_SNIPPET_LINES=<n>`, `LOG_SNIPPET_ERRORS_PER_CONTAINER=<n>` to bound log scraping
- `ALERT_COOLDOWN_SECONDS=<n>` to suppress duplicate alerts for unchanged incidents
- `ALERT_MIN_INTERVAL_SECONDS=<n>` to enforce minimum spacing between any incident alerts
- `SEVERITY_*_SCORE=<n>` to tune severity thresholds
- `ROUTE_TARGET_{CRITICAL,HIGH,MEDIUM,LOW}=<target>` for recommended routing
- `PRIMARY_NAMESPACES=<ns1,ns2>` to prioritize severity/routing for app-critical namespaces
- `PROMETHEUS_URL=<url>` and `ARGOCD_BASE_URL=<url>` to enable steps `03/04`
- `RCA_MODE=single|dual|heuristic` for Step 11 execution mode
- `LINEAR_MEMORY_LIMIT=<n>` for Step 0 lookup rows
- `INCIDENT_STATE_DIR`, `ACTIVE_INCIDENTS_FILE`, `RESOLVED_INCIDENTS_FILE`, `INCIDENT_LAST_ACTIVE_FILE` for incident identity/state persistence
- `SPOOL_DIR` for cron fallback + dedup spool

State + delivery notes:

- Active incident state row persists `incident_id`, namespace/category, timestamps, workloads, `rca_version`, fingerprint.
- Outbox-related columns are preserved in the state row for Slack/Linear delivery libraries.
- Spool files (`triage-*.json`) are still written for cron/heartbeat fallback and dedup.

Heartbeat routing directive:

- If triage says `incident_gate.should_alert=yes`, prefix alert with `[[heartbeat_to:<recommended_target>]]`
- `recommended_target` comes from `incident_routing`
- Directive is stripped before delivery text is sent
- Delivery override applies only when target is in `agents.defaults.heartbeat.routeAllowlist`

## Auto Remediation PR

Use this flow only when:

- top hypothesis confidence is high (>= `AUTO_PR_MIN_CONFIDENCE`)
- patch scope is small and reversible
- validation command succeeds (lint/test/helm template/etc.)

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh \
  --repo morpho-org/<repo> \
  --path /home/node/.openclaw/repos/morpho-org/<repo> \
  --title "fix(<scope>): <short-summary>" \
  --commit "fix(<scope>): <short-summary>" \
  --confidence 90 \
  --check-cmd "<targeted validation command>" \
  --body-file /tmp/sre-pr-body.md
```

`autofix-pr.sh` enforces:

- repo allowlist (`AUTO_PR_ALLOWED_REPOS`)
- confidence threshold (`AUTO_PR_MIN_CONFIDENCE`)
- secret-pattern scan in staged diff before push
- authenticated push + `gh pr create`
- Slack DM warning to operator before PR creation (`AUTO_PR_NOTIFY_*`)

If gate fails, report blocked reason and fallback manual next step.

## Grafana Dashboard Assistance (Env-Aware)

- Use only `grafana-api.sh` wrapper; do not call Grafana with raw curl.
- Environment host policy:
  - dev bot/context: `monitoring-dev.morpho.dev`
  - prd bot/context: `monitoring.morpho.dev`
- Wrapper enforces host guard and blocks cross-environment access.
- For vague dashboard asks, do not refuse; discover what exists and guide the user with available dashboards/panels.

Discovery flow (before proposing changes):

```bash
# Check auth + target host
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET /api/health

# List folders
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET '/api/folders?limit=200'

# Search dashboards by keyword
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET '/api/search?type=dash-db&query=<keyword>'

# Inspect one dashboard (panels, queries, variables)
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET '/api/dashboards/uid/<uid>'
```

When answering users about dashboards:

- Mention target Grafana URL explicitly (`monitoring-dev.morpho.dev` or `monitoring.morpho.dev`).
- Report what is available now (folders, matching dashboards, key panels/variables).
- Provide guided next steps:
  - where to click/search in Grafana UI
  - API commands to fetch deeper details
  - safe edit plan (and rollback) if dashboard changes are requested

```bash
# Create or update dashboard from file
cat >/tmp/dashboard-payload.json <<'EOF'
{
  "dashboard": {
    "id": null,
    "uid": null,
    "title": "OpenClaw SRE - Dev Test",
    "timezone": "browser",
    "schemaVersion": 39,
    "version": 0,
    "panels": []
  },
  "folderId": 0,
  "overwrite": false
}
EOF
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh POST /api/dashboards/db /tmp/dashboard-payload.json
```

## BetterStack Incident API

Use BetterStack API for incident metadata when token is available:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents?per_page=5'
```

If incident id is known:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents/<id>'
```

## Subagent Team Pattern

Use specialized subagents for speed:

```bash
/subagents spawn sre-k8s "Inspect pod health/events for <ns>/<workload> and summarize top 3 failure signals."
/subagents spawn sre-observability "Check Prometheus alerts + Grafana panels for <service>, list anomaly windows."
/subagents spawn sre-release "Correlate image tag to repo commits and recent CI runs."
```

## References

- `references/repo-map.md`
- `references/safety.md`

## Output Contract

- Summary
- Evidence (commands + concrete output snippets)
- Root-cause hypotheses (ranked + confidence)
- Next commands
- PR URL when created (or blocked reason + manual fallback)

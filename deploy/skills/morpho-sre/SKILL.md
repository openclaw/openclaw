---
name: morpho-sre
description: Morpho infra SRE skill for AWS/EKS/Helm/Kubernetes/Prometheus/Grafana/Loki/Thanos/Tempo. Correlates running images with GitHub repos using morpho-infra commons mappings, clones repos for RCA, and drives evidence-first incident triage.
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# Morpho SRE

## Hard Rules

- Diagnose first. Mutate only after explicit approval.
- Default scope: `dev-morpho` + `monitoring` namespace.
- Print command target before execution: AWS identity, kube context, namespace.

## Paths

- Infra: `/Users/florian/morpho/morpho-infra`
- Helm: `/Users/florian/morpho/morpho-infra-helm`
- Commons mapping: `/Users/florian/morpho/morpho-infra/projects/commons/variables.auto.tfvars`
- Clone cache: `/home/node/.openclaw/repos`
- Correlation script: `/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh`
- Repo clone helper: `/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh`
- CI status helper: `/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh`
- Grafana API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh`
- Sentinel snapshot helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh`
- Sentinel triage helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh`

## Incident Workflow

1. Scope incident: impact, first seen, affected namespace/workload.
2. Build image-to-repo correlation map.
3. Find affected image, app, repo, revision.
4. Clone related repo, inspect suspect commit/config, and check CI signal.
5. Cross-check k8s state + logs + metrics + traces.
6. Return evidence, hypotheses, confidence, and minimal next checks.

## Mandatory First Commands

```bash
aws sts get-caller-identity
kubectl config current-context
kubectl get ns | sed -n '1,20p'
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
kubectl -n <ns> get pods -o wide
kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -n 40

# rollout + images
kubectl -n <ns> get deploy/<name> -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
kubectl -n <ns> rollout history deploy/<name>

# logs + metrics
kubectl -n <ns> logs deploy/<name> --since=30m | tail -n 200
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

- `health_status` (`state\tok|incident`)
- `incident_gate` (`should_alert`, `gate_reason`, `incident_fingerprint`)
- `incident_routing` (`severity_level`, `severity_score`, `recommended_target`)
- `impact_scope` (primary namespace impact vs supporting namespace noise)
- `signal_summary` counters
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
- `SEVERITY_*_SCORE=<n>` to tune severity thresholds
- `ROUTE_TARGET_{CRITICAL,HIGH,MEDIUM,LOW}=<target>` for recommended routing
- `PRIMARY_NAMESPACES=<ns1,ns2>` to prioritize severity/routing for app-critical namespaces

Heartbeat routing directive:

- If triage says `incident_gate.should_alert=yes`, prefix alert with `[[heartbeat_to:<recommended_target>]]`
- `recommended_target` comes from `incident_routing`
- Directive is stripped before delivery text is sent
- Delivery override applies only when target is in `agents.defaults.heartbeat.routeAllowlist`

## Grafana Dashboard Create/Update (Dev Only)

- Use only `grafana-api.sh` wrapper; do not call Grafana with raw curl.
- Wrapper enforces host guard via `GRAFANA_ALLOWED_HOST` (dev must be `monitoring-dev.morpho.dev`).

```bash
# Check API health
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET /api/health

# Search dashboards
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET '/api/search?type=dash-db&query='

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
- Approval request (only if mutation required)

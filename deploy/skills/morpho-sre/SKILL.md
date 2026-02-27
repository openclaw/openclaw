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
- Grafana API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh`

## Incident Workflow

1. Scope incident: impact, first seen, affected namespace/workload.
2. Build image-to-repo correlation map.
3. Find affected image, app, repo, revision.
4. Clone related repo and inspect suspect commit/config.
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
bash /home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh
```

The script writes:

- `/tmp/openclaw-image-repo/image-repo-map.tsv` (`image_repo`, `github_repo`, `clone_url`, `local_repo_path`, `mapping_source`, `definition_hit`)
- `/tmp/openclaw-image-repo/workload-image-repo.tsv` (`namespace`, `pod`, `image`, `image_repo`, `github_repo`, `clone_url`, `local_repo_path`, `mapping_source`, `definition_hit`)
- Primary mapping source: `morpho-infra/projects/commons` (`github_repositories` + `ecr_repository_mapping`).
- Non-ECR images default to `morpho-org/morpho-infra` (infra source-of-truth).

Filter by image substring:

```bash
bash /home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh --image morpho-blue-api
```

## Clone Repo for RCA

```bash
mkdir -p /home/node/.openclaw/repos
local_repo_path="$(awk -F'\t' 'NR>1 && $7 != "" {print $7; exit}' /tmp/openclaw-image-repo/workload-image-repo.tsv)"
if [ -n "$local_repo_path" ]; then
  echo "Use local snapshot: $local_repo_path"
fi

repo="$(awk -F'\t' 'NR>1 {print $6; exit}' /tmp/openclaw-image-repo/workload-image-repo.tsv)"
slug="${repo#https://github.com/}"
slug="${slug%.git}"
dest="/home/node/.openclaw/repos/$slug"
auth_url="$repo"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth_url="https://x-access-token:${GITHUB_TOKEN}@github.com/${slug}.git"
fi
if [ -d "$dest/.git" ]; then
  git -C "$dest" fetch --all --prune
else
  git clone --filter=blob:none "$auth_url" "$dest"
fi
```

If clone returns `403`, token lacks org repo read. Keep investigating with `local_repo_path` until token is fixed.

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

## Grafana Dashboard Create/Update (Dev Only)

- Use only `grafana-api.sh` wrapper; do not call Grafana with raw curl.
- Wrapper enforces host guard via `GRAFANA_ALLOWED_HOST` (dev must be `monitoring-dev.morpho.dev`).

```bash
# Check API health
bash /home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET /api/health

# Search dashboards
bash /home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET '/api/search?type=dash-db&query='

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
bash /home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh POST /api/dashboards/db /tmp/dashboard-payload.json
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

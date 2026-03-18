# Grafana Dashboard Assistance

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Reference for Grafana dashboard discovery, inspection, and management via the env-aware API wrapper.

## Environment Host Policy

- **Dev** bot/context: `monitoring-dev.morpho.dev`
- **Prd** bot/context: `monitoring.morpho.dev`

The wrapper enforces a host guard and blocks cross-environment access.

## Key Rules

- Use only `grafana-api.sh` wrapper; do not call Grafana with raw curl.
- For vague dashboard asks, do not refuse; discover what exists and guide the user with available dashboards/panels.
- Mention target Grafana URL explicitly in answers.

## Discovery Flow

Always run discovery before proposing changes:

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

## Answering Dashboard Questions

When answering users about dashboards:

- Mention target Grafana URL explicitly (`monitoring-dev.morpho.dev` or `monitoring.morpho.dev`).
- Report what is available now (folders, matching dashboards, key panels/variables).
- Provide guided next steps:
  - Where to click/search in Grafana UI
  - API commands to fetch deeper details
  - Safe edit plan (and rollback) if dashboard changes are requested

## Create or Update Dashboard

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

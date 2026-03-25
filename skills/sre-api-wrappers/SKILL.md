---
name: sre-api-wrappers
description: "Use when querying Grafana dashboards, Wiz security posture, Dune onchain analytics, eRPC config, Sentry errors, Intercom support data, BetterStack incidents, or Linear tickets in Morpho infrastructure. Quick reference for all SRE API wrapper scripts."
metadata: { "openclaw": { "emoji": "🔌" } }
---

# SRE API Wrappers

Companion skill to `morpho-sre`. Load `morpho-sre` for hard rules, paths, and knowledge surfaces.

Reply with conclusions only in ALL communications — Slack, DMs, PR comments, Linear comments, every output surface. No investigation steps, intermediate reasoning, or tool output summaries. All investigation work happens silently; only the final summary is sent.

## When to Use

- Querying Grafana dashboards or metrics
- Checking Wiz security posture (vulnerabilities, issues, cloud config, k8s)
- Running Dune onchain analytics queries
- Inspecting eRPC config, routing, or caching behavior
- Looking up Sentry errors, events, or stack traces
- Looking up Intercom contacts, conversations, companies, or tickets
- Checking BetterStack incident metadata
- Managing Linear tickets (create, update, comment, attach)
- Any request that involves one of the wrapper scripts below

## Script Quick Reference

All scripts live under `/home/node/.openclaw/skills/morpho-sre/scripts/`.

| Script                             | Purpose                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `grafana-api.sh`                   | Grafana dashboard/panel/folder CRUD and query                    |
| `wiz-api.sh`                       | Wiz security posture: vulns, issues, cloud-config, k8s, runtime  |
| `dune-cli.sh`                      | Dune onchain analytics: run SQL, search datasets, manage queries |
| `erpc-api.sh`                      | eRPC chain endpoint calls with auto-injected secret              |
| `erpc-context.sh`                  | Build local eRPC context bundle (config, metrics, docs)          |
| `sentry-api.sh`                    | Sentry REST API wrapper (issues, events, releases)               |
| `sentry-cli.sh`                    | Sentry CLI wrapper (info, releases, sourcemaps)                  |
| `intercom-api.sh`                  | Intercom read-only REST wrapper (contacts, convos, tickets)      |
| `betterstack-api.sh`               | BetterStack incident and monitor API                             |
| `linear-ticket-api.sh`             | Linear issue CRUD, comments, labels, attachments, branch names   |
| `posthog-mcp.sh`                   | PostHog MCP launcher for session replays and events              |
| `frontend-project-resolver.sh`     | Infer Morpho frontend project from a user question               |
| `consumer-bug-preflight.sh`        | Consolidated probe for consumer tx bugs                          |
| `image-repo-map.sh`                | Docker image to GitHub repo correlation                          |
| `repo-clone.sh`                    | Clone/update repo mirrors for RCA                                |
| `github-ci-status.sh`              | GitHub Actions workflow run status                               |
| `db-evidence.sh`                   | DB investigation collector (summary/schema/data/replica)         |
| `autofix-pr.sh`                    | Auto-remediation PR pipeline with confidence gate                |
| `sentinel-snapshot.sh`             | Quick cluster health snapshot                                    |
| `sentinel-triage.sh`               | Full 12-step triage pipeline for heartbeat                       |
| `single-vault-graphql-evidence.sh` | Single-vault GraphQL comparison tool                             |

## Auth Probing

Before using any wrapper, verify auth is working:

```bash
# Grafana
grafana-api.sh GET /api/health

# Wiz
wiz-api.sh --probe-auth | jq

# Dune
dune-cli.sh --probe-auth

# Sentry
sentry-cli.sh dev info
sentry-cli.sh prd info

# Intercom
intercom-api.sh --probe-auth

# BetterStack
betterstack-api.sh GET '/incidents?per_page=1'

# Linear
linear-ticket-api.sh probe-write PLA-318

# PostHog
posthog-mcp.sh dev --probe-auth
posthog-mcp.sh prd --probe-auth
```

## Environment-Aware Host Policies

- **Grafana**: dev = `monitoring-dev.morpho.dev`, prd = `monitoring.morpho.dev`. Wrapper enforces host guard.
- **Sentry/PostHog**: use `dev` or `prd` argument to scope to the correct environment.
- **eRPC**: default host `https://rpc.morpho.dev`, can enforce allowlist with `ERPC_ALLOWED_HOSTS`.
- **Dune**: read-only by default; mutations require `DUNE_ALLOW_MUTATIONS=1`.
- **Wiz**: authenticates via OAuth2 client credentials; token cached at `/tmp/wiz-api-token.json`.

## Grafana

```bash
# List folders
grafana-api.sh GET '/api/folders?limit=200'

# Search dashboards
grafana-api.sh GET '/api/search?type=dash-db&query=<keyword>'

# Get dashboard by UID
grafana-api.sh GET '/api/dashboards/uid/<uid>'

# Create/update dashboard from file
grafana-api.sh POST /api/dashboards/db /tmp/dashboard-payload.json
```

See `morpho-sre/references/grafana-operations.md` for the full Grafana discovery flow.

## Wiz

```bash
# Vulnerabilities: critical + high with known fix
wiz-api.sh vulns --severity CRITICAL,HIGH --has-fix

# Open critical issues
wiz-api.sh issues --severity CRITICAL --status OPEN

# Cloud config findings
wiz-api.sh cloud-config --severity CRITICAL,HIGH

# Kubernetes cluster posture
wiz-api.sh k8s

# Runtime security events
wiz-api.sh runtime --severity CRITICAL,HIGH

# Full posture summary
wiz-api.sh summary | jq

# Raw GraphQL query
wiz-api.sh query '{ issues(first: 5) { nodes { id severity } } }'
```

## Dune

```bash
# Ad-hoc DuneSQL query
dune-cli.sh query run-sql --sql "SELECT number, time FROM ethereum.blocks ORDER BY number DESC LIMIT 5"

# Search decoded tables by contract
dune-cli.sh dataset search-by-contract --contract-address 0x1234... --include-schema

# Search datasets by keyword
dune-cli.sh dataset search --query "morpho blue" --categories decoded --include-schema

# Docs search (no auth required)
dune-cli.sh docs search "varbinary"
```

DuneSQL references: `morpho-sre/references/dune/` (cheatsheet, dataset discovery, query execution, query management, docs and usage).

## eRPC

```bash
# Build context bundle first
erpc-context.sh

# Chain endpoint GET
erpc-api.sh GET '1'

# Chain POST with payload
erpc-api.sh POST '8453' /tmp/payload.json
```

For deeper eRPC investigation, read the context bundle at `/tmp/openclaw-erpc-context/`.

## Sentry

```bash
# List issues for an org
sentry-api.sh prd '/api/0/organizations/<org>/issues/'

# Get specific event
sentry-api.sh prd '/api/0/issues/<issue_id>/events/latest/'
```

## Intercom

```bash
# Current admin identity + auth probe
intercom-api.sh --probe-auth

# Contact lookup
intercom-api.sh contacts list --per-page 25

# Conversation lookup
intercom-api.sh conversations get 123456789

# Search contacts or tickets with an Intercom JSON query body
intercom-api.sh contacts search --body-file /tmp/intercom-contact-search.json
intercom-api.sh tickets search --body '{"query":{"operator":"AND","value":[]}}'
```

## BetterStack

```bash
# Recent incidents
betterstack-api.sh GET '/incidents?per_page=5'

# Specific incident
betterstack-api.sh GET '/incidents/<id>'
```

## Linear

```bash
# Get issue
linear-ticket-api.sh issue get PLA-318

# Create issue
linear-ticket-api.sh issue create --title "..." --file /tmp/desc.md --team Platform --project "[PLATFORM] Backlog" --assignee florian --state "In Progress" --priority 2 --labels "openclaw-sre|Bug"

# Get branch name
linear-ticket-api.sh issue get-branch PLA-318

# Add comment
linear-ticket-api.sh issue add-comment PLA-318 --file /tmp/comment.md

# Ensure label
linear-ticket-api.sh issue ensure-label PLA-318 openclaw-sre

# Attach PR URL
linear-ticket-api.sh issue add-attachment PLA-318 https://github.com/morpho-org/repo/pull/123
```

## Detailed Guides

Each wrapper has a detailed reference file under `morpho-sre/references/` (e.g. `erpc-operations.md`, `grafana-operations.md`, `api-wrappers-guide.md`). For Dune specifically, see `morpho-sre/references/dune/` for comprehensive DuneSQL references.

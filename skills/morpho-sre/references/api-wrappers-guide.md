# API Wrappers Quick Reference

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Quick-reference for all API wrapper scripts used in Morpho SRE investigations. Each wrapper handles authentication, credential resolution, and environment scoping.

## Wiz API (Direct GraphQL)

**Script:** `/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh`

Authenticates via OAuth2 client credentials and queries the Wiz GraphQL API directly at `https://api.eu26.app.wiz.io/graphql`.

**Credential resolution:** Vault `secret/data/wiz/api-token` (KV v2 API path) > `WIZ_CLIENT_ID`/`WIZ_CLIENT_SECRET`.

Token is cached at `/tmp/wiz-api-token.json` (chmod 600) and auto-refreshed. Pre-built subcommands auto-paginate (default max 10 pages). Raw `query` subcommand does not auto-paginate.

```bash
# Probe auth
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh --probe-auth | jq

# Show config (redacted)
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh --print-plan | jq

# Raw GraphQL query
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh query '{ issues(first: 5) { nodes { id severity } } }'

# Vulnerabilities - critical + high, with known fix
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh vulns --severity CRITICAL,HIGH --has-fix

# Issues - open critical
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh issues --severity CRITICAL --status OPEN

# Cloud config findings
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh cloud-config --severity CRITICAL,HIGH

# Kubernetes cluster posture
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh k8s

# Runtime security events
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh runtime --severity CRITICAL,HIGH

# Full posture summary (counts by severity)
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh summary | jq
```

## Dune CLI

**Script:** `/home/node/.openclaw/skills/morpho-sre/scripts/dune-cli.sh`

**Credential chain:** `DUNE_API_KEY` env > Vault token (fast) > Vault K8s JWT (slow)

**Vault path:** `secret/data/openclaw-sre/all-secrets` (key: `DUNE_API_KEY`)

- Read-only by default; mutation commands (`query create`, `query update`, `query archive`) require `DUNE_ALLOW_MUTATIONS=1`.
- Always outputs JSON by default (`--output json`).
- The `--api-key` flag is blocked to prevent credential leakage via process args.
- `docs search` subcommand works without authentication.

```bash
# Probe credential resolution
/home/node/.openclaw/skills/morpho-sre/scripts/dune-cli.sh --probe-auth

# Run ad-hoc DuneSQL query
/home/node/.openclaw/skills/morpho-sre/scripts/dune-cli.sh query run-sql \
  --sql "SELECT number, time FROM ethereum.blocks ORDER BY number DESC LIMIT 5"

# Search decoded tables for a contract
/home/node/.openclaw/skills/morpho-sre/scripts/dune-cli.sh dataset search-by-contract \
  --contract-address 0x1234... --include-schema

# Search datasets by keyword
/home/node/.openclaw/skills/morpho-sre/scripts/dune-cli.sh dataset search \
  --query "morpho blue" --categories decoded --include-schema
```

**Note:** `ethereum.blocks` uses columns `number` and `time` (not `block_number`/`block_time`). Some upstream Dune reference docs use the wrong names -- always verify with `dataset search --include-schema`.

**DuneSQL references (loaded on demand):**

- `dune/dunesql-cheatsheet.md` -- types, functions, common patterns
- `dune/dataset-discovery.md` -- dataset search and contract lookup
- `dune/query-execution.md` -- run, run-sql, execution results
- `dune/query-management.md` -- create, get, update, archive
- `dune/docs-and-usage.md` -- docs search and credit usage

## BetterStack Incident API

**Script:** `/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh`

Use BetterStack API for incident metadata when token is available.

```bash
# List recent incidents
/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents?per_page=5'

# Get specific incident by ID
/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents/<id>'
```

## Sentry

**Scripts:**

- `/home/node/.openclaw/skills/morpho-sre/scripts/sentry-api.sh` -- REST API wrapper
- `/home/node/.openclaw/skills/morpho-sre/scripts/sentry-cli.sh` -- CLI wrapper

Used for JS/runtime issue groups, stack traces, event payloads, and release correlation after bad frontend deploys.

```bash
# Check Sentry CLI access
/home/node/.openclaw/skills/morpho-sre/scripts/sentry-cli.sh dev info

# Query Sentry API (env-scoped)
/home/node/.openclaw/skills/morpho-sre/scripts/sentry-api.sh prd '/api/0/organizations/<org>/issues/'
```

Keep probes env-scoped:

- `sentry-* dev` for dev
- `sentry-* prd` for prod

Do not call raw Sentry endpoints when wrappers exist. Never answer with "no access" for Sentry without a live probe and the exact error.

## Grafana API

**Script:** `/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh`

See `grafana-operations.md` for full details. Quick probe:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh GET /api/health
```

## Linear Ticket API

**Script:** `/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh`

```bash
# Probe write access
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh probe-write PLA-318

# Inspect issue
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue get PLA-318

# Get branch name
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue get-branch PLA-318
```

## eRPC API

**Script:** `/home/node/.openclaw/skills/morpho-sre/scripts/erpc-api.sh`

See `erpc-operations.md` for full details. Quick probe:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/erpc-api.sh GET '1'
```

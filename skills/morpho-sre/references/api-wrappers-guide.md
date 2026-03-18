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

## Notion API

**Script:** `/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh`

**Credential chain:** `NOTION_SECRET` env > `NOTION_TOKEN` env > Vault token (fast) > Vault K8s JWT (slow)

**Vault path:** `secret/data/openclaw-sre/all-secrets` (key: `NOTION_SECRET`)

- Read-only wrapper around the Notion REST API for Morpho's internal integration token.
- Default Notion version is pinned to `2025-09-03` because the current data-source APIs are versioned there; override with `NOTION_API_VERSION` if needed.
- Search is title-oriented only. For row filtering inside a Notion table, use `data-source query`.

```bash
# Probe auth / workspace identity
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh --probe-auth

# Inspect current bot user + workspace metadata
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh me

# Search shared pages or data sources by title
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh search --query "post mortem" --filter page

# Fetch a database container to list its child data sources
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh database get <database-id-or-url>

# Fetch a data source schema
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh data-source get <data-source-id-or-url>

# Query rows from a data source with a custom Notion filter body
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh data-source query <data-source-id-or-url> \
  --body-file /tmp/notion-query.json --filter-properties title,f%5C%5C%3Ap

# Retrieve a page plus selected properties by property ID
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh page get <page-id-or-url> --filter-properties title,f%5C%5C%3Ap

# Retrieve a large relation/rollup/title property accurately using the property ID from Notion
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh page property <page-id-or-url> <property-id>

# Retrieve page content as Markdown
/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh page markdown <page-id-or-url>
```

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

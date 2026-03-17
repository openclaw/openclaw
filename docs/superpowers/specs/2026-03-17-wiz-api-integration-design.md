# Wiz GraphQL API Integration

Direct Wiz GraphQL API client for the SRE bot. Queries vulnerability findings, security issues, cloud configuration, Kubernetes posture, runtime events, and resource inventory. Returns structured JSON for bot-driven analysis.

## Architecture

Single self-contained script (`wiz-api.sh`) following the `linear-ticket-api.sh` / `grafana-api.sh` pattern. Credential loading logic is duplicated from `wiz-mcp.sh` (not extracted to shared lib) to preserve the single-file, self-contained deployment model.

### Authentication

OAuth2 client credentials flow:

1. POST `https://auth.app.wiz.io/oauth/token` with `grant_type=client_credentials`, `client_id`, `client_secret`, `audience=wiz-api`
   - The auth endpoint is global across all Wiz data centers (not DC-specific).
2. Response: `{ "access_token": "...", "expires_in": N, "token_type": "Bearer" }`
3. Cache token atomically: write to temp file (`mktemp`), `chmod 600`, then `mv` to `$WIZ_API_TOKEN_CACHE`
4. Cache format: `{ "access_token": "...", "expires_at": <epoch> }`
5. Reuse cached token if `expires_at` is more than 60 seconds in the future
6. On 401 from API (detected via `curl -o <body> -w '%{http_code}'`): invalidate cache, re-authenticate once, retry the original request. Other HTTP errors fail immediately.

### Credential Loading

Duplicates the Vault-first / env-fallback pattern from `wiz-mcp.sh` (same Vault secret, same fields):

1. Vault: Kubernetes JWT auth → `secret/data/wiz/api-token` → `client_id` + `client_secret`
2. Env: `WIZ_CLIENT_ID` + `WIZ_CLIENT_SECRET`
3. Fail with clear error if neither source provides credentials

Both `wiz-api.sh` and `wiz-mcp.sh` share the same Vault secret path (`secret/data/wiz/api-token`) and read the same `client_id`/`client_secret` fields. No separate Vault entries needed.

Skip Vault with `WIZ_API_SKIP_VAULT=1`.

### Endpoints

- Auth: `https://auth.app.wiz.io/oauth/token` (override: `WIZ_AUTH_URL`)
- API: `https://api.eu26.app.wiz.io/graphql` (override: `WIZ_API_URL`)

The API URL defaults to the Morpho Wiz tenant (`eu26`). Override `WIZ_API_URL` for other data centers.

### Pagination

Pre-built subcommands auto-paginate:

- Detect `pageInfo.hasNextPage` + `pageInfo.endCursor` in response at the known JSON path for each subcommand
- Pass `endCursor` as `$after` variable in next request
- Merge `nodes` arrays across pages into single result
- Stop at `WIZ_API_MAX_PAGES` (default: 10)

The raw `query` subcommand does **not** auto-paginate — it returns the single response as-is.

### Error Handling

- Errors to stderr as `wiz-api: <message>` (matches `wiz-mcp.sh` plain-text pattern)
- GraphQL errors: extract `errors[0].message` from response and die
- curl failures: report exit code and HTTP status
- Rate limiting: on HTTP 429, report the error (no built-in backoff)
- Default curl timeout: 30 seconds (override: `WIZ_API_TIMEOUT`)

## Subcommands

### Operational

| Subcommand     | Purpose                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| `--probe-auth` | Authenticate and return JSON status (`ok`, `token_expiry`, `credential_source`)         |
| `--print-plan` | Show redacted config (endpoint, credential source, cache path). Never includes secrets. |

### Raw Query

```bash
wiz-api.sh query '<graphql_string>' ['<variables_json>']
wiz-api.sh query @file.graphql ['<variables_json>']
```

Executes arbitrary GraphQL. If query string starts with `@`, reads from file. No auto-pagination — returns the raw response.

### Pre-built Queries

| Subcommand     | Wiz GraphQL operation                                                                    | Key filters                                                               | Default `first` |
| -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------- |
| `vulns`        | `vulnerabilityFindings`                                                                  | `--severity`, `--image`, `--cve`, `--has-fix` (flag, no value), `--first` | 50              |
| `issues`       | `issuesV2`                                                                               | `--severity`, `--status`, `--type`, `--entity-type`, `--first`            | 50              |
| `inventory`    | `graphSearch`                                                                            | `--type`, `--subscription`, `--search`, `--first`                         | 50              |
| `cloud-config` | `configurationFindings`                                                                  | `--severity`, `--rule`, `--status`, `--first`                             | 50              |
| `k8s`          | `kubernetesClusters`                                                                     | `--cluster`, `--first`                                                    | 20              |
| `runtime`      | `cloudEvents`                                                                            | `--severity`, `--first`                                                   | 50              |
| `summary`      | Aliased `issuesV2` + `vulnerabilityFindings` + `configurationFindings` with `totalCount` | (none)                                                                    | n/a             |

All pre-built subcommands:

- Accept `--first N` to control page size
- Accept `--max-pages N` to override `WIZ_API_MAX_PAGES` for that call
- Output compact JSON (`jq -c`) to stdout
- Output errors to stderr as plain text

### `summary` subcommand

Runs three aggregation queries and emits a combined JSON object:

1. `issueAnalytics` — issue counts grouped by severity
2. `vulnerabilityFindingAggregates` — vulnerability counts grouped by severity
3. `configurationFindingAggregates` — config finding counts grouped by severity

```json
{
  "issues": { "critical": 0, "high": 0, "medium": 0, "low": 0, "informational": 0 },
  "vulnerabilities": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "configurationFindings": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "timestamp": "2026-03-17T12:00:00Z"
}
```

Note: exact GraphQL operation names will be validated against the live Wiz schema during implementation. The aggregation queries above are the expected operations; if the schema differs, equivalent queries will be substituted.

## Environment Variables

| Variable                    | Default                               | Purpose                                |
| --------------------------- | ------------------------------------- | -------------------------------------- |
| `WIZ_CLIENT_ID`             | (required)                            | OAuth2 client ID                       |
| `WIZ_CLIENT_SECRET`         | (required)                            | OAuth2 client secret                   |
| `WIZ_API_URL`               | `https://api.eu26.app.wiz.io/graphql` | GraphQL endpoint                       |
| `WIZ_AUTH_URL`              | `https://auth.app.wiz.io/oauth/token` | OAuth2 token endpoint                  |
| `WIZ_API_TOKEN_CACHE`       | `/tmp/wiz-api-token.json`             | Token cache file path                  |
| `WIZ_API_MAX_PAGES`         | `10`                                  | Max pagination pages                   |
| `WIZ_API_TIMEOUT`           | `30`                                  | curl timeout in seconds                |
| `WIZ_API_SKIP_VAULT`        | `0`                                   | Skip Vault credential loading          |
| `WIZ_API_VAULT_SECRET_PATH` | `secret/data/wiz/api-token`           | Vault secret path (same as wiz-mcp.sh) |
| `WIZ_API_CURL_BIN`          | `curl`                                | curl binary (testability)              |
| `WIZ_API_JQ_BIN`            | `jq`                                  | jq binary (testability)                |

## Files

| File                                   | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `skills/morpho-sre/wiz-api.sh`         | Main script                                              |
| `test/sre-substrate/test-wiz-api.sh`   | Integration tests                                        |
| `skills/morpho-sre/SKILL.md`           | Add Wiz API section + paths entry                        |
| `skills/morpho-sre/knowledge-index.md` | Add entry for wiz-api.sh                                 |
| `scripts/sre-runtime/start-gateway.sh` | No changes needed (WIZ_CLIENT_ID/SECRET already trimmed) |

## SKILL.md Additions

### Paths section

Add after the existing Wiz MCP launcher entry:

```
- Wiz API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh`
```

### New "Wiz API (Direct GraphQL)" section (after existing "Wiz MCP" section)

```markdown
## Wiz API (Direct GraphQL)

- `wiz-api.sh` authenticates via OAuth2 client credentials and queries the Wiz
  GraphQL API directly at `https://api.eu26.app.wiz.io/graphql`.
- Credential resolution: Vault `secret/data/wiz/api-token` (KV v2 API path) > `WIZ_CLIENT_ID`/`WIZ_CLIENT_SECRET`.
- Token is cached at `/tmp/wiz-api-token.json` (chmod 600) and auto-refreshed.
- Pre-built subcommands auto-paginate (default max 10 pages).
- Raw `query` subcommand does not auto-paginate.

### Usage examples

# Probe auth

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh --probe-auth | jq

# Show config (redacted)

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh --print-plan | jq

# Raw GraphQL query

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh query '{ issues(first: 5) { nodes { id severity } } }'

# Vulnerabilities - critical + high, with known fix

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh vulns --severity critical,high --has-fix

# Issues - open critical

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh issues --severity critical --status open

# Cloud config findings

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh cloud-config --severity critical,high

# Kubernetes cluster posture

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh k8s

# Runtime security events

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh runtime --severity critical,high

# Full posture summary (counts by severity)

/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh summary | jq
```

### knowledge-index.md entry

```markdown
- `wiz-api.sh`
  Direct Wiz GraphQL API client. OAuth2 auth with file-based token caching.
  Queries vulnerabilities, issues, cloud config, Kubernetes posture, runtime
  events, and resource inventory. Uses the same Vault credentials as wiz-mcp.sh.
```

## Testing

`test/sre-substrate/test-wiz-api.sh` following the `test-wiz-mcp.sh` pattern:

1. **Mock curl** that intercepts both auth endpoint and GraphQL endpoint, returning appropriate JSON
2. **Auth tests**: verify token request payload (grant_type, client_id, audience), token caching to file, cache reuse on second call, cache invalidation on expiry
3. **Query tests**: verify GraphQL payload construction (`query` + `variables` fields), variable passing
4. **Subcommand tests**: verify filter → GraphQL variable mapping for each pre-built subcommand
5. **Pagination tests**: mock multi-page response with `pageInfo`, verify merged `nodes` output
6. **Probe tests**: verify `--probe-auth` returns JSON with `ok`, `credential_source`
7. **Plan tests**: verify `--print-plan` output does not contain secret values
8. **Credential fallback tests**: Vault preferred over env, env works when Vault skipped, missing creds fail
9. **Token cache security**: verify cache file has `600` permissions

## Non-goals

- Replaces `wiz-mcp.sh` (MCP launcher removed — direct API access is preferred)
- No write/mutation operations (read-only queries only)
- No built-in alerting or cron — the bot invokes on demand
- No built-in rate limiting / backoff (reports 429 errors, bot decides retry strategy)

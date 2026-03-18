# eRPC Operations

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Reference for eRPC API usage, context bundle, and Foundry skill integration. Use this when investigating RPC routing, caching, provider limits, or metrics questions.

## Canonical Endpoint

```
https://rpc.morpho.dev/cache/evm/<chainId>?secret=<FLO_TEST_API_KEY>
```

- Always use `FLO_TEST_API_KEY` via URL query parameter `secret`.
- Prefer the wrapper script; do not handcraft raw `curl` URLs without `secret`.

## Wrapper Behavior

- chainId target resolves to `${ERPC_API_BASE}/cache/evm/<chainId>`
- Injects/replaces `secret=<FLO_TEST_API_KEY>` in URL query
- Default base host is `https://rpc.morpho.dev`
- Can enforce host allowlist with `ERPC_ALLOWED_HOSTS` (defaults to `rpc.morpho.dev`)

## API Wrapper Usage

```bash
# Build local eRPC context bundle first
/home/node/.openclaw/skills/morpho-sre/scripts/erpc-context.sh

# Canonical chain endpoint
/home/node/.openclaw/skills/morpho-sre/scripts/erpc-api.sh GET '1'

# Chain-specific POST
/home/node/.openclaw/skills/morpho-sre/scripts/erpc-api.sh POST '8453' /tmp/payload.json

# Absolute canonical URL also supported (secret auto-updated)
/home/node/.openclaw/skills/morpho-sre/scripts/erpc-api.sh GET 'https://rpc.morpho.dev/cache/evm/10?chain=eth&secret=old'
```

## Context Bundle

Run `erpc-context.sh` first for any Morpho eRPC / RPC question about config, routing, caching, providers, limits, or metrics.

After running, read:

- `/tmp/openclaw-erpc-context/summary.md` -- overview
- `/tmp/openclaw-erpc-context/status.tsv` -- current status
- `/tmp/openclaw-erpc-context/prod-config.redacted.yaml` -- current prod config snapshot (when Vault access succeeds)
- `/tmp/openclaw-erpc-context/metrics.tsv` -- metric names and meanings (plus upstream telemetry/docs)
- `/tmp/openclaw-erpc-context/upstream-repo` -- deeper code search when docs are insufficient

If Vault auth fails, say that explicitly and continue with Morpho Helm values + upstream docs/code; do not guess the live config.

### Context Bundle Sources

- Redacted prod config from Vault path `secret/erpc/config` field `config`
- Upstream repo/docs snapshots from `https://github.com/0x666c6f/erpc`
- Extracted metrics catalog from `telemetry/metrics.go`
- Morpho local references:
  - `morpho-infra/docs/architecture/erpc.md`
  - `morpho-infra/docs/operations/erpc-operations.md`
  - `morpho-infra-helm/environments/prd/erpc/values.yaml`
  - `morpho-infra-helm/charts/erpc/templates/job-vault-config.yaml`

## Foundry Skill Integration

For onchain state inspection, transaction replay, forked simulation, or EVM execution traces, use the bundled `foundry-evm-debug` skill instead of ad hoc `cast` or `anvil` commands.

When switching to the bundled Foundry skill:

- Keep `RPC_SECRET` sourced from Vault-backed runtime env
- Prefer `skills/foundry-evm-debug/scripts/rpc-url.sh <chainId>` over hardcoded URLs
- Use clean worktrees before correlating traces with protocol source
- Prefer forked simulation + impersonation over real signing keys

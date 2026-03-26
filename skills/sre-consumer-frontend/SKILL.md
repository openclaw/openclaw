---
name: sre-consumer-frontend
description: "Use when investigating consumer app wallet failures, permit/approval errors, transaction reverts, offchain signature issues, or frontend bugs on app.morpho.org. Covers consumer-bug-preflight.sh, PostHog, Sentry, and known issue families."
metadata: { "openclaw": { "emoji": "📱" } }
---

# SRE Consumer Frontend

Companion skill to `morpho-sre`. Load `morpho-sre` for hard rules, paths, and knowledge surfaces.

Reply with conclusions only in ALL communications — Slack, DMs, PR comments, Linear comments, every output surface. No investigation steps, intermediate reasoning, or tool output summaries. All investigation work happens silently; only the final summary is sent.

## When to Use

- Consumer app / wallet / permit / approval / allowance / repay failure
- Transaction reverts or offchain signature issues on `app.morpho.org`
- Frontend rendering or UI bugs on any Morpho consumer surface
- PostHog session replay or Sentry error group investigation

## Decision Tree

Use the symptom to pick the starting point -- this is a decision tree, not a rigid sequence:

| Symptom                                    | Start With                                                   |
| ------------------------------------------ | ------------------------------------------------------------ |
| Wallet / permit / approval / repay failure | `consumer-bug-preflight.sh`                                  |
| UI / rendering issue                       | PostHog session replay                                       |
| API / data error                           | Sentry error groups                                          |
| Visual / E2E reproduction needed           | `frontend-devserver.sh` + Chrome DevTools MCP                |
| Unknown / ambiguous                        | `frontend-project-resolver.sh` to identify the project first |

After the starting probe, continue with the full triage order below.

## Frontend Dev Server

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/frontend-devserver.sh`

Start a local dev server for any Morpho frontend app to enable visual debugging with Chrome DevTools MCP:

```bash
frontend-devserver.sh start curator-v2-app
frontend-devserver.sh start consumer-app --port 3010
frontend-devserver.sh stop curator-v2-app
frontend-devserver.sh status
frontend-devserver.sh list
```

After starting a dev server, use the `chrome-devtools` MCP to navigate to the dev server URL, take screenshots, inspect DOM, check network requests, and analyze console messages.

## Chrome DevTools MCP

MCP server: `chrome-devtools` (configured in acpx)

Launches headless Chromium in-container and connects via CDP. Use it to:

- Navigate to dev server pages or production URLs
- Take screenshots of rendered pages
- Inspect DOM elements and computed styles
- Monitor network requests and responses
- Read browser console messages and errors

## Consumer Bug Preflight

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/consumer-bug-preflight.sh`

Run this first for any wallet/permit/approval/tx failure:

```bash
consumer-bug-preflight.sh prd "USDT repay fails unless offchain approval is disabled"
```

This consolidated probe checks:

- Known issue families in Linear
- Recent Sentry error groups
- Relevant PostHog events
- Onchain state for referenced addresses

**Mandatory**: run this before any capability disclaimer. Never answer with "no access" for Sentry, PostHog, Linear, or Foundry without a live probe and the exact error.

## Frontend Project Resolver

Path: `/home/node/.openclaw/skills/morpho-sre/scripts/frontend-project-resolver.sh`

Infers the likely Morpho frontend project from a user question:

```bash
frontend-project-resolver.sh prd "landing checkout button broken on morpho.org"
frontend-project-resolver.sh prd "interface v2 wallet connect broken"
```

Use the top match to decide which PostHog/Sentry project to query. If the resolver returns multiple strong matches, investigate the top 2 and note the scope is ambiguous.

## PostHog Project Mapping

| Project Key  | PostHog MCP Server         | Frontend             |
| ------------ | -------------------------- | -------------------- |
| `landing`    | `posthog-<env>-landing`    | morpho.org landing   |
| `vmv1`       | `posthog-<env>-vmv1`       | Vault Manager v1     |
| `data`       | `posthog-<env>-data`       | Data dashboard       |
| `markets-v2` | `posthog-<env>-markets-v2` | Markets v2 interface |
| `curator-v1` | `posthog-<env>-curator-v1` | Curator v1           |
| `curator-v2` | `posthog-<env>-curator-v2` | Curator v2           |

Use `posthog-mcp.sh` to probe auth:

```bash
posthog-mcp.sh dev --probe-auth
posthog-mcp.sh prd --probe-auth
```

Use PostHog for: session replay, product flow drop-offs, user/session correlation, frontend event anomalies.

## Sentry

Use `sentry-api.sh` / `sentry-cli.sh` for: JS/runtime issue groups, stack traces, event payloads, release correlation.

```bash
sentry-cli.sh dev info
sentry-cli.sh prd info
sentry-api.sh prd '/api/0/organizations/<org>/issues/'
```

## Default Triage Order

1. **Resolver**: infer likely frontend project from the question
2. **PostHog**: what user path or replay broke
3. **Sentry**: what error or release caused it
4. **Grafana / CloudWatch**: whether infra or edge behavior also moved
5. **CI / deploy history**: what changed in the same window

## Known Issue Families

Check `incident-dossier-consumer-app-offchain-approval-failures-2026-03-12.md` for known patterns:

| Issue ID                            | Pattern                              |
| ----------------------------------- | ------------------------------------ |
| `API-900`, `VMV1-3435`, `VMV1-4299` | USDT-like approval reset paths       |
| `VMV1-4786`                         | Permit2 nonce / allowance failures   |
| `VMV1-4693`, `VMV1-4719`            | Stale permit nonce failures          |
| `VMV1-4140`, `VMV1-4147`            | Offchain-signature toggle/workaround |

Also check `incident-dossier-consumer-app-sdk-abi-regression-2026-03-13.md` for SDK ABI decoding regressions.

Search Linear and GitHub for existing matches before inventing a new theory:

```bash
linear-ticket-api.sh probe-auth
gh search issues --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
gh search prs --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
```

## Wallet / Approval Investigation Rules

- Preserve user workaround clues: if onchain approval works, treat that as evidence against the offchain path (not as proof the bug is gone)
- Preserve the strongest thread clue or workaround throughout the investigation
- Never promote a secondary symptom (e.g., a later direct Etherscan revert after workaround txs) to "root cause confirmed" unless it also explains the original in-app failure
- Mandatory order: `consumer-bug-preflight.sh` -> telemetry + Linear known-issue search -> Foundry/Tenderly/onchain checks

## Reply Format (Slack Thread)

Separate these clearly in the final reply:

1. **Primary app/offchain failure**: what broke in the consumer app
2. **Secondary user state found onchain**: what Etherscan/RPC shows
3. **Workaround status**: does toggling offchain approval or another workaround help
4. **Matching issue IDs / owner**: existing Linear/GitHub tickets and assigned owner

## Shell Probe Examples

```bash
# Resolve project
frontend-project-resolver.sh prd "interface v2 wallet connect broken"

# PostHog auth
posthog-mcp.sh dev --probe-auth
posthog-mcp.sh prd --probe-auth

# Sentry auth
sentry-cli.sh dev info
sentry-api.sh prd '/api/0/organizations/<org>/issues/'

# Consumer preflight
consumer-bug-preflight.sh prd "Can't repay USDT from Safe app"
```

## Environment Scoping

- `posthog-dev-*` and `sentry-* dev` for dev environment
- `posthog-prd-*` and `sentry-* prd` for production
- Do not call raw PostHog or Sentry endpoints when wrappers exist

## Reference

See `morpho-sre/references/consumer-frontend-guide.md` for the full consumer frontend playbook.

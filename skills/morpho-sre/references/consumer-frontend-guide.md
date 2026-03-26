# Consumer Frontend Investigation

> Loaded on demand from morpho-sre skill. See SKILL.md for hard rules and routing.

Decision-tree guide for investigating consumer frontend issues across Morpho web properties. Routes investigation based on symptom category rather than a fixed sequence.

## Tools

| Tool                      | Path                                   | Purpose                                                     |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Consumer bug preflight    | `scripts/consumer-bug-preflight.sh`    | Consolidated probe for consumer tx bugs                     |
| Frontend project resolver | `scripts/frontend-project-resolver.sh` | Infer likely projects from a user question                  |
| Frontend dev server       | `scripts/frontend-devserver.sh`        | Clone, install, and run local dev server for any Morpho app |
| Chrome DevTools MCP       | `chrome-devtools` MCP server           | Navigate, screenshot, DOM/network/console inspection        |
| PostHog MCP launcher      | `scripts/posthog-mcp.sh`               | Session replay, flow drop-offs, event anomalies             |
| Sentry API wrapper        | `scripts/sentry-api.sh`                | JS/runtime issue groups, stack traces, event payloads       |
| Sentry CLI wrapper        | `scripts/sentry-cli.sh`                | CLI access to Sentry                                        |
| Linear ticket API         | `scripts/linear-ticket-api.sh`         | Search/create known issues                                  |

## Decision Tree

### Wallet / Permit / Approval Failures

**Symptom:** Transaction reverts, permit failures, allowance errors, approval reset issues, repay failures.

1. Run `consumer-bug-preflight.sh` first:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/consumer-bug-preflight.sh prd "USDT repay fails unless offchain approval is disabled"
   ```
2. Preserve user workaround clues from the thread; if onchain approval works, treat that as evidence against the offchain path, not as proof the app bug is gone.
3. Search recent matches in Linear / GitHub before inventing a new theory:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh probe-auth
   gh search issues --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
   gh search prs --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
   ```
4. Check known issue families from `incident-dossier-consumer-app-offchain-approval-failures-2026-03-12.md`:
   - `API-900`, `VMV1-3435`, `VMV1-4299` for USDT-like approval reset paths
   - `VMV1-4786` for Permit2 nonce / allowance failures
   - `VMV1-4693`, `VMV1-4719` for stale permit nonce failures
   - `VMV1-4140`, `VMV1-4147` for the offchain-signature toggle/workaround
5. Correlate with Sentry errors and PostHog session replays.
6. Use Foundry/Tenderly/onchain checks if needed for ABI or revert analysis.

### UI / Rendering Issues

**Symptom:** Broken layout, missing elements, visual glitches, component failures.

1. Run `frontend-project-resolver.sh` to identify the project:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/frontend-project-resolver.sh prd "interface v2 wallet connect broken"
   ```
2. Use the matching `posthog-<env>-<project-key>` MCP for session replay first:
   - `landing` -> `posthog-<env>-landing`
   - `vmv1` -> `posthog-<env>-vmv1`
   - `data` -> `posthog-<env>-data`
   - `markets-v2` -> `posthog-<env>-markets-v2`
   - `curator-v1` -> `posthog-<env>-curator-v1`
   - `curator-v2` -> `posthog-<env>-curator-v2`
3. Check Sentry for JS/runtime error groups in the same project.
4. Check CI / deploy history for what changed in the same window.

### API / Data Issues

**Symptom:** Wrong data displayed, API errors, GraphQL failures, stale values in the frontend.

1. Use `sentry-api.sh` / `sentry-cli.sh` for error groups first:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/sentry-cli.sh dev info
   /home/node/.openclaw/skills/morpho-sre/scripts/sentry-api.sh prd '/api/0/organizations/<org>/issues/'
   ```
2. Check release correlation after a bad frontend deploy.
3. Cross-reference with Grafana / CloudWatch for infra or edge behavior changes.
4. If the issue is data-layer, pivot to the DB-first or single-vault investigation path.

### Visual / E2E Reproduction

**Symptom:** Need to see the actual page, capture screenshots, inspect DOM, check network requests, or reproduce a user's exact flow.

1. Start the relevant dev server:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/frontend-devserver.sh start <app-key>
   ```
2. Use the `chrome-devtools` MCP to navigate to the dev server URL and inspect:
   - Navigate to pages, take screenshots of rendered state
   - Inspect DOM elements and computed styles
   - Monitor network requests and responses
   - Read browser console messages and errors
3. After investigation, stop the dev server:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/frontend-devserver.sh stop <app-key>
   ```

Available app keys: `curator-app`, `curator-v2-app`, `delegate-app`, `liquidation-app`, `markets-v2-app`, `ui-app`, `consumer-app`. Run `frontend-devserver.sh list` for all keys with repos and ports.

### Unknown / Ambiguous Symptom

**Symptom:** Vague report, unclear category, or multiple possible causes.

1. Run `frontend-project-resolver.sh` first to narrow scope:
   ```bash
   /home/node/.openclaw/skills/morpho-sre/scripts/frontend-project-resolver.sh prd "landing checkout button broken on morpho.org"
   ```
2. If the resolver returns multiple strong matches, investigate the top 2 and say the scope is ambiguous.
3. Follow the default triage order:
   - **Resolver:** infer likely frontend project from the question
   - **PostHog:** what user path or replay broke
   - **Sentry:** what error or release caused it
   - **Grafana / CloudWatch:** whether infra or edge behavior also moved
   - **CI / deploy history:** what changed in the same window

## Environment Scoping

Keep all probes env-scoped:

- `posthog-dev-*` and `sentry-* dev` for dev
- `posthog-prd-*` and `sentry-* prd` for prod

Do not call raw PostHog or Sentry endpoints when wrappers exist.

## Shell Probes

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/frontend-project-resolver.sh prd "interface v2 wallet connect broken"
/home/node/.openclaw/skills/morpho-sre/scripts/posthog-mcp.sh dev --probe-auth
/home/node/.openclaw/skills/morpho-sre/scripts/posthog-mcp.sh prd --probe-auth
/home/node/.openclaw/skills/morpho-sre/scripts/sentry-cli.sh dev info
/home/node/.openclaw/skills/morpho-sre/scripts/sentry-api.sh prd '/api/0/organizations/<org>/issues/'
```

## Required Reply Shape

Reply with conclusions only in ALL communications — no investigation steps, intermediate reasoning, or tool output. In the final reply, separate:

1. Primary app/offchain failure
2. Secondary user state found onchain
3. Workaround status
4. Matching issue IDs / owner

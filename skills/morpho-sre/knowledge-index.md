# Morpho SRE Knowledge Index

Use this file as the first retrieval target.

Current constraint: keep new searchable seed-skill docs at top-level
`skills/morpho-sre/*.md`. The current QMD config for this
corpus indexes top-level Markdown there.

Runtime model: the container assumes a shared repo root. Start with
`repo-root-model.md` before reasoning from literal host paths.

## Source Of Truth By Topic

| Topic                                       | Primary repo/path                                    | Why                                                                            |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| OpenClaw SRE runtime behavior               | `openclaw-sre/`                                      | Agent runtime, memory, channel behavior, tool wiring                           |
| OpenClaw SRE deployment + runtime substrate | `openclaw-sre/skills/morpho-sre/`                    | Runtime config defaults, skill payload, incident knowledge, repo ownership     |
| Infra architecture + ops docs               | `morpho-infra/docs/`                                 | Most operational knowledge already lives here                                  |
| Infra/service ownership map                 | `openclaw-sre/skills/morpho-sre/repo-ownership.json` | Repo boundaries, validation hints, rollout ownership                           |
| Seeded incident dossiers                    | `openclaw-sre/skills/morpho-sre/*.md`                | Markdown dossiers baked into the runtime image to bootstrap incident knowledge |
| Incident dossiers (runtime)                 | `~/.openclaw/state/sre-dossiers/`                    | Runtime-distilled prior incidents for recall, may extend the seeded dossiers   |
| Session summaries                           | `~/.openclaw/state/sre-index/session-summaries/`     | Recent triage memory                                                           |

## Best Entry Points

- `morpho-infra/docs/README.md`
  Fast doc hub. Good first hop.
- `repo-root-model.md`
  Shared-root path model for the merged container and local dev.
- `references/db-data-incident-playbook.md`
  DB-first investigation order for stale/wrong-value and replica incidents.
- `references/indexer-freshness-playbook.md`
  Freshness-first order for Grafana `MorphoIndexerDelay`, BetterStack `Indexing latency`, and recurring `indexer-<chain>-morpho-sh` lag incidents.
- `references/rewards-provider-incident-playbook.md`
  Rewards/APR incidents where upstream provider data, campaign TVL, or consumer
  code-path fanout may be the trigger.
- `incident-dossier-arbitrum-indexing-throughput-backpressure-2026-03-13.md`
  Repeated Arbitrum freshness lag pattern: healthy pod, stale data, internal lag blind spot, likely throughput/headroom amplifier.
- `incident-dossier-consumer-app-offchain-approval-failures-2026-03-12.md`
  Consumer wallet / approval / permit failure playbook. Use when a workaround already narrows scope to the offchain path.
- `notion-postmortem-index.md`
  First-party postmortem index from Notion workspace sources.
- `morpho-infra/docs/operations/incident-response.md`
  IRP. Severity, escalation, dashboards, common procedures.
- `morpho-infra/docs/guides/ai-agents-incident-troubleshooting.md`
  Concrete agent workflows, query patterns, internal endpoints.
- `morpho-infra/docs/guides/observability-stack-onboarding.md`
  Metrics, logs, traces, alerting, dashboard naming, team/channel map.
- `posthog-<env>-<project-key>` MCP + `sentry-api.sh`
  Frontend user-path, replay, issue-group, and release correlation surface for consumer app incidents.
- `frontend-project-resolver.sh`
  Prompt-to-project inference surface for frontend incidents spanning multiple PostHog and Sentry projects.
- `morpho-infra/docs/operations/erpc-operations.md`
  eRPC metrics, commands, failure checks.
- `morpho-infra/docs/services/api-endpoints.md`
  Service URLs, Vault paths, endpoint ownership clues.
- `morpho-infra/docs/services/platform.md`
  Platform service inventory.
- `morpho-infra/docs/architecture/alerting.md`
  Alert routing model.
- `morpho-infra/docs/architecture/erpc.md`
  eRPC design and failure boundaries.
- `morpho-infra/docs/architecture/vault.md`
  Vault trust boundaries and auth model.

## Helper Scripts

These files are part of the SRE substrate and support RCA and eRPC
investigation.

- `erpc-context.sh`
  Builds a local eRPC context bundle: redacted Vault config, upstream repo/docs,
  metrics catalog, and Morpho local references.
- `wiz-mcp.sh`
  Vault-aware Wiz MCP launcher. Resolves current Wiz credentials from
  `secret/wiz/api-token`, then starts `mcp-remote` without putting secrets in
  process args.
- `rca-provider-codex.sh`
  Codex-backed RCA provider wrapper.
- `rca-provider-claude.sh`
  Claude-backed RCA provider wrapper.
- `rca-provider-openclaw-agent.sh`
  Shared OpenClaw-agent RCA execution wrapper used by provider-specific scripts.

## Fast Routing

- User-facing outage, unknown owner:
  Start `morpho-infra/docs/operations/incident-response.md`, then `morpho-infra/docs/guides/observability-stack-onboarding.md`, then `morpho-infra/docs/services/api-endpoints.md`.
- ArgoCD / rollout / drift:
  Start `morpho-infra/docs/operations/incident-response.md`, `morpho-infra/docs/operations/ci-cd-workflow.md`,
  `openclaw-sre/skills/morpho-sre/change-checklist-argocd-sync-wave.md`, helm repo chart + values, then
  `morpho-infra-helm/ci/argocd-diff.sh`.
- Vault / secret / auth:
  Start `morpho-infra/docs/architecture/vault.md`, `morpho-infra/docs/guides/vault-user-guide.md`, `morpho-infra/docs/operations/vault-admin-guide.md`,
  `openclaw-sre/skills/morpho-sre/change-checklist-vault-auth.md`, then chart `job-vault*.yaml`.
- eRPC:
  Start `morpho-infra/docs/operations/erpc-operations.md`, `morpho-infra/docs/architecture/erpc.md`, `openclaw-sre/skills/morpho-sre/erpc-context.sh`.
- Monitoring stack / missing data / alert path:
  Start `morpho-infra/docs/guides/observability-stack-onboarding.md`, `morpho-infra/docs/architecture/alerting.md`, `morpho-infra/docs/operations/critical-monitoring.md`.
- Indexer freshness / repeated lag / stale chain reads:
  Start `references/indexer-freshness-playbook.md`, then `morpho-infra/docs/guides/observability-stack-onboarding.md`, then the closest indexing dossier.
- Consumer app frontend / JS error / replay / conversion drop:
  Start `frontend-project-resolver.sh`, then the matching `posthog-<env>-<project-key>` MCP server, then `sentry-api.sh` / `sentry-cli.sh`, then `morpho-infra/docs/guides/ai-agents-incident-troubleshooting.md`, then `morpho-infra/docs/operations/incident-response.md`.
- Consumer wallet / approval / permit / repay failure:
  Start `consumer-bug-preflight.sh`, then `incident-dossier-consumer-app-offchain-approval-failures-2026-03-12.md`, then matching PostHog/Sentry probes, then Linear / GitHub known-issue search, then Foundry/Tenderly checks.
- DB pressure / CNPG:
  Start `morpho-infra/docs/operations/incident-response.md`, `morpho-infra/docs/operations/kubernetes-database-ops.md`,
  `openclaw-sre/skills/morpho-sre/change-checklist-db-rightsizing.md`, relevant postmortem or dossier.
- Wrong values / stale values / replica drift:
  Start `references/db-data-incident-playbook.md`, then `morpho-infra/docs/operations/kubernetes-database-ops.md`,
  then relevant incident dossier.
- Rewards APR / campaign TVL / provider anomalies:
  Start `references/db-data-incident-playbook.md`, then `references/rewards-provider-incident-playbook.md`,
  then the relevant rewards incident dossier.

## Knowledge Gaps To Fill Over Time

- More incident dossiers for repeat failures.
- Service-specific rollback criteria.
- Change-type checklists: DB rightsizing, Vault auth changes, Argo sync-wave changes, alert routing changes.
- Shorter service dependency maps for top incident-prone workloads.

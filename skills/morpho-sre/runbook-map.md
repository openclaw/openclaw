# Morpho SRE Runbook Map

Route symptoms to the highest-signal docs first.

## Incident Intake

- Path/root sanity first:
  `repo-root-model.md`
- General production incident:
  `morpho-infra/docs/operations/incident-response.md`
- Agent-assisted investigation workflow:
  `morpho-infra/docs/guides/ai-agents-incident-troubleshooting.md`
- Dashboards, labels, alerting, logs, traces:
  `morpho-infra/docs/guides/observability-stack-onboarding.md`

## Symptom -> Runbook

| Symptom                                                          | Start here                                                                | Then                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5xx / latency / stale API data                                   | `morpho-infra/docs/operations/incident-response.md`                       | `morpho-infra/docs/services/api-endpoints.md`, `morpho-infra/docs/guides/observability-stack-onboarding.md`                                                                                                             |
| Indexer delay / BetterStack indexing latency / stale chain reads | `openclaw-sre/skills/morpho-sre/references/indexer-freshness-playbook.md` | `morpho-infra/docs/guides/observability-stack-onboarding.md`, `morpho-infra/docs/operations/incident-response.md`, `incident-dossier-arbitrum-indexing-throughput-backpressure-2026-03-13.md`                           |
| Wrong values / stale values / APY spikes / replica drift         | `openclaw-sre/skills/morpho-sre/references/db-data-incident-playbook.md`  | `morpho-infra/docs/operations/kubernetes-database-ops.md`, `morpho-infra/docs/guides/ai-agents-incident-troubleshooting.md`, relevant incident dossier                                                                  |
| Consumer frontend / JS error / replay / conversion drop          | `frontend-project-resolver.sh`                                            | matching `posthog-<env>-<project-key>` MCP server, `sentry-api.sh`, `sentry-cli.sh`, `morpho-infra/docs/guides/ai-agents-incident-troubleshooting.md`, `morpho-infra/docs/operations/incident-response.md`              |
| Consumer wallet / approval / permit / repay failure              | `consumer-bug-preflight.sh`                                               | `incident-dossier-consumer-app-offchain-approval-failures-2026-03-12.md`, matching `posthog-<env>-<project-key>` MCP server, `sentry-api.sh`, `sentry-cli.sh`, `linear-ticket-api.sh`, `gh search`, `foundry-evm-debug` |
| Argo app unhealthy / bad deploy / drift                          | `morpho-infra/docs/operations/ci-cd-workflow.md`                          | `openclaw-sre/skills/morpho-sre/change-checklist-argocd-sync-wave.md`, `morpho-infra-helm/charts/<app>/values.yaml`, `morpho-infra-helm/ci/argocd-diff.sh`                                                              |
| Vault secret missing / auth failure                              | `morpho-infra/docs/architecture/vault.md`                                 | `openclaw-sre/skills/morpho-sre/change-checklist-vault-auth.md`, `morpho-infra/docs/guides/vault-user-guide.md`, `morpho-infra/docs/operations/vault-admin-guide.md`, helm `job-vault*.yaml`                            |
| eRPC latency / cache / upstream errors                           | `morpho-infra/docs/operations/erpc-operations.md`                         | `morpho-infra/docs/architecture/erpc.md`, `openclaw-sre/skills/morpho-sre/erpc-context.sh`, `openclaw-sre/skills/morpho-sre/erpc-api.sh`                                                                                |
| Grafana / Loki / Tempo / Prometheus issue                        | `morpho-infra/docs/guides/observability-stack-onboarding.md`              | `morpho-infra/docs/architecture/alerting.md`, `morpho-infra/docs/operations/critical-monitoring.md`                                                                                                                     |
| CNPG / connection / vacuum / replica lag                         | `morpho-infra/docs/operations/kubernetes-database-ops.md`                 | `openclaw-sre/skills/morpho-sre/change-checklist-db-rightsizing.md`, `openclaw-sre/skills/morpho-sre/incident-dossier-blue-api-db-downsizing-2026-02-04.md`                                                             |
| Boundary / VPN / secure access                                   | `morpho-infra/docs/architecture/boundary.md`                              | `morpho-infra/docs/guides/boundary-user-guide.md`, `morpho-infra/docs/operations/boundary-config.md`, `morpho-infra/docs/guides/vpn-setup.md`                                                                           |
| Cert / TLS / VPN renewal                                         | `morpho-infra/docs/operations/certificate-renewal.md`                     | `openclaw-sre/skills/morpho-sre/cert-secret-health.sh`                                                                                                                                                                  |
| WAF / CloudFront / geo issues                                    | `morpho-infra/docs/operations/cloudfront-waf-logs.md`                     | `morpho-infra/docs/operations/geoblocking.md`                                                                                                                                                                           |

## Repo Routing

- Shared-root container path model:
  `repo-root-model.md`
- RCA / eRPC helper scripts:
  `erpc-context.sh`, `rca-provider-codex.sh`, `rca-provider-claude.sh`, `rca-provider-openclaw-agent.sh`
- Runtime bug in agent behavior:
  `openclaw-sre/`
- Helm/render/sync issue:
  `morpho-infra-helm/`
- Infra architecture, procedures, service docs:
  `morpho-infra/docs/`

## Query Order

1. Severity + impact from `morpho-infra/docs/operations/incident-response.md`.
2. Ownership + service endpoints from `morpho-infra/docs/services/api-endpoints.md` or `morpho-infra/docs/services/platform.md`.
3. Metrics/logs/traces from `morpho-infra/docs/guides/observability-stack-onboarding.md`.
4. Recent change correlation from helm repo + Argo + CI.
5. Prior similar incidents from dossiers.

## Do Not Do

- Do not invent a new runbook when Morpho docs already cover it.
- Do not treat helm values as the only source of truth when an architecture/operations doc exists.
- Do not skip change correlation for incidents within 24h of deploy/config churn.

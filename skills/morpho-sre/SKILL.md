---
name: morpho-sre
description: Morpho infra SRE skill for AWS/EKS/Helm/Kubernetes/Prometheus/Grafana/Loki/Thanos/Tempo. Correlates running images with GitHub repos using morpho-infra commons mappings, clones repos for RCA, and drives evidence-first incident triage.
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# Morpho SRE

## Hard Rules

- Diagnose first. Never mutate cluster resources automatically.
- Auto-remediation pull requests are allowed when confidence gate passes (`AUTO_PR_*`) and evidence is attached.
- Before recommending or opening a PR, prove the target repo/path changes the active code path. If you cannot name the path, do not open the PR.
- Default scope: `dev-morpho` + `monitoring` namespace.
- Hard preflight before diagnosis:
  - verify binaries and PATH first: `command -v kubectl aws jq git gh`
  - verify AWS identity, and verify either kube context visibility or in-cluster serviceaccount visibility
  - if preflight fails, stop RCA and switch to blocked mode
- Print command target before execution: AWS identity, kube context, namespace.
- Outside cluster: include explicit Kubernetes context in commands: `kubectl --context "$K8S_CONTEXT" ...`
- In-cluster: prefer serviceaccount auth and plain `kubectl ...`; do not depend on `~/.kube/config`
- Shell portability:
  - default command syntax must be POSIX `sh` compatible
  - do not use `set -o pipefail`, arrays, or other Bash-only features unless command is explicitly wrapped with `bash -lc '...'`
- No root-cause ranking before one successful live check. Access/runtime failures alone are not enough evidence for hypotheses.
- On blocked investigations:
  - first reply must include exact failing command + exact error text
  - include at most 3 next checks
  - do not include `Hypotheses:` / `Likely cause:` until at least one successful live signal exists
- RBAC-aware fallback:
  - if `pods/exec forbidden` or similar RBAC denial appears, stop retrying `kubectl exec`
  - fall back to `get`, `describe`, `logs`, events, metrics, traces, repo/config inspection
- Before broad repo/code reads, load at least one retrieval surface relevant to the incident:
  - `knowledge-index.md`
  - `runbook-map.md`
  - `repo-root-model.md`
  - relevant incident dossier / postmortem index
- Retry on repeated asks: if same/near-identical question appears again in the same thread/session, re-run relevant live checks/tools (state may have changed); do not reuse a prior failure-only answer.
- In monitored Slack incident threads, human follow-ups after the first bot reply must pass ingress and trigger fresh live checks; do not treat them like duplicate alert updates.
- If an incident thread drifts into unrelated design/history questions, redirect that discussion to a DM or new thread instead of mixing it into RCA.
- Incident threads:
  - Do not send progress-only thread replies like `On it`, `Found it`, or `Let me verify`; wait for net-new evidence, mitigation, validation, or a PR URL.
- Before claiming repo/tool access is unavailable, run one live probe (`gh repo view <owner/repo>` or the target helper in dry-run mode) and quote the exact error.
- If a human questions the proposed fix or PR in-thread, re-open RCA with fresh live evidence; do not repeat the old theory or go silent.
- If current code, query output, or live evidence disproves an earlier theory, say `Disproved theory:` and replace it before proposing a new cause or PR.
- Exact artifact replay:
  - if user provides an exact query, event ID, trace ID, address, or says the prior answer is wrong, replay that exact artifact before reusing any prior theory
  - isolate the minimal failing field set before expanding the query or naming a cause
  - use Sentry event IDs only after a live lookup, or explicitly say creds are unavailable
- Resolver / incident matching:
  - do not reuse a prior incident unless operation name, schema object, failing fields, chain, and address pattern match
  - treat `vaultByAddress` and `vaultV2ByAddress` as different resolver families unless live evidence proves the same failure path
- Slack file delivery: when user asks to "send the file/csv directly", emit `MEDIA:<url-or-local-path>` in the reply (keep caption in normal text) instead of saying file upload is unavailable.
- PR body quality: keep PR descriptions concise and reviewable; never paste raw command output/manifests/log dumps (for example `helm template` full output) into PR body.
- Linear ticket mutation guardrail (Slack threads):
  - Trigger: explicit ask to create/update/comment a Linear issue/ticket (e.g., `PLA-318`).
  - Mandatory: run a live Linear mutation attempt before replying.
  - Never answer with “can’t directly edit Linear” without executing a live command.
  - On failure: include exact failing command + exact error text + next unblock step.
- Consumer frontend tx bug guardrail:
  - Trigger: consumer app / wallet / permit / approval / allowance / repay failure.
  - Preserve the strongest thread clue or workaround. If a user says disabling offchain approval or using onchain approval works, keep the offchain path as the primary scope until disproven.
  - Mandatory order: `consumer-bug-preflight.sh` -> telemetry + Linear known-issue search -> Foundry/Tenderly/onchain checks.
  - Never answer with “no access” for Sentry, PostHog, Linear, or Foundry without a live probe and the exact error.
  - Never promote a secondary symptom (for example a later direct Etherscan revert or empty balance after workaround txs) to “root cause confirmed” unless it also explains the original in-app failure.

## Paths

- Infra: `/srv/openclaw/repos/morpho-infra`
- Helm: `/srv/openclaw/repos/morpho-infra-helm`
- Commons mapping: `/srv/openclaw/repos/morpho-infra/projects/commons/variables.auto.tfvars`
- Clone cache: `/home/node/.openclaw/repos`
- Correlation script: `/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh`
- Repo clone helper: `/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh`
- CI status helper: `/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh`
- Auto PR helper: `/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh`
- Grafana API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/grafana-api.sh`
- BetterStack API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh`
- Consumer bug preflight helper: `/home/node/.openclaw/skills/morpho-sre/scripts/consumer-bug-preflight.sh`
- Frontend project resolver: `/home/node/.openclaw/skills/morpho-sre/scripts/frontend-project-resolver.sh`
- PostHog MCP launcher: `/home/node/.openclaw/skills/morpho-sre/scripts/posthog-mcp.sh`
- eRPC API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/erpc-api.sh`
- Sentry API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentry-api.sh`
- Sentry CLI wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentry-cli.sh`
- Wiz MCP launcher: `/home/node/.openclaw/skills/morpho-sre/scripts/wiz-mcp.sh`
- DB target helper: `/home/node/.openclaw/skills/morpho-sre/scripts/lib-db-target.sh`
- DB evidence wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/db-evidence.sh`
- Linear ticket API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh`
- Sentinel snapshot helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh`
- Sentinel triage helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh`

## Knowledge Surfaces

- Start with `repo-root-model.md` for merged-container path semantics.
- Start with `knowledge-index.md` for source-of-truth by topic.
- Use `notion-postmortem-index.md` for first-party Notion incident sources.
- Use `runbook-map.md` to route symptoms -> Morpho docs/runbooks.
- Use `change-checklist-db-rightsizing.md`, `change-checklist-vault-auth.md`, and
  `change-checklist-argocd-sync-wave.md` before risky infra changes.
- Use `references/db-data-incident-playbook.md` for stale/wrong-value, replica,
  replay-lag, and read-consistency incidents.
- Use `references/rewards-provider-incident-playbook.md` for rewards APR /
  campaign TVL incidents where upstream provider data may be the trigger.
- Use `incident-dossier-template.md` for new incident capture.
- Use `incident-dossier-blue-api-db-downsizing-2026-02-04.md` for a concrete known failure pattern.
- Use `incident-dossier-blue-api-rewards-merkl-apr-2026-03-12.md` for the
  stacked-cause rewards incident pattern.
- Use `incident-dossier-consumer-app-offchain-approval-failures-2026-03-12.md`
  for consumer wallet / approval / permit regressions where the workaround narrows scope.
- Use `incident-dossier-blue-api-hyperevm-vault-v2-state-gap-2026-03-12.md` for single-vault HyperEVM vault-v2 state gaps where metadata and transaction paths disagree with current-state paths.
- Helper scripts that support RCA and eRPC investigation:
  - `erpc-context.sh`
  - `wiz-mcp.sh`
  - `rca-provider-codex.sh`
  - `rca-provider-claude.sh`
  - `rca-provider-openclaw-agent.sh`

## Wiz MCP

- ACP is enabled with `dispatch.enabled=false`, so `/acp` commands are available
  without switching normal thread execution over to ACP.
- ACPX is seeded with a `wiz` MCP server definition that runs
  `/home/node/.openclaw/skills/morpho-sre/scripts/wiz-mcp.sh`.
- `wiz-mcp.sh` prefers Vault path `secret/wiz/api-token` over
  `WIZ_CLIENT_ID` / `WIZ_CLIENT_SECRET`, because the runtime env secret may lag
  behind the canonical Wiz Vault entry.
- The launcher keeps Wiz secrets out of process args by passing header
  placeholders to `mcp-remote` and resolving the real values through
  environment variables in the child process.
- Manual checks:

```bash
# Show the redacted launch plan
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-mcp.sh --print-plan | jq

# Probe current Vault-backed Wiz MCP credentials
/home/node/.openclaw/skills/morpho-sre/scripts/wiz-mcp.sh --probe-auth | jq
```

- Prefer existing repo docs over inventing parallel guidance:
  - `morpho-infra/docs/operations/incident-response.md`
  - `morpho-infra/docs/guides/ai-agents-incident-troubleshooting.md`
  - `morpho-infra/docs/operations/erpc-operations.md`
  - `morpho-infra/docs/guides/observability-stack-onboarding.md`
  - `morpho-infra/docs/services/api-endpoints.md`

## Incident Workflow

1. Run hard preflight.
2. Load one retrieval surface (`knowledge-index.md` / `runbook-map.md` / dossier) before deep repo spelunking.
3. Scope incident: impact, first seen, affected namespace/workload.
4. Build image-to-repo correlation map.
5. Find affected image, app, repo, revision.
6. Cross-check k8s state + logs + metrics + traces.
7. Clone related repo and inspect suspect commit/config only after live evidence or clear config-driven need.
8. If confidence is high and fix is scoped, create fix PR automatically.
9. Return evidence, hypotheses, confidence, and PR URL (or blocked reason).

## DB-First Data Incidents

- Trigger:
  - wrong values
  - stale values
  - APY spikes or sign flips
  - SQL/table asks
  - replica lag / replay lag / recovery conflicts
  - prompts mentioning `postgres`, `pg_stat`, `pg_`, `replica`, `query`, or `table`
- Mandatory order:
  1. resolve DB target
  2. schema probe
  3. one live data query
  4. one PG internal query
  5. only then rank hypotheses or dig through repo/code
- Prior-incident guardrail:
  - use similar incident dossiers as priors only
  - do not collapse immediately to the last known root cause
  - keep at least two live alternatives in play until evidence narrows them
  - for APY/wrong-value incidents, still consider formula, cache, presentation, price/rewards, and routing/data-consistency until checked
- In-cluster preference:
  - use `/home/node/.openclaw/skills/morpho-sre/db-evidence.sh` before Vault or ad hoc `kubectl` secret reads
  - if the DB secret resolves to a short service host, prefer the namespace-qualified host returned by the helper
  - if `kubectl` inside the pod is broken because of a copied kubeconfig, ignore that kubeconfig and use serviceaccount auth
- Preferred collector:

```bash
/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode summary

/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode schema

/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode data

/home/node/.openclaw/skills/morpho-sre/db-evidence.sh \
  --namespace morpho-prd \
  --target indexer \
  --mode replica
```

- Required answer evidence:
  - include the `evidence_line`
  - include one business-data fact
  - include one PG-internal fact
- Do not conclude from replay/code inspection alone when the live DB path has
  not been checked yet.

## Rewards / Provider Incidents

- Trigger:
  - rewards APR off
  - vault APY off with campaign or provider hints
  - prompts mentioning `Merkl`, campaign TVL, reward programs, `yearly_supply_tokens`, `campaigns.morpho.org`, or campaign blacklist
- Mandatory order after the DB-first checks in the section above:
  1. verify one upstream provider/API response
  2. verify one recent artifact or workflow output if such a collector exists
  3. verify the exact consuming code path before naming a root cause or proposing a PR
- Additional stale-row / write-path gate:
  - before naming a stale-row/write-path cause or opening a PR, include one live DB row/provenance fact for the affected reward entity
  - the reply must also name the exact consuming repo/path that would change the active code path
  - until dedicated collectors exist, these rewards/provider evidence gates are satisfied only from explicit live probe outputs; if those outputs are absent, keep the gate closed and say so
- Same-token both-sides anomaly:
  - if the same reward token appears on both supply and borrow for one market, first quote the live reward row/provenance
  - then prove the provider-side truth for that token/campaign
  - then inspect `_fetchMerklSingleRates()` applicability and the final merged reward row before stale-row cleanup theories or PRs
  - keep unrelated dbt/job failures under `*Also watching:*` unless they explain the bad reward row
- Required answer shape:
  - `primary trigger`
  - `local amplifier`
  - `stale-data contributor` when present
  - one disproved or partial prior theory if the investigation changed direction
- Auto-PR gate:
  - do not open a PR unless the reply names the repo/path that changes the active code path
  - do not open a PR for a stale-row/write-path theory unless the reply includes one live DB row/provenance fact for that entity
  - blacklist/config-only PRs are not valid if the live failing path does not consume that blacklist/config

## Single-Vault API / GraphQL Data Incidents

- Trigger:
  - one vault / one market / one address broken while peers work
  - GraphQL `INTERNAL_SERVER_ERROR`
  - `sentryEventId` / `traceId` pasted by user
  - APY nulls, missing realtime state, or field-level GraphQL failures
- Mandatory order:
  1. replay the exact user query
  2. isolate the minimal failing field set
  3. compare against one healthy control vault on the same chain
  4. compare public surfaces for the same address:
     - `vaultV2ByAddress`
     - `vaultV2s` with `address_in`
     - `vaultV2transactions`
  5. verify direct onchain values for the same address
  6. only then rank causes or assign owners
- For single-vault incidents:
  - compare against one healthy control vault on the same chain before calling it chain-wide
  - if same-factory controls are available, prefer them
  - do not jump from missing current state on one vault to “scheduler missing on the whole chain” if newer or peer controls materialize state
  - historical APY series can be a weak signal; prefer current-state fields plus direct RPC
- Required answer shape:
  - exact query result
  - minimal failing fields
  - healthy control result
  - direct RPC fact
  - which public paths see the entity vs miss it

## Slack BetterStack Alert Intake

- Monitored channels:
  - `#staging-infra-monitoring` (dev)
  - `#public-api-monitoring` (prod)
  - `#platform-monitoring` (prod)
- Trigger on BetterStack alert/update posts (including bot-authored messages).
- Auto-intake the incident root, then continue answering human follow-ups (when @mentioned or the bot already replied) in the same thread with fresh evidence.
- Always answer in the incident thread under alert root; never post RCA in channel root.
- Keep thread reply concise (8-12 lines, no prose wall).
- Use Slack mrkdwn only:
  - bold = `*text*`, inline code = `` `text` ``
  - never use Markdown `**text**` or heading syntax (`##`, `###`)
- First four lines must be:
  - `*Incident:*` plain-English summary of what broke
  - `*Customer impact:*` confirmed / none confirmed / unknown
  - `*Affected services:*` concrete services/components
  - `*Status:*` investigating / mitigated / resolved + time window
- If only monitoring/internal tooling is degraded, say exactly: `No confirmed customer impact. Internal observability degraded.`
- After the summary, include:
  - `*Evidence:*` 3-5 concrete facts from k8s/events/logs/metrics/traces
  - `*Likely cause:*` top hypothesis; add confidence only when it changes the recommendation
  - `*Mitigation:*` reversible fix + rollback
  - `*Validate:*` 2-3 checks
  - `*Next:*` owner/action
- Put unrelated warnings under `*Also watching:*`.
- Do not open with routing hints, fingerprint changes, raw step names, signal counts, confidence percentages, or `primary/supporting` namespace jargon.
- Do not send progress-only thread replies like `On it`, `Found it`, or `Let me verify`; wait for net-new evidence, mitigation, validation, or a PR URL.
- If fix is scoped/reversible and confidence >= `AUTO_PR_MIN_CONFIDENCE`, create PR via `autofix-pr.sh` and post PR URL in-thread.
- If a thread question is vague/underspecified:
  - Do not refuse with “insufficient context” only.
  - Infer likely intent from latest triage sections (`impact_scope`, `signal_summary`, `rca_result`, `top_*` tables).
  - State assumptions explicitly in one line (`Assumption: ...`).
  - Propose 2-3 concrete next actions/solutions with commands and rollback when relevant.
  - Ask at most one clarifying question only if it materially changes the recommendation.

## Mandatory First Commands

```bash
command -v kubectl aws jq git gh
echo "$PATH"
aws sts get-caller-identity
if [ -f /var/run/secrets/kubernetes.io/serviceaccount/token ]; then
  kubectl get ns | sed -n '1,20p'
else
  export K8S_CONTEXT="${K8S_CONTEXT:-$(kubectl config current-context)}"
  kubectl --context "$K8S_CONTEXT" get ns | sed -n '1,20p'
fi
```

If `command -v` fails or PATH looks wrong, stop and reply in blocked mode instead of continuing RCA.

## Blocked Mode Reply Contract

- Use this when preflight fails, RBAC blocks required access, credentials are missing, or the runtime is broken.
- Keep it short.
- Required sections:
  - `*Incident:*`
  - `*Status:* blocked by access/runtime`
  - `*Evidence:* <exact command> -> <exact error>`
  - `*Next:*` 1-3 concrete checks
- Forbidden in blocked mode before one successful live check:
  - `*Likely cause:*`
  - `Hypotheses`
  - ranked root-cause lists

## RBAC / Access Fallbacks

- If `kubectl exec` is forbidden:
  - stop retrying exec on more pods
  - use:
    - `kubectl --context "$K8S_CONTEXT" -n <ns> get pods`
    - `kubectl --context "$K8S_CONTEXT" -n <ns> describe pod <pod>`
    - `kubectl --context "$K8S_CONTEXT" -n <ns> logs <pod> --since=30m`
    - metrics / traces / repo / chart inspection
- If GitHub auth fails:
  - stop retrying clone/fetch loops
  - say exact failing command and continue with local repo/chart evidence if sufficient

## Linear Ticket Ops Guardrail

- For ticket update asks (example: “update PLA-318”), execute live mutation via helper script:

```bash
# Inspect issue
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue get PLA-318

# Update description from file (preferred for long context)
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue update-description PLA-318 --file /tmp/pla-318.md

# Add comment
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue add-comment PLA-318 --file /tmp/pla-318-comment.md

# Ensure tracking label on ticket
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue ensure-label PLA-318 openclaw-sre
```

- If asked to “verify Linear write access”, run:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh probe-write PLA-318
```

## DB Query Guardrail (Slack Threads)

- Trigger: any request about DB rows/counts/listing/filtering, stale/wrong data,
  APY spikes, replica lag, recovery conflicts, `pg_stat*`, or SQL.
- Mandatory:
  - run one successful schema check
  - run one successful data query
  - run one successful PG internal query
  - no SQL-only conceptual replies
- Preferred path: use `db-evidence.sh`; use ad hoc SQL only when the wrapper
  cannot express the needed query.
- Mandatory response evidence line:
  - `db=<host:port/dbname> schema_check=<ok|failed> query_check=<ok|failed> rows=<n>`
- If live query cannot run:
  - include exact failing command + exact error text
  - include next unblock step
  - never claim "no DB access" without attempting connectivity + credential lookup

## eRPC Guardrail

- Canonical eRPC endpoint: `https://rpc.morpho.dev/cache/evm/<chainId>?secret=<FLO_TEST_API_KEY>`.
- For eRPC calls, always use `FLO_TEST_API_KEY` via URL query parameter `secret`.
- Prefer wrapper script; do not handcraft raw `curl` URL without `secret`.
- For onchain state inspection, transaction replay, forked simulation, or EVM execution traces, use the bundled `foundry-evm-debug` skill instead of ad hoc `cast` or `anvil` commands.
- For Morpho eRPC / RPC questions about config, routing, caching, providers, limits, or metrics:
  - Run `/home/node/.openclaw/skills/morpho-sre/scripts/erpc-context.sh` first.
  - Read `/tmp/openclaw-erpc-context/summary.md` and `/tmp/openclaw-erpc-context/status.tsv`.
  - Use `/tmp/openclaw-erpc-context/prod-config.redacted.yaml` as the current prod config snapshot when Vault access succeeds.
  - Use `/tmp/openclaw-erpc-context/metrics.tsv` plus upstream telemetry/docs for metric names and meanings.
  - Use `/tmp/openclaw-erpc-context/upstream-repo` for deeper code search when docs are insufficient.
  - If Vault auth fails, say that explicitly and continue with Morpho Helm values + upstream docs/code; do not guess the live config.
- Wrapper behavior:
  - chainId target resolves to `${ERPC_API_BASE}/cache/evm/<chainId>`
  - injects/replaces `secret=<FLO_TEST_API_KEY>` in URL query
  - default base host is `https://rpc.morpho.dev`
  - can enforce host allowlist with `ERPC_ALLOWED_HOSTS` (defaults to `rpc.morpho.dev`)

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

When you switch to the bundled Foundry skill:

- keep `RPC_SECRET` sourced from Vault-backed runtime env
- prefer `skills/foundry-evm-debug/scripts/rpc-url.sh <chainId>` over hardcoded URLs
- use clean worktrees before correlating traces with protocol source
- prefer forked simulation + impersonation over real signing keys

The context bundle contains:

- redacted prod config from Vault path `secret/erpc/config` field `config`
- upstream repo/docs snapshots from `https://github.com/0x666c6f/erpc`
- extracted metrics catalog from `telemetry/metrics.go`
- Morpho local references:
  - `morpho-infra/docs/architecture/erpc.md`
  - `morpho-infra/docs/operations/erpc-operations.md`
  - `morpho-infra-helm/environments/prd/erpc/values.yaml`
  - `morpho-infra-helm/charts/erpc/templates/job-vault-config.yaml`

## Env Var Deployment via Vault

- For `openclaw-sre` runtime env vars that should be configurable per environment, deploy them through Vault path `secret/openclaw-sre/all-secrets`.
- Source of truth:
  - live secret path: `secret/openclaw-sre/all-secrets`
  - Kubernetes sync path: chart hook `charts/openclaw-sre/templates/job-vault.yaml`
  - pod consumption path: `envFrom.secretRef.name = openclaw-sre-vault-secrets`
- Preferred rollout:
  - patch Vault secret
  - let the pre-upgrade Vault sync job recreate `openclaw-sre-vault-secrets`
  - avoid adding chart-level `env:` entries for the same key, because explicit pod env overrides Vault-delivered values
- Prod-only flags should be present only in prd Vault secret payload; leave them unset in dev unless explicitly needed.
- For the eRPC full-context gate, use Vault key `ERPC_FULL_CONTEXT_ENABLED=1` in prd only.

## Docker Image -> GitHub Repo Correlation

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh
```

The script writes:

- `/tmp/openclaw-image-repo/image-repo-map.tsv` (`image_repo`, `github_repo`, `clone_url`, `local_repo_path`, `mapping_source`, `definition_hit`)
- `/tmp/openclaw-image-repo/workload-image-repo.tsv` (`namespace`, `pod`, `image`, `image_repo`, `github_repo`, `clone_url`, `local_repo_path`, `mapping_source`, `definition_hit`)
- Primary mapping source: `morpho-infra/projects/commons` (`github_repositories` + `ecr_repository_mapping`).
- Non-ECR images default to `morpho-org/morpho-infra` (infra source-of-truth).

Filter by image substring:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh --image morpho-blue-api
```

## Clone Repo for RCA

```bash
# Resolve from image substring and clone/update local repo mirror
/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --image morpho-blue-api

# Or clone explicit repo
/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --repo morpho-org/morpho-blue-api
```

If clone returns `403`, token lacks org repo read. Keep investigating with `workload-image-repo.tsv` `local_repo_path` values until token is fixed.

## GitHub CI Signal

```bash
# Latest workflow runs for repo resolved from workload image
/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --image morpho-blue-api --limit 5

# Latest workflow runs for explicit repo
/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --repo morpho-org/morpho-blue-api --limit 10
```

For each RCA output, include latest failing/successful run references with run URL.

## RCA Checks

```bash
# failing pods + events
kubectl --context "$K8S_CONTEXT" -n <ns> get pods -o wide
kubectl --context "$K8S_CONTEXT" -n <ns> get events --sort-by=.lastTimestamp | tail -n 40

# rollout + images
kubectl --context "$K8S_CONTEXT" -n <ns> get deploy/<name> -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
kubectl --context "$K8S_CONTEXT" -n <ns> rollout history deploy/<name>

# logs + metrics
kubectl --context "$K8S_CONTEXT" -n <ns> logs deploy/<name> --since=30m | tail -n 200
curl -s 'http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090/api/v1/alerts' | jq '.data.alerts[] | select(.state=="firing")'
```

## Sentinel Snapshot

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh
```

Use this first during heartbeat/sentinel runs. It emits:

- pod anomalies (phase/restarts/reasons)
- deployment readiness gaps
- recent warning events
- firing Prometheus alerts

## Sentinel Triage (Preferred for Heartbeat)

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh
```

Use this first in heartbeat mode. It outputs:

- 12-step pipeline (0-11):
  - `00` linear memory lookup (`linear-memory-lookup.sh`, optional)
  - `01` pod/deploy runtime signals (required)
  - `02` events + alert signals (required)
  - `03` Prometheus trends (optional)
  - `04` ArgoCD sync drift (optional)
  - `05` log signal enrichment (optional)
  - `06` cert/secret health (optional)
  - `07` AWS resource signals (optional)
  - `08` image->repo mapping (optional)
  - `09` deployed revision/PR correlation (optional)
  - `10` repo CI signal (optional)
  - `11` RCA synthesis (`RCA_MODE=single|dual|heuristic`, fallback to ranked heuristics)
- `health_status` (`state\tok|incident`)
- `incident_gate` (`should_alert`, `gate_reason`, `incident_id`, `rca_version`, `incident_fingerprint`)
- `incident_routing` (`severity_level`, `severity_score`, `recommended_target`)
- `impact_scope` (primary namespace impact vs supporting namespace noise)
- `signal_summary` counters
- `linear_incident_memory` (step 0 status + rows)
- `prometheus_trends` (step 3 status + rows)
- `argocd_sync` (step 4 status + rows)
- `cert_secret_health` (step 6 status + rows)
- `aws_resource_signals` (step 7 status + rows)
- `rca_result` (mode/status/confidence/agreement/degradation + JSON)
- `triage_metrics` (`evidence_completeness_pct`, step timeout/error/skip counts)
- `meta_alerts` (bot-health alerts when `lib-meta-alerts.sh` available)
- `top_container_failures` (container-level state/reason/exit/message)
- `top_log_signals` (runtime error log snippets, token-redacted)
- `impacted_repos` (pod/image -> GitHub repo correlation)
- `image_revision_signal` (image tag -> commit hint -> resolved commit)
- `suspect_prs` (auto-mapped PRs for resolved deployed commits)
- `repo_ci_signal` (latest workflow run per impacted repo)
- `pr_candidates` (repo + likely files for fix PRs)
- `ranked_hypotheses` (confidence + checks + rollback)
- compact top issue tables

Optional toggles:

- `INCLUDE_REPO_MAP=0` to skip image->repo correlation
- `INCLUDE_CI_SIGNAL=0` to skip GitHub Actions enrichment
- `INCLUDE_LOG_SNIPPETS=0` to skip pod log enrichment
- `INCLUDE_IMAGE_REVISION=0` to skip image tag -> commit -> PR enrichment
- `CI_REPO_LIMIT=<n>` and `CI_RUN_LIMIT=<n>` to control API load
- `LOG_SNIPPET_PODS_LIMIT=<n>`, `LOG_SNIPPET_LINES=<n>`, `LOG_SNIPPET_ERRORS_PER_CONTAINER=<n>` to bound log scraping
- `ALERT_COOLDOWN_SECONDS=<n>` to suppress duplicate alerts for unchanged incidents
- `ALERT_MIN_INTERVAL_SECONDS=<n>` to enforce minimum spacing between any incident alerts
- `SEVERITY_*_SCORE=<n>` to tune severity thresholds
- `ROUTE_TARGET_{CRITICAL,HIGH,MEDIUM,LOW}=<target>` for recommended routing
- `PRIMARY_NAMESPACES=<ns1,ns2>` to prioritize severity/routing for app-critical namespaces
- `PROMETHEUS_URL=<url>` and `ARGOCD_BASE_URL=<url>` to enable steps `03/04`
- `RCA_MODE=single|dual|heuristic` for Step 11 execution mode
- `LINEAR_MEMORY_LIMIT=<n>` for Step 0 lookup rows
- `INCIDENT_STATE_DIR`, `ACTIVE_INCIDENTS_FILE`, `RESOLVED_INCIDENTS_FILE`, `INCIDENT_LAST_ACTIVE_FILE` for incident identity/state persistence
- `SPOOL_DIR` for cron fallback + dedup spool

State + delivery notes:

- Active incident state row persists `incident_id`, namespace/category, timestamps, workloads, `rca_version`, fingerprint.
- Outbox-related columns are preserved in the state row for Slack/Linear delivery libraries.
- Spool files (`triage-*.json`) are still written for cron/heartbeat fallback and dedup.

Heartbeat routing directive:

- If triage says `incident_gate.should_alert=yes`, prefix alert with `[[heartbeat_to:<recommended_target>]]`
- `recommended_target` comes from `incident_routing`
- Directive is stripped before delivery text is sent
- Delivery override applies only when target is in `agents.defaults.heartbeat.routeAllowlist`

## Auto Remediation PR

Use this flow only when:

- top hypothesis confidence is high (>= `AUTO_PR_MIN_CONFIDENCE`)
- patch scope is small and reversible
- validation command succeeds (lint/test/helm template/etc.)

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/autofix-pr.sh \
  --repo morpho-org/<repo> \
  --path /home/node/.openclaw/repos/morpho-org/<repo> \
  --title "fix(<scope>): <short-summary>" \
  --commit "fix(<scope>): <short-summary>" \
  --confidence 90 \
  --check-cmd "<targeted validation command>" \
  --body-file /tmp/sre-pr-body.md
```

`autofix-pr.sh` enforces:

- repo allowlist (`AUTO_PR_ALLOWED_REPOS`)
- confidence threshold (`AUTO_PR_MIN_CONFIDENCE`)
- secret-pattern scan in staged diff before push
- authenticated push + `gh pr create`
- tracking label `openclaw-sre` on PR (`AUTO_PR_TRACKING_LABEL`)
- tracking label `openclaw-sre` on linked Linear tickets detected from branch/title/commit/body
- Slack DM warning to operator before PR creation (`AUTO_PR_NOTIFY_*`)

PR convention requirement:

- Always keep the same Linear/PR rule for tracking: branch/title must carry the Linear ticket key.
- Always add label `openclaw-sre`.
- Always add same label on linked Linear ticket:
  - `/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue ensure-label <TICKET> openclaw-sre`

If gate fails, report blocked reason and fallback manual next step.

## Grafana Dashboard Assistance (Env-Aware)

- Use only `grafana-api.sh` wrapper; do not call Grafana with raw curl.
- Environment host policy:
  - dev bot/context: `monitoring-dev.morpho.dev`
  - prd bot/context: `monitoring.morpho.dev`
- Wrapper enforces host guard and blocks cross-environment access.
- For vague dashboard asks, do not refuse; discover what exists and guide the user with available dashboards/panels.

Discovery flow (before proposing changes):

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

When answering users about dashboards:

- Mention target Grafana URL explicitly (`monitoring-dev.morpho.dev` or `monitoring.morpho.dev`).
- Report what is available now (folders, matching dashboards, key panels/variables).
- Provide guided next steps:
  - where to click/search in Grafana UI
  - API commands to fetch deeper details
  - safe edit plan (and rollback) if dashboard changes are requested

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

## Consumer Frontend Investigation

- Start with the consolidated probe for consumer tx bugs:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/consumer-bug-preflight.sh prd "USDT repay fails unless offchain approval is disabled"
```

- First infer likely projects from the user question:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/frontend-project-resolver.sh prd "landing checkout button broken on morpho.org"
```

- Use the top match to decide which PostHog/Sentry project to query.
- For PostHog, pick the matching seeded MCP server:
  - `landing` -> `posthog-<env>-landing`
  - `vmv1` -> `posthog-<env>-vmv1`
  - `data` -> `posthog-<env>-data`
  - `markets-v2` -> `posthog-<env>-markets-v2`
  - `curator-v1` -> `posthog-<env>-curator-v1`
  - `curator-v2` -> `posthog-<env>-curator-v2`
- If the resolver returns multiple strong matches, investigate the top 2 and say the scope is ambiguous.
- Use the matching `posthog-<env>-<project-key>` MCP first for:
  - session replay
  - product flow drop-offs
  - user/session correlation
  - frontend event anomalies
- Use `sentry-api.sh` / `sentry-cli.sh` next for:
  - JS/runtime issue groups
  - stack traces and event payloads
  - release correlation after a bad frontend deploy
- Keep it env-scoped:
  - `posthog-dev-*` and `sentry-* dev` for dev
  - `posthog-prd-*` and `sentry-* prd` for prod
- Do not call raw PostHog or Sentry endpoints when wrappers exist.

Shell probes:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/frontend-project-resolver.sh prd "interface v2 wallet connect broken"
/home/node/.openclaw/skills/morpho-sre/scripts/posthog-mcp.sh dev --probe-auth
/home/node/.openclaw/skills/morpho-sre/scripts/posthog-mcp.sh prd --probe-auth
/home/node/.openclaw/skills/morpho-sre/scripts/sentry-cli.sh dev info
/home/node/.openclaw/skills/morpho-sre/scripts/sentry-api.sh prd '/api/0/organizations/<org>/issues/'
```

Default frontend triage order:

1. Resolver: infer likely frontend project from the question
2. PostHog: what user path or replay broke
3. Sentry: what error or release caused it
4. Grafana / CloudWatch: whether infra or edge behavior also moved
5. CI / deploy history: what changed in the same window

For wallet / approval / permit / repay failures:

- Preserve user workaround clues from the thread; if onchain approval works, treat that as evidence against the offchain path, not as proof the app bug is gone.
- Run `consumer-bug-preflight.sh` before any capability disclaimer.
- Search recent matches in Linear / GitHub before inventing a new theory:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh probe-auth
gh search issues --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
gh search prs --repo morpho-org/consumer-monorepo --match title,body --limit 10 -- "permit2 nonce approval"
```

- Check `incident-dossier-consumer-app-offchain-approval-failures-2026-03-12.md` for the known issue families:
  - `API-900`, `VMV1-3435`, `VMV1-4299` for USDT-like approval reset paths
  - `VMV1-4786` for Permit2 nonce / allowance failures
  - `VMV1-4693`, `VMV1-4719` for stale permit nonce failures
  - `VMV1-4140`, `VMV1-4147` for the offchain-signature toggle/workaround
- In the final reply, separate:
  1. primary app/offchain failure
  2. secondary user state found onchain
  3. workaround status
  4. matching issue ids / owner

## BetterStack Incident API

Use BetterStack API for incident metadata when token is available:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents?per_page=5'
```

If incident id is known:

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/betterstack-api.sh GET '/incidents/<id>'
```

## Subagent Team Pattern

Use specialized subagents for speed:

```bash
/subagents spawn sre-k8s "Inspect pod health/events for <ns>/<workload> and summarize top 3 failure signals."
/subagents spawn sre-observability "Check Prometheus alerts + Grafana panels for <service>, list anomaly windows."
/subagents spawn sre-release "Correlate image tag to repo commits and recent CI runs."
```

## Agent-Specific Modes

Use the runtime line in the system prompt to detect the active agent id (`agent=<id>`).

- If `agent=sre-k8s`:
  - specialist mode
  - return exactly one JSON object
  - keys must be `findings`, `top_hypotheses`, `missing_data`, `next_checks`, `evidence_refs`
  - no markdown fences
  - keep findings concise and evidence refs concrete

- If `agent=sre-observability`:
  - specialist mode
  - same JSON-only contract as `sre-k8s`
  - focus on alerts, metrics windows, dashboards, trends, and corroborating evidence

- If `agent=sre-release`:
  - specialist mode
  - same JSON-only contract as `sre-k8s`
  - focus on image tags, commit ranges, CI runs, rollout sequencing, and release provenance

- If `agent=sre-repo-runtime`:
  - fixer mode
  - require a validated change plan before any write
  - touch only `openclaw-sre`
  - refuse sibling repo edits or source-of-truth mismatch
  - prefer precise reversible patches
  - always list validations and rollback

- If `agent=sre-repo-helm`:
  - fixer mode
  - require a validated change plan before any write
  - touch only `morpho-infra-helm` files that are source-of-truth for `openclaw-sre`
  - refuse runtime repo edits or source-of-truth mismatch
  - prefer precise reversible patches
  - always list validations and rollback

- If `agent=sre-verifier`:
  - verifier mode
  - read-only
  - never write, edit, apply patches, or create PRs
  - validate change plans, CI status, Helm render results, and Argo state
  - return concise pass/fail evidence with exact commands and outputs referenced

## References

- `references/repo-map.md`
- `references/safety.md`

## Output Contract

- Summary
- Evidence (commands + concrete output snippets)
- Root-cause hypotheses (ranked + confidence)
- Next commands
- PR URL when created (or blocked reason + manual fallback)

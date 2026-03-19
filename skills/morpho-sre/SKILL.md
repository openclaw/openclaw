---
name: morpho-sre
description: "Morpho infrastructure SRE skill. Use for any production incident, alert triage, infrastructure investigation, or operational task in Morpho AWS/EKS clusters. Covers incident RCA, DB evidence, API wrapper scripts, auto-remediation PRs, sentinel monitoring, consumer frontend debugging, and security posture. Start here — routes to focused companion skills."
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# Morpho SRE

## Response Discipline (overrides verbosity defaults; does not override safety, blocked-mode, or incident-format contracts)

Every text output you produce becomes a visible message to the user. Intermediate thinking is spam.

- **ONE message per task.** Investigate silently. Send a single consolidated reply with conclusions, evidence, and next steps. Do not narrate your investigation.
- **Zero progress messages.** Never send messages like "Checking...", "Found it", "I'm looking into...", "Let me verify", "I have one check now", "I'm pulling the data", "I found the concrete failure", "I'm checking whether...". These are noise. Suppress them completely.
- **No play-by-play.** Do not describe what you are about to do, what you just found, or what you will check next as separate messages. All of that is internal. The user sees only the finished answer.
- **This applies to ALL output surfaces** — Slack channels, Slack threads, Slack DMs, group DMs, PR comments, Linear comments, and any other user-visible output. DMs with the operator are not casual chat; the same discipline applies.
- **Between tool calls, produce no text.** If you need to run 10 commands to answer a question, run all 10 silently. Only after you have the complete answer, write one reply.
- **If you cannot answer yet, do not send partial findings.** Do not send "I found X, now checking Y". Wait until you have the full picture. Exception: if you are blocked (access denied, missing credentials, runtime broken), send one immediate blocked-mode reply per the Blocked Mode Reply Contract below — that is not a progress update.
- **Bad example** (real conversation — 20+ messages for one task):
  - "I'm checking the local cron/session evidence..."
  - "It did trigger, but I want the failure reason before I answer."
  - "I have one successful live check now. I'm pulling the timeout..."
  - "Found it."
  - "I'm checking the actual timeout limit..."
  - "There's still no schema cap, but the runtime uses setTimeout()..."
  - "Done. I set sre-daily-session-audit to the practical maximum..."
  - (and 15 more messages)
- **Good example** (same task, one message):
  - "The daily improvement session fired at 06:00 UTC but failed after 300s due to cron timeout. I bumped `timeoutSeconds` to 2147483 (max safe JS timer value) and restarted the job. It's running now with the new timeout."

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
  - prefer direct tool commands over unnecessary `bash -lc` wrappers
  - do not use `set -o pipefail`, arrays, or other Bash-only features unless command is explicitly wrapped with `bash -lc '...'`
  - when `bash -lc` is required and the payload contains quoted patterns (for example `rg` with `"`), wrap the outer payload in double quotes and escape inner double quotes instead of nesting raw single quotes
  - prefer `python3 - <<'PY'`; only use `python` after a live `command -v python` check
- Forked tests / anvil / replay / SDK repros: use Morpho cached RPC first (`skills/foundry-evm-debug/scripts/rpc-url.sh <chainId>`). Never use a repo's default RPC provider for forked simulations when the cached endpoint is available. If a forked run hits HTTP 429 or `failed to get fork block`, switch to cached Morpho RPC before concluding anything about application logic.
- GitHub auth preflight (before any repo/PR work):
  1. Check if `/home/node/.openclaw/bin/gh` wrapper exists and is on PATH — use it (auto-mints App token)
  2. Else if `GITHUB_APP_ID` + `GITHUB_APP_INSTALLATION_ID` + `GITHUB_APP_PRIVATE_KEY` exist, mint installation token via `repo-clone.sh` or `github-app-token.sh`
  3. Else if `GH_TOKEN` / `GITHUB_TOKEN` exist, use directly
  4. Only if all three fail: report blocked with exact error from each attempt
  - Never declare "GitHub is blocked" after trying only `gh auth login` or a single empty env var check.
  - For repo materialization: if mapped path has no `.git`, call `repo-clone.sh --image <workload>` to create a proper clone before attempting commits.
- For any PR work requested by a human or triggered by autofix confidence gate, use `autofix-pr.sh` which handles: repo cloning, GitHub App auth, branch creation, commit, PR creation, and Linear linking. Do not attempt manual `git clone` + `git push` + `gh pr create` — the `autofix-pr.sh` pipeline handles all auth and repo bootstrap.
- No root-cause ranking before one successful live check. Access/runtime failures alone are not enough evidence for hypotheses.
- When the operator corrects your approach or tells you to change behavior, apply the correction immediately in the current context. Do not ask permission to act — the correction itself is the authorization. Investigate, act, and report findings.
- Latent corruption investigation: when a corrupt/truncated data file predates the current alert window, investigate what activated the code path that reads it. Check for: recent deploys, pod restarts, config syncs, feature flag toggles, or compaction threshold changes since the file's last-modified timestamp. Include the activation trigger in the RCA.
- Self-referential incident: when the bot is triaging an alert about its own pod (openclaw-sre), note this in the Status line ("Self-referential incident — runtime responsiveness may be degraded during investigation") and prioritize fast, minimal evidence collection.
- On blocked investigations:
  - first reply must include exact failing command + exact error text
  - include at most 3 next checks
  - do not include `Hypotheses:` / `Likely cause:` until at least one successful live signal exists
- RBAC-aware fallback:
  - if a specific RBAC denial appears for a resource, stop retrying that verb
  - fall back to alternative evidence sources: `get`, `describe`, `logs`, events, metrics, traces, repo/config inspection
- Before broad repo/code reads, load at least one retrieval surface relevant to the incident:
  - `knowledge-index.md`
  - `runbook-map.md`
  - `repo-root-model.md`
  - relevant incident dossier / postmortem index
- Retry on repeated asks: if same/near-identical question appears again in the same thread/session, re-run relevant live checks/tools (state may have changed); do not reuse a prior failure-only answer.
- In monitored Slack incident threads, human follow-ups after the first bot reply must pass ingress and trigger fresh live checks; do not treat them like duplicate alert updates.
- If an incident thread drifts into unrelated design/history questions, redirect that discussion to a DM or new thread instead of mixing it into RCA.
- Do not send progress-only replies in any context (see Response Discipline). In incident threads, verify the message contains at least one `*Evidence:*` fact or `*Mitigation:*` action before posting.
- Fix PR gate — when RCA confidence is high:
  1. First, search for an existing open PR that already fixes the issue: `gh search prs --repo <owner/repo> --state open --match title,body --limit 10 -- "<keyword>"`. Also check recent merged PRs that may not yet be deployed.
  2. If an existing fix PR exists: link it in the reply under `*Fix PR:*` with its status (open/merged/deployed).
  3. If no existing fix PR exists and the fix is scoped and reversible: create one via `autofix-pr.sh` and post the URL in the reply.
  4. If the fix is not PR-ready: name the concrete PR candidate (repo, path, title, validation) under `*Suggested PR:*`.
  5. Never finish a high-confidence RCA without either linking an existing fix or proposing one.
- Before claiming repo/tool access is unavailable, run one live probe (`gh repo view <owner/repo>` or the target helper in dry-run mode) and quote the exact error.
- Before accepting any task that requires repo access (PR creation, code changes, repo reads), immediately run `gh repo view <owner/repo>` and verify local clone availability. If either check fails, report the blocker in the same message as the acknowledgement — do not split into acknowledge-then-fail-later.
- If a human challenges or contradicts a technical claim in any thread (incident, bug-report, or general), immediately re-investigate with fresh live evidence. If a human questions the proposed fix or PR in-thread, re-open RCA before defending the fix. Respond in the same thread with updated evidence, a revised conclusion, or an explicit confirmation/disproof statement. Never go silent after a challenge.
- If current code, query output, or live evidence disproves an earlier theory, say `Disproved theory:` and replace it before proposing a new cause or PR.
- Exact artifact replay:
  - if user provides an exact query, event ID, trace ID, address, or says the prior answer is wrong, replay that exact artifact before reusing any prior theory
  - isolate the minimal failing field set before expanding the query or naming a cause
  - use Sentry event IDs only after a live lookup, or explicitly say creds are unavailable
- Primary symptom anchoring:
  - identify the primary reported symptom first; keep adjacent errors, uncertain queries, and “might be related” artifacts as secondary until they explain that symptom
  - if a human says “the main issue is ...” or otherwise corrects scope, adopt that as the primary symptom immediately and restate the old theory as secondary or disproved
  - in bug-report threads, do not let an uncertain artifact outrank an explicit customer-visible mismatch
- Contradicted-theory recovery:
  - if new live evidence or a human correction disproves the current theory, explicitly retract the outdated theory in-thread before continuing
  - restart from the newest exact artifact instead of defending the old theory with adjacent evidence
- Resolver / incident matching:
  - do not reuse a prior incident unless operation name, schema object, failing fields, chain, and address pattern match
  - treat `vaultByAddress` and `vaultV2ByAddress` as different resolver families unless live evidence proves the same failure path
- Slack file delivery: when user asks to "send the file/csv directly", emit `MEDIA:<url-or-local-path>` in the reply (keep caption in normal text) instead of saying file upload is unavailable.
- PR body quality: keep PR descriptions concise and reviewable; never paste raw command output/manifests/log dumps (for example `helm template` full output) into PR body.
- Linear ticket mutation guardrail (Slack threads):
  - Trigger: explicit ask to create/update/comment a Linear issue/ticket (e.g., `PLA-318`).
  - Mandatory: run a live Linear mutation attempt before replying.
  - Never answer with "can't directly edit Linear" without executing a live command.
  - On failure: include exact failing command + exact error text + next unblock step.
- Consumer frontend tx bug guardrail:
  - Trigger: consumer app / wallet / permit / approval / allowance / repay failure.
  - Preserve the strongest thread clue or workaround. If a user says disabling offchain approval or using onchain approval works, keep the offchain path as the primary scope until disproven.
  - Mandatory order: `consumer-bug-preflight.sh` -> telemetry + Linear known-issue search -> Foundry/Tenderly/onchain checks.
  - Never answer with "no access" for Sentry, PostHog, Linear, or Foundry without a live probe and the exact error.
  - Never promote a secondary symptom (for example a later direct Etherscan revert or empty balance after workaround txs) to "root cause confirmed" unless it also explains the original in-app failure.
- Rewards / provider incidents (details in `references/rewards-provider-incidents.md`):
  - replay the primary user-visible reward mismatch before naming a stale-row or write-path cause
  - prove provider entity liveness or absence for the exact affected campaign or reward entity before naming the primary trigger
  - before naming a stale-row/write-path cause or opening a PR, include one live DB row/provenance fact for the affected reward entity
  - the reply must also name the exact consuming repo/path that would change the active code path
  - if the same reward token appears on both supply and borrow for one market, quote the live reward row/provenance first, then prove the provider-side truth

## Single-Vault API / GraphQL Data Incidents

- Details in `references/single-vault-incidents.md`.
- Preferred collector: `single-vault-graphql-evidence.sh`.
- compare against one healthy control vault on the same chain before calling it chain-wide.
- Compare public surfaces: `vaultV2ByAddress`, `vaultV2s` with `address_in`, `vaultV2transactions`.
- before naming an ingestion/provenance root cause, add one live DB row/provenance fact and one job-path or simulation fact for the affected entity.

## Gotchas

- `ethereum.blocks` uses columns `number` and `time` — NOT `block_number`/`block_time` despite upstream Dune reference docs
- Forked Anvil runs 429 on public RPCs — always use cached Morpho RPC first: `skills/foundry-evm-debug/scripts/rpc-url.sh <chainId>`
- `kubectl exec` is available — use it for live container debugging (env vars, process state, filesystem, network); prefer logs/describe first to avoid unnecessary exec sessions
- Vault KV v2 API path is `secret/data/...` not `secret/...` — wrapper scripts handle this
- GitHub App token wrapper at `/home/node/.openclaw/bin/gh` overrides regular `gh` — check for it before declaring GitHub blocked
- Short DB service hostnames from `db-evidence.sh` may need namespace-qualifying when the secret resolves to a cluster-local name
- Same reward token appearing on both supply AND borrow for one market = likely Merkl fetch bug, not display issue — quote live reward row first
- `vaultByAddress` and `vaultV2ByAddress` are different resolver families — do not conflate unless live evidence proves same failure path
- If copied kubeconfig is broken inside the pod, ignore it and use serviceaccount auth instead
- `autofix-pr.sh` handles ALL auth and repo bootstrap — never attempt manual `git clone` + `git push` + `gh pr create`
- BetterStack heartbeat failures and Grafana block-gap alerts are the same incident family when chain + workload match
- Historical APY series is a weak signal for single-vault incidents — prefer current-state fields plus direct RPC
- PR body must never contain raw command output, manifests, or log dumps — keep descriptions concise and reviewable
- `posthog-mcp.sh` project keys map to specific frontend apps (landing, vmv1, data, markets-v2, curator-v1, curator-v2)
- When running `erpc-context.sh`, if Vault auth fails, continue with Helm values + upstream docs — do not guess live config
- `autofix-pr.sh` can exit non-zero after creating the PR if the Linear labeling step fails — always check GitHub for the PR before retrying
- Always search for existing fix PRs before creating a new one — a recent merged PR may already contain the fix but not yet be deployed (check ArgoCD sync status)
- `pods.metrics.k8s.io` is Forbidden for the incident-readonly SA — do not retry it
- Before posting a Slack reply, verify it contains at least one `*Evidence:*` fact or `*Mitigation:*` action (see Response Discipline) — if not, buffer until you have substantive content

## Companion Skills

| Skill                   | When to use                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `sre-incident-triage`   | BetterStack alerts, Slack monitoring threads, incident RCA workflow       |
| `sre-db-evidence`       | Wrong/stale data, APY spikes, replica lag, SQL questions, postgres issues |
| `sre-api-wrappers`      | Grafana, Wiz, Dune, eRPC, Sentry, BetterStack, Linear API queries         |
| `sre-auto-remediation`  | Auto-fix PRs, confidence gates, autofix-pr.sh, Linear linking             |
| `sre-consumer-frontend` | Consumer app wallet failures, permit/approval errors, frontend bugs       |
| `sre-sentinel`          | Heartbeat monitoring, sentinel triage, alert routing, cron health         |
| `sre-verify`            | Post-fix validation, post-deploy checks, regression detection             |

## On-Demand Modes

| Command               | Effect                                                 | Script                                         |
| --------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `/freeze-mutations`   | Disable auto-PR and Linear writes                      | `scripts/hooks-freeze-mutations.sh activate`   |
| `/unfreeze-mutations` | Re-enable mutations                                    | `scripts/hooks-freeze-mutations.sh deactivate` |
| `/deep-rca`           | Force full evidence collection (override light triage) | `scripts/hooks-deep-rca.sh activate`           |
| `/evidence-only`      | Suppress hypotheses and auto-PR; facts only            | `scripts/hooks-evidence-only.sh activate`      |

Check active modes: run the corresponding script with `check` argument.

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
- Wiz API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/wiz-api.sh`
- DB target helper: `/home/node/.openclaw/skills/morpho-sre/scripts/lib-db-target.sh`
- DB evidence wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/db-evidence.sh`
- Single-vault GraphQL evidence helper: `/home/node/.openclaw/skills/morpho-sre/scripts/single-vault-graphql-evidence.sh`
- Linear ticket API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh`
- Notion API wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/notion-api.sh`
- Sentinel snapshot helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-snapshot.sh`
- Sentinel triage helper: `/home/node/.openclaw/skills/morpho-sre/scripts/sentinel-triage.sh`
- Dune CLI wrapper: `/home/node/.openclaw/skills/morpho-sre/scripts/dune-cli.sh`
- Freeze mutations hook: `/home/node/.openclaw/skills/morpho-sre/scripts/hooks-freeze-mutations.sh`
- Deep RCA hook: `/home/node/.openclaw/skills/morpho-sre/scripts/hooks-deep-rca.sh`
- Evidence-only hook: `/home/node/.openclaw/skills/morpho-sre/scripts/hooks-evidence-only.sh`
- Usage measurement: `/home/node/.openclaw/skills/morpho-sre/scripts/skill-usage-log.sh`

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
- Use `incident-dossier-consumer-app-sdk-abi-regression-2026-03-13.md` for SDK ABI decoding regressions when `cast` evidence points to interface/signature drift.
- Use `incident-dossier-openclaw-sre-relationship-index-oom-2026-03-16.md` for openclaw-sre OOM incidents caused by truncated state files and hot retry loops in plugins like relationship-index.
- Helper scripts that support RCA and eRPC investigation:
  - `erpc-context.sh`
  - `single-vault-graphql-evidence.sh`
  - `wiz-api.sh`
  - `rca-provider-codex.sh`
  - `rca-provider-claude.sh`
  - `rca-provider-openclaw-agent.sh`
- Use `references/dune/dunesql-cheatsheet.md` for DuneSQL types, functions, and
  common patterns before writing onchain analytics queries.
- Use `references/dune/dataset-discovery.md` when searching for decoded contract
  tables or spellbook datasets.

- Prefer existing repo docs over inventing parallel guidance:
  - `morpho-infra/docs/operations/incident-response.md`
  - `morpho-infra/docs/guides/ai-agents-incident-troubleshooting.md`
  - `morpho-infra/docs/operations/erpc-operations.md`
  - `morpho-infra/docs/guides/observability-stack-onboarding.md`
  - `morpho-infra/docs/services/api-endpoints.md`

- Use `references/incident-workflow.md` for the step-by-step incident investigation workflow.
- Use `references/db-first-incidents.md` for DB-first data incident playbooks.
- Use `references/rewards-provider-incidents.md` for rewards APR / campaign TVL incidents.
- Use `references/single-vault-incidents.md` for single-vault GraphQL data incidents.
- Use `references/indexer-freshness-incidents.md` for recurring indexer freshness alerts.
- Use `references/consumer-frontend-guide.md` for consumer app wallet/frontend investigations.
- Use `references/erpc-operations.md` for eRPC config, routing, and wrapper usage.
- Use `references/grafana-operations.md` for Grafana dashboard discovery and editing.
- Use `references/api-wrappers-guide.md` for all SRE API wrapper script reference.
- Use `references/auto-remediation-guide.md` for autofix-pr.sh pipeline details.
- Use `references/sentinel-operations.md` for sentinel triage pipeline details.
- Use `references/data-storage-patterns.md` for persistent data/memory patterns.
- Use `config.json` for environment config, severity scores, notification targets, and auto-PR defaults.

## Incident Workflow (Quick Reference)

1. Hard preflight. 2. Load one retrieval surface before repo spelunking. 3. Scope: impact, first seen, namespace/workload. 4. Build image-to-repo map. 5. Find affected image/app/repo/revision. 6. Cross-check k8s state + logs + metrics + traces. 7. Clone repo only after live evidence. 8. Name concrete PR candidate (repo, path, title, validation). 9. Create/reuse Linear ticket; use its `branchName`. 10. If confident + scoped, create fix PR and link to Linear. 11. Return evidence, hypotheses, confidence, PRs, Linear ticket, PR URL (or blocked reason).

For detailed playbooks by incident type, load the relevant reference file from Knowledge Surfaces.

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

- `kubectl exec` is available for live container debugging:
  - `kubectl --context "$K8S_CONTEXT" -n <ns> exec <pod> -- <command>`
  - useful for: env vars (`env | grep`), process state (`ps aux`), filesystem checks (`ls`, `cat`, `df -h`), network (`curl`, `nslookup`), config files
  - prefer logs/describe first; use exec when logs are insufficient or you need live container state
  - use exec responsibly: read-only debugging commands preferred, avoid modifying container state in production
  - for multi-container pods: `kubectl --context "$K8S_CONTEXT" -n <ns> exec <pod> -c <container> -- <command>`
- If GitHub auth fails:
  - stop retrying clone/fetch loops
  - say exact failing command and continue with local repo/chart evidence if sufficient

## Slack BetterStack Alert Intake (Quick Reference)

- Monitored channels: `#staging-infra-monitoring` (dev), `#public-api-monitoring` (prod), `#platform-monitoring` (prod), `#bug-report` (all envs).
- Trigger on BetterStack alert/update posts (including bot-authored messages).
- `#bug-report` channel: investigate every new root post as an incident. Do NOT triage, route, or create Linear tickets — only investigate with live evidence and reply with findings using the standard incident format below.
- In `#bug-report`, first visible token of every substantive reply must be `*Incident:*`; never send preambles like “Found the root cause” or “Let me compose the response.”
- Always answer in the incident thread under alert root; never post RCA in channel root.
- Use Slack mrkdwn only (`*bold*`, `` `code` ``; never Markdown `**bold**` or `##` headings).
- First four lines (required on every reply, including follow-ups):
  - `*Incident:*` plain-English summary
  - `*Customer impact:*` confirmed / none confirmed / unknown
  - `*Affected services:*` concrete services/components
  - `*Status:*` investigating / mitigated / resolved + time window
- Required sections after the header: `*Evidence:*`, `*Likely cause:*`, `*Mitigation:*`, `*Validate:*`, `*Next:*`.
- Put unrelated warnings under `*Also watching:*`.
- If confidence >= `AUTO_PR_MIN_CONFIDENCE` and fix is scoped/reversible, create PR via `autofix-pr.sh` and post URL in-thread.

For full alert intake rules (vague-question handling, recurring indexer RCA, follow-up behavior), see `sre-incident-triage` companion skill.

## Docker Image -> GitHub Repo Correlation

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh              # full map
/home/node/.openclaw/skills/morpho-sre/scripts/image-repo-map.sh --image morpho-blue-api  # filter
```

Outputs: `/tmp/openclaw-image-repo/image-repo-map.tsv` and `workload-image-repo.tsv`.
Primary mapping source: `morpho-infra/projects/commons` (`github_repositories` + `ecr_repository_mapping`). Non-ECR images default to `morpho-org/morpho-infra`.

## Clone Repo for RCA

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --image morpho-blue-api        # from image
/home/node/.openclaw/skills/morpho-sre/scripts/repo-clone.sh --repo morpho-org/morpho-blue-api  # explicit
```

If clone returns `403`, keep investigating with `workload-image-repo.tsv` `local_repo_path` values until token is fixed.

## GitHub CI Signal

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --image morpho-blue-api --limit 5      # from image
/home/node/.openclaw/skills/morpho-sre/scripts/github-ci-status.sh --repo morpho-org/morpho-blue-api --limit 10  # explicit
```

Include latest failing/successful run references with run URL in RCA output.

## RCA Checks

```bash
kubectl --context "$K8S_CONTEXT" -n <ns> get pods -o wide                                   # pod state
kubectl --context "$K8S_CONTEXT" -n <ns> get events --sort-by=.lastTimestamp | tail -n 40    # events
kubectl --context "$K8S_CONTEXT" -n <ns> get deploy/<name> -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'  # images
kubectl --context "$K8S_CONTEXT" -n <ns> rollout history deploy/<name>                       # rollout
kubectl --context "$K8S_CONTEXT" -n <ns> logs deploy/<name> --since=30m | tail -n 200        # logs
kubectl --context "$K8S_CONTEXT" -n <ns> exec <pod> -- env | grep -i <pattern>              # live env vars
kubectl --context "$K8S_CONTEXT" -n <ns> exec <pod> -- cat /path/to/config                  # live config file
kubectl --context "$K8S_CONTEXT" -n <ns> exec <pod> -- df -h                                # disk usage
curl -s 'http://prometheus-stack-kube-prom-prometheus.monitoring.svc.cluster.local:9090/api/v1/alerts' | jq '.data.alerts[] | select(.state=="firing")'  # firing alerts
```

## Smart Contract / ABI Verification

- Never present ABI encoding theories without a live `cast call`, `cast abi-decode`, or Foundry test as evidence.
- Decode actual revert data from Sentry/logs/traces before theorizing about the cause.
- For onchain state inspection, transaction replay, forked simulation, or EVM execution traces, use the bundled `foundry-evm-debug` skill instead of ad hoc `cast` or `anvil` commands.
- If blocked (no RPC, no Foundry), mark as `*Unverified theory:*`.

```bash
cast call <token_address> "eip712Domain()" --rpc-url "${RPC_URL:?}"   # verify ABI claim
cast selectors <selector>                                              # decode revert selector
cast calldata-decode <abi_types> <calldata>                            # decode revert calldata
```

## Env Var Deployment via Vault

- For `openclaw-sre` runtime env vars that should be configurable per environment, deploy them through Vault path `secret/openclaw-sre/all-secrets`.
- Source of truth:
  - live secret path: `secret/openclaw-sre/all-secrets`
  - Kubernetes sync path: chart hook `charts/openclaw-sre/templates/job-vault.yaml`
  - pod consumption path: `envFrom.secretRef.name = openclaw-sre-vault-secrets`
- Notion internal integration token key: `NOTION_SECRET`
- Preferred rollout:
  - patch Vault secret
  - let the pre-upgrade Vault sync job recreate `openclaw-sre-vault-secrets`
  - avoid adding chart-level `env:` entries for the same key, because explicit pod env overrides Vault-delivered values
- Prod-only flags should be present only in prd Vault secret payload; leave them unset in dev unless explicitly needed.
- For the eRPC full-context gate, use Vault key `ERPC_FULL_CONTEXT_ENABLED=1` in prd only.

## Linear Ticket Ops Guardrail

```bash
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue get PLA-318
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue create --title "..." --file /tmp/desc.md \
  --team Platform --project "[PLATFORM] Backlog" --assignee florian \
  --state "In Progress" --priority 2 --labels "openclaw-sre|Bug"
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue get-branch PLA-318
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue ensure-label PLA-318 openclaw-sre
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh issue add-attachment PLA-318 <PR_URL>
/home/node/.openclaw/skills/morpho-sre/scripts/linear-ticket-api.sh probe-write PLA-318
```

See `sre-auto-remediation` companion skill for the full PR pipeline (autofix-pr.sh, confidence gates, Linear linking).

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

---
summary: "CLI reference for `openclaw self-improvement` (recommendation-only idle review)"
read_when:
  - You want to inspect Self-Improvement Governor recommendations
  - You want to see grouped recommendations and the daily improvement scorecard
  - You want to trigger a manual self-improvement scan
  - You are reviewing routed reliability, efficiency, adherence, verification, or Skill Workshop findings
title: "`openclaw self-improvement`"
---

Inspect and manage durable Self-Improvement Governor recommendations. The
governor is recommendation-only: it records routed improvement opportunities
without merging, pushing, releasing, deleting files, exposing secrets, or writing
skills directly.

See [Self-Improvement Governor](/automation/self-improvement-governor) for the
background scanner, routing model, and safety constraints.

## Usage

```bash
openclaw self-improvement scan
openclaw self-improvement preflight
openclaw self-improvement models template
openclaw self-improvement models template --json
openclaw self-improvement preflight --review-model ollama/qwen3.6:27b-q8_0 --fallback-model ollama/openclaw-control-qwen3-30b-q6-chatfix:latest
openclaw self-improvement preflight --strategic --allow-strategic-local
openclaw self-improvement evals run
openclaw self-improvement evals run --fixture-set core --fail-on-threshold
openclaw self-improvement evals run --fixture-set all --limit 7 --local-first --allow-strategic-local --json
openclaw self-improvement analyze
openclaw self-improvement analyze --local-first
openclaw self-improvement analyze --local-first --allow-strategic-local
OPENCLAW_SELF_IMPROVEMENT_LLM=1 openclaw self-improvement analyze --local-first --allow-hosted-escalation --approve-llm-review --model openai/gpt-5.5
openclaw self-improvement scorecard
openclaw self-improvement health
openclaw self-improvement health --fail-on-degraded
openclaw self-improvement health --fail-on-blocked --json
openclaw self-improvement production-check
openclaw self-improvement production-check --require-model-ready --require-evals-ready --fail-on-degraded --json
openclaw self-improvement maintain --dry-run
openclaw self-improvement maintain --apply
openclaw self-improvement summary
openclaw self-improvement summary --status open,reopened --limit 10
openclaw self-improvement triage
openclaw self-improvement triage --route qa --status open,reopened --limit 10
openclaw self-improvement opportunities
openclaw self-improvement opportunities --category efficiency_opportunity,workflow_simplification --route builder --json
openclaw self-improvement list
openclaw self-improvement list --status open,acknowledged --severity high
openclaw self-improvement list --route qa --json
openclaw self-improvement audit-events
openclaw self-improvement audit-events --kind model_preflight --limit 20
openclaw self-improvement show <recommendation-id>
openclaw self-improvement assign <recommendation-id> --agent qa-test-agent
openclaw self-improvement prove <recommendation-id> --proof "pnpm test ... passed" --resolve
openclaw self-improvement update <recommendation-id> --status acknowledged --note "reviewed"
openclaw self-improvement update <recommendation-id> --status resolved --proof "pnpm test ... passed"
openclaw self-improvement groups update <group-id> --status assigned --assign qa-test-agent
openclaw self-improvement groups prove <group-id> --proof "pnpm test ... passed" --resolve
openclaw self-improvement proposals list
openclaw self-improvement proposals show <proposal-id>
openclaw self-improvement proposals update <proposal-id> --status approved --proof "operator approved"
openclaw self-improvement curator list
openclaw self-improvement curator show <proposal-id>
openclaw self-improvement curator accept <proposal-id> --proof "reviewed evidence"
openclaw self-improvement curator workshop-link <proposal-id> --workshop-proposal-id <id> --proof "pending proposal created"
openclaw self-improvement curator reject <proposal-id> --reason "duplicate"
openclaw self-improvement curator promote-proof <proposal-id> --proof "Skill Workshop item applied"
```

## Subcommands

### `scan`

```bash
openclaw self-improvement scan [--json]
```

Runs the deterministic auditor immediately through the Gateway and stores any
new or recurring recommendations. The scan includes task, cron, Skill Workshop,
project/agent health, and Governor audit-ledger evidence, including model-review
fallback or invalid JSON events.

### `models template`

```bash
openclaw self-improvement models template [--json]
```

Prints the recommended local-first Governor model setup without calling the
Gateway or mutating runtime config. The template includes the default Qwen
primary, chatfix fallback, triage, strategic local model refs, optional
external-GPU Kimi guidance, verification commands, and safety notes. No config
patch is required for the default local-only policy.

Operator-managed local serving examples:

```bash
vllm serve moonshotai/Kimi-K2.6 --host 127.0.0.1 --port 8000 --served-model-name moonshotai/Kimi-K2.6
python -m sglang.launch_server --model-path moonshotai/Kimi-K2.6 --host 127.0.0.1 --port 8000 --served-model-name moonshotai/Kimi-K2.6
```

Add hardware-specific backend flags for your GPU and serving stack. Keep the
endpoint on loopback when possible. For trusted LAN, Docker, or Tailscale model
servers, set `models.providers.<provider>.request.allowPrivateNetwork=true`;
public-looking hosted provider URLs are blocked from local-first reviewer slots
and must use hosted escalation gates instead.

Use the optional Kimi guidance only when you intentionally select
`kimi-local/moonshotai/Kimi-K2.6` and have an external GPU serving endpoint.
The default policy expects local Ollama models and does not require registering
`models.providers.kimi-local`.

### `preflight`

```bash
openclaw self-improvement preflight [--review-model <modelId>] [--fallback-model <modelId>] [--strategic-model <modelId>] [--strategic] [--allow-strategic-local] [--allow-hosted-escalation] [--hosted] [--approve-llm-review] [--model <modelId>] [--reviewer-agent <agentId>] [--json]
```

Checks Governor review model readiness without generation. By default it checks
the local-first Qwen primary and chatfix fallback policy. `--strategic`
simulates a major-change or critical group so `--allow-strategic-local` can
verify the strategic local Qwen path after the normal primary and cross-check
readiness attempts.
`--hosted` checks hosted gating instead of local-first local models.

The command returns `ready`, `readiness`, `readyTier`, `readyModelId`,
`reviewPolicy`, `preflightStatus`, `preflightMs`, attempts, model tier, model
id, quantization, parameters, context, `preflightSource`,
`providerConfigured`, remediation hints, and fallback or escalation reason. It
does not mutate runtime config, write scorecards, create recommendations, create
proposals, run model generation, or store model output. It does append a
sanitized `model_preflight` audit event so later Governor scans can recommend
fixes for repeated degraded or blocked local model readiness. Blocked-attempt
remediation hints are kept in that audit event only as bounded, sanitized
operator guidance; they do not authorize config writes or model installation.

Use `readiness` for the operator state:

- `ready`: every planned readiness attempt passed, or deterministic review does not need a model
- `degraded`: at least one planned attempt is usable, but a preferred or fallback path is blocked
- `blocked`: no planned model path is usable

`ready` remains a compatibility boolean for whether any model path is usable.
When the Qwen primary is missing but the chatfix fallback is responsive, the
result is `ready: true`, `readiness: "degraded"`, and
`readyTier: "crossCheck"`. If that chatfix path is proven through the built-in
loopback Ollama catalog rather than an explicit provider block, the attempt also shows
`preflightSource: "default_ollama"` and `providerConfigured: false`.

### `opportunities`

```bash
openclaw self-improvement opportunities [--category <csv>] [--route <csv>] [--status <csv>] [--limit <n>] [--json]
```

Lists active continuous-improvement recommendations without running tasks or
implementation work. By default it filters to the intelligence categories used
by the Governor: efficiency opportunities, instruction adherence, workflow
simplification, agent minimization, capability evolution, knowledge hygiene,
architecture simplification, risk prevention, outcome measurement, and major
change.

Use this command when reviewing ways to make OpenClaw more efficient, more
instruction-adherent, simpler, safer, or more measurable. It still returns
recommendation records only; assignment, proof, dismissal, and resolution use
the existing safe workflow commands.

### `evals run`

```bash
openclaw self-improvement evals run [--fixture-set smoke|core|all] [--limit <n>] [--local-first] [--review-model <modelId>] [--fallback-model <modelId>] [--strategic-model <modelId>] [--allow-strategic-local] [--allow-hosted-escalation] [--approve-llm-review] [--reviewer-agent <agentId>] [--fail-on-threshold] [--json]
```

Runs the Self-Improvement Governor reviewer-quality eval corpus through the
local-first reviewer path and writes a sanitized `reviewer_eval_run` audit event.
The default is `--fixture-set smoke --limit 3 --local-first`. Use `core` or
`all` for the full current corpus. `--fail-on-threshold` makes the Gateway call
fail when readiness is not `ready`, which is useful for production gates.

The eval runner measures:

- schema-valid JSON rate
- safety pass rate
- route-preservation rate
- invalid JSON and fallback usage
- p95 completion time
- quality diagnostics such as `unsafe_action`, `route_mismatch`, `missing_required_evidence`, `low_confidence`, `overbroad_recommendation`, and `invented_fact`

The eval result and audit event contain aggregate metrics, failed case ids, model
tier/model id, and diagnostic counts only. They do not store raw model output,
reasoning, prompts, secrets, or local paths. The dashboard shows the latest
`reviewer_eval_run` event as **Reviewer eval health**.

### `analyze`

```bash
openclaw self-improvement analyze [--limit <n>] [--local-first] [--review-model <modelId>] [--fallback-model <modelId>] [--strategic-model <modelId>] [--allow-strategic-local] [--allow-hosted-escalation] [--llm] [--approve-llm-review] [--model <modelId>] [--reviewer-agent <agentId>] [--json]
```

Runs a bounded analysis pass over grouped recommendations, writes a daily
scorecard snapshot, and creates or refreshes pending proposal records.
When there are no grouped recommendations, analysis is a deterministic no-op:
it writes the scorecard snapshot but does not run preflight, generation, model
attempts, or schema-validation claims.

`--local-first` uses the Governor model policy:

- `--review-model` defaults to `ollama/qwen3.6:27b-q8_0`
- `--fallback-model` defaults to `ollama/openclaw-control-qwen3-30b-q6-chatfix:latest`
- `--strategic-model` defaults to `ollama/openclaw-strategic-qwen3-235b:latest`
- `--allow-strategic-local` appends the strategic local model after the primary and cross-check attempts, only for major-change or critical groups
- `--model` names the hosted escalation model only; it does not replace the local primary reviewer

Direct hosted review with `--llm` is also treated as hosted escalation. It will
not call a hosted model unless the run includes `--allow-hosted-escalation`,
`--approve-llm-review`, and `OPENCLAW_SELF_IMPROVEMENT_LLM=1`.

The Qwen primary and chatfix fallback are tuned for schema discipline with
`temperature: 0.2`, `top_p: 0.95`, and `180000` ms timeout.

The reviewer strips reasoning content, requires schema-valid JSON, retries
invalid JSON once with the fallback model, and records model tier, model id,
quantization, parameters, context, attempt count, schema status, confidence, and
escalation reason in the analysis result. The prompt explicitly requires a
top-level JSON object that starts with `{` and ends with `}`, and tells reviewers
to return `{"groups":[]}` when no group can be improved safely. The parser normalizes common local
model wrapper mistakes, including reasoning wrappers, earlier scratchpad JSON
objects, a bare top-level group array, object-keyed `groups` or
`recommendations` maps, nested `result`/`review`/`output` wrappers, string-array
action fields, confidence labels such as `high`, field aliases such as
`recommended_action` and `recommended_next_step`, and trailing commas, before
deciding whether deterministic fallback is required. The prompt payload includes
both `id` and `groupId`. Missing `groupId` values are recovered only for
unambiguous single-group review output. Object-keyed output must still key
entries by an input group id, and multi-group, ambiguous, or unmatched output
without safe ids remains invalid. Reasoning wrappers are removed from accepted
JSON fields before storage. Unwrapped reasoning-prefixed fields such as
`Reasoning:`, `Thinking:`, `Analysis:`, or `Scratchpad:` are also stripped
unless a clear final/action marker leaves safe final text; reasoning-only fields
do not count as schema-valid review content. Local
OpenAI-compatible completion reviewers, including Kimi served through vLLM or
SGLang, also receive
`response_format: {"type":"json_object"}` and `top_p` payload hints. Native
Ollama reviewers receive reviewer-only `format: "json"` and `options.top_p`
hints, plus `think: false` when the request has no explicit thinking mode.
Other transports are not modified.

Local-first analysis runs a fail-fast preflight before generation. The preflight
parses the selected local model ref as `provider/model`, checks configured
provider/model metadata when present, probes the local HTTP catalog (`/models`
for OpenAI-compatible endpoints or `/api/tags` for Ollama), and records
`ready`, `readiness`, `readyTier`, `readyModelId`, `preflightStatus`, and
`preflightMs` on the analysis result plus attempt records. Attempt records also
show `preflightSource` and `providerConfigured` so operators can distinguish
explicit local provider configuration from the default Ollama fallback. Attempts
that reach model generation also record bounded `completionMs`, so slow
invalid-JSON fallbacks are visible without storing model output. If a selected
local Qwen, optional external Kimi, or hosted-escalation path is not configured
or reachable, that attempt is blocked and the command continues through the
deterministic local-first fallback order instead of hanging on model generation.
If chatfix succeeds after a blocked Qwen primary, the result shows
`readiness: "degraded"`, `readyTier: "crossCheck"`, and
`blockedPrimaryReason`. If no planned model path is usable, the command returns
deterministic fallback metadata.
The catalog response must parse and list the selected model id. A local server
that only returns a generic 200 response is reported as unavailable for Governor
review instead of starting an unproven generation call.
Failed local endpoint probes are cached briefly inside the running Gateway, so
dashboard refreshes and repeated analysis attempts do not spend the same
timeout on a known-dead vLLM, SGLang, LM Studio, or Ollama endpoint. Successful
probes are not cached; once the endpoint responds and lists the selected model,
the next check can prove readiness normally.
`readiness` is model-path health, while `schemaValidated` is review-output
quality. When the Qwen primary is blocked but chatfix is reachable and returns
invalid JSON, the analysis result stays `ready: true`,
`readiness: "degraded"`, `readyTier: "crossCheck"`, and
`schemaValidated: false`.
When generation returns invalid JSON, attempt metadata records the stable, safe
`diagnostic` code so the next model-routing recommendation can explain whether
the local reviewer omitted JSON, omitted required fields, used unmatched group
ids, or returned ambiguous groups without storing raw output.

Preflight also enforces the local endpoint boundary for local-first slots:
loopback endpoints are allowed, trusted private-network or local hostnames need
`models.providers.<provider>.request.allowPrivateNetwork=true`, and
public-looking provider hosts are blocked before fetch or generation. Use
hosted escalation flags when a remote hosted reviewer is intentional.

### `curator`

```bash
openclaw self-improvement curator list [--status <csv>] [--limit <n>] [--json]
openclaw self-improvement curator show <proposal-id> [--json]
openclaw self-improvement curator accept <proposal-id> --proof <text> [--workshop-proposal-id <id>] [--json]
openclaw self-improvement curator workshop-link <proposal-id> --workshop-proposal-id <id> --proof <text> [--workshop-status pending|quarantined|applied|rejected] [--json]
openclaw self-improvement curator reject <proposal-id> --reason <text> [--json]
openclaw self-improvement curator promote-proof <proposal-id> --proof <text> [--workshop-proposal-id <id>] [--workshop-status pending|quarantined|applied|rejected] [--json]
```

Reviews `memory_skill` proposals without writing skills or memory. Curator
commands update only the durable proposal record and append sanitized audit
metadata through `selfImprovement.curator.*` Gateway RPCs.

Accepting or promoting requires proof. Rejecting, superseding, or requesting
more evidence requires a reason. Promotion requires a linked, non-quarantined
Skill Workshop proposal. The curator path never applies Skill Workshop
proposals, edits files, runs implementation tasks, pushes, merges, or releases.

Hosted escalation is blocked unless `--allow-hosted-escalation`,
`--approve-llm-review`, and `OPENCLAW_SELF_IMPROVEMENT_LLM=1` are all present.
`--model` selects the hosted escalation model or the legacy hosted `--llm`
review model. `--reviewer-agent` selects the agent whose model/auth profile
should run the review.

In local-first runs, direct callers cannot use a hosted-looking
`--review-model` such as `openai/...` as the primary, fallback, or strategic
local reviewer. OpenClaw blocks that attempt and keeps going through the local
fallback path. Use `--model` plus the hosted escalation gates when a hosted
review is intentional.

### `scorecard`

```bash
openclaw self-improvement scorecard [--days <n>] [--limit <n>] [--json]
```

Shows the current scorecard and recent daily scorecard snapshots written by
analysis runs.

### `health`

```bash
openclaw self-improvement health [--days <n>] [--limit <n>] [--fail-on-degraded] [--fail-on-blocked] [--json]
```

Shows current Self-Improvement Governor operational health plus recent durable
health snapshots. The health result is deterministic and read-only. It derives
overall `ready`, `degraded`, or `blocked` status, score, trend, blockers, next
actions, and dimension cards for recommendations, reviewer evals, model
readiness, background cadence, proposal queue, and verification proof.

`--fail-on-degraded` exits nonzero unless the current status is `ready`.
`--fail-on-blocked` exits nonzero only when the current status is `blocked`.
Use those flags for production readiness gates after the Gateway is running.
Assigned, non-overdue recommendations can still be active while health is
ready; proof remains required before resolving code, config, smoke, or approval
gated items.

### `production-check`

```bash
openclaw self-improvement production-check [--days <n>] [--limit <n>] [--fail-on-degraded] [--fail-on-blocked] [--require-model-ready] [--require-evals-ready] [--json]
```

Runs the read-only production readiness gate. The check combines operational
health with rollout evidence and returns status, score, blockers, warnings, next
actions, and evidence records. It does not scan, analyze, call a model, prune
stores, write audit events, or mutate Governor state.

`--require-model-ready` blocks unless the latest model preflight evidence is
ready. `--require-evals-ready` blocks unless the latest reviewer eval evidence
is ready. `--fail-on-degraded` exits nonzero unless the gate is fully ready, and
`--fail-on-blocked` exits nonzero only when the gate is blocked.

### `maintain`

```bash
openclaw self-improvement maintain [--dry-run] [--apply] [--json]
```

Runs bounded retention maintenance for Self-Improvement Governor stores. The
command defaults to dry-run and reports per-store retention counts without
changing state. `--apply` is required before any pruning occurs. `--dry-run` and
`--apply` cannot be combined.

Maintenance preserves active recommendations, active proposals, pending curator
work, proof gates, and safety metadata. Apply mode prunes only bounded
historical records and appends a sanitized `retention_maintenance` audit event
with counts and store names, not raw proof text, recommendation text, proposal
text, secrets, local paths, or model output.

### `summary`

```bash
openclaw self-improvement summary [--status <csv>] [--route <csv>] [--limit <n>] [--json]
```

Shows the grouped recommendation scorecard used by the dashboard. The summary
includes active/grouped counts, critical/high counts, test and approval counts,
top grouped recommendations, and the derived Action Queue.

### `triage`

```bash
openclaw self-improvement triage [--route <csv>] [--status <csv>] [--limit <n>] [--json]
```

Shows the prioritized Action Queue. Queue records include owner, SLA, proof,
closure state, rank, route, and next operator action. This command is read-only.

### `assign`

```bash
openclaw self-improvement assign <recommendation-id> --agent <agentId> [--claimed-by <name>] [--note <text>] [--json]
```

Marks one recommendation `assigned` and records the target owner. It does not
run implementation work.

### `prove`

```bash
openclaw self-improvement prove <recommendation-id> --proof <text> [--resolve] [--note <text>] [--json]
```

Attaches proof to one recommendation. Without `--resolve`, the command moves the
record to `in_progress`; with `--resolve`, it attempts a proof-gated resolve.

### `list`

```bash
openclaw self-improvement list [--status <csv>] [--severity <csv>] [--route <csv>] [--category <csv>] [--limit <n>] [--json]
```

Lists recommendations newest first. By default it shows active review records:
`open`, `acknowledged`, `assigned`, `in_progress`, `reopened`, and
`quarantined`.

### `show`

```bash
openclaw self-improvement show <recommendation-id> [--json]
```

Shows one recommendation, including route, evidence, required proof, and safety
constraints.

Recommendation, proof, note, proposal, and audit-event text returned through
Self-Improvement surfaces is sanitized for secret-like values and local
filesystem paths. Existing records are redacted on read without rewriting the
store.

### `audit-events`

```bash
openclaw self-improvement audit-events [--kind <csv>] [--limit <n>] [--json]
```

Lists the sanitized Self-Improvement audit ledger newest first. Use `--kind` to
filter to event types such as `model_preflight`, `analysis_run`,
`proposal_created`, `scorecard_snapshot_written`, `background_cycle`,
`operational_health_snapshot`, or `retention_maintenance`. This is a read-only Gateway inspection command;
it does not append audit events or mutate Governor state.
Model-reviewed analysis events keep bounded attempt counts, tier/status
summaries, blocker text, and remediation hints so later scans can route exact
model-readiness follow-up without storing model output or reasoning.
Invalid-JSON attempts include only a bounded `diagnostic` code and blocker text,
such as `no_balanced_json`, `missing_required_fields`, `unmatched_group_id`, or
`missing_group_id`. Audit metadata summarizes those codes as
`invalidJsonDiagnostics`. It does not include raw model output.

### `update`

```bash
openclaw self-improvement update <recommendation-id> --status <open|acknowledged|assigned|in_progress|reopened|quarantined|resolved|dismissed> [--note <text>] [--assign <agentId>] [--claimed-by <name>] [--proof <text>] [--dismissal-reason <text>] [--json]
```

Updates review status. Recurring resolved or dismissed findings are reopened by
the next scan when the same fingerprint is still present. Recommendations that
require tests need resolution proof before they can be marked resolved through
the Gateway. Dismissed recommendations require a dismissal reason.

### `groups update`

```bash
openclaw self-improvement groups update <group-id-or-key> --status <open|acknowledged|assigned|in_progress|reopened|quarantined|resolved|dismissed> [--note <text>] [--assign <agentId>] [--claimed-by <name>] [--proof <text>] [--dismissal-reason <text>] [--json]
```

Updates every recommendation in a grouped finding. Test-required groups need
resolution proof before `resolved`. Dismissed groups require a dismissal reason.

### `groups prove`

```bash
openclaw self-improvement groups prove <group-id-or-key> --proof <text> [--resolve] [--note <text>] [--json]
```

Attaches proof to every recommendation in a group. With `--resolve`, the group is
resolved only when the proof gate passes.

### `proposals`

```bash
openclaw self-improvement proposals list [--status <csv>] [--kind <csv>] [--limit <n>] [--json]
openclaw self-improvement proposals show <proposal-id> [--json]
openclaw self-improvement proposals update <proposal-id> --status <pending|acknowledged|approved|rejected|superseded> [--note <text>] [--proof <text>] [--dismissal-reason <text>] [--json]
```

Lists and updates pending Self-Improvement Governor proposals. Approval-required
proposals need `--proof` before they can be marked `approved`.

## Related

- [Self-Improvement Governor](/automation/self-improvement-governor)
- [Background tasks](/automation/tasks)
- [CLI reference](/cli)

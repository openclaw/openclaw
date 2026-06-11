---
summary: "Recommendation-only background review for OpenClaw reliability, efficiency, adherence, skills, routing, and major-change opportunities"
read_when:
  - You want OpenClaw to inspect its own state while idle
  - You are reviewing Self-Improvement Governor recommendations
  - You need the safety boundaries for procedural learning and implementation proposals
title: "Self-Improvement Governor"
sidebarTitle: "Self-Improvement Governor"
---

The Self-Improvement Governor is a native OpenClaw background reviewer. It
inspects OpenClaw state, writes durable recommendation records, groups recurring
patterns into scorecards, generates pending proposal records, and routes each
recommendation to the right OpenClaw agent role.

It does **not** directly merge, push, release, delete files, expose secrets, or
write skills. Code/config changes still require tests or explicit operator
approval. Skill updates stay in Skill Workshop pending/quarantined review until
approved by the Memory/Knowledge Curator.

## What It Inspects

The MVP scanner is deterministic and checks:

- failed, timed-out, lost, or blocked task records
- stale `queued` or `running` task records with no recent progress
- repeated correction-like task patterns
- repeated slow, blocked, timed-out, or verification-heavy workflow families
- dashboard/mobile/control-UI smoke failures
- model routing, provider, fallback, auth, rate-limit, and timeout errors
- Governor model-review audit events, including local/hosted fallback and invalid JSON
- Governor audit-ledger signals for repeated instruction, efficiency, risk, and metric gaps
- failed cron/background jobs
- Skill Workshop pending and quarantined proposals
- efficiency signals, such as latency, cost, duplicate work, token waste, and timeouts
- instruction-adherence misses, including repo-rule and test-wrapper mistakes
- workflow simplification and agent minimization opportunities
- capability-evolution and major-change signals
- stale or conflicting knowledge, docs, memory, and skill evidence
- architecture simplification, risk-prevention, and outcome-measurement gaps
- project or agent health gaps when task evidence names them

## Recommendation Records

Recommendations are stored under the OpenClaw state directory:

```text
self-improvement/recommendations.json
```

Each record includes:

- `status`: `open`, `acknowledged`, `assigned`, `in_progress`, `reopened`, `quarantined`, `resolved`, or `dismissed`
- `category`: reliability, stale work, corrections, smokes, model routing, skills, project health, verification, efficiency, instruction adherence, workflow simplification, agent minimization, capability evolution, knowledge hygiene, architecture simplification, risk prevention, outcome measurement, or major change
- `severity`, `criticality`, `priority`, `impact`, and `effort`
- `groupKey`, `groupTitle`, and `recurrenceCount` for grouping repeated findings
- source metadata, such as task id, run id, cron job id, or Skill Workshop proposal id
- route metadata for the target agent role
- deterministic or model-review analysis metadata (`analysis.mode`, selected tier, model id, attempt count, schema status, confidence, prompt version, and safety notes)
- recommended action and required evidence
- a recommendation-only safety envelope
- optional assignment, claim, resolution proof, dismissal reason, and reopen reason
- derived actionability state for owner, SLA, proof, closure readiness, blockers, and next operator action

Recommendation, proposal, and audit-event text is sanitized before display or refresh. The
governor redacts secret-like values and local filesystem paths from stored
evidence, required proof, operator notes, proposal fields, analysis text, audit
summaries, and audit metadata. Existing records are sanitized when they are
read, so old path-heavy evidence does not need a destructive store rewrite.

Recurring resolved or dismissed findings are marked `reopened` on the next scan
if the same fingerprint is still present. Recommendations that require tests
cannot be marked resolved through the Gateway unless resolution proof is already
attached or supplied in the update.

The scanner writes deterministic analysis by default. Analysis runs can request
local-first model review, but idle operation remains evidence-bound and
recommendation-only.
If there are no grouped recommendations to review, analysis stays deterministic
and records no model attempts; it does not preflight, generate, or claim schema
validation for an empty review.

## Actionability And Closure

The Governor derives actionability from durable recommendation fields instead of
writing a separate workflow store. Each recommendation and grouped card can show
owner state (`unassigned`, `assigned`, `claimed`), SLA state (`fresh`, `aging`,
`overdue`), proof state (`not_required`, `missing`, `attached`), closure state
(`blocked`, `ready_to_resolve`, `closed`), blockers, rank, and the next operator
action.

The default closure SLA is 24 hours for critical items, 72 hours for high items,
7 days for medium items, and 14 days for low items. The Action Queue ranks
overdue, unassigned, proof-missing, and ready-to-resolve items so operators can
triage them without authorizing implementation work.

Dismissal requires a reason. Test-required recommendations and groups cannot be
resolved unless proof is already attached or supplied with the update. Audit
events record status, route, assignment, claim, and proof-present metadata, but
they do not store raw proof text.

## Improvement Intelligence

The Governor derives an **Improvement Intelligence** summary from active
recommendation groups. It is not a separate store and does not authorize direct
changes. It gives operators a compact view of opportunities that can make
OpenClaw better day after day:

- efficiency opportunities from repeated slow, failed, duplicate, or timed-out work
- instruction-adherence themes that should route through Memory/Knowledge Curator
- workflow simplification and agent-minimization candidates
- architecture simplification and capability-evolution candidates
- risk-prevention gaps that need QA guardrails
- outcome-measurement gaps where improvement cannot yet be proven
- major-change candidates that require option framing, approval, tests, and rollback planning

The summary includes category counts, high/critical pressure, top opportunities,
stale unresolved patterns, instruction themes, simplification candidates,
major-change candidates, and outcome-metric gaps. The Control UI shows the
summary in the Self-Improvement panel, and
`openclaw self-improvement opportunities` lists the same active recommendation
categories from the CLI.

## Analysis Runs And Proposals

`selfImprovement.analysis.run` performs a bounded review pass over grouped
recommendations. The MVP analysis runner:

- writes or refreshes a daily scorecard snapshot in `self-improvement/scorecards.json`
- creates or refreshes pending proposal records in `self-improvement/proposals.json`
- preserves operator proposal status, proof, dismissal reason, and notes across refreshes
- records audit events in `self-improvement/audit-events.json`

Audit events are an operator ledger, not an action path. They record sanitized
status updates, analysis runs, proposal creation, proposal status changes, and
scorecard snapshots. Audit summaries and metadata are bounded and redacted
before durable writes and again when old records are read.
Model-reviewed analysis events include only bounded attempt metadata, such as
attempt counts, tier/status/preflight summaries, blocked attempt details, and
remediation hints. They do not store model output or reasoning.
Invalid-JSON attempts include a stable, bounded `diagnostic` code, such as
`no_balanced_json`, `missing_required_fields`, `unmatched_group_id`, or
`missing_group_id`. Analysis audit metadata summarizes those codes as
`invalidJsonDiagnostics`, so the Builder Agent can tune local model prompts or
serving configuration without seeing raw model output.
Model-review fallback recommendations are based on the latest relevant
analysis event. If an older local-first run fell back after invalid JSON but a
newer local-first run produced schema-valid review output, the scanner stops
refreshing the stale fallback recommendation and keeps the current model state
separate from the older failure evidence.
Operators can inspect the sanitized ledger with
`openclaw self-improvement audit-events` or the read-only
`selfImprovement.auditEvents.list` Gateway method. The list path does not append
new events or mutate Governor state.

## Reviewer Quality Evals

`selfImprovement.evals.run` runs a bounded reviewer-quality eval corpus through
the same local-first model-review path used by analysis. It is a quality gate,
not an action path. The runner checks whether reviewer output remains
schema-valid, evidence-bound, safely routed, sufficiently confident, and free of
unsafe action recommendations, overbroad rewrite advice, and invented facts.

The default eval command runs the `smoke` fixture set with three cases. Operators
can run `core` or `all` for the full current corpus. The production thresholds
are:

- schema-valid rate at least `0.95`
- safety pass rate exactly `1.0`
- route-preservation rate at least `0.98`
- p95 model completion at most `180000` ms

Each run appends a sanitized `reviewer_eval_run` audit event with aggregate
scorecard metadata: fixture set, readiness, pass/schema/safety/route rates, p95
completion, selected model/tier, diagnostic counts, and failed case ids. It does
not store model output, reasoning, prompts, raw recommendation text, secrets, or
local filesystem paths. The dashboard renders the latest event as **Reviewer
eval health** so operators can see whether the Governor reviewer is ready,
degraded, or blocked before trusting model-enriched recommendations.

Proposal records are not changes. They are routed, approval-gated cards for the
next owner to review:

- `implementation`: Builder Agent follow-up
- `verification`: QA Test Agent follow-up
- `sequencing`: Program Manager follow-up
- `memory_skill`: Memory/Knowledge Curator pending memory or skill proposal
- `user_synthesis`: Todd Stanski prioritization/synthesis
- `major_change`: Program Manager major-change review
- `agentless_alternative`: Program Manager review for simplifying work without adding agents

## Memory/Skill Curation Loop

`memory_skill` proposals are the closed-loop handoff between the Governor and
Skill Workshop. They stay in `self-improvement/proposals.json`; the Governor
does not write `SKILL.md` files, apply Skill Workshop proposals, or mutate
memory directly.

Memory/skill proposals carry curator state:

- `pending_review`: default for memory/skill proposals
- `accepted_for_workshop`: reviewed and ready to link to a pending Skill Workshop proposal
- `needs_more_evidence`: more source evidence is required before workshop work
- `rejected`: explicitly rejected with a reason
- `superseded`: replaced by another proposal or recommendation
- `promoted`: promotion proof has been attached after safe Skill Workshop handling

The Gateway exposes `selfImprovement.curator.list`,
`selfImprovement.curator.get`, and `selfImprovement.curator.update`.
These methods only update proposal records and sanitized audit metadata. They
never run tasks, edit files, push, merge, release, or write skills.

Safety gates:

- accepting or promoting requires curator proof
- rejection, supersession, and evidence requests require a curator reason
- promotion requires a linked, non-quarantined Skill Workshop proposal
- raw proof text is stored only on the proposal; audit events store proof-present booleans
- proposals that still contain redacted sensitive markers must be rewritten before workshop acceptance

Operational health degrades when accepted memory/skill proposals are not linked
to Skill Workshop and blocks when linked workshop proposals are quarantined or a
promoted proposal lacks promotion proof. The Control UI renders these records in
the **Memory/Skill Curator Queue**.

Model review is local-first. The production model policy is:

| Tier               | Default model                                         | Use                                                                     |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `primaryReview`    | `ollama/qwen3.6:27b-q8_0`                             | Default local Governor reviewer                                         |
| `crossCheck`       | `ollama/openclaw-control-qwen3-30b-q6-chatfix:latest` | Practical local retry after invalid or failed primary JSON              |
| `triage`           | `ollama/qwen3.5:9b-q4_K_M`                            | Cheap local health and triage review                                    |
| `strategic`        | `ollama/openclaw-strategic-qwen3-235b:latest`         | Explicitly enabled local escalation for major-change or critical groups |
| `hostedEscalation` | operator-selected hosted model                        | Approval-only fallback after local attempts                             |
| `optionalExternal` | `kimi-local/moonshotai/Kimi-K2.6`                     | External-GPU guidance only; disabled by default                         |

The default primary is tuned for local review rather than creativity:
`Q8_0`, `27B`, `65536` context, `8192` max output tokens,
`temperature: 0.2`, `top_p: 0.95`, and `180000` ms timeout. The chatfix
cross-check uses `Q6`, `30B`, `262144` context, the same conservative sampling
settings, and the same timeout. For major-change or critical groups,
`--allow-strategic-local` appends the strategic local Qwen attempt after the
primary and cross-check attempts.

Kimi K2.6 remains useful only when an operator has an external GPU serving host.
It is not part of production readiness on a local-first, no-external-GPU setup.
If explicitly selected, it should run behind a local OpenAI-compatible endpoint
such as vLLM or SGLang and is recorded with the optional profile `native INT4`,
`1T total / 32B active`, `262144` context, `16384` max output tokens,
`temperature: 1.0`, `top_p: 0.95`, and `300000` ms timeout.

Use this provider shape only when explicitly registering an external Kimi
endpoint:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "kimi-local": {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "local-openclaw",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        timeoutSeconds: 300,
        models: [
          {
            id: "moonshotai/Kimi-K2.6",
            name: "Kimi K2.6 Local",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
}
```

`models.mode: "merge"` keeps existing local and hosted fallback models available.
The `apiKey` value above is a non-secret loopback marker; use a real secret only
when the local serving layer enforces one.

Operator-managed serving examples:

```bash
vllm serve moonshotai/Kimi-K2.6 --host 127.0.0.1 --port 8000 --served-model-name moonshotai/Kimi-K2.6
python -m sglang.launch_server --model-path moonshotai/Kimi-K2.6 --host 127.0.0.1 --port 8000 --served-model-name moonshotai/Kimi-K2.6
```

Those commands are intentionally skeletal. Add hardware-specific tensor
parallelism, cache, memory, and quantization flags according to the local
serving backend and hardware. Keep the Governor endpoint on loopback when
possible. For a trusted LAN, Docker, or Tailscale model server, set
`models.providers.<provider>.request.allowPrivateNetwork=true`; OpenClaw still
blocks public-looking provider hosts from local-first reviewer slots and routes
hosted calls through the explicit hosted escalation gates instead.

The CLI can print the same setup skeleton without reading or writing runtime
config:

```bash
openclaw self-improvement models template
openclaw self-improvement models template --json
```

The reviewer receives only bounded, redacted recommendation/group evidence. It
must return schema-valid JSON. OpenClaw strips reasoning content before parsing
or storing output. The prompt explicitly requires a top-level JSON object that
starts with `{` and ends with `}`, and tells reviewers to return
`{"groups":[]}` when no group can be improved safely. It removes common
local-model reasoning wrappers such as
`<think>`, `<thinking>`, `<reasoning>`, `[reasoning]`, and
`<|begin_of_thought|>` blocks, including wrappers that appear inside accepted
JSON fields. It also strips unwrapped reasoning-prefixed field content such as
`Reasoning:`, `Thinking:`, `Analysis:`, or `Scratchpad:` unless a clear
`Final:`, `Answer:`, or `Recommended action:` marker leaves safe final text.
Fields that contain only stripped reasoning do not count as schema-valid review
content. It also skips earlier scratchpad JSON objects and applies the first
schema-valid recommendation payload it can prove. Local
OpenAI-compatible `openai-completions` reviewers such as Kimi on vLLM or SGLang
receive `response_format: {"type":"json_object"}` and `top_p` payload hints.
Native Ollama reviewers receive reviewer-only `format: "json"` and
`options.top_p` hints, and OpenClaw sets `think: false` only when the request
does not already declare a thinking mode.
The parser tolerates common local-model JSON wrapper mistakes such as a bare
top-level group array, object-keyed `groups` or `recommendations` maps, nested
`result`/`review`/`output` wrappers, string-array action fields, confidence
labels such as `high`, and trailing commas. The prompt payload includes both
`id` and `groupId`, and the parser accepts common local field aliases such as
`recommended_action`, `recommended_next_step`, and `safety_notes`. To avoid
misrouting recommendations, a missing `groupId` is recovered only when exactly
one input group and exactly one output group are present. Object-keyed output
must still key entries by an input group id, and ambiguous or unmatched output
still fails schema validation. The reviewer retries invalid JSON once with the
practical local fallback, then falls back to deterministic analysis if the retry
fails.
Providers that do not use either the local OpenAI-compatible completion
transport or native Ollama transport are left unchanged and still rely on schema
validation plus deterministic fallback.

Before a local reviewer attempts generation, OpenClaw runs a fail-fast preflight:

- parse the selected local reviewer ref as `provider/model`
- check `models.providers.<provider>.models` when the provider is configured
- block public hosted provider base URLs in local-first model slots before
  fetching or generating
- allow loopback endpoints by default; require
  `request.allowPrivateNetwork=true` for trusted private-network or local
  hostname model endpoints
- probe the local HTTP model catalog (`/models` for OpenAI-compatible endpoints or `/api/tags` for Ollama) with a short timeout
- record `ready`, `readiness`, `readyTier`, `readyModelId`, `preflightStatus`, `preflightMs`, tier, model id, attempt count, schema status, and fallback reason
- record whether each local endpoint came from an explicit provider config or
  the built-in default Ollama fallback (`preflightSource` and
  `providerConfigured`)
- record bounded reviewer generation duration as `completionMs` for attempts that reach model generation
- summarize bounded group confidence on the analysis result and dashboard/CLI summaries
- attach read-only remediation hints to blocked attempts, such as running the model template helper or fixing a local provider catalog before retrying

Preflight does not install models or mutate runtime config. If a selected local
Qwen, optional external Kimi, or hosted-escalation path is not configured or the
local endpoint is unavailable, that attempt is blocked with bounded metadata and
the runner continues through the deterministic local-first fallback order. If no
planned model path is usable, analysis returns
`mode: fallback` with deterministic recommendations. If a local model is
configured but OpenClaw cannot prove the selected model from the HTTP
health/catalog endpoint, the attempt is blocked as unavailable or missing config
instead of starting a long generation call. A plain 200 response is not enough;
the catalog must parse and list the selected model id.
Failed local endpoint probes are cached briefly inside the running Gateway, so
dashboard refreshes and repeated analysis attempts do not spend the same
timeout on a known-dead vLLM, SGLang, LM Studio, or Ollama endpoint. Successful
probes are not cached; once the endpoint responds and lists the selected model,
the next check can prove readiness normally.
`readiness` describes whether a planned reviewer model path was available and
responsive. `schemaValidated` and invalid-JSON diagnostics describe whether the
review output was safe to use. A reachable chatfix cross-check that returns
invalid JSON after the Qwen primary is blocked is therefore
`readiness: "degraded"` with `schemaValidated: false`, not fully blocked model
readiness.

Use the preflight-only readiness command before enabling model review:

```bash
openclaw self-improvement preflight
openclaw self-improvement preflight --review-model ollama/qwen3.6:27b-q8_0 --fallback-model ollama/openclaw-control-qwen3-30b-q6-chatfix:latest
openclaw self-improvement preflight --strategic --allow-strategic-local
```

The command calls `selfImprovement.models.preflight`. It checks the same
local-first policy and returns `ready`, `readiness`, `readyTier`, `readyModelId`,
`reviewPolicy`, `preflightStatus`, `preflightMs`, attempts, tier, model id,
quantization, parameters, context, and any fallback or escalation reason without
mutating runtime config, creating recommendations, creating proposals, or
running LLM completions. It appends a sanitized `model_preflight` audit-ledger
event so future Governor scans can notice repeated degraded or blocked local
model readiness.
`ready` is a compatibility boolean for "at least one configured path is usable."
`readiness` is the operator state:

- `ready`: every planned readiness attempt passed, or deterministic review does not need a model
- `degraded`: at least one planned attempt is usable, but a preferred or fallback path is blocked
- `blocked`: no planned model path is usable

For example, a missing Qwen primary with a responsive chatfix fallback returns
`ready: true`, `readiness: "degraded"`, `readyTier: "crossCheck"`, and
`readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest"` so the dashboard can show that the
Governor can still review locally while the preferred primary model remains a
setup gap.
When that fallback is reached through the built-in Ollama default instead of an
explicit `models.providers.ollama` block, the attempt reports
`preflightSource: "default_ollama"` and `providerConfigured: false`. That is
still local-first and read-only, but it tells operators that the fallback is
coming from the default loopback Ollama catalog rather than from durable config.
Blocked attempts also carry a bounded `remediationHint` in CLI, Gateway, and
dashboard metadata. The hint is advisory only. It never changes configuration,
installs models, writes skills, or starts a merge/push/release path.
The sanitized model-preflight audit event keeps those remediation hints as
bounded metadata so the next Governor scan can route a model-readiness
recommendation with the exact operator next step, without storing model output
or secret-bearing config.
Model-preflight audit events also summarize `preflightSources` and
`defaultOllamaFallbackAttempts` so repeated dependence on the default Ollama
fallback can be inspected from the ledger without storing model output.

Analysis results include the same readiness summary when they make model
attempts. A successful chatfix fallback after a blocked Qwen primary returns
`mode: "local_retry"`, `readiness: "degraded"`, `readyTier: "crossCheck"`,
`readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest"`, and
`blockedPrimaryReason` so CLI, Gateway clients, dashboard cards, and audit
events can explain why the fallback was used. Generated attempts also carry
`completionMs`, which helps separate a
fast schema problem from a slow local reviewer that eventually returned invalid
JSON.

Hosted escalation stays locked down. A hosted model call happens only when all
hosted gates pass:

- hosted escalation is explicitly allowed for the run (`--allow-hosted-escalation` or `allowHostedEscalation: true`)
- the run explicitly approves hosted review (`--approve-llm-review` or `llmApproval: true`)
- the environment enables the governor hosted LLM gate (`OPENCLAW_SELF_IMPROVEMENT_LLM=1`)
- runtime model routing/auth can resolve the requested model or reviewer agent

If any gate fails, the runner reports `mode: fallback`, records the reason, and
uses deterministic analysis. Model output can enrich proposal summaries/actions,
but it still cannot merge, push, release, delete files, expose secrets, or write
skills.

In local-first runs, `modelId` / `--model` is reserved for the hosted escalation
model. It does not replace the primary local reviewer. Use `reviewModelId` /
`--review-model` for the local primary. If a direct caller supplies a
hosted-looking `reviewModelId`, fallback model, or strategic model for a
local-first tier, OpenClaw blocks that attempt before preflight/generation and
continues through the remaining local fallback plan.

## Grouped Scorecard

`selfImprovement.summary` groups active recommendations and returns a current
scorecard:

- active and total recommendation counts
- grouped recommendation count
- critical/high open counts
- test-required and approval-required counts
- reopened/resolved counts for the last 24 hours
- buckets by category and route
- short lists for `needsApproval`, `whatWorsened`, and `whatImproved`
- an Action Queue summary for unassigned, overdue, proof-missing, blocked, and ready-to-resolve items
- an Improvement Intelligence summary for continuous-improvement opportunity pressure

The dashboard and CLI use this grouped view so repeated failures become one
operational card instead of a noisy list of identical task records.

`selfImprovement.scorecard` returns the current scorecard plus recent daily
snapshots written by analysis runs.

## Operational Health

The Governor also derives deterministic operational health from existing
recommendations, scorecards, proposals, audit events, reviewer evals, model
preflight events, and background-cycle signals. Health snapshots are stored in:

```text
self-improvement/health-snapshots.json
```

Each snapshot includes an overall `ready`, `degraded`, or `blocked` status, a
0-100 score, a trend, blockers, next actions, and dimension cards for:

- recommendations
- reviewer evals
- model readiness
- background cadence
- proposal queue
- verification proof
- improvement intelligence

Manual analysis writes a health snapshot after analysis. Background cycles write
a sanitized `background_cycle` audit event and then write a health snapshot so
operators can see whether idle review is fresh, stale, or failing. Snapshot
audit events use `operational_health_snapshot` and contain only bounded
aggregate metadata.

Use the read-only health check for production gates:

```bash
openclaw self-improvement health
openclaw self-improvement health --fail-on-degraded
openclaw self-improvement health --fail-on-blocked --json
```

## Production Readiness

`selfImprovement.productionCheck` combines operational health with rollout
evidence into a read-only production gate. It does not scan, analyze, call a
model, prune stores, or mutate audit state.

The gate derives:

- overall `ready`, `degraded`, or `blocked` status
- score, blockers, warnings, and next operator actions
- health-dimension evidence from recommendations, reviewer evals, model
  readiness, background cadence, proposal queue, verification proof, and
  improvement intelligence
- retention-maintenance evidence from the latest maintenance audit event
- optional strict readiness checks for model preflight and reviewer evals

Active assigned recommendations do not make the gate fail by themselves. The
gate fails when work is uncontrolled, stale, unowned, overdue, unrouted, missing
a proof path, or backed by blocked reviewer/model/background evidence. This
keeps continuous improvement healthy while still preventing proof-required
recommendations from closing without evidence.

Use the CLI gate when preparing a production rollout:

```bash
openclaw self-improvement production-check
openclaw self-improvement production-check --fail-on-degraded
openclaw self-improvement production-check --require-model-ready --require-evals-ready --json
```

`--require-model-ready` requires a latest `model_preflight` audit event whose
readiness is `ready`. `--require-evals-ready` requires a latest
`reviewer_eval_run` audit event whose readiness is `ready`. These strict flags
are useful once local reviewer serving and eval scheduling are part of the
operator's production runbook.

## Routing

The governor routes by category:

| Route                    | Agent role                               | Used for                                                                                                     |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Todd Stanski             | User-facing synthesis and prioritization | User-facing priority framing                                                                                 |
| Builder Agent            | Implementation proposals                 | reliability, routing, efficiency, architecture                                                               |
| QA Test Agent            | Verification gaps                        | smoke, test-proof, and risk-prevention gaps                                                                  |
| Program Manager          | Sequencing and prioritization            | stale work, project health, workflow simplification, agent minimization, capability evolution, major changes |
| Memory/Knowledge Curator | Memory and skill updates                 | Skill Workshop, repeated corrections, instruction adherence, knowledge hygiene                               |

If optional configured agent ids are absent, the route still records the
intended role and the best default target id.

## Background Operation

Gateway post-ready maintenance starts the governor as an unref'd background
task. The default cadence is every 6 hours, with an initial delayed scan after
Gateway startup. Set `OPENCLAW_SELF_IMPROVEMENT_INTERVAL_MS` to change the
interval. Intervals below 15 minutes are floored to 15 minutes so the Governor
cannot accidentally create a tight idle-review loop. Background starts also add
bounded jitter by default, which spreads recurring review work away from Gateway
startup and other cron jobs.

Each background cycle runs the deterministic scanner, then runs deterministic
analysis over grouped findings so the daily scorecard and pending proposal queue
stay fresh while OpenClaw is idle. Background analysis does not request model
review, hosted escalation, or local-first generation; explicit CLI or Gateway
parameters are still required for model-reviewed analysis.

Each scan creates a normal system-scoped background task record so the review is
visible in the task ledger. Analysis writes sanitized audit events, scorecard
snapshots, and proposal records, but still cannot merge, push, release, delete
files, expose secrets, or write skills.

If a background cycle is still running when the next interval fires, the next
cycle is skipped and a sanitized `background_cycle` audit event records the
overlap. Background cycles also have a bounded timeout controlled by
`OPENCLAW_SELF_IMPROVEMENT_TIMEOUT_MS` (default 20 minutes). Timeouts are
recorded as audit and health evidence for operator follow-up instead of letting
the scheduler hang indefinitely.

## Retention Maintenance

The Governor keeps durable recommendation, proposal, scorecard, health, and
audit stores bounded through an explicit maintenance command and Gateway method.
Maintenance defaults to dry-run and reports what would be pruned without
changing state:

```bash
openclaw self-improvement maintain --dry-run
openclaw self-improvement maintain --dry-run --json
```

Applying retention requires an explicit apply flag:

```bash
openclaw self-improvement maintain --apply
```

The retention policy preserves active work and prunes only bounded historical
records:

- active recommendations are preserved; closed recommendations are retained for
  90 days, with a maximum recommendation store target of 1000 records
- audit events are retained for 30 days or the latest 500 events
- operational-health snapshots are retained for 30 days or the latest 120
  snapshots
- scorecards are retained for 180 days or the latest 180 snapshots
- pending, accepted, and active proposals are preserved; inactive old proposals
  are retained for 90 days, with a maximum proposal store target of 1000 records

When apply mode prunes data, the Governor appends a sanitized
`retention_maintenance` audit event with store names and record counts only. It
does not store raw proof text, recommendation text, proposal text, secrets,
local paths, or model output in maintenance metadata.

## CLI

```bash
openclaw self-improvement scan
openclaw self-improvement models template
openclaw self-improvement preflight
openclaw self-improvement analyze
openclaw self-improvement analyze --local-first
openclaw self-improvement analyze --local-first --allow-strategic-local
OPENCLAW_SELF_IMPROVEMENT_LLM=1 openclaw self-improvement analyze --local-first --allow-hosted-escalation --approve-llm-review --model openai/gpt-5.5
openclaw self-improvement scorecard
openclaw self-improvement health
openclaw self-improvement health --fail-on-degraded
openclaw self-improvement production-check
openclaw self-improvement production-check --require-model-ready --require-evals-ready --json
openclaw self-improvement maintain --dry-run
openclaw self-improvement maintain --apply
openclaw self-improvement audit-events
openclaw self-improvement audit-events --kind model_preflight --limit 20
openclaw self-improvement summary
openclaw self-improvement triage --route qa
openclaw self-improvement list
openclaw self-improvement list --status open,acknowledged --severity high
openclaw self-improvement show <recommendation-id>
openclaw self-improvement assign <recommendation-id> --agent qa-test-agent
openclaw self-improvement prove <recommendation-id> --proof "pnpm test ... passed" --resolve
openclaw self-improvement update <recommendation-id> --status assigned --assign qa-test-agent
openclaw self-improvement update <recommendation-id> --status resolved --proof "pnpm test ... passed"
openclaw self-improvement groups update <group-id> --status acknowledged
openclaw self-improvement groups prove <group-id> --proof "pnpm test ... passed" --resolve
openclaw self-improvement proposals list
openclaw self-improvement proposals show <proposal-id>
openclaw self-improvement proposals update <proposal-id> --status approved --proof "operator approved"
```

Use `--json` on any command for automation.

## Dashboard

Open **Agents -> Self-Improvement** in the Control UI to view the daily
scorecard, Action Queue, production readiness, retention-maintenance dry-run results,
operational health, grouped recommendation cards, proposal queue,
sanitized audit ledger, routing, actionability state, required evidence, analysis mode, selected
tier, model id, attempt count, schema status, preflight state, per-attempt model profiles
(quantization, parameter size, context, output limit, sampling, and timeout),
bounded attempt blocker details, invalid-output diagnostic codes,
escalation/fallback state, and safety state.
The panel can trigger a manual scan, bounded deterministic analysis run, model
readiness check, read-only production check, retention-maintenance dry run,
assignment, claim, in-progress, proof attachment, proof-gated resolve, and
reason-required dismissal through Gateway RPC. The readiness check appends only
sanitized audit metadata. The production check and maintenance dry run do not
mutate state. Use the CLI or Gateway params when you want an explicit
local-first model review or retention apply.

## Gateway RPC

The Control UI and CLI use these Gateway methods:

- `selfImprovement.scan`
- `selfImprovement.auditEvents.list`
- `selfImprovement.summary`
- `selfImprovement.scorecard`
- `selfImprovement.health`
- `selfImprovement.productionCheck`
- `selfImprovement.maintenance.run`
- `selfImprovement.analysis.run`
- `selfImprovement.models.preflight`
- `selfImprovement.groups.update`
- `selfImprovement.recommendations.list`
- `selfImprovement.recommendations.get`
- `selfImprovement.recommendations.update`
- `selfImprovement.proposals.list`
- `selfImprovement.proposals.get`
- `selfImprovement.proposals.update`

Read-only clients can list audit events, list/get recommendations, list/get
proposals, read summaries, scorecards, operational health, and production
readiness. Model preflight checks require write-capable Gateway access because
they append sanitized audit-ledger events. Scan, analysis, retention
maintenance, group updates, recommendation updates, and proposal updates require
write scope. Retention maintenance still defaults to dry-run unless `apply` is
explicitly true.

## Safety Model

The governor only produces records. It cannot:

- merge, push, publish, or release
- perform destructive file actions
- expose secrets
- write Skill Workshop proposals directly to skills
- apply code or config recommendations without tests or explicit approval

Use the recommended route and required evidence fields as the checklist before
marking a recommendation resolved.

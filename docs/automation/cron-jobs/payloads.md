---
doc-schema-version: 1
summary: "Payload kinds, agent-turn flags, command and script payloads, and session execution styles"
read_when:
  - Choosing a system-event, agent-turn, command, or script payload
  - Setting a per-job model, thinking level, or tool policy
  - Deciding between main, current, isolated, and custom sessions
title: "Automation payloads"
sidebarTitle: "Payloads"
---

What a job runs and where it runs: the four payload kinds, their flags, and the four session execution styles. Part of the [Automations](/automation/cron-jobs) guide.

## Payloads

Every job carries exactly one payload kind, chosen by flag:

| Payload       | Flag                                           | Runs                                                       |
| ------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| System event  | `--system-event <text>`                        | An ordinary turn in the owning agent’s main session        |
| Agent message | `--message <text>`                             | A model-backed agent turn                                  |
| Command       | `--command <shell>` or `--command-argv <json>` | A shell/process on the Gateway host, no model call         |
| Script        | `--script <file\|->`                           | A headless code-mode script using the owning agent's tools |

Doctor converts former heartbeat monitors into ordinary editable `agentTurn` jobs. Gateway startup no longer reconciles a system-owned monitor from config. Use `openclaw automations list --all` to inspect both enabled and disabled jobs. See [Heartbeat migration](/gateway/heartbeat).

The weekly Skill Workshop curator (declaration key `skill-collection-review:<agentId>`, and the older `skillCollectionReview` payload kind) is retired. The Gateway deletes those stored rows when it loads the cron store and creates no replacement; the declaration-key namespace stays reserved. Learned-skill cleanup now runs without a schedule; see [Unused-skill cleanup](/tools/skill-workshop#unused-skill-cleanup).

### Agent-turn options

<ParamField path="--message" type="string" required>
  Prompt text for an agent-turn job, including main, isolated, current, and custom sessions.
</ParamField>
<ParamField path="--model" type="string">
  Model override; must resolve to an allowed model or the run fails with a validation error.
</ParamField>
<ParamField path="--fallbacks" type="string">
  Per-job fallback model list, for example `--fallbacks openai/gpt-5.6-sol,openrouter/meta-llama/llama-3.3-70b-instruct:free`. Pass `--fallbacks ""` for a strict run with no fallbacks.
</ParamField>
<ParamField path="--clear-fallbacks" type="boolean">
  On `automations edit`, removes the per-job fallback override so the job follows configured fallback precedence. Cannot combine with `--fallbacks`.
</ParamField>
<ParamField path="--clear-model" type="boolean">
  On `automations edit`, removes the per-job model override so the job follows normal automation model precedence (stored automation-session override, else agent/default model). Cannot combine with `--model`.
</ParamField>
<ParamField path="--thinking" type="string">
  Thinking level override (`off|minimal|low|medium|high|xhigh|adaptive|max|ultra`). Available levels still depend on the selected model and agent runtime.
</ParamField>
<ParamField path="--clear-thinking" type="boolean">
  On `automations edit`, removes the per-job thinking override. Cannot combine with `--thinking`.
</ParamField>
<ParamField path="--light-context" type="boolean">
  Skip workspace bootstrap file injection.
</ParamField>
<ParamField path="--skip-if-scratch-empty" type="boolean">
  Skip an agent turn when its stored scratch is explicitly empty. Missing scratch still runs. Use `--no-skip-if-scratch-empty` to turn this off.
</ParamField>
<ParamField path="--include-reasoning" type="boolean">
  Include reasoning returned by the agent alongside a meaningful result. Reasoning alone does not turn a quiet check into a notification. Use `--no-include-reasoning` to keep it out of delivery. This is separate from the model's thinking level.
</ParamField>
<ParamField path="--tools" type="string">
  Restrict which tools the job can use, for example `--tools exec,read`. Pass `--tools ""` for an empty allowlist that disables all agent tools, including tools used by a condition trigger.
</ParamField>

New jobs that can run tools always store an explicit tool policy. A job created without
`--tools` (or with `*`) stores `*`: each run uses the owner session's current tool policy,
including its group, agent, sandbox, and runtime restrictions. An agent that requests a
finite list is capped to the tools available to its creating turn and cannot widen the
stored list. If a requested name, group, or pattern matches no captured tool, agent-created
jobs and agent tool-cap edits fail with that entry in the error instead of saving a partial
list. This includes Codex app tools that the creator runtime cannot carry. Use a supported
tool name and runtime, or explicitly remove the unavailable entry.
`automations edit --clear-tools` restores `*`. Existing jobs that predate an
explicit tool policy retain their current behavior until their tool policy is explicitly
edited or the job is recreated. Agent-created script payloads, condition triggers, and jobs
whose creator captured Codex app authority store the creating turn's tools instead: scripts
reach MCP only through servers their list names, and app authority is bound to that list.

Earlier releases saved a copy of the creating turn's tool list on agent-created agent turns.
That copy could miss tools the creator had, such as the native shell. Those jobs now run with
their owner conversation's tools, like a `*` job; the stored copy is left as it is. Jobs whose
creator captured Codex app authority keep using their copy.

Changing an account-bound job to a payload that does not run tools and later back
to an agent turn preserves its account restriction. A payload conversion does not
reauthorize that job as an operator-created job.

Doctor checks scheduled tool authority only for agent turns, script payloads, and
jobs with a condition script. A command payload without a condition script does
not need agent-tool provenance; its retained account restriction stays unchanged.

Management edits cannot restore missing policy metadata as operator authority.
For a legacy job that has lost its policy, an authenticated operator can explicitly
reauthorize it, or an authenticated creator can recreate it with a fresh tool cap.

When the creator's `exec` capability is fixed to the Gateway, the automation also
retains that target. With `tools.exec.host: "auto"`, the saved target determines
placement. A conflicting current explicit host setting or required sandbox
isolation blocks the command instead of moving it to another host. Current tool
and approval policies still apply.

With `message` in the tool cap, scheduled agent turns can read messages and channel
information on supported channel plugins without an inbound chat. Operator-created
jobs use the current operator read policy. Agent-created jobs retain their recorded
creator origin and account, and the channel's delegated read restrictions still
apply. Delivery settings do not grant read access. Script payloads and condition triggers
use the same recorded creator origin at message-action admission; the channel
still enforces its own restrictions on reads and mutations.

Scheduled agent turns can inspect their own job and remove it when finished,
even without an interactive sender. This self-scoped `automations` tool does not
grant administrator access or control over other jobs, and explicit tool-policy
denials still apply.

An authenticated operator turn can schedule an `agentTurn` back into its exact
existing conversation with `sessionTarget: "session:<same session key>"`. New
jobs retain the original authenticated source privately, so the continuation can
finish authorized work, such as inspecting and merging that conversation's PR,
without another message from the operator. Each occurrence revalidates the
original operator scopes, role, device, access grant, model restrictions, and exact
session identity under current policy. This preserves the original operator
scope ceiling; it is not a new PR-only permission or a blanket grant to automations.
The stored tool cap, sandbox, and current tool denials still apply. Scheduled
automation management remains self-scoped.

The same applies to a new `isolated` or `current` `agentTurn` job that an
authenticated operator turn links to its creating conversation. The job retains
the creator's source privately, runs in its own detached session, and rechecks
the original operator scopes, role, device, and access grant at each occurrence
and before its effects. If the device or grant is revoked, or the role changes,
the next occurrence is refused with a message asking you to recreate the
automation from an authenticated turn, and the job is disabled. A revocation
during a run stops that run's remaining operator effects.

If the creating conversation is reset, a linked detached job keeps running
unbound, without that conversation's workspace or memory, and still rechecks the
creator's device and grant. A removed or archived conversation pauses the job.

Stored jobs are unchanged: a source is never inferred for an existing job, so
jobs created before this behavior keep their recorded ownership check. Binding
an older job that names its conversation only by key from an authenticated
Control UI turn in that conversation stores that turn's source (see
[Binding older jobs](/cli/cron#binding-older-jobs-to-their-conversation)). A source
is also never captured for guests, scripts, unlinked jobs, jobs created without
an authenticated operator turn (such as `cron.add` from the CLI), or another
conversation. An authenticated owner update can bind it again
to the updated task. Executable edits without that authentication discard it.
Display-only edits and disabling or re-enabling the job preserve its stored
source; names, schedules, and other executable inputs remain bound. A fresh
owner capture applies only to the definition captured, even if another manager
edits the job before the update commits. Disabling or removing a job still
cancels its active occurrence; re-enabling it does not revive that cancelled
occurrence.

A continuation waits for its current conversation turn to finish before reading
the current job and checking its source at launch. Trigger-supplied context does
not change that stored definition. Existing stored sources remain valid after an
upgrade, including jobs the scheduler disabled. A rejected source is recorded as
a terminal failure instead of repeatedly retrying the same authority error.

While an `at` agent-turn continuation in an explicitly named conversation waits
for a result, it can call `automations` with `action: "next_check"` and `in: "3m"`
to rearm that same job. It does not create a new job or change its task, target,
or permissions. Without a next-check proposal, ordinary one-shot completion and
`deleteAfterRun` behavior are unchanged.

Manual runs use the same scheduled execution context as timer-fired runs after
the request passes admission. Ending the chat turn or tool call that started a
run does not expire the job's tool access. The job still uses its stored authority
and current tool restrictions; starting it manually does not grant the caller's
extra permissions to the job.

Current global, agent, profile, and provider tool policy is checked when each new
scheduled message invocation starts. Configuration changes apply to later invocations;
an invocation already admitted retains its configuration. Disabling or removing a job,
withdrawing its `message` capability, or revoking its caller or plugin authority stops
further affected reads from that occurrence, including pending reads before another
provider request or result delivery. Re-enabling the job does not restore an
occurrence's revoked access.

A new account-bound job created by a verified local administrator retains that
authenticated local source, allowing provider-permitted reads through its saved
creator account. Editing its `toolsAllow` cap from the same local source explicitly
reauthorizes an existing job. Description, display-label, and exact no-op edits
preserve the recorded source. Changes to model-facing names, prompts, tools, schedules,
or other executable behavior need fresh source authorization and clear the old source
when none is present. Remote management alone cannot supply local-source authorization,
and older jobs without a provable origin remain blocked until reauthorized or recreated
from a fresh authorized source.

Scheduled turns can also `edit`, `delete`, `pin`, and `unpin` Discord messages.
Agent-created jobs use their recorded creator account and Discord's delegated
target restrictions. Operator-created jobs use Discord's operator target policy.
Trusted operator jobs can additionally use `channel-edit`, including the existing
channel and thread edit options; account-created jobs do not inherit operator
administration.

For these writes, the job needs `message` in its tool policy, an enabled account
and action, and the bot's required Discord permissions. Use an updated Discord plugin with
[scheduled write support](/plugins/sdk-channel-plugins#scheduled-channel-administration).

Account-bound jobs can use Discord `channel-edit` when an authenticated Discord
turn has authorized their current definition. OpenClaw privately retains that
requester's Discord account and sender identity, and Discord's current channel
or thread permissions must allow the edit. The original session creator and a
configured OpenClaw owner are not substitutes for those native permissions.

Executable edits from the job's owning conversation and account bind the job to
the current authorized editor. This includes the prompt, model, name, schedule,
delivery, and tool policy. An executable edit without a matching authenticated
Discord requester clears this permission and stops further native actions from
the old occurrence. Description and display-label changes preserve it.

Older jobs, jobs edited by older writers, and jobs whose requester authorization
was cleared need fresh authorization before `channel-edit` can run. From the
original Discord conversation and account, ask the agent to edit the job with
an explicit finite `toolsAllow` list including `message`, or recreate it there.
If its execution authorization is also missing, recreate it from that conversation;
management access alone does not restore the missing authorization.
The editor must already have automation-management access. Other job behavior
keeps its existing policy; a CLI edit cannot invent a Discord requester. These
requester facts are omitted from public job results, and no new setting is needed.

Channel-name lookup and subsequent write requests retain the current job and
plugin authority. Configuration changes apply to the next message invocation;
disabling or narrowing the job itself stops later requests and retries in the
current invocation. A confirmed write still returns its result if authority ends
while the response is pending.

### Inference account continuity

New isolated agent-turn jobs privately retain their selected stored inference account
and compatible authentication route. OAuth and API keys can remain enabled together:
changing interactive defaults, profile order, or the job’s plain model selection does
not switch the job’s account or billing route. Automatic ownership remains distinct
from an explicit user profile pin. Token refresh within the same authorization is
allowed; deleting, replacing, or revoking that authorization stops the job rather
than falling back to another account. Model and route compatibility still apply.

At creation, account capture follows scheduled-model selection, including an
allowed `model@profile` value in per-agent or global `subagents.model`. A disallowed
scheduled model falls back without retaining that model's account.

To change an account deliberately, update the job with a model/profile selection,
for example `--model "openai/gpt-4.1@work"`. This captures a fresh authorization.
For legacy jobs without a recorded inference owner, `openclaw doctor --fix` records
the account the job's next unbound run would use: an explicit selection, or else the
first account in the run's normal account order, ignoring temporary rate-limit
cooldowns. With `auth.order` set, that is the account every earlier run used; without
it, runs rotated between accounts of the same type by last use, and Doctor records one
of them. When several accounts are eligible, Doctor names the others and the command
to change the choice.
Doctor can also adopt host-managed accounts on an explicitly selected Codex runtime; it records that runtime with the account. Native-owned or model-locked sessions remain unchanged.
Doctor uses normal automation model selection, preserves inherited defaults and
fallback lists, leaves existing bindings unchanged, and backs up cron state before
committing. Missing accounts, and personal accounts needing their owner's
authorization, are left unchanged with job-specific adoption instructions.

Managed updates and the standard container entrypoint run repairing Doctor before
activation. A manual source upgrade must include `openclaw doctor --fix` before
starting the Gateway. Startup reports potentially unmigrated host-account jobs
before scheduling; it does not capture credentials or rewrite jobs.

Keys in the environment or provider config have no stored account to record. A job
on such a route stays unbound and runs on that key; once a stored account becomes eligible for its route, the
job stops with the adoption instructions instead of switching to that account. Job
creation follows the same rule. An account refusal ends the run; it never falls back
to another model or provider. Credentialless models remain usable without an account.

Unbound CLI-runtime automations use the CLI's own login and do not require an
inference binding. OpenClaw does not forward a stored inference profile on this
native-only path. Jobs with a saved inference binding keep using that account.
Known provider-auth environment variables and the backend's credential exclusions
are removed after environment overrides, even when the live-test preserve-env
option is set. Runtime settings, such as the context window, are retained.
For paired-node runs, the Gateway withholds host credentials on every node. Nodes
advertising native-only auth support also use their own provider inventory to
remove credentials. Older nodes retain their existing local environment behavior
and receive no new invocation parameter. Update the node and approve its new
capability to apply node-side filtering.

Native runtime-owned jobs retain their runtime’s existing authorization checks, and a
native connection cannot silently replace a job’s recorded host-managed inference account.
An explicit update from an authorized native creator can adopt its runtime authority.
Moving a job to an agent with a different credential owner requires explicit account adoption.
Tool and delivery accounts remain separate from the inference account.

`--model` sets the job's primary model; it does not replace a session `/model` override, so configured fallback chains still apply on top of it. An unresolved or disallowed model fails the run with an explicit validation error rather than silently falling back to the default. If a job has `--model` but no explicit or configured fallback list, OpenClaw passes an empty fallback override instead of silently appending the agent primary as a hidden retry target.

A fallback after a provider timeout continues the same scheduled turn and reuses its saved user input. Failed attempts do not complete the turn or duplicate the scheduled prompt.

Pick the model for the job's difficulty, not the agent's default. Routine
automation - summaries, triage, classification, status checks - runs well on a
lighter model, which is cheaper and faster per run and adds up across a
schedule. Keep your default model for jobs that need deep reasoning, and use
`--fallbacks` when a light primary should escalate on failure.

Model-selection precedence for isolated jobs, highest first:

1. Per-job payload `model` (explicit config; a disallowed model fails the run)
2. Gmail hook model override (only when the run came from Gmail and that override is allowed)
3. User-selected stored automation-session model override
4. Agent/default model selection

A user-selected stored session model is an exact selection, as described in [selection source policy](/concepts/model-failover#selection-source-policy): if it fails, the run reports the failure instead of answering from configured fallbacks. The same applies to an agent turn in a main or custom (`session:<key>`) session and to a main-session system event when the session's model was selected by the user. Per-job `--fallbacks` still apply.

Fast mode follows the resolved live selection. Isolated automation resolves it in this order: stored session `fastMode`, per-agent `agents.entries.*.fastModeDefault`, global `agents.defaults.fastModeDefault`, then selected-model `params.fastMode`. Auto mode uses the model's `params.fastAutoOnSeconds` cutoff, defaulting to 60 seconds.

When a runtime reports token usage without a cost, automation estimates use the selected agent's local `models.json` prices and the model metadata retained for that run.

If a run hits a live model-switch handoff, the scheduler retries with the switched provider/model and persists that model selection for the active run. A job with a recorded inference account retains that account and its compatible authentication route; a switch cannot adopt a different account. Retries are bounded: after the initial attempt plus 2 switch retries, the scheduler aborts instead of looping.

Before an isolated run starts, OpenClaw checks reachable local endpoints for configured `api: "ollama"` and `api: "openai-completions"` providers whose `baseUrl` is loopback, private-network, or `.local`. This preflight walks the job's configured fallback chain and only marks the run `skipped` once every candidate is unreachable; `--fallbacks ""` keeps that walk strict to just the primary model, and a user-selected stored session model keeps it strict to that model. A down endpoint records the run as `skipped` with a clear error instead of starting a model call. The result is cached for 5 minutes per endpoint (not per job or model), so many due jobs sharing a dead local Ollama/vLLM/SGLang/LM Studio server cost one check instead of a request storm. Skipped preflight runs do not increment execution-error backoff. They use the existing [failure-alert policy](/automation/cron-jobs/delivery#failure-notifications) without requiring `failureAlert.includeSkipped`; recurring jobs remain enabled and recover automatically when a later preflight finds the provider reachable.

Client-side preflight timeouts are not cached. The next scheduled run checks the endpoint again instead of inheriting a timeout from another run.

The local check opens and closes a TCP connection without sending HTTP requests or provider credentials, so authenticated local servers do not log spurious `/models` authorization failures. TLS, authentication, and model errors are handled by inference. Endpoints routed through a managed proxy defer connectivity checks to inference instead of testing a direct connection.

### Job scratch and quiet results

Each job can keep private task context in scratch stored in the shared state
database, capped at 256 KiB. Present scratch is injected into the job's bounded
run context. It is omitted from job lists, full job definitions, and run-history
responses.

<Warning>
Do not put API keys, tokens, or other secrets in scratch. It becomes model prompt
context even though it is omitted from job-list and history responses.
</Warning>

```bash
openclaw automations scratch <job-id> --set "Check only for newly blocked work."
openclaw automations scratch <job-id> --json
```

Scratch updates use revision compare-and-swap. The CLI reads the current revision
before writing; `--expected-revision <n>` pins a known revision. During an
automation turn, the `automations` tool exposes self-scoped `scratch_get`,
`scratch_set`, and `record_result` actions. They do not grant access to another
job's scratch or settings.

`scratch_get` returns content and the current revision. `scratch_set` replaces
the complete content, or clears it with `null`, and requires `expectedRevision`
from that read. If the prompt says scratch was shortened, reread the complete
content before replacing it. On a revision conflict, read again and reconcile
the content instead of overwriting another edit.

Use a normal final reply for a visible result and `NO_REPLY` for silence.
`record_result` accepts one outcome (`no_change`, `progress`, `done`, `blocked`,
or `needs_attention`). `no_change` needs no summary; every other outcome requires
a trimmed summary of 1–2000 characters. It records the result without sending a
notification by itself. Structured results are retained in run history. After a
successful run, the last meaningful result is saved with the job and included as
bounded context in its next prompt, even when the final reply is silent. Quiet
checks and execution failures do not overwrite that result or append result
boilerplate to the conversation. This is not a delivery retry queue. `no_change`
keeps runner delivery silent without hiding execution failures. A `progress`,
`done`, `blocked`, or `needs_attention` summary is the run's authored outcome:
an earlier tool failure the run moved past no longer adds a generic
`⚠️ <tool> failed` notice to an otherwise silent run. The failure stays visible
in the transcript and progress lane. Adaptive scheduling still uses `next_check` on a paced
job. Scratch is context, not another scheduler:
runtime does not parse `tasks:` blocks or read `HEARTBEAT.md`.

With `payload.skipIfScratchEmpty: true` (`--skip-if-scratch-empty`), blank text,
comments, headings, fence markers, and empty checklist stubs count as an empty
checklist. Removing scratch with `--unset` is different: missing scratch does
not suppress a run. Disable the job when it should stop regardless of scratch.

### Command payloads

Command payloads run scripts inside the Gateway scheduler without starting a model-backed turn. They execute on the Gateway host, capture stdout/stderr, record the run in the job's run history, and reuse the same `announce`, `webhook`, and `none` delivery modes as agent-turn jobs.

<Note>
When an agent-turn automation's exec needs approval, the card is delivered to connected approval surfaces and the run waits for the decision; answering **Always allow** mints a scoped standing grant so later occurrences run without prompting. See [Standing grants for automations](/tools/exec-approvals#standing-grants-for-automations) for lifetime, listing, and revocation.

Command payloads are an operator-admin Gateway automation surface, not an agent `tools.exec` call. Creating, updating, removing, or manually running automation jobs requires `operator.admin`; scheduled command runs later execute inside the Gateway process as that admin-authored automation. Agent exec policy (`tools.exec.mode`, approval prompts, per-agent tool allowlists) governs model-visible exec tools, not command payloads.
</Note>

```bash
openclaw automations create "*/15 * * * *" \
  --name "Queue depth check" \
  --command "scripts/check-queue.sh" \
  --command-cwd "/srv/app" \
  --announce \
  --channel telegram \
  --to "-1001234567890"
```

`--command <shell>` stores `argv: ["sh", "-lc", <shell>]`. Use `--command-argv '["node","scripts/report.mjs"]'` for exact argv execution without shell parsing. Optional `--command-env KEY=VALUE` (repeatable), `--command-input`, `--timeout-seconds` (default 10 minutes), `--no-output-timeout-seconds`, and `--output-max-bytes` control the process environment, stdin, and output bounds.

On `automations edit`, `--command-env` replaces all stored environment overrides; repeat every variable you want to keep. After a successful edit, the CLI warns on stderr with the dropped key names, never their values. This warning is best effort if the stored job cannot be read.

Delivered text is derived from process output: non-empty stdout wins; if stdout is empty and stderr is non-empty, stderr is delivered; if both are present, the scheduler sends a small `stdout:` / `stderr:` block. Exit code `0` records the run `ok`; non-zero exit, signal, timeout, or no-output timeout records `error` and can trigger failure alerts. A command that prints only `NO_REPLY` uses the normal automation silent-token suppression and posts nothing back to chat.

When the run deadline stops a command, run history retains its captured output and command timeout reason after bounded process cleanup. Completion delivery does not start after that deadline.

### Script payloads

Script payloads run headlessly in the same code-mode executor as trigger scripts, without starting a conversational agent turn. They are available by default; setting `cron.triggers.enabled: false` disables creation and execution of script payloads together with condition-trigger scripts and stream schedules. Script jobs support only `main` and `isolated` session targets.

Scripts get only self-scoped `automations` actions (status, list, get, remove, runs, and next_check), with no add, update, run, or wake. To resume a conversation later, schedule an `agentTurn` instead.

```bash
openclaw automations create "0 * * * *" \
  --name "Hourly queue check" \
  --script ./automation/check-queue.js \
  --script-timeout-seconds 300 \
  --script-tool-budget 50 \
  --session isolated \
  --announce
```

Use `--script <file|->` to read JavaScript from a file or stdin. The CLI preserves leading and trailing spaces in file paths; quote the path as one shell argument. The timeout defaults to 300 seconds and is capped at 900; the tool budget defaults to 50 calls and is capped at 200. These payload budgets are separate from the smaller trigger-gate evaluation budgets.

Script payloads can call configured MCP server tools as `MCP.<server>.<tool>({ ...input })`, like interactive Code Mode. MCP is opt-in per server: name each server in the job's `toolsAllow` (`--tools`) with an exact tool such as `wispr-flow__search_meetings` or a server-scoped glob such as `wispr-flow__*`. A wildcard `*`, a missing `toolsAllow`, a glob without a server prefix, or a script that never mentions `MCP` starts no server. Within a named server, the owning agent's tool policy still applies. Each run starts its own runtime for the named servers, counts connection time against the script timeout and each call against the tool budget, and retires the runtime when the run ends. A named server that fails to start is absent from `MCP`; if the script then fails, the run error ends with `MCP server "<name>" is unavailable: <reason>`. See [Event triggers](/automation/cron-jobs/schedules#event-triggers-condition-watchers) for the shared details.

The script may return an object with these optional fields:

- `notify`: Text delivered through the job's `announce`, `webhook`, or `none` delivery mode. If omitted, nothing is delivered. For a `main` job, the text becomes a system event.
- `wake`: `"now"` requests immediate session processing of `notify` (or a compact completion event). The legacy `"next-heartbeat"` value assigns the notice to an eligible scheduled automation; a missing target is reported.
- `state`: JSON state, capped at 16 KB and persisted only after a successful run. The next run receives a frozen copy as `trigger.state`, matching trigger scripts. Because that namespace has one persisted owner, a script payload cannot be combined with a condition trigger on the same job.
- `nextCheck`: A duration such as `"15m"`. It is valid only for jobs with pacing enabled and uses the same pacing clamp as agent-turn proposals.

Throws, timeouts, exhausted tool budgets, invalid results, and `nextCheck` without pacing are normal automation run errors: they enter run history, backoff, and failure-alert handling without persisting returned state.

Plugin reloads invalidate cached script preparation. If a plugin retires during setup,
OpenClaw refreshes the tools once before starting the script, within the original
deadline. A failure after the script starts never triggers this setup retry.
If the refresh fails, run history and failure alerts explain that automatic setup
recovery failed and the script did not run.

Changing a running job's script payload or saved state protects that edit from
the old script's returned state, including when completion is recovered after a
Gateway restart. The completed run still retains its history.

## Authoring recurring jobs

A recurring job re-runs the same instructions on every fire, so anything the model
works out from scratch costs the same time and tokens each run. Keep the model for
judgment and move the repeatable parts into code:

- Put listing and diffing, dedupe, and checkpoints or watermarks in a workspace
  script that the payload runs in a single `exec` call.
- Keep detailed instructions in a workspace file next to the script and have the
  message reference it (for example, "Follow `scripts/<job>.md`"), so most fixes
  need only workspace file edits, not a job update.
- Have the message name the exact tool ids and argument shapes the run should use,
  instead of asking the model to discover them.
- Cap `toolsAllow` to the tools the run actually needs.
- When a script can decide there is nothing to do, use a condition trigger, a
  [command payload](#command-payloads), or a [script payload](#script-payloads) so
  quiet fires skip the model. Scripts can call a configured MCP server only when
  `toolsAllow` names it (`<server>__<tool>` or `<server>__*`). Triggers and script
  payloads are unavailable when `cron.triggers.enabled` is `false`.
- When a run fails, make it fail instead of posting the error yourself: throw from
  trigger or script payload JavaScript, or exit non-zero from a command payload. A
  script that returns an error field still succeeds. The scheduler owns failure
  accounting: only the
  [failure alert](/automation/cron-jobs/delivery#failure-notifications) waits for
  consecutive failed runs; the run's own output still follows the job's delivery
  setting.

## Execution styles

### Codex apps in scheduled automations

Codex-created automations can retain the app IDs and permission ceiling
available to the authenticated creator thread. At execution, OpenClaw requires
the same prepared Codex profile and account, then narrows the stored cap against
current app policy. Revoked apps, account/runtime changes, and interactive
approval requirements stop execution with a recovery message; they never fall
back to broader or different credentials. Older jobs without a captured app
envelope continue their ordinary non-app behavior; recreate or reauthorize one
only when it needs Codex app access. See
[Native Codex plugins](/plugins/codex-native-plugins#scheduled-automations).

| Style           | `--session` value   | Runs in                                | Best for                        |
| --------------- | ------------------- | -------------------------------------- | ------------------------------- |
| Main session    | `main`              | Owning agent's main session            | Reminders, system events        |
| Isolated        | `isolated`          | Dedicated `cron:<jobId>`               | Reports, background chores      |
| Current session | `current`           | Child run of the creating conversation | Context-aware recurring work    |
| Custom session  | `session:custom-id` | Persistent named session               | Workflows that build on history |

Agent-turn jobs default to the creating conversation when the create request carries session context. Callers without a session key, including CLI and API callers that do not supply one, fall back to `isolated`. System events default to `main`; command and script payloads still default to `isolated`.

With `announce`, agent, command, and script results belong to the chat or topic that receives them. A different delivery destination gets the result instead of the creating conversation; without an external route, the creating conversation receives it. An isolated run still does not read that conversation's history. See [Automation delivery](/automation/cron-jobs/delivery) for generation checks and duplicate prevention.

<AccordionGroup>
  <Accordion title="Main session vs current vs isolated vs custom">
    **Main session** jobs run their system event or agent-turn payload through the owning agent’s ordinary session queue, with that session’s existing context and delivery context. The automation remains running until the turn settles; queue acceptance alone is not success. Internal automation turns do not extend daily or idle reset freshness; only visible user activity updates session freshness. **Current-session** jobs run as a child of the conversation that created them: each run has its own `cron:<jobId>` run session, works with that conversation's resources and authority, reads a bounded tail of the conversation, and delivers the final visible assistant result to the resolved destination (the creating conversation when no external route is configured). **Isolated** jobs run a dedicated agent turn with a fresh session. **Custom sessions** (`session:xxx`) persist context across runs, enabling workflows like daily standups that build on previous summaries.

    `current` binds conversation context, not the original agent execution; announce results belong to the resolved delivery destination. The child run has its own session identity and captured tool restrictions, and the conversation's own session row is not changed by it. While the conversation is current, a linked `current` job uses that conversation's dashboard and memory. It runs on its own scheduled model (its `--model`, or the agent's default) with the runtime and inference account recorded when the job was created, so switching the conversation's model or runtime later does not change the job's runs. A job with no recorded account, such as one on a CLI backend that uses its own login, keeps following the conversation's model selection. So does a job whose account was recorded before OpenClaw recorded runtimes, until its account is selected again with `--model <provider/model>@<profile>`. A `current` or `isolated` job linked to the conversation that created it works in that conversation's saved workspace and working directory while the conversation is current, at the workspace root rather than a subdirectory, and keeps the conversation's required sandbox. An unlinked job, or one whose conversation was reset, uses the scheduled agent's workspace. A job whose conversation was removed or archived, or whose bound worktree is gone, pauses instead of running. Resetting the conversation during a run ends the run: OpenClaw tools refuse further effects, and a CLI backend's process is stopped so its own file tools cannot keep writing to the workspace. It does not inherit the conversation's cloud worker placement. Messages sent to the job's cron session address its latest run, independently of the bound conversation. In-flight turns sent through that stable cron key are canceled if the key is reassigned. A task-specific checkout path in the prompt does not grant access to it. Before using a job to continue repository work, verify that its execution environment can access the required checkout and tools; otherwise keep the work with its existing execution owner. A result committed to the conversation does not itself resume the original agent.

    Custom-session agent turns enter the session's ordinary turn queue and wait for active work before preparing context, so a scheduled tick cannot invalidate an in-progress compaction. The automation remains running until that turn settles; queue acceptance alone does not count as success. Saved authenticated continuations retain their original source and its current permissions through execution and delivery.

    To come back to this conversation later (for example, to recheck CI), add a one-shot `at` job with `payload: { kind: "agentTurn", message: "Instructions for your next turn" }` and `sessionTarget: "session:<your session key from Runtime>"`. It runs inside the existing conversation with the same history and saved workspace/worktree.

    With `session.scope: "global"`, `session:global` targets the selected agent's existing global conversation, just like its main-session alias. Keep the literal `global` key; an explicitly agent-qualified named key remains a separate target.

    Custom-session agent turns use the existing session’s saved workspace and working directory, including its managed worktree. Requester-scoped jobs may use a saved workspace only for their owning conversation; trusted operator-scheduled jobs can target another conversation’s saved workspace. A missing, retired, or mismatched worktree stops the run instead of falling back to the agent’s default workspace. Filesystem containment and the job’s tool restrictions still apply; a path in the job prompt does not grant access. Persistent-session rollover keeps the saved workspace binding, permission mode, containment root, and inherited tool restrictions; other detached runs inherit it only from a current creating conversation, as described for `current` jobs above. A new `session:custom-id` without an existing session starts in the configured agent workspace. Use `delivery: { mode: "none" }` without an external target for quiet named-session work that needs no runner fallback announcement.

    Main-session automation events are self-contained reminders. They include their own job scratch and notices assigned to that occurrence, not another monitor’s checklist or unrelated queued events. Put required instructions in the job payload or scratch.

    Main-session agent-turn jobs support ordinary announce delivery, including an owner target. Main-session system-event and script jobs cannot use a separate chat announce target; edits that enable it are rejected without changing the job. Primary webhook delivery remains supported for main-session jobs.

  </Accordion>
  <Accordion title="What 'fresh session' means for isolated jobs">
    A new transcript/session id per run. OpenClaw carries safe preferences (thinking/fast/verbose settings, labels, explicit user-selected model/auth overrides), but does not inherit ambient conversation context from an older automation session row: channel/group routing, send or queue policy, elevation, origin, or ACP runtime binding. Use `current` or `session:<id>` when a recurring job should deliberately build on the same conversation context.

    Messages sent to the job's `cron:<jobId>` session, for example with `sessions_send`, address its latest run. A message still queued when that run ends can fail, and the next run reassigns the key, so later runs start without it. Put information that later runs need in the job payload or [scratch](#job-scratch-and-quiet-results).

  </Accordion>
  <Accordion title="Unattended run contract">
    Isolated automation and hook agent turns are explicitly unattended: no one is present to clarify or approve. The final reply must be the deliverable rather than a plan, acknowledgement, or request for input. The agent records `no_change` without a summary and returns `NO_REPLY` when nothing needs doing. Unchanged state and repeated known blockers stay quiet; new blockers and changes that need action get a concise result. Explicitly requested recurring reports and digests still run and deliver at their requested cadence. Execution failures remain visible rather than being treated as no change. For machine-checkable conditions, use an existing deterministic condition trigger or script to skip inference when nothing changed, instead of paying for a model turn to rediscover that fact.

    A completed model run is not proof that the requested task succeeded. The scheduler does not classify assistant prose as an execution error: a blocker report remains ordinary output, including a subagent's settled final answer. It follows the job's delivery policy and does not itself trigger retries, error backoff, failure alerts, or owner-conversation repair. Runtime failures, such as provider errors or execution timeouts, still fail the run and use the normal scheduler failure policy. Required delivery failures are tracked separately; see [Failure notifications](/automation/cron-jobs/delivery#failure-notifications).

    For trusted scheduled jobs, the job's own instructions win when they intentionally ask for a question or plan, and the agent may remove a job that is no longer needed. External hook turns receive only the common unattended contract; they do not receive that override or self-removal guidance across the external-content boundary.

  </Accordion>
  <Accordion title="Subagent and Discord delivery">
    Child completion does not resume an isolated automation turn. If the orchestrator must act on child results (for example, integrate or verify their work), it must spawn with `collect: true` and collect the results with `agents_wait` before ending its turn; fire-and-forget delegation is valid when the child output itself is the deliverable.

    When isolated automation runs orchestrate subagents, delivery prefers the final descendant output over stale parent interim text. If descendant tasks are still running or settling, OpenClaw suppresses that partial parent update instead of announcing it. This includes a yielded orchestrator waiting for its successor to start and completed descendants whose result delivery is still pending. The wait shares the existing run deadline and stops on cancellation. A `delivery.mode: "none"` run whose turn only handed work to a child waits for the child under the same deadline and records the child's final reply as the run output without sending it. Subagents must return a meaningful result or a concrete blocker, even when delivery is `none`. A child that returns only `NO_REPLY` enters [missing-answer recovery](/tools/subagents/announce#announce); if it still produces no result or times out, the automation fails.

    For successful children, spawn-only handoffs use the complete final answer
    while it is still retained, not the 4,096-character lifecycle preview. If the
    complete answer is no longer available, delivery keeps the existing preview,
    including its trailing `…`.

    For text-only Discord announce targets, OpenClaw sends the final assistant text once instead of replaying both streamed/intermediate text and the final answer. Media and structured Discord payloads are still delivered separately so attachments and components are not dropped.

  </Accordion>
</AccordionGroup>

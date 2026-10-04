---
summary: "Typed workflow runtime for OpenClaw with resumable approval and input gates."
title: Lobster
read_when:
  - You want deterministic multi-step workflows with approvals or structured questions
  - You need to resume a workflow without re-running earlier steps
---

Lobster runs multi-step tool pipelines as one deterministic tool call, with
explicit approval/input checkpoints and resume tokens. Checkpoints belong
to the Lobster runner, not a separate orchestration registry.

## Why

Without Lobster, a multi-step job means many round-trip tool calls, with the
model orchestrating every step. Lobster moves that orchestration into a typed
runtime:

- **One call instead of many**: a single Lobster tool call returns a structured
  result for the whole pipeline.
- **Approvals built in**: side effects (send, post, delete) halt the workflow
  until explicitly approved.
- **Resumable**: a halted workflow returns a token; approve and resume without
  re-running earlier steps.

Lobster is a small, constrained DSL rather than a general scripting language:
approve/resume is a durable, built-in primitive; pipelines are data (easy to
log, diff, replay, review); the tiny grammar limits "creative" code paths so
validation stays realistic; timeouts, output caps, sandbox checks, and
allowlists are enforced by the runtime, not by each script. Each step can still
call any CLI or script - generate `.lobster` files from other tooling if you
want a richer authoring language.

Without Lobster, a recurring email triage looks like:

```text
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

With Lobster, the same job is one call that halts for approval and resumes:

```json
{ "action": "run", "pipeline": "email.triage --limit 20", "timeoutMs": 30000 }
```

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

## How it works

The separately installed official `@openclaw/lobster` plugin runs Lobster
workflows **in-process** using its embedded `@clawdbot/lobster` runtime. No
external `lobster` subprocess is spawned; the tool call returns a JSON envelope
directly. If the pipeline halts for approval or input, Lobster saves its
continuation and returns a resume token. Approval requests can also carry a
short approval ID. The call ends at the checkpoint; no process waits for the
user's answer.

## Enable

Lobster is an **optional** plugin tool, not installed or enabled by default.
Install the official plugin:

```bash
openclaw plugins install @openclaw/lobster
```

Installation applies to a running Gateway automatically; otherwise it takes effect
on the next startup. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

Then allow the tool globally:

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Or per-agent:

```json
{
  "agents": {
    "entries": {
      "main": {
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    }
  }
}
```

<Note>
`alsoAllow` adds `lobster` on top of the active tool profile without
restricting other core tools. Use `tools.allow` only if you want a restrictive
allowlist mode instead.
</Note>

The tool is disabled entirely for sandboxed tool contexts.

If you need the standalone Lobster CLI for development or external pipelines
(outside the embedded gateway runner), install it from the
[Lobster repo](https://github.com/openclaw/lobster) and put `lobster` on
`PATH`.

## Pattern: small CLI + JSON pipes + approvals

Build tiny commands that speak JSON, then chain them into one Lobster call.
(Example command names below - swap in your own.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

If the pipeline requests approval, resume with the token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Example: map input items into tool calls:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

For a **structured LLM step** inside a workflow, enable the optional
`llm-task` plugin tool and call it from Lobster:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "entries": {
      "main": {
        "tools": { "alsoAllow": ["llm-task"] }
      }
    }
  }
}
```

### Important limitation: embedded Lobster vs `openclaw.invoke`

The installed Lobster plugin runs workflows **in-process** inside the gateway.
In that embedded mode, `openclaw.invoke` does **not** automatically inherit a
gateway URL/auth context for nested OpenClaw CLI tool calls.

That means this pattern is **not currently reliable in the embedded runner**:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{ ... }'
```

Use the example below only when running the **standalone Lobster CLI** in an
environment where `openclaw.invoke` is already configured with the correct
gateway/auth context.

For `openclaw.invoke` and `clawd.invoke`, ambient `OPENCLAW_TOKEN` or
`CLAWD_TOKEN` credentials are accepted only for `localhost`, `127.0.0.1`, or
`[::1]` destinations. To send credentials to another HTTP(S) endpoint, pass
`--token` explicitly. This rule also applies to embedded workflows that
explicitly configure a remote connection. This command argument is the remote
Gateway credential, not the Lobster tool's approval-resume `token` parameter.
If an invocation times out or fails after dispatch,
Lobster does not retry it automatically, because the Gateway may already have
performed the action.

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

For model-backed steps in the embedded OpenClaw runner, use Lobster’s native `llm.invoke --provider embedded` stage. The plugin supplies an in-process adapter through `ctx.llmAdapters` that calls the host’s `api.runtime.subagent.complete` API as the agent whose session invoked the tool, in `isolated-agent-runtime` mode with no tools. It needs a Gateway request and that calling agent, and refuses to run without either rather than falling back to another agent. With no `--model`, the calling agent’s configured primary and fallback models apply, under the calling request’s operator authority and that agent’s model policy. A `--model` is an override, pinned with no fallback: the host accepts it only from a request allowed to override models (an `operator.admin` caller), or, for a request without an operator client, when `plugins.entries.lobster.subagent.allowModelOverride` and `subagent.allowedModels` permit it. See [api.runtime.subagent](/plugins/sdk-runtime/background-work#api-runtime-subagent). The adapter does not add Gateway URL or token values to `ctx.env`. Embedded answers are never cached or saved as run state. When an approval or input checkpoint holds output from an LLM stage, a resume re-checks the caller before Lobster consumes the checkpoint: the Gateway request must still carry current authority, and output from an embedded stage resumes only for the same agent and a caller that still holds every operator scope the producing call held. A refused resume leaves the checkpoint in place. Workflows that omit `--provider` keep the route Lobster auto-detects from their environment (`LOBSTER_PI_LLM_ADAPTER_URL`, then `OPENCLAW_URL`/`CLAWD_URL`, then `LOBSTER_LLM_ADAPTER_URL`), so an existing Gateway HTTP step is unchanged on upgrade; `--provider embedded` is the explicit opt-in for host-owned inference.

Malformed JSON fails the stage without being cached or silently converted to `null`. Valid JSON that fails the output schema follows Lobster’s configured schema-validation retry policy. The adapter adds no separate inference retries.

Example workflow step:

```lobster
llm.invoke --provider embedded --prompt 'Classify this item' --output-schema '{"type":"object","properties":{"category":{"type":"string"}},"required":["category"],"additionalProperties":false}'
```

The isolated runtime may retain built-in helpers, so this is not a literal zero-tool guarantee for every harness. Use another runtime if the workflow requires that guarantee. Nested `openclaw.invoke` still does not inherit Gateway URL/auth context; do not put credentials in workflow files or arguments. See [LLM Task](/tools/llm-task) for the separate `llm-task` tool.

## Workflow files (.lobster)

Lobster can run YAML/JSON workflow files with `name`, `args`, `steps`, `env`,
`condition`, and `approval` fields. Set `pipeline` to the file path in the tool
call.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Notes:

- `stdin: $step.stdout` and `stdin: $step.json` pass a prior step's output.
- `condition` (or `when`) can gate steps on `$step.approved`.

### Injected environment variables

Every step shell inherits the parent environment plus these Lobster-injected
variables, so commands can reference resolved workflow args without embedding
raw values into the command string:

- `LOBSTER_ARG_<NAME>` - one per workflow arg. The name is uppercased with each
  run of non-alphanumeric characters collapsed to `_`, so arg `user-id` becomes
  `LOBSTER_ARG_USER_ID`.
- `LOBSTER_ARGS_JSON` - every resolved arg as a single JSON string.

That is the complete injected set. There are **no** per-step output variables
such as `LOBSTER_STEP_<id>_STDOUT` or `LOBSTER_STEP_<id>_JSON_<field>`; shells
treat those names as unset, so parameter-expansion defaults can hide the error.
Read a prior step's output through step references instead - `$step.stdout`,
`$step.json`, or `$step.json.<field>` - in a `stdin:`, `env:`, or `condition:`
value. (`LOBSTER_STATE_DIR` is a separate runtime setting for the state
directory, not a per-run arg.)

## Tool parameters

### `run`

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Run a workflow file with args:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

| Field            | Default     | Notes                                                                                                        |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `pipeline`       | required    | Inline pipeline string, or a path ending in `.lobster`/`.yaml`/`.yml`/`.json` for a workflow file.           |
| `cwd`            | gateway cwd | Relative working directory; must resolve inside the gateway working directory (absolute paths are rejected). |
| `timeoutMs`      | `20000`     | Aborts the run if exceeded.                                                                                  |
| `maxStdoutBytes` | `512000`    | Aborts if captured stdout, stderr, or the embedded JSON result exceeds this size.                            |
| `argsJson`       | -           | JSON string of args for a workflow file (ignored for inline pipelines).                                      |

### `resume`

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

For approvals, use `token` or `approvalId` from `requiresApproval` and a boolean
`approve`. For input, use `token` from `requiresInput` and `responseJson`.
To cancel either kind of checkpoint, use `cancel: true` instead of a decision.
Supply exactly one of `approve`, `responseJson`, or `cancel: true`.

### Structured input

A workflow `input` step or an inline `ask` stage returns `needs_input` with the
question, a JSON Schema and a resume token. Optional `defaults` and `subject`
provide suggested values and material to review. For example:

```json
{
  "status": "needs_input",
  "requiresInput": {
    "type": "input_request",
    "prompt": "What feedback should be included?",
    "responseSchema": { "type": "string" },
    "resumeToken": "<resumeToken>"
  }
}
```

The agent presents the question in chat, then sends the user's answer as JSON:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "responseJson": "\"Please shorten the introduction.\""
}
```

`responseJson` can encode any value allowed by the returned schema, not just an
object. Lobster validates the answer before continuing. Invalid JSON or an
answer that does not match the schema leaves the checkpoint available for
correction. A resume can return another question or approval request.

This is a chat/tool interaction, not an Inbox card or form. The plugin does not
list pending checkpoints; retain the returned token to resume later. As with
approval tokens, possession of an input token permits resume by a caller allowed
to use the tool; tokens are not bound to an OpenClaw user or session.

## Output envelope

Lobster returns a JSON envelope with one of four statuses:

- `ok` - finished successfully
- `needs_approval` - paused; `requiresApproval` carries a `resumeToken` and a
  short `approvalId`, either of which can resume the run
- `needs_input` - paused; `requiresInput` carries the question, answer schema
  and `resumeToken`
- `cancelled` - explicitly denied or cancelled

The tool surfaces the envelope in both `content` (pretty JSON) and `details`
(raw object).

## Approvals

If `requiresApproval` is present, inspect the prompt and decide:

- `approve: true` - resume and continue side effects
- `approve: false` - cancel and finalize the workflow

Use `approve --preview-from-stdin --limit N` to attach a JSON preview to
approval requests without custom jq/heredoc glue. Resume state is stored as
small JSON files under the Lobster state directory (`~/.lobster/state` by
default, override with `LOBSTER_STATE_DIR`); the token itself only encodes a
pointer to that state, not the full pipeline state.

## Safety

- **Local in-process only** - workflows execute inside the gateway process; no
  network calls from the plugin itself.
- **No secrets** - Lobster doesn't manage OAuth; it calls OpenClaw tools that
  do.
- **Sandbox-aware** - disabled when the tool context is sandboxed.
- **Hardened** - timeouts and output caps enforced by the embedded runner.

## Troubleshooting

| Error                                                         | Cause / fix                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `lobster runtime timed out`                                   | Pipeline exceeded `timeoutMs`. Increase it or split the pipeline.                |
| `lobster stdout exceeded maxStdoutBytes` (or `stderr`)        | Captured output exceeded the cap. Raise `maxStdoutBytes` or reduce output.       |
| `lobster runtime result exceeded maxStdoutBytes`              | The JSON result exceeded the cap. Raise `maxStdoutBytes` or reduce output.       |
| `run --args-json must be valid JSON`                          | `argsJson` (workflow-file runs) failed to parse. Fix the JSON string.            |
| `lobster runtime failed` (or another `runtime_error` message) | The embedded runtime returned an error envelope. Check gateway logs for details. |

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/building-plugins#registering-agent-tools)

## Case study: community workflows

One public example: a "second brain" CLI + Lobster pipelines that manage three
Markdown vaults (personal, partner, shared). The CLI emits JSON for stats,
inbox listings, and stale scans; Lobster chains those commands into workflows
like `weekly-review`, `inbox-triage`, `memory-consolidation`, and
`shared-task-sync`, each with approval gates. AI handles judgment
(categorization) when available and falls back to deterministic rules when
not.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)

## Related

- [Automation](/automation) - all automation mechanisms
- [Tools Overview](/tools) - all available agent tools
- [Lobster plugin reference](/plugins/reference/lobster) - manifest, config, and tool reference for the plugin

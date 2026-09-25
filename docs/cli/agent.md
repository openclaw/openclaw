---
summary: "CLI reference for Gateway-backed `openclaw agent` turns and isolated `agent exec` runs"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
  - You want a strict, ephemeral one-shot agent run for CI
title: "Agent"
---

# `openclaw agent`

Run one agent turn through the Gateway. The explicit `--local` flag and `agent exec` are the embedded execution paths.

Gateway-backed turns are operator input. An agent's `exec` subprocess carrying
`OPENCLAW_SHELL=exec` cannot use this command to report back to another session;
use its attributed session tool or normal subagent completion instead. This
does not change operator terminal use or the separate embedded execution paths.

Pass at least one session selector: `--to`, `--session-key`, `--session-id`, or `--agent`. Explicitly blank or whitespace-only selector values are rejected before local or Gateway dispatch, even when another selector supplies a valid target. Omit an unused selector instead of passing an empty value.

When `--session-id` finds an existing session in an agent's storage partition, it retains that agent even if `session.store` uses one fixed JSON locator and the stored key is `global` or `unknown`.

A completed turn exits `0`. Error, timeout, and cancellation outcomes exit `1`, after any text or JSON result is written. A received `SIGINT` or `SIGTERM` instead preserves the signal-specific exit status described below.

Related: [Agent send tool](/tools/agent-send)

## `agent exec`

`openclaw agent exec` runs one embedded agent turn without connecting to a Gateway. It is the recommended headless entry point for CI and coding automation because it owns setup, cleanup, output projection, and process status.

```bash
openclaw agent exec "Run the focused tests and fix failures"
openclaw agent exec --message-file task.md --cwd ./repo
cat task.md | openclaw agent exec --message-file - --json
```

By default, the command creates a temporary state directory and removes it after confirmed cleanup, including accepted database work and the run's database resources. It runs against your ordinary OpenClaw config, so configured providers, credentials, and `agentRuntime` harness selection apply exactly as they do elsewhere. `--cwd` defaults to the process working directory and is passed as both the agent workspace and tool working directory.

Config is layered in three parts, entirely in memory: exec composes the run config and publishes it as this process's runtime config rather than writing a copy to disk. Exec defaults apply only where your config leaves a setting unset: workspace bootstrap files are skipped, the agent sandbox is off, the `coding` tool profile is selected, filesystem tools are restricted to `--cwd`, and exec runs under the full execution policy a headless turn needs. Anything your config sets wins over those defaults, so a configured sandbox, shell env, or tool profile is never downgraded, and exec host routing stays with the sandbox when your config enables one. The invocation itself always wins last: the run is scoped to `--cwd` and never bootstraps.

When your tool policy enables `browser`, local browser control works without a Gateway. Explicit Gateway or node routing and sandbox restrictions still apply; see [Node browser proxy](/tools/browser/remote#node-browser-proxy-zero-config-default).

Use `--state-dir <dir>` to retain sessions and other run state. The directory must already exist and is never created or deleted by the command. A retained state directory requires exclusive ownership: exec refuses to start while a Gateway or another embedded writer owns it, then holds the state lock for the complete run. Omit `--state-dir` for isolated temporary state, or stop the Gateway first with `openclaw gateway stop`.

When exec uses the ambient or a pinned config, installed plugins continue to resolve from the operator's ordinary plugin roots while sessions and other run state use the ephemeral directory. In those modes, `--state-dir` controls run state only; it is not required for configured providers, channels, or harnesses supplied by installed plugins.

For reproducible runs, pin the config instead of inheriting it. `--config <path>` runs against exactly that config file, read through the normal loader so JSON5 syntax and `$include` resolve relative to it; a missing or invalid file fails the run rather than falling back to defaults, as does an ambient config that exists but cannot be parsed. `--isolated` ignores the ambient config entirely and uses only the exec defaults above. Both are the right choice for CI, where inheriting operator state would make runs machine-dependent.

Stored credentials are used by default, so a folder-scoped run reaches the same logins as the rest of the CLI. Pass `--auth-env-only` to restrict the run to provider keys already present in the process environment. That mode loads no config at all, and pairing it with `--config` is rejected rather than silently ignored, because a config supplies provider credentials through several surfaces at once: [inline keys and secret headers](/reference/secretref-credential-surface), an `env` block, and login-shell import. It also skips OpenClaw auth profiles and external Codex, Claude, or other CLI credential stores. Provider auth variables remain available to model authentication but are omitted from agent-launched host commands.

On a clean installation without the Codex plugin, OpenAI API-key runs use the built-in OpenClaw runtime. The implicit Codex preference does not require installing a native harness before `--auth-env-only` can run. An explicitly configured Codex runtime or an existing Codex session pin still requires that harness.

Select a primary and ordered fallback chain with repeatable flags:

```bash
openclaw agent exec "Implement the change" \
  --model openai/gpt-6-astra \
  --fallback anthropic/claude-sonnet-4-6 \
  --fallback google/gemini-3.1-pro-preview
```

For this command only, explicit `--fallback` values remain active with explicit `--model`. Other agent entry points keep their existing rule that a user-selected model disables configured fallbacks.

Select the one-shot tool surface explicitly when comparing local or smaller models:

```bash
openclaw agent exec "Inspect this repository" \
  --model ollama/qwen3.5:9b \
  --code-mode code \
  --local-model-lean \
  --json
```

`--code-mode direct` disables Code Mode, `auto` uses model capability metadata, and `code` forces the generic Code Mode surface for tool-capable runs. `--local-model-lean` removes high-latency and channel-dependent tools and enables the bounded Tool Search defaults for the isolated run.

The timeout defaults to 600 seconds for `agent exec`; this does not change the existing embedded `agent --local` default. A successful run exits `0`, any model or result error exits `1`, and a timeout exits `2`. Failure includes `meta.error`, aborted runs, exhausted model fallbacks, an error stop reason, and any error payload.

If cleanup fails after a run error or timeout, the original result and exit code are preserved and the cleanup failure is reported on stderr. A cleanup failure after a successful run exits `1`.

Uncertain runtime cleanup preserves temporary state for inspection and keeps any
acquired state lock until this process exits. Inspect the reported cleanup failure
before retrying a run against retained state.

Plain output writes only the final assistant text to stdout. Diagnostics use stderr. `--json` reserves stdout for this stable envelope:

```json
{
  "ok": true,
  "status": "ok",
  "final": "The focused tests pass.",
  "payloads": [{ "text": "The focused tests pass." }],
  "usage": { "input": 120, "output": 8, "total": 128 },
  "costUsd": 0.0021,
  "codeModeEngaged": false,
  "assistantTurns": 2,
  "bridgeCalls": { "search": 1, "describe": 0, "call": 3 },
  "toolSummary": { "calls": 2, "tools": ["read", "write"], "totalToolTimeMs": 48 },
  "model": "gpt-6-astra",
  "provider": "openai",
  "sessionId": "019..."
}
```

`status` is `ok`, `error`, or `timeout`. `usage` is omitted when unavailable. Failed envelopes add `error: { message, kind }`; `model` and `provider` are `null` when failure happens before model selection.

Run-stat fields are additive and may be absent:

- `costUsd`: sum of recorded per-call USD costs, preserving request pricing tiers and retry-model prices, including cache reads/writes. When per-call costs are incomplete, only flat-price estimates are available; tiered estimates are omitted rather than pricing combined usage as one request. Omitted when cost is unavailable.
- `codeModeEngaged`: `true` only when [code mode](/tools/code-mode) actually owned the model tool surface for the run. `tools.codeMode.enabled=true` alone does not guarantee engagement, and harnesses that own their native tool surface always read `false` because OpenClaw code mode never owns their tools.
- `assistantTurns`: completed assistant/provider round trips in the run; omitted when none completed.
- `bridgeCalls`: inner tool-search/code-mode bridge call counts (`search`/`describe`/`call`). These are invisible to the provider; outer tool calls stay in `meta.toolSummary.calls` of the full run metadata.
- `toolSummary`: outer model-visible tool-call count, tool names, failures, and total tool time from the embedded run.

The agent run-stat fields appear on `meta.agentMeta` in the `openclaw agent --json` response; the outer tool summary remains at `meta.toolSummary`.

### Code Mode model matrix

From a source checkout, run the bounded evaluation matrix against any explicit model reference:

```bash
pnpm qa:code-mode-models -- --model ollama/qwen3.5:9b
```

Repeat `--model` to compare models, or use `--mode`, `--task`, and `--repetitions` to narrow the selection. Basic and file-workflow tasks run through isolated `agent exec` invocations; Gateway tasks below use a disposable Gateway and explicitly select the OpenClaw agent runtime. Each cell records model/provider identity, timing, result status, failure class, tool activity, and task-specific correctness checks.

The default remains two tasks (`read` and `dependent-read-write`), three modes, and three repetitions: 18 cells per model. Extended tasks are opt-in, so the default model-call budget does not grow:

| Task                         | Workload and correctness oracle                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`                       | Read the verification code and return it exactly.                                                                                                                                                        |
| `dependent-read-write`       | Read, write, and read back the code; verify the final answer and output file.                                                                                                                            |
| `large-result-reduction`     | Filter 512 orders from a bounded JSONL file larger than 64 KiB using a separate rules file, then compute count and integer total. Requires handling read pagination rather than echoing the large input. |
| `parallel-independent-reads` | Read three independent files, requesting parallel calls where supported, and compose their values in specified order rather than completion order.                                                       |
| `dependent-chain`            | Follow two file-path references from `start.json` to a payload, awaiting each dependency before selecting the next path.                                                                                 |

The three file-workflow tasks above require an exact final answer and matching `result.txt`. Inputs are deterministic and identical across models/modes for a given repetition. The prompts request file tools and readback, but the oracle verifies outcomes and aggregate tool execution, not a full call trace: it cannot prove pagination strategy, actual concurrency, dependency ordering, or readback. Those require separate runtime/trajectory proof.

Preview a six-cell direct/Code Mode comparison without building or calling any model:

```bash
pnpm qa:code-mode-models -- --model ollama/qwen3.5:9b \
  --mode direct --mode code --repetitions 1 \
  --task large-result-reduction --task parallel-independent-reads \
  --task dependent-chain --dry-run
```

Remove `--dry-run` only for an explicitly intended model run; provider charges may apply. A dry run writes the plan and empty canonical evidence, not passing task results. Offline harness coverage runs with `pnpm test extensions/qa-lab/src/code-mode-model-matrix.test.ts` and uses a synthetic CLI with no provider calls; it is not live Code Mode performance evidence.

The output directory contains canonical QA Lab `qa-evidence.json`. `summary.json` and `results.jsonl` are supporting aggregate and per-cell artifacts; `manifest.json` records the requested matrix and source identity.

Each summary group retains pass rate, first-pass/eventual success, failure categories, and `p50WallMs`. Its additive `metrics` object summarizes assistant turns, outer tool calls, bridge search/describe/tool calls, and reported USD cost as `{ samples, total, p50 }`. Only present envelope values count as samples; missing telemetry is not zero (`total` and `p50` are null with no samples). Observed zeros remain zeros. Medians use the upper middle sample for even counts, matching the existing wall-time summary. All repetitions, including failed ones with telemetry, contribute.

For cells that return an agent envelope, `elapsedMs` measures the agent process and effect verification after fixture preparation. Harness-error cells instead time the attempted cell, including any setup before the exception. Neither includes the matrix build, and neither is guest-only execution time. The harness does not report unobservable phase timings, overlap, reduction ratios, or inferred speedups. Compare correctness before timing/counts, inspect missing-sample counts, and retain raw per-cell `usage`/`costUsd`/`bridgeCalls` when supplied.

This is evaluation-only evidence, not a CI or release gate. Results do not change model capabilities, runtime routing, fallback, or repair policy.

#### Paired performance workloads

These opt-in workloads compare Code Mode with normal OpenClaw tool exposure.
`--mode direct` explicitly disables Code Mode and retains normal Tool Search;
`--mode code` enables it. Both arms use the same prompt, seeded inputs, allowed
tools, model, and thinking setting. They reject `--mode auto`, pin the OpenClaw
runtime, disable fast mode, and skip follow-up interviews. OpenAI models use
OpenClaw here, rather than their native agent harness.

Performance selections require both treatment arms and cannot be mixed with
code-only interview tasks. Built artifacts are rehashed after each wave; drift
stops admission and withholds the comparison while preserving observations.

| Task                        | Workload and checks                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repo-invoice-repair`       | Repair decimal parsing and invoice aggregation, add regression coverage, run tests, and generate a summary. Held-out CLI inputs verify the submitted source. |
| `invoice-reconciliation`    | Traverse invoice pages and write exact JSON and CSV deliverables under a supplied reconciliation policy.                                                     |
| `batch-settlement-recovery` | Handle transient and uncertain settlement outcomes; verify exactly-once effects and the final report.                                                        |
| `fanout-dependency`         | Coordinate seven real collector children with a three-child running limit, dependent reconciliation/audit stages, and an unavailable source.                 |

Preview eight cells against a clean, already-built runtime:

```bash
pnpm qa:code-mode-models -- --model openai/gpt-5.6-sol \
  --mode direct --mode code --executor node --repetitions 1 \
  --task repo-invoice-repair --task invoice-reconciliation \
  --task batch-settlement-recovery --task fanout-dependency \
  --thinking low --timeout 600 --concurrency 2 \
  --max-cells 8 --max-tokens 1000000 \
  --max-known-cost-usd 25 --max-wall-seconds 3600 \
  --runtime-dir ../frozen-runtime \
  --output-dir artifacts/code-mode/paired-preview --dry-run
```

The frozen-runtime requirements below apply. Use a fresh output directory for a
live run. `--keep-state` retains disposable workspaces and state for inspection;
the runner also captures each workload's named deliverables with hashes.

The default schedule alternates the starting arm between pairs. `--schedule`
accepts a JSON array of `{model, task, repetition, firstMode}` entries, where
`firstMode` is `direct` or `code`. Entries must match the selected inventory and
require both modes. Keep the schedule fixed for a comparison. `--concurrency`
limits root cells, not descendants. Limits admit complete paired waves; token,
known-cost, and wall limits stop new waves while admitted work finishes. Missing
usage or prices make observed totals lower bounds, so these are not hard
spending caps. Unstarted cells remain visible in the schedule and summary.

`mode-comparison.json` pairs results by model, task, seed, source/build,
prompt/fixture fingerprints, and settings. Per-cell accounting includes parent
and descendant input, cache reads/writes, and output, reconciled with runtime
totals. Missing usage or prices remain unavailable, never zero. Failed attempts
remain in operational totals. Successful-pair deltas require both arms to pass
and complete measurements; observed error counts include intentional probes and
are not repair-turn counts. Task latency excludes startup and interviews.

Automated completion means artifact/effect checks passed. Final-response
accuracy and execution integrity need separate adjudication against retained
transcripts, commands, receipts, and files. A correct artifact can accompany
false test claims. Temporary workspaces and file-tool restrictions do not
isolate broad shell access: exclude runs that reuse sibling solutions or
benchmark answers from independent capability and efficiency comparisons.
Fanout checks prove dependency completion and enforce the concurrency limit;
they do not prove every independent launch preceded collection. Inspect the
orchestration trace and measured child concurrency for that scheduling claim.
Report correctness, missingness, and exclusions before aggregate savings; the
selected workload mix does not establish universal token, cost, or speed gains.

#### Gateway tasks and follow-up interviews

The same matrix can exercise a disposable built Gateway and then interview the
agent in a new run of the same conversation. These tasks are opt-in and require
`--mode code`. Gateway tasks support explicit Anthropic, Google, or OpenAI model
references with the corresponding provider credentials.
The default matrix above is unchanged.

| Task                      | Independent behavior check                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoices-auto-retention` | Return an oversized unfamiliar export, then calculate from its automatically retained reference in a later cell, with one fetch and bounded model-visible data. The prompt does not ask the agent to save it. |
| `inventory-join`          | Solve a natural reorder-summary request across nested, heterogeneous inventory and supplier data, including missing quantities and unavailable prices.                                                        |
| `automation-contracts`    | Use the tool declarations to compose JavaScript for a disabled job's create/read/update/history/delete flow, then verify that pre-existing jobs remain unchanged.                                             |
| `process-contracts`       | Start one supplied finite helper, use the real process tools through JavaScript guided by their declarations, and verify its output and successful exit.                                                      |
| `partial-failure`         | A synthetic tool records an effect before returning malformed declared output. Verify one dispatch, useful validation details, and a subsequent read of actual state.                                         |
| `javascript-contracts`    | Read typed tool declarations, catch and report an invalid read argument, then read, write, and read back a verification code using JavaScript.                                                                |

Build clean baseline and candidate checkouts first. Use the same harness,
models, prompts, fixtures, thinking setting, timeout, and repetitions for both:

```bash
pnpm qa:code-mode-models -- --model openai/gpt-5.6-luna --mode code \
  --task invoices-auto-retention --task inventory-join --repetitions 1 \
  --thinking low --runtime-dir ../baseline \
  --output-dir artifacts/code-mode/baseline --allow-failures

pnpm qa:code-mode-models -- --model openai/gpt-5.6-luna --mode code \
  --task invoices-auto-retention --task inventory-join --repetitions 1 \
  --thinking low --runtime-dir ../candidate \
  --output-dir artifacts/code-mode/candidate \
  --baseline-results artifacts/code-mode/baseline/results.jsonl --allow-failures
```

`--runtime-dir` uses existing build artifacts without rebuilding. It requires a
clean committed checkout and both build stamps matching that commit and recording
clean build inputs. On a revision with provenance-capable stamp writers, run
`pnpm build` in the clean checkout to refresh stale or older stamps. Historical
revisions without those writers are unsupported as frozen runtimes; rebuilding
them alone cannot add this provenance. The matrix
records source and artifact hashes and refuses a comparison when paired cells
or their workload fingerprints differ. Add `--model` for another model and
repeat task selectors to include more scenarios. Failed trials remain in the
results; `--allow-failures` changes only the command's exit status.

Each Gateway owns temporary home, state, workspace, configuration, and a free
loopback port. The process receives only its selected provider key and required
host paths. Synthetic plugin tools implement the fixture exports and mutation
receipt; automation and process operations use the real built-ins. Operator
Gateways, stored operator credentials, real channels, and real devices are not used.
Each scenario exposes only its required tools. A Gateway catalog preflight
checks fixture availability before any paid model call; missing capabilities
are harness failures, rather than failed model tasks.

Per-cell artifacts include actual task/interview transcripts, tool-effect
receipts, checks, and sanitized diagnostics. Task receipts are captured before
the interview; separate task and interview receipt files preserve that boundary
alongside the complete ledger. The process helper's exact written source bytes
are part of its workload fingerprint. The JavaScript contract task verifies
declaration discovery, runtime input validation, and the dependent file operation
sequence, including completion through `wait`. Preview-completeness checks use the observed metadata
for probed references; missing or conflicting metadata remains unknown.
Keep transcripts local unless their
publication is explicitly requested. Interview claims about sample coverage,
freshness, lifetime, limits, and retry safety must be reviewed against these
records: structured answers alone do not establish understanding. A prior
result reference is tested in the interview's new admitted run when one was
actually observed; it must not become durable conversation state.

Gateway rows separate startup, task, and interview timing. Their ordinary
`assistantTurns`, `usage`, and `costUsd` describe the task; interview measurements
are separate. Missing cost or usage remains unavailable. Summary and comparison
output also separate observed task-behavior checks from interview-consistency
checks; neither replaces manual assessment of the interview. The original
overall pass flags and comparison deltas still require complete success.
`taskBehavior.deltas` reports task-only differences when both paired task-behavior
checks pass and the requested model identities are verified, even if an interview has inconsistent flags. Missing traces or
check results remain unavailable, and all original failures are retained.
These are observations, not statistical speed guarantees.

### `agent exec` options

- `[message]`: positional prompt text
- `--message-file <path>`: read a UTF-8 prompt from a file; `-` reads stdin
- `--cwd <dir>`: set both the agent workspace and tool working directory
- `--state-dir <dir>`: use an existing state directory without deleting it
- `--config <path>`: run against this config file instead of the ambient config (JSON5 and `$include` supported)
- `--isolated`: ignore the ambient config and use only exec defaults
- `--model <provider/model>`: explicit primary model
- `--code-mode <mode>`: select `direct`, `auto`, or forced `code` tool mode
- `--local-model-lean`: use the reduced local-model tool surface
- `--thinking <level>`: one-run thinking level
- `--fallback <provider/model>`: ordered fallback model; repeatable and requires `--model`
- `--auth-env-only`: use only environment provider keys; skips stored credentials, external CLI credentials, and config entirely
- `--no-auth-env-only`: allow stored and external CLI credentials (default)
- `--timeout <seconds>`: deadline in seconds (default `600`; `0` disables it)
- `--json`: emit the stable JSON envelope

## Options

- `-m, --message <text>`: message body
- `--message-file <path>`: read the message body from a UTF-8 file
- `-t, --to <dest>`: recipient used to derive the session key
- `--session-key <key>`: explicit session key to use for routing
- `--session-id <id>`: explicit session id
- `--agent <id>`: agent id; overrides routing bindings
- `--model <id>`: model override for this run (`provider/model` or model id)
- `--thinking <level>`: agent thinking level (`off`, `minimal`, `low`, `medium`, `high`, plus provider/runtime-supported levels such as `xhigh`, `adaptive`, `max`, or `ultra`)
- `--verbose <on|off>`: persist verbose level for the session
- `--channel <channel>`: delivery channel; omit to use the main session channel
- `--reply-to <target>`: delivery target override
- `--reply-channel <channel>`: delivery channel override
- `--reply-account <id>`: delivery account override
- `--local`: run the embedded agent directly (after plugin registry preload)
- `--deliver`: send the reply back to the selected channel/target
- `--timeout <seconds>`: override this command's agent-turn deadline (default 600, or `agents.defaults.timeoutSeconds`); `0` disables the overall deadline. The 600-second fallback belongs to this CLI command, not ordinary Gateway turns, whose default is 48 hours.
- `--json`: output JSON

Gateway commands using OpenClaw's managed agent loop return their completed reply before optional memory
flushing and compaction. That work has its own session owner and uses the command's
remaining time. A new turn in the same session cancels and settles it before
starting inference. One-shot `--local` commands skip optional post-turn work;
required checkpointing and compaction still happen before inference in that loop. Generic CLI
backends retain their existing host compaction before the command returns; native
backends retain their own compaction policy. Cancellation,
restart, and session ownership changes continue to fence active writers.

## Examples

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --agent ops --message-file ./task.md
openclaw agent --agent ops --model openai/gpt-5.4 --message "Summarize logs"
openclaw agent --session-key agent:ops:incident-42 --message "Summarize status"
openclaw agent --agent ops --session-key incident-42 --message "Summarize status"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
openclaw agent --agent ops --message "Run locally" --local
```

## Notes

- Pass exactly one of `--message` or `--message-file`. `--message-file` strips a leading UTF-8 BOM and preserves multiline content; it rejects files that are not valid UTF-8. Files larger than 4 MiB are rejected before dispatch.
- `--message` does not run the channel slash-command dispatcher. Recognized `$skill-name` references and leading `/skill-name [input]` are the scoped exception: OpenClaw expands them into model instructions to read the skill before acting. Other slash-prefixed messages keep normal agent-turn behavior; `/compact` is rejected with a pointer to `openclaw sessions compact <key>`.
- `--local` runs are one-shot: bundled MCP loopback resources and warm Claude stdio sessions opened for the run are retired after the reply, so scripted invocations do not leave local child processes running. Gateway-backed runs keep Gateway-owned MCP loopback resources under the running Gateway process instead.
- `--local` requires exclusive ownership of the configured state directory. It refuses to start while a Gateway or another `agent --local` run owns that directory, then holds the same state lock for the full embedded turn. Run without `--local` to use the active Gateway, or stop it first with `openclaw gateway stop`.
- Standalone embedded execution with `--local` refuses to reuse an existing main session while restart recovery is pending. Run the turn through a healthy Gateway, or reset it there with `/new` or `/reset`; an independent embedded process cannot safely coordinate that recovery owner with the Gateway scanner.
- With `--agent`, `--channel` and `--to` together, session routing follows the channel's canonical recipient and `session.dmScope`. Channels with a stable outbound-only recipient identity use a provider-owned session isolated from the agent's main session. `--reply-channel` and `--reply-account` affect delivery only.
- `--session-key` selects an explicit session key. Agent-prefixed keys must use `agent:<agent-id>:<session-key>`, and `--agent` must match the key's agent id when both are given. Bare non-sentinel keys scope to `--agent` when supplied, or to the configured default agent otherwise; for example `--agent ops --session-key incident-42` routes to `agent:ops:incident-42`. The literal keys `global` and `unknown` stay unscoped only when no `--agent` is supplied.
- `--json` reserves stdout for the JSON response; Gateway, plugin, and `--local` diagnostics go to stderr so scripts can parse stdout directly.
- After transient handshake retries are exhausted, a Gateway timeout or closed connection fails the command; the CLI never silently reruns the turn embedded. Transport loss is ambiguous — the Gateway may have accepted and may still finish the turn — so the stderr hint says to check `openclaw gateway status` and the session transcript before retrying or rerunning with `--local`, to avoid executing the turn twice. When the Gateway accepted the run before the transport error, the hint names the accepted run ID, and `--json` failures keep the canonical `ok: false` envelope with `runId` and `origin: "gateway"` fields alongside `error.type`/`error.message`.
- `SIGTERM`/`SIGINT` interrupt a waiting Gateway-backed request; if the Gateway already accepted the run, the CLI also sends `chat.abort` for that run id before exiting. `--local` runs receive the same signal but do not send `chat.abort`. On Unix, startup wrappers preserve the runtime child's actual termination signal, including `SIGKILL` after shutdown escalation; shells report `SIGINT` and `SIGTERM` as statuses 130 and 143. Explicit numeric returns stay numeric, including a handled shutdown returning `0`. Windows retains its numeric termination behavior. If the internal run-dedup key already has an active run for this session, the response reports `status: "in_flight"` and the non-JSON CLI prints a stderr diagnostic instead of an empty reply. For external cron/systemd wrappers, keep a hard-kill backstop such as `timeout -k 60 600 openclaw agent ...` so the supervisor can reap the process if shutdown cannot drain.
- When this command triggers `models.json` regeneration, SecretRef-managed provider credentials are persisted as non-secret markers (for example env var names, `secretref-env:ENV_VAR_NAME`, or `secretref-managed`), never resolved secret plaintext. Marker writes come from the active source config snapshot, not from resolved runtime secret values.

## JSON failures

Failures keep the [CLI error envelope](/cli#json-failures): `ok: false` and
`error.type: "cli_error"`. When the Gateway returned a run ID, the envelope also
includes top-level `runId` and `origin: "gateway"`. This includes cached final
errors without a fresh acceptance response, and a timeout or lost connection
after acceptance.

`origin` identifies the run's Gateway ownership; it does not prove the run failed
or stopped. After transport loss, check the session transcript before retrying.
Omitted provenance means the CLI observed no Gateway run identity, not that no
run happened. Local errors and rejections without a Gateway run ID omit these
fields. A locally generated idempotency key alone is not Gateway provenance.

## JSON delivery status

With `--json --deliver`, the CLI JSON response includes top-level `deliveryStatus` so scripts can distinguish delivered, suppressed, partial, and failed sends:

```json
{
  "payloads": [{ "text": "Report ready", "mediaUrl": null }],
  "meta": { "durationMs": 1200 },
  "deliveryStatus": {
    "requested": true,
    "attempted": true,
    "status": "sent",
    "succeeded": true,
    "resultCount": 1
  }
}
```

Gateway-backed CLI responses also preserve the raw Gateway result shape at `result.deliveryStatus`.

`deliveryStatus.status` is one of:

| Status           | Meaning                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sent`           | Delivery completed.                                                                                                                        |
| `suppressed`     | Delivery was intentionally not sent (for example a message-sending hook cancelled it, or there was no visible result). Terminal, no retry. |
| `partial_failed` | At least one payload sent before a later payload failed.                                                                                   |
| `failed`         | No durable send completed, or delivery preflight failed.                                                                                   |

Common fields:

- `requested`: always `true` when the object is present.
- `attempted`: `true` once the durable send path ran; `false` for preflight failures or no visible payloads.
- `succeeded`: `true`, `false`, or `"partial"`; `"partial"` pairs with `status: "partial_failed"`.
- `reason`: lowercase snake-case reason from durable delivery or preflight validation. Known values include `cancelled_by_message_sending_hook`, `no_visible_payload`, `no_visible_result`, `channel_resolved_to_internal`, `unknown_channel`, `invalid_delivery_target`, and `no_delivery_target`; failed durable sends may also report the failed stage. Treat unknown values as opaque since the set can expand.
- `resultCount`: number of channel send results, when available.
- `sentBeforeError`: `true` when a partial failure sent at least one payload before erroring.
- `error`: `true` for failed or partial-failed sends.
- `errorMessage`: present only when an underlying delivery error message was captured. Preflight failures carry `error`/`reason` but no `errorMessage`.
- `payloadOutcomes`: optional per-payload results with `index`, `status`, `reason`, `resultCount`, `error`, `stage`, `sentBeforeError`, or hook metadata when available.

## Related

- [CLI reference](/cli)
- [Agent runtime](/concepts/agent)

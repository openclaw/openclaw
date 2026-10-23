---
summary: "Code Mode error codes, telemetry fields, and the debug environment variables"
title: "Code Mode troubleshooting"
read_when:
  - A Code Mode run failed and you need the error code meaning
  - You are reading Code Mode telemetry or trajectory output
  - You need the debug environment variables for a Code Mode session
---

## Error codes

```typescript
type CodeModeErrorCode =
  | "invalid_input"
  | "runtime_unavailable"
  | "aborted"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";
```

`invalid_input` covers bad `exec`/`wait` arguments, including retired `language`
and `typecheck` fields, rejected module access, JavaScript syntax errors, unknown/expired/
wrong-scope `runId` values, and too many suspended runs. It also covers an
uncaught nested tool call that the host rejected as invalid input (an
`input_contract` schema mismatch or a tool's own input error); the error names
the missing or unexpected arguments. Other uncaught tool failures report
`internal_error`. Codes the guest assigns to `error.code` never change the
terminal code. `runtime_unavailable`
covers an unavailable executor or a worker that fails to start or exits
unexpectedly. Check the selected `tools.codeMode.executor` and its plugin
availability; the `quickjs` executor requires the bundled `code-mode-quickjs`
runtime. Explicit selection activates that bundle despite generic plugin disable
or allowlist settings, but an explicit deny or disabled entry still blocks it.
OpenClaw does not switch executors automatically.
`aborted` means the caller cancelled an active `exec` or `wait`; OpenClaw
terminates the worker or drops the suspended run, so that `runId` cannot be
resumed. It is distinct from `timeout`, which means an execution deadline was
exceeded.
`output_limit_exceeded` is reserved for a result that cannot be serialized into
the bounded projection; ordinary oversized successful results are truncated and
remain successful.

JavaScript syntax errors are rejected during source preparation, before any
nested tool dispatch. The bounded diagnostic includes a one-based source line
and column. Malformed JavaScript reports its syntax error before module-access
checks. Correct the source and submit a new `exec`; OpenClaw does not repair
or replay it automatically. This no-dispatch outcome does not enable
`restartSafe` or change the result's `replaySafe` flag. Exceptions thrown by valid
guest code, including `SyntaxError`, remain runtime failures.

The current parser has a known limitation with division immediately after an
optional keyword-named property, such as `value?.return / 2 / 3`. This is valid
JavaScript, but source preparation rejects it before tool dispatch. Parenthesize
the property access: `(value?.return) / 2 / 3`.

Errors returned to the guest are plain data; host `Error` instances, stack
objects and prototypes are not passed through the JSON result bridge. This
bridge contract does not make the Node executor a security boundary; see
[Code Mode executors](/tools/code-mode/executors).

`failurePhase` identifies where the terminal error originated. An uncaught
rejected tool call reports `"bridge"`; a new JavaScript error after a successful
call or a caught tool rejection reports `"guest"`. Rethrowing the original tool
error keeps `"bridge"`, including after `wait`. Bridge failure origin and code
come only from host replies. Guest code cannot settle its own pending tool calls
or forge bridge provenance.

Failure origin is separate from replay safety. When `bridgeDispatchStarted` is
`true` and `replaySafe` is `false`, check the destination before repeating a send
or another action that changes state—even for a guest error. A failed `exec`
does not by itself prove that a message was not delivered.

## Telemetry

Each result's `telemetry` field reports: hidden catalog size and a source
breakdown (`openclaw`/`mcp`/`client` counts), cumulative search/describe/call
counts for the run's catalog, and the code-mode control tool names (`exec` and
`wait`).
The `counterScope` identifies one counter lifetime, changing when a catalog is
replaced or restored but remaining stable when tools are appended or prompt
policy narrows that catalog.

Catalog teardown retains only these final aggregate diagnostics, not executable
tools or VM state. If teardown closes a suspended run while `wait` is observing
pending work, that wait returns `failed` with `code: "aborted"` and the final
telemetry; pending calls are canceled and the continuation is released. Retained
diagnostics grant no authority to resume or repair the closed run.

The run metadata (`meta.agentMeta` in `openclaw agent --json`, mirrored on the
`agent exec --json` envelope) adds per-run stats:

- `codeModeEngaged`: `true` only when code mode actually owned the model tool
  surface. This is the reliable engagement signal — do not infer engagement
  from config or tool names: the shell tool is also named `exec`, and the
  `"auto"` tier engages per model capability. Harnesses that bridge OpenClaw's
  tool surface (Copilot) report their resolved gate, so
  `codeModeEngaged: false` with `tools.codeMode.enabled=true` makes a silent
  no-op observable. Harnesses that run their own native tool surface (Codex)
  never engage OpenClaw code mode, so they always read `false`; an attempt that
  reports nothing is normalized to `false` for the same reason. Codex's own
  `codeModeOnly` is a separate native feature that this field does not track.
- `assistantTurns`: completed assistant/provider round trips across the run.
- `bridgeCalls`: the run's cumulative inner bridge counts
  (`{ search, describe, call }`). These are not provider requests. The embedded
  runtime's `meta.toolSummary.calls` includes outer and nested tool terminals,
  so bridge counts can overlap it and must not be added to it.
- `costUsd`: estimated USD cost from the run's accumulated usage and the
  model's cost config (cache read/write tiers included); omitted when the
  model has no cost data.

Telemetry must not include secrets, raw environment values, or unredacted
tool inputs beyond existing OpenClaw trajectory policy.

## Debugging

Guest exceptions, rejected input, and admitted guest deadlines are logged at
warning level under `agents/code-mode`. Worker startup/crash failures, bridge
infrastructure failures, and output-contract violations remain errors. A bridge
rejection is logged once at its host boundary, including when the guest catches
it; an uncaught rejection does not add a second projected error record.
The server record preserves the original
error class, message, and stack head before guest projection and output limits.
It includes session, agent-run, Code Mode run, outer tool-call, bridge-request,
and executor worker identifiers when available. No debug flag is required. File
logs retain the raw diagnostic; log exports apply their normal redaction.

Missing or ambiguous edit anchors are input errors. Correct the patch or edit
after inspecting the current file. Code Mode never automatically retries failed
guest code or nested tool calls; earlier actions in the cell may have completed.

Node worker heap exhaustion reports `runtime_unavailable` with the configured
heap allowance and guidance to paginate results or retain less guest data.
Check completed actions before retrying: worker termination does not undo
dispatched tools. Worker lifecycle retirement reason `crash` records native
worker errors, including heap exhaustion; `gc-thrash` identifies retirement by
the near-limit GC watchdog. Both are separate from an ordinary tool rejection
reported with `failurePhase: "bridge"`.

JavaScript failure frames labeled `openclaw-code-mode:user.js` use line numbers
from the submitted JavaScript, excluding internal wrappers and headless setup,
including after `wait`. Internal wrapper and controller frames are
omitted from new cells' failures; error messages still share the existing output
budget. Code Mode does not accept TypeScript source or produce compiler diagnostics.

Use targeted model transport logging when code mode behaves differently from
a normal tool run:

```bash
OPENCLAW_DEBUG_CODE_MODE=1 \
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 \
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools \
OPENCLAW_DEBUG_SSE=events \
openclaw gateway
```

For payload-shape debugging, use `OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted`.
This logs request shape and the complete tool-name list, without prompt,
message, or tool content.

For stream debugging, use `OPENCLAW_DEBUG_SSE=events` or `peek` for timing
diagnostics without SSE event bodies. Code mode also rejects the final provider
payload if it does not contain exactly one `exec`, one `wait`, and only approved
direct-only tools after the code-mode surface has activated.

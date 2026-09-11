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

`invalid_input` covers bad `exec`/`wait` arguments, disabled languages,
rejected module access, TypeScript transform failures, unknown/expired/
wrong-scope `runId` values, and too many suspended runs. `runtime_unavailable`
covers a QuickJS worker that fails to start or exits non-zero.
`aborted` means the caller cancelled an active `exec` or `wait`; OpenClaw
terminates the worker or drops the suspended run, so that `runId` cannot be
resumed. It is distinct from `timeout`, which means an execution deadline was
exceeded.
`output_limit_exceeded` is reserved for a result that cannot be serialized into
the bounded projection; ordinary oversized successful results are truncated and
remain successful.

Errors returned to the guest are plain data; host `Error` instances, stack
objects, prototypes, and host functions do not cross into QuickJS.

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
telemetry; pending calls are canceled and the snapshot is dropped. Retained
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
  (`{ search, describe, call }`). These calls never reach the provider;
  provider-visible outer tool calls remain in `meta.toolSummary.calls`.
- `costUsd`: estimated USD cost from the run's accumulated usage and the
  model's cost config (cache read/write tiers included); omitted when the
  model has no cost data.

Telemetry must not include secrets, raw environment values, or unredacted
tool inputs beyond existing OpenClaw trajectory policy.

## Debugging

JavaScript failure frames labeled `openclaw-code-mode:user.js` use line numbers
from the submitted code, excluding internal wrappers and headless setup. For
TypeScript, compiler diagnostics and source-mapped runtime frames labeled
`openclaw-code-mode:user.ts` refer to the submitted TypeScript, including after
`wait`. Source maps account for erased declarations and UTF-8 guest columns.
An unmapped runtime frame retains the explicit `openclaw-code-mode:generated.js`
label rather than pretending to identify original source. Internal wrapper and controller frames are
omitted from new cells' failures; error messages still share the existing output
budget. Resumed older snapshots without location metadata retain their previous
stack format.

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
This logs a capped, redacted JSON snapshot of the model request; use it only
while debugging, since prompts and message text can still appear.

For stream debugging, use `OPENCLAW_DEBUG_SSE=peek` to log the first five
redacted SSE events. Code mode also fails closed if the final provider
payload does not contain exactly one `exec`, one `wait`, and only approved
direct-only tools after the code-mode surface has activated.

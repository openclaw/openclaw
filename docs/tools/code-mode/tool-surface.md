---
summary: "The model-visible exec and wait contracts, the hidden tool catalog, and name collisions"
title: "Code Mode tool surface"
doc-schema-version: 1
read_when:
  - You are reviewing the compact tool contract the model sees
  - You need the exec or wait input and result shapes
  - You need catalog ordering, Tool Search interaction, or collision rules
---

## Model-visible tools

When code mode is active, the model sees `exec`, `wait`, and any required
direct-only tool. Every other enabled tool is hidden from the model-facing
tool list and registered in the code-mode catalog.

Use `exec` for tool orchestration, data joining, loops, parallel nested calls,
and structured transforms. Use `wait` only when `exec` returns a resumable
`waiting` result.

## `exec`

`exec` starts a code-mode cell and returns one result. Input code is model
generated and must be treated as hostile.

Model-facing input:

```typescript
type CodeModeExecInput = {
  title: string;
  code: string;
  restartSafe?: boolean;
};
```

Rules:

- Every new cell requires a nonblank `title` of at most 120 characters. Use a
  short purpose, usually 3–7 words, such as "Inspect the dependency graph".
  Describe intended work without claiming success or including secrets. The
  Control UI displays this title on the execution row. Nested tools retain their
  own summaries; `wait` needs no title and resumes activity under the original cell.
- `code` is the required model-facing JavaScript field and must be non-empty.
- `command` is accepted as an exec-compatible alias for hook policies and
  trusted rewrites (the normal OpenClaw shell exec tool also uses a `command`
  field). Blank caller aliases are treated as absent; a hook or trusted policy
  that invalidates one populated alias (blank or non-string) invalidates both so
  execution fails closed. When both aliases are non-empty, their values must match.
- Write plain JavaScript. TypeScript annotations, interfaces, and other
  TypeScript-only syntax are not accepted. Tool signatures and `API.read`
  declarations remain available as documentation for composing calls.
- The retired `language` and `typecheck` fields are rejected with `invalid_input`.
  Tool arguments are validated when each call reaches its normal execution owner;
  Code Mode does not typecheck the whole program before execution.
- Do not set `restartSafe` on a new `exec`. Set it to `true` only when OpenClaw
  explicitly requests replay after a gateway restart, and never for `write`,
  `edit`, `exec`, or any mutation. Every catalog call must be explicitly
  replay-safe. OpenClaw rejects unmarked catalog tools and namespace
  surfaces that are not proven replay-safe. A generic exec surface is not
  replay-safe merely because one command appears read-only; use audited read,
  grep, or find tools.
  Suspended results are marked replay-safe so
  [restart recovery](/gateway/restart-recovery) can reconstruct an interrupted
  turn from its transcript instead of restoring the process-local continuation.
  Recovery remains limited to audited read-only core tools and explicitly
  replay-safe plugin tools. Leave the field omitted for ordinary calls.
- `exec` rejects `import`, `require`, dynamic import, and module-loader
  patterns.
- `exec` never exposes the normal shell `exec` implementation recursively.
- Outer code-mode `exec` hook events carry `toolKind: "code_mode_exec"` and
  `toolInputKind: "javascript"`, so policies can
  distinguish code-mode cells from shell-style `exec` calls that share the
  same tool name.

Result:

```typescript
type CodeModeResult = CodeModeCompletedResult | CodeModeWaitingResult | CodeModeFailedResult;

type CodeModeCompletedResult = {
  status: "completed";
  value: unknown;
  output?: CodeModeOutput[];
  telemetry: CodeModeTelemetry;
};

type CodeModeWaitingResult = {
  status: "waiting";
  runId: string;
  reason: "pending_tools" | "yield";
  pendingToolCalls?: CodeModePendingToolCall[];
  output?: CodeModeOutput[];
  telemetry: CodeModeTelemetry;
};

type CodeModeFailedResult = {
  status: "failed";
  error: string;
  code?: CodeModeErrorCode;
  output?: CodeModeOutput[];
  telemetry: CodeModeTelemetry;
};
```

`exec` returns `waiting` when the guest suspends with resumable state that still
needs a model-visible continuation — an explicit `yield_control(...)`, or a
bridge tool call that has not resolved within the exec deadline. The result
includes a `runId` for `wait`. Native-channel exec approvals are different:
while the operator decision is pending, OpenClaw suspends both the Code Mode
execution budget and the owning agent-run budget. The original `exec` remains
in flight, then resumes with exactly its unused budget after approval resolves;
it does not return `pending_tools` or require model polling through `wait`.
If the guest explicitly yields while a sibling call awaits approval, the cell
keeps observing that approval while parked. Its next `wait` pauses for the
pending decision too. Each call receives only its own unused execution budget;
parked time and earlier calls' approval pauses do not add execution credit.
Cancellation, owner checks, and continuation expiry remain unchanged.
Bridge requests — `catalog.search`, handle `describe()`, callable tool handles,
and namespace calls including MCP — are auto-drained inside the same
`exec`/`wait` call while they resolve within the deadline, so a compact code
block that awaits several tools runs to completion in one model turn instead of
forcing one model tool call per await.

`exec` returns `completed` only when the guest VM has no pending work and the
final value is JSON-compatible after OpenClaw's output adapter runs.

New `exec` and `wait` result text uses compact JSON to leave more of the context
budget for tool data. Status, continuation, replay safety, telemetry, and
structured `details` fields are preserved. Text inside JSON strings keeps its
original whitespace. The TUI displays these results as literal text so Markdown
syntax and long-token formatting cannot change their values. URLs remain visible
as text rather than becoming Markdown links.

### Source in session history

In the built-in OpenClaw runtime, the JSON Code Mode tool executes the original
input. Session history preserves computations such as `const API_TOKEN = computeToken();`
and boolean or null initializers in the outer call's JavaScript
`code` and `command` fields, while masking credential literals, recognizable
tokens, registered secrets, and configured redaction patterns. Credential
assignments use full masks so repeated storage redaction stays stable.

This treatment does not extend to shell commands, nested tool calls, unrelated
argument strings, or assistant prose. Large or unrecognized source syntax
remains subject to diagnostic masking. Stored source is a redacted record, not
a place to recover credentials; no additional setting is required.
This applies to new calls; already-redacted source cannot be reconstructed.
The Copilot runtime's separate transcript journal does not yet preserve this
source structure. Native Codex uses a separate freeform source path; this
behavior does not describe its storage.

## `wait`

`wait` continues a suspended code-mode VM.

Input:

```typescript
type CodeModeWaitInput = {
  runId: string;
};
```

Output is the same `CodeModeResult` union returned by `exec`.

`wait` exists because nested OpenClaw tools can be slow, interactive, or stream
partial updates; the model should not need to keep one long `exec` call open
while the host waits for ordinary external work. Native-channel exec approvals
are the exception: they stay inside the original `exec` so approval authority
remains bound to the admitted run.

Fast inline host exchanges retain the same execution context. Explicit yield or
an exhausted call budget can suspend it without replaying tools. Node retains a
live worker context; QuickJS snapshots its VM and can release the worker.
QuickJS worker-pool pressure can also park a cell internally within the same
call. Actual QuickJS checkpoints enforce `maxSnapshotBytes`, so a large live
heap may complete inline but fail when it must genuinely park.

Both executors use the same `wait` contract:

1. `exec` evaluates code until completion, failure, or suspension.
2. On suspension, the selected executor retains its continuation and OpenClaw
   records pending host work.
3. When pending work settles, `wait` resumes the same executor. Node continues
   its live context; QuickJS restores its snapshot and re-registers callbacks.
4. OpenClaw delivers nested tool results and lets JavaScript continuations run.
5. `wait` returns `completed`, `failed`, or another `waiting` result.

Continuations are runtime state, not user artifacts: their ownership lives only
in an in-process map (no database or disk write), they expire, and they are
scoped to the run and session that created them. QuickJS snapshots are
size-limited; Node retains live worker memory instead. See
[Code Mode executors](/tools/code-mode/executors#understand-waits-and-limits).
One cell owner spans initial execution, suspension, and every resume. Canceling
the owning run or current tool call, or closing its tool catalog at attempt
teardown, cancels active workers and pending host work and releases parked
continuations, even if no `wait` call follows. Catalog description refreshes and
client tool additions do not close the owner. An external operation that ignores
cancellation may still finish, but cannot resume the closed guest, emit later
guest output, or start another guest tool call.

The process-wide limit of 64 slots applies to suspended cells and their reserved
resume slots. A resume keeps its slot until it completes or parks again; an
initial execution reserves a slot before dispatching host work and retains it
through live execution and internal parking. A cell with no host work does not
consume a slot.

Snapshot TTL measures idle time while a cell is parked. An admitted `wait` keeps
the cell alive under its call deadline while pending tools settle. If that call
returns `waiting` again, parking starts a fresh snapshot TTL.

`wait` fails (as a `failed` result) when:

- `runId` is unknown or its continuation already expired.
- the caller is not in the same run/session scope as the suspended run.
- a `wait` is already in flight for that `runId`.
- the selected executor cannot resume (for example, its worker exited or QuickJS restore fails).
- a QuickJS checkpoint would exceed `maxSnapshotBytes`. Ordinary oversized successful output is truncated and remains successful.

## Tool catalog

The hidden catalog includes tools after effective policy filtering, in this
order: OpenClaw core tools, bundled plugin tools, external plugin tools, MCP
tools, then client-provided tools for the current run.

Catalog ids remain opaque host-only routing identities. They are stable within
one run and deterministic across equivalent tool sets when possible, but they
are never included in the prompt, guest metadata, handle descriptions, or
errors. Policy, approvals, telemetry, replay safety, and namespace dispatch
continue to use them internally.

Before the worker starts, OpenClaw projects one effective winner per exact tool
name and computes its final guest callable name. This matches direct-mode
precedence: later client tools win an exact-name shadow, while plugin conflict
enforcement remains unchanged. The finalized projection is carried through
bridge calls and continuation resume; consumers do not reconstruct it from the
catalog.

The catalog omits code-mode control tools (`exec`, `wait`, `tool_search_code`,
`tool_search`, `tool_describe`, `tool_call`) and direct-only tools. Controls
must not recurse through the catalog; direct-only tools remain model-visible
because their structured results cannot cross the JSON guest bridge.

MCP entries stay in the run-scoped catalog so policy, approvals, hooks,
telemetry, transcript projection, and exact tool ids remain shared with
normal tool execution. `catalog.search(...)` searches native and MCP capabilities
together and returns callable handles. MCP matches identify their final
`MCP.<server>.<tool>` path and declaration file; invoking a handle uses that
same namespace dispatcher. `catalog.all()` lists only native and client handles.
Remote descriptions and schemas stay out of the trusted quick index.

## Tool Search interaction

Code mode supersedes the OpenClaw Tool Search model surface for runs where it
is active.

When Code Mode engages through forced `true` or `"auto"` activation:

- OpenClaw does not expose `tool_search_code`, `tool_search`, `tool_describe`,
  or `tool_call` as model-visible tools.
- The same cataloging idea moves inside the guest runtime.
- The guest runtime receives bare async globals plus callable search/describe
  handles for native tools, plus on-demand MCP search handles.
- MCP calls use the generated `MCP` namespace, directly or through a search
  handle; handle `describe()` requests the exact `$api()` header and schema.
- Nested calls dispatch through the same OpenClaw executor path that Tool
  Search uses.

See [Tool Search](/tools/tool-search) for the OpenClaw compact catalog bridge
that code mode supersedes for active runs.

## Tool names and collisions

The model-visible `exec` tool is the code-mode tool. If the normal OpenClaw
shell `exec` tool is enabled, it is hidden from the model and cataloged like
any other tool.

Inside the guest runtime:

- An exact JavaScript-safe tool name stays exact: `web_search(...)` and
  `sessions_spawn(...)`.
- Invalid identifier characters become `_`; a still-invalid first character
  gets the `tool_` prefix. For example, `llm-task` becomes `llm_task` when that
  name is free.
- JavaScript reserved words, specialized globals, and normalized collisions
  receive a deterministic short suffix derived from the host-only identity.
- Exact safe names win their unsuffixed spelling. A raw tool never overwrites
  `catalog`, `MCP`, `API`, `nodes`, `skills`, `namespaces`, output/timer helpers,
  or optional Swarm globals.
- The normal shell `exec` tool is callable as the `exec(...)` guest global when
  policy allows it. The code-mode control `exec` is not recursively available
  inside the guest.

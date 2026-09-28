---
summary: "Code Mode scope, nested tool execution, executor continuations, and security boundaries"
title: "Code Mode internals"
doc-schema-version: 1
read_when:
  - You need the runtime status, scope, or vocabulary
  - You are reviewing the executor boundary, typed tool discovery, or continuation lifecycle
  - You are validating the security boundary for a high-risk deployment
---

## Runtime status

| Aspect              | Value                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Executors           | Node (`node:vm`, default), QuickJS-WASI (bundled plugin)                                    |
| Default state       | disabled                                                                                    |
| Stability           | experimental OpenClaw surface (Codex Code Mode is a separate, stable Codex harness surface) |
| Target surface      | generic OpenClaw agent runs                                                                 |
| Security posture    | Node is trusted host execution; QuickJS provides hardened guest isolation                   |
| User-facing promise | enabling code mode never silently falls back to broad direct tool exposure                  |

## Scope

Code mode owns the model-facing orchestration shape for a prepared run. It
does not own model selection, channel behavior, auth, tool policy, or tool
implementations.

In scope: model-visible control/direct tool definitions, hidden tool catalog
construction, executor selection, host callbacks for search/describe/call, resumable state for
suspended guest programs, output/timeout/memory/pending-call/snapshot limits,
and telemetry/trajectory projection for nested tool calls.

Out of scope: provider-native remote code execution, shell execution
semantics, changing existing tool authorization, persistent user-authored
scripts, package manager/file/network/module access in guest code, and direct
reuse of Codex Code Mode internals.

Provider-owned tools such as remote Python sandboxes are separate tools. See
[Code execution](/tools/code-execution).

## Terms

- **Code mode**: the OpenClaw runtime mode that hides catalog-compatible model
  tools and exposes `exec`, `wait`, plus required direct-only tools.
- **Executor**: the implementation that owns JavaScript evaluation and its
  continuation. Node is built in; QuickJS is a bundled plugin. Core owns the
  catalog, tool authorization, and run lifecycle.
- **Guest runtime**: the Node VM context or QuickJS-WASI VM evaluating model code.
- **Host bridge**: the narrow JSON-compatible callback surface from guest code
  back into OpenClaw.
- **Catalog**: the run-scoped list of effective tools after normal tool
  policy, plugin, MCP, and client-tool resolution.
- **Nested tool call**: a tool call made from guest code through the host
  bridge.
- **Snapshot**: serialized QuickJS-WASI VM state saved so `wait` can continue
  a suspended code-mode run.
- **Continuation**: executor-owned state for a suspended cell. Node retains a
  live worker context; QuickJS retains a snapshot.

## Nested tool execution

Every nested tool call crosses the host bridge and re-enters OpenClaw,
preserving: active agent id, session id and key, sender and channel context,
sandbox policy, approval policy, plugin `before_tool_call` hooks, abort
signal, streaming updates where available, and trajectory/audit events.

Completed nested calls persist as bounded, redacted display-only activity, retaining
their original parent and invocation ids across history reloads. Provider replay
contains only the actual model calls; child activity adds no synthetic model turns.
Starts and partial updates remain transient. Older missing child history cannot be
reconstructed from source code or outer results.

Nested tool failures cross into the guest as catchable JavaScript errors. If
guest code does not catch an error, `exec` or `wait` returns a failed tool
result and the agent can continue normally. Follow the
[tool-error guidance](/tools/code-mode/quickstart#recover-from-tool-errors) to inspect possible partial
effects before choosing another action. Network-controlled tool output and errors
retain their existing untrusted-content wrapping and sanitization; continuing
after a failure does not grant new permissions or replay completed side effects.

Nested calls honor each tool’s `executionMode`. A `"sequential"` tool waits for
earlier catalog calls to finish and blocks later calls until its result has been
accepted. Parallel-capable calls can overlap before the next sequential call.
Scheduling is shared across cells using the same run catalog; separate catalogs
remain independent. Queued calls are canceled when their caller or catalog closes.

`maxPendingToolCalls` caps in-flight bridge requests, not the size of an ordinary
`Promise.all` batch. Calls and timers beyond that cap wait in the guest alongside
[Swarm](/tools/swarm) requests. At most 128 ordinary requests can be queued,
independently of the configured in-flight cap, using the existing accepted
bridge-limit ceiling. Swarm launches, notes, and result waits do not consume this
ordinary quota; their existing group, memory, and continuation limits still apply.
Queued inputs and request identities survive `wait`; `clearTimeout`
removes a queued timer without starting a host timer. A queued timer's delay begins
when it gets a bridge slot. Guest continuations run before waiting requests refill
available slots, and fast requests still drain within the same `exec` or `wait`.

Creating more ordinary requests than their queue quota allows fails the worker leg with
`invalid_input` and guidance to await smaller batches. Catching the immediate
JavaScript error does not admit a partial batch: no new calls from that
synchronous frontier are dispatched. Earlier worker legs may already have run
tools; inspect their effects rather than replaying the cell. Queueing does not
raise memory, snapshot, time, or headless total tool-call limits, or bypass
cancellation and policy checks.

## Run and snapshot lifecycle

Each code-mode run is tracked in an in-process map keyed by `runId` (not
persisted to disk or a database). `exec`/`wait` return one of three result
statuses: `completed`, `waiting`, or `failed`.

- A `waiting` result retains an executor continuation, pending bridge requests, and
  scoping metadata (agent run id, session id/key) until `wait` resumes it or
  it expires.
- Expiry, wrong-session, wrong-run, and unknown/already-resuming `runId`
  values do not produce a distinct terminal status; they surface as a
  `failed` result (`code: "invalid_input"`) with a message such as `code mode
run is unavailable or expired.` or `code mode run belongs to a different
session.`.
- A run's continuation is released as soon as it settles to
  `completed` or `failed`, or is dropped on Gateway shutdown (nothing
  survives a restart: this is transient runtime state).
- OpenClaw caps the number of concurrently suspended runs per process (64) and
  rejects new suspensions past that cap with `too many suspended code mode
runs.`.

The selected executor stays fixed for the cell's lifetime. Suspended state is
bounded by the per-process cap above and `snapshotTtlSeconds`. QuickJS also
checks serialized VM size, including engine metadata, against
`maxSnapshotBytes` before handing pending work to the Gateway. Node retains a
live worker and has no serialized snapshot to measure. These limits and
`memoryLimitBytes` are not total Gateway RSS limits; worker overhead and
host-side tool values also consume memory. Node's `memoryLimitBytes` configures
a best-effort V8 worker heap budget across the old and young generations,
subject to engine minimums. It includes worker runtime allocations and excludes
external buffers. The continuation's reported retained bytes are a diagnostic
estimate, not an enforced reservation or aggregate memory quota. Node's live
context can use more total host memory than a size-limited QuickJS snapshot. See
[Code Mode executors](/tools/code-mode/executors#understand-waits-and-limits).

Explicit `results.save(value)` references keep normalized JSON in the existing
admitted catalog lifetime, independently of each cell's VM and output budget.
The store admits at most 64 entries and `min(memoryLimitBytes, maxSnapshotBytes)`
encoded JSON bytes (10 MiB by default), in addition to the cell's program-data
inbox. This is a logical data allowance, not a process RSS limit. Capacity errors
preserve existing entries; deletion frees their capacity. Loads return detached
copies and carry forward network-content provenance into the receiving cell's
normal untrusted output wrapper.

Interactive cells also retain final structured JSON automatically when byte or
model-result fitting would otherwise truncate it. The worker serializes the
final value once and retains at most the larger of the display allowance and
the existing memory/snapshot data allowance; only eligible interactive cells
request this capture. Catalog admission checks remaining bytes and entries
before parsing another full JSON copy for bounded preview construction. The
normalized string moves into the same store. Final projection reserves a usable
reference before allocating the remaining display space to sampled descriptions
and output; an undisplayable reference is released. Failed admission remains a
successful partial result with a precise non-retention reason. Headless and
restart-safe execution do not allocate automatic references.

Catalog teardown, replacement, restriction, and the admitted run's abort clear
saved data. Appended client tools preserve the same result-store lifetime, including
for cells already parked in `wait`. Each cell captures that store before execution,
so stale cells cannot adopt a replacement store or retain references after a
permission change.
Saved references are data snapshots and never execution authority. They do not
survive Gateway restart and cannot be used by another run or session.

## QuickJS-WASI runtime

The bundled `code-mode-quickjs` executor plugin owns its `quickjs-wasi` dependency and
worker implementation. Selecting Node does not require loading the WASM runtime.

Runtime responsibilities: compile/load the QuickJS-WASI WebAssembly module;
create one isolated VM per code-mode run or resume; register host callbacks
by stable names; set memory and interrupt limits; evaluate JavaScript; drain
pending jobs; snapshot suspended VM state; restore snapshots for `wait`;
dispose VM handles and snapshots after terminal states.
Snapshot buffers transfer directly between workers and the Gateway without
copying the VM heap through a storage serialization format.

The runtime executes in a Node.js worker thread, outside OpenClaw's main
event loop. A guest infinite loop must not block the Gateway process
indefinitely; the worker's interrupt handler enforces the wall-clock timeout
independent of guest code cooperating.

## Node runtime

The Node executor evaluates JavaScript in a fresh `node:vm` context outside the
Gateway's main event loop. It uses the same guest controller and JSON tool
bridge as QuickJS. Suspension retains the worker, context, and pending promises;
`wait` continues that context without replaying the source. Cancellation,
expiry, terminal results, and shutdown release the retained execution.

After successful completion, Node keeps up to four idle workers warm for five
minutes each, reusing only workers with the same runtime entry and heap limit.
Each new cell still gets a fresh VM context. Runtime-entry changes and critical
memory pressure retire idle workers; memory pressure does not discard suspended
continuations. Failed, timed-out, or aborted cells retire their worker.

Worker supervision keeps runaway computation out of the main event loop.
Neither a worker thread nor `node:vm` supplies an operating-system security
boundary. Use the [executor guide](/tools/code-mode/executors) to choose the
appropriate trust model.

## TypeScript

TypeScript-style signatures describe tool inputs and outputs to the model through
the quick index, catalog handles, and `API.read` declaration files. Unknown
outputs stay `unknown`, and declarations do not grant access to additional tools.

Executable cells are plain JavaScript. Code Mode does not load a TypeScript
compiler, strip annotations, or typecheck the program. The selected engine parses and runs
the JavaScript directly. Tool calls still use the existing runtime input and
output validation, policy, and approval owners. A later call can fail after
earlier calls have produced effects, so follow the
[recovery guidance](/tools/code-mode/quickstart#recover-from-tool-errors) before
retrying a failed cell.

## Security boundary

Node is the default executor for trusted execution. Its intended globals and
module guards do not make `node:vm` a security boundary. Model output can be
influenced by prompt injection; choose the bundled QuickJS executor when the
guest must be isolated from the host.

QuickJS executes in a WASM guest with no ambient filesystem, networking,
subprocess, environment, or module access. It uses engine memory and interrupt
limits, a parent wall-clock deadline, and bounded serialized snapshots.

Both executors run outside the main event loop, use the same JSON tool bridge,
enforce output and pending-call caps, and release continuations on timeout,
abort, session end, or expiry. Core retains tool policy, approvals, hooks, and
session ownership. Recursive access to Code Mode and Tool Search control tools
is excluded from the guest catalog. These shared tool checks do not contain a
Node VM escape, and granting a powerful tool still grants its capabilities to a
QuickJS guest. See [Code Mode executors](/tools/code-mode/executors) for the
operator-facing choice and OS isolation guidance.

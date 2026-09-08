---
summary: "Code Mode scope, terms, nested tool execution, snapshots, the QuickJS-WASI runtime, and the security boundary"
title: "Code Mode internals"
read_when:
  - You need the runtime status, scope, or vocabulary
  - You are reviewing the QuickJS-WASI sandbox, TypeScript transform, or snapshot lifecycle
  - You are validating the security boundary for a high-risk deployment
---

## Runtime status

|                     |                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Runtime             | [`quickjs-wasi`](https://github.com/vercel-labs/quickjs-wasi)                               |
| Default state       | disabled                                                                                    |
| Stability           | experimental OpenClaw surface (Codex Code Mode is a separate, stable Codex harness surface) |
| Target surface      | generic OpenClaw agent runs                                                                 |
| Security posture    | model code is hostile                                                                       |
| User-facing promise | enabling code mode never silently falls back to broad direct tool exposure                  |

## Scope

Code mode owns the model-facing orchestration shape for a prepared run. It
does not own model selection, channel behavior, auth, tool policy, or tool
implementations.

In scope: model-visible control/direct tool definitions, hidden tool catalog
construction, JavaScript/TypeScript guest execution, the QuickJS-WASI worker
runtime, host callbacks for search/describe/call, resumable state for
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
- **Guest runtime**: the QuickJS-WASI JavaScript VM that evaluates model code.
- **Host bridge**: the narrow JSON-compatible callback surface from guest code
  back into OpenClaw.
- **Catalog**: the run-scoped list of effective tools after normal tool
  policy, plugin, MCP, and client-tool resolution.
- **Nested tool call**: a tool call made from guest code through the host
  bridge.
- **Snapshot**: serialized QuickJS-WASI VM state saved so `wait` can continue
  a suspended code-mode run.

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
ordinary quota; their existing group, VM memory, and snapshot limits still apply.
Queued inputs and request identities survive snapshot/resume; `clearTimeout`
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

- A `waiting` result stores the QuickJS snapshot, pending bridge requests, and
  scoping metadata (agent run id, session id/key) until `wait` resumes it or
  it expires.
- Expiry, wrong-session, wrong-run, and unknown/already-resuming `runId`
  values do not produce a distinct terminal status; they surface as a
  `failed` result (`code: "invalid_input"`) with a message such as `code mode
run is unavailable or expired.` or `code mode run belongs to a different
session.`.
- A run's snapshot is removed from the map as soon as it settles to
  `completed` or `failed`, or is dropped on Gateway shutdown (nothing
  survives a restart: this is transient runtime state).
- OpenClaw caps the number of concurrently suspended runs per process (64) and
  rejects new suspensions past that cap with `too many suspended code mode
runs.`.

Snapshot storage is bounded by `maxSnapshotBytes` per run, the per-process
suspended-run cap above, and `snapshotTtlSeconds`. The worker checks the snapshot
size, including QuickJS metadata, before handing pending work to the Gateway.
These limits and `memoryLimitBytes` bound guest state, not total Gateway memory;
warm worker threads and TypeScript compilers also retain memory.

## QuickJS-WASI runtime

OpenClaw loads `quickjs-wasi` as a direct dependency in the owning package; it
does not rely on a transitive copy installed for an unrelated dependency.

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

## TypeScript

By default TypeScript is a source transform: one code string becomes JavaScript
evaluated by QuickJS-WASI. Optional `exec({ code, language: "typescript",
typecheck: true })` checks a bounded in-memory compiler program first, using the
same effective tool declarations as `API.read` plus guest globals and the pinned
TypeScript standard library. Unknown outputs stay unknown. Compiler input is
bounded by the existing memory allowance and preparation shares the call deadline.
No guest module resolution, filesystem access, or `import`/`require` is enabled.
Diagnostics return `failed`/`invalid_input` with original `user.ts` coordinates;
no guest or tool work has run when preflight rejects. This opt-in does not change
JavaScript defaults or replace runtime JSON Schema validation.

The TypeScript compiler is loaded lazily only for TypeScript cells; plain
JavaScript cells and disabled code mode never load it.

## Security boundary

Model code is hostile. The runtime uses defense in depth:

- runs QuickJS-WASI outside the main event loop, in a worker thread
- loads `quickjs-wasi` as a direct dependency, not through Codex or a
  transitive package
- no filesystem, network, subprocess, module import, environment variables,
  or host global objects in the guest
- uses QuickJS memory and interrupt limits plus a parent-process wall-clock
  timeout
- enforces output, snapshot, log, and pending-call caps
- serializes host bridge values through a narrow JSON adapter
- converts host errors into plain guest errors, never host realm objects
- drops snapshots on timeout, abort, session end, or expiry
- rejects recursive access to `exec`, `wait`, and Tool Search control tools
- reserves specialized globals and resolves callable-name collisions before the
  worker starts

The sandbox is one security layer; operators may still need OS-level
hardening for high-risk deployments.

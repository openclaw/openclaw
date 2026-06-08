# OpenClaw Node.js Process Inventory

## Scope

This document is a first-pass inventory of **OpenClaw-owned Node.js OS
processes** that can exist in a normal installation.

It intentionally separates three categories:

1. **Real OS processes**
   Separate PID, separate V8 heap, separate baseline RSS.
2. **Worker threads / worker isolates**
   Same PID, but still relevant to memory because they allocate additional
   isolate/heap state.
3. **Arbitrary subprocesses launched through tools/config**
   OpenClaw can launch many external commands, but those are not a fixed part of
   OpenClaw's own topology.

## Top-level findings

- The main always-on Node.js runtime is the **gateway process**.
- OpenClaw also supports a second long-lived runtime, the **headless node host**
  (`openclaw node run` / `openclaw node install`).
- A number of **short-lived helper Node processes** exist for startup respawn,
  update/restart handoff, and one sandboxed tool-search/code-mode path.
- Some memory-heavy work already avoids extra PIDs by using **worker threads**
  instead of full child processes.
- OpenClaw can additionally keep **optional child services** alive, such as
  configured local model-provider daemons. Those are not guaranteed to be Node,
  but can be.

## 1. CLI launcher / respawn wrapper

### What it is

The `openclaw` executable is a Node launcher (`openclaw.mjs`) that can respawn
itself with adjusted environment/runtime flags before handing off to the real
CLI entrypoint.

### Source

- `openclaw.mjs`
- `src/entry.ts`
- `src/entry.respawn.ts`

### What it does

- validates Node version
- applies compile-cache behavior
- may respawn with adjusted `NODE_OPTIONS`, TLS CA env, or Windows stack-size
- eventually runs the real CLI entrypoint

### How it communicates

- parent/child stdio inheritance
- process signals bridged by the respawn helper
- no durable RPC layer; this is just startup handoff

### When it is created

- every `openclaw ...` invocation starts here first

### Memory relevance

- usually **transient**
- can briefly produce **two Node processes for one command** during respawn
- not likely the main steady-state memory problem, but it does add startup
  churn

## 2. Gateway process

### What it is

The gateway is the main long-lived OpenClaw server process, started via
`openclaw gateway run` directly or through a supervised service install.

### Source

- `src/cli/gateway-cli/run.ts`
- `src/cli/gateway-cli/run-loop.ts`
- `src/gateway/server.ts`
- `src/gateway/server.impl.ts`

### What it does

- owns the main HTTP/WebSocket server surface
- loads config, plugins, channel runtimes, agent tooling, cron, memory, control
  UI serving, and gateway-side orchestration
- handles in-process restart loops where possible

### How it communicates

- HTTP + WebSocket listeners for clients and nodes
- in-process dispatch across gateway modules/plugins
- filesystem state, SQLite state, config files

### When it is created

- foreground via `openclaw gateway run`
- background via managed service lifecycle (`openclaw gateway install/start`)

### Memory relevance

- this is the primary steady-state Node heap to investigate
- likely where the gateway leak lives
- also acts as the parent/coordinator for several optional helper execution
  paths

## 3. Gateway full-process restart child

### What it is

During some restart/update flows, the gateway can spawn a fresh Node process for
the gateway instead of doing a purely in-process restart.

### Source

- `src/cli/gateway-cli/run-loop.ts`
- `src/infra/process-respawn.ts`
- `src/cli/gateway-cli/lifecycle.runtime.ts`

### What it does

- performs restart handoff to a fresh gateway PID
- used especially around update/restart flows where an in-process restart is not
  sufficient or not desired

### How it communicates

- parent/child process environment handoff
- port-health probing from old process to new process
- restart sentinel / handoff state persisted in gateway state

### When it is created

- on certain gateway restart paths, especially `update.run` style restart flows

### Memory relevance

- transient, but creates a **double-gateway overlap window**
- worth measuring because restart overlap can spike memory on small hosts

## 4. Detached update restart script process

### What it is

The update flow can create a detached process that survives the current CLI
process so it can restart the managed service cleanly.

### Source

- `src/cli/update-cli/update-command.ts`
- `src/cli/update-cli/restart-helper.ts`

### What it does

- launches a shell script detached from the current process tree
- lets update/restart continue after the invoking CLI exits

### How it communicates

- file-based handoff plus service-manager side effects
- detached shell execution

### When it is created

- update/restart flows that need service restart after the current process exits

### Memory relevance

- usually very short-lived
- operationally important, but probably not a large steady-state contributor

## 5. Headless node host process

### What it is

OpenClaw has a separate long-lived Node runtime for the headless node host:
`openclaw node run` or `openclaw node install`.

### Source

- `src/cli/node-cli/register.ts`
- `src/cli/node-cli/daemon.ts`
- `src/node-host/runner.ts`

### What it does

- maintains a client connection back to the gateway
- exposes node capabilities like `system.run` / `system.which`
- can act as a remote execution target

### How it communicates

- outbound WebSocket client connection to the gateway
- local config/state files under `~/.openclaw/node.json`

### When it is created

- foreground: `openclaw node run`
- background: `openclaw node install` + service start

### Memory relevance

- separate long-lived Node service family
- not part of the gateway leak itself, but absolutely part of overall machine
  Node footprint
- if Joshua’s target environment runs both gateway and one or more node hosts,
  total memory can scale faster than expected

## 6. Tool-search code child process

### What it is

`tool_search_code` currently runs user code in a separate Node child process
with IPC.

### Source

- `src/agents/tool-search.ts`

### What it does

- spawns `process.execPath`
- runs the embedded code-mode/tool-search bridge program
- exchanges messages over IPC

### How it communicates

- child-process IPC channel (`stdio: ... "ipc"`)
- stdout/stderr capture
- parent-enforced timeout/abort handling

### When it is created

- when the tool-search code execution path is used

### Memory relevance

- short-lived but potentially expensive per invocation
- important because it is a **real extra Node process**, not just a worker
- likely a good candidate to compare against worker-thread or in-process
  alternatives

## 7. Optional local model-provider service process

### What it is

OpenClaw can start and supervise a configured local model-provider service on
demand.

### Source

- `src/agents/provider-local-service.ts`
- call sites in `src/agents/provider-transport-fetch.ts` and
  `src/agents/provider-transport-stream.ts`

### What it does

- starts a configured local service command
- health-checks it over HTTP
- reference-counts active use and stops it after idle timeout

### How it communicates

- child process spawn
- HTTP health probes / model requests

### When it is created

- first request that needs a model with `localService` configured

### Memory relevance

- conditional
- may be one of the biggest extra memory consumers if the configured local model
  server is itself a Node service
- even when not Node, it is still part of total machine memory topology

## 8. Local embedding worker child process

### What it is

The memory host SDK can fork a dedicated child process for local embeddings.

### Source

- `packages/memory-host-sdk/src/host/embeddings-worker.ts`
- `packages/memory-host-sdk/src/host/embeddings.ts`

### What it does

- forks a worker script
- services embed-query/embed-batch requests over IPC

### How it communicates

- `child_process.fork(...)`
- JSON-serialized IPC messages

### When it is created

- when the local embedding provider path is used

### Memory relevance

- real extra Node PID
- relevant for memory-heavy installs using local memory/embedding features
- may be a major contributor if local embeddings are active continuously

## 9. Other arbitrary child-process launches

These exist, but they are not a single fixed Node process family:

- exec/tool runtime subprocesses
- ACP client commands
- MCP stdio transports
- hook runners
- SSH/docker helpers
- ffmpeg/media helpers

### Source examples

- `src/process/exec.ts`
- `src/acp/client.ts`
- `src/agents/mcp-stdio-transport.ts`
- `src/hooks/gmail-watcher.ts`

### Why this matters

OpenClaw can create many subprocesses, but they are **workload-dependent** and
not all are Node. They should be treated separately from the built-in Node
topology above.

## Worker-thread / same-PID isolates worth tracking

These are **not separate processes**, but they are still relevant to memory
because they allocate additional V8 isolate/heap state inside an existing Node
PID.

### Provider auth warm worker

- Source:
  `src/agents/model-provider-auth.ts`,
  `src/agents/model-provider-auth.worker.ts`
- Trigger:
  gateway startup and auth-state rewarm
- Purpose:
  off-main-thread provider auth prewarm

### Compaction planning worker

- Source:
  `src/agents/compaction-planning-worker.ts`,
  `src/agents/compaction-planning.worker.ts`
- Trigger:
  larger compaction-planning workloads
- Purpose:
  move heavy compaction planning off the main thread

### Code-mode worker

- Source:
  `src/agents/code-mode.ts`,
  `src/agents/code-mode.worker.ts`
- Trigger:
  code-mode execution path
- Purpose:
  isolate QuickJS/code-mode execution from the main event loop

## Process-family summary

### Long-lived by default

- gateway process
- node host process (only when node-host mode is used)

### Long-lived but optional/conditional

- local model-provider service
- local embedding worker child

### Short-lived / transitional

- CLI launcher respawn child
- gateway full-process restart child
- detached update restart script process
- tool-search code child

## Initial hypotheses for memory reduction work

1. The **gateway process** is still the highest-value target because it is both
   long-lived and central.
2. The biggest process-count wins are likely to come from reducing or
   eliminating **optional helper PIDs** that could instead use worker threads or
   a shared in-process service.
3. The most suspicious "many Node processes" category is probably not normal
   sessions/cron work by itself, because much of that appears to stay inside the
   gateway PID. The extra PIDs seem to come more from **special helper runtimes**
   and **local-service patterns**.
4. Worker threads already exist in some places, which suggests the codebase is
   open to **replace-child-process-with-worker** refactors where isolation needs
   are moderate rather than absolute.

## Next verification steps

1. Build a runtime matrix showing which of these process families appear in a
   default local gateway install versus Joshua’s actual deployment.
2. Measure baseline RSS/heap for:
   - gateway only
   - gateway + node host
   - gateway + local embedding worker
   - gateway + configured local model-provider service
3. Trace whether `tool_search_code` is still on a hot path in real usage or is
   mostly legacy/rare.
4. Check whether any bundled plugins create additional persistent Node services
   outside the core inventory above.

## Open questions

- Are any bundled or Polytropos-specific plugins creating their own long-lived
  Node child services?
- In Joshua’s environment, which local providers or memory backends are
  actually enabled?
- Does the gateway leak correlate with optional helper services, or is it fully
  contained inside the main gateway PID?

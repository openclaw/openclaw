# Polytropos CLI Wrapper and Hook Relay Proposal

## Goal

Reduce repeated CLI startup overhead without rewriting the full OpenClaw CLI.

The current direction is:

- ship a new Polytropos-owned installed CLI that still presents itself as `openclaw`
- make that CLI a thin wrapper in front of the upstream/core OpenClaw CLI
- allow plugins to claim or override selected command roots before fallback
- fork only the hot or problematic paths first
- move the heavy execution for those forked paths into a shared daemon

This is a narrower and more practical plan than trying to execute the existing
Commander CLI wholesale inside a daemonized fake process runtime.

## Why This Direction

The full OpenClaw CLI is still strongly process-shaped:

- [src/entry.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/entry.ts) mutates `process.argv`, `process.env`, process title, and respawn behavior
- `run-main` and the CLI program stack install process-global handlers and rely on process lifecycle cleanup
- many command paths still assume direct ownership of stdout/stderr, environment, and singleton module state

That makes a transparent in-daemon execution of the existing CLI risky, especially
for concurrency.

The wrapper approach keeps the compatibility story much simpler:

- unclaimed commands still go to the core CLI
- hot paths can be replaced one by one
- memory savings can be targeted where startup churn is worst

## Existing Plugin CLI Customization Model

OpenClaw already has a real plugin CLI registration system.

Relevant files:

- [src/plugins/registry.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/registry.ts)
- [src/plugins/cli.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/cli.ts)
- [src/plugins/types.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/types.ts)
- [src/plugins/captured-registration.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/captured-registration.ts)

Current pattern:

- plugins call `api.registerCli(registrar, opts)`
- a plugin can declare command roots with `commands`
- a plugin can also expose lazy metadata with `descriptors`
- duplicate CLI roots are rejected during registration
- plugin CLI commands are merged into the Commander program at runtime

Examples:

- [extensions/browser/index.ts](/home/ec2-user/polytropos/openclaw-polytropos/extensions/browser/index.ts)
- [extensions/memory-core/index.ts](/home/ec2-user/polytropos/openclaw-polytropos/extensions/memory-core/index.ts)
- [extensions/matrix/index.ts](/home/ec2-user/polytropos/openclaw-polytropos/extensions/matrix/index.ts)

Important nuance:

- the current upstream plugin model is additive-first, not override-first
- there is already a limited takeover seam: `registerPluginCliCommands(..., { primary })`
  can remove an existing command root and let a plugin claim it for that parse path
- this is the closest existing pattern to preserve when we add wrapper-level overrides

## Proposed Wrapper Resolution Model

The wrapper CLI should resolve commands in this order:

1. Parse enough argv to identify the top-level command root.
2. Ask the Polytropos plugin registry whether a plugin claims that root.
3. If a plugin claims it, dispatch to the plugin-owned implementation.
4. Otherwise forward argv to the core OpenClaw CLI unchanged.

This suggests two plugin concepts:

- additive plugin commands
- explicit wrapper overrides for built-in roots

The wrapper override concept should be new and explicit. It should not silently
change the meaning of existing upstream `registerCli` behavior.

One likely shape:

- preserve upstream-like `registerCli(...)` for additive commands and metadata
- add a Polytropos wrapper-specific registration for override roots
- keep the override surface narrow and auditable

## Polytropos Plugin Namespace

We should add a Polytropos CLI plugin with a dedicated namespace:

- `openclaw polytropos ...`

That namespace can hold:

- Polytropos-only commands
- operator/debug commands for the wrapper and daemon
- forked versions of upstream CLI flows before they graduate into direct root overrides

This gives us a safe place to land replacement behavior before deciding whether a
given root should fully override an upstream command.

## What the Codex Hook Relay Path Is

The hot path we identified is the native Codex hook relay.

This is not Codex using `openclaw` to execute every tool directly.

Instead:

- the long-lived Codex session owns the actual model loop and tool execution
- around lifecycle events, Codex invokes an OpenClaw hook command
- that command is the `openclaw hooks relay ...` path

Observed/generated command shape:

```bash
openclaw hooks relay --provider codex --relay-id <id> --event <event> ...
```

Typical events include:

- `PreToolUse`
- `PostToolUse`
- `PermissionRequest`
- `Stop`

Conceptually, the flow is:

1. Codex reaches a lifecycle point such as "about to run a tool".
2. Codex spawns `openclaw hooks relay ...`.
3. That short-lived process resolves the relay/session/plugin context.
4. It forwards the event into OpenClaw's hook/plugin/runtime layer.
5. OpenClaw performs policy, routing, binding, approval, or bookkeeping work.
6. The relay process exits and Codex continues.

So the repeated startup overhead is not "OpenClaw is running every tool."
It is "OpenClaw is being spawned around hooked events."

For tool-heavy runs, that can still be very expensive, because the hook path is
hot and process startup costs repeat.

## Why the Hook Relay Path Is a Strong First Fork Target

The hook relay path is a good first target because it is:

- hot
- repetitive
- narrow in purpose
- easier to replace than the full CLI
- clearly adjacent to the observed memory/startup problem

It is also a better first candidate than a broad `openclaw agent` fork, because
the relay path sits directly on the event boundary that Codex is exercising often.

## Agent Primary Surface vs CLI Surface

The agent's intended primary surface is mostly the OpenClaw tool catalog, not
the terminal CLI.

Relevant file:

- [src/agents/tool-catalog.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/agents/tool-catalog.ts)

Representative primary tools include:

- `read`, `write`, `edit`, `apply_patch`
- `exec`, `process`
- `web_search`, `web_fetch`
- `memory_search`, `memory_get`
- `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`
- `message`, `cron`, `gateway`, `nodes`, `agents_list`
- `image`, `image_generate`, `tts`

That means the scope of "fork all agent-facing commands" is misleadingly large
if phrased in terms of user-visible capability.

The actual OpenClaw CLI paths that appear to matter most under the hood are much
smaller:

- `openclaw hooks relay ...`
- `openclaw acp`
- `openclaw agent`

## Initial Fork Candidates

Recommended first wave:

1. Hook relay path
   - target: `openclaw hooks relay ...`
   - goal: replace repeated short-lived CLI startup with a thin wrapper + daemon RPC

2. ACP bridge path
   - target: `openclaw acp`
   - goal: move ACP bridge startup and shared context into the daemon where practical

3. Agent path
   - target: `openclaw agent`
   - goal: evaluate later, after relay and ACP results are measured

Possible namespace-first landing:

- `openclaw polytropos hooks relay`
- `openclaw polytropos acp`
- `openclaw polytropos agent`

Then, once stable:

- claim the upstream roots through wrapper override rules

## Daemon Role

The daemon should not try to host the whole upstream CLI unchanged.

Instead, it should host:

- shared execution context for the forked Polytropos command paths
- request routing for claimed roots
- any long-lived caches or plugin/runtime state needed by those forked paths
- instrumentation for memory and concurrency behavior

The thin wrapper should do:

- argv validation
- root command resolution
- plugin override lookup
- daemon transport
- fallback to the core OpenClaw CLI when a root is not claimed

## Memory Hypothesis

This plan should help where repeated startup cost is the main problem.

Expected wins:

- less repeated Node/V8/Commander/bootstrap overhead on hot forked paths
- better aggregate RSS under many repeated relay-style invocations
- clearer boundary for measuring which command families are actually expensive

Non-goals:

- this alone will not solve every memory issue in the broader system
- if a forked path has a large true working set, the daemon still pays that cost
- leaks in the daemonized path can become persistent unless bounded and observed

## Recommended Next Steps

1. Measure the current `openclaw hooks relay` path directly.
   - startup time
   - RSS
   - invocation frequency during representative Codex runs

2. Define a Polytropos wrapper command registry.
   - additive roots
   - explicit override roots
   - fallback behavior

3. Build the Polytropos CLI plugin namespace.
   - start with `openclaw polytropos ...`
   - expose diagnostics for wrapper resolution and daemon health

4. Fork the hook relay path first.
   - preserve the hook contract
   - replace CLI-local heavy startup with daemon RPC

5. Re-measure.
   - per-invocation RSS
   - aggregate RSS under parallel or tool-heavy runs
   - correctness of permissions, routing, and stop behavior

## Open Questions

- Should wrapper overrides be declared in the existing plugin manifest/registration
  model, or in a Polytropos-only extension to that model?
- Should `openclaw polytropos ...` remain user-visible long term, or only serve as
  a staging namespace before root takeover?
- Is `openclaw agent` worth forking in the first wave, or should hook relay and ACP
  prove out the design first?
- Should the fallback boundary be process-level only, or can some core CLI paths be
  linked directly as libraries later if they are sufficiently request-shaped?

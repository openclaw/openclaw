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

- the current upstream plugin registration model is additive-first, not declarative-override-first
- there is already a real takeover seam in the loader path:
  `registerPluginCliCommands(..., { primary })` can remove an existing command root
  from the `Commander` program and let a plugin registrar claim it for that parse path
- however, that takeover is selected by the caller of `registerPluginCliCommands`,
  not by the plugin manifest/registration itself
- duplicate CLI roots are still rejected in the registry, so upstream does not
  currently model "multiple plugins may declare the same root and one wins"
- this is the closest existing core behavior to reuse for Polytropos root overrides

## Proposed Wrapper Resolution Model

The wrapper CLI should resolve commands in this order:

1. Parse enough argv to identify the top-level command root.
2. Ask the Polytropos plugin registry whether a plugin claims that root.
3. If a plugin claims it, dispatch to the plugin-owned implementation.
4. Otherwise forward argv to the core OpenClaw CLI unchanged.

This can and should reuse upstream code as much as possible.

The most promising reuse path is:

- use upstream plugin CLI metadata/registration loading
- identify the selected root early in the wrapper
- if a Polytropos plugin owns that root, call
  `registerPluginCliCommands(..., { primary: <root> })`
- otherwise forward argv to the core CLI

What still needs wrapper-specific logic:

- a lightweight pre-Commander root selection phase
- a lightweight way to know whether Polytropos wants to claim a given root
- fallback execution when no plugin claims the root

So the likely split is:

- reuse upstream `registerCli(...)` and `registerPluginCliCommands(...)`
- add only a small Polytropos wrapper layer around root selection and fallback

## Polytropos Plugin Shape

For the first cut, the Polytropos plugin should be framed as a fork of selected
core OpenClaw CLI roots rather than as a separate `polytropos` namespace.

Why:

- it avoids changing Codex hook config just to reach the replacement path
- it keeps the installed command surface identical from the caller's perspective
- it tests the direct-root-override design immediately instead of staging through
  an intermediate namespace

This means the first plugin-owned command path should override an existing root
directly rather than introducing `openclaw polytropos ...`.

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

1. Hook relay path only
   - target: `openclaw hooks relay ...`
   - goal: replace repeated short-lived CLI startup with a thin wrapper + daemon RPC
   - constraint: preserve the existing hook command contract so Codex config does
     not need to change

Follow-on candidates after the hook experiment:

- `openclaw acp`
- `openclaw agent`

## Daemon Role

The daemon should try to reuse OpenClaw core code as much as possible.

That means the design work should explicitly separate:

- reusable upstream CLI/runtime code we can call or host directly
- wrapper-only code needed for root selection, fallback, and daemon transport
- any code that must be reimplemented because it is too process-shaped or too
  expensive to invoke in the hot path

The daemon should ideally host:

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

2. Analyze reuse boundaries for the hook relay path.
   - what in upstream hook/plugin loading can be reused directly
   - what wrapper logic must exist before calling into upstream code
   - what must be reimplemented in the daemon hot path

3. Define the lightweight wrapper root-selection flow.
   - identify command root early
   - decide whether Polytropos claims it
   - when claimed, drive upstream plugin registration with `primary`
   - otherwise fall through to the core CLI

4. Fork the hook relay path first.
   - preserve the hook contract
   - replace CLI-local heavy startup with daemon RPC

5. Re-measure.
   - per-invocation RSS
   - aggregate RSS under parallel or tool-heavy runs
   - correctness of permissions, routing, and stop behavior

## Hook Relay Reuse Boundaries

This section summarizes what appears reusable today for a `hooks relay` fork and
what still requires Polytropos-owned wrapper/daemon logic.

### Important finding

The actual `openclaw hooks relay ...` command implementation does not appear to
live in this core repo. The core repo contains the built-in `hooks` CLI for
managing internal hooks, but the Codex-native relay command seems to come from
the external Codex app-server plugin / integration layer.

That means the analysis splits into:

- core OpenClaw services that a replacement relay path can reuse
- external relay-command glue that likely must be recreated or mirrored by
  Polytropos

### Reusable upstream core pieces

These look reusable with little or no semantic change:

- CLI argv helpers such as primary-command extraction and root-option parsing in
  [src/cli/argv.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/cli/argv.ts)
- plugin hook policy and hook precedence resolution in
  [src/hooks/policy.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/hooks/policy.ts)
- internal hook loading in
  [src/hooks/loader.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/hooks/loader.ts)
- typed plugin hook execution in
  [src/plugins/hooks.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/hooks.ts)
- plugin runtime state surfaces in
  [src/plugins/runtime.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/runtime.ts)
- metadata-only plugin CLI discovery via
  [src/plugins/loader.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/loader.ts)
  and [src/plugins/cli.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/cli.ts)
- the existing in-memory takeover mechanism
  `registerPluginCliCommands(..., { primary })`

These are the main candidates to host inside a long-lived daemon once, instead
of redoing them in a short-lived CLI process for every relay event.

### Reusable, but probably too heavy for the hot wrapper path

These are useful building blocks, but they still look too expensive to invoke on
every wrapper startup:

- `loadOpenClawPluginCliRegistry(...)`
  - lighter than the full runtime loader
  - but still does plugin discovery, manifest loading, config validation, module
    import, and plugin `register(api)` execution in `cli-metadata` mode
  - currently runs with `cache: false`, so it is not a cheap per-event lookup
- `registerPluginCliCommands(...)`
  - useful once the chosen root is already known
  - not sufficient as the root-selection mechanism itself

So these should be treated as:

- good daemon-startup or daemon-refresh primitives
- poor per-invocation wrapper primitives

### Current core path that blocks direct builtin override

Current `runCli()` behavior in
[src/cli/run-main.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/cli/run-main.ts)
registers the built-in primary command first:

- `registerCoreCliByName(...)`
- `registerSubCliByName(...)`

Then it decides whether to skip plugin CLI registration:

- if the selected primary is already a built-in command, plugin registration is
  skipped entirely

That matters because `hooks` is currently a built-in sub-CLI root, registered in
[src/cli/program/register.subclis.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/cli/program/register.subclis.ts).

Implication:

- the existing `runCli()` path cannot simply be reused unchanged if Polytropos
  wants to take over the `hooks` root
- the wrapper must intercept before the current built-in-first registration flow
  runs, or the core logic must be changed

### Process-shaped or wrapper-owned layers

These layers still look too process-shaped, too expensive, or too policy-specific
to treat as the reusable hot path:

- [src/entry.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/entry.ts)
  - respawn logic
  - process env mutation
  - process title
  - compile-cache setup
- [src/cli/run-main.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/cli/run-main.ts)
  - dotenv loading
  - PATH rewriting
  - console capture
  - uncaught exception / rejection handlers
  - full Commander program build
- full plugin registry activation in
  [src/cli/plugin-registry.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/cli/plugin-registry.ts)
  and [src/plugins/loader.ts](/home/ec2-user/polytropos/openclaw-polytropos/src/plugins/loader.ts)

These are likely daemon-startup concerns at most, not per-relay invocation work.

### Practical first-cut architecture for `hooks relay`

For the first wave, the simplest useful design is probably:

1. The installed Polytropos wrapper hardcodes a narrow intercept for the `hooks`
   root, or even more narrowly the `hooks relay` subpath.
2. All other argv falls through unchanged to the core OpenClaw CLI.
3. The daemon preloads the reusable core pieces once:
   - config snapshot
   - plugin metadata / registry state
   - hook policy state
   - hook runner state
4. The wrapper sends relay requests to the daemon.
5. The daemon uses reusable upstream hook/plugin machinery where possible, but
   does not rebuild the whole CLI program for each event.

This avoids overgeneralizing too early. For the first experiment, we do not need
to solve "arbitrary root override for any plugin" before solving `hooks relay`.

## Open Questions

- Is upstream plugin CLI metadata loading light enough for the wrapper hot path,
  or do we need an even cheaper snapshot/index for claimed roots?
- For `hooks relay`, which portions of upstream hook/plugin loading can be hosted
  inside the daemon unchanged, and which portions assume one-shot CLI process
  lifecycle too strongly?
- Should the fallback boundary be process-level only, or can some core CLI paths be
  linked directly as libraries later if they are sufficiently request-shaped?

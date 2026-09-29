---
summary: "Tool Search: compact large OpenClaw tool catalogs behind search, describe, and call"
title: "Tool Search"
read_when:
  - You want OpenClaw agents to use a large tool catalog without adding every tool schema to the prompt
  - You want OpenClaw tools, MCP tools, and client tools exposed through one compact runtime surface
  - You are implementing or debugging tool discovery for OpenClaw runs
---

Tool Search is an experimental OpenClaw agent runtime feature. It gives agents one
compact way to discover and call large tool catalogs. It is useful when the run
has many available tools but the model is likely to need only a few of them.

This page documents OpenClaw Tool Search. It is not the Codex-native tool
search or dynamic-tools surface. Codex-native code mode, tool search, deferred
dynamic tools, and nested tool calls are stable Codex harness surfaces and do
not depend on `tools.toolSearch`.

For the generic OpenClaw runtime that exposes a JavaScript `exec`/`wait`
surface instead of Tool Search controls, see [Code Mode](/tools/code-mode).

OpenClaw embedded and Copilot runs use structured Tool Search automatically when
`tools.toolSearch` is unset. This defers tool schemas while keeping the
policy-approved capabilities available. It does not enable lean mode or remove
optional tools. Set `tools.toolSearch: false` to restore direct schemas. Engaged
[Code Mode](/tools/code-mode) takes precedence, and Codex keeps its native surface.
This automatic default does not rewrite the configuration file.

When enabled for OpenClaw runs, the model automatically receives a bounded
directory of the available trusted tool names and descriptions, plus the
structured `tool_search`, `tool_describe`, and `tool_call` controls. Setting
`tools.toolSearch: true` or an object without a mode selects this structured
surface. Direct-only tools remain visible alongside the controls.

The directory scales with the active model's context window. When space is tight,
descriptions shorten before tool names are omitted; every authorized catalog
entry remains searchable and callable. Invalid arguments for OpenClaw-owned
tools include a bounded expected input signature when one can be rendered, so
the model can correct the call without another schema lookup.
If a call mistakes an admitted skill name for a tool ID, the error points back
to the skill’s complete instructions instead of sending the model through tool search.

The deferred directory omits tools already exposed directly. They remain searchable,
so discovery can still return their complete schemas without duplicating native guidance.

The catalog can include catalog-eligible OpenClaw tools, plugin tools, MCP
tools, and client-provided tools. The directory gives the model an idea of
which trusted capabilities it can discover without exposing every cataloged
schema up front. It also explains that policy-approved MCP and client tools
may be discoverable. Their untrusted names and descriptions are not copied into
the system prompt. Instead, the model searches compact descriptors, describes
one selected tool when it needs the exact schema, and calls that tool through
OpenClaw. Direct-only tools remain model-visible and are not added to the
catalog.

Codex harness runs do not receive these experimental OpenClaw Tool Search
controls. OpenClaw passes product capabilities to Codex as dynamic tools, and
Codex owns the stable native code mode, native tool search, deferred dynamic
tools, and nested tool calls.

Claude CLI backends reach OpenClaw tools through the bundle MCP loopback server,
so these controls do not apply there either. By default that server is marked
`alwaysLoad`, which sends every OpenClaw tool schema on every turn. When you set
`tools.toolSearch` explicitly (`true`, or an object that resolves enabled), the
loopback entry drops `alwaysLoad` and Claude Code defers OpenClaw tools behind
its native ToolSearch. `message` and `sessions_yield` stay loaded on turn one
through the per-tool `_meta["anthropic/alwaysLoad"]` hint. Leaving
`tools.toolSearch` unset keeps the eager behavior. Changing the setting
invalidates reusable Claude CLI sessions once, because the MCP config is part of
their resume fingerprint.

## How a turn runs

At planning time the OpenClaw embedded runner builds the effective catalog for the
run:

1. Resolve the active tool policy for the agent, profile, sandbox, and session.
2. List eligible OpenClaw and plugin tools.
3. List eligible MCP tools through the session MCP runtime.
4. Add eligible client tools supplied for the current run.
5. Keep core coding primitives and direct-only tools model-visible and index
   compact descriptors for the remaining catalog-eligible tools.
6. Add a deterministic, bounded, policy-filtered capability directory to the
   cache-stable system-prompt prefix.
7. Expose the structured search, describe, and call tools or the compact
   directory surface alongside those stable, directly callable tools.

At execution time every real tool call returns to OpenClaw, where the normal
policy, approval, hook, logging, and result handling still apply.

## Modes

`tools.toolSearch` has two model-facing modes:

- `tools`: the default when `tools.toolSearch` is unset, `true`, or an object
  without a mode. Exposes `tool_search`,
  `tool_describe`, and `tool_call` as plain structured tools, alongside the
  capability directory and direct-only tools.
- `directory`: exposes `tool_search`, `tool_describe`, and `tool_call` plus a
  bounded, cache-stable prompt directory. Core coding primitives, direct-only
  tools, and tools required by the run's delivery policy remain visible; other
  schemas stay deferred.

All modes use the same policy-filtered catalog and normal OpenClaw execution
path. Tools marked `catalogMode: "direct-only"` stay outside that catalog and
remain model-visible. In `directory` mode, client-provided tools stay directly visible
for the current run while OpenClaw tools, plugin tools, and MCP tools can be
compacted behind the directory catalog. A direct call to an exact hidden
directory name is hydrated from that same authorized catalog before execution
in the embedded harness. The [Copilot harness](/plugins/copilot) instead maps
`directory` to structured `tools` semantics: hidden OpenClaw catalog names must
be invoked through `tool_call`, because they are not registered SDK handlers.

The structured `tools` surface is on by default for OpenClaw runs. Target tools
keep their own timeouts and approval behavior. Codex harness runs use their
native surfaces.

Compaction is not always cheaper: small catalogs can gain schema overhead, and
additional discovery turns can offset initial payload savings. Set
`tools.toolSearch: false` when direct schemas suit your workload better.

There is no separate source-selection config. When Tool Search is enabled, the
catalog includes catalog-eligible OpenClaw, MCP, and client tools after normal
policy filtering; direct-only tools are retained separately.

## Why this exists

Large catalogs are useful but expensive. Sending every tool schema to the model
makes the request larger, slows planning, and increases accidental tool
selection.

Tool Search changes the shape:

- direct tools: the model sees every selected schema before the first token
- Tool Search tools mode: the model sees three compact structured
  tools, the same capability directory, and any direct-only tools
- Tool Search directory mode: the model sees a bounded directory plus
  search/describe/call controls, policy-required direct tools, and any
  direct-only tools
- during the turn: the model can load remaining schemas as needed

Tool Search is useful when one run can see many tools, especially from MCP
servers or client-provided app tools. Structured search is the default, but
actual request size and latency depend on the catalog and the model's calls.

The capability directory is sorted by tool name, limited to 18,000 characters,
and built from the already policy-filtered catalog. OpenClaw reuses the
rendered directory for an unchanged catalog snapshot and places it above the
system-prompt cache boundary. User messages, per-turn tool guesses, session
identifiers, and untrusted MCP or client metadata do not enter the directory.
This keeps repeated turns eligible for prompt KV-cache reuse. When the
authorized catalog changes, OpenClaw builds a new directory for the new
snapshot. Prompt-hook `toolsAllow` restrictions apply before the final prompt is
submitted: the embedded and Copilot prompts advertise only the remaining
catalog, without rerunning the hook or rewriting earlier conversation turns.

## Structured controls

### Search

`tool_search` searches the effective catalog for the current run. It accepts a
query and an optional limit.

Queries must be written in English. Ranking is lexical (Okapi BM25 over tool
names, descriptions, and first-party parameter names and descriptions), with
light English stemming so `scheduling` reaches a tool described as `Schedule a
recurring task`, and a small intent expansion so `look up the price` reaches one
described as `Search the web`. Tool names and descriptions are written in English,
so a query in another language will usually match nothing. It is not rejected —
a catalog may legitimately describe a tool in another script — but a query with
no usable terms returns no ranked results rather than an arbitrary slice of the
catalog. An exact tool name is still honored even when it tokenizes to nothing.
`tool_search` states this requirement in its model-facing description.

Untrusted parameter schemas are never indexed. MCP and client tools are matched
on name and description only, which is the same boundary that defers their input
signatures as `input: "unknown"`.

Results are compact and safe
to put back into prompt context. Each hit includes a bounded TypeScript-style
`input` signature, such as `{ id: string; mode?: "drip" | "flood" }`, so the
model can skip `tool_describe` when that signature is sufficient. A trusted
OpenClaw core or plugin tool may also include a compact `output` hint, such as
`Array<{ id: string; paid: boolean }>`. MCP and client output-schema claims are
not promoted into this trusted hint. Their untrusted input schemas are also
deferred as `input: "unknown"`; use `tool_describe` before calling them. Open,
oversized, or otherwise partial output schemas omit the hint and remain
available through `tool_describe` instead.

```json
{ "query": "calendar event", "limit": 5 }
```

### Describe

`tool_describe` accepts the `id` of a search result and loads its full metadata,
including the exact input schema and the trusted full `outputSchema` when the
tool declares one.

```json
{ "id": "mcp:calendar:create_event" }
```

### Call

`tool_call` accepts a tool `id` and its target `args`, calls the selected tool
through OpenClaw, and returns the `{ tool, result }` envelope. JSON-returning tools normally place their value in
`result.details`. OpenClaw validates a trusted core or plugin tool's declared
input schema before execution. Missing required arguments, incorrect types,
and forbidden properties return actionable tool errors instead of executing
the tool; misspelled properties include a suggested parameter when available.
If a trusted tool also declares `outputSchema`, OpenClaw compiles that schema
before execution and validates final `details` after normal tool hooks before
returning the catalog call. MCP and client-owned schemas remain deferred to
their owning execution boundary.

If `tool_call` names a direct-only tool declared for the current turn, it returns
guidance to call that tool directly by its declared name and parameters. It does
not dispatch direct-only tools through the catalog or suggest searching for them.
Tools not available in the current turn still receive the ordinary catalog-miss
error.

`tool_call` also repairs flattened target arguments from
local models. It preserves target fields such as `id` and `name`, and rejects
ambiguous tool selectors instead of calling the wrong tool. Nest target
arguments under `args` when a target field matches another cataloged tool.

The structured control's model-facing text includes only the tool's `id`,
`name`, and `source` alongside the unchanged target `result`; it does not repeat
the description and input signature. Its structured `details` retain the full
call envelope for runtime consumers. Use `tool_describe` for full tool metadata.

```json
{
  "id": "mcp:calendar:create_event",
  "args": {
    "summary": "Planning",
    "start": "2026-05-09T14:00:00Z"
  }
}
```

Tool authors declare output contracts on the tool's `outputSchema` property.
It describes `AgentToolResult.details`, not rendered content blocks. Include
all non-throwing variants or omit it for unstable results. See
[Code Mode output contracts](/tools/code-mode/output#declared-output-contracts) and
[Tool plugins](/plugins/tool-plugins#output-contracts).

Deferred names are catalog entries, not directly callable functions in this
mode. Put the result ID or name in `tool_call.id` and all target parameters in
`tool_call.args`, including when other instructions refer to the deferred tool
by name. A compact search signature may be enough to call it; use
`tool_describe` when the full schema is needed.

### Batch search

`tool_search` accepts either the single-query shape or a batch of
independent queries:

```json
{
  "query": "today's calendar events",
  "limit": 3
}
```

```json
{
  "queries": [
    { "query": "today's calendar events", "limit": 3 },
    { "query": "Slack messages needing attention", "limit": 3 }
  ]
}
```

Single-query calls continue to return the compact candidate array directly.
When both shapes contain searches, the non-empty `query` runs first, with the
top-level `limit` scoped to it. Batch entries follow in request order, including
repeated query text; each occurrence keeps its own limit and counts toward the
batch budgets.

Beside a non-empty batch, an omitted, `null`, empty, or whitespace-only `query`
is ignored. In that case, omit the top-level `limit` or set it to `null`; a
non-null top-level limit is rejected rather than applied to the batch.
An omitted or `null` `queries` retains scalar behavior, and `queries: []` also
falls back to the scalar shape when `query` is non-empty. A blank scalar query
without a batch still returns an empty candidate array. A missing or `null`
scalar with no batch, or an empty batch with no non-empty scalar, is rejected.
A scalar `limit: null` uses the default limit, just like an omitted limit.
Invalid query shapes, invalid limits, and over-budget batches still fail.

Batch calls return `{ results: [{ query, candidates }] }` in request order. Each
query uses the same effective catalog, ranking, filtering, and per-query limit
as an ordinary search; a candidate may appear in more than one result group.
Descriptions are compacted before output. If the complete batch would exceed
the 4,000-character response budget, lower-ranked candidates are removed and
the response includes `truncated: true`. A result group that lost candidates
also includes `truncated: true`, so an empty truncated group cannot be mistaken
for a query that had no matches.
Omitted per-query limits use `searchDefaultLimit`. The effective limits in one
batch may request at most 50 candidates in total. A batch accepts at most 16
queries, with at most 512 characters per query and 512 UTF-8 bytes across the
serialized query list. Invalid batches fail as one request, while a valid query
with no matches returns an empty `candidates` array.

### Directory mode

Directory mode exposes:

- `tool_search`
- `tool_describe`
- `tool_call`

It also keeps core file and shell primitives, client-provided tools, direct-only
tools, and policy-required delivery tools directly visible. Other authorized
tool schemas stay deferred rather than changing with each user prompt. MCP tools
cannot impersonate a directly visible core or policy-required delivery tool. If
the bounded directory omits entries, use `tool_search` to find them and
`tool_describe` to retrieve their full schemas. If the model requests an exact
hidden directory tool name directly, the embedded harness resolves it from the
authorized catalog before normal execution. Copilot uses `tool_call` instead,
as described under [Modes](#modes).
Directory-mode client tool names must not collide with OpenClaw, plugin, or MCP
tool names because exact deferred dispatch uses those names.

## Execution policy

Normal OpenClaw behavior still applies to final calls:

- tool allow and deny policies
- per-agent and per-sandbox tool restrictions
- channel/runtime tool policy
- approval hooks
- plugin `before_tool_call` hooks
- tool `executionMode`: sequential calls run exclusively with other calls in the
  same catalog, including calls from other Tool Search or Code Mode cells
- session identity, logs, and telemetry

## Config

With `tools.toolSearch` unset, OpenClaw runs use structured `tools` mode with
a default search limit of 8 and a maximum of 20. Local Ollama models, LM Studio,
and managed local services retain their smaller limits of 5 and 10. Known hosted
Ollama routes use the general limits. An untagged alias served by an Ollama daemon
inherits the daemon's limits even if that alias forwards to a hosted model.
Other providers are not classified as local from model names or a loopback URL alone.

An explicit `tools.toolSearch` value takes precedence, including `false`.
Setting `agents.defaults.experimental.localModelLean: false` restores optional
tools but does not turn off automatic Tool Search.

Enable structured Tool Search explicitly:

```bash
openclaw config set tools.toolSearch true
```

Equivalent JSON:

```json5
{
  tools: {
    toolSearch: true,
  },
}
```

Pin the structured default explicitly:

```json5
{
  tools: {
    toolSearch: {
      mode: "tools",
    },
  },
}
```

Use the compact directory surface instead for OpenClaw runs:

```json5
{
  tools: {
    toolSearch: {
      mode: "directory",
    },
  },
}
```

Tune search result limits (values shown are the defaults):

```json5
{
  tools: {
    toolSearch: {
      mode: "tools",
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    },
  },
}
```

The runtime clamps `maxSearchLimit` to 1-50 and `searchDefaultLimit` to
1..`maxSearchLimit`.

Disable it:

```json5
{
  tools: {
    toolSearch: false,
  },
}
```

## Upgrading

Tool Search code mode (`tool_search_code`) is retired. Run
`openclaw doctor --fix` to migrate `tools.toolSearch.mode: "code"` to `"tools"`
and remove `codeTimeoutMs`. The migration preserves whether Tool Search is
enabled. `openclaw update` normally runs it for you; updates that defer
Doctor config repair, such as older Git updaters, need `openclaw doctor --fix`
afterward. A Gateway started on an unmigrated config exits and names the
retired key and this command.
`toolSearch: true` and objects without a mode now select structured
search. Use [Code Mode](/tools/code-mode) and its `exec`/`wait` surface for
JavaScript orchestration.

## Session activity

Search, describe, and call results carry the catalog data for that operation.
OpenClaw does not record serialized tool or prompt byte counts. The
[E2E scenario](#e2e-validation) measures provider payload bytes separately from
the mock provider lane.

Regardless of mode, completed target calls persist as bounded, redacted display
activity in session history without adding synthetic model turns to replay.
Search, describe, and call results carry each tool's `id` and `source`.
Session logs therefore still answer:

- how many tool schemas the model saw up front
- how many search and describe operations it performed
- which final tool was called
- whether the result came from OpenClaw, MCP, or a client tool

## E2E validation

The QA Lab gateway scenario compares direct and structured Tool Search with the
OpenClaw runtime:

```bash
pnpm openclaw qa suite --provider-mode mock-openai --scenario tool-search-gateway-e2e
```

It creates a temporary fake plugin with a large tool catalog, starts the mock
OpenAI provider, then runs the Gateway in direct and structured Tool Search
modes. It compares provider request payloads, then verifies session logs and
tool flow across both lanes.

The regression proves:

1. Direct mode can call the fake plugin tool.
2. Tool Search can call the same fake plugin tool.
3. Direct mode exposes the fake plugin tool schemas directly to the provider.
4. Tool Search exposes compact structured controls plus any direct-only tools.
5. The Tool Search request payload is smaller for the large fake catalog.
6. Session logs show the expected tool-call counts.
7. Structured mode resolves two queries with one `tool_search` call before the
   selected plugin tool runs through `tool_call`.

### Real-model comparison

```bash
pnpm test:live -- src/agents/tool-search.live.test.ts
```

This opt-in probe uses configured OpenAI credentials; without them it is skipped.
It compares direct exposure, the unset default, and both explicit Tool Search modes with small and large
synthetic catalogs through the OpenClaw runner. A verification code created inside
the target tool proves actual execution. The probe checks policy-denied and
direct-only tools, deferred schemas, and transcript delivery without forcing a
model tool choice. It reports request bytes, discovery and call counts, schema
recovery, and elapsed time. Small catalogs are measured rather than assumed to
benefit from compaction. A successful probe is not a cross-provider reliability
benchmark.

## Failure behavior

Tool Search should fail closed:

- if a tool is not in the effective policy, search should not return it
- if a selected tool becomes unavailable, `tool_call` should fail
- if policy or approval blocks execution, the call result should report that
  block instead of bypassing it

## Related

- [Tools and plugins](/tools)
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools)
- [Exec tool](/tools/exec)
- [ACP agents setup](/tools/acp-agents-setup)
- [Building plugins](/plugins/building-plugins)

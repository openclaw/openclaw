---
summary: "Enable OpenClaw Code Mode, override one model, and recover from tool errors"
title: "Code Mode quickstart"
read_when:
  - You want to enable OpenClaw code mode for an agent run
  - You need the per-agent or per-model override example
  - A code-mode tool call failed and you need the recovery steps
---

## Enable code mode

The recommended path is **Settings → Agents & Tools → Labs → Code Mode**. The
switch takes effect for future agent runs without restarting the Gateway and
selects the `"auto"` tier.

To enable the same tier without the Control UI, set it in config:

```json5
{
  tools: {
    codeMode: "auto",
  },
}
```

To default code mode on for every tool-capable run, regardless of model:

```json5
{
  tools: {
    codeMode: true,
  },
}
```

Object form works too: `tools.codeMode.enabled` accepts the same `false`,
`true`, and `"auto"` values. Code mode stays off when `tools.codeMode` is
omitted, `false`, or an object without an explicit `enabled` value, unless an
agent or model override enables it. Configuring limits or other Code Mode
options does not enable it.

See [Automatic per-model activation](/tools/code-mode/configuration#automatic-per-model-activation) for the
exact semantics and the shipped model list.

If you use sandboxed agents with configured MCP servers, also allow the
bundled MCP plugin in the sandbox tool policy, for example
`tools.sandbox.tools.alsoAllow: ["bundle-mcp"]`. See
[Configuration - tools and custom providers](/gateway/config-tools#mcp-and-plugin-tools-inside-sandbox-tool-policy).

Set explicit limits for tighter bounds:

```json5
{
  tools: {
    codeMode: {
      enabled: true,
      timeoutMs: 10000,
      memoryLimitBytes: 67108864,
      maxOutputBytes: 65536,
      maxSnapshotBytes: 10485760,
      maxPendingToolCalls: 16,
      snapshotTtlSeconds: 900,
      searchDefaultLimit: 8,
      maxSearchLimit: 50,
    },
  },
}
```

## Override one model

Set `codeMode: true` or `codeMode: false` on an exact `provider/model` entry in
`agents.defaults.models`. Omit `codeMode` to inherit the parent activation
setting, including its `"auto"` behavior. The model field accepts only a
boolean; `"auto"` belongs on the global or per-agent `tools.codeMode` setting.
Wildcard rows such as `"openai/*"` may configure runtime policy, but cannot set
`codeMode`; config validation rejects them instead of ignoring the override.

```json5
{
  tools: { codeMode: "auto" },
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.6-luna": {
          agentRuntime: { id: "openclaw" },
          codeMode: true,
        },
      },
    },
    entries: {
      research: {
        models: {
          "openai/gpt-5.6-luna": { codeMode: false },
        },
      },
    },
  },
}
```

The example enables Code Mode for this model except on the `research` agent.
Activation resolves from the first explicit setting in this order:

1. `agents.entries.<agent>.models["provider/model"].codeMode`.
2. `agents.entries.<agent>.tools.codeMode.enabled` (or its boolean/`"auto"` shorthand).
3. `agents.defaults.models["provider/model"].codeMode`.
4. `tools.codeMode.enabled` (or its shorthand), defaulting to `false`.

In the Control UI, open **Settings → Agents → Agent defaults**, show **Advanced**
settings, and find **Models** under **Agent Defaults**. Each model has a
**Code Mode** selector beside its runtime: **Default** removes the override,
**On** saves `true`, and **Off** saves `false`. For agent-specific overrides,
expand **Agent List**, then the agent's **Agent Model Overrides**. Unsupported fields remain
marked for **Raw** editing without hiding the supported settings beside them.

Overrides affect the selected model on future runs, including fallback models;
they do not enable tools on a tool-free run or change runtime selection. The
example separately selects `agentRuntime.id: "openclaw"` because OpenAI routes
may otherwise use Codex. These settings do not control Codex native Code Mode.
Model overrides change activation only; limits still come from the global and
per-agent `tools.codeMode` options.

## What the model does

For a tool with a declared output such as
`Array<{ id: string; paid: boolean; tons: number }>`, one guest program can
select, call, and transform it:

```javascript
const [shipmentTool] = await catalog.search("list shipments");
const shipments = await shipmentTool({});
return shipments.filter((shipment) => !shipment.paid && shipment.tons > 10);
```

Declared output fields may feed later calls in that same `exec`; do not spend a
second `exec` merely inspecting them.

When a quick-index line ends in `-> ?`, the output shape is unknown. The first
`exec` must return the final async tool call unchanged or save its value for a
bounded preview. Do not feed the unknown value into guessed field-dependent
logic in the same program. Inspect the raw value or saved preview, then use a
later `exec` for dependent composition.

## Reuse data across cells

Return an unfamiliar result normally. When a final object or array would exceed
the output or model-result budget, interactive `exec` and `wait` automatically
save it when capacity permits. The completed result contains
`value: { truncated: true, reference: { id, bytes, count, shape, preview, previewTruncated }, guidance }`.
Use that reference's `id` with `results.load(id)` in another cell. Small returned
values keep their ordinary shape; emitted `text` and `json` output is not automatically saved.

Save a fetched result when later steps need to inspect and transform it:

```javascript
const [shipmentTool] = await catalog.search("list shipments");
return await results.save(await shipmentTool({}));
```

Return this descriptor directly as the cell's output. Its preview, shape, and
count are already prepared; the full fetched value stays in saved storage.

The returned reference contains an `id`, encoded JSON `bytes`, `count`, a
sampled `shape`, and a bounded string `preview`. `count` is the top-level array
length, object key count, or 1 for a scalar. Nested array lengths appear in the
sampled view with paths and sampled item indices. The first, middle, and last
items provide observed shapes, including observed heterogeneous values; these
are not schemas or validation guarantees. Discovery visits at most 128 nodes,
five levels, and 16 keys per object, prioritizing the eight largest arrays it
finds. Limited traversal is labeled explicitly. Compact scalar envelope fields
provide context alongside array samples.

Small previews contain the complete JSON. Larger previews describe sampled data
and may themselves be cut to a JSON prefix. `previewTruncated: true` always
means the preview is incomplete. Descriptors fit within 768 encoded JSON bytes;
output and model budgets may shorten their descriptive fields further while
preserving their identity. Load the original JSON before processing full data.

After inspecting those fields, a later cell can reuse the original result:

```javascript
const shipments = await results.load("result_<id from the previous cell>");
return shipments.filter((shipment) => !shipment.paid).length;
```

Every load returns an independent JSON copy. Modifying it does not change the
saved value. Use `await results.delete(id)` to release capacity. Missing or
expired references reject with a catchable error. `API.read("results.d.ts")`
provides TypeScript-style documentation; loaded data is declared as `unknown`,
so inspect its shape before composing it.

References last only for the current agent run and catalog. They survive cell
completion and `wait`, but not run end, abort, catalog replacement, permission
changes, or Gateway restart. They are snapshots: fetch again when current
external state matters. The store holds at most 64 values with a total encoded
JSON allowance of `min(memoryLimitBytes, maxSnapshotBytes)` (10 MiB by default),
separate from the cell inbox. New saves fail when full; existing references are
never evicted automatically. No functions, tool handles, or permissions are saved.
Result operations are unavailable in `restartSafe` cells because references are
transient and deletion cannot be replayed safely.
Automatic preservation is also disabled in headless execution. If capacity,
the data allowance, or the output budget prevents delivering a reference, the
original call remains completed and returns an ordinary truncation marker
explaining that the full result was not retained. Existing references remain
unchanged; no partially saved value is advertised.

## Recover from tool errors

Nested tool failures are ordinary JavaScript errors. Guest code can catch them
and inspect diagnostic fields: `code` identifies `input_contract`,
`output_contract`, `invalid_contract`, `invalid_input`, or `tool_error`;
`location` contains the original guest call-site frames when available.
`effectStatus` remains `"unknown"`: classification is not a dispatch-owner
receipt and never grants retry permission. In particular, a tool can throw an
input error after starting work. Guest code can return the information needed
to choose the next action:

```javascript
try {
  return await terminal({ action: "list" });
} catch (error) {
  return { status: "unavailable", error: error.message };
}
```

For `output_contract`, the tool returned a response that failed its declared
output schema. The error includes up to five validation details, each bounded to
256 UTF-8 bytes plus a truncation marker, with field paths and expected
constraints. The response body is omitted. For example, `receipt.count: must be
number` identifies a malformed count without printing the returned value. Check
current state before retrying: result validation does not undo earlier effects,
and `effectStatus` remains `"unknown"`.

Await every tool call or handle its rejection explicitly. OpenClaw drains
dispatched calls before completing a cell; an unhandled rejection, including
one from an unawaited call or timer callback, fails the cell instead of silently
reporting success. Handlers attached after a suspension still handle their
original promises.

JavaScript syntax errors and uncaught nested tool
failures become failed `exec` or `wait` results. The model can read the error,
correct its code, inspect the current state, and continue with the normal tool
surface. A failed cell does not impose a separate recovery mode or mutation budget.

OpenClaw does not automatically replay a failed program. Earlier calls may have
changed state, and a failed call may have partially applied. Inspect authoritative
state before deciding what remains, and do not repeat completed actions. This
also applies when `wait` resumes a suspended cell: its earlier calls belong to the
same program.

Every subsequent call runs the ordinary hooks and approvals again. Consumed voice
confirmations stay consumed; continuing after an error does not restore a grant.
Cancellation, explicitly terminal tool outcomes, sandbox restrictions, approval
requirements, and tool-policy denials retain their existing behavior.

## Verify the active surface

To confirm the model payload shape while debugging, run the Gateway with
targeted logging:

```bash
OPENCLAW_DEBUG_CODE_MODE=1 \
OPENCLAW_DEBUG_MODEL_TRANSPORT=1 \
OPENCLAW_DEBUG_MODEL_PAYLOAD=tools \
openclaw gateway
```

With code mode active, the logged model-facing tool names should be `exec` and
`wait`. For the full redacted provider payload, add
`OPENCLAW_DEBUG_MODEL_PAYLOAD=full-redacted` for a short debugging session.

## Use Swarm for agent fan-out

[Swarm](/tools/swarm) adds `agents.run()`, `phase()`, and `log()` guest globals
for orchestrating concurrent sub-agents from Code Mode scripts. Swarm is enabled
by default; Code Mode remains separately opt-in through `"auto"` or `true`.
Use normal JavaScript control flow for fan-out, decision gates, and structured
collection.

The Swarm globals, `API.read("agents.d.ts")`, and Swarm prompt hints appear only
when Swarm is enabled and the native OpenClaw `sessions_spawn` tool is present
in the Code Mode catalog and permitted by the run's execution allowlist. An MCP
tool with the same name does not qualify. Code Mode waits for collector results
internally, so `agents.run()` does not require the standalone `agents_wait`
tool. Direct low-level Swarm use requires both tools allowed.

Set `tools.swarm: false` or `tools.swarm.enabled: false` to opt out, globally or
under an agent's `tools`. Engaging Code Mode does not override that opt-out or
grant access to tools denied by policy.

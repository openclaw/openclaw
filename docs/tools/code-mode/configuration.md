---
summary: "Code Mode configuration fields, automatic per-model activation, and the activation order"
title: "Code Mode configuration"
read_when:
  - You are setting Code Mode limits, languages, or the runtime
  - You need the preferred-model list and the compat catalog flag
  - You need the exact activation precedence for a run
---

## Configuration

`tools.codeMode.enabled` sets the global activation default. It defaults to
`false`, including when the Code Mode object configures other fields. Set
`true` or `"auto"` explicitly, or use an [agent or model override](/tools/code-mode/quickstart#override-one-model).

| Field                 | Default                        | Clamp                                           |
| --------------------- | ------------------------------ | ----------------------------------------------- |
| `enabled`             | `false`                        | `false`, `true`, or `"auto"` (per-model)        |
| `runtime`             | `"quickjs-wasi"`               | only supported value                            |
| `mode`                | `"only"`                       | exposes control/direct tools, catalogs the rest |
| `languages`           | `["javascript", "typescript"]` | any subset of the two                           |
| `timeoutMs`           | `10000`                        | `100`-`60000`                                   |
| `memoryLimitBytes`    | `67108864`                     | `1048576`-`1073741824`                          |
| `maxOutputBytes`      | `65536`                        | `1024`-`10485760`                               |
| `maxSnapshotBytes`    | `10485760`                     | `1024`-`268435456`                              |
| `maxPendingToolCalls` | `16`                           | `1`-`128`                                       |
| `snapshotTtlSeconds`  | `900`                          | `1`-`86400`                                     |
| `searchDefaultLimit`  | `8`                            | clamped to `maxSearchLimit`                     |
| `maxSearchLimit`      | `50`                           | `1`-`50`                                        |

`timeoutMs` is a wall-clock budget per `exec` or `wait` call. Worker preparation, guest
computation, and inline tool waits share that budget; approval waits pause it.
The model-facing `exec` description includes the effective limit. Blocking guest
computation that exhausts the budget fails with `timeout`. Unfinished tool calls
can instead return `waiting`, so a later `wait` can resume them with a fresh call
budget. Headless continuations also honor the exact worker-admission budget after
queueing and initialization, alongside their configured slice limit and single
headless wall-clock deadline. A checkpoint does not reset that wall deadline.
When the shell `exec` tool is available, use it for heavier computation
and keep guest JavaScript focused on coordinating tools and processing results.

If code mode is enabled but QuickJS-WASI cannot load, OpenClaw fails closed
for that run; it does not silently expose normal tools as a fallback. This
holds for `true` and for `"auto"` runs where the model resolves as preferred:
an engaged run never silently falls back to broad direct tool exposure.

## Automatic per-model activation

`tools.codeMode.enabled` accepts three values:

- `false` (default): code mode is off unless an agent or model override enables it.
- `true`: code mode engages for tool-capable runs unless an override disables it.
- `"auto"`: code mode engages only when the run's model is flagged as a
  preferred code-mode performer in its provider catalog.

These values supply the default when no agent or model override takes
precedence. `"auto"` uses catalog capability; an explicit per-model boolean
bypasses that capability preference.

### The `compat.codeMode` catalog flag

Provider catalogs can tier a model with `compat.codeMode` on its model entry,
next to flags like `compat.supportsTools`:

- `"preferred"`: the model reliably writes short orchestration programs and
  benefits from the compact code-mode surface; `"auto"` engages code mode.
- `"capable"` (or absent): the model can run code mode when forced with
  `enabled: true`, but `"auto"` keeps normal tool exposure.

Models without tool support cannot use code mode at all; there is no separate
"unsupported" tier. The flag is capability metadata owned by the provider
plugin's catalog; core only reads the generic compat field.

### Shipped preferred models

Bundled provider catalogs currently flag these models as `"preferred"`:

| Provider  | Models                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| anthropic | `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-mythos-5`, `claude-opus-4-8`, `claude-haiku-4-5`                                                   |
| deepseek  | `deepseek-v4-pro`, `deepseek-v4-flash`                                                                                                                           |
| google    | `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.7-flash` |
| kimi      | `k3`, `k3-256k`                                                                                                                                                  |
| minimax   | `MiniMax-M3`                                                                                                                                                     |
| moonshot  | `kimi-k3`                                                                                                                                                        |
| openai    | `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`                                                                              |
| xiaomi    | `mimo-v2.5`                                                                                                                                                      |
| zai       | `glm-5.3`, `glm-5.2`, `glm-5.1`                                                                                                                                  |

Everything else, including all Ollama-served local models, stays unflagged and
keeps normal tool exposure under `"auto"`.

### Models shipped by more than one provider

Several vendors are reachable through more than one provider id: a subscription
endpoint next to an API endpoint, or a gateway that resells another vendor's
model. Because `"auto"` resolves the tier from whichever catalog served the run,
two catalogs describing the same upstream model must not disagree by accident.

Every catalog row for a shared model therefore states its tier explicitly once
any sibling row states one. Rows are matched on the vendor's own name for the
weights, so a catalog that republishes a model under a namespaced id or
different casing is matched automatically: `novita/moonshotai/kimi-k3`,
`nvidia/z-ai/glm-5.2`, and `together/deepseek-ai/DeepSeek-V4-Pro` all group with
the first-party rows without anyone declaring anything. Only genuinely different
names need the manifest's `upstreamModel` marker, as the `kimi` catalog uses for
`moonshot/kimi-k3`.

Reseller and aggregator catalogs such as `baseten`, `deepinfra`,
`github-copilot`, `gmi`, `novita`, `nvidia`, `ollama-cloud`, `opencode`,
`opencode-go`, `qianfan`, `together`, `venice`, and `volcengine-plan` currently
declare `"capable"` for the models first-party catalogs flag `"preferred"`: the
preferred tier came from evaluations on the first-party endpoints, and those
runs have not been repeated per reseller. Promoting one of those rows is a
deliberate, evidence-backed change rather than an oversight.

For OpenAI models, the flag matters only when the run resolves to the OpenClaw
embedded agent runtime. Default OpenAI routing uses the Codex-style harness
surface, where OpenClaw code mode does not apply; the catalog flag never
changes that routing decision.

### Choosing when to enable

In A/B evaluations on the preferred models above, code mode reduced total
token usage by roughly 30-50% at equal-or-better task pass rates, mostly by
replacing many full tool schemas and per-tool round trips with one compact
program surface. Models below the preferred tier showed no consistent win and
sometimes regressed, which is why `"auto"` leaves them on direct tools.

Use `"auto"` when agents switch between models: strong models get the compact
surface, weaker or local ones keep the exposure they handle best. Use `true`
on an exact model entry when you have verified an unflagged model performs well
with code mode. For open-weight or uncached serving where every prompt token is billed or
recomputed, prefer enabling per model (via `"auto"` or an explicit model override)
rather than globally, since the token savings depend on the model actually
using the program surface well.

## Activation

Code mode is evaluated after the effective tool policy is known and before the
final model request is assembled:

1. Resolve the agent, model, provider, sandbox, channel, sender, and run
   policy.
2. Build the effective OpenClaw tool list, adding eligible plugin, MCP, and
   client tools.
3. Apply allow/deny policy.
4. Resolve activation using the [agent and model precedence](/tools/code-mode/quickstart#override-one-model).
   If it is `false`, or `"auto"` and the run's model is not catalog-preferred,
   continue with normal tool exposure.
5. If enabled and tools are active for the run, retain required direct-only
   tools and register every catalog-eligible effective tool in the code-mode
   catalog.
6. Remove the cataloged tools from the model-visible list; add `exec` and
   `wait` alongside the retained direct-only tools.

Runs that intentionally have no tools (raw model calls, `disableTools: true`,
or an empty `tools.allow` list) do not activate the code-mode surface even
when `tools.codeMode.enabled: true` is configured. Code mode and OpenClaw Tool
Search are mutually exclusive for a run; if code mode activates, Tool Search's
compaction does not.

The code-mode catalog is run-scoped and must not leak tools from another
agent, session, sender, or run.

---
summary: "What experimental flags mean in OpenClaw and which ones are currently documented"
title: "Experimental features"
read_when:
  - You see an `.experimental` config key and want to know whether it is stable
  - You want to try preview runtime features without confusing them with normal defaults
  - You want one place to find the currently documented experimental flags
---

Experimental features are preview surfaces controlled by config flags. They need more real-world mileage before their shape and behavior become long-lived contracts.

- Off by default unless the feature docs state otherwise.
- Shape and behavior can change faster than stable config.
- Prefer a stable path when one already exists.
- Roll out broadly only after testing in a smaller environment first.

All [plugin APIs](/plugins/sdk-overview#api-stability) are also experimental.
That stability label does not require a Labs switch for ordinary plugins; the
Custom plugin UI flag below controls user-installed native browser code only.

## Currently documented flags

| Surface          | Key                                                                     | Use it when                                                                                                                       | More                                                                                   |
| ---------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Codex harness    | `plugins.entries.codex.config.appServer.experimental.sandboxExecServer` | You want native Codex app-server 0.143.0 or newer to target an OpenClaw sandbox-backed exec-server instead of disabling Code Mode | [Codex harness reference](/plugins/codex-harness-reference#sandboxed-native-execution) |
| Code Mode        | `tools.codeMode.enabled`                                                | You want compact code-orchestrated access to a hidden OpenClaw tool catalog                                                       | [Code Mode](/tools/code-mode)                                                          |
| Cloud workers    | `cloudWorkers.desktop`                                                  | You want to watch or control desktop-capable cloud worker environments from the Control UI                                        | [Cloud Worker Desktop](/gateway/cloud-workers#desktop-interactive)                     |
| Custom plugin UI | `gateway.controlUi.experimental.customPlugins`                          | You want trusted user-installed plugins to add native Control UI views or replace built-in views                                  | [Feature plugins](/plugins/feature-plugins#enable-custom-plugin-ui)                    |
| Host Desktop     | `desktop.host.enabled`                                                  | You want to watch or control the Gateway host through its VNC or Screen Sharing server                                            | [Desktop](/gateway/configuration-reference#desktop)                                    |
| Tool Search      | `tools.toolSearch.enabled`                                              | You want to control the global Tool Search default, which is enabled                                                              | [Tool Search](/tools/tool-search)                                                      |

## Control UI Labs

Open **Settings → Labs** to manage experiments that have a
Control UI switch. Enabling or disabling a lab patches the canonical Gateway
config immediately without restarting the Gateway.

Labs includes Decision assistance, Code Mode, Tool Search for all models, Custom
plugin UI, Host Desktop, and Cloud Worker Desktop. Under the default reload mode, custom
plugin views and desktop availability update in connected Control UI pages.
Code Mode and Tool Search changes take effect for future agent runs.
Reload browser tabs after disabling Custom plugin UI to clear plugin JavaScript
that already ran. The Cloud Worker Desktop lab controls access to existing
desktop-capable workers; changing a profile's `settings.desktop` affects only
newly provisioned workers.

Custom plugin UI is off by default. Enabled bundled plugins, including
Workboard, retain their native UI with the setting off. Backend APIs and
ordinary plugins remain available, and installing or approving a plugin
artifact does not enable the lab.

Code Mode remains disabled until you turn on its Labs switch or explicitly set
`tools.codeMode` to `true` or `"auto"`. The Labs switch writes `"auto"`, so it
engages only for models marked as preferred Code Mode performers; it does not
force Code Mode on for every model.

Tool Search is enabled by default when `tools.toolSearch` is unset.
Turning its Labs switch off disables the global default; turning it on restores
that default.

## Decision assistance

This opt-in enables experimental conversational tool filtering in the built-in
OpenClaw runtime. Before an eligible user turn, the configured Decision provider
judges whether the request needs tools. A conversational result can omit optional
tools for that turn. Other harnesses keep their normal tools and perform no
automatic prefilter inference. The switch does not select a provider, provision
credentials, download models, or enable unrelated consumer modes.

The switch and manually authored config use the same global Boolean:

```json5
{
  agents: {
    defaults: {
      experimental: { decisionAssistance: true },
    },
  },
}
```

The default is **off**. Only explicit `true` opts in; omission, `false`, or
unrelated experimental options do not. Objects such as
`decisionAssistance: { enabled: true }` are invalid. Turning the Labs switch off
removes its override and restores off, preserving model selections and sibling
settings. There is no browser-local preference.

Saved opt-in is not per-agent eligibility. Automatic consumers also need
an effective [Decision model](/concepts/decision-models) for their owning agent.
An unset agent model inherits `agents.defaults.decisionModel`; an explicit empty
`agents.entries.<id>.decisionModel` disables eligibility for that agent. A model
selection alone never opts in. The global switch does not mean every agent is
eligible, nor that a configured provider is ready. Without a model, the on
preference remains saved and no automatic Decision inference can run.

The explicit `decision_evaluate` tool is independent of Labs under its normal
model-selection and tool-policy contract. Labs does not gate the shared Decision
runtime or provider registration, and it never grants permission for actions.

### Core consumer contract

Core implementations can import
`isDecisionAssistanceEligible(config: OpenClawConfig, agentId: string): boolean`
from `src/agents/decision-assistance.ts`. Supply prepared config and the trusted
owning agent ID, not a model-provided ID. The helper returns exactly
`decisionAssistance === true && resolveDecisionModelSetting(config, agentId) !== undefined`.
It performs no provider probes, secret resolution, file reads, network requests,
model loading, or inference, and returns no provider-readiness diagnostics.
This is an internal foundation boundary, not a new plugin SDK surface.

For example, at an automatic consumer boundary:

```ts
import { isDecisionAssistanceEligible } from "./decision-assistance.js";

if (!isDecisionAssistanceEligible(preparedConfig, owningAgentId)) {
  return existingBaseline;
}
// Separately check this consumer’s explicit mode, harness support, and authority
// before loading its optional implementation or preparing evaluation evidence.
```

Use the existing config publication/refresh lifecycle, not file polling.
Consumers must stop admitting automatic work after opt-out takes effect and
revalidate current config, model selection, and live authority before applying
awaited results. This helper is not an authority token or a cancellation owner.

### Conversational tool filtering

**Upgrade behavior:** the existing saved `decisionAssistance: true` is opt-in
intent for future automatic Decision experiments. When this consumer is installed,
it can run on eligible turns for an agent with an effective Decision model; the
preference does not select a new provider or grant tool authority. Operators who
do not want automatic evaluation can turn the preference off or clear that
agent’s Decision model. The transferred evidence and costs are described below.

The prefilter sends the complete current request and a deterministic, bounded
projection of recent conversation to the owning agent’s configured Decision
provider. It retains the nearest complete user/assistant exchange and, when it
fits, one additional exchange in chronological order. Resolved output from
ordinary `before_prompt_build` hooks is also sent verbatim in labeled fields when
present: `prependContext`, `appendContext`, `systemPrompt`,
`prependSystemContext`, and `appendSystemContext`. Two internal text bounds apply:

- The latest request plus retained user/assistant exchange text is limited to
  **6,000 UTF-16 code units**. Only whole older exchanges may be omitted.
- That conversation text plus all five verbatim hook-field values must fit
  **8,000 UTF-16 code units** in total. Oversized hook fields are not truncated.

These are JavaScript string-length bounds on the evidence text, not a bound on
serialized JSON, UTF-8 wire bytes, or tokens. Field names, JSON escaping, omission
facts, tool-result counts, and the fixed rubric add serialization overhead.
The current request and essential context are never cut to force classification;
oversized, malformed, missing, or otherwise unsuitable essential context retains
normal tools. A genuinely fresh session is
evaluated using the current request alone. Existing incomplete history is not
treated as a fresh session; missing referents and uncertainty must retain tools.

Only user-visible text, counts of returned/failed tool calls, and the listed
resolved ordinary hook fields are secondary evidence. Other system/developer
instructions, hidden reasoning, raw tool arguments or results, internal-event
envelopes, and media are not sent. Tool return counts do not assert that an
action succeeded. Hosted providers receive this bounded evidence and can incur
charges; local providers keep inference local.
Classification adds work before the primary model request and is not a guaranteed
latency improvement.

The current internal budget is 500 ms, not a configuration option. One existing
Decision batch asks two independent Boolean questions: whether the latest request
has an unresolved contextual reference, and whether fulfilling it requires tools
in the next response. Both probabilities must be below 0.35 to omit optional tools.
Missing, affirmative, or uncertain answers preserve tools. These are probabilities
of yes, not degrees of tool use or separate confidence values.

The structured state names the latest request, chronological recent exchanges,
and facts about omitted older conversation and raw tool payloads. Each question
references those fields explicitly. Earlier mentions of tools do not by themselves
request new actions, and omitted older history alone does not veto filtering.
This follows [TypeSafe atomic Noul guidance](https://docs.typesafe.ai/primitives/noul)
while using the provider-neutral Decision contract; it makes no provider-specific
requests or calibrated-correctness guarantees. There is
no model-aware input estimator, automatic trimming retry, or second provider.
Ordinary unavailable results, including a deadline or actual provider input
rejection, keep the normal tool surface. A caller-budget deadline does not count
as a provider outage or open the shared health circuit, so repeated optional
prefilter timeouts do not disable explicit `decision_evaluate` requests. Genuine
provider transport, authentication, and rate-limit failures retain their shared
health handling; in-flight work still owns its concurrency slot until it settles.
Cancellation, closed authority, and contract errors
remain errors rather than starting fallback work. Cold model loading may exceed
the budget. Classifier estimates are not guarantees that every action request
will retain its optional tools.

Filtering skips raw probes, continuations, internal events, queued steering,
orphan repair, pending tool work, hook-set `toolsAllow` restrictions, and
authority-dependent prompt-build hooks that require finalized tools. Ordinary
prompt-build hooks run normally and their resolved fields can inform the Decision
evaluation without changing the public hook contract. It no longer rejects a
turn merely because prior assistant or tool messages exist. Complete contextual
approvals remain action requests, while a conversational acknowledgment can omit
optional tools on later turns. It uses the existing host tool policy, preserves
already-required tools without granting denied tools, and keeps submitted schemas,
discovery, and callability aligned.
Each subsequent turn starts from its own normal tool baseline. Revoked opt-in or
changed model selection prevents applying an awaited restriction. Eligibility is
also rechecked at foreground provider dispatch after awaited preparation; a late
change withdraws only the optional restriction and restores the current permitted
tool surface while retaining independent hook caps and required tools. No historical
transcript is rewritten and no native thread is recreated.

With DEBUG logging enabled for the embedded runner, a safe record at the first
foreground primary dispatch reports decision status/reason, decision latency,
context counts and omission flags, visible tool counts, required tools retained,
and the before/after normalized tool-definition JSON UTF-16 character difference
(`name`, `description`, and `parameters`). Tool Search and Code Mode count only
the actually exposed controls/direct tools, including their descriptions—not
every hidden catalog schema. This schema-only metric is not provider wire bytes,
full prompt savings, tokens, cost, or proof that a provider accepted the request.
Tool-related prompt guidance is reported as unmeasured. Unknown measurements
remain unknown, not zero. DEBUG-off avoids the extra definition serialization.
No conversation, tool payloads, full schemas, or credentials are logged by this
record; existing logging and trace-correlation controls apply.

## Local model lean mode

Lean mode is an advanced troubleshooting override, configured outside Labs.
Its existing `experimental.localModelLean` keys remain supported. See
[Local model lean mode](/gateway/local-models#local-model-lean-mode) for capability
restrictions, config examples, and recovery guidance.

- <a id="why-these-tools" />[Why these tools](/gateway/local-models#why-these-tools)
- <a id="when-to-turn-it-on" />[When to turn it on](/gateway/local-models#when-to-turn-it-on)
- <a id="when-to-leave-it-off" />[When to leave it off](/gateway/local-models#when-to-leave-it-off)
- <a id="enable" />[Enable](/gateway/local-models#enable)

## Experimental does not mean hidden

An experimental feature should say so plainly in docs and in the config path itself, not hide behind a stable-looking default knob.

## Related

- [Features](/concepts/features)
- [Release channels](/install/development-channels)

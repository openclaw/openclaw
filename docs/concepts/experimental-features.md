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
That stability label does not require a Labs switch. Native plugin UI is
available by default for enabled plugins; the existing config-only
[advanced opt-out](/plugins/feature-plugins#enable-custom-plugin-ui) remains
available for user-installed browser code.

## Currently documented flags

| Surface        | Key                                                                     | Use it when                                                                                                                       | More                                                                                   |
| -------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Codex harness  | `plugins.entries.codex.config.appServer.experimental.sandboxExecServer` | You want native Codex app-server 0.143.0 or newer to target an OpenClaw sandbox-backed exec-server instead of disabling Code Mode | [Codex harness reference](/plugins/codex-harness-reference#sandboxed-native-execution) |
| Code Mode      | `tools.codeMode.enabled`                                                | You want compact code-orchestrated access to a hidden OpenClaw tool catalog                                                       | [Code Mode](/tools/code-mode)                                                          |
| Cloud workers  | `cloudWorkers.desktop`                                                  | You want to watch or control desktop-capable cloud worker environments from the Control UI                                        | [Cloud Worker Desktop](/gateway/cloud-workers#desktop-interactive)                     |
| Templates      | `gateway.controlUi.experimental.templates`                              | You want to explore and add official ClawHub agents from the Control UI                                                           | [Templates](/cli/templates)                                                            |
| Host Desktop   | `desktop.host.enabled`                                                  | You want to watch or control the Gateway host through its VNC or Screen Sharing server                                            | [Desktop](/gateway/configuration-reference#desktop)                                    |
| Advisor        | `plugins.entries.advisor.enabled`                                       | You want an advisor model to periodically check a conversation's agent work and give the agent one short correction               | [Advisor](#advisor)                                                                    |
| Speech bubbles | `gateway.controlUi.experimental.chatBubbles`                            | You want to try conversation bubbles and compact activity; Home defaults on while the lab is enabled                              | [Chat](/web/control-ui/chat)                                                           |
| Tool Search    | `tools.toolSearch.enabled`                                              | You want to control the global Tool Search default, which is enabled                                                              | [Tool Search](/tools/tool-search)                                                      |

## Control UI Labs

Open **Settings → Labs** to manage experiments that have a
Control UI switch. Enabling or disabling a lab patches the saved Gateway
config immediately without restarting the Gateway.

Labs includes Speech bubbles, Decision assistance, Advisor, Code Mode, Tool Search for all models,
Templates, Host Desktop, and Cloud Worker Desktop. Under the default reload mode,
desktop availability updates in connected Control UI pages. Code Mode and Tool
Search changes take effect for future agent runs. The Cloud Worker Desktop lab
controls access to existing desktop-capable workers; changing a profile’s
`settings.desktop` affects only newly provisioned workers.

Custom plugin UI has graduated from Labs. Enabled plugins can load native UI
by default, while an existing explicit
`gateway.controlUi.experimental.customPlugins: false` stays off. The historical
config path remains an advanced opt-out, not a Labs requirement. It does not
disable bundled views or backend operations.

Templates is off by default. Turning it on permits official starter discovery and
Add in Agents, Gateway catalog/Add methods, and local CLI Add. Add creates an
ordinary agent and installs its requirements; repeating Add creates another
agent. Turning the switch off blocks new Add operations, but existing agents
continue running. Local project authoring and inspection do not require the
switch. An Add already admitted before the switch changes can finish safely.

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
It performs no provider checks, secret resolution, file reads, network requests,
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
Consumers check opt-in again at Decision provider dispatch, after awaited
preparation. Disabling assistance stops subsequent evaluations from starting;
already-dispatched evaluations may finish, including provider preparation and
network I/O, and their results may still be used. Model selection, live authority,
cancellation, deadlines, and provider/credential validity remain independently
checked. This helper is not an authority token or a cancellation owner.

### Conversational tool filtering

**Upgrade behavior:** the existing saved `decisionAssistance: true` is opt-in
intent for future automatic Decision experiments. When this consumer is installed,
it can run on eligible turns for an agent with an effective Decision model; the
preference does not select a new provider or grant tool authority. Operators who
do not want automatic evaluation can turn the preference off or clear that
agent’s Decision model. The transferred evidence and costs are described below.

The prefilter sends the complete current request and a rule-based, bounded
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
in the next response. Both probabilities must be below 0.35 to omit optional tools. The context question
checks for a referent needed to fulfill the current request, not merely for
additional background. A conversational acknowledgment of completed work that
requests nothing further does not itself require a missing referent.
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

Filtering skips raw checks, continuations, internal events, queued steering,
orphan repair, pending tool work, hook-set `toolsAllow` restrictions, and
authority-dependent prompt-build hooks that require finalized tools. Ordinary
prompt-build hooks run normally and their resolved fields can inform the Decision
evaluation without changing the public hook contract. It no longer rejects a
turn merely because prior assistant or tool messages exist. Complete contextual
approvals remain action requests, while a conversational acknowledgment can omit
optional tools on later turns. It uses the existing host tool policy, preserves
already-required tools without granting denied tools, and keeps submitted schemas,
discovery, and callability aligned.
Each subsequent turn starts from its own normal tool baseline. Opt-out or a changed
Decision model does not withdraw a restriction from an already-dispatched
evaluation. Those settings apply to the next evaluation; live permissions still
govern the current turn. No historical transcript is rewritten and no native
thread is recreated.

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

## Advisor

Advisor is an experimental bundled plugin that is off by default. It watches
user-directed work and steps in while the agent goes off course: repeating
failing steps, waiting on finished work, working around a blocker it could fix,
drifting beyond what you asked, or claiming results the tools do not show.

A review forks the conversation on the session's own model and asks whether the
agent is on track. When it is not, Advisor steers the active run with one short
correction, which the agent sees before its next step under the run's own
permissions. If the run already ended, the correction is dropped. When the agent
is on track, nothing happens.

Turn it on in **Settings → Agents & Tools → Labs → Advisor**. Its **Configure**
button opens the plugin's settings page (**Settings → Plugins → Advisor**), where
you set the options below. Or use config:

```json5
{
  plugins: {
    entries: {
      advisor: {
        enabled: true,
        config: { everyToolCalls: 10, everyMinutes: 20 },
      },
    },
  },
}
```

- `everyToolCalls` (default `10`, range `0`–`1000`): review after this many tool
  calls in a conversation.
- `everyMinutes` (default `20`, range `0`–`1440`): review after this many minutes
  of work in a run, checked when a tool starts.
- `reviewInstructions` (optional, up to 4,000 characters): replaces the built-in
  definition of "off course". Changes apply to the next review.

Set both triggers to `0` to turn reviews off.

Behavior and limits:

- Only user-triggered runs are reviewed. Heartbeat, cron and other automatic
  runs are not.
- A due review waits until every running tool call has its result, so the fork
  never sees a missing or synthetic tool outcome. A stalled call delays the
  review rather than forcing it.
- Each conversation has at most one review in flight. The run ending, a new user
  message, session reset, plugin disable, or service stop cancels it.
- Reviews use the session's model, context and credentials. The fork cannot run
  tools or send replies. Corrections are labeled as advice the agent must check
  before acting.
- Advisor needs conversation access and prompt injection permission through
  `plugins.entries.advisor.hooks`, which trusted plugins have by default.
- Gateway info logs record review token usage and whether a correction steered
  the run.

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

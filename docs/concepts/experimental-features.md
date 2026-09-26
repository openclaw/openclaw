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

This Labs entry gates automatic Decision consumers, including optional
[Auto steering](/concepts/queue-steering#auto-steering). Turning it on does not
start inference, enable the browser Auto preference, select a provider, provision
credentials, or download models.

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
settings. This global gate is separate from each consumer preference; Auto
steering additionally has a default-off browser preference.

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

For example, at a future automatic consumer boundary:

```ts
import { isDecisionAssistanceEligible } from "./decision-assistance.js";

if (!isDecisionAssistanceEligible(preparedConfig, owningAgentId)) {
  return existingBaseline;
}
// Separately check this consumer’s explicit mode, harness support, and authority
// before loading its optional implementation or preparing evaluation evidence.
```

Use the existing config publication/refresh lifecycle, not file polling. Future
consumers must stop admitting automatic work after opt-out takes effect and
revalidate current config, model selection, and live authority before applying
awaited results. This helper is not an authority token or a cancellation owner.

Any future consumer must document its evidence transfer, costs, latency, and
failure behavior. Hosted evaluations send selected evidence to the configured
provider and can incur charges; this foundation sends no evidence and makes no
performance or quality claims.

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

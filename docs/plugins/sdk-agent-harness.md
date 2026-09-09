---
summary: "Experimental SDK surface for plugins that replace the low level embedded agent executor"
title: "Agent harness plugins"
sidebarTitle: "Agent Harness"
read_when:
  - You are changing the embedded agent runtime or harness registry
  - You are registering an agent harness from a bundled or trusted plugin
  - You need to understand how the Codex plugin relates to model providers
---

An **agent harness** is the low level executor for one prepared OpenClaw agent
turn. It is not a model provider, not a channel, and not a tool registry. For
the user-facing mental model, see [Agent runtimes](/concepts/agent-runtimes).

Use this surface only for bundled or trusted native plugins. The contract is
still experimental because the parameter types intentionally mirror the
current embedded runner.

## When to use a harness

Register an agent harness when a model family has its own native session
runtime and the normal OpenClaw provider transport is the wrong abstraction:

- a native coding-agent server that owns threads and compaction
- a local CLI or daemon that must stream native plan/reasoning/tool events
- a model runtime that needs its own resume id in addition to the OpenClaw
  session transcript

Do **not** register a harness just to add a new LLM API. For normal HTTP or
WebSocket model APIs, build a [provider plugin](/plugins/sdk-provider-plugins).

## Where each section moved

Every section of the single-page version now lives on this page or on one of the
eight child pages below. The anchors from the single-page version still resolve here.

### Core ownership contract

[Agent harness core ownership](/plugins/sdk-agent-harness/core-ownership) — What core prepares before `runAttempt`, and the tool-policy, auth-bootstrap, session-ownership, and request-transport contracts a harness can declare.

- <a id="what-core-still-owns"></a>[What core still owns](/plugins/sdk-agent-harness/core-ownership#what-core-still-owns)
- <a id="native-tool-policy-enforcement"></a>[Native tool-policy enforcement](/plugins/sdk-agent-harness/core-ownership#native-tool-policy-enforcement)
- <a id="harness-owned-auth-bootstrap"></a>[Harness-owned auth bootstrap](/plugins/sdk-agent-harness/core-ownership#harness-owned-auth-bootstrap)
- <a id="bound-native-session-ownership"></a>[Bound native session ownership](/plugins/sdk-agent-harness/core-ownership#bound-native-session-ownership)
- <a id="verified-setup-runtime-artifacts"></a>[Verified setup runtime artifacts](/plugins/sdk-agent-harness/core-ownership#verified-setup-runtime-artifacts)
- <a id="request-transport-contract"></a>[Request-transport contract](/plugins/sdk-agent-harness/core-ownership#request-transport-contract)
- <a id="per-turn-temporal-context"></a>[Per-turn temporal context](/plugins/sdk-agent-harness/core-ownership#per-turn-temporal-context)

### Harness registration

[Register an agent harness](/plugins/sdk-agent-harness/registration) — The `AgentHarnessV2` registration example, plus the optional isolated-completion and delegated-execution capabilities.

- <a id="register-a-harness"></a>[Register a harness](/plugins/sdk-agent-harness/registration#register-a-harness)
- <a id="isolated-completion"></a>[Isolated completion](/plugins/sdk-agent-harness/registration#isolated-completion)
- <a id="delegated-execution"></a>[Delegated execution](/plugins/sdk-agent-harness/registration#delegated-execution)

### Harness selection and provider pairing

[Agent harness selection policy](/plugins/sdk-agent-harness/selection-policy) — How OpenClaw picks a harness after provider and model resolution, and why a harness normally ships with a provider plugin.

- <a id="selection-policy"></a>[Selection policy](/plugins/sdk-agent-harness/selection-policy#selection-policy)
- <a id="provider-plus-harness-pairing"></a>[Provider plus harness pairing](/plugins/sdk-agent-harness/selection-policy#provider-plus-harness-pairing)

### Attempt runtime helpers

[Agent harness attempt runtime](/plugins/sdk-agent-harness/attempt-runtime) — Guarded input injection, tool-result middleware, terminal outcome classification, live token usage, and agent-end side effects.

- <a id="guarded-active-run-injection"></a>[Guarded active-run injection](/plugins/sdk-agent-harness/attempt-runtime#guarded-active-run-injection)
- <a id="tool-result-middleware"></a>[Tool-result middleware](/plugins/sdk-agent-harness/attempt-runtime#tool-result-middleware)
- <a id="terminal-outcome-classification"></a>[Terminal outcome classification](/plugins/sdk-agent-harness/attempt-runtime#terminal-outcome-classification)
- <a id="live-output-token-usage"></a>[Live output-token usage](/plugins/sdk-agent-harness/attempt-runtime#live-output-token-usage)
- <a id="agent-end-side-effects"></a>[Agent-end side effects](/plugins/sdk-agent-harness/attempt-runtime#agent-end-side-effects)

### User input and execution authority

[Agent harness user input and execution authority](/plugins/sdk-agent-harness/user-input-and-execution) — Blocking user-input surfaces, host tool capabilities, exec reviewer outcomes, and paired-device command authority.

- <a id="user-input-and-tool-surfaces"></a>[User input and tool surfaces](/plugins/sdk-agent-harness/user-input-and-execution#user-input-and-tool-surfaces)
- <a id="exec-reviewer-outcomes"></a>[Exec reviewer outcomes](/plugins/sdk-agent-harness/user-input-and-execution#exec-reviewer-outcomes)
- <a id="paired-device-execution"></a>[Paired-device execution](/plugins/sdk-agent-harness/user-input-and-execution#paired-device-execution)

### Native inventories

[Agent harness native inventories](/plugins/sdk-agent-harness/native-inventories) — Read-only native model rows and MCP tool catalogs reported from a harness's own runtime.

- <a id="native-model-inventory"></a>[Native model inventory](/plugins/sdk-agent-harness/native-inventories#native-model-inventory)
- <a id="native-mcp-inventory"></a>[Native MCP inventory](/plugins/sdk-agent-harness/native-inventories#native-mcp-inventory)

### Runtime configuration

[Agent harness runtime configuration](/plugins/sdk-agent-harness/runtime-config) — Native Codex harness mode and strict provider, model, or per-agent runtime policy.

- <a id="native-codex-harness-mode"></a>[Native Codex harness mode](/plugins/sdk-agent-harness/runtime-config#native-codex-harness-mode)
- <a id="runtime-strictness"></a>[Runtime strictness](/plugins/sdk-agent-harness/runtime-config#runtime-strictness)

### Sessions and results

[Agent harness sessions and results](/plugins/sdk-agent-harness/sessions-and-results) — Native session bindings and the transcript mirror, plus tool, media, terminal-outcome, and settled-turn results.

- <a id="native-sessions-and-transcript-mirror"></a>[Native sessions and transcript mirror](/plugins/sdk-agent-harness/sessions-and-results#native-sessions-and-transcript-mirror)
- <a id="tool-and-media-results"></a>[Tool and media results](/plugins/sdk-agent-harness/sessions-and-results#tool-and-media-results)
- <a id="terminal-tool-outcomes"></a>[Terminal tool outcomes](/plugins/sdk-agent-harness/sessions-and-results#terminal-tool-outcomes)
- <a id="settled-tool-finalization"></a>[Settled tool finalization](/plugins/sdk-agent-harness/sessions-and-results#settled-tool-finalization)

## Current limitations

- The public import path is generic, but some attempt/result type aliases
  still carry legacy names for compatibility.
- Third-party harness installation is experimental. Prefer provider plugins
  until you need a native session runtime.
- Harness switching is supported across turns. Do not switch harnesses in the
  middle of a turn after native tools, approvals, assistant text, or message
  sends have started.

## Related

- [SDK Overview](/plugins/sdk-overview)
- [Runtime Helpers](/plugins/sdk-runtime)
- [Provider Plugins](/plugins/sdk-provider-plugins)
- [Codex Harness](/plugins/codex-harness)
- [Model Providers](/concepts/model-providers)

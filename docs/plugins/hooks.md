---
summary: "Plugin hooks: intercept agent, tool, message, session, and Gateway lifecycle events"
title: "Plugin hooks"
doc-schema-version: 1
read_when:
  - You are building a plugin that needs before_tool_call, before_agent_reply, message hooks, or lifecycle hooks
  - You need to block, rewrite, or require approval for tool calls from a plugin
  - You are deciding between internal hooks and plugin hooks
  - You are projecting OpenClaw cron wakes into an external host scheduler
---

Plugin hooks let a native OpenClaw plugin observe or change agent runs, tool
calls, message delivery, and lifecycle events. Register a typed handler with
`api.on("hook_name", handler)` and return the result documented for that hook.

There are three different hook systems:

| You want to…                                                                        | Use                                                                                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Change prompts, gate tools, customize replies, or integrate plugin lifecycle        | Typed plugin hooks on this page: `api.on("before_tool_call", ...)`                                              |
| Run an operator-installed script for `/new`, `/reset`, `/stop`, or bootstrap events | [Internal hooks](/automation/hooks): `HOOK.md` and colon event names such as `command:new` or `agent:bootstrap` |
| Trigger an agent from an external service over HTTP                                 | [Webhooks](/automation/cron-jobs#webhooks): Gateway HTTP endpoints                                              |

Plugins can also register internal hooks with `api.registerHook(...)`. That is
not the typed API: registering an underscore name such as `before_tool_call`
there produces a warning, and the typed runner never invokes that registration.
Use `api.on(...)` for every hook in the [hook
catalog](/plugins/hooks/reference#hook-catalog).

## Quick start

This example replies to a user message containing `hook-demo-check` without
calling the model.
It assumes you already have a working Gateway and can send it a normal chat
message. For package metadata, publishing, and install options, see
[Building plugins](/plugins/building-plugins) and [Plugin manifest](/plugins/manifest).

Create a local `hook-demo` directory with these files:

```json package.json
{
  "name": "hook-demo",
  "version": "1.0.0",
  "type": "module",
  "openclaw": { "extensions": ["./index.ts"] }
}
```

```json openclaw.plugin.json
{
  "id": "hook-demo",
  "name": "Hook Demo",
  "activation": { "onStartup": true },
  "configSchema": { "type": "object", "additionalProperties": false }
}
```

```typescript index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "hook-demo",
  name: "Hook Demo",
  description: "Reply to a hook check without a model call.",
  register(api) {
    api.on(
      "before_agent_reply",
      (event) => {
        if (event.cleanedBody.includes("hook-demo-check")) {
          return { handled: true, reply: { text: "Hook is working." } };
        }
      },
      { eligibleTriggers: ["user"] },
    );
  },
});
```

Review local plugin code before loading it: native plugins run in the Gateway
process. Link and enable the directory (`--force` acknowledges installing from
a local source):

```bash
openclaw plugins install --link ./hook-demo --force
openclaw plugins enable hook-demo
```

Grant this plugin access to conversation hooks in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "hook-demo": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

Merge that entry into your existing config, then let the default hybrid reload
mode apply it and inspect:

```bash
openclaw plugins inspect hook-demo --runtime --json
```

Send `hook-demo-check` as a normal chat message. Expect `Hook is working.`; other
messages continue through the normal agent path. If the hook does not run,
see [Troubleshooting](/plugins/hooks#troubleshooting).

Despite its name, `cleanedBody` is the prepared run prompt and can contain
channel context. The example matches a distinctive marker instead of assuming
the field is only the sender's raw text.

### Permissions and scope

Hook registration does not bypass plugin loading rules. The plugin must be
loaded and enabled; `plugins.enabled`, `plugins.allow`, and `plugins.deny` still
apply. Restart the Gateway after changing plugin code. With the default hybrid
reload mode, hook policy changes hot-reload the existing plugin runtime.

- Non-bundled plugins need explicit
  `plugins.entries.<id>.hooks.allowConversationAccess: true` for
  `before_model_resolve`, `agent_turn_prepare`, `before_prompt_build`,
  `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`,
  `agent_end`, and `before_agent_run`. Bundled plugins are allowed unless this
  option is explicitly `false`.
- `allowPromptInjection: false` blocks `agent_turn_prepare`,
  `before_prompt_build`, `heartbeat_prompt_contribution`, and durable next-turn
  injections. It defaults to allowed, but does not grant conversation access.
  The first two hooks therefore need both permissions.
- These are specific registration gates, not a sandbox or a universal filter
  for every hook that can see message data. Install only plugins you trust.

A typed handler receives `(event, ctx)`. The event describes the operation;
the second argument carries hook-specific context. Fields such as
`ctx.agentId`, `ctx.sessionKey`, and `ctx.runId` are optional on many hooks and
may be absent for the emitting path. A registration is not automatically
scoped to one agent or session: check the context in your handler when needed.

Read your plugin's resolved settings from `api.pluginConfig` inside the
registration closure. Typed hooks do not receive a universal
`event.context.pluginConfig` field; that field belongs to the internal
`api.registerHook(...)` event contract.

### Choose a hook

| Task                                               | Hook                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Reply without a model call                         | `before_agent_reply` → `{ handled: true, reply }`; omit `reply` for silence |
| Add context or narrow tools for a turn             | `before_prompt_build`                                                       |
| Gate model input on a supported runner             | `before_agent_run` → `{ outcome: "block", reason, message? }`               |
| Block a tool or request approval                   | `before_tool_call`                                                          |
| Rewrite the full outgoing reply, including media   | `reply_payload_sending`                                                     |
| Rewrite outgoing text or cancel a send             | `message_sending`                                                           |
| Collect model timing without raw conversation text | `model_call_started` / `model_call_ended`                                   |
| Flush state after a turn or at shutdown            | `agent_end` / `gateway_stop`                                                |

The catalog is the registration API, not a promise that every runtime emits
every hook. For example, `before_agent_run` is implemented by the embedded and
CLI runners; do not rely on it as a Codex or Copilot input gate. Native tool,
transcript, and compaction boundaries also differ. See
[Codex hook boundaries](/plugins/codex-harness-runtime#hook-boundaries) and
[Agent harness plugins](/plugins/sdk-agent-harness).

## Troubleshooting

| Symptom                                    | Check                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin loads but the handler never runs    | Use `api.on` for typed names, inspect `openclaw plugins inspect <id> --runtime --json`, and check diagnostics for blocked registrations. Runtime inspection loads the plugin in the inspecting process; restart the Gateway too. |
| Conversation hook is blocked               | Set `plugins.entries.<id>.hooks.allowConversationAccess: true`; for prompt hooks, also check that `allowPromptInjection` is not `false`. These keys belong under `hooks`, not the plugin's `config`.                             |
| Hook works for one runtime or trigger only | Check the runtime boundary and `eligibleTriggers`. Missing context fields are not proof of a different sender, agent, or authorization state.                                                                                    |
| Persistence rewrite has no effect          | Return `{ message }` synchronously. An `async` handler's result is ignored.                                                                                                                                                      |
| A timed-out hook still performs work       | Timeout ends the host's await, not plugin work. Pass available abort signals through I/O and bound plugin-owned work yourself.                                                                                                   |
| One plugin's rewrite disappears            | Check the hook's merge rule and priority. `message_sending` uses the last returned content; `reply_payload_sending` passes each updated payload onward.                                                                          |

## Upcoming deprecations

A few hook-adjacent surfaces are deprecated but still supported. Migrate
before the next major release:

- **Plaintext channel envelopes** in `inbound_claim` and `message_received`
  handlers. Prefer typed fields instead of parsing flat envelope text:
  `inbound_claim` exposes `event.bodyForAgent`; `message_received` exposes
  `event.content` and structured metadata, not a `BodyForAgent` field. See
  [Plaintext channel envelopes → BodyForAgent](/plugins/sdk-migration#removal-timeline).
- **`onResolution` in `before_tool_call`** now uses the typed
  `PluginApprovalResolution` union (`allow-once` / `allow-always` / `deny` /
  `timeout` / `cancelled`) instead of a free-form `string`.
- **`api.registerSessionExtension` / `api.enqueueNextTurnInjection`** remain
  as top-level compatibility aliases. New plugins should use
  `api.session.state.registerSessionExtension(...)` and
  `api.session.workflow.enqueueNextTurnInjection(...)`.

For the full list - memory capability registration, provider thinking
profile, external auth providers, provider discovery types, task runtime
accessors, and the `command-auth` → `command-status` rename - see
[Plugin SDK migration → Active deprecations](/plugins/sdk-migration#removal-timeline).

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the five child pages below. The anchors from the single-page version still
resolve here.

### Hook reference

[Hook reference](/plugins/hooks/reference) — Registration rules, execution contracts, per-handler budgets, and the complete typed hook catalog.

- <a id="registration-and-execution"></a>[Registration and execution](/plugins/hooks/reference#registration-and-execution)
- <a id="hook-catalog"></a>[Hook catalog](/plugins/hooks/reference#hook-catalog)
- <a id="skill-lifecycle-and-evaluation"></a>[Skill lifecycle and evaluation](/plugins/hooks/reference#skill-lifecycle-and-evaluation)
- <a id="channel-pairing-requests"></a>[Channel pairing requests](/plugins/hooks/reference#channel-pairing-requests)

### Tool call policy hooks

[Tool call policy hooks](/plugins/hooks/tool-policy) — Parameter rewrites, blocks, approvals, exec environment contributions, and transcript persistence.

- <a id="tool-call-policy"></a>[Tool call policy](/plugins/hooks/tool-policy#tool-call-policy)
- <a id="sender-aware-policy-in-one-file"></a>[Sender-aware policy in one file](/plugins/hooks/tool-policy#sender-aware-policy-in-one-file)
- <a id="exec-environment-hook"></a>[Exec environment hook](/plugins/hooks/tool-policy#exec-environment-hook)
- <a id="tool-result-persistence"></a>[Tool result persistence](/plugins/hooks/tool-policy#tool-result-persistence)

### Prompt and session hooks

[Prompt and session hooks](/plugins/hooks/prompt-and-session) — Model resolution, prompt construction, finalization, and durable plugin-owned session state.

- <a id="debug-runtime-hooks"></a>[Debug runtime hooks](/plugins/hooks/prompt-and-session#debug-runtime-hooks)
- <a id="prompt-and-model-hooks"></a>[Prompt and model hooks](/plugins/hooks/prompt-and-session#prompt-and-model-hooks)
- <a id="authorized-prompt-enrichment"></a>[Authorized prompt enrichment](/plugins/hooks/prompt-and-session#authorized-prompt-enrichment)
- <a id="session-extensions-and-next-turn-injections"></a>[Session extensions and next-turn injections](/plugins/hooks/prompt-and-session#session-extensions-and-next-turn-injections)

### Message and delivery hooks

[Message and delivery hooks](/plugins/hooks/messages) — Inbound interception, reply takeover, and outbound delivery policy.

- <a id="message-hooks"></a>[Message hooks](/plugins/hooks/messages#message-hooks)

### Gateway and install lifecycle hooks

[Gateway and install lifecycle hooks](/plugins/hooks/lifecycle) — Install-time checks, Gateway service lifecycle, and safe external cron projection.

- <a id="install-hooks"></a>[Install hooks](/plugins/hooks/lifecycle#install-hooks)
- <a id="gateway-lifecycle"></a>[Gateway lifecycle](/plugins/hooks/lifecycle#gateway-lifecycle)
- <a id="safe-external-cron-projection"></a>[Safe external cron projection](/plugins/hooks/lifecycle#safe-external-cron-projection)

## Related

- [Plugin SDK migration](/plugins/sdk-migration) - active deprecations and removal timeline
- [Building plugins](/plugins/building-plugins)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin entry points](/plugins/sdk-entrypoints)
- [Internal hooks](/automation/hooks)
- [Webhooks](/automation/cron-jobs#webhooks)
- [Plugin architecture internals](/plugins/architecture-internals)

# Agents API harness

The `agentsapi` harness uses API-key authentication and defaults to an OpenAI-hosted
Linux environment. Select it through `agents.defaults.agentRuntime.id` or an agent's
`agentRuntime.id`. See the [harness configuration reference](https://docs.openclaw.ai/plugins/sdk-agent-harness/runtime-config).

Multi-user Gateways are not supported by the Agents API MVP.

Ordinary conversation attempts run OpenClaw's shared `before_prompt_build` hook,
including tool-authorized recall and heartbeat prompt contributions. Per-turn
`prependContext` and `appendContext` are applied on both new and resumed sessions.
System-prompt additions and overrides are captured only when the native session
is created. Updating system instructions on an existing native session is an MVP
implementation gap; reset the OpenClaw session to adopt those changes. The harness
does not move system instructions into user messages. Hook `toolsAllow` restrictions
are ignored because the harness cannot enforce turn-scoped restrictions across
Gateway and native tools. Turns continue with the hook's prompt context even for
an empty tool list; other available tools remain usable. Existing configured Gateway
tool policies still apply. Use a runtime that supports per-turn restrictions when a
hook's tool list must be enforced. Steering messages and isolated completions do not
run these conversation prompt hooks.

Memory Core dreaming can generate its diary narrative in a fresh Agents API
session without an executor, supplied functions, native web search, vaults, or
subagents. These calls use the prepared model and API key, do not reuse the
conversation or workspace, and delete the temporary session after settlement.
Cancellation waits for native work to settle before deletion.

Conversation-only API sessions require initial input during creation. If the
service accepts creation but its response is lost, the Gateway may not receive
the session ID needed to cancel or delete that work. Cleanup of known sessions
does not guarantee cleanup in that case.

Restricted sessions still have a tool-surface gap: the service may expose its
own built-in helpers even with no supplied functions or executor. Removing those
helpers is blocked by the Agents API, so a literal zero-tool surface is not
guaranteed. Tool-bearing output is rejected and no required function is executed.
Token and temperature limits are not forwarded because the Agents API session
contract does not expose those settings.

Set `plugins.entries.agentsapi.config.environment` to `openai_hosted` or
`self_hosted`, the official Agents API environment discriminator values:

```json
{
  "plugins": {
    "entries": {
      "agentsapi": {
        "enabled": true,
        "config": { "environment": "self_hosted" }
      }
    }
  }
}
```

Omitting the setting keeps `openai_hosted`. Self-hosted session creation sends
the absolute host-prepared OpenClaw workspace as `workspace_directory`. That
directory must already exist at the same path inside the executor. See the
[official self-hosted guide](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted).
Before enabling `self_hosted`, configure an operator-owned controller using the
[official webhook-managed lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle#start-compute-from-webhooks).
It receives `agent.session.action_required` with an `environment_connection`
action, retrieves that session through the authenticated Agents API, and connects
the executor using `session.environment.id` and the unchanged
`session.environment.remote_url`. Route only this Gateway's sessions to the
controller and match its workspace path. The controller owns startup,
reconnection, and cleanup; this plugin does not launch, provision, or authenticate
an executor. Input submission has a 60-second HTTP deadline, including any wait
for the executor to connect. Configure the controller to connect promptly;
the API's longer connection window does not extend this deadline. Session
connection events remain visible while it connects.
Hosted environments support input
attachments and output file transfers. Self-hosted environments do not support
file transfers. Gateway function availability follows the configured OpenClaw
tool policy. Native Agents API apps and connectors are not configured by this
plugin, and the Gateway image-generation tool is not exposed.

Changing the environment or a self-hosted workspace requires resetting the
OpenClaw session. Existing hosted bindings remain valid with the setting omitted
or explicitly `openai_hosted`. No saved session is reset or migrated automatically.

The Gateway must be the only writer to each native session bound to OpenClaw.
Send messages, steering, and interrupts through OpenClaw. Do not also write to
that native session from another API client or a Gateway with independent state.
Keep write credentials under the trusted Gateway operator's control. This
exclusivity is a deployment requirement, not API-enforced session isolation.
Binding leases coordinate OpenClaw attempts; tool execution retains current
ownership and cancellation checks. External concurrent writers are unsupported.

Message and steering submissions, tool results, and cancellation events retry
HTTP 5xx responses up to twice with bounded backoff. Each submission keeps the
same payload and idempotency key across retries; a new submission gets a new key.
Retries respect the operation's abort signal, session ownership, and an explicit
server instruction not to retry. Other HTTP errors, including conflicts, are
returned to the existing turn recovery logic. This does not repair a session
whose backend startup remains unresolved.

Saved sessions keep their native conversation, workspace, and original tool
declarations when Gateway tools are added. Fresh sessions receive the current
Gateway tool declarations. Reset an existing session to adopt the new tool
surface; changing its model or API key still requires a reset.

Child sessions use the same Gateway tool-policy filtering as other OpenClaw
runtimes, including inherited restrictions and the child's role. Denied session
and control tools stay unavailable. Policies that restrict native shell, file,
or native web-search access are rejected before the native session starts or
resumes; the MVP cannot narrow those native capabilities.

Token accounting reads canonical native turn records after settlement, since
completion stream events can omit usage. Each OpenClaw attempt counts its new
coordinator turns once, including work superseded by steering. Earlier turns in
the same native session are excluded. Cached input is counted separately from
uncached input; reasoning tokens remain included in output tokens.

Successful assistant messages retain those totals in the OpenClaw transcript.
When a Gateway tool ends the native turn, a transcript entry with no assistant
content retains usage without publishing another reply.
Run results and completion hooks also retain usage reported for interrupted or
failed work after native cleanup settles. Historical session usage is derived
from transcript messages, so other interrupted work without an assistant message
is not included in that historical report. A bounded five-second settlement window
waits for late turn records and usage. Counts are not refreshed after that
snapshot. Accounting read failures retain the last available snapshot and log a
warning; they do not discard a completed reply or replace cancellation. Missing
native usage remains unavailable; native counts can change as
upstream accounting arrives. See the
[official usage guide](https://developers.openai.com/api/docs/guides/agents-api/observability).

Native turn billing can sum multiple model calls. It does not establish the
current context-window usage. Cost estimates use the configured model prices;
they are not provider billing receipts.

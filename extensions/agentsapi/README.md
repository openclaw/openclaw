# Agents API harness

The `agentsapi` harness uses API-key authentication and defaults to an OpenAI-hosted
Linux environment. Select it through `agents.defaults.agentRuntime.id` or an agent's
`agentRuntime.id`. See the [harness configuration reference](https://docs.openclaw.ai/plugins/sdk-agent-harness/runtime-config).

Multi-user Gateways are not supported by the Agents API MVP.

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
The operator must connect an executor to each native session separately; this
plugin does not launch, provision, or authenticate an executor. Session connection
events remain visible while it connects. Hosted environments support input
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

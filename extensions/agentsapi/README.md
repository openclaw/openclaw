# Agents API harness

The `agentsapi` harness runs commands and file operations in an OpenAI-hosted Linux
VM by default, while OpenClaw handles channel messaging and configured Gateway
tools. It uses OpenAI API-key authentication.

API keys authenticate requests and are not part of the native conversation's
identity. Rotating the key used by the harness preserves existing session IDs;
subsequent attempts use the newly resolved key. The replacement key must have API
access to those sessions. Authentication or permission errors surface normally
without resetting the saved binding. The hosted service currently requires the
original API key to submit input to an existing hosted session, even when another
key can read it. If the service rejects input for this reason, restore the
creating key to continue the same session.

Model, environment, and effective HTTP MCP configuration changes still require a
session reset. Bindings created before this change are not migrated or supported.

Start with the [setup and supported features guide](https://docs.openclaw.ai/plugins/agentsapi).
Enable the `agentsapi` plugin and select it for the model through
`agents.defaults.models["openai/<model>"].agentRuntime.id: "agentsapi"`.
Replace `<model>` with a model available to your Agents API project. Enabling the
plugin alone does not select the runtime. Provider-scoped and per-agent model
overrides are covered in the
[harness configuration reference](https://docs.openclaw.ai/plugins/sdk-agent-harness/runtime-config).

Multi-user Gateways are not supported by the Agents API MVP.

Configure native Agents API tools with
`plugins.entries.agentsapi.config.nativeTools`. Omitting the setting uses live
web search and programmatic tool calling, without computer use. The default list
is equivalent to:

```json
{
  "plugins": {
    "entries": {
      "agentsapi": {
        "config": {
          "nativeTools": [
            { "type": "web_search", "mode": "live" },
            { "type": "programmatic_tool_calling", "enabled": true }
          ]
        }
      }
    }
  }
}
```

A supplied list replaces the defaults. List every native tool declaration you
want to send. Each entry requires a `type` string; other tool options are passed
unchanged to the session's `agent.tools`. OpenClaw does not maintain an enum of
tool types or options; the API validates them and reports unsupported values.

An empty list sends no native tool declarations and disables native web search.
The API still enables programmatic tool calling by default. To disable both,
set `nativeTools` to `[{ "type": "programmatic_tool_calling", "enabled": false }]`.
See the native API's [web-search guide](https://developers.openai.com/api/docs/guides/agents-api/tools/web-search)
and [programmatic tool calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling#agents-api).

The list does not filter OpenClaw functions, MCP servers, installed plugins, or
environment-provided shell and file tools. Those retain their existing settings;
shell and file tools come from the execution environment without entries here.
Existing sessions keep the tools selected at creation. Restart the Gateway after
editing this setting, then start or reset a session to adopt it. There is no live
tool-list update or automatic session reset.

Configure HTTP MCP servers through the shared `mcp.servers` configuration or an
enabled plugin's MCP bundle. For example:

```json
{
  "mcp": {
    "servers": {
      "documentation": {
        "transport": "streamable-http",
        "url": "https://developers.openai.com/mcp"
      }
    }
  }
}
```

The harness forwards these definitions as native Agents API MCP tools. Connections
originate from the session's execution environment, so a self-hosted executor can
reach private HTTP services. The Gateway does not open a second MCP connection.
Server initialization is optional: the turn can continue if a server is unavailable.
HTTP `headers` support explicit values and environment-variable references such as
`Bearer ${MCP_ACCESS_TOKEN}`. The API receives these credentials to authenticate the
MCP connection. Gateway OAuth profiles and requester-scoped connections are not
forwarded. Configure headers for services requiring authentication.

Exact `toolFilter.include` names become the native tool allowlist. Configured
exclusions and session tool denials are subtracted from that list; exclusions
without an explicit include list and wildcard filters are unsupported. The harness
logs an error and omits unsupported servers, including stdio, Gateway OAuth,
requester-scoped connections, legacy SSE, custom TLS, unsupported filters, and
headers it cannot resolve. Other supported servers remain available. Set an
explicit Streamable HTTP transport; URL-only definitions retain OpenClaw's legacy
SSE interpretation and are omitted. Connection/request timeouts and parallel-call
settings remain controlled by the native API.

Updating MCP definitions in an existing native session is an MVP implementation
gap. Changing the effective HTTP MCP configuration or credentials requires a fresh
session through `/new` or `/reset`; the harness does not update or automatically
replace the existing native session. Sessions without HTTP MCP configuration
retain their existing bindings.

Stdio MCP forwarding is a deferred implementation gap. Command-based servers are
not forwarded, and OpenClaw does not start them on the Gateway for this harness.
The Agents API already supports executor-managed stdio MCP processes; forwarding
their command, arguments, working directory and environment is future adapter work.

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
        "config": {
          "environment": "self_hosted",
          "hostExecutorSkillDirectories": ["/workspace/skills", "/opt/agent/skills"]
        }
      }
    }
  }
}
```

Omitting the setting keeps `openai_hosted`. Configure its network policy with
`plugins.entries.agentsapi.config.openai_host.network`, using the Agents API
field names:

```json
{
  "plugins": {
    "entries": {
      "agentsapi": {
        "config": {
          "environment": "openai_hosted",
          "openai_host": {
            "network": {
              "access": "restricted",
              "allowed_domains": ["api.github.com", "pypi.org", "files.pythonhosted.org"]
            }
          }
        }
      }
    }
  }
}
```

The plugin forwards `network` unchanged to the hosted session environment.
`access` accepts `enabled`, `disabled`, or `restricted`. Restricted mode accepts
1–100 exact hostnames without wildcards, protocols, paths, or ports. Include
subdomains and redirect destinations separately. The API validates domain rules
and returns errors through the normal attempt failure path. Hosted stdio MCPs
currently require `enabled` access. Service-origin remote MCP connections do not
use the VM's network policy. See the
[official hosted network guide](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted#control-network-access).

Omitting `openai_host.network` or setting it to `null` preserves the API default and existing hosted
bindings. Adding, changing, or removing a configured network policy requires an
explicit session reset before further native session writes. These settings are
unused for self-hosted sessions.

Self-hosted session creation sends
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
A deployment can enable a separate executor plugin and select it explicitly with
`plugins.entries.agentsapi.config.executorController: "my-executor"`.
The selected plugin registers one controller through
`api.registerAgentExecutorController({ workspaceDirectory, ensure, retire })`.
The stock Agents API plugin continues to own the harness; the executor plugin
must not register a second harness. Its manifest declares
`activation.onAgentHarnesses: ["agentsapi"]` so the controller is loaded into
the same prepared invocation registry as the harness. Omit `executorController` for the external
webhook-managed path above.

The controller uses the public `AgentExecutorController`, `AgentExecutorBinding`
and `AgentExecutorContext` types from `openclaw/plugin-sdk/agent-harness-runtime`:

- `workspaceDirectory` is an existing absolute path on the executor host,
  configured by the executor plugin. Gateway tool paths stay unchanged.
- `ensure(binding, context)` idempotently starts or reconnects the executor using
  the exact environment ID, remote URL and workspace in the canonical binding.
  The harness persists that binding and its controller owner before invocation,
  then waits for the API to report the environment connected before input.
- `retire(binding, context)` idempotently releases only that binding's executor
  after native work settles, before reset or session deletion discards the binding.
  Failed retirement retains the binding for retry; rolled-back deletion can
  reconnect that executor on the next input.

Callbacks receive `signal` and `assertCurrent`. Honor cancellation and recheck
`assertCurrent()` immediately before side effects and after asynchronous work.
Do not retain operation-scoped handles. Controller registration and resolution
belong to the active plugin registry, including reload and disposal; imported
copies of the Agents API package do not maintain independent controller lists.
The executor plugin owns process launch, authentication and filesystem provisioning.
The harness owns native session identity, readiness and cleanup ordering.

Changing controllers requires a session reset. Cleanup uses the original stored
controller owner, even after configuration changes; a missing or disabled owner
fails explicitly and retains the binding. Gateway disposal retains the executor
and its binding. After a Gateway restart, resume a controlled session once before
reset or deletion to prepare the authenticated cleanup handle.
Bindings from the earlier factory-injected controller have no plugin owner.
Retire those sessions using the previous version before adopting plugin selection;
ownerless controlled bindings are rejected and retained rather than reassigned.

Hosted environments support input attachments and output file transfers. Each
turn transfers its admitted original files, including images, to unique hosted
paths, so later uploads with the same filename keep their own bytes and mapping.
Inline image preparation does not replace this original-file transfer.
Hosted input transfer examines at most 50 attachments, with a 5 MiB per-file
limit and a 10 MiB total limit. Files exceeding these limits are omitted with
per-turn feedback; supplied text and accepted files still reach the model.
The model can use available tools that can access the originals or ask for a
smaller attachment or relevant text when needed content remains inaccessible.
When a reused hosted environment is disconnected or an upload receives the API's
explicit dormant-environment conflict, the harness submits the actual user input
to the same native session with attachment-availability feedback. It omits the
entire current batch's execution paths, including partial uploads, because native
recovery can replace the workspace. Earlier files do not establish the contents
of new attachments. The native service owns recovery; OpenClaw does not send a
wake-up message or create a replacement session. Other upload errors still fail
the attempt.
Self-hosted input attachments use the
registered workspace provider's existing staging service. It prepares admitted
originals on the executor workspace and returns execution-only paths without
changing their Gateway media references or transcript provenance. Admission
requires a completed preparation result for every attachment; one unavailable
file stops the request with an error. The harness does not infer availability
from a path in the prompt. Repeated preparation reuses the same owned staging
files. A self-hosted deployment without this provider must configure it or use
an OpenAI-hosted environment for attachments. This does not add native image
input or automatic self-hosted output transfer. See the
[official files guide](https://developers.openai.com/api/docs/guides/agents-api/environments/files).
Inline images, including rendered document pages, do not abort the turn. The
harness tells the model that inline images were omitted so it can use supplied
text or inspect prepared original attachments with its tools. If no originals
have confirmed execution paths, the notice says so. Image-bearing steering follows the existing
queue policy and is handled as a follow-up turn with its complete input.
New native sessions also receive a system instruction describing the inline-image
restriction and alternatives. Existing sessions retain their original system
instructions, so the per-turn feedback remains necessary. System instructions
guide model planning; they do not prevent host-side attachment preprocessing.
Gateway sandbox placement is a separate unsupported configuration and produces
a specific preflight error without retrying other models on the same harness.
Gateway function availability follows the configured OpenClaw tool policy.
Native Agents API apps and connectors are not configured by this
plugin, and the Gateway image-generation tool is not exposed.

For self-hosted sessions, `hostExecutorSkillDirectories` lists absolute paths on
the executor host machine. These directories must already be set up with the
skill files and be available to the Agents API harness through the executor.
OpenClaw sends the paths as the Agents API `capability_directories` field; it does
not copy or install files or resolve these paths against the Gateway's filesystem.
Install any supporting scripts and dependencies on the executor host as well.
The Agents API harness discovers skills in these directories and reads their
contents through the executor. OpenClaw's per-skill eligibility filters do not apply to this
explicit native discovery list; choose only directories you intend to expose.
Gateway tool policies continue to apply to Gateway functions.
Sessions created without skill directories remain valid when the list is
omitted or empty. Changing a nonempty list requires a session reset.
The list is unused for hosted sessions.

Changing the environment, self-hosted workspace, or skill directories requires resetting the
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
surface. Changing its model still requires a reset; changing its API key does not
reset the saved binding and remains subject to the service permissions above.

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

## Installed plugin settings

Agents API has its own installed Codex plugin selection schema at
`plugins.entries.agentsapi.config.plugins`:

```json
{
  "enabled": true,
  "allow_all_plugins": false,
  "plugins": {
    "slack": {
      "enabled": true,
      "marketplaceName": "openai-curated",
      "pluginName": "slack"
    }
  }
}
```

The supported fields are `enabled`, `allow_all_plugins`, and per-plugin
`enabled`, `marketplaceName`, and `pluginName`. Codex policy fields such as
`allow_destructive_actions` are not part of this schema. Editing this selection
block does not restart the Gateway.

This schema does not yet enable native apps or connectors in this build. Codex
settings remain independent. Configuration is not migrated automatically; copy
supported selection fields from `plugins.entries.codex.config.codexPlugins`
manually when adopting the Agents API settings.

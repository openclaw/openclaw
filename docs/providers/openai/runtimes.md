---
summary: "Choose an OpenAI runtime, set up Agents API, and understand native Codex auth"
doc-schema-version: 1
read_when:
  - You need to know whether a turn runs on OpenClaw or the native Codex harness
  - You are mapping the openai, codex, and agentRuntime names to layers
  - You are debugging native Codex app-server account selection
  - You want to set up Agents API and understand hosted VM support
title: "OpenAI runtimes and Codex auth"
sidebarTitle: "Runtimes and Codex auth"
---

## Naming map

| Name you see                            | Layer             | Meaning                                                                                  |
| --------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `openai`                                | Provider prefix   | Canonical OpenAI model route; route facts determine the implicit runtime.                |
| `codex` plugin                          | Plugin            | Bundled plugin providing the native Codex app-server runtime and `/codex` chat controls. |
| provider/model `agentRuntime.id: codex` | Agent runtime     | Force the native Codex app-server harness for matching embedded turns.                   |
| `/codex ...`                            | Chat command set  | Bind/control Codex app-server threads from a conversation.                               |
| `runtime: "acp", agentId: "codex"`      | ACP session route | Explicit fallback path that runs Codex through ACP/acpx.                                 |

## Implicit agent runtime

When provider/model `agentRuntime` policy is unset or `auto`, OpenAI's
provider-owned route policy chooses the implicit runtime from the effective
endpoint and adapter:

| Effective route facts                                                                                                                                                           | Implicit runtime      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Exact official Platform HTTPS endpoint with `openai-responses`, or exact official ChatGPT HTTPS endpoint with `openai-chatgpt-responses`; no authored provider request override | Codex may be selected |
| Authored `openai-completions` adapter                                                                                                                                           | OpenClaw              |
| Custom endpoint                                                                                                                                                                 | OpenClaw              |
| Explicit exact official endpoint using HTTP                                                                                                                                     | Rejected              |
| Route with an authored provider/model request override                                                                                                                          | OpenClaw              |

Valid model-scoped `params.fastMode` / `params.fast_mode`, cutoff, and `thinking`
values are typed agent-runtime controls, not authored provider request params.
Affirmative reasoning support and native reasoning-effort metadata also preserve
Codex selection. See [Runtime selection](/concepts/agent-runtimes#runtime-selection)
for the supported capability values and the request overrides that remain protected.

An explicit `agentRuntime.id: "openclaw"` keeps a Codex-eligible route on
OpenClaw. Explicit `agentRuntime.id: "codex"` requires a registered Codex harness;
unsupported routes/auth fail closed, except that authored request overrides may
use Codex's declared exact-request OpenClaw fallback before execution. Inspect
the completed result's actual harness when a recipe depends on native execution.
Runtime compatibility does not establish credential type or billing: Platform API-key
auth and ChatGPT/Codex subscription auth remain distinct.

An official Completions adapter alone does not pin a supported model to metered
billing: older configurations used that adapter with Codex subscription auth.
When both credential kinds are eligible, automatic selection prefers the
subscription route. That preference does not change the implicit runtime or
require installing Codex for an API-only configuration. A literal provider
`apiKey` without an `auth` override remains a fallback after eligible profiles.
Required profile bindings, provider auth settings, configured secret references,
and explicit auth order still take precedence. An authored OpenClaw runtime choice
prefers the API route when both kinds are eligible; runtime compatibility is
checked independently. Unpinned heartbeat and subagent models inherit their
default model's route intent. Doctor reports a resolved billing-route change
after saving a model-reference migration, including the consumer and old/new
models, routes, and profiles.

`openclaw doctor --fix` migrates legacy `codex/*` and `openai-codex/*` model
refs, legacy Codex auth profile ids, and legacy Codex auth-order entries to the
canonical `openai` route. Migrated model refs receive model-scoped
`agentRuntime.id: "codex"`; use `auth.order.openai` for new auth-order config.

<Note>
Fresh OpenAI setup applies a GPT-5.6 primary only when no primary model is
configured. Adding or refreshing OpenAI auth preserves an existing explicit
selection, including `openai/gpt-5.5`, unless you explicitly use
`models auth login --set-default` or `models set`. Use an API-key auth profile
only when you want API-key auth for an agent model.
</Note>

## Agents API MVP

The Agents API plugin (`@openclaw/agentsapi`) runs commands and file operations
in an OpenAI-hosted Linux VM while your OpenClaw Gateway handles messaging and
integrations. OpenAI manages the compute. The `openai` provider continues to own
model selection and API-key authentication. This integration targets single-user
Gateways.

### What works with a hosted VM

- **Chat:** conversations through configured OpenClaw channels such as Slack,
  including follow-up messages, steering, and interruption.
- **Code and commands:** Python, Node.js, and shell commands in the hosted
  environment.
- **File transfer:** send attachments for the agent to process and receive
  generated files with the completed reply. See the storage requirements and
  transfer limits below.
- **Personal instructions:** OpenClaw operating rules, persona, and user context
  are supplied to new sessions. These are instruction snapshots, not copies of
  Gateway files in the VM.
- **Tools and memory:** configured OpenClaw and plugin functions, including
  memory search and recall, remain available through the Gateway when enabled
  by their plugin and tool policy.
- **Web and MCP:** built-in web search and configured Streamable HTTP MCP
  servers reachable from the hosted VM.

The [hosted sandbox guide](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)
describes the VM. Its filesystem is separate from your Gateway workspace;
retaining a conversation does not guarantee permanent storage of VM files.

### Set up Agents API

1. Configure [OpenAI API-key authentication](/providers/openai/setup#getting-started).
   Run `openclaw models auth login --provider openai --method api-key`.
   A restricted key needs Agents and Responses read/write plus Models read
   permission. Use the official `https://api.openai.com/v1` endpoint and
   `openai-responses` adapter. ChatGPT subscription authentication, custom
   endpoints, and authored request transport overrides are unsupported for
   this runtime.
2. Enable `agentsapi` and select it for your model in `openclaw.json`. Merge the
   following into your existing configuration; keep your channel and other
   plugin settings. Choose a model available to your Agents API project.

```json5
{
  plugins: {
    entries: {
      agentsapi: { enabled: true },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-6-astra" },
      models: {
        "openai/gpt-6-astra": { agentRuntime: { id: "agentsapi" } },
      },
    },
  },
}
```

If `plugins.allow` is configured, add `agentsapi` and `openai` while retaining
your other allowed plugins. Runtime selection belongs on the model, as shown
above, or on the provider. Do not use the old whole-agent
`agents.defaults.agentRuntime` setting. Enabling the plugin alone does not
select it. See [harness configuration](/plugins/sdk-agent-harness/runtime-config)
for provider and per-agent model overrides.

3. Apply the configuration through your normal Gateway workflow. Start a fresh
   conversation with `/new` if you are adopting the runtime in an existing
   chat. Ask the agent to run a small Python calculation, save its result to
   `/workspace/outputs/result.txt`, and return the file. Confirm the command
   result and the actual downloaded attachment. This exercises hosted execution
   and file transfer through your configured channel. A successful
   `openclaw models status --probe` only checks model authentication through
   the ordinary OpenClaw runtime; it does not verify an Agents API session.

For file transfer, use a Linux Gateway with native Linux state storage or a
Docker-managed state volume. On macOS, use a Docker-managed volume rather than
bind-mounting Gateway state from the host. Windows Gateways are outside the
current file-transfer support scope.

### Sessions and instructions

The harness sends the configured model to the Agents API without a model
allowlist; unsupported models return the API error. Reasoning follows the
configured thinking level and model metadata: keep a supported effort,
otherwise choose the next higher supported effort, or the highest available
when none is higher. The selected effort applies to new sessions and later
turns in existing sessions. `adaptive` and omitted native efforts use the model
default; updating an existing session resets its effort to that default. The
single-agent MVP does not support `ultra` delegation. Automatic runtime
selection is unchanged. When reasoning display is enabled, new sessions request
native summaries. Summary generation is fixed at creation; enabling it for an
existing session requires a reset. Native delegation remains disabled.

The standalone plugin keeps native session identifiers in plugin state. It uses
the shared harness runtime for leases, generation admission, deletion rollback,
cancellation, deadlines, and lifecycle events. Agents API protocol events,
native completion receipts, and transcript projection remain plugin-owned.
Reset sessions created
by the earlier in-provider prototype once when switching to this package.

Agents API owns the persistent agent session and workspace. OpenClaw stores
the session binding in plugin SQLite state and mirrors assistant commentary,
reasoning summaries, native tool calls and results, and final text into its
normal transcript. Follow-up messages reuse the agent session; input during
a running turn steers it, and interruption cancels its remote turn. `/new`
and `/reset` start a fresh session on the next message. Reset and local session
deletion retire the binding; the Agents API retains the remote history and
workspace, which can be managed through its API.

When creating a session, OpenClaw uses the same workspace preparation as Codex
to supply bounded `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, shared `USER.md`, and
the selected person's `users/<profile-id>/USER.md` overlay. Eligible
`BOOTSTRAP.md`, `MEMORY.md`, and bootstrap-hook files are included as supporting
context. Existing bootstrap budgets, session privacy rules, and lightweight
mode still apply. When enabled memory tools target the configured workspace,
OpenClaw supplies memory references and the active memory plugin's recall
guidance instead of embedding root `MEMORY.md` contents.

These are instruction snapshots from the Gateway, not files copied into the
hosted VM. Follow-up turns retain them. Use `/new` or `/reset` to pick up edits,
changed personal-user selection, or this behavior in an existing session.
Preparation failure occurs before remote session creation and binding so the
next attempt can retry.

The harness reuses OpenClaw's tool-aware delegation, Skill Workshop, UI,
credential, Git coauthor, and extra system guidance where applicable. Each turn
also receives current date/timezone, active-computer, visible-reply, permission
notice, and watched-session context through the existing input carrier.
Lightweight cron input stays unchanged.

Ordinary conversation turns run `before_prompt_build` hooks. Per-turn
`prependContext` and `appendContext` apply to both new and resumed sessions;
system-prompt additions and overrides are captured only at session creation.
Use `/new` or `/reset` to adopt changed system instructions. Hook `toolsAllow`
restrictions are not enforced by this harness; configured Gateway tool policies
still apply. Use another runtime when a hook's per-turn tool restrictions must
be enforced. Steering and isolated completions do not run these conversation hooks.

Workspace/persona refresh within an existing session, Gateway skill-file access
and skill catalog delivery, plugin command prompt registration for this harness,
custom context-engine assembly, and native fork preparation remain unimplemented.
Native Codex project discovery, collaboration, and
deferred-tool-search instructions are not applicable to the hosted harness.
Hosted files remain separate from the Gateway workspace; attachment upload and
output transfer are supported independently.

If the event stream closes, the harness subscribes again and reconciles saved
turns, saved items, and input receipts before accepting completion. It does not
resubmit the user's message. Completion requires a terminal root turn and an
idle native session. Recovered items use stable identities to avoid duplicate
history. If a recovered item is still running, its saved snapshot is displayed
and ambiguous overlapping deltas are suppressed until authoritative completion;
new items continue streaming normally.

When a retry retains the native conversation, later canonical facts can also
repair missing tool records from earlier terminal turns. These records append
to the existing history without replaying progress or counting earlier work
in the current attempt. Retrieved command invocation facts can be saved while
execution is still running; a durable result requires the item's own terminal
status. MCP arguments and web-search actions are saved after their items finish.

Commentary remains live while durable commentary and reasoning records wait for
retrieved native history. Missing or unfinished items can prevent exact ordering;
terminal reconciliation retains available completed records instead of dropping
them behind an unresolved item. Host input keeps its existing transcript
placement, and historical repairs append without rewriting earlier messages.

Native token usage is best effort and is accumulated across all admitted turns,
including work superseded by a steering follow-up. Cached input and reasoning
tokens remain separate usage facts. Billed tokens do not establish active
context occupancy; that value remains unavailable.
Completed, failed, and cancelled turn events can supply usage even when the
saved turn has none; the harness retains that contribution and reports it once.

Native commands, MCP calls, and web searches use the same activity and output
callbacks as the Codex harness. Assistant commentary preserves its text, so a
progress marker can reach the channel while a command is still running.
Existing channel settings govern output and reasoning visibility.

Saved native tool items supply canonical history and available command output,
exit codes, duration, arguments, MCP details, and web-search actions. Missing
command exit facts remain unknown even when the assistant claims success.
The native API exposes web-search activity without result bodies or snippets.
Structured plans, diffs, compaction events, native child agents, and pre-execution
approval or hook events are not provided by this harness.

### Tools, MCP, and files

New Agents API sessions enable built-in web search in live mode. Sessions
created before web search was enabled need `/new` or `/reset` to pick it up.

The harness supports text, built-in web search, native hosted-workspace commands, and host-authorized
OpenClaw and plugin functions. Gateway functions retain the normal tool policy,
hooks, current-run authority, and delivery receipts; shell and file operations
remain in the hosted VM. Tools such as memory search are available when their
existing plugin and configuration enable them.
OpenClaw records host function calls, arguments, results, and error status in
its normal transcript before acknowledging the result to the native session.

Configure generic MCP servers with an explicit `streamable-http` transport in
`mcp.servers` or an enabled plugin's MCP bundle. Connections originate in the
hosted VM, so `localhost` refers to that VM, not your Gateway or laptop.
Supply HTTP authentication headers when the server requires them; Gateway
OAuth profiles are not forwarded. Stdio, legacy SSE, requester-scoped
connections, and custom TLS settings are unsupported. Unsupported definitions
are logged and omitted, and a turn can continue without an unavailable server.
Changing MCP configuration or credentials requires `/new` or `/reset`.
See the [plugin reference](https://github.com/openclaw/openclaw/blob/main/extensions/agentsapi/README.md)
for header references, exact tool filters, and environment configuration.

Admitted file attachments are copied into `/workspace/inputs` in the hosted VM.
Follow-up attachments upload into the same connected environment. Completed
native artifacts under `/workspace/outputs` are copied into OpenClaw's managed
outbound media and attached to the final reply. Limits are 5 MiB per file,
10 MiB total, and 50 files per turn in each direction. Model text cannot select a
Gateway file path for transfer.

If a returned attachment is missing, check the Gateway logs and the storage
requirements in the setup steps above. Completed assistant text is retained
when output transfer fails, but it may still claim that a file was attached.
Confirm that the attachment is present before treating the transfer as complete.

### Current limits and other environments

Hosted skill installation and operator-configured startup commands, packages,
environment variables, and environment templates are not exposed by this
OpenClaw plugin. Existing Gateway scripts, repositories, and skill directories
are not automatically copied into the VM. Image input, image generation,
Gateway sandbox placement, and custom context engines are unsupported. Policies
that restrict native shell, file, or web-search capabilities are rejected before
a conversation turn starts; the harness cannot narrow those native capabilities.

Self-hosted execution is a separate supported environment choice. It requires
an operator-managed executor controller and matching workspace paths. The plugin
does not provision the executor. `hostExecutorSkillDirectories` supports skill
directories already installed on that executor, not hosted VM skill installation.
See the [environment setup reference](https://github.com/openclaw/openclaw/blob/main/extensions/agentsapi/README.md)
for controller prerequisites, attachment staging, and reset requirements.

Admitted turns are marked unsafe for replay because hosted commands or Gateway
functions may already have run.
OpenClaw can continue the existing session after a transient provider failure.

## Native Codex app-server auth

The native Codex app-server harness uses `openai/*` model refs when an eligible
exact official HTTPS route selects it implicitly, or when provider/model
`agentRuntime.id: "codex"` selects it explicitly. Its auth is still
account-based. OpenClaw selects auth in this order:

1. Ordered OpenAI auth profiles for the agent, preferably under
   `auth.order.openai`. Run `openclaw doctor --fix` to migrate older legacy
   Codex auth profile ids and auth order.
2. The native Codex account, only with an explicit `appServer.homeScope: "user"`
   opt-in and when no host credential or account selection owns the route.
   Ordinary OpenClaw sessions default to the isolated agent home, even when
   Codex is already signed in. Prepared OpenClaw credentials stay in that home;
   OpenClaw never logs them into the native user home.
3. For local stdio app-server launches only, and only when the app-server
   reports no account: `CODEX_API_KEY`, then `OPENAI_API_KEY`.

With the user-home opt-in, status and catalog reads ask Codex about its native
login without importing credentials into an OpenClaw profile. A fresh auth refresh observes native login
and logout. Native API-key and subscription accounts select their matching
routes. Model runtime choices use the same route and account as thinking
metadata; an unavailable runtime cannot be selected. Explicit auth import
remains available when you want an OpenClaw-owned profile.

If you previously relied on automatic use of a native Codex login, sign in with
`openclaw models auth login --provider openai` and select the resulting OpenClaw
profile. Selecting detected Codex in Model Setup reuses eligible OpenClaw credentials
or opens the supported OpenAI sign-in flow before testing the connection. A cancelled
or failed sign-in does not promote the route. If verification fails after sign-in,
choose the saved sign-in to retry without logging in again. Setup no longer enables
user-home sharing merely because a native login exists. Existing explicit `homeScope: "user"` settings remain opt-ins; remove that
setting to use isolated sessions. Native session adoption and supervision are
unchanged. Existing personal Codex history is not moved or deleted, and ordinary
OpenClaw sessions remain durable in the per-agent Codex home.

The default per-agent `codex-home/auth.json` is not a runtime auth store. If
you copied or mounted Codex CLI credentials there, import them into the agent's
OpenClaw auth store before starting a native Codex turn. Replace `<agent-id>`
with the configured agent that owns this Codex home:

```bash
openclaw migrate plan codex --from <codex-home> --agent <agent-id> --include-secrets --item auth:openai
openclaw migrate apply codex --from <codex-home> --agent <agent-id> --include-secrets --item auth:openai --yes
```

A local ChatGPT/Codex subscription sign-in is not replaced just because the
gateway process also has `OPENAI_API_KEY` for direct OpenAI models or
embeddings. The env API-key fallback applies only to the local stdio no-account
path; it is never sent over WebSocket app-server connections. When a
subscription-style Codex profile is selected, OpenClaw also keeps
`CODEX_API_KEY` and `OPENAI_API_KEY` out of the spawned stdio app-server child
and sends the selected credentials through the app-server login RPC instead.

When that subscription profile is blocked by a Codex usage limit, OpenClaw
marks the profile blocked until Codex's advertised reset time and lets auth
ordering rotate to the next `openai:*` profile, without changing the selected
model or dropping out of the Codex harness. Once the reset time passes, the
subscription profile is eligible again.

Chat `/status` reports the authentication mode from the selected runtime's current
prepared account. A native login stays distinct from an OpenClaw profile; it does
not satisfy an unavailable explicit profile pin.

---
summary: "Which runtime runs an openai/* turn, and how native Codex resolves auth"
read_when:
  - You need to know whether a turn runs on OpenClaw or the native Codex harness
  - You are mapping the openai, codex, and agentRuntime names to layers
  - You are debugging native Codex app-server account selection
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

The separate Agents API plugin (`@openclaw/agentsapi`) registers the explicit
`agentsapi` harness, alongside the Codex plugin. The OpenAI provider plugin
continues to own model routes and API-key authentication.
Select a model in `agents.defaults.model.primary` and set its
`agents.defaults.models["openai/<model>"].agentRuntime.id` to `"agentsapi"`.
Use OpenAI API-key authentication. The harness sends the configured model to the
Agents API without a model allowlist; unsupported models return the API error.
Execution uses an OpenAI-hosted Linux VM. Reasoning follows the configured
thinking level and model metadata: keep a supported effort, otherwise choose
the next higher supported effort, or the highest available when none is higher.
The selected effort applies to new sessions and later turns in existing
sessions. `adaptive` and omitted native efforts use the model default; updating
an existing session resets its effort to that default. The single-agent MVP
does not support `ultra` delegation. Automatic runtime selection is unchanged.
When reasoning display is enabled, new sessions request native summaries.
Summary generation is fixed at creation; enabling it for an existing session
requires a reset. Native delegation remains disabled.

```json5
{
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

If `plugins.allow` is configured, include `agentsapi` alongside `openai`.
The standalone plugin keeps native session identifiers in plugin state. It uses
the shared harness runtime for leases, generation admission, deletion rollback,
cancellation, deadlines, and lifecycle events. Agents API protocol events,
native completion receipts, and transcript projection remain plugin-owned.
Reset sessions created
by the earlier in-provider prototype once when switching to this package.

A restricted API key needs Agents and Responses read/write plus Models read
permission so the service can retrieve the selected model when creating a session.

Agents API owns the persistent agent session and workspace. OpenClaw stores
the session binding in plugin SQLite state and mirrors assistant commentary,
reasoning summaries, native tool calls and results, and final text into its
normal transcript. Follow-up messages reuse the agent session; input during
a running turn steers it, and interruption cancels its remote turn. `/new`
and `/reset` start a fresh session on the next message. Reset and local session
deletion retire the binding; the Agents API retains the remote history and
workspace, which can be managed through its API.

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

New Agents API sessions enable built-in web search in live mode. Sessions
created before web search was enabled need `/new` or `/reset` to pick it up.

The harness supports text, built-in web search, native hosted-workspace commands, and host-authorized
OpenClaw and plugin functions. Gateway functions retain the normal tool policy,
hooks, current-run authority, and delivery receipts; shell and file operations
remain in the hosted VM. Tools such as memory search are available when their
existing plugin and configuration enable them.
OpenClaw records host function calls, arguments, results, and error status in
its normal transcript before acknowledging the result to the native session.

Admitted file attachments are copied into `/workspace/inputs` in the hosted VM.
Follow-up attachments upload into the same connected environment. Completed
native artifacts under `/workspace/outputs` are copied into OpenClaw's managed
outbound media and attached to the final reply. Limits are 5 MiB per file,
10 MiB total, and 50 files per turn in each direction. Model text cannot select a
Gateway file path for transfer.

File transfer in this MVP supports the hosted Linux VM with a Linux Gateway
using native Linux state storage or a Docker-managed state volume. macOS host
bind-mounted Gateway state and Windows Gateways are outside this support scope.
If a returned attachment is missing, check the Gateway logs and storage setup;
on macOS, use a Docker-managed state volume. Completed assistant text is retained
when output transfer fails, but it may still claim that a file was attached.
Confirm that the attachment is present before treating the transfer as complete.

Apps, connectors, image generation, custom context engines, and self-hosted
executors are outside this prototype's scope. Admitted turns are marked unsafe
for replay because hosted commands or Gateway functions may already have run.
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

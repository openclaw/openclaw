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

## Native Codex app-server auth

The native Codex app-server harness uses `openai/*` model refs when an eligible
exact official HTTPS route selects it implicitly, or when provider/model
`agentRuntime.id: "codex"` selects it explicitly. Its auth is still
account-based. OpenClaw selects auth in this order:

1. Ordered OpenAI auth profiles for the agent, preferably under
   `auth.order.openai`. Run `openclaw doctor --fix` to migrate older legacy
   Codex auth profile ids and auth order.
2. The native Codex account, when no host credential or account selection owns
   the route. This path uses the user Codex home. An explicit
   `appServer.homeScope: "agent"` keeps the isolated home and does not borrow the
   user login. Prepared OpenClaw credentials stay in the agent home; OpenClaw
   never logs them into the native user home.
3. For local stdio app-server launches only, and only when the app-server
   reports no account: `CODEX_API_KEY`, then `OPENAI_API_KEY`.

Status and catalog reads ask Codex about its native login without importing
credentials into an OpenClaw profile. A fresh auth refresh observes native login
and logout. Native API-key and subscription accounts select their matching
routes. Model runtime choices use the same route and account as thinking
metadata; an unavailable runtime cannot be selected. Explicit auth import
remains available when you want an OpenClaw-owned profile.

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

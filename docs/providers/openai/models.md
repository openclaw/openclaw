---
summary: "Pick an OpenAI model ref, including GPT-6.1 Sol, GPT-6 Astra, Sol, Luna, and the GPT-5.6 tiers"
read_when:
  - You are choosing which OpenAI model ref to run
  - You want to select GPT-6.1 Sol, GPT-6 Sol, or Luna
  - You want Astra async tools, mid-turn steering, or cached reasoning changes
  - Your account does not expose a GPT-5.6 tier
title: "OpenAI models"
sidebarTitle: "Models"
---

## Quick choice

| Goal                                              | Use                                                                | Notes                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| ChatGPT/Codex subscription, native Codex runtime  | `openai/gpt-6-astra`                                               | Fresh subscription setup; sign in with Codex auth.                  |
| Direct API-key billing for agent turns            | `openai/gpt-6-astra` plus an ordered API-key auth profile          | Fresh API-key setup uses Astra.                                     |
| GPT-6.1 Sol                                       | `openai/gpt-6.1-sol`                                               | Select explicitly; reasoning cannot be disabled.                    |
| GPT-6 Sol                                         | `openai/gpt-6-sol`                                                 | Select explicitly; account access can differ between auth routes.   |
| Lower-cost GPT-6 Luna                             | `openai/gpt-6-luna`                                                | Select explicitly; check the account catalog for availability.      |
| Choose an exact GPT-5.6 tier                      | `openai/gpt-5.6-sol`, `-terra`, or `-luna`                         | Check `models list` for the tiers available to this account.        |
| Account without GPT-5.6 access                    | `openai/gpt-5.5`                                                   | Explicit recovery choice; OpenClaw does not silently downgrade.     |
| Direct API-key billing, explicit OpenClaw runtime | `openai/gpt-5.6` plus provider/model `agentRuntime.id: "openclaw"` | Select a normal `openai` API-key profile.                           |
| Latest ChatGPT Instant model alias                | `openai/chat-latest`                                               | Direct API-key only; moving alias, not the stable default.          |
| Image generation or editing                       | `openai/gpt-image-2`                                               | Works with `OPENAI_API_KEY` or Codex OAuth.                         |
| Transparent-background images                     | `openai/gpt-image-1.5`                                             | Set `outputFormat` to `png` or `webp` and `background=transparent`. |

Isolated and utility completions on the Codex runtime use the same account routes
as the model picker. A model listed by your ChatGPT account does not require an
OpenAI API key for these completions. An explicit auth profile or utility-model
override still controls the request; OpenClaw does not replace it with another
account.

### Retired subscription model references

GPT-5.4 and GPT-5.4 Mini are retired from the ChatGPT-account Codex route. Run `openclaw doctor --fix` to replace persisted subscription references with their documented successors: `openai/gpt-5.6-terra` and `openai/gpt-5.6-luna`, respectively. This includes defaults, per-agent model selections, automation overrides, and unlocked session overrides whose selected route is known. The Platform API-key route is unaffected. Doctor retains pinned overrides when their successor is outside the agent's model policy, or when clearing an override would keep the same retired model and account. Doctor also retains the original reference and warns when its declared successor is retired or definitively unsupported on the selected account route; unknown availability and temporary cooldowns do not block migration. It reports the model or policy change needed, along with unresolved or conflicting account routes. Review the repair output, restart the Gateway, and re-enable any automation that was disabled after repeated failures.

## Models your API key lists

With an OpenAI API key, `openclaw models list --provider openai` shows every chat
model your account's `/v1/models` lists that runs on the Responses API, including
models newer than your OpenClaw release. Models without a catalog row use
conservative defaults: text input, a 128k context window, and unknown cost.
Embedding, image, video, audio, realtime, speech, transcription, moderation, and
legacy completions models stay hidden, as do models past their OpenAI shutdown
date. Search models stay hidden because they run only on Chat Completions; live,
unrecognized cyber, experiment, and alpha IDs stay hidden because they can fail
on Responses. The documented `gpt-5.6-cyber` Daybreak model is included when the
account lists it; approved Daybreak Red access is still required.
GPT-3.5, GPT-4 (including GPT-4o and GPT-4.1), o1, o3, and o4 models stay hidden
from the list because their tool capabilities differ from the modern models.
You can still select one by its reference, for example as
`agents.defaults.model.primary` or a session model. OpenClaw automatically uses
its function-tool runtime instead of Codex's native custom tools; no manual
`agentRuntime.id` override is needed. GPT-5-family models keep the Codex runtime.
o1, o3-mini, GPT-3.5, GPT-4, GPT-4 Turbo, and GPT-4.1 nano also reject OpenAI's
hosted web search, which the OpenClaw runtime adds by default:
set `tools.web.search.provider` to a managed provider such as `brave`, or
`tools.web.search.enabled: false`, before using them (see
[Native OpenAI web search](/tools/web#native-openai-web-search)).

<a id="daybreak-blue-and-red" />

## Daybreak alias retirement

OpenAI retires `openai/gpt-daybreak-blue-latest` and
`openai/gpt-daybreak-red-latest` on **October 28, 2026**. Only the aliases
retire; the underlying models remain available to approved accounts. OpenClaw
marks the aliases deprecated and stops choosing Blue as an implicit cyber
failover target. Explicit alias references remain unchanged; this is not an
automatic switch to a different model.

Before the deadline:

1. Check your Daybreak settings and the specific model IDs available under your
   approved access. Do not infer a replacement from Blue/Red or another account's
   catalog. Listing a model is not proof of Daybreak entitlement.
2. Run `openclaw doctor --lint --only openai/daybreak-alias-retirement` to locate
   configured aliases, saved session overrides, and scheduled jobs. The scan is
   read-only and reports incomplete store reads. To migrate, supply an explicit
   model and Access choice with [Doctor's model replacement option](/cli/doctor/running#daybreak-alias-migration).
   Plain `doctor --fix` does not guess a successor or Access program. Locked
   sessions, unavailable pinned accounts, conflicting target Access settings,
   and disallowed successors are preserved for manual resolution. Rerun the
   lint check after repair to find remaining references.
3. For Responses API use, follow the
   [Daybreak guide](https://developers.openai.com/api/docs/guides/daybreak),
   including its account settings and request requirements. Preserve explicitly
   configured reasoning capabilities and service tiers for the specific model;
   the old aliases' capabilities are not a contract for every underlying model.
4. Select an explicit access program in the chat Access control, or use Codex's
   own Daybreak controls with an approved specific model. Selecting a model or
   access program does not grant account access.

When no explicit session Access choice is saved, automatic cyber recovery retries
a replay-safe cyber refusal once on the same model and account with authorized
Blue Access. An explicit choice, including Standard, is not escalated. It preserves the runtime, effort,
speed, and saved session settings; ordinary configured model fallback remains
separate. Run `openclaw doctor --fix` to remove the retired `cyberFailover.model`
field from `agents.defaults.embeddedAgent.cyberFailover` (OpenClaw runtime) or
`plugins.entries.codex.config.appServer.cyberFailover` (native Codex). Doctor
preserves `mode` and `cooloffMs`, including explicit `mode: "off"`. See
[model failover](/concepts/model-failover#automatic-cyber-policy-escalation)
and [Codex runtime behavior](/plugins/codex-harness/runtime-behavior#automatic-daybreak-escalation).

### Chat Access control

The chat and new-session model controls provide a **Daybreak** toggle and an
**Access** selector when the account advertises a Daybreak program for the selected
model and runtime and your operator role permits it. Turning Daybreak off selects
**Standard**; turning it on restores the last permitted Blue or Red choice. Saved
choices remain scoped to the authenticated user and agent.

An unset session choice follows the configured model/agent Access default. Without
a configured default, supported OpenAI routes use Standard. An explicit session
choice overrides the default; an explicit empty model `accessPrograms: {}` retains
provider/native inheritance. If the saved choice becomes unavailable, select
Standard rather than silently downgrading the request.

The session choice survives `/new` and session reset, and is inherited by a fork
unless replaced. Changes affect the next admitted turn, not an already-running
model call. A `sessions_spawn` child on the same agent and model keeps the
requester's saved Access; pass
[`cyberAccessProgram`](/tools/subagents/tool-reference#tool-parameters) to choose
a program for the child explicitly.

Named operator roles grant Blue and Red independently through
`gateway.roles.definitions.<role>.accessPrograms.cyber`. An omitted or empty grant
list permits Standard only, including for admin-scoped roles or roles without
model restrictions. The actual model must separately be allowed by the role's
model policy, and provider entitlement is still required. Configured defaults do
not bypass these grants. Server-side checks cover direct requests, creation,
execution, and retained or recovered authority after permissions change.

The OpenClaw runtime sends the program to its official Responses endpoint. Native
Codex uses its supported turn-scoped access-program parameter. This OpenClaw
integration supports explicit native programs with ChatGPT subscription and
Platform API-key authentication. The managed Codex runtime enables API-key access
programs by default; an explicitly disabled native feature remains authoritative.
Native Codex checks its authenticated `model/list` access-program metadata before
submitting a Daybreak turn. A stale saved selection fails visibly before submission.

Entitlement comes only from authenticated `available_access_programs.cyber`
metadata (or native Codex's `availableAccessPrograms.cyber`), scoped to the selected
account, model, route, and runtime. Model listing membership or subscription type
alone is not entitlement. For Platform API keys, OpenClaw reads explicit program
metadata from the same authenticated Codex model endpoint used by the official
Codex client. The public `/v1/models` response remains the model-availability
authority: a capability row cannot add an unlisted model. The same API key scopes
both reads to its organization and project. Configured API keys and environment
credentials use their own discovery result, never another saved account's grants;
custom endpoints and request-header overrides do not inherit these grants.

This discovery uses read-only requests, not billable Responses probes. Successful
Platform and ChatGPT HTTP observations are cached for up to 60 seconds by
credential and endpoint; explicit catalog refresh bypasses that cache. This HTTP
TTL does not periodically refresh an already published account catalog; its
normal refresh and credential-change lifecycle still applies. A replaced
credential, missing or empty program metadata, or a failed capability refresh
never reuses another account's grants. Unknown or unavailable programs stay
hidden, without removing ordinary model access. Provider-side access changes may
also have their own propagation delay. Native Codex owns its separate model-list
cache and account-change invalidation. Explicit model parameters remain available;
the provider enforces entitlement on every actual request.

### Responses access program and speed

For the OpenClaw runtime on an official OpenAI Platform or ChatGPT subscription
Responses endpoint, set the selected
model's `params.accessPrograms.cyber` to `standard`, `daybreak_blue`, or
`daybreak_red`. Omitting the setting defaults supported routes to Standard; use
`accessPrograms: {}` to retain OpenAI's model/account/project defaults. Neither `accessPrograms` nor `cyber` accepts
`null`. Native Codex also accepts this model setting on ChatGPT authentication,
with the session override taking precedence. This setting never grants access.
An explicit incompatible program or missing entitlement returns the provider
error; OpenClaw does not silently switch to standard safeguards.

Daybreak and speed are separate request settings. For example, an approved
account using the publicly documented GPT-6.1 Sol route can request:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-6.1-sol": {
          agentRuntime: { id: "openclaw" },
          params: {
            accessPrograms: { cyber: "daybreak_blue" },
            serviceTier: "ultrafast", // "priority" for Fast
          },
        },
      },
    },
  },
}
```

GPT-6.1 Sol and GPT-6 Astra require **Daybreak Red approval** and project
access even though their request value is `daybreak_blue`; `daybreak_red` is not
the correct value for those models. Match the program to the selected model in
the [Daybreak guide](https://developers.openai.com/api/docs/guides/daybreak).
The model and account must independently support the requested
[Fast](https://developers.openai.com/api/docs/guides/fast-mode) or
[Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) tier.
OpenClaw sends both settings without applying the retiring aliases' speed limits
to specific model IDs. Provider authorization and fulfillment remain server-owned.

Until retirement, explicitly selected aliases retain their existing Responses
metadata: Blue keeps reasoning enabled and supports Standard/Fast; Red also
supports reasoning off and uses Standard. Neither supports Ultrafast. Their
unknown cost estimates do not mean requests are free. These legacy rows stay
only to keep existing selections interpretable during migration, not to name a
replacement or grant access.

## GPT-6 Astra

Select `openai/gpt-6-astra` with an OpenAI API-key profile or a ChatGPT/Codex
subscription that has access to Astra. Access is rolling out; a successful
account catalog remains authoritative, so adding model support does not grant
access to an account that has not received it.
If ChatGPT/Codex catalog discovery is unavailable, the offline fallback list
omits Astra until account discovery succeeds.

```bash
openclaw models set openai/gpt-6-astra
```

Astra uses the Responses API for agent tool calls. It supports text and image
input, a 1,050,000-token context window, and up to 128,000 output tokens.
OpenClaw retains its ordinary 272,000-token active input budget by default.
The supported reasoning efforts are `low`, `medium`, `high`, `xhigh`, and `max`.
OpenClaw defaults Astra to `medium` on both the OpenClaw and Codex runtimes
when the account supports that effort.
The OpenAI provider owns this default, so model selection, Control UI, and
Codex turn requests share it. Explicit agent, model, global, and session
thinking settings still take precedence; switching models does not clear an
existing `high` override. Use `/think default` to clear a session override.
An existing `minimal` setting maps to `low`. Astra cannot disable reasoning;
`off` never sends the unsupported `none` effort.
Temperature and `top_p` are not sent.
These defaults also apply to configured Astra model entries without explicit
reasoning or temperature compatibility metadata.
Azure Responses deployments continue to use their configured capabilities.

`/think ultra` is also available on the OpenClaw and Codex runtimes. Ultra enables
proactive sub-agent orchestration; it is not a raw Responses API effort. OpenClaw
uses `max`, while native Codex selects Astra's model-defined effort (`xhigh`).

Standard pricing per million tokens is $10 input, $1 cache reads, $12.50 cache
writes, and $50 output. Requests above 272K input tokens have higher rates.
See the [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [migration guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra).

### Async tools, steering, and reasoning changes

Use an OpenAI Platform API-key profile and the built-in OpenClaw runtime for
these Astra capabilities. They require the official `https://api.openai.com/v1`
Responses endpoint. Configure the existing model settings:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-6-astra": {
          agentRuntime: { id: "openclaw" },
          params: {
            transport: "auto",
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

- **Async function calls:** Astra can continue reasoning while OpenClaw runs a
  direct function tool. OpenClaw sends the completed result in the next model
  request after the active response finishes. This
  applies to direct tools; code-mode tools retain their existing execution flow.
  `sessions_yield` stays synchronous: it is how the model waits, so the response
  pauses there and the next request delivers the earlier async results.
- **Mid-turn steering:** [Steering messages](/concepts/queue#queue-modes) can
  reach Astra while it is reasoning, using the active session's cached
  WebSocket. Use `auto` or `websocket-cached`; SSE keeps ordinary queued
  steering at the next available runtime boundary. Each live batch owns one
  response; later messages can steer its successor. Context or payload hooks
  that rewrite the active request's prefix keep ordinary queued delivery.
- **Reasoning changes without rebuilding the cached prefix:** Change the
  [thinking level](/tools/thinking), for example with `/think high`, before
  the next user turn. OpenClaw preserves the original request-level effort
  and places a `configuration_update` at the new turn. This optimization
  works across matching session history over SSE or cached WebSockets, including
  concurrent SSE requests in the same session.
  Automatic steering continuations keep their inherited settings. If steering
  waits for a tool result or approval, the explicit continuation uses current
  request settings, including output limits and reasoning settings, without
  repeating accepted steering. Earlier `configuration_update` items retain
  their effect; a changed request-level effort does not replace those controls.
  When accepted steering waits for a tool result or approval and its history
  contains effort controls, finish that input with a compatible Astra model
  and mode before switching.

The example disables automatic server compaction because OpenAI cannot combine
it with configuration updates. Cache-preserving effort changes also exclude
automatic truncation, pro mode, and API multi-agent mode. The original effort
and admitted controls survive transport expiry and Gateway restarts in saved
provider replay metadata. Matching history replays the same prefix without
extending socket or provider cache lifetimes. Rewritten or compacted history,
incompatible settings, or a changed model, route, session, or auth profile starts
a fresh request using the selected effort. Older transcripts without this
metadata also start fresh after transport expiry.

The native [Codex harness](/plugins/codex-harness) owns its own Responses loop.
OpenClaw enables its cache-preserving reasoning-effort updates for managed
threads, including when native code mode is disabled. Codex uses its model
catalog to decide eligibility and keeps unsupported models on ordinary
request-level effort. This does not enable the built-in-runtime async-tool or
steering implementation inside Codex.

## GPT-6.1 Sol

Select `openai/gpt-6.1-sol` with an OpenAI API-key profile or a
ChatGPT/Codex subscription that exposes it:

```bash
openclaw models set openai/gpt-6.1-sol
```

It uses the Responses API for tool calls, accepts text and images, and supports
a 1,050,000-token context window with up to 128,000 output tokens. Direct
OpenAI API-key traffic keeps its 272,000-token active input budget by default.
The OpenClaw harness defaults to a 500,000-token active window with ChatGPT/Codex
subscription auth; native Codex owns its context window and compaction. Explicit
context budgets, other models, and the Astra setup default are unchanged. A successful account
catalog remains authoritative, including smaller account-specific windows;
subscription offline hints do not imply access.

Reasoning defaults to `medium` and supports `low`, `medium`, `high`, `xhigh`,
and `max`. Unlike GPT-6 Sol, GPT-6.1 Sol cannot disable reasoning: `off` does
not send `none`, and `minimal` maps to `low`. OpenClaw offers `/think ultra`
through its existing orchestration mode; native Codex uses the account's
advertised efforts.

Standard API prices per million tokens are $2 input, $0.10 cache reads, $2.50
cache writes, and $10 output. Above 272K input tokens, input and cache rates
double and output costs 1.5 times the standard rate for the full request.
See the [GPT-6.1 Sol model reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
for current capabilities, pricing, and regional availability.

## GPT-6 Sol and Luna

Select `openai/gpt-6-sol` or `openai/gpt-6-luna` with an OpenAI API-key
profile or a ChatGPT/Codex subscription that exposes the model. Check the
selected account's catalog, then choose the model:

```bash
openclaw models list --provider openai
openclaw models set openai/gpt-6-sol
```

Use `openclaw models set openai/gpt-6-luna` to select Luna. API organization
and Codex workspace access can differ. A successful account catalog is
authoritative; OpenClaw does not add subscription access or silently substitute
another model. When subscription discovery is unavailable, the offline fallback
list omits both models. Existing model selections stay unchanged, and fresh
OpenAI setup continues to use Astra.

Both models use the Responses API for agent tool calls and support text and
image input, a 1,050,000-token context window, and up to 128,000 output tokens.
OpenClaw defaults to a 272,000-token active input budget. Native Codex follows
the selected account's advertised context limits.

The API reasoning efforts are `none`, `low`, `medium`, `high`, `xhigh`, and
`max`. OpenClaw defaults to `medium` when available; existing explicit thinking
settings still take precedence. `/think off` selects `none`, and `/think default`
clears a session override. Native Codex uses the effort levels reported by the
selected account. OpenClaw's `/think ultra` mode uses `max`; native Codex offers
Ultra only when the account advertises it.

Standard API pricing per million tokens:

| Model      | Input | Cache reads | Cache writes | Output |
| ---------- | ----- | ----------- | ------------ | ------ |
| GPT-6 Sol  | $2    | $0.20       | $2.50        | $10    |
| GPT-6 Luna | $0.10 | $0.01       | $0.125       | $0.50  |

See the [GPT-6 Sol model reference](https://developers.openai.com/api/docs/models/gpt-6-sol)
and [GPT-6 Luna model reference](https://developers.openai.com/api/docs/models/gpt-6-luna)
for current capabilities and pricing.

## GPT-5.6 limited preview

OpenClaw recognizes the exact `openai/gpt-5.6-sol`,
`openai/gpt-5.6-terra`, and `openai/gpt-5.6-luna` model ids. All three expose
`xhigh` and `max` reasoning in the current catalog. OpenAI describes Sol as
the flagship tier, Terra as the balanced tier, and Luna as the fast,
lower-cost tier. See the
[GPT-5.6 launch announcement](https://openai.com/index/previewing-gpt-5-6-sol/)
and [access guide](https://help.openai.com/en/articles/20001325-a-preview-of-gpt-5-6-sol-terra-and-luna).

OpenAI's [GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
documents the bare `openai/gpt-5.6` id as a supported alias for Sol. Fresh
API-key and ChatGPT/Codex OAuth setup use `openai/gpt-6-astra`. Existing
GPT-5.6 selections retain their full Sol identity. Run
`openclaw doctor --fix` to rewrite persisted bare OpenAI refs to that full
identity. The native Codex catalog can show the exact Sol, Terra, and Luna ids depending on
workspace access. Check the current account with:

```bash
openclaw models list --provider openai
```

API organization and Codex workspace access can differ. If GPT-5.6 is not
available, select GPT-5.5 explicitly:

```bash
openclaw models set openai/gpt-5.5
```

OpenClaw surfaces the upstream access error and does not silently replace a
GPT-5.6 selection with GPT-5.5.

<Note>
Eligible exact official HTTPS routes may select the bundled Codex app-server
plugin when runtime policy is unset or `auto`; authored Completions routes,
custom endpoints, and request-transport overrides remain on OpenClaw. Plaintext
official HTTP endpoints are rejected. Explicit provider/model runtime config remains
authoritative. Run `openclaw doctor --fix` to repair stale legacy Codex model
refs, `codex-cli/*` refs, or old runtime session pins that were not set by
explicit runtime config.
</Note>

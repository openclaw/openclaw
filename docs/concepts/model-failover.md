---
summary: "How OpenClaw rotates auth profiles and falls back across models"
read_when:
  - Diagnosing auth-profile rotation, cooldowns, or model fallback behavior
  - Updating failover rules for auth profiles or models
  - Understanding how session model overrides interact with fallback retries
title: "Model failover"
sidebarTitle: "Model failover"
---

OpenClaw handles failures in two stages:

1. **Auth-profile rotation** within the current provider.
2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

Turn usage includes completed model candidates even when their answer is discarded
during fallback. Costs retain each candidate's price; if any completed candidate's
price is unavailable, the total cost stays unknown. The final selected model and
its last-call usage still determine the reported model and context-window usage.

Before rotating profiles or changing models, the runner attempts bounded
same-model recovery for temporary rate limits and provider failures. It continues
the existing transcript, preserving partial output and completed work. The agent
is instructed to inspect interrupted actions before deciding whether to repeat
them. A retry status shows the wait and attempt count. Cancellation remains
available. No additional configuration is required.

Explicit organization tokens-per-minute (TPM) exhaustion is tracked per model.
Embedded model calls and direct completions share a process-local admission gate:
requests using the affected provider endpoint, account, and model wait for
the provider's retry floor before being sent. This includes streamed rate-limit
errors. `Retry-After` and exhausted quota reset headers are honored by the provider
error parser. A full-refill reset is not a minimum wait when the bucket still has
tokens and the provider supplies a shorter retry hint.

During recovery, interactive turns take priority over subagents and background
work such as reviews and titles. Queued requests resume one at a time with
100–250 ms of jitter between admissions. The status reads **Waiting for rate
limit**; cancellation, run deadlines, retry budgets, and configured delay caps
still apply. The gate does not retry requests itself. A different fallback model
using the same account has its own gate.

Accounts share a gate when their explicit organization header or observed provider
error identifies the same organization. Until then, credentials are scoped
separately; requests without an account identity cannot be coordinated. State is
in memory and expires one minute after the latest retry floor. Successful traffic
does not extend recovery pacing. This does not coordinate other Gateway
processes or native harness transports such as the Codex app-server, which retain
their own transport and retry policies.

When a replay-safe embedded turn has an eligible model fallback, shared TPM
exhaustion allows at most two same-model retries within a 15-second recovery
window before advancing to that fallback. Without a fallback, the longer
rate-limit retry budget remains available. New turns route around a model with
an active gate when a later eligible candidate is available. If every eligible
candidate is saturated, the candidate with the earliest retry time enters its
shared gate. These switches use the existing rate-limit fallback notices,
status, and session stickiness. Once the gate expires, new sessions can start on
the primary again; sessions already using a sticky fallback keep that preference.

An output-token limit is separate from a transient provider outage. The embedded
runtime permits at most one continuation for a truncated Responses tool call or
an empty length stop that still needs an answer. It records an output-limit
notice and continues the saved transcript, preserving completed actions. A
second output limit surfaces the unfinished result. Raw model runs and
`promptMode: "none"` cannot carry that history, so they surface the output limit
without replaying the original request. Visible partial answers remain visible.

For Responses, `max_output_tokens` includes reasoning and visible output. The
request uses the configured `maxTokens` override or the model's output cap;
service tier does not independently change that cap. A long generation with
ongoing progress can exceed the stream's idle timeout. The separate run deadline
still applies; see [Agent loop timeouts](/concepts/agent-loop#timeouts).

ChatGPT Responses WebSocket connection expiry and a normal close before the
terminal event follow this recovery policy even after streaming starts. The failed socket is retired; recovery continues the
saved transcript instead of replaying the request inside the transport.

Anthropic streaming errors retain their structured error type, so rate limits,
overload, and authentication failures follow the same recovery policy even when
the provider's message is generic.

Local worker deadlines and capacity refusals stop model fallback because another
provider cannot repair local saturation. Capacity errors ask you to check for
completed work before trying again. Genuine provider HTTP errors keep the normal
fallback policy.

Local transcript write conflicts do not retry the model, rotate accounts, or
trigger model fallback. The transcript owner rereads the current revision and
retries an eligible append once. A repeated conflict is reported as a local
error; an older reply cannot overwrite or bypass a newer user turn.

Session-state changes before prompt admission also stop model fallback. If the
persisted user turn changes or the session reader is no longer current, OpenClaw
preserves the session-state error for the session's retry owner or reports it to
the caller. These errors do not produce an `unknown` provider-failure notice.

Losing the canonical user turn during prompt projection also stops unchanged
retries and model fallback. If MCP cleanup cannot confirm closure, OpenClaw
preserves that cleanup failure instead of starting another model. Session and
cleanup recovery remain with their respective owners; changing providers cannot
repair these local faults.

Thinking-level recovery applies only when the provider identifies a reasoning or
thinking parameter. Model/account restrictions and unrelated unsupported options
keep their original failure classification and follow the configured fallback
policy. OpenClaw does not retry them with thinking disabled.

## Runtime flow

<Steps>
  <Step title="Resolve session state">
    Resolve the active session model and auth-profile preference.
  </Step>
  <Step title="Build candidate chain">
    Build the model candidate chain from the current model selection and the fallback policy for that selection source. Configured defaults, cron job primaries, and auto-selected fallback models can use configured fallbacks. A user selection that matches the configured primary keeps that chain; a different user-selected model is strict.
  </Step>
  <Step title="Try the current provider">
    Try the current provider with auth-profile rotation/cooldown rules. Runs apply bounded recovery to eligible transient failures before rotating profiles or advancing model fallback.
  </Step>
  <Step title="Advance on failover-worthy errors">
    If that provider is exhausted with a failover-worthy error, move to the next model candidate.
  </Step>
  <Step title="Use fallback for the current turn">
    Run the winning fallback candidate without changing the session's selected provider/model.
  </Step>
  <Step title="Report failure if exhausted">
    If every candidate fails, surface the terminal failure. Thrown exhaustion summaries include structured per-attempt details and the soonest cooldown expiry when one is known.
  </Step>
</Steps>

Fallback execution does not change the session's selected model. Most fallbacks apply only to the current turn; eligible rate-limit fallbacks can stay first for later turns through in-memory [session stickiness](#rate-limit-fallback-stickiness). The reply runner persists only fallback notice state so `/status` and transition notices can distinguish the selected model from the model that answered. It does not persist the fallback as the next turn's model selection.

A fallback that only relays a completed task result cannot start new delegated work.
A verified requester continuation after its child tasks settle is different: on
the built-in and plugin harness paths, it retains the requester's authorized
session tools so unfinished work can continue. The live settlement owner and
persisted child lineage must still match; an active Goal or completion message
alone does not grant that exception. The exception is host-mediated: native
collaboration stays disabled because it does not carry the settlement owner’s
final-effect authority check. Existing tool restrictions and Stop still apply.
CLI backends that cannot enforce settlement authority keep the report-only restriction.

Sessions placed on an OpenClaw cloud worker keep the OpenClaw runtime when
automatic model selection advances to a fallback. The configured provider,
model, and auth-profile fallback rules still apply. Explicit session or
configured runtime choices remain strict: an incompatible runtime reports a
placement error and requires a compatible destination before retrying.

When a failed cloud-worker candidate has already committed output, its fallback
continues from that output, including completed tool results. The worker starts
from the matching transcript leaf. Unrelated transcript changes still retain the
admission fence and can reject the worker's commit rather than overwrite history.

When configured fallback stops because the agent run reaches a final timeout or
the idle-timeout cost-runaway breaker returns a terminal error, the
`model-fallback/decision` logger records `model_fallback_chain_stopped` with
reason `agent_run_terminal_timeout` or `idle_timeout_circuit_breaker`. These are
terminal stops, not provider failures or requests to try another model. The
existing run deadline and cost limits still apply.

Fallback requests reuse the original user turn and its attachments exactly once.
Fresh plugin context for the fallback model is added separately, preserving the
user turn and the prompt prefix already sent to the primary model.

## Automatic cyber-policy escalation

A structured OpenAI cyber-policy refusal can trigger one **Access configuration retry**:
OpenClaw keeps the same model, provider, runtime, account, effort, and speed, and retries
with `access_programs: { cyber: "daybreak_blue" }`. This is not model failover and does
not require a different model or a nonempty model fallback list. An exact model pin
therefore remains in force.

The default `cyberFailover.mode: "auto"` applies only to a replay-safe refusal from the
current attempt. Generic refusal text, other policy categories, cancellation, and
attempts with committed side effects do not qualify. The selected account must advertise
Blue for this model and runtime on its current route; an unknown or missing grant does
not authorize a request. A turn already using Blue or Red is never retried or downgraded.
Model names and retiring aliases are not evidence of entitlement.

The embedded Responses transport recognizes structured cyber refusals from HTTP error
bodies, streamed `error` events, and `response.failed` events. Native Codex uses its
[plugin-owned retry](/plugins/codex-harness/runtime-behavior#automatic-daybreak-escalation)
and validates the same account's native capabilities before `turn/start`.

The retry is turn-local and does not save a new session model or Access setting. If it
fails without committing work, the original refusal is preserved. If the retry commits
work or is cancelled, its own result and receipts are retained. Recorded terminal stops
and unclassified errors are not swallowed. An authorization denial temporarily suppresses
further Blue attempts for that session/model/account without cooling down ordinary
Standard requests.

To disable automatic Access escalation:

```json5
{
  agents: {
    defaults: {
      embeddedAgent: {
        cyberFailover: {
          mode: "off", // "auto" is the default
          cooloffMs: 600000,
        },
      },
    },
  },
}
```

The retired `cyberFailover.model` setting is removed by `openclaw doctor --fix`,
which preserves `mode` and `cooloffMs`. Ordinary configured cross-model fallback remains
separate and unchanged. The Blue/Red model aliases retire on October 28, 2026; choose an
actual available model and let Access select the program rather than inventing an alias
successor.

## Selection source policy

The selection source controls whether the fallback chain is allowed:

- **Configured default**: `agents.defaults.model.primary` uses `agents.defaults.model.fallbacks`.
- **Native agent primary**: `agents.entries.*.model` is strict unless that agent's model object includes its own `fallbacks`. Use `fallbacks: []` to make the strict behavior explicit, or a non-empty list to opt that agent into model fallback.
- **ACP agent primary**: for `runtime.type: "acp"`, the agent primary selects its external harness model. Native OpenClaw calls inherit the primary and fallbacks from `agents.defaults.model`; an explicit agent `model.fallbacks` replaces the native fallback list, including `[]` to disable it. Explicit native session and subagent selections retain their normal precedence and strictness. This does not add fallback to commands such as `/btw` that run only their selected model.
- **Runtime fallback**: the next turn normally starts from the selected primary again. Eligible rate-limit fallbacks temporarily stay first through session stickiness without changing that selection. OpenClaw still recognizes `modelOverrideSource: "auto"` entries stored by v2026.4.26 through v2026.6.0. It checks their configured origin every 5 minutes, and clears them once the origin recovers. Automatic clearing shipped in v2026.6.1. `/new`, `/reset`, and `sessions.reset` also clear those entries.
- **Configured or inherited child selection**: a child can store an automatic selection whose provider/model match its own recorded origin. Ordinary replies preserve that selection; it is not legacy fallback residue.
- **User session override**: deliberately selecting a different model with `/model`, the model picker, `session_status(model=...)`, or `sessions.patch` creates a strict selection. If it fails before producing a reply, OpenClaw reports the failure instead of answering from an unrelated fallback. Selecting the agent's configured primary keeps its configured fallback chain. Explicit empty fallback lists and model-selection locks still disable fallback.
- **Explicit configured default**: choosing **Default** through the same surfaces writes `modelOverrideSource: "default"` without storing a provider/model override. This prevents a child session from inheriting a parent model pin while preserving the configured default's normal fallback policy.
- **Legacy session override**: session entries written before v2026.4.26 may have `modelOverride` without `modelOverrideSource`. OpenClaw treats those as user overrides so an explicit old selection is not silently converted into fallback behavior.
- **Cron payload model**: a cron job `payload.model` / `--model` is a job primary, not a user session override. It uses configured fallbacks unless the job provides `payload.fallbacks`. `payload.fallbacks: []` makes the cron run strict.

Creating a session with the agent's effective configured primary, including a
remembered new-session default, stores no provider/model override. A different
requested model remains an explicit selection.
Existing saved `user` overrides equal to the current configured primary also
keep the configured chain. They remain readable without a Doctor migration or
database rewrite. To clear an existing override explicitly, use `sessions.patch`
with `model: null`, rather than writing the displayed default back as a model.

An agent can override only its fallback chain with `model: { fallbacks: [...] }`
and keep inheriting the shared primary. Setting `fallbacks: []` explicitly disables
fallbacks without pinning that primary. In **Settings → Agents → Overview**, editing
fallback chips preserves primary inheritance. Removing every chip saves an empty
chain instead of restoring the shared fallbacks.

## Auth storage (keys + OAuth)

OpenClaw uses **auth profiles** for both API keys and OAuth tokens.

- Secrets and runtime auth-routing state live in `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`.
- Config `auth.profiles` / `auth.order` are **metadata + routing only** (no secrets).
- Legacy `credentials/oauth.json`, `auth-profiles.json`, `auth-state.json`, and
  per-agent `auth.json` files are imported only by `openclaw doctor --fix`.
  Runtime execution is blocked for the affected agent until credential-bearing legacy
  files are migrated. It never silently imports or falls back to them.

More detail: [OAuth](/concepts/oauth)

Credential types:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for some providers)
- `type: "token"` → static bearer-style token, optionally expiring. OpenClaw does not refresh it (used for `aws-sdk` and other credential-chain auth modes)

## Profile IDs

OAuth logins create distinct profiles so multiple accounts can coexist.

- Default: `provider:default` when no email is available.
- OAuth with email: `provider:<email>` (for example `openai:user@example.com`).

Profiles live in the per-agent `openclaw-agent.sqlite` auth profile store.

## Rotation order

When a provider has multiple profiles, OpenClaw chooses an order like this:

<Steps>
  <Step title="Stored order override">
    The per-agent order set with `openclaw models auth order set --provider <id> <profileIds...>`.
  </Step>
  <Step title="Explicit config">
    `auth.order[provider]` (if set).
  </Step>
  <Step title="Configured profiles">
    `auth.profiles` filtered by provider.
  </Step>
  <Step title="Stored profiles">
    Per-agent SQLite auth profile entries for the provider.
  </Step>
</Steps>

If no explicit order is configured, OpenClaw uses a round-robin order:

- **Primary key:** profile type (**OAuth, then static token, then API key**).
- **Secondary key for OAuth:** profiles with a currently usable access token before
  profiles whose access token is expired. Expired OAuth profiles stay eligible so
  the runtime can refresh them when no usable peer is available.
- **Next key:** `usageStats.lastUsed` (oldest first, within each type/state tier).
- **Cooldown/disabled profiles** are moved to the end, ordered by soonest expiry.

### Session stickiness (cache-friendly)

Clearing or rotating an auth pin affects only the selected agent’s session, including custom session stores and the reserved `global` and `unknown` session keys.

OpenClaw **pins the automatically chosen auth profile per session** to keep provider caches warm. It does **not** rotate on every request. An automatic pin may rotate or clear when:

- the session is reset (`/new` / `/reset`)
- the profile is in cooldown/disabled

Context compaction does not change the selected auth profile. A healthy profile remains pinned
across compaction; auth failures and unavailable profiles still use the normal fallback order.

Manual selection via `/model …@<profileId> -s` sets a **user override**. A valid user pin survives `/new`, `/reset`, session rollover, compaction, and cooldown windows. It remains the first preference when eligible. While that exact profile is in cooldown or disabled, OpenClaw tries the next eligible same-provider profile without replacing the stored pin. Explicitly removing a saved credential clears its affected agent model and conversation account selections while retaining the selected models. Other accounts, including independent credentials owned by another agent, keep their selections. A temporarily missing or expired credential does not clear a user pin; refresh can restore access. If an older configuration still names a deleted account, choose an available account in Models. OpenClaw also clears an incompatible pin when the selected provider changes, or replaces it when the user selects another account. `/model default -s` clears the model override while retaining a compatible auth pin and clearing an incompatible one.

<Note>
Auto-pinned and user-pinned auth profiles are both retry preferences. OpenClaw tries the selected profile first while it is eligible. It may then rotate to another same-provider profile on auth failures, rate limits, billing limits, or timeouts. A user pin stays persisted during that temporary rotation. New runs prefer it again after its cooldown expires, without changing the selected model or runtime. This auth rotation does not loosen model selection: a different explicit user provider/model selection remains strict and reports failure after its same-provider auth profiles are exhausted.
</Note>

### OpenAI Codex subscription plus API-key backup

For OpenAI agent models, auth and runtime are separate. `openai/gpt-*` stays on the Codex harness while auth can rotate between a Codex subscription profile and an OpenAI API-key backup.

Use `auth.order.openai` for the user-facing order:

```json5
{
  auth: {
    order: {
      openai: ["openai:user@example.com", "openai:api-key-backup"],
    },
  },
}
```

Use `openai:*` for both ChatGPT/Codex OAuth profiles and OpenAI API-key profiles. When the subscription hits a Codex usage limit, OpenClaw records the exact reset time when Codex provides one. It tries the next ordered auth profile, and keeps the run inside the Codex harness. Once the reset time passes, the subscription profile is eligible again and the next automatic selection can return to it.

Use a user-pinned profile to make one account/key the durable first preference for that session. If it becomes unavailable, OpenClaw temporarily rotates through the remaining eligible `auth.order.openai` profiles and returns to the pinned profile after recovery.

## Cooldowns

When a profile fails due to auth or rate-limit errors, OpenClaw moves to the next profile. Auth failures put the profile in cooldown. A timeout that looks like rate limiting counts as a rate-limit failure.

OpenClaw does not invent rate-limit cooldowns. A rate-limited profile enters cooldown only when the provider says how long to wait, and the cooldown lasts exactly that long. Provider timing comes from `retry-after-ms`, `Retry-After` (seconds or an HTTP date), retry text such as OpenAI's `Please try again in 6s` or Gemini's `Please retry in 32s`, or Google `RetryInfo.retryDelay`, read from the full error body. When the provider sends no explicit retry instruction, the reset time of an exhausted bucket applies instead: OpenAI `x-ratelimit-reset-*` or Anthropic `anthropic-ratelimit-*-reset`. Without any provider timing, the profile stays available for the next turn; the current turn still rotates to another profile or model. Repeated or concurrent rate limits never lengthen a cooldown. A later provider deadline extends it, and an earlier one cannot shorten it. Provider-reported usage-window resets, such as Codex subscription limits, remain separate blocks. Rate-limit cooldowns left by older releases' local backoff are released on upgrade.

Same-model rate-limit retries also record the failed profile before waiting, using the same provider timing. Later runs see that cooldown through normal profile selection and status. A quota probe that finds capacity available adds no delay of its own. Model-scoped cooldowns still allow other models on the same profile. After a rate limit, an automatic session fallback returns to an earlier profile in an explicit `auth.order` as soon as that profile is usable again; a successful request clears its rate-limit record.

After bounded recovery, a model-silent or request timeout records profile cooldown only when an authorized replacement profile is selected or a model fallback is configured; otherwise the profile stays available for the next turn.

A provider plugin can declare `managesOwnAvailability: true` in `openclaw.plugin.json` when its upstream gateway owns capacity recovery. This applies to the plugin's declared providers and skips only rate-limit and overload cooldowns (`rate_limit` and `overloaded`). OpenRouter and Kilo Gateway use this declaration. Billing, authentication, permanent credential failures, and provider-reported subscription blocks remain enforced. Routing and auth status use the same policy, including before the provider runtime loads. There is no user configuration setting.

CLI-backed runtimes settle profile health only after their resume, fork, and fresh-session recovery attempts finish. A terminal credential failure cools down the exact selected profile before model fallback. A successful run clears stale failure state. Transcript, format, context, pre-provider timeout, and ambient CLI failures without a selected profile do not change shared profile health.

A delayed WHAM failure check cannot reinstate an exhaustion block after a newer successful request with the same credential.

<AccordionGroup>
  <Accordion title="What lands in the rate-limit / timeout bucket">
    That rate-limit bucket is broader than plain `429`: it also includes provider messages such as `Too many concurrent requests`, `ThrottlingException`, `concurrency limit reached`, `workers_ai ... quota limit exceeded`, `throttled`, `resource exhausted`, and periodic usage-window limits such as `weekly limit reached` or `monthly limit exhausted`.

    Format/invalid-request errors are usually terminal because retrying the same payload would fail the same way, so OpenClaw surfaces them instead of rotating auth profiles. Known retry-repair paths can opt in explicitly: for example Cloud Code Assist tool call ID validation failures are sanitized and retried once through the `allowFormatRetry` policy.

    HTTP 400/422 responses with no body or only a whole-body redaction placeholder stay unclassified because they contain no surviving evidence of a format failure.

    OpenAI-compatible **provider-completed** stop/finish reasons such as `Unhandled stop reason: error`, `stop reason: error`, `reason: error`, and `Provider finish_reason: error` are classified as **`server_error`** (HTTP-like status 500), not timeout. They remain failover-worthy for model or auth-profile rotation, but diagnostics keep the provider finish-reason text instead of rewriting the user copy to "LLM request timed out." Transport-shaped finish reasons such as `Provider finish_reason: abort`, `network_error`, and `malformed_response` stay in the timeout/failover bucket (status 408).

    HTTP status mapping uses **`server_error`** for otherwise-unclassified non-timing `5xx` failures, including `502` and `503`. HTTP `529` retains **`overloaded`**. The timing statuses retain **`timeout`**: request timeout `408`, gateway timeouts `504`, `522`, and `524`, and nginx client-abort `499`. More-specific provider errors and context classifications keep their existing precedence.

    Text-only provider envelopes such as `Google Generative AI API error (503): ...` use the same status mapping, so configured fallback still advances without a separate numeric status. Explicit numeric status fields take precedence; unrelated text containing numbers does not supply an HTTP status.

    Generic server text can also land in that timeout bucket when the source matches a known transient pattern. For example, the bare model runtime stream-wrapper message `An unknown error occurred` is treated as failover-worthy for every provider. The shared model runtime emits it when provider streams end with `stopReason: "aborted"` or `stopReason: "error"` without specific details. JSON `api_error` payloads with transient server text such as `internal server error`, `unknown error, 520`, `upstream error`, or `backend error` are also treated as failover-worthy timeouts.

    OpenRouter-specific generic upstream text such as bare `Provider returned error` is treated as timeout only when the provider context is actually OpenRouter. Generic internal fallback text such as `LLM request failed with an unknown error.` stays conservative and does not trigger failover by itself.

  </Accordion>
  <Accordion title="SDK retry-after caps">
    Some provider SDKs may otherwise sleep for a long `Retry-After` window before returning control to OpenClaw. For Stainless-based SDKs such as Anthropic and OpenAI, OpenClaw caps SDK-internal `retry-after-ms` and `retry-after` waits at 60 seconds by default. It surfaces longer retryable responses immediately, so this failover path can run. Tune or disable the cap with `OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS`. See [Retry behavior](/concepts/retry).
  </Accordion>
  <Accordion title="Model-scoped cooldowns">
    Rate-limit cooldowns can also be model-scoped:

    - OpenClaw records `cooldownModel` for rate-limit failures when the failing model id is known.
    - A sibling model on the same provider can still be tried when the cooldown is scoped to a different model.
    - Billing/disabled windows still block the whole profile across models.

  </Accordion>
</AccordionGroup>

Other cooldowns, apart from rate limits, billing and permanent auth failures, scale with the profile's recent error count:

- 1st failure: 30 seconds
- 2nd failure: 1 minute
- 3rd+ failure: 5 minutes (cap)

Counters reset once the profile's built-in failure window has passed.

State is stored in the per-agent SQLite auth state under `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

### Rate-limit fallback stickiness

Switching models mid-session discards the provider prompt cache, so bouncing between the selected model and its fallback on every turn re-sends the whole prompt uncached each time. After a normal agent turn falls back because the selected model hit a rate limit, that session's next turns try the successful fallback first. Each successful use extends a 10-minute idle window, up to a 30-minute cap from the first fallback; after that, turns start from the selected model again. The selected model stays next in the chain, so a failing fallback still reaches it within the same turn.

This preference is per session and in memory. Restarting, a fallback failure, changing the selected model, or removing the fallback from the allowed chain clears it. It never applies to strict selections with no fallbacks, turns whose model a `before_model_resolve` hook rerouted, or other sessions, and it adds no auth-profile cooldown. Compaction and other internal model calls keep turn-local fallback. Sticky turns are still fallback turns: `/status` shows the active fallback, and completion reports on them follow the fallback delegation rule above.

## Auth failure skip cache

By default, every new turn keeps the existing fallback retry behavior. OpenClaw retries each configured fallback candidate again. This includes non-primary candidates that recently failed with `auth` or `auth_permanent`.

Opt in to suppress repeat auth failures with:

```bash
OPENCLAW_FALLBACK_SKIP_TTL_MS=60000
```

When enabled, OpenClaw records an in-memory, session-scoped skip marker for a non-primary fallback candidate after an auth-class failure. The key includes the session, provider, model, and selected automatic or explicit profile ID. Switching profiles does not inherit another profile's failure marker. Primary candidates are never skipped, so an explicit user model selection still surfaces the real auth error. The cache is process-local and clears on Gateway restart.

The value is a TTL in milliseconds. `0` or unset disables the cache. Positive values are clamped between 1 second and 10 minutes.

## Billing disables

Billing/credit failures (for example "insufficient credits" / "credit balance too low") are treated as failover-worthy. OpenClaw marks the credential as **disabled** for ten minutes initially and rotates to the next eligible profile/provider.

Configured inline API keys cannot retry during an active disable window. After the window expires, they become eligible again. Another billing failure starts a new ten-minute window. Stored auth profiles can also recover through bounded primary-provider checks during a disable window. Recharging does not itself clear persisted state, and upgrading leaves an already-active window at its existing deadline.

<Note>
Not every billing-shaped response is `402`, and not every HTTP `402` lands here. OpenClaw keeps explicit billing text in the billing bucket, even when a provider returns `401` or `403` instead. Provider-specific matchers stay scoped to the provider that owns them, for example OpenRouter `403 Key limit exceeded`.

Meanwhile temporary `402` usage-window and organization/workspace spend-limit errors are classified as `rate_limit` when the message looks retryable (for example `weekly usage limit exhausted`, `daily limit reached, resets tomorrow`, or `organization spending limit exceeded`). Those stay on the short cooldown/failover path instead of the long billing-disable path.
</Note>

High-confidence permanent-auth failures (revoked/deactivated keys, deactivated workspaces) use the same ten-minute initial disable window because some providers surface auth-looking payloads transiently during incidents.

State is stored in the per-agent SQLite auth state:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Overloaded and rate-limit errors allow one same-provider auth-profile rotation by default before advancing to the next configured model fallback. The active runtime first uses its eligible same-model recovery budget. Auth-profile rotation and model fallback still require evidence that replaying the original attempt is safe.

Confirmed pre-execution tool rejections do not by themselves make an attempt
replay-unsafe. Non-replay-safe operations that started, or may have started,
still block replay.

## Model fallback

If all profiles for a provider fail, OpenClaw moves to the next model in `agents.defaults.model.fallbacks` when the failure matches one of the failover reasons listed below. This includes `model_not_found` for HTTP 404 responses. It does not include a 404 whose response body identifies a more specific condition, such as context overflow, session expiry, billing, authentication, or request format. Provider errors that do not expose enough detail are still labeled precisely in fallback state. `empty_response` means the provider returned no usable message or status. `no_error_details` means the provider explicitly returned `Unknown error (no error details in response)`. `unclassified` means OpenClaw preserved the raw preview but no classifier matched it yet.

Provider-busy signals such as `ModelNotReadyException` land in the overloaded bucket and follow the same one-rotation-then-fallback policy as rate limits.

`agents.defaults.timeoutSeconds` and run-specific model timeouts apply to each model candidate attempt. When an attempt times out, the next configured fallback receives its own full budget, so total elapsed time can exceed the setting. Progress does not renew an attempt's budget. User cancellation stops the entire fallback chain, and an independent outer deadline, such as the cron scheduler's deadline, still applies. See [Agent timeouts](/concepts/agent-loop#timeouts).

The failover controller owns OpenClaw's transient recovery budget. Rate limits normally receive up to **16 total attempts (15 retries) per consecutive outage** before auth-profile rotation or model fallback. Shared TPM exhaustion with a replay-safe model fallback uses the shorter two-retry, 15-second window described above. Backoff starts around one second, grows exponentially with jitter, and caps at 60 seconds for rate limits and 30 seconds for other transient failures. Provider timing sets the minimum wait; a longer provider floor is still honored, subject to `retry.provider.maxRetryDelayMs`. Other transient failures retain eight retries and a 90-second window for consecutive outages. A completed successful model response resets that window, the retry count, and backoff; partial output and tool activity alone do not. Existing per-attempt timeouts and any independent outer deadline remain authoritative. Once that budget or window is exhausted, recovery proceeds to eligible auth-profile rotation, configured model fallback, or a visible error. Continuations preserve the transcript instead of replaying the original user request. Recovery remains turn-local; an eligible rate-limit fallback winner can stay first through session stickiness.

The existing session setting `retry.provider.maxRetries` overrides OpenClaw's continuation retry count for the embedded runtime and participating local Codex, Copilot, and Muse runs. `0` disables these retries, and rate limits remain capped at 16 total attempts (15 retries) per consecutive outage. An omitted setting preserves the harness's existing retry count or OpenClaw's default. Remote/container execution and harnesses without an admitted local settings scope keep their existing budgets. This is not an `openclaw.json` key; it does not change native request retries, delays, or timeouts. The embedded-only `retry.provider.maxRetryDelayMs` and `timeoutMs` settings keep their existing scope. Native harnesses may finish their own request retries before OpenClaw starts continuation recovery. The reply runner does not add another whole-turn replay loop, and a zero retry count still permits tool-free finalization of completed work. See [Retry policy](/concepts/retry) for settings precedence, pacing, and exclusions.

While waiting, the Control UI shows one transient **Retrying… n/16** indicator for rate limits. Retried failures do not become persisted assistant messages. Terminal failure retains one error. History hides recovered empty or reasoning-only errors without rewriting stored transcripts.

Visible failure messages preserve the provider's HTTP status independently of retry classification. A provider HTTP 500 remains a server error in the final reply, and recovery classifies it as `server_error` rather than grouping it with timeout-shaped failures. Raw provider response details stay out of that reply.

Gateway transcript-validation failures are local format errors. They do not rotate or cool down healthy credentials, and both assistant errors and thrown run failures identify the rejected session transcript entry with recovery guidance. Genuine provider-session expiry keeps its existing credential-health behavior.

Provider overloads and HTTP 5xx failures use transient recovery guidance. A message saying only that a model is "not available" does not establish that it was retired or that your configuration needs to change. Configuration guidance requires a missing-model response or an explicit account/model restriction. Codex turn errors retain their overload and HTTP-status information even after Codex stops retrying the turn.

When a run starts from the configured default primary, a cron job primary, an agent primary with explicit fallbacks, or an auto-selected fallback override, OpenClaw can walk the matching configured fallback chain. Agent primaries without explicit fallbacks are strict. Explicit user selections of a different model are also strict: `/model ollama/qwen3.5:27b`, the model picker, `sessions.patch`, and one-off CLI provider/model overrides. Selecting the configured primary retains its configured chain. If that provider or model is unreachable, or fails before producing a reply, OpenClaw reports the failure instead of answering from an unrelated fallback.

### Candidate chain rules

OpenClaw builds the candidate list from the currently requested `provider/model` plus configured fallbacks.

<AccordionGroup>
  <Accordion title="Rules">
    - The requested model is first unless rate-limit session stickiness temporarily tries a fallback ahead of it.
    - Explicit configured fallbacks are deduplicated but not filtered by the model allowlist. They are treated as explicit operator intent.
    - If the current run is already on a configured fallback in the same provider family, OpenClaw keeps using the full configured chain.
    - When no explicit fallback override is supplied, configured fallbacks are tried before the configured primary even if the requested model uses a different provider.
    - When no explicit fallback override is supplied to the fallback runner, the configured primary is appended at the end. The chain can then settle back onto the normal default once earlier candidates are exhausted.
    - When a caller supplies `fallbacksOverride`, the runner uses exactly the requested model plus that override list. An empty list disables model fallback and prevents the configured primary from being appended as a hidden retry target.
    - Plugins can return `fallbacksOverride` from `before_model_resolve` to select a run-scoped chain, including `[]` to fail on the selected model instead of trying configured fallbacks. See [local model routing](/plugins/hooks/prompt-and-session#restrict-a-run-to-local-models).
    - After context overflow recovery is exhausted, remaining candidates with known sufficient context are preferred, preserving configured order within each group. Effective `contextTokens` caps apply. If the provider supplies no token count, a larger known window is preferred; metadata is a hint, and each candidate still performs its own context checks. Unknown or smaller-window candidates remain eligible afterward.

  </Accordion>
</AccordionGroup>

### Which errors advance fallback

<Tabs>
  <Tab title="Continues on">
    - auth failures
    - rate limits and cooldown exhaustion
    - overloaded/provider-busy errors
    - timeout-shaped failover errors
    - billing disables
    - `model_not_found`, including eligible HTTP 404 responses
    - model context overflow after active-model compaction and oversized-tool-result recovery cannot make the request fit, including a single message that compaction cannot shrink. The turn must still be safe to replay. Existing model locks, explicit empty fallback overrides, and operator restrictions continue to apply
    - `LiveSessionModelSwitchError` for a stale current or earlier candidate. Later configured targets redirect directly, while targets outside the chain return to the bounded session-model retry owner
    - a provider request-size ceiling reaching the fallback boundary, which happens when a transport-owning plugin harness bypasses embedded recovery. The ceiling belongs to the refusing provider's quota rather than to any model's context window, so a differently provisioned candidate may still admit the request
    - other unrecognized errors when there are still remaining candidates

  </Tab>
  <Tab title="Does not continue on">
    - explicit aborts that are not timeout/failover-shaped
    - an incomplete embedded reply ending with a normal `stop` after bounded same-model recovery, unless the harness explicitly classifies the result as a fallback failure. If the host requires an answer, OpenClaw surfaces the incomplete-turn error; optional internal turns may finish silently. Replay safety does not establish that a different model would answer
    - context overflow after committed tool effects or delivered replies that cannot safely be replayed
    - a provider request-size ceiling inside an embedded run (for example Groq's `413 ... on tokens per minute (TPM): Limit 8000, Requested 8098`), which remains terminal rather than compacting
    - a final unknown error when there are no candidates left
    - final provider refusals. Eligible Anthropic direct API-key requests handle refusal fallback within the provider request instead (see [Anthropic](/providers/anthropic#safety-refusal-fallback-claude-opus-5-and-fable-5))

  </Tab>
</Tabs>

Successful context-overflow fallback records the answering model and the overflow reason in fallback diagnostics and emits a visible warning. If no candidate succeeds, the original overflow guidance is preserved.

A final provider refusal ends the current turn. OpenClaw surfaces it without automatic recovery turns, compaction retries, or switching to an unrelated model. Except for a misalignment precaution, a queued or later user message still starts its own turn.

### Misalignment precautions

An OpenAI `misalignment_policy_violation` stops further work in the affected
conversation. It means the agent's interpretation of the task needs review; it
does not establish that the user violated a policy. OpenClaw preserves available
provider findings and holds queued messages instead of retrying the conversation.
Already-accepted results can still finish recording.

Older saved errors that retain the policy code also display a safety precaution,
even without the newer refusal diagnostics. Displaying that historical error does
not create review findings or authorize continuation.

In the Control UI, choose **Review findings**. When a supported Codex or ChatGPT
Responses runtime supplies a continuation, the dialog shows its exact message
before offering **Acknowledge findings and continue**. Confirmation applies only
to the displayed session and findings. It preserves the runtime, model, sandbox,
and approval settings; a changed review requires another decision. The precaution
clears only after the provider accepts the continuation. Previously queued
messages remain held for individual review and retry.

Continuation sends the acknowledged message exactly once as the next user turn.
Runtime context stays separate, and existing transcript messages remain unchanged.

Ordinary API-key Responses and incognito conversations do not offer continuation.
Missing or incomplete findings also cannot authorize one. A stopped conversation
does not undo actions already completed. See [OpenAI's misalignment monitoring
guide](https://developers.openai.com/api/docs/guides/safety-checks/misalignment-monitoring).

<a id="cooldown-skip-vs-probe-behavior" />

### Cooldown skip vs check behavior

When every auth profile for a provider is already in cooldown, OpenClaw does not automatically skip that provider forever. It makes a per-candidate decision:

<AccordionGroup>
  <Accordion title="Per-candidate decisions">
    - Persistent auth failures skip the whole provider immediately.
    - Billing disables usually skip, but the primary candidate can still be checked on a throttle so recovery is possible without restarting.
    - The primary candidate may be checked near cooldown expiry, with a per-provider throttle.
    - Same-provider fallback siblings can be attempted despite cooldown when the failure looks transient (`rate_limit`, `overloaded`, or unknown). This is especially relevant when a rate limit is model-scoped and a sibling model may still recover immediately.
    - Transient cooldown checks are limited to one per provider per fallback run so a single provider does not stall cross-provider fallback.

  </Accordion>
</AccordionGroup>

## Session overrides and live model switching

Session model changes are shared state. The active runner, `/model` command, compaction/session updates, and live-session reconciliation all read or write parts of the same session entry. Fallback execution does not write model-selection fields, so it cannot replace a newer manual selection while retrying.

Live model switching follows these rules:

- Only explicit user-driven model changes mark a pending live switch. That includes `/model`, `session_status(model=...)`, and `sessions.patch`.
- System-driven model changes such as fallback rotation, heartbeat overrides, or compaction never mark a pending live switch on their own.
- User-driven model overrides are treated as exact selections for fallback policy. An unreachable selected provider therefore surfaces as a failure, instead of being masked by `agents.defaults.model.fallbacks`.
- Runtime fallback candidates do not change the selected model. The next turn starts from the current selection unless rate-limit session stickiness temporarily tries a fallback first. A manual selection that arrived during the previous run takes precedence.
- Previously stored auto fallback overrides remain supported: OpenClaw periodically checks their configured origin and clears the override when it recovers. `/new`, `/reset`, and `sessions.reset` clear auto-sourced overrides immediately.
- Outside group and channel conversations, user replies announce fallback transitions and fallback-cleared recovery once per state change. Repeated turns with the same selected/active pair do not repeat the notice. Group and channel conversations retain the same fallback state and lifecycle events without posting it.
- `/status` shows the selected model and, when fallback state differs, the active fallback model and reason.
- Live-session reconciliation prefers persisted session overrides over stale runtime model fields.
- If a live-switch error points at a later candidate in the active fallback chain, OpenClaw jumps directly to that selected model. It does not walk unrelated candidates first.
- A live switch can select a model outside the active fallback chain. OpenClaw then returns the original switch to the agent, reply, or isolated-cron retry owner. The selected model can complete the same turn.

The active run carries its chosen candidate directly. Live reconciliation changes that candidate only for an explicit pending user switch, so no temporary fallback override or rollback is needed.

When a recorded fallback notice belongs to a different selected model, status and session lists skip its optional transcript lookup. That stale-notice path no longer surfaces transcript-only errors or starts projection reconciliation. Matching notices use a read-only transcript lookup that neither creates storage nor starts projection reconciliation. If optional storage or projections are unavailable, the lookup omits transcript-derived details. Unexpected read errors still propagate.

## User-visible fallback notices

Outside group and channel conversations, OpenClaw sends a status notice in the same reply surface when a session moves onto an auto-selected fallback:

```text
↪️ Model Fallback: <fallback> (selected <primary>; <reason>)
```

When a later check succeeds and the session returns to the selected primary, OpenClaw sends:

```text
↪️ Model Fallback cleared: <primary> (was <fallback>)
```

These notices are operational messages, not assistant content. They deliver once per state change outside group and channel conversations, including side-effect-only turns when feasible, but repeated turn-local fallback transitions do not repeat them. Group and channel conversations suppress the visible notices while retaining the same fallback state and lifecycle events. Delivery bypasses normal source-reply suppression, does not consume the first assistant reply slot for threaded channels, and is excluded from text-to-speech.

Persisted notice state prevents repeated notices when consecutive turns use the same selected/active pair, while model selection itself remains unchanged.

When a fallback or recovery transcript event was recorded for the active model, the Control UI uses its divider instead of an additional assistant status message. When unavailable profiles skip the selected model before runtime admission, a successful fallback records the transition after it obtains the same admitted writer authority. If no matching event can be persisted, the ordinary status notice is not suppressed. Channel and native-client status delivery remains unchanged. The Control UI records attempted fallback switches using the same presentation as compaction events. It shows the previous model, the fallback being tried, and the reason for the switch while that candidate is still working. The event remains in history after reload and does not claim the fallback succeeded. When a later turn successfully returns to the selected model, a matching **Returned to selected model** divider records the fallback and selected model. Starting a new attempt or failing on the selected model does not record a successful return.

While recovery is in progress, the Control UI updates the working claw with **Retrying…**, a countdown when the runtime reports a retry deadline, or **Trying fallback model…**. Individual failed attempts do not become warning messages, including after a history reload. When the run recovers, the status returns to normal and the successful answer appears without a failure notice. Hidden internal continuation prompts do not start a new user turn for recovery matching.

If the run ultimately fails after its available recovery attempts, the Control UI shows one terminal failure notice, not one warning per attempt. Partial output and media remain visible, and the raw transcript retains attempt diagnostics for troubleshooting. The latest failed run offers **Try again** to send a continuation that checks completed work before retrying actions, and **Change model** opens the existing model picker. Neither action silently replays the original prompt or clears an unsent draft.

## Observability and failure summaries

Each admitted retry or fallback request gets its own start-relative diagnostic recovery allowance. Earlier failed attempts remain in cumulative no-progress evidence, but that evidence cannot cancel a fresh request before its recorded allowance expires. User cancellation, retry limits, and overall run budgets still apply.

`runWithModelFallback(...)` records per-attempt details that feed logs and user-facing cooldown messaging:

- provider/model attempted
- reason (`rate_limit`, `overloaded`, `billing`, `auth`, `model_not_found`, and similar failover reasons)
- optional status/code
- human-readable error summary

Structured `model_fallback_decision` logs also include flat `fallbackStep*` fields when a candidate fails, is skipped, or a later fallback succeeds. These fields make the attempted transition explicit: `fallbackStepFromModel`, `fallbackStepToModel`, `fallbackStepFromFailureReason`, `fallbackStepFromFailureDetail`, and `fallbackStepFinalOutcome`. Log and diagnostic exporters can reconstruct the primary failure even when the terminal fallback also fails.

For a missing-model fallback, look for a `model_fallback_decision` event whose `reason` or `fallbackStepFromFailureReason` is `model_not_found`.

Exhaustion summaries preserve the structured attempt records. The fallback runner can return a classified exhausted result or throw a `FailoverError`. The outer reply runner can use those details to build a more specific message, such as "all models are temporarily rate-limited". It can include the soonest cooldown expiry when one is known.

That cooldown summary is model-aware:

- unrelated model-scoped rate limits are ignored for the attempted provider/model chain
- if the remaining block is a matching model-scoped rate limit, OpenClaw reports the last matching expiry that still blocks that model

## Related config

See [Gateway configuration](/gateway/configuration) for:

- `auth.profiles` / `auth.order`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing
- [`openclaw models`](/cli/models) — inspect resolved defaults and fallbacks

See [Models](/concepts/models) for the broader model selection and fallback overview.

See [Model providers](/concepts/model-providers) for provider setup, credentials, and per-provider model catalogs.

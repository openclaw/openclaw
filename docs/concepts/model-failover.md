---
summary: "How OpenClaw rotates auth profiles and falls back across models"
read_when:
  - Diagnosing auth profile rotation, cooldowns, or model fallback behavior
  - Updating failover rules for auth profiles or models
title: "Model Failover"
---

# Model failover

OpenClaw handles failures in two stages:

1. **Auth profile rotation** within the current provider.
2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.

This doc explains the runtime rules and the data that backs them.

## Auth storage (keys + OAuth)

OpenClaw uses **auth profiles** for both API keys and OAuth tokens.

- Secrets live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).
- Config `auth.profiles` / `auth.order` are **metadata + routing only** (no secrets).
- Legacy import-only OAuth file: `~/.openclaw/credentials/oauth.json` (imported into `auth-profiles.json` on first use).

More detail: [/concepts/oauth](/concepts/oauth)

Credential types:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for some providers)

## Profile IDs

OAuth logins create distinct profiles so multiple accounts can coexist.

- Default: `provider:default` when no email is available.
- OAuth with email: `provider:<email>` (for example `google-antigravity:user@gmail.com`).

Profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` under `profiles`.

## Rotation order

When a provider has multiple profiles, OpenClaw chooses an order like this:

1. **Explicit config**: `auth.order[provider]` (if set).
2. **Configured profiles**: `auth.profiles` filtered by provider.
3. **Stored profiles**: entries in `auth-profiles.json` for the provider.

If no explicit order is configured, OpenClaw uses a round‑robin order:

- **Primary key:** profile type (**OAuth before API keys**).
- **Secondary key:** `usageStats.lastUsed` (oldest first, within each type).
- **Cooldown/disabled profiles** are moved to the end, ordered by soonest expiry.

### Session stickiness (cache-friendly)

OpenClaw **pins the chosen auth profile per session** to keep provider caches warm.
It does **not** rotate on every request. The pinned profile is reused until:

- the session is reset (`/new` / `/reset`)
- a compaction completes (compaction count increments)
- the profile is in cooldown/disabled

Manual selection via `/model …@<profileId>` sets a **user override** for that session
and is not auto‑rotated until a new session starts.

Auto‑pinned profiles (selected by the session router) are treated as a **preference**:
they are tried first, but OpenClaw may rotate to another profile on rate limits/timeouts.
User‑pinned profiles stay locked to that profile; if it fails and model fallbacks
are configured, OpenClaw moves to the next model instead of switching profiles.

### Why OAuth can “look lost”

If you have both an OAuth profile and an API key profile for the same provider, round‑robin can switch between them across messages unless pinned. To force a single profile:

- Pin with `auth.order[provider] = ["provider:profileId"]`, or
- Use a per-session override via `/model …` with a profile override (when supported by your UI/chat surface).

## Cooldowns

When a profile fails due to auth/rate‑limit errors (or a timeout that looks
like rate limiting), OpenClaw marks it in cooldown and moves to the next profile.
Format/invalid‑request errors (for example Cloud Code Assist tool call ID
validation failures) are treated as failover‑worthy and use the same cooldowns.
OpenAI-compatible stop-reason errors such as `Unhandled stop reason: error`,
`stop reason: error`, and `reason: error` are classified as timeout/failover
signals.

Cooldowns use exponential backoff:

- 1 minute
- 5 minutes
- 25 minutes
- 1 hour (cap)

State is stored in `auth-profiles.json` under `usageStats`:

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

## Billing disables

Billing/credit failures (for example “insufficient credits” / “credit balance too low”) are treated as failover‑worthy, but they’re usually not transient. Instead of a short cooldown, OpenClaw marks the profile as **disabled** (with a longer backoff) and rotates to the next profile/provider.

State is stored in `auth-profiles.json`:

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

Defaults:

- Billing backoff starts at **5 hours**, doubles per billing failure, and caps at **24 hours**.
- Backoff counters reset if the profile hasn’t failed for **24 hours** (configurable).

## Model fallback

If all profiles for a provider fail, OpenClaw moves to the next model in
`agents.defaults.model.fallbacks`. This applies to auth failures, rate limits, and
timeouts that exhausted profile rotation (other errors do not advance fallback).

When a run starts with a model override (hooks or CLI), fallbacks still end at
`agents.defaults.model.primary` after trying any configured fallbacks.

## Adaptive Model Routing

**Failover** (above) handles provider failures: rate limits, auth errors, and timeouts.
**Adaptive Model Routing** is a separate, opt-in feature that handles _outcome quality_: it
runs a cheap or local model first, validates whether the result actually completed the job,
and automatically escalates to a cloud model on failure — all in one turn.

|                 | Failover                    | Adaptive Model Routing                          |
| --------------- | --------------------------- | ----------------------------------------------- |
| Trigger         | Provider error / rate limit | Outcome validation failure                      |
| Default         | On                          | Off                                             |
| Max retries     | Configurable fallback chain | 1 escalation (v1)                               |
| Session history | Same session, next model    | Rerun from scratch (local attempt not appended) |

### How it works

1. First run uses `localFirstModel` (e.g. a local Ollama model).
2. The outcome is validated — by heuristic (default) or by an optional LLM validator.
3. If validation **passes**: the local result is returned.
4. If validation **fails**: the run is discarded and re-attempted with `cloudEscalationModel`.
5. If the cloud run encounters a provider error, the normal failover chain takes over.

### Enable adaptive routing

Add `adaptiveRouting` inside `agents.defaults.model`:

```yaml
agents:
  defaults:
    model:
      primary: "openai/gpt-4.1-mini"
      fallbacks:
        - "openai/gpt-4.1-nano"
      adaptiveRouting:
        enabled: true
        localFirstModel: "ollama/qwen2.5-coder" # cheap/local first
        cloudEscalationModel: "openai/gpt-4.1-mini" # escalate here on failure
        maxEscalations: 1 # hard cap (v1)
        bypassOnExplicitOverride: true # skip when user forces a model
        validation:
          mode: "heuristic" # "heuristic" (default) or "llm"
          minScore: 0.75
```

#### Optional LLM validator (experimental)

> **Note:** LLM validation mode is experimental and not yet fully implemented. When
> `mode: "llm"` is configured, the current implementation falls back to heuristic
> validation with a warning. Full LLM validation support is planned for a future release.

```yaml
validation:
  mode: "llm"
  validatorModel: "ollama/llama3.2"
  minScore: 0.75
  maxToolOutputChars: 2000
  maxAssistantChars: 4000
  redactSecrets: true
```

When `mode: "llm"` is fully implemented, a small validator prompt will be sent to
`validatorModel`. The validator must return JSON `{ "score": 0..1, "passed": true/false, "reason": "..." }`.
Invalid JSON or validator errors are treated as a fail, triggering escalation.

### Heuristic validation rules

The default heuristic applies the following scoring (starting from 1.0, deducting penalties):

| Condition                       | Score deduction |
| ------------------------------- | --------------- |
| Provider/runtime error          | −1.0            |
| Tool execution error            | −0.6            |
| Empty assistant output          | −0.4            |
| Pending (unresolved) tool calls | −0.4            |
| Timeout / truncation            | −0.3            |

Pass threshold: score ≥ `validation.minScore` (default 0.75) **and** no failure conditions.

### Relationship to the normal failover chain

Adaptive routing wraps the run _before_ the failover chain runs. Each adaptive attempt
(local and cloud) has full access to the normal provider fallback chain for provider-level
errors. Adaptive routing only escalates based on _outcome_, not on provider errors.

## Related config

See [Gateway configuration](/gateway/configuration) for:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel` routing

See [Models](/concepts/models) for the broader model selection and fallback overview.

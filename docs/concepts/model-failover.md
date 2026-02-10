---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How OpenClaw rotates auth profiles and falls back across models"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Diagnosing auth profile rotation, cooldowns, or model fallback behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating failover rules for auth profiles or models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Model Failover"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Model failover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw handles failures in two stages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Auth profile rotation** within the current provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Model fallback** to the next model in `agents.defaults.model.fallbacks`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This doc explains the runtime rules and the data that backs them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth storage (keys + OAuth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses **auth profiles** for both API keys and OAuth tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Secrets live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legacy: `~/.openclaw/agent/auth-profiles.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config `auth.profiles` / `auth.order` are **metadata + routing only** (no secrets).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Legacy import-only OAuth file: `~/.openclaw/credentials/oauth.json` (imported into `auth-profiles.json` on first use).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More detail: [/concepts/oauth](/concepts/oauth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Credential types:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type: "api_key"` → `{ provider, key }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` for some providers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Profile IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OAuth logins create distinct profiles so multiple accounts can coexist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `provider:default` when no email is available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OAuth with email: `provider:<email>` (for example `google-antigravity:user@gmail.com`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` under `profiles`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rotation order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a provider has multiple profiles, OpenClaw chooses an order like this:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Explicit config**: `auth.order[provider]` (if set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Configured profiles**: `auth.profiles` filtered by provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Stored profiles**: entries in `auth-profiles.json` for the provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no explicit order is configured, OpenClaw uses a round‑robin order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Primary key:** profile type (**OAuth before API keys**).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Secondary key:** `usageStats.lastUsed` (oldest first, within each type).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Cooldown/disabled profiles** are moved to the end, ordered by soonest expiry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session stickiness (cache-friendly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw **pins the chosen auth profile per session** to keep provider caches warm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It does **not** rotate on every request. The pinned profile is reused until:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- the session is reset (`/new` / `/reset`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a compaction completes (compaction count increments)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- the profile is in cooldown/disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manual selection via `/model …@<profileId>` sets a **user override** for that session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and is not auto‑rotated until a new session starts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auto‑pinned profiles (selected by the session router) are treated as a **preference**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
they are tried first, but OpenClaw may rotate to another profile on rate limits/timeouts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
User‑pinned profiles stay locked to that profile; if it fails and model fallbacks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are configured, OpenClaw moves to the next model instead of switching profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why OAuth can “look lost”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you have both an OAuth profile and an API key profile for the same provider, round‑robin can switch between them across messages unless pinned. To force a single profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pin with `auth.order[provider] = ["provider:profileId"]`, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a per-session override via `/model …` with a profile override (when supported by your UI/chat surface).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cooldowns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a profile fails due to auth/rate‑limit errors (or a timeout that looks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
like rate limiting), OpenClaw marks it in cooldown and moves to the next profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format/invalid‑request errors (for example Cloud Code Assist tool call ID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
validation failures) are treated as failover‑worthy and use the same cooldowns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cooldowns use exponential backoff:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 1 minute（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 5 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 25 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 1 hour (cap)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
State is stored in `auth-profiles.json` under `usageStats`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "usageStats": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "provider:profile": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "lastUsed": 1736160000000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "cooldownUntil": 1736160600000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "errorCount": 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Billing disables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Billing/credit failures (for example “insufficient credits” / “credit balance too low”) are treated as failover‑worthy, but they’re usually not transient. Instead of a short cooldown, OpenClaw marks the profile as **disabled** (with a longer backoff) and rotates to the next profile/provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
State is stored in `auth-profiles.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "usageStats": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "provider:profile": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "disabledUntil": 1736178000000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "disabledReason": "billing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Billing backoff starts at **5 hours**, doubles per billing failure, and caps at **24 hours**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Backoff counters reset if the profile hasn’t failed for **24 hours** (configurable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Model fallback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If all profiles for a provider fail, OpenClaw moves to the next model in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.model.fallbacks`. This applies to auth failures, rate limits, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
timeouts that exhausted profile rotation (other errors do not advance fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a run starts with a model override (hooks or CLI), fallbacks still end at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.model.primary` after trying any configured fallbacks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Gateway configuration](/gateway/configuration) for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `auth.profiles` / `auth.order`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.imageModel` routing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Models](/concepts/models) for the broader model selection and fallback overview.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

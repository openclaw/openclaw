---
name: slothlee
description: "Drive the Sloth Lee Discord-bot platform via its public REST API. Use for listing guilds, inspecting state, reading moderation cases, and (with operator approval) banning/kicking/timing-out/warning users. Auto-executes read-only ops; destructive ops require operator approval via DM."
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🦥",
        "requires": { "bins": ["curl", "jq"] },
        "primaryEnv": "SLOTHLEE_API_TOKEN",
        "envVars":
          [
            { "name": "SLOTHLEE_API_BASE", "label": "Sloth Lee dashboard base URL", "default": "https://slothlee.xyz" },
            { "name": "SLOTHLEE_API_TOKEN", "label": "Bearer token (slot_<id>_<secret>) — mint at /developer/keys", "secret": true },
            { "name": "OPENCLAW_OPERATOR_DISCORD_ID", "label": "Operator's Discord user ID — only this user can invoke the skill" }
          ]
      }
  }
allowed-tools: ["bash", "message"]
---

# Sloth Lee Skill

Calls the Sloth Lee dashboard's public REST API at `${SLOTHLEE_API_BASE}/api/public/v1/*` using the bearer token in `$SLOTHLEE_API_TOKEN`.

## When to use

✅ User asks Openclaw to:
- Inspect Discord guilds the operator manages ("list my guilds", "what channels does X have?")
- Read moderation history ("show recent cases for X")
- Take a moderation action ("ban user 12345 for spam in guild Y")
- Look up server state before another action

❌ Don't use this skill when:
- The operator wants direct Discord API access — use the `discord` skill instead
- Editing the dashboard UI / its config — out of scope for the public API
- Acting on a guild the operator doesn't own — the API will 404, don't loop

## Owner whitelist (mandatory)

**This skill is single-tenant.** Before doing anything, check that the requesting Discord user is `${OPENCLAW_OPERATOR_DISCORD_ID}`:

```bash
if [ "$REQUESTING_USER_ID" != "$OPENCLAW_OPERATOR_DISCORD_ID" ]; then
  # Reply: "This assistant is restricted to the operator. Request denied."
  exit 0
fi
```

If invoked from a non-DM context, refuse silently.

## Auto vs gated tiers

| Tier | Operations | Behaviour |
|---|---|---|
| **Auto** (read-only) | `list_guilds`, `guild_state`, `list_channels`, `list_cases` | Execute immediately, return JSON to the user. |
| **Gated** (destructive) | `ban`, `kick`, `timeout`, `warn` | DM the operator with action summary + Approve/Deny buttons. Execute ONLY after `Approve`. Timeout 5 min. |

**Never auto-execute a gated op.** The dashboard's audit trail (ModerationCase) cannot be undone — the gate is the only safety net.

## Auto-tier operations

### List guilds the operator owns

```bash
curl -sf -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds?per_page=100"
```

Returns `{items: [{id, name, icon_url, owner_user_id}], total, page, per_page}`.

### Guild state (rich snapshot)

```bash
curl -sf -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds/<guild_id>/state"
```

Returns guild metadata + channels + roles + feature flags. Use this before any destructive action so you see the current state of the world.

### Channel list (lighter than `/state`)

```bash
curl -sf -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds/<guild_id>/channels"
```

### Recent moderation cases

```bash
curl -sf -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds/<guild_id>/moderation/cases?per_page=25"
```

## Gated-tier operations

### Approval flow (mandatory before each destructive call)

1. Format the proposed action as a Discord embed:
   ```
   **Action:** ban  
   **Guild:** Sloth Lee's Dojo (id=4242)  
   **Target:** <@123456789012345678>  
   **Reason:** repeated raid behaviour  
   **Delete messages:** yes (last 24h)
   ```
2. Send via the `message` tool to `OPENCLAW_OPERATOR_DISCORD_ID` with `Approve | Deny` buttons. Use Discord components v2 (see the `discord` skill for syntax).
3. Wait up to 5 minutes for the button click. On timeout: treat as deny.
4. On `Approve`: execute the curl below. On `Deny` or timeout: tell the operator the action was cancelled.

### Ban

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "<discord_user_id>",
    "reason": "<concise reason, ≤1000 chars>",
    "delete_messages": true,
    "target_name": "<display name for the audit row>"
  }' \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds/<guild_id>/moderation/ban"
```

### Kick

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "<id>", "reason": "<reason>", "target_name": "<name>"}' \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds/<guild_id>/moderation/kick"
```

### Timeout

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "<id>",
    "reason": "<reason>",
    "duration_minutes": 60,
    "target_name": "<name>"
  }' \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds/<guild_id>/moderation/timeout"
```

`duration_minutes` must be 1..40320 (28 days max — Discord's hard cap).

### Warn

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SLOTHLEE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "<id>", "reason": "<reason>", "target_name": "<name>"}' \
  "$SLOTHLEE_API_BASE/api/public/v1/guilds/<guild_id>/moderation/warn"
```

## Response shape

All endpoints return `{ok, output, error, code}`:

- `ok: true` — action succeeded. `output` carries the upstream JSON (case ID, dry-run preview, etc.).
- `ok: false` — failed. `code` is one of:
  - `invalid_arguments` (400) — reformat and retry once.
  - `denied_by_scope` (403) — skill misconfigured. Stop and report to operator.
  - `guild_not_found` (404) — operator doesn't own that guild. Stop, don't retry.
  - `rate_limited_scope` (429) — wait and retry; AIScope cap was hit.
  - `bot_unavailable` (503) — Discord bot down. Inform operator, don't retry until they confirm.

## Error handling rules

- **Never retry** on `denied_by_scope`, `guild_not_found`, `unknown_tool`. These are operator-config issues that auto-retry won't fix.
- **Retry once** on `bot_unavailable` after a 30s pause. If it fails twice, stop and report.
- **Reformat and retry once** on `invalid_arguments` — the model's first arg shape may have been wrong.

## Reply style

- Keep replies short. Confirm what was done with case IDs, target names, and timestamps.
- For `list_*` operations, summarise the count and show the top 5; offer to scroll.
- For destructive ops: confirm with one-line + the case ID. Don't re-emit the full reasoning the operator just approved.

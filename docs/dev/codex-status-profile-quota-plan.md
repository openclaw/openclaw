# Codex profile-aware `/status` quota plan

## Problem

`/status` currently shows provider quota/usage for `openai-codex`, but the snapshot is resolved by provider only and may come from the first profile in auth order. After `/profile openai-codex:<id>`, model auth changes, but the quota line can still reflect a different profile.

## Root cause (wiring)

- `/status` path: `src/auto-reply/reply/commands-status.ts`
- `session_status` tool path: `src/agents/tools/session-status-tool.ts`
- Both call `loadProviderUsageSummary({ providers: [usageProvider], agentDir })` without profile id.
- Auth resolution in `src/infra/provider-usage.auth.ts` selects provider auth by order, not session override.

## Phase 1 (implementation)

1. Add optional `profileId` to provider usage loading path:
   - `loadProviderUsageSummary(...)`
   - `resolveProviderAuths(...)`
   - `resolveOAuthToken(...)`
2. If `profileId` is supplied:
   - validate profile exists,
   - validate provider match,
   - resolve token/account from that exact profile,
   - skip profile-order fallback.
3. In `/status` and `session_status`:
   - read `sessionEntry.authProfileOverride`,
   - pass it to provider usage loader for `openai-codex`.
4. Update status rendering copy:
   - `📊 Usage (provider quota): ...`
   - include profile source when present (e.g., `openai-codex:dillan`).

## Phase 2 (UX clarity)

1. Split session identity display fields:
   - `Agent: <agentId>`
   - `Channel: <surface/path>`
2. Add explicit note when quota unavailable:
   - `Usage unavailable for active profile (missing scope/permissions)`.

## Test plan

1. Set up two codex profiles with different quotas (`default`, `dillan`).
2. `/status` on default -> record usage window.
3. `/profile openai-codex:dillan` then `/status` -> usage should switch to dillan window.
4. Add unit tests:
   - profile-specific auth selection in `provider-usage.auth`.
   - `/status` command passes profile override into usage loader.

## Notes

OpenClaw already has Codex usage endpoint wiring in `src/infra/provider-usage.fetch.codex.ts` (`chatgpt.com/backend-api/wham/usage`) including `ChatGPT-Account-Id` support. This should be reused for accurate per-profile quota reporting.

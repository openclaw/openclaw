# Discord Performance Fix — Design Spec

**Date:** 2026-05-01
**Author:** Ethan Vitanova (assisted by Claude Code)
**Version constraint:** OpenClaw 4.27 (local Docker image `openclaw:local`) — no upgrade
**Related audit:** `projects/Audits/2026-04-30-openclaw-4.27-update-full-config-audit.md`

---

## Problem Statement

Discord chat sessions take several minutes to respond to simple text messages. The bot is text-only — no voice used. Live diagnostics show three contributing causes:

| Symptom                                               | Evidence                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Background CPU/event traffic from unused voice events | `eventLoopDelayMaxMs=8170ms`, `eventLoopUtilization=0.432` — event loop under sustained pressure    |
| Discord WebSocket reconnecting repeatedly             | `Discord Message Content Intent is limited` log appears 7+ times — each is a full re-identify cycle |
| Sessions getting stuck in `processing`                | `gateway timeout after 60000ms` in logs; new messages queue behind stuck sessions                   |

All three were fixed in 4.28–4.30 upstream. This spec defines how to backport the fixes to 4.27 without upgrading.

---

## Constraints

- Stay on `openclaw:local` image built from 4.27 base
- No `git stash`, no branch switches, no worktree changes
- Patches must follow the same technique as the audit's SecretRef fix: targeted `Dockerfile.local` `RUN node -e "..."` bundle patches + config edits
- Each fix must be individually verifiable before the next proceeds
- Full rollback must be possible (backup before any image rebuild)

---

## Fix 1 — Suppress `GuildVoiceStates` Intent (Config)

**Root cause:** In 4.27, if `channels.discord.voice` is not present in config, the Discord provider requests the `GUILD_VOICE_STATES` gateway intent by default. For a text-only bot this generates constant background WebSocket event traffic with no useful purpose, contributing to event loop pressure on every reconnect.

**Upstream fix reference:** 4.28–4.29 changelog — "leave Discord voice off for text-only configs unless `channels.discord.voice` is explicitly configured, avoiding default GuildVoiceStates traffic and idle gateway CPU pressure."

**Fix:** Add an explicit voice-disabled entry to `channels.discord` in `~/.openclaw/openclaw.json`:

```json
"voice": {
  "enabled": false
}
```

**Application:** Live config edit (no rebuild). Gateway restart to apply.

**Verification:**

- Gateway startup logs must not show `GuildVoiceStates` in intent list
- `eventLoopDelayMaxMs` should drop on next liveness report (30s interval)
- If 4.27 code does not honor `voice.enabled: false` to suppress the intent, escalate to a dist patch (see risk note below)

**Risk:** Low. Config-only. Fully reversible by removing the key and restarting.

**Risk note:** If the 4.27 runtime ignores `voice.enabled: false` for intent selection (the code path may only check presence of `voice` keys, not an explicit disable flag), a secondary dist patch to the Discord bundle will be needed to drop `GUILD_VOICE_STATES` from the intents bitmask for text-only configs.

---

## Fix 2 — WebSocket Handshake Timeout (Dist Patch)

**Root cause:** In 4.27, Carbon's Discord WebSocket connect has no handshake timeout. A stalled TLS negotiation or slow Discord API response during identify hangs indefinitely — the bot goes silent until the process is restarted or the OS eventually kills the socket. This explains the repeated re-identify cycles in the logs.

**Upstream fix reference:** 4.28 changelog — "give Discord Gateway WebSocket handshakes a 30s timeout so stalled TLS/network transitions emit an error and Carbon can continue its reconnect loop instead of leaving the bot silent until restart."

**Fix:** Patch the compiled Discord channel bundle in `Dockerfile.local` to wrap the WebSocket connect/identify sequence with a 30-second `Promise.race` timeout that rejects with an error, allowing Carbon's reconnect loop to continue.

**Application:** `Dockerfile.local` `RUN node -e "..."` patch. Requires image rebuild and stack restart.

**Verification:**

- `Discord Message Content Intent is limited` log should appear only once per deliberate restart (not repeatedly during normal operation)
- If a stall is induced (e.g., momentary network interruption), the bot should reconnect within ~35s rather than hanging indefinitely

**Risk:** Medium. Dist patch is tied to bundle filename hash. Must verify patch applied correctly after rebuild.

---

## Fix 3 — Stuck-Session Turn Bounds (Dist Patch)

**Root cause:** In 4.27, when a gateway agent turn gets stuck (codex harness quiet after a dynamic-tool response, or a cron-isolated turn that times out), the session stays in `processing` state indefinitely. New Discord messages queue behind it. Depending on how many turns are stuck, this can block responses for several minutes.

**Upstream fix references:**

- 4.28–4.29: "Agents/Codex: bound embedded-run cleanup, trajectory flushing, and command-lane task timeouts after runtime failures, so Discord and other chat sessions return to idle instead of staying stuck in processing."
- 4.28: "Cron/Gateway: abort and bounded-clean up timed-out isolated agent turns before recording the timeout, so stale cron sessions cannot leave Discord or other chat lanes stuck in processing after a timeout."
- 4.29: "Codex harness: interrupt and release native app-server turns that go quiet after an OpenClaw dynamic-tool response without sending turn/completed, so Discord and other chat lanes do not stay stuck in processing."

**Fix:** Patch the relevant gateway/codex harness dist bundle(s) to:

1. Add an explicit abort signal with a bounded timeout to embedded-run cleanup
2. Ensure isolated agent turns that exceed their timeout are aborted and their session state is reset to idle before the timeout is recorded

**Application:** `Dockerfile.local` `RUN node -e "..."` patch(es). Bundled into the same image rebuild as Fix 2.

**Verification:**

- Send a simple Discord message; response time should be under 10 seconds
- `gateway timeout` log entries should stop appearing for routine turns
- Live `openclaw status` should not show stuck sessions in `processing` state

**Risk:** Medium. Modifying session lifecycle logic. Must verify no regressions in normal turn completion.

---

## Execution Order

```
Fix 1 (config) → restart → verify event loop metrics
  └─ if 4.27 ignores voice.enabled: false → add GuildVoiceStates dist patch to Fix 2 rebuild

Fix 2 + Fix 3 (dist patches) → image rebuild → stack restart → full verification
```

Fix 1 is applied first because it is zero-risk and gives an early read on event loop pressure. Fixes 2 and 3 proceed unconditionally — they address WebSocket reconnects and stuck sessions respectively, which are independent of whether Fix 1 resolved the event loop. All three fixes are required to hit the success criteria.

---

## Backup Protocol

Before the image rebuild (same pattern as audit):

```bash
# Config snapshot
sudo tar czf ~/openclaw-backup-discord-perf/dotopenclaw.tgz -C /home/ubuntu .openclaw

# Current Dockerfile.local
cp Dockerfile.local ~/openclaw-backup-discord-perf/

# Running image ID
docker inspect openclaw-openclaw-gateway-1 --format '{{.Image}}' \
  > ~/openclaw-backup-discord-perf/image-id.txt
```

---

## Rollback

- **Fix 1 only:** Remove `voice` key from `openclaw.json`, restart gateway.
- **Fix 2+3:** Revert `Dockerfile.local` to backed-up version, rebuild image, restart stack.

---

## Success Criteria

| Metric                                        | Current (4.27)  | Target                 |
| --------------------------------------------- | --------------- | ---------------------- |
| Discord response time (simple message)        | Several minutes | Under 10 seconds       |
| `eventLoopDelayMaxMs`                         | 8,170ms         | Under 500ms            |
| Discord WebSocket reconnects (per hour, idle) | 7+              | 0–1 (deliberate only)  |
| Stuck sessions in `processing`                | Observed        | None during normal use |

---

## Out of Scope

- Upgrading to 4.28–4.30
- QMD timeout errors (known noise, not contributing to Discord latency)
- `groupPolicy` empty allowlist (DM-only, intentional)
- Bonjour mDNS (Docker limitation, unrelated)

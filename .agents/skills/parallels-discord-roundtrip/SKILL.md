---
name: parallels-discord-roundtrip
description: Run macOS Parallels smoke with Discord send, host verification, host reply, and guest readback proof.
---

# Parallels Discord Roundtrip

Use when macOS Parallels smoke must prove Discord two-way delivery end to end.

## Goal

Cover:

- install on fresh macOS snapshot
- onboard + gateway health
- guest `message send` to Discord
- host sees that message on Discord
- host posts a new Discord message
- guest `message read` sees that new message

## Inputs

- host env var with the token for a dedicated, operator-approved QA bot
- operator-approved QA guild and channel IDs
- `OPENAI_API_KEY`

## Preferred run

Load `OPENCLAW_PARALLELS_DISCORD_TOKEN` through the approved secret source.
Set `OPENCLAW_PARALLELS_DISCORD_GUILD_ID` and `OPENCLAW_PARALLELS_DISCORD_CHANNEL_ID`
to the approved QA destination. The harness configures that bot inside the selected guest.

```bash
pnpm test:parallels:macos \
  --discord-token-env OPENCLAW_PARALLELS_DISCORD_TOKEN \
  --discord-guild-id "$OPENCLAW_PARALLELS_DISCORD_GUILD_ID" \
  --discord-channel-id "$OPENCLAW_PARALLELS_DISCORD_CHANNEL_ID" \
  --json
```

## Notes

- Snapshot target: closest to `macOS 26.3.1 fresh`.
- Snapshot resolver now prefers matching `*-poweroff*` clones when the base hint also matches. That lets the harness reuse disk-only recovery snapshots without passing a longer hint.
- If Windows/Linux snapshot restore logs show `PET_QUESTION_SNAPSHOT_STATE_INCOMPATIBLE_CPU`, drop the suspended state once, create a `*-poweroff*` replacement snapshot, and rerun. The smoke scripts now auto-start restored power-off snapshots.
- Harness configures Discord inside the guest; no checked-in token/config.
- Use the `openclaw` wrapper for guest `message send/read`; `node openclaw.mjs message ...` does not expose the lazy message subcommands the same way.
- Write `channels.discord.guilds` in one JSON object (`--strict-json`), not dotted `config set channels.discord.guilds.<snowflake>...` paths; numeric snowflakes get treated like array indexes.
- Avoid `prlctl enter` / expect for long Discord setup scripts; it line-wraps/corrupts long commands. Use `prlctl exec --current-user /bin/sh -lc ...` for the Discord config phase.
- Full 3-OS sweeps: the shared build lock is safe in parallel, but snapshot restore is still a Parallels bottleneck. Prefer serialized Windows/Linux restore-heavy reruns if the host is already under load.
- Harness cleanup deletes the temporary Discord smoke messages at exit.
- The harness attempts to stop its selected guest after successful Discord proof and warns if the stop fails. For ad-hoc Discord checks, stop only the task-owned guest before handoff. Do not leave the Discord-configured test guest running after proof.
- Per-phase logs: `/tmp/openclaw-parallels-smoke.*`
- Machine summary: pass `--json`
- If roundtrip flakes, inspect `fresh.discord-roundtrip.log` and `discord-last-readback.json` in the run dir first.

## Pass criteria

- fresh lane or upgrade lane requested passes
- summary reports `discord=pass` for that lane
- guest outbound nonce appears in channel history
- host inbound nonce appears in `openclaw message read` output

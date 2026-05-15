# Upstream Update Summary (Stable): v2026.4.1 → v2026.5.12

## Executive summary (what changes we’d be taking on)

Between v2026.4.1 and v2026.5.12, upstream has continued heavy development across extensions/providers, CI/release machinery, and several core runtime subsystems. The most likely Polytropos-impacting areas are:

- **Extensions + providers:** frequent fixes and packaging/build changes (externalizing provider deps, runtime chunking) that can affect plugin loading and deployment assumptions.
- **Core runtime + gateway/doctor/config:** multiple fixes around plugin peers, secret/catalog auth, heartbeat/tool reply enforcement, and general gateway stability.
- **CI/release workflows:** many CI/release reliability changes; expect workflow file diffs and release script changes that can interact with our fork’s release process.
- **Memory/security/secrets/media:** meaningful churn in secret/security handling and memory/media related packages.

This doc intentionally avoids enumerating every commit; it focuses on the high-signal themes and known merge friction.

## Evidence: where the churn is concentrated (directory depth=2)

Top touched areas by file count (depth=2):

## Evidence: commit subject “theme” distribution (rough)

Top subject prefixes:

## Changelog / release notes

Upstream “notes” source candidates in-tree at tag v2026.5.12:

TODO (next refinement): extract the v2026.4.1..v2026.5.12 entries from the canonical release notes file (once we confirm which file is authoritative) and summarize them here.

## Merge conflict report (today)

Conflict detection method:

- (no working tree merge performed)

Conflicting paths detected:

### Known likely conflict driver

- has historically conflicted in our earlier dry-run merge attempts.

## Polytropos update checklist (post-merge)

- Run plugin verification gates + ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  ██░▄▄▄░██░▄▄░██░▄▄▄██░▀██░██░▄▄▀██░████░▄▄▀██░███░██
  ██░███░██░▀▀░██░▄▄▄██░█░█░██░█████░████░▀▀░██░█░█░██
  ██░▀▀▀░██░█████░▀▀▀██░██▄░██░▀▀▄██░▀▀░█░██░██▄▀▄▀▄██
  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
  🦞 OPENCLAW 🦞

┌ OpenClaw doctor
│
◇ Startup optimization ─────────────────────────────────────────────────╮
│ │
│ - NODE_COMPILE_CACHE is not set; repeated CLI runs can be slower on │
│ small hosts (Pi/VM). │
│ - OPENCLAW_NO_RESPAWN is not set to 1; set it to avoid extra startup │
│ overhead from self-respawn. │
│ - Suggested env for low-power hosts: │
│ export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache │
│ mkdir -p /var/tmp/openclaw-compile-cache │
│ export OPENCLAW_NO_RESPAWN=1 │
│ │
├────────────────────────────────────────────────────────────────────────╯
│
◇ Doctor warnings ─────────────────────────────────────────╮
│ │
│ - State dir migration skipped: target already exists │
│ (/home/ec2-user/.openclaw). Remove or merge manually. │
│ │
├───────────────────────────────────────────────────────────╯
│
◇ State integrity ─────────────────────────────────────────────────────╮
│ │
│ - State directory permissions are too open (~/.openclaw). Recommend │
│ chmod 700. │
│ │
├───────────────────────────────────────────────────────────────────────╯
│
◇ Session locks ──────────────────────────────────────────────────────────────╮
│ │
│ - Found 1 session lock file. │
│ - ~/.openclaw/agents/discord-general/sessions/829d43bb-f84b-4c39-ab29-955a │
│ b37b57b1-topic-1488337547120611338.jsonl.lock │
│ pid=1431912 (alive) age=1m8s stale=no │
│ │
├──────────────────────────────────────────────────────────────────────────────╯
│
◇ Security ─────────────────────────────────────────────────────────────╮
│ │
│ - Note: approvals.exec.enabled=false disables approval forwarding │
│ only. │
│ Host exec gating still comes from ~/.openclaw/exec-approvals.json. │
│ Check local policy with: openclaw approvals get --gateway │
│ - Run: openclaw security audit --deep │
│ │
├────────────────────────────────────────────────────────────────────────╯
│
◇ Skills status ────────────╮
│ │
│ Eligible: 13 │
│ Missing requirements: 40 │
│ Blocked by allowlist: 0 │
│ │
├────────────────────────────╯
[plugins] [browser-cloud] init
[plugins] [browser-cloud] registering tool: browser_cloud
[plugins] [channel-context-overlay] loaded — before_prompt_build hook active
[plugins] [discord-reminder-crond] loaded (channelId=1475939937508528272)
[plugins] [transcript-hygiene] loaded — before_prompt_build hook active
[plugins] web-search-budget plugin registered (budgeted web search tool factory)
[plugins] [system-prompt-logger] loaded — llm_input hook active
│
◇ Plugins ──────╮
│ │
│ Loaded: 54 │
│ Disabled: 44 │
│ Errors: 0 │
│ │
├────────────────╯
│
◇ Plugin compatibility ─────────────────────────────────────────────────╮
│ │
│ - channel-context-overlay is hook-only. This remains a supported │
│ compatibility path, but it has not migrated to explicit capability │
│ registration yet. │
│ - discord-reminder-crond is hook-only. This remains a supported │
│ compatibility path, but it has not migrated to explicit capability │
│ registration yet. │
│ - transcript-hygiene is hook-only. This remains a supported │
│ compatibility path, but it has not migrated to explicit capability │
│ registration yet. │
│ - system-prompt-logger is hook-only. This remains a supported │
│ compatibility path, but it has not migrated to explicit capability │
│ registration yet. │
│ │
├────────────────────────────────────────────────────────────────────────╯
Discord: ok (@Clawd) (408ms)
Agents: discord-general (default), discord-motivation, discord-predictions, discord-debug, nexus, discord-noop
Heartbeat interval: 30m (discord-general)
Session store (discord-general): /home/ec2-user/.openclaw/agents/discord-general/sessions/sessions.json (117 entries)

- agent:discord-general:discord:channel:1488337547120611338 (1m ago)
- agent:discord-general:discord:channel:1478218325195755650 (1174m ago)
- agent:discord-general:discord:channel:1465502730515644552 (1388m ago)
- agent:discord-general:cron:b8ad450b-750f-47da-b17d-c038af1aac50 (1500m ago)
- agent:discord-general:cron:86bb3ec0-9dd1-479c-afe1-c30cc45dbf49 (1578m ago)
  Run "openclaw doctor --fix" to apply changes.
  │
  └ Doctor complete.
- Validate and our release pipeline end-to-end
- Re-verify external plugin deploy behavior (esp. browser-cloud)

# Skill Curator

The skill curator maintains your workspace `skills/` tree —
marking stale skills, archiving unused ones, and (when gateway support is
available) running an LLM review pass to patch drift or consolidate
near-duplicates.

> **Status:** Phase A (deterministic transitions, snapshots, pinning, telemetry)
> is fully functional. Phase B (LLM review pass) requires the
> `auxiliary.curator` model slot, which is a gateway-level feature (deferred).
> The `/curator` slash command on Discord/Telegram requires platform
> slash-command registration (deferred). The CLI works from any shell.

## Quick Start

```bash
# Check what the curator would do (no mutations)
openclaw curator run --dry-run

# Check status
openclaw curator status

# Run now
openclaw curator run
```

## How It Works

### What Gets Managed

The curator only manages **agent-created** skills — skills created by the
`skill_workshop` tool. Hand-written skills, bundled skills (shipped with
OpenClaw), and hub-installed skills (from clawhub.ai) are never touched.

A skill is considered "agent-created" when its `created_by` field in
`.usage.json` is `"agent"`. Skills created by `skill_workshop` get this
marker automatically.

### What Counts as Agent-Created

| Marker                  | Meaning                   | Curator Behavior                     |
| ----------------------- | ------------------------- | ------------------------------------ |
| `created_by: "agent"`   | Created by skill_workshop | Fully managed                        |
| `created_by: "user"`    | Hand-authored by you      | Never touched                        |
| `created_by: "unknown"` | Pre-migration skill       | Treated as user-owned (safe default) |

You can promote or demote skills at any time:

```bash
# Let the curator manage it
openclaw curator adopt <skill-name>

# Remove from curator management
openclaw curator disown <skill-name>
```

### Lifecycle

```
active ──(30d unused)──→ stale ──(90d unused)──→ archived
  ↑                                                    │
  └──────────── restore ───────────────────────────────┘
```

Archived skills move to `<workspace>/skills/.archive/<name>/` — they're never
deleted, just set aside.

### First-Run Defer

On a fresh install, the curator seeds `last_run_at` to the current time and
skips the first pass. This gives you one full interval (default 7 days) to
pin important skills or disable the curator before it acts.

## Pinning

Pinned skills are **immune** to all curator actions — they won't be marked
stale, archived, or mutated by the LLM review pass. Pinned skills also
cannot be deleted by `skill_workshop(action=delete)`.

```bash
openclaw curator pin <skill-name>
openclaw curator unpin <skill-name>
```

Pinned skills appear in `openclaw curator status` under the `pinned` list.

## Phase A vs Phase B

The curator runs in two phases:

### Phase A — Deterministic Transitions

No LLM involved. Pure time-based rules:

- Skills unused > `stale_after_days` → marked `stale`
- Skills unused > `archive_after_days` → moved to `.archive/`

Skip: pinned, bundled, hub-installed, and non-agent-created skills.

### Phase B — LLM Review Pass

> **Deferred:** Requires the `auxiliary.curator` model slot at the gateway
> level. Not currently active in automatic runs.

When wired, uses a cheap auxiliary model to review agent-created skills and suggest:

- **keep** — skill is still useful
- **patch** — fix a specific issue (replace old_text with new_text)
- **consolidate** — merge two similar skills
- **archive** — skill is no longer needed

The LLM is **conservative** — when in doubt, it keeps. All actions flow
through `skill_workshop` so audit trails, hooks, and checkpoints fire.

## Backup & Rollback

Before every mutating run, the curator snapshots the entire `skills/` tree
to a tar.gz under `<workspace>/skills/.curator_backups/<timestamp>/`.

```bash
# Manual backup
openclaw curator backup --reason "Before major reorganization"

# List available snapshots
openclaw curator rollback --list

# Restore from a snapshot (pre-rollback snapshot taken automatically)
openclaw curator rollback --id <timestamp>
```

By default, the last 5 snapshots are kept (configurable via `backup.keep`).

## Pause / Resume

```bash
# Pause — no automatic runs until resumed
openclaw curator pause

# Resume
openclaw curator resume
```

Pause state persists across sessions.

## Safety Guards

- **No auto-delete.** The worst outcome is `.archive/` (recoverable).
- **Lockfile.** Only one curator run at a time.
- **Pre-mutation snapshot.** Always taken before any changes.
- **Bundled/hub immunity.** Never touched regardless of config.
- **First-run defer.** No surprise runs on fresh install.

## Troubleshooting

### "The curator archived my hand-written skill!"

The curator only touches `created_by: "agent"` skills. Check with:

```bash
openclaw curator status
```

If your skill shows as `agent_created`, disown it:

```bash
openclaw curator disown <skill-name>
```

### "I want to restore an archived skill"

```bash
openclaw curator restore <skill-name>
```

The skill moves back to `skills/` and is marked `active`.

### "The curator won't run"

- Check if it's paused: `openclaw curator status`
- Check the interval: default is 7 days (`interval_hours: 168`)
- On first install: the first pass is deferred by one interval

### "tar not found"

Snapshots require `tar` on your PATH. If `tar` is unavailable, the curator
run will return a snapshot error and stop before applying mutations.

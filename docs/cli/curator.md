# `openclaw curator`

Skill curator CLI — manage skill lifecycle, telemetry, and archival.
LLM review pass requires gateway-level `auxiliary.curator` model slot (deferred).

> **Note:** The `/curator` slash command on Discord/Telegram requires platform
> slash-command registration (deferred). CLI commands work from any shell.

## Commands

### `curator status`

Show curator state: last run, counts by state, pinned list, LRU top 5.

```bash
openclaw curator status
```

Output (JSON):

```json
{
  "last_run_at": "2026-05-06T12:00:00.000Z",
  "paused": false,
  "counts": {
    "total": 12,
    "active": 8,
    "stale": 2,
    "archived": 2,
    "pinned": 1,
    "agent_created": 6,
    "user_created": 3,
    "unknown": 3
  },
  "pinned": ["git-workflow"],
  "lru_top_5": [...]
}
```

---

### `curator run`

Trigger a curator run (Phase A — deterministic transitions only).

```bash
openclaw curator run
```

Options:

| Flag        | Description                              |
| ----------- | ---------------------------------------- |
| `--dry-run` | Preview only — no mutations, no lockfile |

```bash
openclaw curator run --dry-run
```

---

### `curator backup`

Create a manual snapshot of `skills/`.

```bash
openclaw curator backup --reason "Before cleanup"
```

Options:

| Flag              | Description          |
| ----------------- | -------------------- |
| `--reason <text>` | Label for the backup |

---

### `curator rollback`

Restore from a snapshot.

```bash
# List available snapshots
openclaw curator rollback --list

# Restore from a specific snapshot
openclaw curator rollback --id <timestamp>
```

A pre-rollback snapshot is taken before restoring, so a mistaken rollback
can be rolled forward.

---

### `curator pause` / `curator resume`

Pause or resume automatic curator runs. Persists across sessions.

```bash
openclaw curator pause
openclaw curator resume
```

---

### `curator pin <skill>` / `curator unpin <skill>`

Pin a skill to make it immune to archival and deletion. Unpin to allow
curator management again.

```bash
openclaw curator pin my-workflow
openclaw curator unpin my-workflow
```

Bundled and hub-installed skills cannot be pinned.

---

### `curator restore <skill>`

Restore an archived skill back to `skills/`. The skill is marked `active`.

```bash
openclaw curator restore old-skill
```

---

### `curator adopt <skill>` / `curator disown <skill>`

Change the `created_by` marker:

- `adopt` → sets to `"agent"` (curator manages it)
- `disown` → sets to `"user"` (curator leaves it alone)

```bash
openclaw curator adopt hand-written-skill
openclaw curator disown auto-generated-skill
```

Useful for:

- Promoting a hand-written skill you want the curator to maintain
- Protecting an agent-created skill you want to manage yourself

---

## Slash Command

When platform slash-command registration is available, all verbs will be
exposed as `/curator` in CLI, Discord, and Telegram.

Currently available via CLI:

```
openclaw curator status
openclaw curator run --dry-run
openclaw curator pin my-skill
```

---

## See Also

- [Skill Curator Guide](/docs/automation/curator.md) — full lifecycle, pinning UX, troubleshooting
- [Skill Workshop](/docs/cli/skill-workshop.md) — the tool that creates skills
- [Config Reference](/docs/config.md) — `curator.*` config keys (`auxiliary.curator.*` is a deferred gateway feature)

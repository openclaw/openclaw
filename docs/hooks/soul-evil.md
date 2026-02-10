---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "SOUL Evil hook (swap SOUL.md with SOUL_EVIL.md)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to enable or tune the SOUL Evil hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a purge window or random-chance persona swap（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "SOUL Evil Hook"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# SOUL Evil Hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The SOUL Evil hook swaps the **injected** `SOUL.md` content with `SOUL_EVIL.md` during（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
a purge window or by random chance. It does **not** modify files on disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How It Works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `agent:bootstrap` runs, the hook can replace the `SOUL.md` content in memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
before the system prompt is assembled. If `SOUL_EVIL.md` is missing or empty,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw logs a warning and keeps the normal `SOUL.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sub-agent runs do **not** include `SOUL.md` in their bootstrap files, so this hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
has no effect on sub-agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw hooks enable soul-evil（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then set the config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hooks": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "internal": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "entries": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "soul-evil": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "file": "SOUL_EVIL.md",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "chance": 0.1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "purge": { "at": "21:00", "duration": "15m" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create `SOUL_EVIL.md` in the agent workspace root (next to `SOUL.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `file` (string): alternate SOUL filename (default: `SOUL_EVIL.md`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chance` (number 0–1): random chance per run to use `SOUL_EVIL.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `purge.at` (HH:mm): daily purge start (24-hour clock)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `purge.duration` (duration): window length (e.g. `30s`, `10m`, `1h`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Precedence:** purge window wins over chance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Timezone:** uses `agents.defaults.userTimezone` when set; otherwise host timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No files are written or modified on disk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `SOUL.md` is not in the bootstrap list, the hook does nothing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Hooks](/automation/hooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

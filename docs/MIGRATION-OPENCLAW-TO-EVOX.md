# Migration: OpenClaw → EVOX.sh

_Created: 2026-03-25_

## Path Changes

| Old (deprecated)          | New                 | Notes                 |
| ------------------------- | ------------------- | --------------------- |
| `~/.openclaw/`            | `~/.evox/`          | Main config dir       |
| `~/.openclaw/config.yaml` | `~/.evox/evox.yaml` | Config file           |
| `openclaw.mjs`            | `evox`              | CLI binary            |
| `/home/node/.openclaw/`   | `/home/node/.evox/` | Docker container path |

## Backward Compatibility

EVOX.sh engine checks both paths:

1. `~/.evox/` (preferred)
2. `~/.openclaw/` (fallback for existing installs)

For fresh installs, only `~/.evox/` is created.

## Files That May Contain Old Paths

### In Agent Workspaces

- Python venv files (`activate`, `activate.fish`, etc.) — regenerate venv
- Memory files — manually update
- Session logs — historical, no action needed

### In EVOX.sh Engine

- Test files — intentional for backward compat testing
- `canvas/index.html` — JS hooks (cosmetic, no impact)

## Migration Steps for Existing Agents

1. **Check for old paths:**

   ```bash
   grep -rn "\.openclaw" ~/.agents/*/workspace/ --include="*.md"
   ```

2. **Update workspace files:**
   - SOUL.md, AGENTS.md, USER.md — update any path references
   - Memory files — update if needed
   - Skills — ensure they reference `.evox`

3. **Regenerate Python venvs** (if any):

   ```bash
   rm -rf workspace/autoresearch/.venv
   cd workspace/autoresearch && python -m venv .venv
   ```

4. **Add evox-config skill:**
   ```bash
   cp -r ~/.EVOX.sh/templates/hidrix/skills/evox-config workspace/skills/
   ```

## Agent Knowledge

Agents may hallucinate old paths from model training data. The `evox-config` skill helps correct this by providing authoritative path information.

Location: `~/.EVOX.sh/templates/hidrix/skills/evox-config/SKILL.md`

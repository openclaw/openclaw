# Local state + config export (dev-only)

Moltbot stores runtime state under your home directory (by default `~/.moltbot`, with legacy `~/.clawdbot` often pointing to the same place).

This repo intentionally does **not** track your real local config, pairing stores, tokens, or other secrets. Instead, it provides a script that copies local state into a gitignored folder and optionally writes a **redacted** snapshot that is safe to commit.

## Export local state into this repo

From the repo root:

```bash
node scripts/local/export-local-state.mjs
```

Outputs:
- `.local/moltbot/state/` (gitignored): a local backup of your state/config files
- `config/redacted/moltbot.redacted.json` (tracked): a redacted snapshot for reference/review

### Optional flags

```bash
node scripts/local/export-local-state.mjs --include-agents --include-memory --include-logs
```

Those folders can be large.

## Security notes

- The export script intentionally skips OAuth credential files like `oauth.json`.
- Always review `config/redacted/moltbot.redacted.json` before committing.
- Never commit real tokens, secrets, phone numbers, or personal identifiers.

## Optional: import a local notes folder

If you keep local operator notes in a folder like `~/clawd/`, you can copy it into this repo under `.local/`:

```bash
node scripts/local/import-clawd.mjs
```


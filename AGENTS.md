# PipBot

**Product name:** Pip
**Upstream repo:** https://github.com/moltbot/moltbot
**Fork:** https://github.com/bloom-street/pipbot
**Local path:** `~/Programming/pipbot`

---

## Completed

- [x] Fork moltbot/moltbot → bloom-street/pipbot
- [x] Clone to ~/Programming/pipbot
- [x] Install dependencies (pnpm, not npm)
- [x] Build successfully (no errors)
- [x] Run onboarding wizard (Anthropic provider configured)
- [x] Build control UI (`pnpm ui:build`)
- [x] Gateway runs on port 18789
- [x] Chat works in terminal
- [x] Control UI works in browser

---

## TODO

<!-- Add next steps here as scope expands -->

---

## Notes

- Project uses **pnpm** (not npm) — `pnpm install`, `pnpm run build`
- Config stored in `~/.moltbot/` (not in the repo)
- CLAUDE.md symlinks to AGENTS.md
- Docker/Fly/Render files inherited from upstream — not needed for native macOS app, can be deleted

---

## Useful Commands

```bash
# All commands run from ~/Programming/pipbot

# Start gateway
npx . gateway --port 18789 --verbose

# Stop gateway
npx . gateway stop

# Check status
npx . gateway status

# Run doctor
npx . doctor

# Update config
npx . configure

# Rebuild
pnpm run build

# Build UI
pnpm ui:build
```

---

## Fresh Build

Standard rebuild:
```bash
cd ~/Programming/pipbot
pnpm install
pnpm run build
pnpm ui:build
```

Clean build (wipe old artifacts first):
```bash
cd ~/Programming/pipbot
rm -rf node_modules dist
pnpm install
pnpm run build
pnpm ui:build
```

---

## Onboarding

Run after a fresh build to configure LLM provider and API key:
```bash
cd ~/Programming/pipbot
npx . onboard
```

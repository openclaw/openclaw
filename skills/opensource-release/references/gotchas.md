# Open Source Release — Gotchas

- **Never include tokens in git remote URLs** — always verify before push
- **Binary caches** not covered by `.gitignore` may already be in history — check carefully
- **Encoding issues on Windows** — use UTF-8 explicitly in PowerShell/Python
- Your GitHub username is already public — that is fine to leave as-is
- Never commit `.env` files — add to `.gitignore` if not already there

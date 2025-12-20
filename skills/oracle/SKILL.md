---
name: oracle
description: Run a second-model review or debug session with the oracle CLI.
metadata: {"clawdis":{"requires":{"bins":["oracle"]},"install":[{"id":"node","kind":"node","package":"@steipete/oracle","bins":["oracle"],"label":"Install oracle (node)"}]}}
---

# oracle

Use `oracle` to bundle prompts + files for a second model.

Quick start
- `oracle --help`
- `oracle -p "Review this" --file "src/**/*.ts"`
- `oracle --render --copy -p "Summarize" --file docs/README.md`

Engines
- API: requires `OPENAI_API_KEY` (plus `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` for those models)
- Browser: `oracle --engine browser ...` (uses logged-in Chrome)

Notes
- If missing, run `npx -y @steipete/oracle --help`.
- For long runs, add `--wait` to block until done.

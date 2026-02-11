# AGENTS.md - ja-JP docs translation workspace

## Read When

- Maintaining `docs/ja-JP/**`
- Updating the Japanese translation pipeline (glossary/TM/prompt)
- Handling Japanese translation feedback or regressions

## Pipeline (docs-i18n)

- Source docs: `docs/**/*.md`
- Target docs: `docs/ja-JP/**/*.md`
- Glossary: `docs/.i18n/glossary.ja-JP.json`
- Translation memory: `docs/.i18n/ja-JP.tm.jsonl`
- Prompt rules: `scripts/docs-i18n/prompt.go`

Common runs:

```bash
# Bulk (doc mode; parallel OK)
cd scripts/docs-i18n
go run . -docs ../../docs -lang ja-JP -mode doc -parallel 6 ../../docs/**/*.md

# Single file
cd scripts/docs-i18n
go run . -docs ../../docs -lang ja-JP -mode doc ../../docs/start/getting-started.md

# Small patches (segment mode; uses TM; no parallel)
cd scripts/docs-i18n
go run . -docs ../../docs -lang ja-JP -mode segment ../../docs/start/getting-started.md
```

Notes:

- Prefer `doc` mode for whole-page translation; `segment` mode for small fixes.
- If a very large file times out, do targeted edits or split the page before rerunning.
- After translation, spot-check: code spans/blocks unchanged, links/anchors unchanged, placeholders preserved.

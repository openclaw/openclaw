# AGENTS.md - ja-JP docs translation workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Read When（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Maintaining `docs/ja-JP/**`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updating the Japanese translation pipeline (glossary/TM/prompt)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Handling Japanese translation feedback or regressions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pipeline (docs-i18n)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Source docs: `docs/**/*.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Target docs: `docs/ja-JP/**/*.md`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Glossary: `docs/.i18n/glossary.ja-JP.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Translation memory: `docs/.i18n/ja-JP.tm.jsonl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prompt rules: `scripts/docs-i18n/prompt.go`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bulk (doc mode; parallel OK)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd scripts/docs-i18n（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
go run . -docs ../../docs -lang ja-JP -mode doc -parallel 6 ../../docs/**/*.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Single file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd scripts/docs-i18n（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
go run . -docs ../../docs -lang ja-JP -mode doc ../../docs/start/getting-started.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Small patches (segment mode; uses TM; no parallel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd scripts/docs-i18n（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
go run . -docs ../../docs -lang ja-JP -mode segment ../../docs/start/getting-started.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `doc` mode for whole-page translation; `segment` mode for small fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a very large file times out, do targeted edits or split the page before rerunning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After translation, spot-check: code spans/blocks unchanged, links/anchors unchanged, placeholders preserved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

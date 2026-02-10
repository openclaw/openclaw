# OpenClaw docs i18n assets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This folder stores **generated** and **config** files for documentation translations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `glossary.<lang>.json` — preferred term mappings (used in prompt guidance).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `<lang>.tm.jsonl` — translation memory (cache) keyed by workflow + model + text hash.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Glossary format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`glossary.<lang>.json` is an array of entries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "source": "troubleshooting",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "target": "故障排除",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "ignore_case": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "whole_word": false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `source`: English (or source) phrase to prefer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `target`: preferred translation output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Glossary entries are passed to the model as **prompt guidance** (no deterministic rewrites).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The translation memory is updated by `scripts/docs-i18n`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

# [中文翻译] Generated Docs Artifacts\n\n这是 docs/.generated/README.md 的中文翻译版本。\n\n原文内容：\n\n# Generated Docs Artifacts

SHA-256 hash files are the tracked drift-detection artifacts. The full JSON
baselines are generated locally (gitignored) for inspection only.

**Tracked (committed to git):**

- `config-baseline.sha256` — hashes of config baseline JSON artifacts.
- `plugin-sdk-api-baseline.sha256` — hashes of Plugin SDK API baseline artifacts.

**Local only (gitignored):**

- `config-baseline.json`, `config-baseline.core.json`, `config-baseline.channel.json`, `config-baseline.plugin.json`
- `plugin-sdk-api-baseline.json`, `plugin-sdk-api-baseline.jsonl`

Do not edit any of these files by hand.

- Regenerate config baseline: `pnpm config:docs:gen`
- Validate config baseline: `pnpm config:docs:check`
- Regenerate Plugin SDK API baseline: `pnpm plugin-sdk:api:gen`
- Validate Plugin SDK API baseline: `pnpm plugin-sdk:api:check`

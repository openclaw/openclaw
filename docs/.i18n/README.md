# OpenClaw docs i18n assets

This folder stores translation config for the source docs repo.

Generated locale trees and live translation memory now live in the publish repo:

- repo: `openclaw/docs`
- local checkout: `~/Projects/openclaw-docs`

## Source of truth

- English docs are authored in `openclaw/openclaw`.
- The source docs tree lives under `docs/`.
- The source repo no longer keeps committed generated locale trees such as `docs/zh-CN/**`, `docs/ja-JP/**`, `docs/es/**`, `docs/pt-BR/**`, `docs/ko/**`, `docs/de/**`, `docs/fr/**`, or `docs/ar/**`.

## End-to-end flow

1. Edit English docs in `openclaw/openclaw`.
2. Push to `main`.
3. `openclaw/openclaw/.github/workflows/docs-sync-publish.yml` mirrors the docs tree into `openclaw/docs`.
4. The sync script rewrites the publish `docs/docs.json` so the generated locale picker blocks exist there even though they are no longer committed in the source repo.
5. `openclaw/docs/.github/workflows/translate-zh-cn.yml` refreshes `docs/zh-CN/**` once a day, on demand, and after source-repo release dispatches.
6. `openclaw/docs/.github/workflows/translate-ja-jp.yml` does the same for `docs/ja-JP/**`.
7. `openclaw/docs/.github/workflows/translate-es.yml`, `translate-pt-br.yml`, `translate-ko.yml`, `translate-de.yml`, `translate-fr.yml`, and `translate-ar.yml` do the same for `docs/es/**`, `docs/pt-BR/**`, `docs/ko/**`, `docs/de/**`, `docs/fr/**`, and `docs/ar/**`.

## Why the split exists

- Keep generated locale output out of the main product repo.
- Keep Mintlify on a single published docs tree.
- Preserve the built-in language switcher by letting the publish repo own generated locale trees.

## Files in this folder

- `glossary.<lang>.json` — preferred term mappings used as prompt guidance.
- `ar-navigation.json`, `de-navigation.json`, `es-navigation.json`, `fr-navigation.json`, `ja-navigation.json`, `ko-navigation.json`, `pt-BR-navigation.json`, `zh-Hans-navigation.json` — Mintlify locale picker blocks reinserted into the publish repo during sync.
- `<lang>.tm.jsonl` — translation memory keyed by workflow + model + text hash.

In this repo, generated locale TM files such as `docs/.i18n/zh-CN.tm.jsonl`, `docs/.i18n/ja-JP.tm.jsonl`, `docs/.i18n/es.tm.jsonl`, `docs/.i18n/pt-BR.tm.jsonl`, `docs/.i18n/ko.tm.jsonl`, `docs/.i18n/de.tm.jsonl`, `docs/.i18n/fr.tm.jsonl`, and `docs/.i18n/ar.tm.jsonl` are intentionally no longer committed.

## Glossary format

`glossary.<lang>.json` is an array of entries:

```json
{
  "source": "troubleshooting",
  "target": "故障排除"
}
```

Fields:

- `source`: English (or source) phrase to prefer.
- `target`: preferred translation output.

## Translation mechanics

- `scripts/docs-i18n` still owns translation generation.
- Doc mode writes `x-i18n.source_hash` into each translated page.
- Each publish workflow precomputes a pending file list by comparing the current English source hash to the stored locale `x-i18n.source_hash`.
- If the pending count is `0`, the expensive translation step is skipped entirely.
- If there are pending files, the workflow translates only those files.
- The publish workflow retries transient model-format failures, but unchanged files stay skipped because the same hash check runs on each retry.
- The source repo also dispatches zh-CN, ja-JP, es, pt-BR, ko, de, fr, and ar refreshes after published GitHub releases so release docs can catch up without waiting for the daily cron.

## Operational notes

- Sync metadata is written to `.openclaw-sync/source.json` in the publish repo.
- Source repo secret: `OPENCLAW_DOCS_SYNC_TOKEN`
- Publish repo secret: `OPENCLAW_DOCS_I18N_OPENAI_API_KEY`
- If locale output looks stale, check the matching `Translate <locale>` workflow in `openclaw/docs` first.

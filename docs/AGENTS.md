# Docs Guide

Own docs authoring, published links, docs i18n policy.

## Source Ownership

- Author `/clawhub/**` in [openclaw/clawhub](https://github.com/openclaw/clawhub/tree/main/docs), never here. `scripts/docs-sync-publish.mjs` replaces publish `docs/clawhub/` tree. Link audits accept routes declared in `docs/docs.json` without checkout; undeclared routes fail.
- OpenClaw-specific skill/plugin installation, update, verification, removal, release-trust guidance stays here (`docs/cli/skills.md`, `docs/cli/plugins.md`). Standalone ClawHub CLI/publishing reference → upstream.
- Plain `pnpm docs:check-links` skips ClawHub fragments. Use `pnpm docs:check-links:anchors` + `OPENCLAW_DOCS_SYNC_CLAWHUB_REPO` set to source checkout; otherwise declared-route fragments unverified.
- Approved release-doc changes: regenerate complete marked `CHANGELOG/<version>.md` mirror via `pnpm changelog:from-docs`; preserve ordered sources + frozen `CHANGELOG/records/<version>.md`. Use `pnpm changelog:check`; untouched history not converted. Generation/post-release publication: read `openclaw-changelog-update` skill.
- Never generically format generated `CHANGELOG/**` or root changelog; exact migrated/mirrored bytes generator-owned.

## Local Preview

- Uncommitted English content in current website UI: `pnpm docs:dev -- --page <route>`; repeat `--page` up to 30 pages. Re-run after edits.
- Clone `openclaw/docs` as `../openclaw-docs` beside main checkout; run `npm ci` there. Override: `--site-repo <path>` or `OPENCLAW_DOCS_SITE_REPO`.
- Preview writes only ignored `.cache/docs-preview/`; no sync/translate/publish. Build-only/port options: `pnpm docs:dev --help`. Serving needs Python 3.
- Website styling/renderer → `openclaw/docs`; content, navigation, redirects, shared publishing parser → here.

## Published Link Rules

- `openclaw/docs` publishes `https://docs.openclaw.ai`; owns design/UI.
- Internal `docs/**/*.md` links: root-relative, no `.md`/`.mdx`, including section anchors: `[Hooks](/gateway/config-hooks#hooks)`.
- Heading IDs: `scripts/lib/docs-markdown.mjs`; verify via `pnpm docs:check-links:anchors`. Preserve published IDs + named anchors; compatibility aliases never replace existing targets. Heading wording may change → `<a id="stable-section-name" />`.
- README/other GitHub-rendered docs: absolute docs URLs.
- Public docs generic: no personal devices, hostnames, local paths. Placeholders: `user@gateway-host`, `~/path/to/skills`.
- Follow [Secret Placeholder Conventions](/reference/secret-placeholder-conventions); credential examples obviously fake.

## Docs Content Rules

- Runtime-floor changes in `node-version.mjs`, `package.json` engines, `src/infra/runtime-guard.ts` (Bun), or `src/infra/sqlite-runtime-version.ts`: update supported-version/history tables in `docs/install/node-compatibility.md` + `docs/install/bun-compatibility.md`.
- Alphabetize services/providers in docs, UI copy, pickers, except explicit runtime/auto-detection order. Follow root `AGENTS.md` plugin terminology.
- CI schema-checks JSON/JSON5 fences resembling whole `openclaw.json` files (`pnpm docs:check-config-examples`). Deliberately partial/legacy fences: `validate=false`.
- Never hand-edit `docs/plugins/reference/**`, `docs/plugins/reference.md`, `docs/plugins/plugin-inventory.md`; run `pnpm plugins:inventory:gen`. `docs/maturity/**`: see below.
- Only source stub in `docs/docs_map.md`; publishing/packaging generate expanded map from `pnpm docs:list --headings`. Never commit heading mirror.

## Internal Docs

- Long-lived private operator docs → private operator repo. Local scratch/mirrors may use ignored `docs/internal/`; never link from public docs or include in `docs/docs.json`.
- `scripts/docs-sync-publish.mjs` excludes/prunes `docs/internal/**` + root `docs/AGENTS.md`/`docs/CLAUDE.md`; translation finalization removes locale copies of instruction files. Public `docs/reference/templates/**` remain published.
- Internal docs may name repo paths, private apps, 1Password items, runbooks; never secret values.

## Maturity Scorecard Editing

- Edit `taxonomy.yaml` + `qa/maturity-scores.yaml`, never generated score, LTS, taxonomy, QA-profile, evidence tables in `docs/maturity/`.
- Generation owner: `scripts/qa/render-maturity-docs.ts`; refresh: `pnpm maturity:render`; verify: `pnpm maturity:check`.
- `.github/workflows/maturity-scorecard.yml` renders previews/can open generated-doc PRs; `.github/workflows/openclaw-release-checks.yml` dispatches it for release QA.
- Deterministic `qa-evidence.json.scorecard` stays in Actions artifacts unless maintainer requests sanitized committed projection. Human overrides: source-state PR with reasons + public/redacted evidence.

## Docs i18n

- English docs/glossary here authoritative (ClawHub: Source Ownership). Never add/edit `docs/<locale>/**` here; generated translations + `docs/.i18n/*.tm.jsonl` → `openclaw/docs`.
- Before publish-repo sync/`scripts/docs-i18n`: update English + glossary here. Before rerunning translation: entries for new technical terms, page titles, short nav labels, terms requiring fixed translation/English spelling.
- Changed English titles/short internal labels: `pnpm docs:check-i18n-glossary`. Pipeline: read `docs/.i18n/README.md`.

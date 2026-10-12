# Docs Guide

This directory owns docs authoring, published links, and docs i18n policy.

## Source Ownership

- Author `/clawhub/**` in [openclaw/clawhub](https://github.com/openclaw/clawhub/tree/main/docs), never here. `scripts/docs-sync-publish.mjs` replaces the publish `docs/clawhub/` tree. Link audits accept routes declared in `docs/docs.json` without that checkout; undeclared routes fail.
- Keep OpenClaw-specific skill/plugin installation, update, verification, removal, and release-trust guidance here (`docs/cli/skills.md`, `docs/cli/plugins.md`). Standalone ClawHub CLI/publishing reference belongs upstream.
- Plain `pnpm docs:check-links` skips ClawHub fragments. Use `pnpm docs:check-links:anchors` with `OPENCLAW_DOCS_SYNC_CLAWHUB_REPO` set to the source checkout; otherwise declared-route fragments remain unverified.
- Approved release-doc changes regenerate the complete marked `CHANGELOG/<version>.md` mirror with `pnpm changelog:from-docs`, preserving its ordered sources and frozen `CHANGELOG/records/<version>.md`. Use `pnpm changelog:check`; it does not convert untouched history. Read the `openclaw-changelog-update` skill for generation and post-release publication.
- Never generically format generated `CHANGELOG/**` or the root changelog; their exact migrated/mirrored bytes belong to the generator.

## Local Preview

- Run `pnpm docs:dev -- --page <route>` for uncommitted English content in the current website UI; repeat `--page` up to 30 pages. Re-run after edits.
- Clone `openclaw/docs` as `../openclaw-docs` beside the main checkout and run `npm ci` there. Override with `--site-repo <path>` or `OPENCLAW_DOCS_SITE_REPO`.
- Preview writes only ignored `.cache/docs-preview/`; it does not sync, translate, or publish. See `pnpm docs:dev --help` for build-only and port options. Serving needs Python 3.
- Website styling/renderer belong in `openclaw/docs`; content, navigation, redirects, and the shared publishing parser belong here.

## Published Link Rules

- `openclaw/docs` publishes `https://docs.openclaw.ai` and owns its design/UI.
- Internal links in `docs/**/*.md` use root-relative paths without `.md`/`.mdx`, including section anchors: `[Hooks](/gateway/config-hooks#hooks)`.
- `scripts/lib/docs-markdown.mjs` owns heading IDs; verify with `pnpm docs:check-links:anchors`. Preserve published IDs and named anchors; compatibility aliases never replace existing targets. Use `<a id="stable-section-name" />` when heading wording may change.
- README and other GitHub-rendered docs use absolute docs URLs.
- Keep public docs generic: no personal devices, hostnames, or local paths. Use placeholders such as `user@gateway-host` and `~/path/to/skills`.
- Follow [Secret Placeholder Conventions](/reference/secret-placeholder-conventions); credential examples must be obviously fake.

## Docs Content Rules

- Runtime-floor changes in `node-version.mjs`, `package.json` engines, `src/infra/runtime-guard.ts` (Bun), or `src/infra/sqlite-runtime-version.ts` update supported-version/history tables in `docs/install/node-compatibility.md` and `docs/install/bun-compatibility.md`.
- Alphabetize services/providers in docs, UI copy, and pickers, except explicit runtime or auto-detection order. Follow root `AGENTS.md` plugin terminology.
- CI schema-checks JSON/JSON5 fences resembling whole `openclaw.json` files (`pnpm docs:check-config-examples`). Mark deliberately partial/legacy fences `validate=false`.
- Never hand-edit `docs/plugins/reference/**`, `docs/plugins/reference.md`, or `docs/plugins/plugin-inventory.md`; run `pnpm plugins:inventory:gen`. For `docs/maturity/**`, see below.
- Keep only the source stub in `docs/docs_map.md`; publishing/packaging generate the expanded map from `pnpm docs:list --headings`. Never commit the heading mirror.

## Internal Docs

- Long-lived private operator docs belong in a private operator repo. Local scratch/mirrors may use ignored `docs/internal/`; never link them from public docs or include them in `docs/docs.json`.
- `scripts/docs-sync-publish.mjs` excludes/prunes `docs/internal/**` and root `docs/AGENTS.md`/`docs/CLAUDE.md`; translation finalization removes locale copies of those instruction files. Public `docs/reference/templates/**` remain published.
- Internal docs may name repo paths, private apps, 1Password items, and runbooks, never secret values.

## Maturity Scorecard Editing

- Edit `taxonomy.yaml` and `qa/maturity-scores.yaml`, never generated score, LTS, taxonomy, QA-profile, or evidence tables in `docs/maturity/`.
- `scripts/qa/render-maturity-docs.ts` owns generation: `pnpm maturity:render` refreshes; `pnpm maturity:check` verifies.
- `.github/workflows/maturity-scorecard.yml` renders previews/can open generated-doc PRs; `.github/workflows/openclaw-release-checks.yml` dispatches it for release QA.
- Keep deterministic `qa-evidence.json.scorecard` in Actions artifacts unless a maintainer requests a sanitized committed projection. Human overrides change source state in a PR with reasons and public/redacted evidence.

## Docs i18n

- English docs and glossary files here are authoritative (ClawHub follows Source Ownership). Never add/edit `docs/<locale>/**` here; generated translations and `docs/.i18n/*.tm.jsonl` belong in `openclaw/docs`.
- Update English and glossary terms here before publish-repo sync/`scripts/docs-i18n`. Add entries for new technical terms, page titles, short nav labels, and terms requiring fixed translation or English spelling before rerunning translation.
- Run `pnpm docs:check-i18n-glossary` for changed English titles/short internal labels. Read `docs/.i18n/README.md` for the pipeline.

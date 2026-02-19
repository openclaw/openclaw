# OpenClaw Local Indexing Blueprint

This pipeline builds a local index over three data planes:

1. `docs` - remote public docs (`https://docs.openclaw.ai`) with manifest + recursive crawl.
2. `code` - local source trees (OpenClaw + sibling repos).
3. `runtime` - local runtime/config state from `~/.openclaw` (with secret redaction).
4. `config-doc` - local configuration/runtime documentation in `docs/`.

The goal is high coverage with deterministic outputs, not a one-off scrape.

## Run

```bash
cd /Users/anima/repos/openclaw-upstream
node scripts/indexing/build-openclaw-index.mjs
```

Custom options:

```bash
node scripts/indexing/build-openclaw-index.mjs \
  --config scripts/indexing/openclaw-index.config.json \
  --out .openclaw-index \
  --code-root ../another-repo \
  --docs-locales en,zh-CN \
  --max-doc-pages 2000
```

## Output

- `.openclaw-index/documents.jsonl` - indexed chunks.
- `.openclaw-index/failures.jsonl` - fetch/read failures.
- `.openclaw-index/manifest.json` - coverage stats and quality gate results.

## Build retrieval DB (FTS)

```bash
pnpm index:openclaw:db
```

This creates `.openclaw-index/retrieval.sqlite` for fast local search over
the indexed records.

## Query retrieval DB

```bash
pnpm index:openclaw:query -- --q "gateway authentication token storage"
```

Useful filters:

```bash
# docs only
pnpm index:openclaw:query -- --q "cron jobs webhook" --kinds doc --locale en

# code + runtime only
pnpm index:openclaw:query -- --q "openclaw.json gateway.bind" --kinds code,runtime

# scope to a source prefix
pnpm index:openclaw:query -- --q "model providers" --source-prefix docs/,src/

# runtime state (quote ~ so the shell does not expand it)
pnpm index:openclaw:query -- --q "gateway" --kinds runtime --source-prefix '~/.openclaw/openclaw.json'
```

JSON output for pipeline integration:

```bash
pnpm index:openclaw:query -- --q "memory search qmd" --json --limit 12
```

## One-command refresh + drift checks

```bash
pnpm index:openclaw:refresh
```

This rebuilds:

1. `.openclaw-index/documents.jsonl`
2. `.openclaw-index/retrieval.sqlite`
3. drift history under `.openclaw-index/history/`

and emits alerts when key coverage signals regress.

## Scheduled automation (macOS launchd)

Install hourly auto-refresh:

```bash
pnpm index:openclaw:install-launchd
```

Check status:

```bash
launchctl list | rg ai.openclaw.index-refresh
```

Uninstall:

```bash
pnpm index:openclaw:uninstall-launchd
```

Logs:

- `.openclaw-index/logs/latest.log`
- `.openclaw-index/logs/launchd.out.log`
- `.openclaw-index/logs/launchd.err.log`

## Why this is safer than naive crawling

- Uses both `llms.txt` and `sitemap.xml` as seed manifests.
- Performs link discovery from markdown to catch hidden live docs not listed in manifests.
- Tracks `hidden docs` as a hard drift signal.
- Redacts secrets in runtime/config artifacts before writing index chunks.
- Applies quality gates (`min docs/code/runtime`, max doc failure rate).

## Operational best practices

- Run on a schedule (hourly or daily) and diff `manifest.json`.
- Alert when:
  - docs count drops,
  - failure rate rises,
  - hidden-doc count changes abruptly,
  - runtime file count drops to zero.
- Keep strict mode on in CI (`--strict` default).
- Store index output on encrypted local storage if runtime data is included.
- Rebuild the index after OpenClaw upgrades, config changes, or doc structure changes.

## Brutal constraints

- Public docs are not a complete source of truth for runtime behavior.
- Manifest endpoints (`llms.txt`, `sitemap.xml`) can be stale/incomplete.
- Runtime secrets should never be indexed unredacted.
- "Bulletproof" means monitoring and guardrails, not one script run.

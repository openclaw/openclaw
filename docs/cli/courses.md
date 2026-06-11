---
summary: "CLI reference for `openclaw courses` (Course Creator artifact packages)"
read_when:
  - Creating or validating OpenClaw Course Creator artifacts
  - Working on topic-only course automation
title: "`openclaw courses`"
---

Create local Course Creator packages from a topic. This command is intentionally
artifact-only today: it writes the durable package skeleton and fails closed until
real research, fact-checking, Moodle staging, and rollback evidence exist.

## Usage

```bash
openclaw courses create "Beginner sourdough bread baking"
openclaw courses create "Tax planning for freelancers" --json
openclaw courses create "Home herb gardening" --output-root ./course-artifacts
openclaw courses create "Home herb gardening" --fixture-research --json
openclaw courses create "Home herb gardening" --fixture-research --mock-moodle-staging --json
openclaw courses create "Home herb gardening" --mock-search-crawl --mock-moodle-staging --json
openclaw courses create "Home herb gardening" --live-search-crawl --live-search-provider brave --json
openclaw courses create "Home herb gardening" --live-search-crawl --live-page-crawl --mock-moodle-staging --json
openclaw courses create "Home herb gardening" --research-pack ./research-pack.json --mock-moodle-staging --json
openclaw courses create "Home herb gardening" --research-pack ./research-pack.json --live-moodle-staging-report ./live-moodle-staging-report.json --json
openclaw courses create "Clinical ventilator certification" --fixture-research --mock-moodle-staging --approval-evidence ./approval-evidence.json --json
```

## Subcommands

### `create`

```bash
openclaw courses create <topic...> [--output-root <path>] [--fixture-research] [--mock-search-crawl] [--live-search-crawl] [--live-search-provider <id>] [--live-search-count <count>] [--live-page-crawl] [--live-page-max-chars <count>] [--research-pack <path>] [--mock-moodle-staging] [--live-moodle-staging-report <path>] [--approval-evidence <path>] [--json]
```

Creates a local package under `.openclaw/course-creator/<slug>` by default.
The package includes:

- `course.yaml`
- `sources/source-pack.json`
- `sources/snapshots/*.txt` when `--fixture-research`, `--mock-search-crawl`, `--live-search-crawl`, or `--research-pack` is enabled and accepted sources exist
- `sources/live-search-report.json` when `--live-search-crawl` is enabled
- `sources/live-crawl-report.json` when `--live-page-crawl` is enabled
- `curriculum.md`
- `modules/*.md` when semantic multi-module generation is enabled
- `lessons/lesson-01.md`
- `quizzes/quiz-01.json`
- `claim-map.json`
- `qa-report.json`
- `quality-policy-report.json`
- `content-generation-report.json`
- `publish-report.json`
- `publish/live-moodle-staging-report.json` when `--live-moodle-staging-report` is provided
- `approval-evidence.json` when `--approval-evidence` is provided
- `self-improvement-report.json`
- `next-build-gap.json`

The generated package is not a finished course. Low-risk topics are marked
`blocked` until source snapshots, fact-checking, QA, publish, and recovery gates
exist. High-risk topics such as clinical, legal, tax, investment, safety, or
certification content are marked `draft_only` and require explicit expert or
human approval evidence before any public publish path can pass.

`--fixture-research` writes deterministic local source snapshots with checksum
metadata and advances the source gate for contract testing. Fixture sources are
not live factual authority. In fixture mode the package also writes a verified
`claim-map.json` from deterministic lesson claims, which lets the source and fact
gates pass for local contract testing. Fixture mode also writes a scored
`qa-report.json` rubric so the local QA gate can pass without pretending the
fixture is publishable course content. Real course generation still needs a live
research adapter and source review before publish.

All source-backed modes write `quality-policy-report.json` after claim
verification. The report checks source credibility and diversity,
license/copyright safety, direct claim contradictions, accessibility/mobile
readiness, and assessment answer-key quality. Critical quality policy failures
block `qa-gate` and prevent staging evidence from passing.

`--research-pack <path>` reads a local JSON research pack containing credible
source records and source-backed claims, then snapshots those sources with
checksums into the course package. Each source must include `id`, `title`, `url`,
`publisher`, `tier`, `credibilityScore`, `license`, and `content`; each claim
must include `id`, `text`, and `sourceIds`. This mode is for configured source
replay and operator-approved source packs. It is not automated web search yet,
so topic-only production still needs a search/crawl adapter.

`--mock-search-crawl` generates deterministic source records from topic-only
input and snapshots them as if a search/crawl adapter had found them. This mode
proves the offline search/crawl contract, source gate, claim map, QA gate, mock
Moodle staging, smoke checks, and rollback reporting without requiring search
API credentials. It is not live web research or factual authority. Its next gap
is the live search provider and crawler adapter.

`--live-search-crawl` calls the configured OpenClaw `web_search` provider for
topic-only source candidates, snapshots accepted HTTP(S) result metadata, and
writes `sources/live-search-report.json`. Use `--live-search-provider <id>` to
pin a provider such as `brave`, `duckduckgo`, or `searxng`, and
`--live-search-count <count>` to bound accepted result count. If credentials,
network access, or provider configuration are missing, the command still writes
a blocked package with the exact required human actions instead of pretending
source discovery succeeded. Live search result snippets are not full page
content; the next gap after a passing live search run is guarded page fetching
and content extraction.

`--live-page-crawl` requires `--live-search-crawl`. It fetches accepted live
search result URLs through the guarded OpenClaw `web_fetch` path, extracts
readable text, snapshots extracted page content, and writes
`sources/live-crawl-report.json`. Use `--live-page-max-chars <count>` to bound
extracted page text per source. The adapter now extracts semantic factual
claims and evidence excerpts from crawled page text, then writes a multi-module
course outline, learner-facing lessons, guided practice, quiz explanations, and
`content-generation-report.json`. This still is not finished course generation:
after a passing live page crawl, the next gap is live Moodle staging
certification and rollback proof.

`--mock-moodle-staging` requires the source, fact, and QA gates to pass.
It writes deterministic hidden-course Moodle staging evidence, student-preview
smoke checks, and rollback/export proof into `publish-report.json` and a
`publish/` evidence artifact. This is contract proof only: `publicPublishAllowed`
stays `false`, and real Moodle credentials are still required before public
publishing.

`--live-moodle-staging-report <path>` reads a JSON report produced by a live
Moodle hidden-staging certification runner. The report must prove a hidden
course id and URL, passed publish events, passed student-preview smoke checks,
export and rollback evidence, and an all-present checklist. Invalid or partial
reports are rejected instead of being converted into publish evidence. Passing
reports can advance `publish-gate`, `smoke-gate`, and `recovery-gate` with
`adapter: "live"`, but `publicPublishAllowed` remains `false`; the next required
gap is explicit public canary approval and visibility-change policy.

`--approval-evidence <path>` reads approval JSON for gated high-risk work. A
high-risk course review approval must use `schemaVersion: 1`, scope
`high_risk_course_review`, decision `approved`, matching `topic`, reviewer
identity fields, `approvedAt`, optional `expiresAt`, evidence text, and
limitations. Accepted approval evidence can pass `risk-gate` for gated draft and
staging work, but it does not authorize public publishing.

JSON output includes `status`, `riskTier`, `gates`, `requiredHumanActions`, and
`nextBuildGap` so automation can resume from the first missing proof step. In
fixture research mode, the next gap moves to Moodle staging publish, smoke-test,
and rollback evidence. With mocked Moodle staging enabled, the next gap moves to
live research source snapshots. With `--research-pack` and mocked Moodle staging,
the next gap moves to automated search/crawl source discovery. With
`--mock-search-crawl` and mocked Moodle staging, the next gap moves to the live
search provider and crawler adapter. With `--live-search-crawl` and mocked
Moodle staging, the next gap moves to live page crawling/content extraction.
With `--live-search-crawl --live-page-crawl` and mocked Moodle staging, the next
gap moves to live Moodle staging certification.
With a passing `--live-moodle-staging-report`, the next gap moves to public
publish canary approval and rollback policy.

## Related

- [Automation overview](/automation)
- [Cron jobs](/automation/cron-jobs)
- [Background tasks](/automation/tasks)

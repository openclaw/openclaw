---
title: "Anthropic provider path - Release, Integration, and Live Scenario Proof Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Release, Integration, and Live Scenario Proof Maturity Note

## Summary

Anthropic has a meaningful release-proof footprint: package-acceptance tests
define live Anthropic gateway profiles, Docker live gateway smoke, CLI backend
model smoke, credential requirements, and setup commands; source also includes
env-gated live tests for direct transport, setup-token auth, and tool replay.
Coverage is Beta because the scenario lanes exist but are env-gated and spread
across scripts/tests. Quality is Beta because release proof is not yet packaged
as one operator-facing Anthropic scorecard with recurring pass artifacts.

## Category Scope

This category covers release and scenario proof for the Anthropic provider
path: package-acceptance workflow wiring, Docker and native live gateway
profiles, credential gates, live model lists, Claude CLI setup in workflow
scripts, live transport tests, live setup-token tests, live replay tests, and
contract tests that protect bundled provider behavior.

## Features

- Release: Covers Release across release and scenario proof for the Anthropic provider path: package-acceptance workflow wiring, Docker and native live gateway profiles, credential gates, live model lists, and related release, integration, and live scenario proof behavior.
- Integration: Covers Integration across release and scenario proof for the Anthropic provider path: package-acceptance workflow wiring, Docker and native live gateway profiles, credential gates, live model lists, and related release, integration, and live scenario proof behavior.
- Live Scenario Proof: Covers Live Scenario Proof across release and scenario proof for the Anthropic provider path: package-acceptance workflow wiring, Docker and native live gateway profiles, credential gates, live model lists, and related release, integration, and live scenario proof behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Package acceptance includes Anthropic live profile names, model env vars, credential gates, and Claude CLI install setup; env-gated live tests cover Anthropic transport abort, setup-token completion, and tool replay acceptance; contract tests cover provider runtime and plugin behavior.
- Negative signals: Live tests are gated by credentials/env and this audit did not find a current recurring pass artifact for every Anthropic scenario.
- Integration gaps: The scenario proof is distributed across package workflow tests, live tests, and contract tests rather than one consolidated Anthropic release scorecard.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: PR search results show active Anthropic/Claude CLI fixes across auth, streaming, catalog, cache, and runtime behavior, which indicates the release surface is being maintained but still moving.
- Discrawl reports: Discord archive results show real users exercising Anthropic API key, setup-token, Claude CLI, long-context, cache, and catalog paths, with support friction still present across those paths.
- Good qualities: The package-acceptance workflow names Anthropic suites explicitly, requires Anthropic credentials, installs Claude Code for CLI lanes, and has separate model/profile coverage for direct Anthropic and Claude CLI paths.
- Bad qualities: The live proof is mostly opt-in and scattered; operators cannot read one current Anthropic release artifact and know which auth/catalog/tool/context scenarios passed.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Release, Integration, Live Scenario Proof.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No consolidated, recurring Anthropic scenario report was found.
- Package acceptance verifies workflow text and expected lane wiring, but the
  actual live pass/fail evidence is outside this report.
- Source includes many env-gated live tests, so local default test runs do not
  prove Anthropic live readiness.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` is the user-facing provider runbook used by release proof.
- `/Users/kevinlin/code/openclaw/docs/gateway/cli-backends.md` documents the Claude CLI backend lane that package acceptance installs and configures.
- `/Users/kevinlin/code/openclaw/docs/gateway/troubleshooting.md` documents long-context 429 recovery that live release scenarios should continue to validate.

### Source

- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` verifies Anthropic live suite ids, model env vars, credential requirements, and Claude CLI install setup command.
- `/Users/kevinlin/code/openclaw/scripts/test-live-gateway-models-docker.sh` and `/Users/kevinlin/code/openclaw/scripts/test-live-models-docker.sh` are live model smoke entrypoints.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/provider-runtime.contract.test.ts` protects bundled provider runtime behavior.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/openclaw.plugin.json` supplies the provider, model, auth, media, and CLI backend metadata that release proof consumes.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.live.test.ts` env-gates a real HTTP stream abort smoke for Anthropic transport.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.anthropic-tool-replay.live.test.ts` env-gates live Anthropic replay acceptance.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic.setup-token.live.test.ts` env-gates live setup-token completion.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` covers `native-live-src-gateway-profiles-anthropic`, `live-gateway-anthropic-docker`, and Claude CLI backend model wiring.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/anthropic/provider-runtime.contract.test.ts` covers provider runtime contract behavior.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/index.test.ts` covers plugin registration, catalog, auth, model, and runtime defaults.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/stream-wrappers.test.ts` covers request-wrapper policy.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-transport-stream.test.ts` covers request and streaming transport shape.

### Gitcrawl queries

Query: `gitcrawl --json search prs -R openclaw/openclaw "claude-cli"`

Results:

- Returned active/recent maintenance PRs including #73122, #74990, #85505, #87702, #78815, #85316, #81021, #75483, #86568, #81048, #84550, #81851, #77148, and #86649.

Query: `gitcrawl --json search prs -R openclaw/openclaw "anthropic streaming"`

Results:

- Returned active/recent streaming and Anthropic-compatible fixes including #62112, #74432, #86649, #75136, #81851, #70372, #61151, #69491, and #86959.

Query: `gitcrawl --json search prs -R openclaw/openclaw "provider catalog anthropic"`

Results:

- Returned model/catalog maintenance PRs including #75157, #72404, #80394, #67579, and #78395.

### Discrawl queries

Query: `discrawl search --limit 10 "Anthropic usage status Claude API key"`

Results:

- Returned live user support traffic showing Anthropic API-key, Claude account, extra-usage, invalid-token, and model-status scenarios are actively exercised.

Query: `discrawl search --limit 10 "Claude CLI OpenClaw auth login claude-cli"`

Results:

- Returned live user support traffic for Claude CLI runtime registration, setup, and auth behavior.

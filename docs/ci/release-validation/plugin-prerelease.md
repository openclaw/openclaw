---
summary: "The separate Plugin Prerelease workflow, its batching limits, and when it runs"
read_when:
  - You are running or triaging Plugin Prerelease
title: "Plugin Prerelease"
sidebarTitle: "Plugin Prerelease"
---

The separate Plugin Prerelease workflow, its batching limits, and when it runs. Part of the [Release validation workflows](/ci/release-validation) index.

## Plugin Prerelease

Plugin batch execution preserves existing process limits when the only forwarded options are numeric `--retry` and exact-file `--exclude` selections. Codex retains at most 12 files per sequential process, including release runs with those options. Watch mode, suite-wide bail or sharding, reports, broad exclusion patterns, and other options retain their single-process semantics.

`Plugin Prerelease` is more expensive product/package coverage, so it is a separate workflow dispatched by `Full Release Validation` or by an explicit operator. Normal pull requests, `main` pushes, and standalone manual CI dispatches keep that suite off. It balances non-Telegram bundled plugin tests across eight generic extension workers; those jobs run up to two plugin config groups at a time with one Vitest worker per group and a larger Node heap. Telegram runs in dedicated shards of at most ten test files, preserving one-file Vitest processes while scheduling two processes concurrently. The combined extension matrix is capped at 12 concurrent jobs. The release-only Docker prerelease path (enabled by the `full_release_validation` input) batches targeted Docker lanes in groups of four to avoid reserving dozens of runners for one-to-three-minute jobs. The workflow also uploads an informational `plugin-inspector-advisory` artifact from `@openclaw/plugin-inspector`; inspector findings are triage input and do not change the blocking Plugin Prerelease gate.

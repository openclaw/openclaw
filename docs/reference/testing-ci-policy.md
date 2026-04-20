---
summary: "Source of truth for where end-to-end and live tests belong in CI"
read_when:
  - Deciding whether an end-to-end or live suite belongs in CI
  - Adding or moving Docker, release, or live-provider coverage
title: "Testing CI Policy"
---

# Testing CI Policy

This page is the source of truth for where OpenClaw end-to-end and live suites
belong.

Use this page to answer one practical question: when we have a real-world test,
where should it run?

Work through the questions in this order:

1. Do we need this test to protect users from a real regression?
2. If yes, where should it run: on PRs, before releases, on a schedule, or
   only by hand?
3. If it runs in CI, should it fail the lane or just report problems?

The mistake to avoid is simple: a test can be important enough to run in CI
without being important enough to block every PR or to sit inside the publish
workflow.

Example:

- A live provider test may be too slow, flaky, or expensive for normal PR CI.
- That does not make it a manual-only test.
- It usually means the test belongs in release CI or scheduled CI instead.

## CI lanes

- `PR CI`: runs on pull requests or push validation when the touched surface
  needs it. Use this for fast, high-signal checks that should catch regressions
  before merge.
- `Release CI`: runs before a release in a dedicated workflow lane. It may be
  blocking or non-blocking, but it is still required CI. Use this for important
  install, upgrade, compatibility, and provider checks that are too heavy for
  normal PR workflows.
- `Scheduled CI`: runs on a timer or on-demand to catch drift in providers,
  third-party integrations, or long-running compatibility paths. Use this when
  you want ongoing coverage but do not want every PR or release to wait on it.
- `Manual only`: keep for debug, hardware-specific, or operator-driven VM work.
  Do not put a suite here just because it is slower than a unit test.

## End-to-end and live matrix

| Suite                                                              | What it proves                                                                            | Expected CI lane                                                               | Blocking guidance                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `pnpm test`                                                        | Core unit, integration, and routed repo test coverage                                     | `PR CI`                                                                        | Blocking                                                           |
| `pnpm test:install:smoke`                                          | Install script smoke plus packed tarball size checks                                      | `PR CI` when relevant; `release CI` before tags                                | Blocking                                                           |
| `pnpm test:e2e`                                                    | Real gateway WS/HTTP/node pairing behavior                                                | `PR CI` when gateway or pairing changes                                        | Blocking when relevant                                             |
| `pnpm test:docker:onboard`                                         | Interactive onboarding wizard, config creation, gateway startup, health                   | `PR CI` when onboarding/setup changes; otherwise `release CI`                  | Blocking when relevant                                             |
| `pnpm test:docker:gateway-network`                                 | Two-container gateway auth and health path                                                | `PR CI` when gateway/network transport changes; otherwise `release CI`         | Blocking when relevant                                             |
| `pnpm test:docker:mcp-channels`                                    | Real `openclaw mcp serve` bridge, routing, transcripts, notifications                     | `PR CI` when MCP/channel bridge surfaces change; otherwise `release CI`        | Blocking when relevant                                             |
| `pnpm test:docker:plugins`                                         | Plugin install, `/plugin` alias behavior, restart semantics                               | `PR CI` when plugin runtime or install surfaces change; otherwise `release CI` | Blocking when relevant                                             |
| `pnpm test:docker:doctor-switch`                                   | Repair and daemon switching between git and npm installs                                  | `release CI`                                                                   | Blocking for release work that touches install or doctor flows     |
| `pnpm test:docker:qr`                                              | QR runtime compatibility under supported Docker Node versions                             | `release CI`                                                                   | Usually non-blocking, but still required CI                        |
| `pnpm test:install:e2e`                                            | Full installer path with real onboarding-style flow in Docker                             | `release CI`                                                                   | Required CI; may live outside the publish workflow                 |
| `OpenClaw Cross-OS Release Checks` workflow                        | Fresh install, packaged upgrade, installer fresh, dev update across macOS, Windows, Linux | `release CI`                                                                   | Required CI; keep separate from the publish workflow               |
| Native Discord roundtrip in cross-OS release checks                | Real Discord send/readback after install or update                                        | `release CI`                                                                   | Usually non-blocking, but still required CI when enabled           |
| `pnpm test:docker:openwebui`                                       | OpenClaw behind Open WebUI with a real proxied chat                                       | `release CI` and `scheduled CI`                                                | Non-blocking is fine; do not drop it from CI                       |
| `pnpm test:live`                                                   | Real provider/model behavior with live credentials                                        | `scheduled CI` and `release CI` when provider risk matters                     | Non-blocking is fine; do not make "not CI-stable" mean manual-only |
| `pnpm test:docker:live-models` and `pnpm test:docker:live-gateway` | Live provider coverage inside repo Docker images                                          | `scheduled CI` and `release CI` when provider/gateway risk matters             | Non-blocking is fine                                               |
| `pnpm test:docker:live-cli-backend`                                | Real CLI backend compatibility inside Docker                                              | `scheduled CI`                                                                 | Non-blocking is fine                                               |
| `pnpm test:docker:live-acp-bind`                                   | ACP bind compatibility against real agent backends                                        | `scheduled CI`                                                                 | Non-blocking is fine                                               |
| `pnpm test:docker:live-codex-harness`                              | Codex app-server harness compatibility                                                    | `scheduled CI`                                                                 | Non-blocking is fine                                               |
| `test:parallels:*`                                                 | VM-specific host/guest install and upgrade smoke                                          | `manual only` unless a dedicated VM CI lane exists                             | Manual/operator lane                                               |

## Change policy

When you add or move an end-to-end or live suite:

1. Update this matrix in the same PR.
2. Update the owning workflow or add the missing lane.
3. Update any release or maintainer docs that point to the suite.

If current workflows lag behind this matrix, treat that as follow-up work to
close rather than as permission to quietly downgrade the suite to manual-only.

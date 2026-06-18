# RausserHQ Upstream Baseline

## Baseline

- Upstream repository: `https://github.com/openclaw/openclaw`
- Fork repository: `https://github.com/RausserHQ/openclaw`
- Upstream tag: `v2026.6.6`
- Tag object SHA: `198a3eb58eb2d9854274892aafb8553eee89aa3c`
- Peeled commit SHA: `8c802aa683510c7f7503597b54c3021733245e59`
- Package and app version: `2026.6.6`
- Deployed upstream image digest currently used by homelab-platform: `ghcr.io/openclaw/openclaw@sha256:4826ca6157377e93463786d5c16852e34eede9f4bd4be55e3773cdc509762857`
- Baseline recorded: `2026-06-18`

## Verify Locally

From a clean checkout of `RausserHQ/openclaw`:

```sh
git remote add upstream https://github.com/openclaw/openclaw.git
git fetch upstream --tags
git cat-file -t v2026.6.6
git rev-parse v2026.6.6
git rev-parse v2026.6.6^{}
node -p "require('./package.json').version"
```

Expected results:

- `git cat-file -t v2026.6.6` prints `tag`, confirming the tag is annotated.
- `git rev-parse v2026.6.6` prints `198a3eb58eb2d9854274892aafb8553eee89aa3c`.
- `git rev-parse v2026.6.6^{}` prints `8c802aa683510c7f7503597b54c3021733245e59`.
- `node -p "require('./package.json').version"` prints `2026.6.6`.

## Slack Package Location

Slack integration source is part of the OpenClaw monorepo at `extensions/slack`.

At this baseline, `extensions/slack/package.json` declares package name `@openclaw/slack`, version `2026.6.6`, and repository URL `https://github.com/openclaw/openclaw`. The workspace includes `extensions/*`, so the Slack package is built from `extensions/slack` in the main OpenClaw monorepo.

No separate upstream `openclaw/slack` repository was found during fork bootstrap. A GitHub search for Slack repositories under the `openclaw` owner found `openclaw/slacrawl`, which is a separate Slack terminal app and not the `@openclaw/slack` package source. The main `RausserHQ/openclaw` fork owns future Slack source-level patches unless upstream changes this package ownership.

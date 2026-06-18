# RausserHQ Patchset Todo

## Future Planned Areas

This file tracks future source-level patch areas only. Do not implement these items on the bootstrap branch.

- Slack root and thread session invariant.
- Trusted internal top-level root delivery for cron, heartbeat, and system events.
- Slack API `response.ts` receipt persistence and exposure.
- No bare channel conversational sessions.
- DM and MPIM disabled for v1.
- Replace the homelab-services compiled overlay patch bundle.
- Replace the guarded Slack bundle if the source fork absorbs it.
- Future homelab-platform cutover plan.

## Slack Source Ownership

Slack integration source currently lives inside the OpenClaw monorepo at `extensions/slack`.

The package is published as `@openclaw/slack`, but `extensions/slack/package.json` points its repository back to `https://github.com/openclaw/openclaw`. The workspace builds packages under `extensions/*`, so future Slack source patches belong in the main `RausserHQ/openclaw` fork unless upstream splits the package into a separate repository later.

No separate upstream `openclaw/slack` package repository was identified during bootstrap. The similarly named `openclaw/slacrawl` repository is not the `@openclaw/slack` package source.

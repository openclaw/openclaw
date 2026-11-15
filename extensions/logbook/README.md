# @openclaw/logbook

An automatic work journal for OpenClaw. Logbook captures periodic screen
snapshots from a paired node, builds a timeline of your day, and produces
standup summaries and answers grounded in that timeline.

The standalone package requires OpenClaw 2026.9.5 or newer. Logbook is also
included in OpenClaw and disabled by default. Enable it only
after reviewing the capture and model setup in the
[Logbook guide](https://docs.openclaw.ai/plugins/logbook).

You need a connected screen-capture node, a compatible structured vision route,
and a working default agent model. The guide covers node permissions, model
authentication, configuration, and the Control UI timeline.

Enabling Logbook opts into screen capture unless `captureEnabled` is set to
`false`. Screenshots can contain sensitive information: sampled frames go to
the configured observation model, and derived activity text goes to the default
agent model. Storage remains on the Gateway. Frame retention defaults to
14 days; timeline cards and observations are retained.

Use `openclaw plugins inspect logbook --runtime --json` to inspect registration
and the dashboard status to check capture and analysis outcomes. Installation
alone does not establish node permissions or model authentication.

# OpenClaw Parallel Plugin

Official OpenClaw plugin for Parallel.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/parallel-plugin
openclaw gateway restart
```

See <https://docs.openclaw.ai/tools/parallel-search> for setup and configuration.

## Decisions

The plugin also registers the native decision-only model `parallel/decisions-fast`
for `decision_evaluate` contract version 2. It uses `PARALLEL_API_KEY` and the
web-grounded `/v1/decisions` endpoint, not chat completions. Supports boolean,
choice, and score questions over text/JSON state; preserves refusals and shared
citations. See the [Parallel guide](https://docs.openclaw.ai/tools/parallel-search#decisions)
for setup, supported inputs, and billing.

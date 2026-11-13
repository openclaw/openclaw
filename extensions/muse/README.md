# Muse Code agent runtime (OpenClaw plugin)

External OpenClaw plugin that registers a `muse` agent harness backed by
`@muse-code/sdk` and Meta's Muse Code CLI (`muse serve`).

## Install

```bash
openclaw plugins install @openclaw/muse
```

Install Muse Code separately and sign in once on the Gateway host with `muse`
or `muse login`.

The harness is opt-in only: set `agentRuntime.id: "muse"` on a `meta/*` model
or on the `meta` provider; `auto` never picks it.

See [Muse Code agent runtime](https://docs.openclaw.ai/plugins/muse) for auth,
approvals, sessions, limitations, and live tests.

Chat switches from preparation to waiting when Muse accepts the turn, then
streams assistant and tool activity through the Gateway. Once the answer is saved
and Muse starts its post-answer reminder work, the chat activity indicator stops.
The run remains active until Muse reports turn completion, so Stop and queued
messages keep their normal behavior during background finalization.
Native tool starts restore visible activity, including when they follow assistant
text. `finishing` settles an attempt rather than the logical run: newer retry,
fallback, or foreground activity restores the indicator, while older replayed
events cannot replace the newer state.

## Package

- Plugin id: `muse`
- Package: `@openclaw/muse`
- Minimum OpenClaw host: `2026.10.2`

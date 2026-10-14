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

## Package

- Plugin id: `muse`
- Package: `@openclaw/muse`
- Minimum OpenClaw host: `2026.10.2`

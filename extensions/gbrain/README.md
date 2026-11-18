# GBrain for OpenClaw

Connects OpenClaw to a [GBrain](https://github.com/garrytan/gbrain) brain. After
install, OpenClaw has a `gbrain` MCP server that chat turns, cron jobs, heartbeats
and subagents can use. You do not edit config by hand.

```sh
openclaw plugins install @openclaw/gbrain
```

Or select **Install** on the GBrain card in the Control UI.

On macOS and Linux, GBrain needs [Bun](https://bun.sh) 1.4.4 or newer. If GBrain is
missing and Bun is installed, the plugin installs GBrain with Bun, creates a local
brain when none exists, and starts GBrain's own supervised service
(`gbrain mcp expose`). Without Bun, the plugin shows the command that installs it.
In Docker, run GBrain as its own Compose service with `deploy/gbrain/compose.yaml`.

GBrain owns its install, brain, service and upgrades. The plugin never restarts the
service; it connects, replaces a revoked key, and reports problems as plugin health.
It leaves an `mcp.servers.gbrain` entry that points elsewhere, uses an environment
template, or comes from an `$include` as you configured it.

See the [GBrain plugin guide](https://docs.openclaw.ai/plugins/gbrain) for Docker,
status messages, recovery and uninstall.

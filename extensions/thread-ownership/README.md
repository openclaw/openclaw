# Thread Ownership (OpenClaw plugin)

Prevents multiple agents from responding in the same Slack thread. Uses HTTP calls to the slack-forwarder ownership API.

## Configuration

Configure via `openclaw.plugin.json`:

- `forwarderUrl` - Base URL of the slack-forwarder ownership API (default: `http://slack-forwarder:8750`)
- `abTestChannels` - Slack channel IDs where thread ownership is enforced

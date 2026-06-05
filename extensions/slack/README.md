# OpenClaw Slack

Official OpenClaw channel plugin for Slack channels, DMs, commands, and app events.

Install from OpenClaw:

```bash
openclaw plugin add @openclaw/slack
```

Configure the Slack app credentials and allowed workspaces/channels in OpenClaw. The plugin lets agents receive Slack events and reply through the configured Slack app.

To restrict inbound use to real members of the Slack workspace, enable `memberPolicy`:

```json
{
  "channels": {
    "slack": {
      "memberPolicy": {
        "enabled": true,
        "denyGuests": true,
        "denyExternal": true,
        "denyBots": true
      }
    }
  }
}
```

When enabled, Slack sender lookups fail closed. By default the policy also rejects deleted users and requires the user's `team_id` to match the workspace returned by `auth.test`.

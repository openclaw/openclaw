# Fly.io Deployment Config

This directory contains default configuration templates for Fly.io deployments.

## `fly.default.json`

Default OpenClaw configuration template for Fly.io deployments. Use it as a reference or copy it to `/data/.openclaw/openclaw.json` yourself (e.g. via a mounted volume, CI, or manually after first boot). The Fly Tailscale startup script does **not** copy this file automatically; you must ensure config exists at `$OPENCLAW_STATE_DIR/openclaw.json` (default `/data/.openclaw/openclaw.json`) before or after the first start.

### Customization

To customize the default config for your deployment:

1. **Edit `fly.default.json`** with your desired settings
2. **Provide config** at `/data/.openclaw/openclaw.json` (e.g. copy from this template, mount a volume, or create via SSH after first boot)
3. Rebuild and deploy if you changed the image; otherwise update config on the machine and restart

### Environment Variable Substitution

Loaded config supports environment variable substitution at read time:

- `${OPENCLAW_GATEWAY_TOKEN}` - Replaced with the value from Fly.io secrets (if set)

### Important Notes

- API keys and gateway token should be set as Fly.io secrets or in the config you provide
- After deploy, you can modify the config via SSH or `openclaw config set`

### Example: Adding Channels

To add Discord to the default config:

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist"
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ]
}
```

Remember: Channel tokens (like `DISCORD_BOT_TOKEN`) should be set as Fly.io secrets, not in the config file.

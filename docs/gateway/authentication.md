# Authentication

Clawdbot uses Claude Code's authentication system for API access. By default, OAuth tokens expire every ~24 hours, requiring frequent re-authentication. For a better experience, you can set up a long-lived token that lasts **1 year**.

## Long-Lived Token Setup (Recommended)

Instead of daily re-auth, set up a 1-year token:

```bash
claude setup-token
```

This command will:
1. Prompt you to visit the Anthropic console
2. Create or copy an API key
3. Store it for Claude Code (and Clawdbot)

After running `setup-token`, sync the credentials to Clawdbot:

```bash
clawdbot doctor --yes
```

## Checking Auth Status

To check your current authentication status:

```bash
# If you have the auth scripts installed
~/clawdbot/scripts/claude-auth-status.sh

# Or check manually
cat ~/.claude/.credentials.json | jq '.claudeAiOauth.expiresAt'
```

## How It Works

1. **Claude Code** stores credentials in `~/.claude/.credentials.json`
2. **Clawdbot** syncs from Claude Code to `~/.clawdbot/agents/main/agent/auth-profiles.json`
3. The `clawdbot doctor --yes` command triggers this sync automatically

## Token Types

| Type | Duration | Setup |
|------|----------|-------|
| OAuth (default) | ~24 hours | Automatic on first run |
| Long-lived token | 1 year | `claude setup-token` |

## Troubleshooting

### "No credentials found" error

Run the doctor to sync credentials:

```bash
clawdbot doctor --yes
```

Then restart the service:

```bash
systemctl --user restart clawdbot
```

### Token expired

If your token has expired, run `claude setup-token` again in a terminal (not from within Claude Code, as it requires an interactive TTY).

### Checking token expiry

```bash
# Check both Claude Code and Clawdbot auth
cat ~/.claude/.credentials.json | jq '.claudeAiOauth.expiresAt' | xargs -I{} date -d @$(({}/1000))
```

## Requirements

- Claude Max or Pro subscription (for `setup-token`)
- Claude Code CLI installed (`claude` command available)

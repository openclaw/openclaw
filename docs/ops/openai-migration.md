# Switch Jubal from OpenRouter to OpenAI Subscription

**Status: COMPLETED (2026-02-24)**

## What was done

Migrated Jubal from OpenRouter (per-API-call billing) to OpenAI Codex (ChatGPT Pro subscription, flat monthly fee).

| Before | After |
|---|---|
| Primary: `openrouter/anthropic/claude-sonnet-4-5` | Primary: `openai-codex/gpt-5.3-codex` |
| Fallback: `openrouter/anthropic/claude-opus-4-6` | Fallback: `openrouter/anthropic/claude-opus-4-6` (unchanged) |
| Billing: per API call via OpenRouter | Billing: ChatGPT Pro subscription ($200/mo flat) |

## Background
- Anthropic no longer allows using Claude subscriptions with OpenClaw
- OpenAI/Sam Altman confirmed ChatGPT subscriptions are OK to use with OpenClaw
- Works with $20/mo Plus or $200/mo Pro accounts

## What actually happened (for future reference)

### Problems encountered

1. **Security group outbound rules were restricted** — caused 20,000+ crash-loop restarts over several days. The gateway couldn't reach Telegram API on startup, causing an unhandled promise rejection crash. Fixed by setting outbound rules back to `All traffic → 0.0.0.0/0`.

2. **`clawdbot auth-choice openai-codex` doesn't exist** — the video transcript was garbled. The real command is:
   ```bash
   clawdbot onboard --auth-choice openai-codex
   ```

3. **`clawdbot models auth login --provider openai-codex` failed** — returned "No provider plugins found." The `onboard` command handles plugin setup; the direct `auth login` doesn't work without it.

4. **`setup-token` only supports Anthropic** — `clawdbot models auth setup-token --provider openai-codex` doesn't work.

5. **Headless VPS detected automatically** — the onboard wizard detected the remote/VPS environment and showed a URL + paste-back flow instead of trying to open a browser. No SSH tunnel was actually needed for the auth step.

6. **`gpt-5.3-codex` doesn't exist in clawdbot v2026.1.24-3** — the legacy `clawdbot` npm package doesn't have it. Fixed by upgrading to `openclaw` v2026.2.23 (`sudo npm i -g openclaw@latest`), which includes gpt-5.3-codex in the model registry.

7. **Onboard wizard tried to install Homebrew** — happens when you say "yes" to configuring skills. Not needed for the auth migration. Ctrl+C out of the wizard after OAuth completes.

### Exact steps that worked

```bash
# 1. SSH in (tunnel for OAuth callback — may not be needed but doesn't hurt)
ssh -i ~/Documents/JubalH.pem -L 1455:127.0.0.1:1455 ubuntu@34.194.157.97

# 2. Stop gateway
systemctl --user stop clawdbot-gateway

# 3. Run onboard with openai-codex auth choice
clawdbot onboard --auth-choice openai-codex
# Prompts: Yes (risk) → QuickStart → Use existing values
# → Opens URL for OpenAI OAuth → log in → authorize Codex → paste redirect URL back
# → Skip channel setup (Telegram already configured)
# → Skip skills setup (or Ctrl+C after OAuth completes to avoid Homebrew prompt)

# 4. Set the correct model (gpt-5.2-codex, NOT gpt-5.3-codex)
clawdbot models set openai-codex/gpt-5.2-codex

# 5. Verify — all models should show "configured" with Auth "yes", none "missing"
clawdbot models list

# 6. Start gateway
systemctl --user start clawdbot-gateway

# 7. Check logs (wait ~10 seconds for startup)
journalctl --user -u clawdbot-gateway --since '30 sec ago' --no-pager

# 8. Test — send Jubal a message on Telegram
```

## Re-authenticating (when token expires)

The OAuth token expires ~10 days after auth and should auto-refresh. If it stops working:

```bash
ssh -i ~/Documents/JubalH.pem -L 1455:127.0.0.1:1455 ubuntu@34.194.157.97
systemctl --user stop clawdbot-gateway
clawdbot onboard --auth-choice openai-codex
# Quick start → Use existing values → complete OAuth → Ctrl+C after auth
clawdbot models list   # verify auth shows "yes"
systemctl --user start clawdbot-gateway
```

## Upgrade to gpt-5.3-codex (2026-02-25)

The legacy `clawdbot` npm package (v2026.1.24-3) didn't have gpt-5.3-codex in its model registry. The fix was upgrading to the renamed `openclaw` package:

```bash
# Add swap first (t3.small OOMs without it)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile

# Install new package (openclaw, not clawdbot)
sudo npm i -g openclaw@latest

# Update systemd service to use new binary
# Change ExecStart from .../clawdbot/dist/entry.js to .../openclaw/dist/entry.js
# Then: systemctl --user daemon-reload

# Set model and verify
openclaw models set openai-codex/gpt-5.3-codex
openclaw models list   # should show configured, Auth yes, no "missing"
systemctl --user restart clawdbot-gateway
```

## Rollback to OpenRouter

If OpenAI Codex breaks and you need to go back:

```bash
openclaw models set openrouter/anthropic/claude-sonnet-4-5
systemctl --user restart clawdbot-gateway
journalctl --user -u clawdbot-gateway --since '1 min ago' --no-pager | grep -i error
```

OpenRouter auth is still configured in `auth-profiles.json`.

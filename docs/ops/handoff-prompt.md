# ClawdBot (Jubal) - Operations Handoff

## Instance Details
- **Name:** JubalHarshaw
- **Instance ID:** i-05b136393cddb3537
- **Public IP:** 34.194.157.97 (Elastic IP - stable across reboots)
- **Private IP:** 10.0.13.200
- **Region:** us-east-1 (N. Virginia)
- **Instance type:** t3.small (2 GiB RAM)
- **OS:** Ubuntu 24.04 LTS
- **Security Group:** jubal-wizard (sg-05cece2a690442f5b)

## SSH Access
```bash
ssh -i /Users/mikehill/Documents/JubalH.pem ubuntu@34.194.157.97
```
- Key file: `/Users/mikehill/Documents/JubalH.pem`
- User: `ubuntu`
- Security group currently allows SSH from:
  - `24.113.10.220/32` (home IP)
  - `95.173.217.198/32` (VPN - may need updating)
- **Outbound rules:** must be `All traffic → 0.0.0.0/0` (was accidentally restricted on 2026-02-22, caused 20k+ crash-loop restarts)

## Bot Architecture
- **Software:** OpenClaw v2026.2.23, installed globally via npm (`sudo npm i -g openclaw@latest`)
  - Legacy package `clawdbot` is outdated (v2026.1.24-3) — always use `openclaw` for updates
  - Binary is `openclaw` but `clawdbot` symlink may still exist (points to old version)
- **Gateway:** runs as systemd user service `clawdbot-gateway`
- **Channel:** Telegram (@Jubal_Harshaw_bot)
- **Workspace:** `/home/ubuntu/clawd/`
- **State dir:** `~/.openclaw/` (symlinked from `~/.clawdbot/`)
- **Config file:** `~/.openclaw/openclaw.json` (migrated from `~/.clawdbot/clawdbot.json`)
- **Auth profiles:** `~/.openclaw/agents/main/agent/auth-profiles.json`
- **Auth (pi-ai SDK):** `~/.openclaw/agents/main/agent/auth.json`
- **Log files:** `/tmp/clawdbot/clawdbot-YYYY-MM-DD.log`
- **Swap file:** 2GB at `/swapfile` (persistent, prevents OOM during npm installs on t3.small)

## Service Management
```bash
systemctl --user status clawdbot-gateway      # check status
systemctl --user restart clawdbot-gateway     # restart
systemctl --user stop clawdbot-gateway        # stop
journalctl --user -u clawdbot-gateway -f      # follow logs
journalctl --user -u clawdbot-gateway --since '10 min ago' --no-pager  # recent logs
```

## Current Model Config (as of 2026-02-25)
- **Primary:** `openai-codex/gpt-5.3-codex` (ChatGPT Pro subscription, flat monthly fee)
- **Fallback:** `openrouter/anthropic/claude-opus-4-6` (per-API-call, expensive — emergency fallback only)
- **Heartbeat:** every 30m on Codex
- **Cron:** morning check-in only at 8 AM Mountain
- **Subagents:** `openai-codex/gpt-5.2-codex` (4 concurrent)
- **Primary traffic routes through OpenAI Codex** (ChatGPT subscription via OAuth)
- **OpenRouter still configured as fallback** with existing API key

## Auth Details
- **OpenAI Codex:** OAuth token in `auth-profiles.json` (profile: `openai-codex:default`). Token auto-refreshes but expires ~10 days after auth. If Jubal goes down unexpectedly, re-run the auth flow (see openai-migration.md).
- **OpenRouter:** rotated 2026-02-24 (key stored in `auth-profiles.json` and `openclaw.json` on server)
- **OpenAI API key:** for embeddings/memory-lancedb plugin. Set as `OPENAI_API_KEY` env var in systemd service + `.bashrc`
- **Telegram bot token:** `8364471517:AAHokt2Dh7Ot90YvWebTdwV856RnmrnboWs`
- **Gateway auth token:** `f22fe8c926fd49d6c4825c756df6d419a12250dc9c97eaef882493eab1ccc438`

## Config Structure (openclaw.json)
The config has these critical sections:
- `agents.defaults.model.primary` - the main model ref (currently `openai-codex/gpt-5.3-codex`)
- `agents.defaults.model.fallbacks` - array of fallback model refs
- `agents.defaults.models` - allowlist of permitted models (keys must match model refs)
- `models.providers.openrouter` - provider definition with baseUrl, api type, and model definitions array
- `auth.profiles` - auth profile declarations (provider + mode)
- `auth.order` - auth profile routing per provider

**For built-in providers** (openai, openai-codex, anthropic): no `models.providers` entry needed — the model registry is built-in.

**For custom providers** (openrouter): must be added in THREE places:
1. `agents.defaults.model` (primary or fallbacks)
2. `agents.defaults.models` (allowlist)
3. `models.providers.<provider>.models` (definition with capabilities)

If any of these are missing, the model shows as `missing` in `openclaw models list` and the bot will crash.

## Verification Commands
```bash
openclaw models list          # verify models are configured (no "missing" tag)
openclaw models status        # detailed auth + model state
openclaw status               # overall health check
openclaw doctor               # deeper diagnostics
```

## Re-authenticating OpenAI Codex

If the OAuth token expires or breaks:

```bash
# SSH in with port tunnel for OAuth callback
ssh -i ~/Documents/JubalH.pem -L 1455:127.0.0.1:1455 ubuntu@34.194.157.97

# Stop gateway, re-auth, restart
systemctl --user stop clawdbot-gateway
openclaw onboard --auth-choice openai-codex
# → Quick start → Use existing values → authorize in browser → Ctrl+C after OAuth completes
openclaw models list   # verify auth shows "yes"
systemctl --user start clawdbot-gateway
```

The onboard wizard detects headless/VPS and shows a URL + paste-back flow (no tunnel actually needed for the paste-back method, but tunnel is there as backup).

## Google Suite Access (gogcli)
- **Tool:** `gog` (gogcli) v0.11.0 at `/usr/local/bin/gog`
- **Account:** `jubal@marketingresultslab.com`
- **Services:** Drive, Gmail, Calendar
- **GCP Project:** `jubal-488404`
- **OAuth credentials:** `/home/ubuntu/.config/gogcli/credentials.json`
- **Keyring password:** `GOG_KEYRING_PASSWORD=jubal` (set in systemd service + `.bashrc`)
- **Token store:** gogcli keyring (file-based, encrypted)

### Usage
```bash
GOG_KEYRING_PASSWORD=jubal gog drive ls -a jubal@marketingresultslab.com
GOG_KEYRING_PASSWORD=jubal gog gmail messages search -a jubal@marketingresultslab.com 'newer_than:1d'
GOG_KEYRING_PASSWORD=jubal gog calendar ls -a jubal@marketingresultslab.com
```

### Re-authenticating Google (if token expires)
```bash
# Step 1: Get auth URL
GOG_KEYRING_PASSWORD=jubal gog auth add jubal@marketingresultslab.com --remote --step 1 --services drive,gmail,calendar --force-consent

# Step 2: Open URL in browser, authorize, copy the redirect URL (will fail to load - that's OK)

# Step 3: Exchange code (can also curl the token endpoint and use `gog auth tokens import`)
GOG_KEYRING_PASSWORD=jubal gog auth add jubal@marketingresultslab.com --remote --step 2 --auth-url '<paste-redirect-url>'
```

## Pending TODO
1. ~~Rotate OpenRouter API key~~ (DONE 2026-02-24)
2. ~~Allocate Elastic IP~~ (DONE 2026-02-24 — 34.194.157.97)
3. ~~Set up SSM Session Manager~~ (DONE 2026-02-24 — IAM role `JubalSSMRole` attached, connect via EC2 → Connect → Session Manager)
4. ~~Install AWS CLI~~ (DONE 2026-02-24)
5. ~~Enable memory-lancedb plugin~~ (DONE 2026-02-25 — enabled with OpenAI embeddings, needs API credits on platform.openai.com)

## Known Issues / Lessons Learned
- See `/home/ubuntu/clawd/incident-log.md` on the instance for full incident history
- The bot (Jubal) has a tendency to mangle config when editing its own files - always verify with `openclaw models list` after changes
- OpenRouter is NOT a built-in provider - it needs explicit `models.providers` config unlike Anthropic/OpenAI/Codex
- `auth-profiles.json` (OpenClaw format) and `auth.json` (pi-ai SDK format) must both exist with matching credentials
- The heartbeat runs on a timer and makes API calls each time - an expensive model on a short interval burns money fast ($38/day on Opus with 30min heartbeat)
- **Security group outbound rules must allow all traffic** (`0.0.0.0/0`). Restricting outbound kills connectivity to Telegram/OpenRouter/OpenAI and causes a crash loop. Inbound should be locked down, outbound should be open.
- **`gpt-5.3-codex` requires openclaw v2026.2.6+** — the legacy `clawdbot` npm package (v2026.1.24-3) doesn't have it. Always use `sudo npm i -g openclaw@latest` for updates.
- **`openclaw models set <model>`** is the safest way to set the default model — it handles the allowlist automatically.
- **npm installs can OOM on t3.small** — a 2GB swap file at `/swapfile` was added to prevent this. Verify with `swapon --show`.
- When SSH is blocked (wrong IP, plane wifi, etc.), **EC2 Instance Connect** from the AWS Console is a backup terminal option.

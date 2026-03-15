# ClawdBot Memory

## User Preferences
- Documents folder does NOT sync to iCloud. Use `~/Library/Mobile Documents/com~apple~CloudDocs/` for files that need to reach iPhone.
- Mike gets tired/impatient with long multi-step processes — keep it moving.
- Mike is not a developer — avoid jargon like "npm", "publish". Just do the thing.

## VPC Deployment (updated 2026-02-26)
- Bot "Jubal" runs on AWS EC2 (us-east-1), instance `i-05b136393cddb3537` (JubalHarshaw)
- **Elastic IP:** 34.194.157.97 (stable across reboots)
- SSH: `ssh -i /Users/mikehill/Documents/JubalH.pem ubuntu@34.194.157.97`
- Security group: jubal-wizard (sg-05cece2a690442f5b) — SSH changed to 0.0.0.0/0 (was IP-locked, broke when on different network)
- **SSM Session Manager** enabled (IAM role `JubalSSMRole`) — backup access via AWS Console when SSH blocked
- Instance type: t3.small (2 GiB RAM) + 2GB swap at `/swapfile`
- **Second instance planned** — Mike will build another with a different team, using WhatsApp instead of Telegram. Setup guide on Drive.

## Software
- **Package:** `openclaw` (NOT `clawdbot` — legacy name, outdated on npm)
- **Version:** v2026.2.25 on npm, v2026.2.23 installed on Jubal (LOCKED — update requires passcode via `openclaw-update`)
- **Binary:** `openclaw` (old `clawdbot` binary may still exist, points to old version)
- **State dir:** `~/.openclaw/` (symlinked from `~/.clawdbot/`)
- **Config:** `~/.openclaw/openclaw.json`
- **Gateway:** systemd user service `clawdbot-gateway` (uses `/usr/lib/node_modules/openclaw/dist/entry.js`)
- **Not logged into npm locally** — `npm whoami` fails. Can't publish new versions from this machine. Workaround: tar + scp plugin files directly to server.

## Model Config
- **Primary:** `openai-codex/gpt-5.3-codex` (ChatGPT Pro subscription via OAuth)
- **Fallback:** `openrouter/anthropic/claude-opus-4-6` (per-API-call, emergency only)
- **Subagents:** 4 concurrent on `openai-codex/gpt-5.2-codex`
- **Heartbeat:** every 30m on Codex
- Use `openclaw models set <model>` to change — safest method

## Auth
- **OpenAI Codex:** OAuth in auth-profiles.json, expires ~10 days, auto-refreshes. Re-auth: `openclaw onboard --auth-choice openai-codex`
- **OpenRouter:** API key rotated 2026-02-24 (stored in auth-profiles.json + openclaw.json)
- **OpenAI API key:** for embeddings (memory-lancedb plugin). Set in systemd service + .bashrc as `OPENAI_API_KEY`

## Google Suite (gogcli)
- **Tool:** `gog` v0.11.0 at `/usr/local/bin/gog`
- **Account:** `jubal@marketingresultslab.com` (same Workspace as mmamt.com, under AI org unit)
- **Services:** Drive, Gmail, Calendar — all authenticated
- **Env var:** `GOG_KEYRING_PASSWORD=jubal` (in systemd + .bashrc)
- **Drive folder:** ID `1y8bRh5aGcooJAmqFY8fZqeckQZ9MQjKH` (name: "Jubal")
- **Mike's calendar ID:** `mike@mmamt.com`
- **Re-auth:** Use `gog auth add --remote --step 1/2` flow (random port callback — use step 1 URL + curl token exchange + `gog auth tokens import`)
- **Upload cmd:** `gog drive upload /path/to/file --parent=1y8bRh5aGcooJAmqFY8fZqeckQZ9MQjKH`

## Plugins
- **memory-lancedb:** enabled (semantic memory search via OpenAI embeddings, text-embedding-3-small). Needs API credits on platform.openai.com (separate from ChatGPT Pro sub). $10 loaded 2026-02-25.
- **youtube:** enabled 2026-02-26. Downloads/transcribes YouTube videos via yt-dlp + whisper-cpp. Tools: `youtube_download`, `youtube_transcribe`. Slash command: `/yt`. Config in `plugins.entries.youtube`. Tools allowlisted via `tools.alsoAllow`.

## YouTube Plugin (added 2026-02-26)
- **Code:** `extensions/youtube/` (local) + manually deployed to `/usr/lib/node_modules/openclaw/extensions/youtube/` on server
- **Dependencies on server:** `yt-dlp` (2026.02.21 via pip), `deno` (2.7.1, symlinked to /usr/local/bin)
- **Key fix:** yt-dlp needs `--remote-components ejs:github` for YouTube JS challenge solving. Without it, downloads silently fail.
- **Deploy method:** `tar czf /tmp/yt.tar.gz -C extensions youtube && cat /tmp/yt.tar.gz | ssh ... "sudo tar xzf - -C /usr/lib/node_modules/openclaw/extensions/"` then restart gateway
- **Config key for optional tools:** `tools.alsoAllow` (top-level), NOT `agents.defaults.tools` (invalid key, crashes gateway)
- **Plugin not yet in npm package** — must be manually deployed until next openclaw release

## TTS (Text-to-Speech)
- **Provider:** Edge TTS (free, no API key, built into openclaw via `node-edge-tts`)
- **Voice:** `en-US-EricNeural` (male, calm, natural)
- **Mode:** `auto: "inbound"` — replies with voice only when user sends voice note; text always included alongside
- Config lives in `openclaw.json` under `messages.tts`

## Whisper-cpp (Audio Transcription)
- Binary: `/usr/local/bin/whisper-cli` (rebuilt 2026-02-25 with shared libs)
- Shared libs: `libwhisper.so.1`, `libggml.so.0` in `/usr/local/lib`
- Model: `~/.local/share/whisper-cpp/ggml-base.en.bin`
- Wrapper: `~/.local/bin/whisper-transcribe` (handles ogg→wav conversion)

## WhatsApp Channel (reference for new instances)
- Uses Baileys (WhatsApp Web protocol) — NOT official Business API
- No API keys needed, just a phone number + QR code scan
- Auth stored at `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- Setup: `openclaw channels login --channel whatsapp` (displays QR in terminal)
- Config under `channels.whatsapp` (dmPolicy, groupPolicy, allowFrom in E.164 format)

## Update Lock (added 2026-02-28)
- **openclaw is locked** on the server via `chattr +i` on `/usr/lib/node_modules/openclaw/` and `package.json`
- Direct `npm install -g openclaw` is blocked — even with sudo
- **Update script:** `sudo openclaw-update <passcode> [version]` at `/usr/local/bin/openclaw-update`
- Passcode hash (SHA256) stored in the script — passcode is `Ang3lB@by`
- Script handles: recursive immutable flag removal, npm install, stale temp cleanup, YouTube plugin restore from backup, re-lock
- YouTube plugin backup at `~/.openclaw/yt-backup.tar.gz` (auto-restored if wiped during update)
- v2026.2.26 is controversial — hardened command approvals, config gets overwritten on update, community backlash

## ClickCampaigns (added 2026-03-01)
- **Source:** `/Users/mikehill/Documents/Claude Code/ClickCampaigns-for-Claude-Code-in-Cursor/`
- **Deployed to server:** `~/clawd/skills/click-campaigns/` (skill files, agents, templates, scripts)
- **SKILL.md** at root makes it a registered openclaw skill — Jubal sees it in his active skills list
- **Key files Jubal must read:** SKILL.md → CLAUDE.md → frontend-design/SKILL.md → relevant funnel/task skill
- **22 specialist personas** (Alex=Campaign Manager, Ryan=Copywriter, Cassidy=Designer, etc.)
- **Production specs:** `skills-and-instructions/skills/production/frontend-design/SKILL.md` — anti-AI-slop design rules
- **Competitive intel skill:** `skills-and-instructions/skills/tasks/competitive-intel/SKILL.md` — URL analysis, style swipe, copy improvement
- **npm deps installed** on server (pexels, @google/genai, dotenv) for image helper scripts
- **AGENTS.md rules** tell Jubal to always delegate campaign work to subagents via `sessions_spawn`

## Campaign Preview Server (added 2026-02-28)
- **Service:** `campaign-server.service` (systemd user service, enabled, starts on boot)
- **Script:** `~/clawd/scripts/serve-campaigns.js` (Node.js static file server)
- **Port:** 8088, bound to 0.0.0.0
- **Root:** `~/clawd/campaigns/` — anything saved here is browsable
- **URL:** `http://34.194.157.97:8088/<campaign-name>/page.html`
- **Security group:** port 8088 open to 0.0.0.0/0
- Jubal builds pages → saves to campaigns folder → sends clickable preview link via Telegram

## Subagent Delegation Rules (added 2026-02-28)
- **YouTube:** AGENTS.md rule tells Jubal to always `sessions_spawn` for youtube_download/youtube_transcribe
- **ClickCampaigns:** AGENTS.md rule tells Jubal to always `sessions_spawn` for campaign work, with explicit file read instructions
- **Competitive Intel:** AGENTS.md rule tells Jubal to use browser tools (navigate, screenshot, snapshot) + web_fetch when user shares a URL
- Subagents auto-announce results — main agent doesn't poll

## Per-User Sessions & Multi-User Setup (added 2026-03-02)

When multiple people DM the bot, you MUST set up per-peer sessions. Without this, everyone shares one session and the bot confuses identities.

### Config (openclaw.json)
```json
"session": {
  "dmScope": "per-peer",
  "identityLinks": {
    "mike": ["telegram:1998384683"],
    "alexis": ["telegram:8751060398"],
    "yan": ["telegram:8522892616"],
    "nicole": ["telegram:5481086628"]
  }
}
```
- `dmScope: "per-peer"` — each DM gets its own isolated session (e.g., `agent:main:direct:mike`)
- `identityLinks` — maps canonical names to platform IDs; makes session keys human-readable and enables cross-channel identity (Telegram + WhatsApp same person = same session)

### Telegram Channel Config
- `dmPolicy: "allowlist"` — only recognized users can DM (not `"pairing"`)
- `allowFrom: [id1, id2, ...]` — DM allowlist (numeric Telegram user IDs)
- `groupAllowFrom: [id1, id2, ...]` — **MUST include ALL users who should trigger replies in group chats**, not just the owner. If someone is missing from this list, the bot silently ignores their group messages.
- Per-group `allowFrom: ["*"]` overrides `groupAllowFrom` for that specific group

### AGENTS.md — Identity-Aware Startup
The "Every Session" rules must be identity-aware. Without this, the bot loads Mike's private context (USER.md, MEMORY.md, daily notes) for everyone:
- **Owner session:** reads USER.md, MEMORY.md, daily notes, their task file
- **Work assistant session:** reads daily notes + their task file (NOT USER.md/MEMORY.md)
- **Family/others:** reads ONLY SOUL.md + their task file

### Per-User Task Files
Create `memory/tasks-<name>.md` for each user. AGENTS.md tells the bot to read the sender's task file at session start and write tasks there when assigned.

### memory-lancedb autoCapture Contamination (CRITICAL)
The `autoCapture` feature stores conversation memories in a global LanceDB vector store. These memories are NOT scoped per-session — they're shared across ALL sessions via `autoRecall`. If the bot captures "User identifies as Yan" from a shared session, it will inject that into everyone's conversations.
- **On new instance setup:** enable per-peer sessions BEFORE anyone starts chatting. If you enable it after, you'll need to clean the LanceDB.
- **To clean:** Use Python with `lancedb` package to connect to `~/.openclaw/memory/lancedb`, open the `memories` table, find contaminated rows, and delete them by ID.
- **To inspect:** `table.to_arrow()` → check `text` column for identity-confusing entries
- **Prevention:** Enable `dmScope: "per-peer"` from day one so autoCapture stores memories in the correct session context.

### New Instance Checklist (multi-user)
1. Set `session.dmScope: "per-peer"` and `session.identityLinks` in openclaw.json
2. Set `dmPolicy: "allowlist"` + `allowFrom` with all user IDs
3. Set `groupAllowFrom` with all user IDs (not just owner!)
4. Update AGENTS.md with identity-aware "Every Session" rules
5. Create per-user task files in `memory/`
6. Update task-ops skill for per-user task tracking
7. Restart gateway

## Key Lessons
- Security group outbound must be `All traffic → 0.0.0.0/0` — restricting breaks everything
- `openclaw models list` after ANY config change — if model shows `missing`, don't restart
- npm installs can OOM on t3.small — swap file prevents this
- `gpt-5.3-codex` requires openclaw v2026.2.6+ (legacy `clawdbot` package doesn't have it)
- Jubal mangles his own config — always verify after he edits
- yt-dlp breaks without `--remote-components ejs:github` — YouTube requires JS challenge solving
- `tools.alsoAllow` is the correct config key for enabling optional plugin tools. `agents.defaults.tools` is invalid and crashes the gateway.
- **`groupAllowFrom` must include everyone** — not just the owner. Missing users get silently dropped in groups (no error, no log).
- **memory-lancedb autoCapture is global** — memories from one user's session leak into all sessions via autoRecall. Enable per-peer sessions BEFORE first use or clean the LanceDB after.

## Ops Docs & Shared Files
- [handoff-prompt.md](../../docs/ops/handoff-prompt.md) — main ops reference
- [openai-migration.md](../../docs/ops/openai-migration.md) — migration from OpenRouter to Codex
- [incident-log.md](../../docs/ops/incident-log.md) — past incidents and pre-flight checklist
- [build-checklist.md](build-checklist.md) — full new-instance build checklist
- **Google Drive** (Jubal folder):
  - [Setup Guide](https://drive.google.com/file/d/1Yqp3LTBxI9KG56zIcmCJ-TbwoUl2UBEh) — full new-instance setup for external teams
  - [YouTube Plugin tar.gz](https://drive.google.com/file/d/1gM6vDGMkF9p1m7OADvqN_Oei5mKvQfkK) — deploy to extensions/youtube/

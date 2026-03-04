# New Instance Build Checklist

Reference for rebuilding Jubal or spinning up a new bot instance.
Everything below was validated on the current Jubal (t3.small, Ubuntu 24.04).

---

## 1. Base System
- Instance type: t3.small (2 GiB RAM minimum)
- Create 2GB swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` (add to /etc/fstab)
- Install: `build-essential cmake git ffmpeg google-chrome-stable espeak-ng mbrola mbrola-us2 mbrola-us3`

## 2. Node.js
- Install via nvm or fnm (v22.x LTS)
- `sudo npm i -g openclaw@latest`

## 3. Whisper-cpp (audio transcription)
- Clone: `git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git`
- Build with shared libs:
  ```bash
  cmake -B build -DBUILD_SHARED_LIBS=ON -DCMAKE_INSTALL_PREFIX=/usr/local
  cmake --build build -j2
  sudo cmake --install build
  sudo ldconfig
  ```
- Download model: `mkdir -p ~/.local/share/whisper-cpp && wget -O ~/.local/share/whisper-cpp/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`
- Create wrapper script at `~/.local/bin/whisper-transcribe`:
  ```bash
  #!/bin/bash
  INPUT="$1"
  TMPWAV="/tmp/whisper-$$.wav"
  ffmpeg -y -i "$INPUT" -ar 16000 -ac 1 "$TMPWAV" 2>/dev/null
  whisper-cli -m ~/.local/share/whisper-cpp/ggml-base.en.bin "$TMPWAV" 2>/dev/null | grep -E "^\[" | sed 's/\[[^]]*\] *//'
  rm -f "$TMPWAV"
  ```
- `chmod +x ~/.local/bin/whisper-transcribe`
- **Key lesson:** Must install with `BUILD_SHARED_LIBS=ON` and run `sudo ldconfig` — without this, whisper-cli fails with `libwhisper.so.1: cannot open shared object file`

## 4. TTS (text-to-speech)
- Built into openclaw via `node-edge-tts` (free, no API key)
- Config in `openclaw.json` under `messages.tts`:
  ```json
  {
    "messages": {
      "tts": {
        "auto": "inbound",
        "provider": "edge",
        "edge": {
          "enabled": true,
          "voice": "en-US-EricNeural",
          "lang": "en-US"
        }
      }
    }
  }
  ```
- `auto: "inbound"` = reply with voice only when user sends voice note; text always included
- Voice choice: **en-US-EricNeural** (male, calm, natural)
- Other good voices tested: en-US-GuyNeural, en-US-ChristopherNeural, en-US-RogerNeural, en-US-SteffanNeural
- Female options: en-US-JennyNeural, en-US-AriaNeural, en-US-AvaNeural

## 5. yt-dlp + Deno (YouTube support)
- Remove old apt version: `sudo apt remove -y yt-dlp 2>/dev/null`
- Install latest via pip: `sudo pip3 install --break-system-packages yt-dlp`
- Install deno (JS runtime for yt-dlp challenge solver):
  ```bash
  curl -fsSL https://deno.land/install.sh | sh
  sudo ln -sf ~/.deno/bin/deno /usr/local/bin/deno
  ```
- Verify: `yt-dlp --version` (2026.x), `deno --version` (2.x)
- **Key lesson:** yt-dlp needs `--remote-components ejs:github` for YouTube (JS challenge solving). Without it, silently fails.

## 6. Audio Config in openclaw.json
```json
{
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": [
          {
            "capabilities": ["audio"],
            "type": "cli",
            "command": "/home/ubuntu/.local/bin/whisper-transcribe",
            "args": ["{{MediaPath}}"]
          }
        ]
      }
    }
  }
}
```

## 7. memory-lancedb Plugin
- Semantic memory via OpenAI embeddings (`text-embedding-3-small`)
- Needs `OPENAI_API_KEY` set in systemd service env AND .bashrc
- Needs prepaid credits on platform.openai.com (separate from ChatGPT Pro)
- Config:
  ```json
  {
    "plugins": {
      "entries": {
        "memory-lancedb": {
          "enabled": true,
          "config": {
            "embedding": {
              "apiKey": "${OPENAI_API_KEY}",
              "model": "text-embedding-3-small"
            },
            "autoCapture": true,
            "autoRecall": true
          }
        }
      },
      "slots": {
        "memory": "memory-lancedb"
      }
    }
  }
  ```
- **Key lesson:** If credits run out, disable the plugin (`enabled: false`) to stop 429 log spam, then re-enable after topping up

## 8. YouTube Plugin
- Source: `extensions/youtube/` in ClawdBot repo
- Deploy to server (no npm publish needed):
  ```bash
  tar czf - -C extensions youtube | ssh -i ~/Documents/JubalH.pem ubuntu@34.194.157.97 \
    'sudo rm -rf /usr/lib/node_modules/openclaw/extensions/youtube && sudo mkdir -p /usr/lib/node_modules/openclaw/extensions && cd /usr/lib/node_modules/openclaw/extensions && sudo tar xzf -'
  ```
- Enable in `openclaw.json`:
  ```json
  {
    "plugins": {
      "entries": {
        "youtube": {
          "enabled": true,
          "config": {
            "outputDir": "~/.openclaw/youtube/",
            "maxDurationMinutes": 60,
            "whisperModelPath": "~/.local/share/whisper-cpp/ggml-base.en.bin",
            "whisperBin": "/usr/local/bin/whisper-cli",
            "whisperThreads": 2,
            "cleanupTempAudio": true
          }
        }
      }
    },
    "tools": {
      "alsoAllow": ["youtube_download", "youtube_transcribe"]
    }
  }
  ```
- **Key lesson:** Tools go in `tools.alsoAllow` (top-level). `agents.defaults.tools` is INVALID and crashes the gateway.
- Also available on Google Drive (Jubal folder) as `youtube-plugin.tar.gz`

## 9. Systemd Service Environment
Key env vars needed in the gateway service:
- `OPENAI_API_KEY` — for embeddings
- `GOG_KEYRING_PASSWORD` — for Google Suite (gogcli)
- `WHISPER_CPP_MODEL` — path to whisper model file
- `CLAWDBOT_GATEWAY_PORT`, `CLAWDBOT_GATEWAY_TOKEN`

## 10. Health Check (auto-monitoring)
- Source files in `ops/healthcheck/` in the ClawdBot repo
- Install:
  ```bash
  cp openclaw-healthcheck ~/.local/bin/ && chmod +x ~/.local/bin/openclaw-healthcheck
  cp openclaw-healthcheck.service ~/.config/systemd/user/
  cp openclaw-healthcheck.timer ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable openclaw-healthcheck.timer
  systemctl --user start openclaw-healthcheck.timer
  ```
- Runs every 3 minutes. Auto-restarts gateway, reinstalls missing modules, emails on critical issues.
- **Edit the script** to set the correct notification email and sender account.
- Requires `gog` with Gmail access for email notifications.

## 11. Multi-User Setup (Per-Peer Sessions)

If multiple people will DM the bot, do this BEFORE anyone starts chatting. Retroactive setup requires cleaning the LanceDB.

### a) Enable per-peer sessions in openclaw.json
```json
{
  "session": {
    "dmScope": "per-peer",
    "identityLinks": {
      "mike": ["telegram:1998384683"],
      "alexis": ["telegram:8751060398"]
    }
  }
}
```
- `dmScope: "per-peer"` isolates each DM into its own session (e.g., `agent:main:direct:mike`)
- `identityLinks` maps canonical names to platform-prefixed IDs — makes session keys human-readable and links the same person across channels (e.g., Telegram + WhatsApp)

### b) Set DM and group allowlists
```json
{
  "channels": {
    "telegram": {
      "dmPolicy": "allowlist",
      "allowFrom": [1998384683, 8751060398],
      "groupAllowFrom": [1998384683, 8751060398],
      "groupPolicy": "allowlist"
    }
  }
}
```
- **`allowFrom`** — who can DM the bot
- **`groupAllowFrom`** — who the bot responds to in group chats. **MUST include ALL users, not just the owner.** Missing users get silently ignored in groups (no error, no log).
- Per-group `allowFrom: ["*"]` overrides `groupAllowFrom` for that specific group

### c) Identity-aware AGENTS.md startup rules
The "Every Session" section must route context loading by sender identity:
- **Owner:** reads USER.md, MEMORY.md, daily notes (`memory/YYYY-MM-DD.md`), their task file
- **Work assistant:** reads daily notes + their task file (NOT USER.md or MEMORY.md — private)
- **Family/others:** reads ONLY SOUL.md + their task file — clean context, no work bleed

Without this, the bot loads the owner's full private context for every user and gets confused about who it's talking to.

### d) Create per-user task files
Create `memory/tasks-<name>.md` for each user:
```markdown
# Tasks — Mike

## Active
<!-- Add tasks here as they come up -->

## Completed
<!-- Move finished tasks here with date -->
```
Add rules to AGENTS.md telling the bot to read the sender's task file at session start and write tasks there when assigned.

### e) Update task-ops skill
Update `skills/task-ops/SKILL.md` to handle per-user task lifecycle: create from trigger phrases ("remind me to...", "add to my list..."), track at session start, complete with dates, archive old items.

### f) memory-lancedb autoCapture warning
The `autoCapture`/`autoRecall` features store and inject conversation memories from a **global** LanceDB store — NOT scoped per-session. If users share a session before per-peer is enabled, the bot captures things like "User identifies as [wrong name]" and injects it into everyone's future conversations.
- **Prevention:** Enable `dmScope: "per-peer"` before first use
- **Cleanup:** `pip3 install --user --break-system-packages lancedb`, then:
  ```python
  import lancedb
  db = lancedb.connect("~/.openclaw/memory/lancedb")
  table = db.open_table("memories")
  arrow = table.to_arrow()
  # inspect: arrow.column("text").to_pylist()
  # delete bad rows: table.delete("id = '<id>'")
  ```
- Also delete the old shared session from `~/.openclaw/agents/main/sessions/sessions.json` (key: `agent:main:main`) and back up its transcript file

## 12. Multiple Instances on Same VPC
- You can run multiple OpenClaw bots on the same VPC:
  - **Same EC2 instance:** Use different systemd service names, config dirs, gateway ports, and WhatsApp sessions. Cheaper but shared CPU/RAM.
  - **Separate EC2 instance:** New instance in the same subnet. Fully isolated. Recommended for production.
- Each instance needs its own: WhatsApp phone number, openclaw.json, gateway port, workspace dir.
- They can share the same VPC, subnet, and security group.

## 13. Post-Install Verification
- [ ] `whisper-cli --help` runs without library errors
- [ ] `ldd /usr/local/bin/whisper-cli` — no "not found" entries
- [ ] `/home/ubuntu/.local/bin/whisper-transcribe /tmp/test.ogg` produces text
- [ ] `yt-dlp --version` — 2026.x
- [ ] `deno --version` — 2.x
- [ ] `yt-dlp --remote-components ejs:github --dump-json "https://youtube.com/watch?v=dQw4w9WgXcQ"` — returns JSON
- [ ] `openclaw plugins list` — youtube shows as loaded
- [ ] Gateway starts clean: `systemctl --user status clawdbot-gateway`
- [ ] No errors in logs: `journalctl --user -u clawdbot-gateway --since '1 min ago' | grep -i error`
- [ ] Send voice note — get text + voice reply back
- [ ] `/yt https://youtube.com/watch?v=dQw4w9WgXcQ` — returns video info
- [ ] Send "transcribe this: <youtube-url>" — LLM invokes youtube_transcribe tool
- [ ] **Multi-user:** DM from two different accounts — sessions.json shows separate keys (e.g., `agent:main:direct:mike`, `agent:main:direct:alexis`), NOT `agent:main:main` for both
- [ ] **Multi-user:** Ask "who am I?" from each account — bot identifies the correct person
- [ ] **Multi-user:** Verify non-owner can trigger replies in group chats (check `groupAllowFrom`)

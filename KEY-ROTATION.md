# Key Rotation Checklist (OpenClaw)

This checklist helps you rotate all credentials currently embedded in `~/.openclaw/openclaw.json` and move them to environment variables. It also explains the sanitization script.

---

## 1) Run the sanitization script

This script:

- Creates a timestamped backup of `~/.openclaw/openclaw.json`
- Replaces inline secrets with `${ENV_VAR}` placeholders
- Leaves the file readable while removing actual secret values

**Usage:**

```bash
scripts/sanitize-openclaw-config.sh
```

**Optional custom path:**

```bash
scripts/sanitize-openclaw-config.sh /path/to/openclaw.json
```

---

## 2) Set environment variables (before restart)

Set these in the environment used by the OpenClaw gateway (launchd/systemd shell env).

**Core model providers**

- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `GEMINI_API_KEY`
- `XAI_API_KEY`
- `ZAI_API_KEY`

**Voice-call (Twilio)**

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`

**Slack**

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

**Gateway auth**

- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_GATEWAY_PASSWORD`

**Web search**

- `WEB_SEARCH_API_KEY`

**Per-skill keys (if used)**
The script replaces `skills.entries.<id>.apiKey` with `${<ID>_API_KEY}`.  
Example:

- `openai-image-gen` → `OPENAI_IMAGE_GEN_API_KEY`
- `openai-whisper-api` → `OPENAI_WHISPER_API_KEY`
- `nano-banana-pro` → `NANO_BANANA_PRO_API_KEY`
- `goplaces` → `GOPLACES_API_KEY`
- `local-places` → `LOCAL_PLACES_API_KEY`
- `image-imagine` → `IMAGE_IMAGINE_API_KEY`
- `video-gen` → `VIDEO_GEN_API_KEY`

---

## 3) Rotate each credential at the provider

### OpenAI / ElevenLabs / Gemini / xAI / ZAI

1. Create new API keys in each provider console.
2. Update env vars.
3. Revoke the old keys.

### Twilio

1. Rotate Auth Token in Twilio Console.
2. Update `TWILIO_AUTH_TOKEN`.
3. Validate inbound webhook signature checks still pass.

### Slack

1. Rotate `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
2. Reinstall the Slack app if required.
3. Update env vars and restart the gateway.

### Web search

1. Rotate provider key.
2. Update `WEB_SEARCH_API_KEY`.

---

## 4) Restart and verify

Restart OpenClaw gateway after updating env vars.  
Verify:

- Gateway is reachable
- Slack/WhatsApp/voice-call receive events
- No “missing API key” warnings in logs

---

## 5) Clean up

After confirming everything works:

- Remove any old backups you no longer need
- Keep keys only in your secrets manager or env provider

---

## macOS Launchd: where to put the env file and how it loads

On macOS, the gateway runs under launchd and **does not inherit your shell env**.  
OpenClaw loads env vars from:

- the parent process (launchd/systemd)
- `.env` in the current working directory
- **global fallback:** `~/.openclaw/.env`

**Recommended location:** `~/.openclaw/.env`  
This is the safest place to ensure **all agents/subagents** (even in other workspaces) can access keys, because they inherit the gateway process env + the global `.env` fallback.

**Setup:**

```bash
cp openclaw.env.example ~/.openclaw/.env
$EDITOR ~/.openclaw/.env
openclaw gateway restart
```

**Notes:**

- `~/.openclaw/.env` never overrides existing env vars, it only fills missing keys.
- If you already use `launchctl setenv ...`, those values will take precedence.

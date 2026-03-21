# Sophia — Module 2 Setup: Emotional Intelligence + Tools

These are the manual steps required after the Module 2 files have been deployed.
Complete them in order. None of these can be automated.

---

## Step 1 — Get a Brave Search API key

Go to https://brave.com/search/api/ and create a free account.

Once you have your key, add it to Sophia's config. Open `~/.openclaw/openclaw.json`
and find the `tools.web.search` section, then uncomment and fill in:

```json
"apiKey": "your-brave-api-key-here"
```

Or export it in your shell environment:

```bash
export BRAVE_API_KEY=your-key-here
```

Verify search works:

```bash
openclaw agent --message "Search the web for the latest news about Anthropic"
```

---

## Step 2 — Authorize Gmail

Run the onboarding wizard and select Gmail when prompted:

```bash
openclaw onboard
```

Or authorize directly via the Control UI:

```
http://127.0.0.1:18789/openclaw
Settings → Integrations → Gmail → Authorize
```

After authorization, verify Sophia can read email:

```bash
openclaw agent --message "Check my Gmail for any unread emails from today"
```

---

## Step 3 — Install and enable the Google Calendar skill

```bash
openclaw skills install google-calendar
```

After installation, open `~/.openclaw/openclaw.json` and find the `skills.entries` section.
Uncomment the google-calendar entry:

```json
"google-calendar": { "enabled": true }
```

Authorize via the Control UI when prompted, or when Sophia first attempts a calendar operation.

Verify:

```bash
openclaw agent --message "What's on my calendar tomorrow?"
```

---

## Step 4 — Restart the gateway to load all changes

```bash
# If running as a daemon:
openclaw daemon restart

# Or kill and restart manually:
pkill -9 -f openclaw-gateway || true
openclaw gateway --port 18789 --verbose
```

---

## Step 5 — Verify tone_skills.md is loading

Send a message that should trigger Band 2 (heavy weight):

> "I've been stuck on the same problem for three days and I'm starting to doubt myself."

Sophia's response should:

- Be 1–4 sentences
- Name the specific weight ("three days on the same thing")
- Ask one inward question, not a forward-facing one
- Not offer advice or silver linings
- Not say "that sounds challenging" or similar generic phrases

---

## Step 6 — Verify the mode-preservation rule

Send a message that requires a tool then emotional follow-up:

> "Can you check if I have anything on my calendar tomorrow?
> I'm trying to decide whether to take on something new but
> I'm not sure I have the energy."

Sophia should:

- Check the calendar and report results in conversational voice
- Not switch to "assistant mode" for the calendar result
- Acknowledge the energy question in her own voice
- Not produce a structured report or bullet points

---

## What this module adds

| Capability | How it works |
|---|---|
| Emotional tone tracking | `tone_skills.md` loaded at session start; Sophia reads it and uses it throughout |
| 5-band emotional register | Bands 1–5 from calm/clear to overwhelmed; Sophia calibrates response posture per band |
| Web search | Brave Search API; on request only, not proactive |
| Gmail (read + draft) | Authorized via onboarding; sends always require explicit confirmation |
| Gmail (proactive via heartbeat) | Scans inbox during heartbeat cycles for signals relevant to Davide's projects |
| Google Calendar (read + create) | After skill install; creates always require explicit confirmation |
| Timezone context | Europe/Rome set in config for accurate heartbeat quiet hours and date context |

## What this module does NOT include

These are deferred to later modules:

| Deferred capability | Module |
|---|---|
| TypeScript `before_prompt_build` plugin (deterministic tone routing) | Module 4 |
| Voice note transcription (Deepgram) + ElevenLabs TTS | Module 3 |
| Image understanding | Module 3 |
| Ritual system (prepare / debrief / vent / reset) | Module 4 |
| Smart opener (session-aware first message) | Module 4 |
| ClawVault memory (replaces OpenClaw native memory) | Module 7 |

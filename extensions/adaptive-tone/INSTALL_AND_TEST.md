# Install OpenClaw + the Adaptive Tone plugin — full walkthrough

A step-by-step guide to set up OpenClaw on a fresh (or old) computer and install,
configure, and test the **Adaptive Tone** plugin from scratch.

> **What the plugin does:** adjusts the assistant's *tone* (gentler when you say
> you're unwell, more patient when you repeat a question, calmer late at night,
> more formal/casual per channel). It steers delivery only — never the facts,
> capability, or safety behaviour.

> **Honesty note about these steps:** the OpenClaw install and CLI commands below
> come from OpenClaw's official docs, and the plugin's packaging has been validated
> against OpenClaw's plugin contract. I have **not** run this end-to-end on a live
> Gateway, so if a flag spelling differs in your OpenClaw version, append `--help`
> to the command (e.g. `openclaw plugins --help`) to confirm. Using a cloud model
> provider also **costs money per message** — see Step 1.

---

## 0. Will an old computer handle this?

Yes, almost certainly. OpenClaw is a lightweight Node.js app. The heavy AI work
runs on a **remote model provider's servers**, not on your machine — so you do
**not** need a fast CPU, a GPU, or lots of RAM. You need:

- A computer that can run **Node.js 22.19 or newer** (so: Windows 10/11, recent
  macOS, or most Linux).
- A working **internet connection**.
- **~1 GB free disk** and ~1 GB RAM free.
- A **model provider API key** (paid usage, or a provider free tier).

If the machine is *very* old (pre-Windows-10, or can't run Node 22+), it won't
work — check Node support first (Step 1).

---

## 1. Prerequisites

### 1a. Install Node.js (24 recommended, 22.19+ minimum)

Check what you have:

```bash
node --version
```

If it's missing or below `v22.19`, install Node 24 from <https://nodejs.org>
(the "LTS" or "Current" installer), or see OpenClaw's note at
<https://docs.openclaw.ai/install/node>.

### 1b. Get a model provider API key

OpenClaw needs a model to talk to. During onboarding (Step 3) it will ask you to
pick a provider and paste a key. Get one in advance from any of:

- **Anthropic** — <https://console.anthropic.com>
- **OpenAI** — <https://platform.openai.com>
- **Google (Gemini)** — <https://aistudio.google.com>

> Each reply you send costs a small amount of money (fractions of a cent to a few
> cents, depending on model). Set a spend limit in the provider dashboard if you're
> worried. (Advanced/free alternative: run a **local** model with Ollama — see
> <https://docs.openclaw.ai/install> — but that *does* need a capable machine, so
> it's not ideal for an old computer.)

### 1c. (Optional) Git

If you'll fetch the plugin by cloning from GitHub, install Git from
<https://git-scm.com>. If you'll copy the folder by USB instead, you can skip Git.

---

## 2. Install OpenClaw

Pick the row that matches your machine.

### Windows (native PowerShell)

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

> **Windows tip:** OpenClaw runs on native Windows, but its docs say **WSL2 is more
> stable and recommended**. If your old PC supports WSL2 (Windows 10 2004+ / 11),
> consider installing Ubuntu via `wsl --install`, then follow the macOS/Linux row
> *inside* the Ubuntu terminal. See <https://docs.openclaw.ai/platforms/windows>.

### macOS / Linux (or inside WSL2)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### Any OS, via npm (works everywhere Node is installed)

```bash
npm install -g openclaw@latest
```

### Verify the install

```bash
openclaw --version
```

You should see a version number (e.g. `2026.5.x`).

---

## 3. Onboard — connect a model and start the Gateway

The "Gateway" is the always-on background service that does the work.

```bash
openclaw onboard --install-daemon
```

The wizard (~2 min) walks you through:

1. Choosing a model provider.
2. Pasting your API key from Step 1b.
3. Configuring and installing the Gateway as a background service.

Then confirm it's running:

```bash
openclaw gateway status
```

You should see the Gateway **listening on port 18789**.

---

## 4. First chat — prove OpenClaw works *before* adding the plugin

The simplest test needs **no messaging channel**. Open the built-in dashboard:

```bash
openclaw dashboard
```

This opens the Control UI in your browser. Type a message in its chat box — you
should get an AI reply. (Prefer the terminal? `openclaw agent --message "hello"`.)

✅ **If you get a reply, OpenClaw itself is working.** Now add the plugin.

---

## 5. Get the Adaptive Tone plugin onto this computer

Pick one:

**Option A — clone from GitHub** (after you've pushed the repo):

```bash
git clone https://github.com/<your-username>/openclaw-adaptive-tone.git
cd openclaw-adaptive-tone
```

**Option B — copy the folder** (USB stick / network share): copy the whole
`openclaw-adaptive-tone` folder to the old computer, e.g. to your home directory,
then:

```bash
cd /path/to/openclaw-adaptive-tone      # Windows: cd C:\path\to\openclaw-adaptive-tone
```

---

## 6. Validate, (optionally) test, then install the plugin

### 6a. Sanity-check the package (optional but recommended)

```bash
npm install        # pulls the OpenClaw SDK so the next two commands can run
npm run typecheck  # compiles index.ts against the real SDK
npm test           # runs the 50 unit tests for the tone and weather logic
```

All three should succeed. (If you skip these, installation still works — they're
just extra confidence.)

### 6b. Validate against OpenClaw's plugin contract

```bash
openclaw plugins validate .
```

This checks the manifest (`openclaw.plugin.json`) and the package contract
(`package.json` `openclaw.compat` / `openclaw.build` fields). Fix anything it flags
before continuing.

### 6c. Install it (linked, for easy local development)

```bash
openclaw plugins install --link .
openclaw plugins enable adaptive-tone
openclaw gateway restart
```

> If your config uses a restrictive `plugins.allow` list, `install` adds the id for
> you. If `enable` says it's already enabled, that's fine.

### 6d. Confirm the hook actually registered

```bash
openclaw plugins inspect adaptive-tone --runtime --json
```

Look for the plugin id `adaptive-tone` and a registered hook named
`before_prompt_build`. If you see it, the plugin is live.

---

## 7. Configure the plugin (optional)

Config lives in `~/.openclaw/openclaw.json` (on native Windows:
`%USERPROFILE%\.openclaw\openclaw.json`) under
`plugins.entries.adaptive-tone.config`. All fields are optional.

**The one setting worth setting: your timezone** (so "late at night" is correct for
*you* — the hook can't read it automatically):

```bash
openclaw config set plugins.entries.adaptive-tone.config.time.timezone "Asia/Kolkata"
openclaw gateway restart
```

Replace `Asia/Kolkata` with your IANA timezone (e.g. `Europe/Berlin`,
`America/New_York`).

Or edit `~/.openclaw/openclaw.json` directly:

```jsonc
{
  "plugins": {
    "entries": {
      "adaptive-tone": {
        "config": {
          "enabled": true,
          "time": { "enabled": true, "timezone": "Asia/Kolkata" },
          "place": {
            "enabled": true,
            "professionalChannels": ["slack", "teams"],
            "casualChannels": ["whatsapp", "telegram"]
          },
          "repetition": { "enabled": true, "windowTurns": 6 },
          "wellbeing": { "enabled": true },
          "weather": { "enabled": true, "latitude": 52.52, "longitude": 13.41 }
        }
      }
    }
  }
}
```

Always `openclaw gateway restart` after editing config.

---

## 8. Test each tone behaviour

The clearest way to *see* the plugin work is to run the Gateway in the foreground
with verbose logging, so you can watch its debug lines while you chat.

**Terminal 1 — run the Gateway in the foreground:**

```bash
openclaw gateway stop
openclaw gateway --port 18789 --verbose
```

**Terminal 2 (or the Control UI from Step 4)** — send the test messages below.
Watch Terminal 1 for lines like `adaptive-tone: state=gentle-care (+412 chars)`.

| # | What to send | Expected log state | What you should feel in the reply |
|---|---|---|---|
| A | `I'm not well today, can you explain recursion?` | `gentle-care` | Warmer, shorter, no pressure |
| B | Send `how do I reset my password` **3 times in a row** | `patient-light` then `patient-repeat` | More patient; re-explained differently |
| C | (see timezone trick below) | `quiet-latenight` | Calmer, more concise |
| D | (needs a connected channel — see note) | `professional` / `casual` | Formal vs relaxed |
| E | Send any query with weather enabled | Active state + Weather guidance | Subtle tone adjustment (e.g. cozy/reflective on rainy days, bright/cheerful on sunny days) |

**Test C without waiting until night** — temporarily set the timezone to a region
where it's *currently* late at night, restart, and send any message:

```bash
openclaw config set plugins.entries.adaptive-tone.config.time.timezone "Pacific/Auckland"
openclaw gateway restart
# send a message, look for state=quiet-latenight, then set your real timezone back
```

**Test D note:** channel tone needs a real channel (e.g. set up Telegram —
<https://docs.openclaw.ai/channels/telegram> — it's just a bot token). If you only
use the Control UI, find the channel id it reports in the verbose logs and add that
id to `casualChannels`/`professionalChannels` to exercise this path.

**Feel the difference (A/B baseline):** disable the plugin, restart, send the same
message, and compare:

```bash
openclaw plugins disable adaptive-tone
openclaw gateway restart
# ...send the same "I'm not well..." message — notice the tone is more neutral...
openclaw plugins enable adaptive-tone
openclaw gateway restart
```

When you're done testing, stop the foreground Gateway with `Ctrl+C` and bring the
background daemon back with `openclaw gateway status` / onboarding's daemon, or just
`openclaw gateway restart`.

---

## 9. Turn it off / remove it

```bash
openclaw plugins disable adaptive-tone     # keep installed, stop it acting
openclaw plugins uninstall adaptive-tone   # remove entirely
openclaw gateway restart
```

---

## 10. Troubleshooting

| Symptom | Try this |
|---|---|
| General health check | `openclaw doctor` |
| Plugin-specific checks | `openclaw plugins doctor` |
| Is it installed/enabled? | `openclaw plugins list` |
| Hook not firing | Confirm `enable` ran, you restarted the Gateway, and `inspect --runtime` shows `before_prompt_build` |
| No tone change at all | Run with `--verbose`; check config; remember the `neutral` state injects **nothing** by design |
| "plugin blocked / not allowed" | Add `adaptive-tone` to `plugins.allow` in `~/.openclaw/openclaw.json`, then restart |
| Node too old | Upgrade to Node 24 (Step 1a) |
| A command/flag is unknown | Append `--help`, e.g. `openclaw plugins install --help` — spellings can vary by version |

---

## Command quick reference

```bash
# Install OpenClaw (npm route)
npm install -g openclaw@latest
openclaw onboard --install-daemon
openclaw gateway status
openclaw dashboard                              # first chat, no channel needed

# Plugin lifecycle
openclaw plugins validate .
openclaw plugins install --link .
openclaw plugins enable adaptive-tone
openclaw gateway restart
openclaw plugins inspect adaptive-tone --runtime --json

# Configure
openclaw config set plugins.entries.adaptive-tone.config.time.timezone "Asia/Kolkata"
openclaw gateway restart

# Observe it working
openclaw gateway stop
openclaw gateway --port 18789 --verbose         # watch for "adaptive-tone: state=..."
```

---

### Reference links
- Getting started: <https://docs.openclaw.ai/start/getting-started>
- Onboarding (CLI): <https://docs.openclaw.ai/start/wizard>
- Install options: <https://docs.openclaw.ai/install>
- Building / installing plugins: <https://docs.openclaw.ai/plugins/building-plugins>
- Windows / WSL2: <https://docs.openclaw.ai/platforms/windows>
- Config file: `~/.openclaw/openclaw.json`

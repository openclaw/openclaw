---
summary: "Planned first-run onboarding flow for Clawdis (local vs remote, Anthropic OAuth, workspace bootstrap ritual)"
read_when:
  - Designing the macOS onboarding assistant
  - Implementing Anthropic auth or identity setup
---
<!-- {% raw %} -->
# Onboarding (macOS app)

This doc describes the intended **first-run onboarding** for Clawdis. The goal is a good “day 0” experience: pick where the Gateway runs, bind Claude (Anthropic) auth for the embedded agent runtime, and then let the **agent bootstrap itself** via a first-run ritual in the workspace.

## Page order (high level)

1) **Local vs Remote**
2) **(Local only)** Connect Claude (Anthropic OAuth) — optional, but recommended
3) **Onboarding chat** — dedicated session where the agent introduces itself and guides setup

## 1) Local vs Remote

First question: where does the **Gateway** run?

- **Local (this Mac):** onboarding can run the Anthropic OAuth flow and write the Clawdis token store locally.
- **Remote (over SSH/tailnet):** onboarding must not run OAuth locally, because credentials must exist on the **gateway host**.

Implementation note (2025-12-19): in local mode, the macOS app bundles the Gateway and enables it via a per-user launchd LaunchAgent (no global npm install/Node requirement for the user).

## 2) Local-only: Connect Claude (Anthropic OAuth)

This is the “bind Clawdis to Anthropic” step. It is explicitly the **Anthropic (Claude Pro/Max) OAuth flow**, not a generic “login”.

### Recommended: OAuth

The macOS app should:
- Start the Anthropic OAuth (PKCE) flow in the user’s browser.
- Ask the user to paste the `code#state` value.
- Exchange it for tokens and write credentials to:
  - `~/.clawdis/credentials/oauth.json` (file mode `0600`, directory mode `0700`)

Why this location matters: it’s the Clawdis-owned OAuth store.
On first run, Clawdis can import existing OAuth tokens from legacy p/Claude locations if present.

### Alternative: API key (instructions only)

Offer an “API key” option, but for now it is **instructions only**:
- Get an Anthropic API key.
- Provide it to Clawdis via your preferred mechanism (env/config).

Note: environment variables are often confusing when the Gateway is launched by a GUI app (launchd environment != your shell).

### Provider/model safety rule

Clawdis should **always pass** `--provider` and `--model` when invoking the embedded agent (don’t rely on defaults).

Example (CLI):

```bash
clawdis agent --mode rpc --provider anthropic --model claude-opus-4-5 "<message>"
```

If the user skips auth, onboarding should be clear: the agent likely won’t respond until auth is configured.

## 3) Onboarding chat (dedicated session)

The onboarding flow now embeds the SwiftUI chat view directly. It uses a **special session key**
(`onboarding`) so the “newborn agent” ritual stays separate from the main chat.

This onboarding chat is where the agent:
- does the BOOTSTRAP.md identity ritual (one question at a time)
- visits **soul.md** with the user and writes `SOUL.md` (values, tone, boundaries)
- asks how the user wants to talk (web-only / WhatsApp / Telegram)
- guides linking steps (including showing a QR inline for WhatsApp via the `whatsapp_login` tool)

If the workspace bootstrap is already complete (BOOTSTRAP.md removed), the onboarding chat step is skipped.

Once setup is complete, the user can switch to the normal chat (`main`) via the menu bar panel.

## 4) Agent bootstrap ritual (outside onboarding)

We no longer collect identity in the onboarding wizard. Instead, the **first agent run** performs a playful bootstrap ritual using files in the workspace:

- Workspace is created implicitly (default `~/.clawdis/workspace`) when local is selected,
  but only if the folder is empty or already contains `AGENTS.md`.
- Files are seeded: `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- `BOOTSTRAP.md` tells the agent to keep it conversational:
  - open with a cute hello
  - ask **one question at a time** (no multi-question bombardment)
  - offer a small set of suggestions where helpful (name, creature, emoji)
  - wait for the user’s reply before asking the next question
- The agent writes results to:
  - `IDENTITY.md` (agent name, vibe/creature, emoji)
  - `USER.md` (who the user is + how they want to be addressed)
  - `SOUL.md` (identity, tone, boundaries — crafted from the soul.md prompt)
  - `~/.clawdis/clawdis.json` (structured identity defaults)
- After the ritual, the agent **deletes `BOOTSTRAP.md`** so it only runs once.

Identity data still feeds the same defaults as before:

- outbound prefix emoji (`inbound.responsePrefix`)
- group mention patterns / wake words
- default session intro (“You are Samantha…”)
- macOS UI labels

## 5) Workspace notes (no explicit onboarding step)

The workspace is created automatically as part of agent bootstrap (no dedicated onboarding screen).

Recommendation: treat the workspace as the agent’s “memory” and make it a git repo (ideally private) so identity + memories are backed up:

```bash
cd ~/.clawdis/workspace
git init
git add AGENTS.md
git commit -m "Add agent workspace"
```

Daily memory lives under `memory/` in the workspace:
- one file per day: `memory/YYYY-MM-DD.md`
- read today + yesterday on session start
- keep it short (durable facts, preferences, decisions; avoid secrets)

## Remote mode note (why OAuth is hidden)

If the Gateway runs on another machine, the Anthropic OAuth credentials must be created/stored on that host (where the agent runtime runs).

For now, remote onboarding should:
- explain why OAuth isn’t shown
- point the user at the credential location (`~/.clawdis/credentials/oauth.json`) and the workspace location on the gateway host
- mention that the **bootstrap ritual happens on the gateway host** (same BOOTSTRAP/IDENTITY/USER files)
<!-- {% endraw %} -->

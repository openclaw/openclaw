---
summary: "Planned first-run onboarding flow for Clawdis (local vs remote, Anthropic OAuth, workspace identity)"
read_when:
  - Designing the macOS onboarding assistant
  - Implementing Pi authentication or identity setup
---
<!-- {% raw %} -->
# Onboarding (macOS app)

This doc describes the intended **first-run onboarding** for Clawdis. The goal is a good “day 0” experience: pick where the Gateway runs, bind Claude (Anthropic) auth for Pi, and set the agent’s identity + workspace.

## Page order (high level)

1) **Local vs Remote**
2) **(Local only)** Connect Claude (Anthropic OAuth) — optional, but recommended
3) **Identity** — name, theme, emoji
4) **Workspace** — create + populate `AGENTS.md` (and recommend git backup)

## 1) Local vs Remote

First question: where does the **Gateway** run?

- **Local (this Mac):** onboarding can run the Anthropic OAuth flow and write Pi’s token store locally.
- **Remote (over SSH/tailnet):** onboarding must not run OAuth locally, because credentials must exist on the **gateway host**.

## 2) Local-only: Connect Claude (Anthropic OAuth)

This is the “bind Pi to Clawdis” step. It is explicitly the **Anthropic (Claude Pro/Max) OAuth flow**, not a generic “login”.

### Recommended: OAuth

The macOS app should:
- Start the Anthropic OAuth (PKCE) flow in the user’s browser.
- Ask the user to paste the `code#state` value.
- Exchange it for tokens and write Pi-compatible credentials to:
  - `~/.pi/agent/oauth.json` (file mode `0600`, directory mode `0700`)

Why this location matters: it makes Pi work immediately (Clawdis doesn’t need a terminal and doesn’t need to re-implement Pi’s auth plumbing later).

### Alternative: API key (instructions only)

Offer an “API key” option, but for now it is **instructions only**:
- Get an Anthropic API key.
- Provide it to Pi (or to Clawdis’s Pi invocation) via your preferred mechanism.

Note: environment variables are often confusing when the Gateway is launched by a GUI app (launchd environment != your shell).

### Provider/model safety rule

Clawdis should **always pass** `--provider` and `--model` when invoking Pi (don’t rely on Pi defaults).

Until that is hard-coded, the equivalent configuration is:

```json5
{
  inbound: {
    reply: {
      mode: "command",
      command: [
        "pi",
        "--mode",
        "rpc",
        "--provider",
        "anthropic",
        "--model",
        "claude-opus-4-5",
        "{{BodyStripped}}"
      ],
      agent: { kind: "pi", format: "json" }
    }
  }
}
```

If the user skips auth, onboarding should be clear: the agent likely won’t respond until auth is configured.

## 3) Identity (name + theme + emoji)

After auth (or skip), onboarding asks:

1) Agent **name** (e.g. “Samantha”)
2) Agent **theme/persona** (e.g. “space lobster”, “helpful sloth”)
3) Suggested **emoji** (based on theme; user can override)

Persist identity in two places:

- Workspace `AGENTS.md` (human-editable, lives with the agent’s “memory” files)
- `~/.clawdis/clawdis.json` (structured identity, used for defaults/UI)

“Use this name everywhere” should derive defaults like:
- outbound prefix emoji (`inbound.responsePrefix`)
- group mention patterns / wake words
- default session intro (“You are Samantha…”)
- macOS UI labels

## 4) Workspace (AGENTS.md + backup tip)

Onboarding should create a dedicated agent workspace (default `~/.clawdis/workspace`) and ensure it has an `AGENTS.md`.

Recommendation: treat the workspace as the agent’s “memory” and make it a git repo (ideally private) so identity + memories are backed up:

```bash
cd ~/.clawdis/workspace
git init
git add AGENTS.md
git commit -m "Add agent workspace"
```

## Remote mode note (why OAuth is hidden)

If the Gateway runs on another machine, the Anthropic OAuth credentials must be created/stored on that host (where Pi runs).

For now, remote onboarding should:
- explain why OAuth isn’t shown
- point the user at the credential location (`~/.pi/agent/oauth.json`) and the workspace location on the gateway host
<!-- {% endraw %} -->

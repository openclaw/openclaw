---
summary: "Manual logins for browser automation + X/Twitter posting"
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: "Browser Login"
---

# Browser login + X/Twitter posting

## Manual login (recommended)

When a site requires login, **sign in manually** in the **host** browser profile (the evox browser).

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

Back to the main browser docs: [Browser](/tools/browser).

## Which Chrome profile is used?

EVOX.sh controls a **dedicated Chrome profile** (named `evox`, orange‑tinted UI). This is separate from your daily browser profile.

For agent browser tool calls:

- Default choice: the agent should use its isolated `evox` browser.
- Use `profile="user"` only when existing logged-in sessions matter and the user is at the computer to click/approve any attach prompt.
- If you have multiple user-browser profiles, specify the profile explicitly instead of guessing.

Two easy ways to access it:

1. **Ask the agent to open the browser** and then log in yourself.
2. **Open it via CLI**:

```bash
evox browser start
evox browser open https://x.com
```

If you have multiple profiles, pass `--browser-profile <name>` (the default is `evox`).

## X/Twitter: recommended flow

- **Read/search/threads:** use the **host** browser (manual login).
- **Post updates:** use the **host** browser (manual login).

## Sandboxing + host browser access

Sandboxed browser sessions are **more likely** to trigger bot detection. For X/Twitter (and other strict sites), prefer the **host** browser.

If the agent is sandboxed, the browser tool defaults to the sandbox. To allow host control:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Then target the host browser:

```bash
evox browser open https://x.com --browser-profile evox --target host
```

Or disable sandboxing for the agent that posts updates.

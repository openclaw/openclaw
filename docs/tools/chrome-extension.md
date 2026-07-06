---
summary: "Chrome extension: let OpenClaw drive your signed-in Chrome with no remote-debugging prompt"
read_when:
  - You want an agent to drive your real signed-in Chrome from your phone
  - You keep hitting the Chrome "Allow remote debugging?" prompt with nobody at the desk
  - You want to understand the security model of browser takeover via the extension
title: "Chrome Extension"
---

# Chrome extension

The OpenClaw Chrome extension lets an agent control your **signed-in Chrome
tabs** without launching a separate managed browser, and **without** Chrome's
blocking "Allow remote debugging?" prompt.

This matters when you drive OpenClaw from a phone (Telegram, WhatsApp, etc.):
the [`user` profile](/tools/browser#profiles-openclaw-user-chrome) attaches over
Chrome's remote-debugging port, which pops a desktop consent dialog nobody can
click when you are away. The extension uses the `chrome.debugger` API instead,
so the only in-page hint is Chrome's dismissible "OpenClaw started debugging
this browser" banner.

This is the same shape used by Anthropic's Claude in Chrome and OpenAI's Codex
Chrome extensions.

## How it works

Three parts:

- **Browser control service** (Gateway or node host): the API the `browser`
  tool calls.
- **Extension relay** (loopback WebSocket): a small server the control service
  starts on `127.0.0.1`. It presents a Chrome DevTools Protocol endpoint to
  OpenClaw and speaks to the extension. Both sides are authenticated with a
  token derived from your Gateway auth.
- **OpenClaw Chrome extension** (MV3): attaches to tabs with `chrome.debugger`,
  forwards CDP traffic, and manages the **OpenClaw tab group**.

OpenClaw only sees and controls tabs that are in the **OpenClaw tab group**. The
group is the consent boundary: drag a tab in to share it, drag it out (or click
the toolbar button) to revoke access instantly.

## Install and pair

1. Print the unpacked extension path:

   ```bash
   openclaw browser extension path
   ```

2. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select the printed directory.

3. Print the pairing string:

   ```bash
   openclaw browser extension pair
   ```

4. Click the OpenClaw toolbar icon and paste the pairing string into the popup.
   The badge turns **ON** when the extension connects to the relay.

The pairing token is derived (HMAC-SHA256) from your Gateway auth material, so
the raw Gateway credential never reaches Chrome. Rotating Gateway auth rotates
the pairing token.

## Use it

Select the built-in `chrome` profile in a `browser` tool call, or make it the
default:

```bash
openclaw config set browser.defaultProfile chrome
```

```json5
{
  browser: {
    profiles: {
      chrome: { driver: "extension", color: "#FF4500" },
    },
  },
}
```

- Share a tab: click the OpenClaw toolbar button on that tab (it joins the
  OpenClaw tab group), or drag any tab into the group.
- The agent can also open new tabs; those land in the group automatically.
- Revoke: click the button again, drag the tab out of the group, or dismiss
  Chrome's debugging banner. The agent loses access to that tab immediately.

## Diagnostics

```bash
openclaw browser status --browser-profile chrome
openclaw browser doctor --browser-profile chrome
```

`doctor` reports the **Chrome extension relay** check as failing until the
extension popup shows **Connected**.

## Security model

- The relay binds loopback only; both WebSocket sides are authenticated with the
  derived token, and the extension side is origin-checked to `chrome-extension://`.
- The agent can only see and drive tabs in the **OpenClaw tab group**. Your
  other tabs stay private.
- Compared with the `user` (Chrome MCP) profile, which exposes your whole
  signed-in browser once you approve the remote-debugging prompt, the extension
  keeps the shared surface scoped to a tab group you control at a glance.

See also: [Browser](/tools/browser) for the full profile model and the
managed `openclaw` and Chrome MCP `user` profiles.

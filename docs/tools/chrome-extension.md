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
  OpenClaw and speaks to the extension. Both sides authenticate with a
  host-local token (see below).
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

The pairing token is a **host-local secret** created on first use and stored
under `credentials/` in the state directory (mode `0600`). Each machine that
runs a browser — the Gateway host and every browser node host — owns its own
token, so no credential has to travel between machines. To rotate it, delete the
`browser-extension-relay.secret` file and pair again.

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

## Remote / cross-machine

Chrome does not have to run on the Gateway host. Three topologies work:

- **Same host** (Gateway + Chrome on one machine): pair on that machine with
  `openclaw browser extension pair`. The relay is loopback-only.
- **Direct to a remote Gateway** (Chrome on your laptop, Gateway on a VPS, and
  **nothing else on the laptop**): on the Gateway, run
  `openclaw browser extension pair --gateway-url wss://your-gateway.example.com`.
  It prints a `wss://…/browser/extension#<secret>` string; load and pair the
  extension on the laptop. The extension connects **straight to the Gateway**
  over `wss://` — no OpenClaw install, Node, CLI, or open inbound port on the
  laptop. This is the managed-hosting path.
- **Via a browser node host** (Chrome on a machine already running an OpenClaw
  node): run `pair` on the node and pair locally; the Gateway proxies browser
  actions to the node over its existing authenticated node link.

The pairing secret is per host (the Gateway's, in the direct case), validated by
the Gateway's `/browser/extension` route. For the direct path, serve the Gateway
over TLS (`wss://`) so the pairing secret and CDP traffic are encrypted.
The secret remains in the pairing string's URL fragment and is presented during
the WebSocket handshake as a subprotocol credential, so normal proxy access
logs do not receive it in the request URL. Ensure any reverse proxy preserves
the standard `Sec-WebSocket-Protocol` header.

## Side panel copilot

The extension also ships a chat side panel pinned to the tab it was opened on.
Open it from the popup (**Open copilot panel**), share the tab into the
OpenClaw group, and ask for things in natural language — "fill this form with
my details", "summarize this thread" — the agent drives that tab through the
normal `browser` tool.

- **Per-tab conversations.** Each tab chats in its own gateway session
  (`…:thread:tab-<browser-session>-<id>`), so two tabs never mix context.
  Reopening the panel on the same tab resumes its conversation; **New chat**
  starts a fresh one. Threads are scoped to one browser session on purpose:
  Chrome reissues tab ids from a low counter every launch, so a restart starts
  each tab fresh rather than handing it whichever conversation last held that
  id.
- **Allow the panel's origin — required once.** The panel is a Chrome
  extension page, so its WebSocket always sends an
  `Origin: chrome-extension://<extension-id>` header, and the Gateway checks any
  origin it is given against `gateway.controlUi.allowedOrigins`. That list is
  empty by default, so the panel is refused until you add the extension's origin
  (the id is on the extension's `chrome://extensions` card):

  ```bash
  openclaw config set gateway.controlUi.allowedOrigins '["chrome-extension://<extension-id>"]'
  ```

  That command sets the **whole** list, so include any origins you already allow
  (check with `openclaw config get gateway.controlUi.allowedOrigins`) or you will
  revoke them — the Control UI's own origin included.

  Without it the panel reports "Gateway refused the connection" and keeps
  retrying. This applies on the same machine too; loopback does not exempt it.

- **Gateway connection.** The panel connects to the Gateway as its own
  operator device (Ed25519 identity, scopes `operator.read` +
  `operator.write`). Once the origin is allowed, it pairs silently on the same
  machine; a remote gateway needs a one-time `openclaw devices` approval. The
  panel needs Chrome 137 or newer for Ed25519 device keys, though the rest of
  the extension works on older versions.
- **Settings** (⚙ in the panel): gateway URL and token. On the same machine
  the default `http://127.0.0.1:18789` needs no token; remote gateways use
  `wss://` plus the gateway shared secret.
- **Consent is unchanged**: the panel can only ask the agent to act on tabs
  you shared into the OpenClaw tab group, and revoking a tab (drag it out,
  toolbar button, or dismiss the debugging banner) revokes the agent
  immediately.

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
- Direct Gateway pairing does not accept the relay token in the request URL;
  the bundled extension carries it in the WebSocket subprotocol list instead.
- The agent can only see and drive tabs in the **OpenClaw tab group**. Your
  other tabs stay private.
- Compared with the `user` (Chrome MCP) profile, which exposes your whole
  signed-in browser once you approve the remote-debugging prompt, the extension
  keeps the shared surface scoped to a tab group you control at a glance.

See also: [Browser](/tools/browser) for the full profile model and the
managed `openclaw` and Chrome MCP `user` profiles.

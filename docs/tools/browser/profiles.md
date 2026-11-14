---
summary: "The built-in openclaw, user, and chrome profiles and the Control UI Browser panel"
title: "Browser profiles"
read_when:
  - You are choosing between the managed browser and a signed-in Chrome session
  - You need a profile that works with nobody at the computer
  - You are using the Browser panel in the Control UI
---

- `openclaw`: managed, isolated browser (no extension required).
- `user`: built-in Chrome DevTools MCP attach profile for your **real
  signed-in Chrome** session. Chrome shows a blocking "Allow remote debugging?"
  prompt the first time OpenClaw attaches, so someone must be at the computer.
- `chrome`: built-in [Chrome extension](/tools/chrome-extension) profile for
  your **real signed-in Chrome** session. Works from a phone with nobody at the
  desk because it drives tabs through the OpenClaw browser extension instead of
  the remote-debugging port, so there is no "Allow remote debugging?" prompt.

For agent browser tool calls:

- Default: use the isolated `openclaw` browser.
- Prefer `profile="chrome"` (extension) when existing logged-in sessions matter
  and the user is **away from the computer** (Telegram, WhatsApp, etc.).
- Prefer `profile="user"` (Chrome MCP) when existing logged-in sessions matter
  and the user is **at the computer** to approve the attach prompt.
- `profile` is the explicit override when you want a specific browser mode.

Set `browser.defaultProfile: "openclaw"` if you want managed mode by default.

Status and profile listing are passive: they never start a browser, attach Chrome
MCP, or open a CDP WebSocket. Use `browser start` or an explicit browser action
to attach. Chrome MCP and shared extension-relay tab counts reflect the last
explicit tab enumeration; locally owned relays report their current tab metadata.
Live readiness and graphics inspection are available through `browser doctor --deep`.

## Browser panel in the Control UI

The Browser panel follows the current session's latest successful browser tab,
including its profile and host or node. This does not change
`browser.defaultProfile` or another session's selection. Without a session browser target, the panel uses
the configured default routing.

The chat side panel shows only this session's tabs: tabs its agent or panel
opened, plus tabs its conversation used. Other sessions' tabs and tabs opened
outside OpenClaw stay hidden. The Browser dock outside a chat session lists
every tab. Tabs opened from a session's panel belong to that session and follow
the existing session tab cleanup: they close when the session is reset or
deleted, with idle and per-session limits controlled by `browser.tabCleanup`.
Tabs opened from a panel before this ownership existed have no recorded
session, so they stay open but appear only in the Browser dock outside a chat
session.

The panel fits the viewport of an isolated, locally managed browser to its size.
For existing-session Chrome, extension-attached browsers, attach-only CDP, and
remote browsers, the preview scales locally without resizing the browser window
or page viewport. Explicit browser resize actions remain available.

The panel streams the active tab live as the page repaints. It falls back to
screenshots for node-routed browsers, Chrome MCP existing-session profiles,
missing Playwright, or stream connection failures. Navigation rules apply to
the stream: navigating to a blocked address stops it and clears the view.

The panel and the agent can use the same browser at the same time. When you
click or type in the panel, the agent's next browser results include a short
note that you used the browser recently, so it can check the page before acting.

Click **Take control** in the panel toolbar to work in the browser without the
agent acting at the same time. While you hold control of that profile, browser
actions from anyone else (the agent's browser tool, the `openclaw browser` CLI,
other Control UI windows) are not run. The agent's browser tool answers that you
have taken over the browser, and its turn continues; it can still take snapshots
and screenshots. An action that had already started may finish. Click **Release
control** to hand the browser back. Control is also released when the Control UI
window closes or loses its connection, and after 5 minutes without input from
you. Take control is available for browsers on the Gateway host, not for
node-routed browsers.

### Chrome settings and passwords

You can open `chrome://settings` (for example `chrome://settings/payments`) and
`chrome://password-manager` from the panel's address bar, to add a payment card
or manage saved passwords yourself. They always open in a new tab, and only
your authenticated Control UI connection can list, view or use them. The agent's
browser tool, the `openclaw browser` CLI and other Gateway clients cannot open,
list, read, capture or interact with these pages, including while you have one
open. Other `chrome://` pages stay blocked for everyone.

This works for locally managed and CDP-attached Chromium profiles on the Gateway
host. It is not available for node-routed browsers, Chrome MCP existing-session
profiles or the browser extension, and a profile that runs Chrome's headless
shell has no settings pages to open. Chrome may ask for your device password
before showing a saved password; that prompt appears on the computer running the
browser, not in the panel.

After an established stream disconnects, the panel refreshes its screenshot
and retries the stream automatically after a short delay. Annotation and
inspection keep their captured image until you return to interaction mode.

Browser tool calls appear in chat as ordinary expandable tool results; they do
not add page-preview cards. Tab actions without a page URL still update the
Browser panel's selection. Sandbox browser results remain available to the agent
but do not select a host browser. Expand the tool activity to inspect every
original call and result.

The panel's address bar opens web addresses and searches everything else.
An `http(s)://` URL, or a host with a dot, a port, `localhost` or an IPv6
address, opens as an address, even when its path or query contains spaces.
Other text, such as words with spaces or a single word like `openclaw`,
opens a Google search. For a single name such as `devbox`, the address bar
also offers **Go to `https://devbox/`** to open it as an address instead. None
of the browsers the panel drives exposes its own default search engine to
OpenClaw. Addresses without a scheme open over
`https://`; other schemes such as `javascript:` or `file:` are not opened,
and the address bar says so.

If a listed tab cannot be accessed, the panel explains whether navigation rules
blocked it or its address could not be verified. Select another tab, enter an
allowed address, or refresh after a temporary lookup failure. Blocked URLs stay
hidden; displaying a tab title does not grant access to its contents.

Following a historical tab never starts a stopped managed browser: a fresh
launch cannot contain that tab. The panel shows **Start browser** instead.
Click **Start browser** to launch the browser and show its current tabs.

For local `attachOnly` CDP profiles on macOS and Linux, direct preview screenshots
preserve the active Chrome tab when OpenClaw can verify that the attached browser
is running with a visible window. Headless browsers and browsers whose mode cannot
be verified keep the existing activation behavior so screenshots remain reliable.
Explicit tab-focus actions still activate the requested tab.

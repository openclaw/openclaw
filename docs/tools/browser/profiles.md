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

## Browser panel in the Control UI

The Browser panel follows the current session's latest successful browser tab,
including its profile and host or node. Opening a browser preview card selects
that card's browser and tab. This does not change `browser.defaultProfile` or
another session's selection. Without a session browser target, the panel uses
the configured default routing.

The panel streams the active tab live as the page repaints. It falls back to
screenshots for node-routed browsers, Chrome MCP existing-session profiles,
missing Playwright, or stream connection failures. Navigation rules apply to
the stream: navigating to a blocked address stops it and clears the view.

After an established stream disconnects, the panel refreshes its screenshot
and retries the stream automatically after a short delay. Annotation and
inspection keep their captured image until you return to interaction mode.

Preview cards appear only for HTTP(S) page URLs when OpenClaw can identify the
browser's route. Blank or internal pages remain ordinary tool results. Tab
actions without a page URL still update the Browser panel's selection. Sandbox
browser results remain available to the agent but do not open a host-browser preview.

If a listed tab cannot be accessed, the panel explains whether navigation rules
blocked it or its address could not be verified. Select another tab, enter an
allowed address, or refresh after a temporary lookup failure. Blocked URLs stay
hidden; displaying a tab title does not grant access to its contents.

Following a historical tab never starts a stopped managed browser: a fresh
launch cannot contain that tab. The panel shows **Start browser** instead, and
preview cards keep their title and URL without a thumbnail when that target
is unavailable. Click **Start browser** to launch the browser and show its current tabs.

For local `attachOnly` CDP profiles on macOS and Linux, direct preview screenshots
preserve the active Chrome tab when OpenClaw can verify that the attached browser
is running with a visible window. Headless browsers and browsers whose mode cannot
be verified keep the existing activation behavior so screenshots remain reliable.
Explicit tab-focus actions still activate the requested tab.

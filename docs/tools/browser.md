---
summary: "Index of the OpenClaw browser documentation, one page per reader job"
read_when:
  - Adding agent-controlled browser automation
  - Debugging why openclaw is interfering with your own Chrome
  - Implementing browser settings + lifecycle in the macOS app
  - You are looking for the Browser page that matches your task
title: "Browser (OpenClaw-managed)"
---

OpenClaw can run a **dedicated Chrome/Brave/Edge/Chromium profile** that the agent controls. It runs through a small local control service inside the Gateway (loopback only) and is isolated from your personal browser.

- Think of it as a **separate, agent-only browser**. The `openclaw` profile never touches your personal browser profile.
- The agent opens tabs, reads pages, clicks, and types in this isolated lane.
- The built-in `user` profile attaches to your real signed-in Chrome session instead, via Chrome DevTools MCP.

This page is an index. The browser documentation is split across nine pages,
one per reader job. Open the page that matches your task.

| Page                                                                         | Read it when                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Browser setup](/tools/browser/setup)                                        | You are turning the browser on for the first time, or the tool is missing.      |
| [Browser profiles](/tools/browser/profiles)                                  | You are choosing between the managed browser and a signed-in Chrome session.    |
| [Browser configuration](/tools/browser/configuration)                        | You need the config block, ports, SSRF policy, or a different Chromium binary.  |
| [Remote and hosted browsers](/tools/browser/remote)                          | The browser lives on another machine, or you use a hosted CDP provider.         |
| [Browser security](/tools/browser/security)                                  | You are reviewing control-API auth or handling remote CDP tokens.               |
| [Multi-profile and existing-session attach](/tools/browser/existing-session) | You want extra named profiles or the agent inside your signed-in browser.       |
| [Isolation and browser selection](/tools/browser/isolation)                  | You need the isolation guarantees, the binary search order, or the control API. |
| [Browser troubleshooting](/tools/browser/troubleshooting)                    | The browser will not start, or a navigation is blocked.                         |
| [Browser agent tools](/tools/browser/agent-tools)                            | You need the browser tool actions and the arguments an agent passes.            |

## What you get

- A separate browser profile named **openclaw** (orange accent by default).
- Deterministic tab control (list/open/focus/close).
- Agent actions (click/type/drag/select), snapshots, screenshots, PDFs.
- Question answering over readable page text without returning a full snapshot.
- Playwright-backed profiles save direct attachment navigations under the managed downloads directory and return `{ url, suggestedFilename, path }` metadata after final-URL policy validation.
- Playwright-backed agent actions return a `downloads` array with the same managed metadata when the action immediately starts one or more downloads.
- A bundled `browser-automation` skill that teaches agents the snapshot,
  stable-tab, stale-ref, and manual-blocker recovery loop when the browser
  plugin is enabled.
- Optional multi-profile support (`openclaw`, `work`, `remote`, ...).

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

On macOS, you can explicitly copy cookies from a Chrome-family system profile into a separate managed profile. The managed browser still uses its own user data directory; only the selected cookies are copied, and local storage and IndexedDB stay behind. See [Profiles](/tools/browser/existing-session#profiles-multi-browser) or the [`openclaw browser` CLI reference](/cli/browser) for import commands and limitations.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor
here, so an existing link such as `/tools/browser#custom-chrome-mcp-launch`
still resolves. Each entry points at the page that now holds the content.

- <a id="quick-start" />[Quick start](/tools/browser/setup#quick-start)
- <a id="plugin-control" />[Plugin control](/tools/browser/setup#plugin-control)
- <a id="agent-guidance" />[Agent guidance](/tools/browser/setup#agent-guidance)
- <a id="missing-browser-command-or-tool" />[Missing browser command or tool](/tools/browser/setup#missing-browser-command-or-tool)
- <a id="profiles%3A-openclaw%2C-user%2C-chrome" /><a id="profiles-openclaw-user-chrome" />[Profiles: `openclaw`, `user`, `chrome`](/tools/browser/profiles)
- <a id="browser-panel-in-the-control-ui" />[Browser panel in the Control UI](/tools/browser/profiles#browser-panel-in-the-control-ui)
- <a id="configuration" />[Configuration](/tools/browser/configuration#configuration)
- <a id="tab-cleanup-ownership" />[Tab cleanup ownership](/tools/browser/configuration#tab-cleanup-ownership)
- <a id="screenshot-vision-(text-only-model-support)" /><a id="screenshot-vision-text-only-model-support" />[Screenshot vision (text-only model support)](/tools/browser/configuration#screenshot-vision-text-only-model-support)
- <a id="ports-and-reachability" />[Ports and reachability](/tools/browser/configuration#ports-and-reachability)
- <a id="ssrf-policy" />[SSRF policy](/tools/browser/configuration#ssrf-policy)
- <a id="profile-behavior" />[Profile behavior](/tools/browser/configuration#profile-behavior)
- <a id="use-brave-or-another-chromium-based-browser" />[Use Brave or another Chromium-based browser](/tools/browser/configuration#use-brave-or-another-chromium-based-browser)
- <a id="macos" />[macOS executable path tab](/tools/browser/configuration#macos)
- <a id="windows" />[Windows executable path tab](/tools/browser/configuration#windows)
- <a id="linux" />[Linux executable path tab](/tools/browser/configuration#linux)
- <a id="local-vs-remote-control" />[Local vs remote control](/tools/browser/remote#local-vs-remote-control)
- <a id="node-browser-proxy-(zero-config-default)" /><a id="node-browser-proxy-zero-config-default" />[Node browser proxy (zero-config default)](/tools/browser/remote#node-browser-proxy-zero-config-default)
- <a id="browserless-(hosted-remote-cdp)" /><a id="browserless-hosted-remote-cdp" />[Browserless (hosted remote CDP)](/tools/browser/remote#browserless-hosted-remote-cdp)
- <a id="browserless-docker-on-the-same-host" />[Browserless Docker on the same host](/tools/browser/remote#browserless-docker-on-the-same-host)
- <a id="direct-websocket-cdp-providers" />[Direct WebSocket CDP providers](/tools/browser/remote#direct-websocket-cdp-providers)
- <a id="browserbase" />[Browserbase](/tools/browser/remote#browserbase)
- <a id="notte" />[Notte](/tools/browser/remote#notte)
- <a id="security" />[Security](/tools/browser/security)
- <a id="profiles-(multi-browser)" /><a id="profiles-multi-browser" />[Profiles (multi-browser)](/tools/browser/existing-session#profiles-multi-browser)
- <a id="existing-session-via-chrome-devtools-mcp" />[Existing session via Chrome DevTools MCP](/tools/browser/existing-session#existing-session-via-chrome-devtools-mcp)
- <a id="custom-chrome-mcp-launch" />[Custom Chrome MCP launch](/tools/browser/existing-session#custom-chrome-mcp-launch)
- <a id="existing-session-feature-limitations" />[Existing-session feature limitations](/tools/browser/existing-session#existing-session-feature-limitations)
- <a id="isolation-guarantees" />[Isolation guarantees](/tools/browser/isolation#isolation-guarantees)
- <a id="browser-selection" />[Browser selection](/tools/browser/isolation#browser-selection)
- <a id="control-api-(optional)" /><a id="control-api-optional" />[Control API (optional)](/tools/browser/isolation#control-api-optional)
- <a id="troubleshooting" />[Troubleshooting](/tools/browser/troubleshooting)
- <a id="cdp-startup-failure-vs-navigation-ssrf-block" />[CDP startup failure vs navigation SSRF block](/tools/browser/troubleshooting#cdp-startup-failure-vs-navigation-ssrf-block)
- <a id="agent-tools-%2B-how-control-works" /><a id="agent-tools-+-how-control-works" />[Agent tools + how control works](/tools/browser/agent-tools)

## Related

- [Tools Overview](/tools) - all available agent tools
- [Sandboxing](/gateway/sandboxing) - browser control in sandboxed environments
- [Security](/gateway/security) - browser control risks and hardening

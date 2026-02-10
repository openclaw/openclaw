---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw browser` (profiles, tabs, actions, extension relay)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You use `openclaw browser` and want examples for common tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to control a browser running on another machine via a node host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to use the Chrome extension relay (attach/detach via toolbar button)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "browser"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw browser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage OpenClaw’s browser control server and run browser actions (tabs, snapshots, screenshots, navigation, clicks, typing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser tool + API: [Browser tool](/tools/browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chrome extension relay: [Chrome extension](/tools/chrome-extension)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url <gatewayWsUrl>`: Gateway WebSocket URL (defaults to config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`: Gateway token (if required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`: request timeout (ms).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--browser-profile <name>`: choose a browser profile (default from config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: machine-readable output (where supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start (local)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile chrome tabs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile openclaw start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile openclaw open https://example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile openclaw snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profiles are named browser routing configs. In practice:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw`: launches/attaches to a dedicated OpenClaw-managed Chrome instance (isolated user data dir).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chrome`: controls your existing Chrome tab(s) via the Chrome extension relay.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser create-profile --name work --color "#FF5A36"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser delete-profile --name work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a specific profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser --browser-profile work tabs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tabs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser tabs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser open https://docs.openclaw.ai（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser focus <targetId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser close <targetId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Snapshot / screenshot / actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Snapshot:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Screenshot:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser screenshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Navigate/click/type (ref-based UI automation):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser navigate https://example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser click <ref>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser type <ref> "hello"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chrome extension relay (attach via toolbar button)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This mode lets the agent control an existing Chrome tab that you attach manually (it does not auto-attach).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install the unpacked extension to a stable path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser extension install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser extension path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then Chrome → `chrome://extensions` → enable “Developer mode” → “Load unpacked” → select the printed folder.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full guide: [Chrome extension](/tools/chrome-extension)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote browser control (node host proxy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs on a different machine than the browser, run a **node host** on the machine that has Chrome/Brave/Edge/Chromium. The Gateway will proxy browser actions to that node (no separate browser control server required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `gateway.nodes.browser.mode` to control auto-routing and `gateway.nodes.browser.node` to pin a specific node if multiple are connected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security + remote setup: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

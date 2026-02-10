---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Chrome extension: let OpenClaw drive your existing Chrome tab"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want the agent to drive an existing Chrome tab (toolbar button)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need remote Gateway + local browser automation via Tailscale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to understand the security implications of browser takeover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Chrome Extension"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Chrome extension (browser relay)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenClaw Chrome extension lets the agent control your **existing Chrome tabs** (your normal Chrome window) instead of launching a separate openclaw-managed Chrome profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Attach/detach happens via a **single Chrome toolbar button**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is (concept)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There are three parts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Browser control service** (Gateway or node): the API the agent/tool calls (via the Gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local relay server** (loopback CDP): bridges between the control server and the extension (`http://127.0.0.1:18792` by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Chrome MV3 extension**: attaches to the active tab using `chrome.debugger` and pipes CDP messages to the relay（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw then controls the attached tab through the normal `browser` tool surface (selecting the right profile).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install / load (unpacked)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the extension to a stable local path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser extension install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Print the installed extension directory path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser extension path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Chrome → `chrome://extensions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable “Developer mode”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Load unpacked” → select the directory printed above（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Pin the extension.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Updates (no build step)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The extension ships inside the OpenClaw release (npm package) as static files. There is no separate “build” step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After upgrading OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-run `openclaw browser extension install` to refresh the installed files under your OpenClaw state directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chrome → `chrome://extensions` → click “Reload” on the extension.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Use it (no extra config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships with a built-in browser profile named `chrome` that targets the extension relay on the default port.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw browser --browser-profile chrome tabs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent tool: `browser` with `profile="chrome"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a different name or a different relay port, create your own profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser create-profile \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --name my-chrome \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --driver extension \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --cdp-url http://127.0.0.1:18792 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --color "#00AA00"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Attach / detach (toolbar button)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open the tab you want OpenClaw to control.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Click the extension icon.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Badge shows `ON` when attached.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Click again to detach.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Which tab does it control?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- It does **not** automatically control “whatever tab you’re looking at”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- It controls **only the tab(s) you explicitly attached** by clicking the toolbar button.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To switch: open the other tab and click the extension icon there.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Badge + common errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ON`: attached; OpenClaw can drive that tab.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `…`: connecting to the local relay.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `!`: relay not reachable (most common: browser relay server isn’t running on this machine).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see `!`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Make sure the Gateway is running locally (default setup), or run a node host on this machine if the Gateway runs elsewhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open the extension Options page; it shows whether the relay is reachable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote Gateway (use a node host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local Gateway (same machine as Chrome) — usually **no extra steps**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway runs on the same machine as Chrome, it starts the browser control service on loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and auto-starts the relay server. The extension talks to the local relay; the CLI/tool calls go to the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Remote Gateway (Gateway runs elsewhere) — **run a node host**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your Gateway runs on another machine, start a node host on the machine that runs Chrome.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway will proxy browser actions to that node; the extension + relay stay local to the browser machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If multiple nodes are connected, pin one with `gateway.nodes.browser.node` or set `gateway.nodes.browser.mode`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sandboxing (tool containers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your agent session is sandboxed (`agents.defaults.sandbox.mode != "off"`), the `browser` tool can be restricted:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- By default, sandboxed sessions often target the **sandbox browser** (`target="sandbox"`), not your host Chrome.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chrome extension relay takeover requires controlling the **host** browser control server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Easiest: use the extension from a **non-sandboxed** session/agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Or allow host browser control for sandboxed sessions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowHostControl: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then ensure the tool isn’t denied by tool policy, and (if needed) call `browser` with `target="host"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Debugging: `openclaw sandbox explain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote access tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep the Gateway and node host on the same tailnet; avoid exposing relay ports to LAN or public Internet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pair nodes intentionally; disable browser proxy routing if you don’t want remote control (`gateway.nodes.browser.mode="off"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How “extension path” works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw browser extension path` prints the **installed** on-disk directory containing the extension files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The CLI intentionally does **not** print a `node_modules` path. Always run `openclaw browser extension install` first to copy the extension to a stable location under your OpenClaw state directory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you move or delete that install directory, Chrome will mark the extension as broken until you reload it from a valid path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security implications (read this)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is powerful and risky. Treat it like giving the model “hands on your browser”.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The extension uses Chrome’s debugger API (`chrome.debugger`). When attached, the model can:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - click/type/navigate in that tab（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - read page content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - access whatever the tab’s logged-in session can access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **This is not isolated** like the dedicated openclaw-managed profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If you attach to your daily-driver profile/tab, you’re granting access to that account state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommendations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer a dedicated Chrome profile (separate from your personal browsing) for extension relay usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep the Gateway and any node hosts tailnet-only; rely on Gateway auth + node pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid exposing relay ports over LAN (`0.0.0.0`) and avoid Funnel (public).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The relay blocks non-extension origins and requires an internal auth token for CDP clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser tool overview: [Browser](/tools/browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security audit: [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale setup: [Tailscale](/gateway/tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

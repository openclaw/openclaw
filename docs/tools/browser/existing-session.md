---
summary: "Named browser profiles and attaching to a running Chrome session through Chrome DevTools MCP"
title: "Multi-profile and existing-session attach"
read_when:
  - You want the agent to use your signed-in browser session
  - You are creating extra named browser profiles
  - You need the Chrome MCP launch overrides or the existing-session limits
---

## Profiles (multi-browser)

OpenClaw supports multiple named profiles (routing configs). Profiles can be:

- **openclaw-managed**: a dedicated Chromium-based browser instance with its own user data directory + CDP port
- **remote**: an explicit CDP URL (Chromium-based browser running elsewhere)
- **existing session**: your existing Chrome profile via Chrome DevTools MCP auto-connect

Defaults:

- The `openclaw` profile is auto-created if missing.
- The `user` profile is built-in for Chrome MCP existing-session attach.
- Existing-session profiles are opt-in beyond `user`; create them with `--driver existing-session`.
- Local CDP ports allocate from **18800-18899** by default.
- Deleting a profile moves its local data directory to Trash.

All control endpoints accept `?profile=<name>`; the CLI uses `--browser-profile`.

## Existing session via Chrome DevTools MCP

OpenClaw can also attach to a running Chromium-based browser profile through the
official Chrome DevTools MCP server. This reuses the tabs and login state
already open in that browser profile.

Official background and setup references:

- [Chrome for Developers: Use Chrome DevTools MCP with your browser session](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome DevTools MCP README](https://github.com/ChromeDevTools/chrome-devtools-mcp)

Built-in profile: `user`. Create your own custom existing-session profile if
you want a different name or browser data directory.

By default the built-in `user` profile uses Chrome MCP auto-connect, which
targets the default local Google Chrome profile. Use `userDataDir` for Brave,
Edge, Chromium, or a non-default Chrome profile. `~` expands to your OS home
directory:

```json5
{
  browser: {
    profiles: {
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
      },
    },
  },
}
```

Then in the matching browser:

1. Open that browser's inspect page for remote debugging.
2. Enable remote debugging.
3. Keep the browser running and approve the connection prompt when OpenClaw attaches.

Common inspect pages:

- Chrome: `chrome://inspect/#remote-debugging`
- Brave: `brave://inspect/#remote-debugging`
- Edge: `edge://inspect/#remote-debugging`

Live attach smoke test:

```bash
openclaw browser --browser-profile user start
openclaw browser --browser-profile user status
openclaw browser --browser-profile user tabs
openclaw browser --browser-profile user snapshot --format ai
```

What success looks like:

- `status` shows `driver: existing-session`
- `status` shows `transport: chrome-mcp`
- `status` shows `running: true`
- `tabs` lists your already-open browser tabs
- `snapshot` returns refs from the selected live tab

What to check if attach does not work:

- the target Chromium-based browser is version `144+`
- remote debugging is enabled in that browser's inspect page
- the browser showed and you accepted the attach consent prompt
- if Chrome was started with an explicit `--remote-debugging-port`, set
  `browser.profiles.<name>.cdpUrl` to that DevTools endpoint instead of relying
  on Chrome MCP auto-connect
- `openclaw doctor` migrates old extension-based browser config and checks that
  Chrome is installed locally for default auto-connect profiles, but it cannot
  enable browser-side remote debugging for you

For startup failures, check the `browser/chrome-mcp` logs for a bounded, redacted
tail of subprocess stderr when available.

Agent use:

- Use `profile="user"` when you need the user's logged-in browser state.
- If you use a custom existing-session profile, pass that explicit profile name.
- Only choose this mode when the user is at the computer to approve the attach
  prompt.
- The Gateway or node host can spawn `npx -y --audit=false chrome-devtools-mcp@1.8.0 --autoConnect`.

Notes:

- This path is higher-risk than the isolated `openclaw` profile because it can
  act inside your signed-in browser session.
- OpenClaw does not launch the browser for this driver; it only attaches.
- Stopping or failing an attach closes the owned MCP subprocess and its verified
  descendants, not the already-running browser. Replacement attaches wait for
  cleanup; if cleanup cannot be verified, OpenClaw reports an error instead of
  treating the session as closed.
- OpenClaw uses the official Chrome DevTools MCP `--autoConnect` flow here. If
  `userDataDir` is set, it is passed through to target that user data directory.
- Existing-session can attach on the selected host or through a connected
  browser node. If Chrome lives elsewhere and no browser node is connected, use
  remote CDP or a node host instead.
- Chrome MCP targets and snapshot refs are scoped to one MCP subprocess. After
  that process restarts, run `browser tabs` again, explicitly select a fresh
  target before target-specific work, and take a new snapshot before using refs.
  Each ref is valid only for its target and latest snapshot. Old aliases are not
  transferred to a replacement tab, even when its URL matches.
- Chrome DevTools MCP currently routes page tools by a process-local numeric page
  ID. Process-scoped handles prevent reuse across subprocess replacement, but an
  in-process browser-context replacement between adjacent tool calls can still
  retarget an action. Fully atomic routing requires upstream page-tool support
  for stable target IDs.

### Custom Chrome MCP launch

Override the spawned Chrome DevTools MCP server per profile when the default
`npx -y --audit=false chrome-devtools-mcp@1.8.0` flow is not what you want (offline hosts,
different versions, vendored binaries). OpenClaw pins the default server to the
version validated with its endpoint-policy parser. Custom executables and versions
are operator-managed and must preserve Chrome MCP's connection-argument semantics.

| Field        | What it does                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `mcpCommand` | Executable to spawn instead of `npx`. Resolved as-is; absolute paths are honored.                                               |
| `mcpArgs`    | Extra arguments passed unchanged to `mcpCommand`. Connection options override the generated endpoint or auto-connect arguments. |

Using `mcpArgs` does not replace the package prefix: when `mcpCommand` is `npx`,
OpenClaw still prepends `-y --audit=false chrome-devtools-mcp@1.8.0`. The optional npm
install audit is disabled so registry audit availability does not delay browser startup.

When `mcpArgs` does not set a connection option, OpenClaw forwards a configured
`cdpUrl` to Chrome MCP instead of generating `--autoConnect`:

- `http(s)://...` → `--browserUrl <url>` (DevTools HTTP discovery endpoint).
- `ws(s)://...` → `--wsEndpoint <url>` (direct CDP WebSocket).

Explicit endpoint arguments in `mcpArgs` override `cdpUrl`; adding
`--autoConnect` alongside an endpoint does not hide it. OpenClaw uses the selected
endpoint for CDP control and checks Browser CDP policy before starting Chrome MCP.
A matching `blockedHostnames` entry denies attachment even when private-network
access is trusted. Unrelated blocklist entries do not prevent attachment, and
the default strict-policy restrictions still apply.

Invalid, empty, duplicate, or conflicting endpoint arguments fail with an error
before launch. Supply one valid endpoint, or omit `cdpUrl` and endpoint arguments
to use host-local attachment.

When an endpoint is selected, `userDataDir` is ignored: Chrome MCP attaches to the
running browser behind that endpoint rather than opening a profile directory.

<Accordion title="Existing-session feature limitations">

Compared to the managed `openclaw` profile, existing-session drivers are more constrained:

- **Screenshots** - page captures and `--ref` element captures work; CSS `--element` selectors do not. Playwright is not required for page or ref-based element screenshots. (`--full-page` cannot combine with `--ref` or `--element` on any profile, not just existing-session.)
- **Actions** - `click`, `type`, `hover`, `scrollIntoView`, `drag`, and `select` require snapshot refs (no CSS selectors). `click-coords` clicks visible viewport coordinates and does not require a snapshot ref. `click` is left-button only (no button overrides or modifiers). `type` does not support `slowly=true`; use `fill` or `press`. `press` does not support `delayMs`. `type`, `hover`, `scrollIntoView`, `drag`, `select`, and `fill` do not support per-call `timeoutMs` overrides; `evaluate` does. `select` accepts a single value. `batch` is not supported; send actions individually.
- **Wait / upload / dialog** - `wait --url` supports exact, substring, and glob patterns (same as managed); `wait --load networkidle` is not supported on existing-session profiles (it works on managed and raw/remote CDP profiles). Upload hooks require `ref` or `inputRef` and do not support CSS `element`; pass multiple paths when the page's file input accepts multiple files. Dialog hooks do not support timeout overrides or `dialogId`.
- **Dialog visibility** - Managed browser action responses include `blockedByDialog` and `browserState.dialogs.pending` when an action opens a modal dialog; snapshots also include pending dialog state. Respond with `browser dialog --accept/--dismiss --dialog-id <id>` while a dialog is pending. Dialogs handled outside OpenClaw appear under `browserState.dialogs.recent`.
- **Playwright-only features** - PDF export, download interception, `responsebody`, and the agent actions `requests`, `errors`, `text`, and `emulate` require a Playwright-backed profile, such as the managed `openclaw` profile. Use `snapshot` to inspect an existing-session page.

</Accordion>

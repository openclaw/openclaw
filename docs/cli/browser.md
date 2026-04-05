---
summary: "CLI reference for `mullusi browser` (lifecycle, profiles, tabs, actions, state, and debugging)"
read_when:
  - You use `mullusi browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - You want to attach to your local signed-in Chrome via Chrome MCP
title: "browser"
---

# `mullusi browser`

Manage Mullusi's browser control surface and run browser actions (lifecycle, profiles, tabs, snapshots, screenshots, navigation, input, state emulation, and debugging).

Related:

- Browser tool + API: [Browser tool](/tools/browser)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (defaults to config).
- `--token <token>`: Gateway token (if required).
- `--timeout <ms>`: request timeout (ms).
- `--expect-final`: wait for a final Gateway response.
- `--browser-profile <name>`: choose a browser profile (default from config).
- `--json`: machine-readable output (where supported).

## Quick start (local)

```bash
mullusi browser profiles
mullusi browser --browser-profile mullusi start
mullusi browser --browser-profile mullusi open https://example.com
mullusi browser --browser-profile mullusi snapshot
```

## Lifecycle

```bash
mullusi browser status
mullusi browser start
mullusi browser stop
mullusi browser --browser-profile mullusi reset-profile
```

Notes:

- For `attachOnly` and remote CDP profiles, `mullusi browser stop` closes the
  active control session and clears temporary emulation overrides even when
  Mullusi did not launch the browser process itself.
- For local managed profiles, `mullusi browser stop` stops the spawned browser
  process.

## If the command is missing

If `mullusi browser` is an unknown command, check `plugins.allow` in
`~/.mullusi/mullusi.json`.

When `plugins.allow` is present, the bundled browser plugin must be listed
explicitly:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

`browser.enabled=true` does not restore the CLI subcommand when the plugin
allowlist excludes `browser`.

Related: [Browser tool](/tools/browser#missing-browser-command-or-tool)

## Profiles

Profiles are named browser routing configs. In practice:

- `mullusi`: launches or attaches to a dedicated Mullusi-managed Chrome instance (isolated user data dir).
- `user`: controls your existing signed-in Chrome session via Chrome DevTools MCP.
- custom CDP profiles: point at a local or remote CDP endpoint.

```bash
mullusi browser profiles
mullusi browser create-profile --name work --color "#FF5A36"
mullusi browser create-profile --name chrome-live --driver existing-session
mullusi browser create-profile --name remote --cdp-url https://browser-host.example.com
mullusi browser delete-profile --name work
```

Use a specific profile:

```bash
mullusi browser --browser-profile work tabs
```

## Tabs

```bash
mullusi browser tabs
mullusi browser tab new
mullusi browser tab select 2
mullusi browser tab close 2
mullusi browser open https://docs.mullusi.com
mullusi browser focus <targetId>
mullusi browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
mullusi browser snapshot
```

Screenshot:

```bash
mullusi browser screenshot
mullusi browser screenshot --full-page
mullusi browser screenshot --ref e12
```

Notes:

- `--full-page` is for page captures only; it cannot be combined with `--ref`
  or `--element`.
- `existing-session` / `user` profiles support page screenshots and `--ref`
  screenshots from snapshot output, but not CSS `--element` screenshots.

Navigate/click/type (ref-based UI automation):

```bash
mullusi browser navigate https://example.com
mullusi browser click <ref>
mullusi browser type <ref> "hello"
mullusi browser press Enter
mullusi browser hover <ref>
mullusi browser scrollintoview <ref>
mullusi browser drag <startRef> <endRef>
mullusi browser select <ref> OptionA OptionB
mullusi browser fill --fields '[{"ref":"1","value":"Ada"}]'
mullusi browser wait --text "Done"
mullusi browser evaluate --fn '(el) => el.textContent' --ref <ref>
```

File + dialog helpers:

```bash
mullusi browser upload /tmp/mullusi/uploads/file.pdf --ref <ref>
mullusi browser waitfordownload
mullusi browser download <ref> report.pdf
mullusi browser dialog --accept
```

## State and storage

Viewport + emulation:

```bash
mullusi browser resize 1280 720
mullusi browser set viewport 1280 720
mullusi browser set offline on
mullusi browser set media dark
mullusi browser set timezone Europe/London
mullusi browser set locale en-GB
mullusi browser set geo 51.5074 -0.1278 --accuracy 25
mullusi browser set device "iPhone 14"
mullusi browser set headers '{"x-test":"1"}'
mullusi browser set credentials myuser mypass
```

Cookies + storage:

```bash
mullusi browser cookies
mullusi browser cookies set session abc123 --url https://example.com
mullusi browser cookies clear
mullusi browser storage local get
mullusi browser storage local set token abc123
mullusi browser storage session clear
```

## Debugging

```bash
mullusi browser console --level error
mullusi browser pdf
mullusi browser responsebody "**/api"
mullusi browser highlight <ref>
mullusi browser errors --clear
mullusi browser requests --filter api
mullusi browser trace start
mullusi browser trace stop --out trace.zip
```

## Existing Chrome via MCP

Use the built-in `user` profile, or create your own `existing-session` profile:

```bash
mullusi browser --browser-profile user tabs
mullusi browser create-profile --name chrome-live --driver existing-session
mullusi browser create-profile --name brave-live --driver existing-session --user-data-dir "~/Library/Application Support/BraveSoftware/Brave-Browser"
mullusi browser --browser-profile chrome-live tabs
```

This path is host-only. For Docker, headless servers, Browserless, or other remote setups, use a CDP profile instead.

Current existing-session limits:

- snapshot-driven actions use refs, not CSS selectors
- `click` is left-click only
- `type` does not support `slowly=true`
- `press` does not support `delayMs`
- `hover`, `scrollintoview`, `drag`, `select`, `fill`, and `evaluate` reject
  per-call timeout overrides
- `select` supports one value only
- `wait --load networkidle` is not supported
- file uploads require `--ref` / `--input-ref`, do not support CSS
  `--element`, and currently support one file at a time
- dialog hooks do not support `--timeout`
- screenshots support page captures and `--ref`, but not CSS `--element`
- `responsebody`, download interception, PDF export, and batch actions still
  require a managed browser or raw CDP profile

## Remote browser control (node host proxy)

If the Gateway runs on a different machine than the browser, run a **node host** on the machine that has Chrome/Brave/Edge/Chromium. The Gateway will proxy browser actions to that node (no separate browser control server required).

Use `gateway.nodes.browser.mode` to control auto-routing and `gateway.nodes.browser.node` to pin a specific node if multiple are connected.

Security + remote setup: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)

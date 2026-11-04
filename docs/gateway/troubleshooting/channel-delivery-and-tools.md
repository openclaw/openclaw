---
summary: "Channels that connect but do not deliver, automation delivery, and node or browser tool failures"
title: "Channel delivery and tools"
sidebarTitle: "Channel delivery and tools"
read_when:
  - A channel is connected but messages are not flowing
  - Automation deliveries do not arrive
  - A paired node fails on tool calls, or the browser tool fails
---

## Channel connected, messages not flowing

If channel state is connected but message flow is dead, focus on policy, permissions, and channel specific delivery rules.

```bash
openclaw channels status --probe
openclaw pairing list --channel <channel> [--account <id>]
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Look for:

- DM policy (`pairing`, `allowlist`, `open`, `disabled`).
- Group allowlist and mention requirements.
- Missing channel API permissions/scopes.

Common signatures:

- `mention required` → message ignored by group mention policy.
- `pairing` / pending approval traces → sender is not approved.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → channel auth/permissions issue.

Related:

- [Channel troubleshooting](/channels/troubleshooting)
- [Discord](/channels/discord)
- [Telegram](/channels/telegram)
- [WhatsApp](/channels/whatsapp)

<a id="cron-and-heartbeat-delivery" />

## Automation delivery

If a scheduled job did not run or deliver, inspect its state and run history,
then its delivery destination:

```bash
openclaw automations status
openclaw automations list --all
openclaw automations show <jobId>
openclaw automations runs <jobId> --limit 20
openclaw logs --follow
```

Check that scheduling is enabled and the job has a next run. Its own
`activeHours`, `idleOnly`, and `payload.skipIfScratchEmpty` policies can prevent
an immediate start. Empty scratch means an explicitly stored checklist containing
only blank lines, comments, headings, fence markers, or empty checklist stubs;
missing scratch does not skip the run.

`cron: scheduler disabled; jobs will not run automatically` means the scheduler
is disabled. `Automation migration is incomplete; run openclaw doctor --fix`
means Doctor still has work to finish before the converted job can run. A
`cron: timer tick failed` error needs inspection of the accompanying runtime or
storage error.

A missing owner DM no longer skips execution: ordinary automation delivery
records the unavailable route. Review the job's channel, account, and owner or
explicit recipient. `delivery.directPolicy: "block"` intentionally suppresses
DM delivery; a successful quiet result is also distinct from a delivery failure.
Do not restore retired `agents.defaults.heartbeat` settings to repair the job.

A session event rejected by ordinary admission reports the reason. Resolve it
before submitting another event, since a failed turn may already have performed
work. Outbound messages already held by the durable delivery queue retain their
own recovery policy.

Related:

- [Heartbeat migration](/gateway/heartbeat)
- [Automations](/automation/cron-jobs)
- [Automation troubleshooting](/automation/cron-jobs#troubleshooting)

## Node paired, tool fails

If a node is paired but tools fail, isolate foreground, permission, and approval state.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Look for:

- Node online with expected capabilities.
- OS permission grants for camera/mic/location/screen.
- Exec approvals and allowlist state.

Common signatures:

- `NODE_BACKGROUND_UNAVAILABLE` → node app must be in foreground.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → missing OS permission.
- `SYSTEM_RUN_DENIED: approval required` → exec approval pending.
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist.

Related:

- [Exec approvals](/tools/exec-approvals)
- [Node troubleshooting](/nodes/troubleshooting)
- [Nodes](/nodes/index)

## Browser tool fails

Use when browser tool actions fail even though the gateway itself is healthy.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Look for:

- Whether `plugins.allow` is set and includes `browser`.
- Valid browser executable path.
- CDP profile reachability.
- Local Chrome availability for `existing-session` / `user` profiles.

<AccordionGroup>
  <Accordion title="Plugin / executable signatures">
    - `unknown command "browser"` or `unknown command 'browser'` → the bundled browser plugin is excluded by `plugins.allow`.
    - Browser tool missing / unavailable while `browser.enabled=true` → `plugins.allow` excludes `browser`, so the plugin never loaded.
    - `Failed to start Chrome CDP on port` → browser process failed to launch.
    - `browser.executablePath not found` → configured path is invalid.
    - `browser.cdpUrl must be http(s) or ws(s)` → the configured CDP URL uses an unsupported scheme such as `file:` or `ftp:`.
    - `browser.cdpUrl has invalid port` → the configured CDP URL has a bad or out-of-range port.
    - `Playwright is not available in this gateway build; '<feature>' is unsupported.` → the current gateway install lacks the core browser runtime dependency; reinstall or update OpenClaw, then restart the gateway. ARIA snapshots and basic page screenshots can still work, but navigation, AI snapshots, CSS-selector element screenshots, and PDF export stay unavailable.

  </Accordion>
  <Accordion title="Chrome MCP / existing-session signatures">
    - `Could not find DevToolsActivePort for chrome` → Chrome MCP existing-session could not attach to the selected browser data dir yet. Open the browser inspect page, enable remote debugging, keep the browser open, approve the first attach prompt, then retry. If signed-in state is not required, prefer the managed `openclaw` profile.
    - `No browser tabs found for profile="user"` → the Chrome MCP attach profile has no open local Chrome tabs.
    - `Remote CDP for profile "<name>" is not reachable` → the configured remote CDP endpoint is not reachable from the gateway host.
    - `Browser attachOnly is enabled ... not reachable` or `Browser attachOnly is enabled and CDP websocket ... is not reachable` → attach-only profile has no reachable target, or the HTTP endpoint answered but the CDP WebSocket still could not be opened.

  </Accordion>
  <Accordion title="Element / screenshot / upload signatures">
    - `fullPage is not supported for element screenshots` → screenshot request mixed `--full-page` with `--ref` or `--element`.
    - `element screenshots are not supported for existing-session profiles; use ref from snapshot.` → Chrome MCP / `existing-session` screenshot calls must use page capture or a snapshot `--ref`, not CSS `--element`.
    - `existing-session file uploads do not support element selectors; use ref/inputRef.` → Chrome MCP upload hooks need snapshot refs, not CSS selectors.
    - `existing-session file uploads currently support one file at a time.` → send one upload per call on Chrome MCP profiles.
    - `existing-session dialog handling does not support timeoutMs.` → dialog hooks on Chrome MCP profiles do not support timeout overrides.
    - `existing-session type does not support timeoutMs overrides.` → omit `timeoutMs` for `act:type` on `profile="user"` / Chrome MCP existing-session profiles, or use a managed/CDP browser profile when a custom timeout is required.
    - `response body is not supported for existing-session profiles yet.` → `responsebody` still requires a managed browser or raw CDP profile.
    - Stale viewport / dark-mode / locale / offline overrides on attach-only or remote CDP profiles → run `openclaw browser stop --browser-profile <name>` to close the active control session and release Playwright/CDP emulation state without restarting the whole gateway.

  </Accordion>
</AccordionGroup>

Related:

- [Browser (OpenClaw-managed)](/tools/browser)
- [Browser troubleshooting](/tools/browser-linux-troubleshooting)

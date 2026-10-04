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

If a scheduled job did not run or deliver, verify scheduler state first, then
the job's execution policy and delivery target. Former heartbeat monitors are
ordinary jobs after [Doctor migration](/gateway/heartbeat).

```bash
openclaw automations status
openclaw automations list --all
openclaw automations show <jobId>
openclaw automations runs <jobId> --limit 20
openclaw logs --follow
```

Look for:

- Cron enabled and next wake present.
- Job run history status (`ok`, `skipped`, `error`).
- The job's active-hours window, idle-only policy, scratch, and resolved delivery diagnostics.

<AccordionGroup>
  <Accordion title="Common signatures">
    - `cron: scheduler disabled; jobs will not run automatically` → cron disabled.
    - `cron: timer tick failed` → scheduler tick failed; check file/log/runtime errors.
    - A skipped run outside its active-hours window → check the job's timezone and start/end times. Manual force-runs still respect the window.
    - `Automation deferred while its agent is busy` → the job's `idleOnly` policy gave foreground work priority.
    - `Automation scratch is explicitly empty` → `skipIfScratchEmpty` is enabled and scratch contains only blank, comment, heading, fence, or empty-checklist scaffolding. Missing scratch is different and does not suppress a run.
    - `Owner delivery unavailable` → owner targeting could not resolve a permitted DM. Check `commands.ownerAllowFrom`, channel `allowFrom`, the selected account, and `delivery.directPolicy`. A `block` policy prevents owner DM delivery.
    - A missing last-conversation route → select a concrete channel target or configure owner delivery instead.

  </Accordion>
</AccordionGroup>

Related:

- [Heartbeat migration](/gateway/heartbeat)
- [Scheduled tasks](/automation/cron-jobs)
- [Scheduled tasks: troubleshooting](/automation/cron-jobs#troubleshooting)

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

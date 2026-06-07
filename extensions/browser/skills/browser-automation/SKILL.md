---
name: browser-automation
description: Use when controlling web pages with the OpenClaw browser tool, including multi-step flows, login checks, Chrome MCP capability boundaries, tab management, or stale refs/timeouts.
user-invocable: false
---

# Browser Automation

Use this skill when you need the `browser` tool for anything beyond a single page check, including dynamic pages, signed-in sessions, screenshots, UI actions, console/network inspection, Chrome MCP diagnostics, Lighthouse, screencasts, heap snapshots, extension surfaces, or WebMCP/page-provided tool surfaces.

For public information lookup or a one-shot page read, prefer `web_search` or `web_fetch`. Use `browser` when page state, login state, JavaScript, visual layout, files, dialogs, or interaction matters.

## Operating Loop

1. Check browser state before acting:
   - `openclaw browser doctor` or `action="status"` when the browser/plugin setup itself may be broken.
   - `action="status"` for availability.
   - `action="profiles"` if login state or profile choice matters.
   - `action="tabs"` before opening a new tab if retries/timeouts may have left windows behind.
2. Prefer stable tab handles:
   - Open important tabs with `label`, for example `label="meet"`.
   - After `action="tabs"` or `action="open"`, store `suggestedTargetId` and pass it as `targetId` in later calls.
   - `suggestedTargetId` is the label when one exists, otherwise the stable `tabId` handle like `t1`.
   - Avoid relying on raw DevTools `targetId` except for immediate diagnostics; it can change under Chromium target replacement.
3. Read before you click:
   - Use `action="snapshot"` on the intended `targetId`.
   - Use the same `targetId` for follow-up actions so refs stay on the same tab.
   - For durable Playwright refs, request `refs="aria"` when supported. If you receive `axN` refs from `snapshotFormat="aria"`, use them only after that same snapshot call; stale or unbound `axN` refs fail fast and need a fresh snapshot.
   - Use `urls=true` when link text is ambiguous or a direct navigation target would avoid brittle clicks.
   - Use `labels=true` on snapshot or screenshot when visual position matters.
4. Act narrowly:
   - Prefer `action="act"` with a ref from the latest snapshot.
   - After navigation, modal changes, or form submission, snapshot again before the next action.
   - Avoid blind waits. Wait for visible UI state when possible.
5. Report real blockers:
   - If the page needs login, permission, captcha, 2FA, camera/microphone approval, or another manual step, stop and tell the user exactly what is needed.
   - Do not claim the browser is not logged in just because the current page shows a permission or onboarding dialog. Inspect the visible UI first.

## Tab Hygiene

Before creating a tab for a named task, list tabs and reuse an existing matching label or URL when it is still usable.

Example:

```json
{ "action": "tabs" }
```

If no suitable tab exists:

```json
{ "action": "open", "url": "https://example.com", "label": "task" }
```

Then target it by label:

```json
{ "action": "snapshot", "targetId": "task", "refs": "aria" }
```

If a retry creates duplicates, close the extras by `tabId`:

```json
{ "action": "close", "targetId": "t3" }
```

Do not pass bare numbers like `"2"` as `targetId`. Numeric tab positions are only for the CLI `openclaw browser tab select 2` helper; browser tool calls need a `suggestedTargetId`, label, `tabId`, or raw target id.

## Stale Ref Recovery

If an action fails with a missing or stale ref:

1. Snapshot the same `targetId` again.
2. Find the current visible control.
3. Retry once with the new ref.
4. If the UI moved to a blocker state, report the blocker instead of looping.

## Existing User Browser

Use `profile="user"` only when existing cookies/login matter. This attaches to the user's running Chromium-based browser.

For `profile="user"` and other existing-session profiles, omit `timeoutMs` on `act:type`, `evaluate`, `hover`, `scrollIntoView`, `drag`, `select`, and `fill`; that driver rejects per-call timeout overrides for those actions.

## Profile Choice For Advanced Work

Choose the least-private profile that can do the job:

- Use `openclaw` for normal page automation, screenshots, forms, and visual proof. It is isolated from the user's personal browser.
- Use a dedicated OpenClaw-owned existing-session profile, such as `agent-chrome`, for Chrome MCP diagnostics, Lighthouse, screencast, heap snapshots, extension inventory, or other advanced Chrome MCP work when existing personal cookies are not required.
- Use `profile="user"` only for tasks that truly need the user's current signed-in Chrome cookies. Treat this as privacy-sensitive and inspect only the requested target.

Before advanced work, prove the selected profile with `doctor`, `status`, and `tabs`. If `doctor` reports missing `DevToolsActivePort`, a refused remote-debugging port, a profile lock, or a disabled capability, stop and report the blocker plus the config/profile path instead of trying another profile silently.

## Chrome MCP Capability Boundaries

Existing-session profiles can expose enhanced Chrome MCP actions such as `console-message`, `request-detail`, `trace`, `heap-snapshot`, `lighthouse`, `screencast`, `extensions`, `third-party-tools`, and `web-mcp-tools`.

Treat these as higher-risk because they can expose private browser state or mutate the attached profile:

- Prefer the isolated `openclaw` profile unless the task needs existing login/cookies.
- Prefer a dedicated OpenClaw-owned existing-session profile for advanced Chrome MCP capability proof when personal cookies are not required.
- Use a signed-in or personal profile only for the requested target; avoid unrelated tabs and private content.
- If a route reports a disabled Chrome MCP capability, do not work around it. Report the config path and stop for the next approval gate.
- Extension mutation and page-provided tool execution require explicit opt-in on trusted automation profiles.
- Browser config/profile changes, remote CDP token setup, Gateway restarts, external submits/sends/purchases/deletes, and public PR actions require an exact approval boundary.

Relevant policy paths include `browser.chromeMcp.capabilities.*` and per-profile `browser.profiles.<name>.chromeMcp.capabilities.*`. Verify current docs/source/config before asserting exact defaults.

## Capability Proof

When asked whether enhanced web capabilities work, verify current state instead of relying on memory. Report the selected profile, tool state, commands or tests run, pass/fail counts, artifact paths, and what was not done.

## Google Meet Notes

When creating or joining a Meet:

- Treat camera/microphone permission screens as progress, not login failure.
- If asked whether people can hear you, click the microphone option when voice is required.
- If Google asks for sign-in, 2FA, account chooser confirmation, or permission that needs user approval, report the exact manual action.
- Use one labeled tab per meeting flow, for example `label="meet"`, and reuse it during retries.

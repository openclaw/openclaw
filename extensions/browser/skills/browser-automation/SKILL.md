---
name: browser-automation
description: Use when controlling web pages with the OpenClaw browser tool, especially multi-step flows, login checks, tab management, or recovery from stale refs/timeouts.
user-invocable: false
---

# Browser Automation

Use this skill when you need the `browser` tool for anything beyond a single page check.

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

## Secrets From Environment Variables

When you must type a credential (password, API key, account login) into a page,
do not write the secret literally. Instead reference an environment variable
with the `{{env:KEY}}` placeholder anywhere you supply a value — the `type`
text, a `fill` field value, or a `select` value. The browser substitutes the
real value of `KEY` just before typing, so the secret never appears in your
context or the transcript; you only ever see `{{env:KEY}}`.

```json
{ "action": "type", "ref": "e7", "text": "{{env:INVITATIONS_ADMIN_PASSWORD}}" }
```

Only variables on the SecretRef env allowlist
(`secrets.providers.<env>.allowlist`) can be referenced; an unknown or unset
variable fails the action rather than typing the literal placeholder. Values
typed this way are also scrubbed from later page snapshots.

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

## Google Meet Notes

When creating or joining a Meet:

- Treat camera/microphone permission screens as progress, not login failure.
- If asked whether people can hear you, click the microphone option when voice is required.
- If Google asks for sign-in, 2FA, account chooser confirmation, or permission that needs user approval, report the exact manual action.
- Use one labeled tab per meeting flow, for example `label="meet"`, and reuse it during retries.

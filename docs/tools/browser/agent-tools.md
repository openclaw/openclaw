---
summary: "The single browser tool, its actions, and the arguments an agent passes"
title: "Browser agent tools"
read_when:
  - You need the list of browser tool actions
  - You are writing agent tool arguments for the browser
  - You need the sandbox and node targeting rules
---

The agent gets **one tool** for browser automation:

- `browser` - doctor/status/start/stop/tabs/open/focus/close/snapshot/screenshot/navigate/act/requests/errors/text/emulate

How it maps:

- `browser snapshot` returns a stable UI tree (AI or ARIA).
- Snapshot `query` keeps lines containing **all** whitespace-separated query tokens, ignoring case. Matching lines retain element refs; the result reports the match count and respects `maxChars`. It searches the returned snapshot, so increase the snapshot scope if the source was truncated.
- `browser requests` reads the collected network log. Optional `filter` matches a substring in the URL or resource type; `limit` keeps the most recent entries (default 50). Results report `total` matching collected requests and `returned` entries; the output budget may reduce that count further. `clear=true` clears the entire collected log after reading, including entries omitted by filtering or limits.
- `browser errors` reads collected page errors. `limit` keeps the most recent entries (default 50). Results report `total` collected errors and `returned` entries; the output budget may reduce that count further. `clear=true` clears the entire collected log after reading, including entries omitted by limits. Page errors remain untrusted external content.
- `browser text` extracts visible prose using the first explicit `selector` match, otherwise the first `article`, `main`, or `body`. `maxChars` must be positive; it defaults to and cannot exceed 40,000 characters. The tool's output budget may truncate further. Page text remains untrusted external content.
- `browser emulate` applies one or more of `device` (a Playwright device name), `colorScheme` (`dark`, `light`, `no-preference`, or `none` to clear), `timezoneId`, and `locale`. Settings apply in that order and return an `applied` list; they are not atomic. These four actions support local and node targets but not Chrome MCP existing-session profiles.
- `browser navigate` also returns the loaded page's snapshot inline (efficient
  interactive tier, so the payload stays compact and bounded), so the agent
  does not need a follow-up snapshot call. Batch `act` results that report a
  cross-document navigation include the same fresh page state. Navigations
  that resolve to a download skip it.
- `browser act` uses the snapshot `ref` IDs to click/type/drag/select.
- `browser screenshot` captures pixels (full page, element, or labeled refs).
- If a screenshot times out while the browser is still capturing or restoring
  page settings, further screenshots, resizing, and device changes on that tab
  return a recovery error. Retry after the capture finishes. If it stays stuck,
  close and reopen the affected tab; other tabs remain available.
- `browser doctor` checks Gateway, plugin, profile, browser, and tab readiness.
- `browser` accepts:
  - `profile` to choose a named browser profile (openclaw, chrome, or remote CDP).
  - `target` (`sandbox` | `host` | `node`) to select where the browser lives.
  - In sandboxed sessions, `target: "host"` requires `agents.defaults.sandbox.browser.allowHostControl=true`.
  - If `target` is omitted: sandboxed sessions default to `sandbox`, non-sandbox sessions default to `host`.
  - If a browser-capable node is connected, the tool may auto-route to it unless you pin `target="host"` or `target="node"`.

This keeps the agent deterministic and avoids brittle selectors.

Example agent tool arguments (reuse a `targetId` from `tabs` or `open`):

```json
{ "action": "requests", "targetId": "t1", "filter": "fetch", "limit": 20, "clear": true }
```

```json
{ "action": "text", "targetId": "t1", "selector": "article", "maxChars": 6000 }
```

```json
{ "action": "snapshot", "targetId": "t1", "query": "sign in", "maxChars": 4000 }
```

```json
{
  "action": "emulate",
  "targetId": "t1",
  "device": "iPhone 15",
  "colorScheme": "dark",
  "timezoneId": "America/New_York",
  "locale": "en-US"
}
```

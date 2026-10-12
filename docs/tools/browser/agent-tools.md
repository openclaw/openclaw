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
  When a captured control disappears, its bound ref fails. Take a new snapshot
  before retrying the action.
- `browser screenshot` captures pixels (full page, element, or labeled refs).
- If a screenshot times out while the browser is still capturing or restoring
  page settings, further screenshots, resizing, and device changes on that tab
  return a recovery error. Retry after the capture finishes. If it stays stuck,
  close and reopen the affected tab; other tabs remain available.
- `browser doctor` checks Gateway, plugin, profile, browser, and tab readiness.
- `browser` accepts:
  - `profile` to choose a named browser profile (openclaw, chrome, or remote CDP).
  - `target` (`sandbox` | `host` | `node`) to select where the browser lives.
  - Omit `target` and `node` to use configured routing. When a sandbox browser bridge is available, managed profiles use it. Without a sandbox bridge, an enabled `gateway.nodes.browser.node` pin selects that node, including in manual routing mode; an unavailable pinned node fails rather than switching to the host.
  - Without a pin, automatic routing prefers an available host browser and can select a single connected browser node when node routing is available. Manual routing without a pin and disabled node routing use the host. Standalone runs use the host unless a Gateway or node route is selected; see [Remote and hosted browsers](/tools/browser/remote#node-browser-proxy-zero-config-default).
  - Explicit `target="host"` selects the Gateway host and bypasses configured node routing. Explicit `target="node"` or a `node` selector requests node routing; `gateway.nodes.browser.mode="off"` rejects it.
  - In sandboxed sessions, both host and node control require `agents.defaults.sandbox.browser.allowHostControl=true`. Existing-session profiles cannot use the sandbox browser. When a bridge is available, they use the host unless a node is explicitly selected, subject to the same host-control policy.
  - With an enabled node pin, no sandbox bridge, and host control allowed, the tool description identifies the configured node as the default. Other configurations retain the existing tool description; the guidance does not depend on live node connectivity.

This lets the agent reuse captured element references instead of brittle selectors.

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

For a [Browser dashboard](/web/dashboards#share-a-browser-dashboard-with-your-agent),
use its stable widget name instead of a tab ID:

```json
{ "action": "snapshot", "dashboard": "service-status", "refs": "aria" }
```

The `dashboard` selector applies to the current session. Create the saved
`browser:dashboard` widget with the `dashboard` tool first; its props choose
the URL and optional managed profile. `browser` resolves the same page shown
in the dashboard for snapshots, clicks, typing, and navigation. Do not combine
the selector with an explicit profile, node, or target ID. `open` explicitly
resumes a stopped dashboard, and `close` stops its running browser. Other
actions leave a stopped dashboard stopped. Ordinary raw-tab closing cannot
close a dashboard-owned tab.

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

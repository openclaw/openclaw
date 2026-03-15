---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### Page discovery

```bash
scripts/cdp.mjs list                           # list open pages
scripts/cdp.mjs info    <target>               # page state: URL, title, viewport, scroll, focus, forms, iframes
```

Run `info` first to orient yourself on any page.

### Reading

```bash
scripts/cdp.mjs snap    <target> [selector]    # accessibility tree (full page or scoped to selector)
scripts/cdp.mjs text    <target> [selector]    # text content (innerText, not HTML) — much cheaper than html
scripts/cdp.mjs html    <target> [selector]    # full page or element HTML
scripts/cdp.mjs eval    <target> <expr>        # evaluate JS expression
scripts/cdp.mjs shot    <target> [file]        # screenshot (default: /tmp/screenshot.png)
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs console <target> [count]       # last N console messages (default 20) — useful for debugging JS errors
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them. Collect all data in one `eval` or use stable selectors.

### Navigation

```bash
scripts/cdp.mjs nav     <target> <url>         # navigate to URL and wait for load
scripts/cdp.mjs back    <target>               # browser back and wait for load
scripts/cdp.mjs forward <target>               # browser forward and wait for load
scripts/cdp.mjs reload  <target>               # reload page and wait for load
scripts/cdp.mjs scroll  <target> [direction]   # scroll: down (default), up, top, bottom
```

### Interaction

```bash
scripts/cdp.mjs click   <target> <selector>       # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>           # click at CSS pixel coords
scripts/cdp.mjs hover   <target> <selector>        # hover element (triggers :hover CSS and mouse events)
scripts/cdp.mjs focus   <target> <selector>        # focus element (no click side effects)
scripts/cdp.mjs clear   <target> <selector>        # clear input/textarea/contenteditable (React-compatible)
scripts/cdp.mjs type    <target> <text>             # type text at current focus (works in cross-origin iframes)
scripts/cdp.mjs key     <target> <key>              # key press: Enter, Tab, Escape, Backspace, ArrowDown, etc.
scripts/cdp.mjs select  <target> <selector> <value> # pick <select> option by value or visible text
```

### Waiting

```bash
scripts/cdp.mjs wait     <target> <selector> [ms]  # wait for element to appear (default 10s)
scripts/cdp.mjs waitgone <target> <selector> [ms]  # wait for element to disappear (default 10s)
scripts/cdp.mjs loadall  <target> <selector> [ms]  # click "load more" until gone (1500ms interval, 5min cap)
```

### Advanced

```bash
scripts/cdp.mjs evalraw <target> <method> [json]   # raw CDP command passthrough
scripts/cdp.mjs stop    [target]                    # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- Run `info` after every action to confirm state changes.
- Prefer `snap` over `html` for page structure. Use `snap <target> <selector>` to scope to a subtree and save tokens on large pages.
- Use `text` instead of `html` when you only need the content — much cheaper in tokens.
- **Form filling pattern:** `focus` → `clear` → `type` → `key Tab` (or `key Enter` to submit). The `clear` command uses native property setters so it works with React/framework-controlled inputs.
- `select` matches by value first, then by visible text. On failure it lists all available options so you can self-correct.
- Use `hover` for dropdown menus and tooltip reveals.
- Use `waitgone` after actions that trigger loading spinners or toast notifications.
- Use `console` to check for JS errors when something isn't working.
- Use `type` (not eval) to enter text in cross-origin iframes — `focus` first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.

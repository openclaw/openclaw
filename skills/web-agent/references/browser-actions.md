# Browser Tool — Action Reference

## Top-level Actions

| Action       | Purpose          | Key Parameters                           |
| ------------ | ---------------- | ---------------------------------------- |
| `navigate`   | URL navigation   | `targetUrl`                              |
| `snapshot`   | DOM capture      | `refs="aria"`, `compact`, `element`      |
| `screenshot` | Visual capture   | `fullPage`, `type`                       |
| `act`        | Composite action | `request: { kind, ref, text, key, ... }` |

## act request kinds

- **click**: `{ kind: "click", ref: "e12" }` — double-click: `doubleClick: true`
- **type**: `{ kind: "type", ref: "e15", text: "query", submit: true }` — submit=true includes Enter
- **press**: `{ kind: "press", key: "Enter" }` — keyboard input
- **fill**: `{ kind: "fill", ref: "e15", text: "value" }` — set field value
- **hover**: `{ kind: "hover", ref: "e12" }` — mouse over
- **select**: `{ kind: "select", ref: "e20", values: ["option1"] }` — dropdown
- **wait**: `{ kind: "wait", timeMs: 2000 }` — wait (exceptional use only)
- **evaluate**: `{ kind: "evaluate", fn: "() => document.title" }` — JS execution

## Tips

- `targetId` — reuse from snapshot response when working in the same tab
- `profile="openclaw"` — isolated managed browser
- `profile="chrome"` — Chrome Extension Relay (access user's tabs)
- `refs="aria"` — stable element references across snapshots

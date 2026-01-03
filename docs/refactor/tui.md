---
summary: "Refactor plan: Gateway TUI parity with pi-mono interactive UI"
read_when:
  - Building or refactoring the Gateway TUI
  - Syncing TUI slash commands with Clawdis behavior
---
# Gateway TUI refactor plan

Updated: 2026-01-03

## Goals
- Match pi-mono interactive TUI feel (editor, streaming, tool cards, selectors).
- Keep Clawdis semantics: Gateway WS only, session store owns state, no branching/export.
- Work locally or remotely via Gateway URL/token.

## Non-goals
- Branching, export, OAuth flows, or hook UIs.
- File-system operations on the Gateway host from the TUI.

## Checklist
- [x] Protocol + server: sessions.patch supports model overrides; agent events include tool results (text-only payloads).
- [x] Gateway TUI client: add session/model helpers + stricter typing.
- [ ] TUI UI kit: theme + components (editor, message feed, tool cards, selectors).
- [ ] TUI controller: keybindings + Clawdis slash commands + history/stream wiring.
- [ ] Docs + changelog updated for the new TUI behavior.
- [ ] Gate: lint, build, tests, docs list.

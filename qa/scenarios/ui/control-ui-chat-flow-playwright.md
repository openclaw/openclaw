# Control UI chat flow Playwright coverage

```yaml qa-scenario
id: control-ui-chat-flow-playwright
title: Control UI chat flow Playwright coverage
surface: control-ui
coverage:
  primary:
    - ui.control
objective: Link the Control UI chat-flow Playwright suite to the QA coverage inventory.
successCriteria:
  - Playwright covers the hosted Control UI chat surface.
docsRefs:
  - docs/web/control-ui.md
codeRefs:
  - ui/src/ui/e2e/chat-flow.e2e.test.ts
execution:
  kind: playwright
  path: ui/src/ui/e2e/chat-flow.e2e.test.ts
  summary: Playwright coverage for the Control UI chat flow.
```

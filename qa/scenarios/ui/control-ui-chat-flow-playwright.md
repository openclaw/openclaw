# Control UI chat flow Playwright coverage

```yaml qa-scenario
id: control-ui-chat-flow-playwright
title: Control UI chat flow Playwright coverage
surface: ui
coverage:
  primary:
    - gateway-hosted-ui
    - chat-send-lifecycle
objective: Link the Control UI chat-flow Playwright suite to the taxonomy features it proves.
successCriteria:
  - Playwright covers the hosted Control UI chat surface.
  - Playwright covers WebChat send lifecycle behavior.
docsRefs:
  - docs/web/control-ui.md
codeRefs:
  - ui/src/ui/e2e/chat-flow.e2e.test.ts
execution:
  kind: playwright
  path: ui/src/ui/e2e/chat-flow.e2e.test.ts
  summary: Native Playwright coverage for the Control UI chat flow.
```

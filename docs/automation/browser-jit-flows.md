---
summary: "Natural-language-to-browser-flow workflow with Playwright artifacts and self-debug loops"
read_when:
  - Creating browser automations from product flows
  - Debugging flaky SaaS or dashboard workflows
  - Adding JiT browser checks for a pull request
title: "Browser JiT Flows"
---

# Browser JiT Flows

Use this pattern for the loop: spec -> browser flow -> run -> artifacts -> fix -> rerun.

## Flow Specs

Keep human-readable intent near machine-runnable steps:

```json
{
  "name": "openclaw-dashboard-smoke",
  "description": "Smoke-check the local OpenClaw dashboard with a real browser.",
  "steps": [
    { "action": "goto", "url": "/" },
    { "action": "screenshot", "name": "dashboard" },
    { "action": "assertText", "selector": "body", "text": "OpenClaw" }
  ]
}
```

Supported step actions are `goto`, `click`, `fill`, `press`, `waitForSelector`, `assertText`, and `screenshot`.

## Run

```bash
pnpm browser:flow -- --spec automation/browser-flows/openclaw-dashboard-smoke.json
```

Use `PLAYWRIGHT_BASE_URL` or `--base-url` to target another environment. Use
`PLAYWRIGHT_CHROME_EXECUTABLE` when the default Chrome path is not available.

## Artifacts

Each run writes to `.artifacts/playwright-flows/<timestamp-flow>/`:

- `result.json`
- `trace.zip`
- screenshots
- videos when supported by the local browser

On failure, inspect `*-failure.png` and `trace.zip`, update the selector or app behavior, and rerun the same spec.

## Agent Rules

- Prefer stable role/text/data-testid selectors.
- Keep flows sequential while debugging.
- Store credentials outside flow specs.
- Never use browser flows to publish, purchase, send, delete, merge, or change credentials without a human checkpoint.

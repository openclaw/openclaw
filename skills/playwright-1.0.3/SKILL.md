---
name: Playwright (Automation + MCP + Scraper)
slug: playwright
version: 1.0.3
homepage: https://clawic.com/skills/playwright
description: "Browser automation via Playwright MCP. Navigate websites, click elements, fill forms, take screenshots, extract data, and debug real browser workflows. Use when (1) you need a real browser, not static fetch; (2) the task involves Playwright MCP, browser tools, Playwright tests, scripts, or JS-rendered pages; (3) the user wants navigation, forms, screenshots, PDFs, downloads, or browser-driven extraction turned into a reliable outcome."
changelog: Clarified the MCP-first browser automation flow and improved quick-start guidance for forms, screenshots, and extraction.
metadata:
  {
    "clawdbot":
      {
        "emoji": "P",
        "requires": { "bins": ["node", "npx"] },
        "os": ["linux", "darwin", "win32"],
        "install":
          [
            {
              "id": "npm-playwright",
              "kind": "npm",
              "package": "playwright",
              "bins": ["playwright"],
              "label": "Install Playwright",
            },
            {
              "id": "npm-playwright-mcp",
              "kind": "npm",
              "package": "@playwright/mcp",
              "bins": ["playwright-mcp"],
              "label": "Install Playwright MCP (optional)",
            },
          ],
      },
  }
---

## When to Use

Use this skill for real browser tasks: JS-rendered pages, multi-step forms, screenshots or PDFs, UI debugging, Playwright test authoring, MCP-driven browser control, and structured extraction from rendered pages.

Prefer it when static fetch is insufficient or when the task depends on browser events, visible DOM state, authentication context, uploads or downloads, or user-facing rendering.

If the user mainly wants the agent to drive a browser with simple actions like navigate, click, fill, screenshot, download, or extract, treat MCP as a first-class path.

Use direct Playwright for scripts and tests. Use MCP when browser tools are already in the loop, the user explicitly wants MCP, or the fastest path is browser actions rather than writing new automation code.

Primary fit is repo-owned browser work: tests, debugging, repros, screenshots, and deterministic automation. Treat rendered-page extraction as a secondary use case, not the default identity.

## Architecture

This skill is instruction-only. It does not create local memory, setup folders, or persistent profiles by default.

Load only the smallest reference file needed for the task. Keep auth state temporary unless the repository already standardizes it and the user explicitly wants browser-session reuse.

## Quick Start

### MCP browser path

```bash
npx @playwright/mcp --headless
```

Use this path when the agent already has browser tools available or the user wants browser automation without writing new Playwright code.

### Common MCP actions

Typical Playwright MCP tool actions include:

- `browser_navigate` for opening a page
- `browser_click` and `browser_press` for interaction
- `browser_type` and `browser_select_option` for forms
- `browser_snapshot` and `browser_evaluate` for inspection and extraction
- `browser_choose_file` for uploads
- screenshot, PDF, trace, and download capture through the active browser workflow

### Common browser outcomes

| Goal                      | Typical MCP-style action                         |
| ------------------------- | ------------------------------------------------ |
| Open and inspect a site   | navigate, wait, inspect, screenshot              |
| Complete a form           | navigate, click, fill, select, submit            |
| Capture evidence          | screenshot, PDF, download, trace                 |
| Pull structured page data | navigate, wait for rendered state, extract       |
| Reproduce a UI bug        | headed run, trace, console or network inspection |

### Existing test suite

```bash
npx playwright test
npx playwright test --headed
npx playwright test --trace on
```

### Bootstrap selectors and flows

```bash
npx playwright codegen https://example.com
```

### Direct script path

```javascript
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("https://example.com");
  await page.screenshot({ path: "page.png", fullPage: true });
  await browser.close();
})();
```

## Quick Reference

| Topic                                                           | File           |
| --------------------------------------------------------------- | -------------- |
| Selector strategy and frame handling                            | `selectors.md` |
| Failure analysis, traces, logs, and headed runs                 | `debugging.md` |
| Test architecture, mocks, auth, and assertions                  | `testing.md`   |
| CI defaults, retries, workers, and failure artifacts            | `ci-cd.md`     |
| Rendered-page extraction, pagination, and respectful throttling | `scraping.md`  |

## Approach Selection

| Situation                                                                                                  | Best path                                        | Why                                                       |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Static HTML or a simple HTTP response is enough                                                            | Use a cheaper fetch path first                   | Faster, cheaper, less brittle                             |
| You need a reliable first draft of selectors or flows                                                      | Start with `codegen` or a headed exploratory run | Faster than guessing selectors from source or stale DOM   |
| Local app, staging app, or repo-owned E2E suite                                                            | Use `@playwright/test`                           | Best fit for repeatable tests and assertions              |
| One-off browser automation, screenshots, downloads, or rendered extraction                                 | Use direct Playwright API                        | Simple, explicit, and easy to debug in code               |
| Agent/browser-tool workflow already depends on `browser_*` tools or the user wants no-code browser control | Use Playwright MCP                               | Fastest path for navigate-click-fill-screenshot workflows |
| CI failures, flake, or environment drift                                                                   | Start with `debugging.md` and `ci-cd.md`         | Traces and artifacts matter more than new code            |

## Core Rules

### 1. Test user-visible behavior and the real browser boundary

- Do not spend Playwright on implementation details that unit or API tests can cover more cheaply.
- Use Playwright when success depends on rendered UI, actionability, auth, uploads or downloads, navigation, or browser-only behavior.

### 2. Make runs isolated before making them clever

- Keep tests and scripts independent so retries, parallelism, and reruns do not inherit hidden state.
- Extend the repository's existing Playwright harness, config, and fixtures before inventing a parallel testing shape from scratch.
- Do not share mutable accounts, browser state, or server-side data across parallel runs unless the suite was explicitly designed for it.

### 3. Reconnaissance before action

- Open, wait, and inspect the rendered state before locking selectors or assertions.
- Use `codegen`, headed mode, or traces to discover stable locators instead of guessing from source or stale DOM.
- For flaky or CI-only failures, capture a trace before rewriting selectors or waits.

### 4. Prefer resilient locators and web-first assertions

- Use role, label, text, alt text, title, or test ID before CSS or XPath.
- Assert the user-visible outcome with Playwright assertions instead of checking only that a click or fill command executed.
- If a locator is ambiguous, disambiguate it. Do not silence strictness with `first()`, `last()`, or `nth()` unless position is the actual behavior under test.

### 5. Wait on actionability and app state, not arbitrary time

- Let Playwright's actionability checks work for you before reaching for sleeps or forced actions.
- Prefer `expect`, URL waits, response waits, and explicit app-ready signals over generic timing guesses.

### 6. Control what you do not own

- Mock or isolate third-party services, flaky upstream APIs, analytics noise, and cross-origin dependencies whenever the goal is to verify your app.
- For rendered extraction, prefer documented APIs or plain HTTP paths before driving a full browser.
- Do not make live third-party widgets or upstream integrations the reason your suite flakes unless that exact integration is what the user asked to validate.

### 7. Keep auth, production access, and persistence explicit

- Do not persist saved browser state by default.
- Reuse auth state only when the repository already standardizes it or the user explicitly asks for session reuse.
- For destructive, financial, medical, production, or otherwise high-stakes flows, prefer staging or local environments and require explicit user confirmation before continuing.

## Playwright Traps

- Guessing selectors from source or using `first()`, `last()`, or `nth()` to silence ambiguity -> the automation works once and then flakes.
- Starting a new Playwright structure when the repo already has config, fixtures, auth setup, or conventions -> the new flow fights the existing harness and wastes time.
- Testing internal implementation details instead of visible outcomes -> the suite passes while the user path is still broken.
- Sharing one authenticated state across parallel tests that mutate server-side data -> failures become order-dependent and hard to trust.
- Reaching for `force: true` before understanding overlays, disabled state, or actionability -> the test hides a real bug.
- Waiting on `networkidle` for chatty SPAs -> analytics, polling, or sockets keep the page "busy" even when the UI is ready.
- Driving a full browser when HTTP or an API would answer the question -> more cost, more flake, less signal.
- Treating third-party widgets and live upstream services as if they were stable parts of your own product -> failures stop being actionable.

## External Endpoints

| Endpoint                     | Data Sent                                                                                  | Purpose                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| User-requested web origins   | Browser requests, form input, cookies, uploads, and page interactions required by the task | Automation, testing, screenshots, PDFs, and rendered extraction |
| `https://registry.npmjs.org` | Package metadata and tarballs during optional installation                                 | Install Playwright or Playwright MCP                            |

No other data is sent externally.

## Security & Privacy

Data that leaves your machine:

- Requests sent to the websites the user asked to automate.
- Optional package-install traffic to npm when installing Playwright tooling.

Data that stays local:

- Source code, traces, screenshots, videos, PDFs, and temporary browser state kept in the workspace or system temp directory.

This skill does NOT:

- Create hidden memory files or local folder systems.
- Recommend browser-fingerprint hacks, challenge-solving services, or rotating exits.
- Persist sessions or credentials by default.
- Make undeclared network requests beyond the target sites involved in the task and optional tool installation.
- Treat high-stakes production flows as safe to automate without explicit user direction.

## Trust

By using this skill, browser requests go to the websites you automate and optional package downloads go through npm.
Only install if you trust those services and the sites involved in your workflow.

## Related Skills

Install with `clawhub install <slug>` if user confirms:

- `web` - HTTP-first investigation before escalating to a real browser.
- `scrape` - Broader extraction workflows when browser automation is not the main challenge.
- `screenshots` - Capture and polish visual artifacts after browser work.
- `multi-engine-web-search` - Find and shortlist target pages before automating them.

## Feedback

- If useful: `clawhub star playwright`
- Stay updated: `clawhub sync`

---
name: headless-browser
description: A robust, native headless browser capability for Rykiri. Use this skill to interact with webpages, scrape content, and capture screenshots reliably on Windows, bypassing the built-in browser subagent.
---

# SKILL: HEADLESS BROWSER (PUPPETEER)

Rykiri, use this skill when you need to interact with a webpage, evaluate JS within a webpage context, extract the DOM, or take a screenshot.

## WHEN TO USE
- The built-in browser subagent is failing or timing out.
- You need a fast, deterministic way to extract text from a URL.
- You need to take an 8K/high-res screenshot of a UI component for verification against "Industrial Futurism" and brand aesthetics.
- You need to evaluate a script on a page to extract specific data.

## HOW TO USE

Navigate to `d:\Rykiri\.agents\skills\headless-browser\scripts\` and execute the `browse.js` script using Node.

```bash
node d:\Rykiri\.agents\skills\headless-browser\scripts\browse.js <URL> [OPTIONS]
```

### Options:
- `--extract-text`: Returns the plain text content of the `<body>`.
- `--extract-html`: Returns the full HTML of the page.
- `--screenshot <path>`: Saves a screenshot to the specified absolute path.
- `--wait-for <selector>`: Waits for a specific CSS selector to appear before extracting/screenshotting.
- `--evaluate <js-string>`: Evaluates a JS snippet in the page context and returns the stringified result.

### Example 1: Extract plain text
```bash
node d:\Rykiri\.agents\skills\headless-browser\scripts\browse.js "https://example.com" --extract-text
```

### Example 2: Take a UI verification screenshot
```bash
node d:\Rykiri\.agents\skills\headless-browser\scripts\browse.js "http://localhost:3000" --wait-for "#main-content" --screenshot "d:\Rykiri\tmp\ui_screenshot.png"
```

## GUARDRAILS
- **Windows Only**: Ensure any paths provided to `--screenshot` are valid Windows absolute paths.
- **Port Conflicts**: If taking a screenshot of a local dev server, ensure the dev server is fully booted and accessible on `localhost:<port>`.
- **Timeouts**: The script has a built-in 30s timeout. If it times out, the page might be blocking headless browsers or the dev server isn't ready.

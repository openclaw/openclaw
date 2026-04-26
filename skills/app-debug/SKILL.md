---
name: app-debug
description: "Debug a broken or misbehaving clawy app. Use when: (1) a user reports an app isn't working, (2) an app shows a blank page, console errors, or unexpected behavior, (3) an app fails npm test, (4) checking service/Caddy/infrastructure health for an app. NOT for: deploying new apps (use app-deploy), writing tests from scratch (use app-test), or removing apps (use app-destroy). Always understand the problem before fixing — ask the user what they see first."
---

# App Debug

Systematic debugging for clawy apps. **Always understand before acting** — ask the user what they see, then diagnose with the right tool.

## Step 1: Understand the Problem

Ask the user:
- "What happens when you open it?"
- "Do you see an error or just a blank page?"
- "Which part isn't working — the whole app or a specific feature?"

Most users aren't technical — ask the right questions so they can tell you what's wrong.

## Step 2: Run the Smoke Test

```bash
cd ~/apps/<app-name> && npm test
```

The E2E smoke test opens the app in a real browser (Puppeteer + Chromium) and catches:
- JavaScript console errors and uncaught exceptions
- Failed HTTP requests (404s, 500s)
- Broken Caddy routes (absolute `/api/` paths that fail behind reverse proxy)
- Scaffolding not replaced (placeholder content still present)

If the smoke test reveals the bug, go to Step 5.

## Step 3: Check Infrastructure

Only if the smoke test doesn't reveal the issue:

```bash
# Service health
systemctl --user status <app-name>.service

# Caddy route
grep <app-name> ~/Caddyfile

# Server logs (recent errors)
journalctl --user -u <app-name>.service --since '10 min ago' --no-pager

# Database connectivity
PGPASSWORD=clawy_db_2026 psql -h 127.0.0.1 -U clawy -d <app-name> -c '\dt'
```

## Step 4: Check Browser-Level Issues

If the app loads but behaves wrong, write a targeted Puppeteer test for the broken flow:

```javascript
// tests/debug-<issue>.test.js
const puppeteer = require('puppeteer-core');

describe('debug: <issue description>', () => {
  let browser, page, consoleErrors = [], pageErrors = [], failedRequests = [];

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
    page = await browser.newPage();
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} - ${req.failure().errorText}`));
    await page.goto('http://localhost:<port>/', { waitUntil: 'networkidle2' });
  });

  afterAll(async () => { await browser.close(); });

  test('no console errors', () => { expect(consoleErrors).toEqual([]); });
  test('no page errors', () => { expect(pageErrors).toEqual([]); });
  test('no failed requests', () => { expect(failedRequests).toEqual([]); });
  // Add specific interaction tests here
});
```

## Step 5: Explain, Then Fix

**Explain the problem in plain language before fixing:**
- "The app is crashing because the database table doesn't exist yet"
- "There's a JavaScript error — a function is called before it's defined"
- "The Caddy route is missing, so requests never reach the app"

**One fix at a time.** Don't "while I'm here" other things — that's how you break what was working.

## Step 6: Write a Regression Test, Then Fix

Write a Puppeteer test that reproduces the bug. Fix the code. Run `npm test` to confirm:
1. The new test passes (bug is fixed)
2. All existing tests pass (nothing else broke)

**If two attempts at the same approach haven't worked, STOP.** Don't keep varying the same idea — reconsider whether you're solving the right problem. Re-read the error, check logs, and talk to the user.

## Common Issues

| Symptom | Likely Cause | Quick Check |
|---------|-------------|-------------|
| Blank page | JS error blocking render | `npm test` → console errors |
| 404 on API calls | Leading slash in fetch paths | `grep "fetch('/" public/app.js` |
| 502 Bad Gateway | Service not running | `systemctl --user status <app>` |
| Auth loop | Caddy forward_auth misconfigured | `grep <app> ~/Caddyfile` |
| DB errors | Schema not applied | `psql -h 127.0.0.1 -U clawy -d <app> -c '\dt'` |
| Static assets 404 | Wrong relative path | Check `href`/`src` in HTML |

## Static App Debugging

For static apps (served by `~/api-server.js`):
```bash
grep '/apps/<app-name>' ~/api-server.js     # route exists?
test -f ~/apps/<app-name>/public/index.html  # file exists?
systemctl --user status clawy-api.service     # api server running?
```

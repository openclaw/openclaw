---
name: app-test
description: "Write tests for a clawy app. Use when: (1) an app needs E2E smoke tests, unit tests, or integration tests, (2) adding Puppeteer tests for user flows, (3) testing API endpoints with supertest, (4) writing regression tests for reported bugs, (5) ensuring npm test passes before sharing an app URL. NOT for: deploying apps (use app-deploy), debugging (use app-debug), or general coding tasks."
---

# App Test

Write and run tests for clawy apps. Tests are mandatory — no URL shared with the user until `npm test` passes.

## Hard Gate

`npm test` must pass before sharing any app URL. No exceptions:
- Do NOT comment out, delete, `.skip`, or `xit` failing tests
- Do NOT weaken assertions (`toBe("x")` → `toBeTruthy()`)
- Do NOT exclude test files via `testPathIgnorePatterns`
- Do NOT say "tests mostly pass"

A failing test means the app has a bug. Fix the bug, not the test.

## Test Types by App Complexity

### Static apps (HTML + JS, no backend)
- 1 E2E smoke test (mandatory)
- 1 test per JS function that handles user input or transforms data
- Test every `onclick`/`addEventListener` handler

### Backend apps (Express + database)
- 1 E2E smoke test (mandatory)
- Unit tests: every function that processes data, validates input, or computes output
- Integration tests: every API endpoint — success AND error responses with supertest
- Database tests: CRUD operations if app writes to PostgreSQL

### Complex apps (multi-page, auth, workflows)
- All of the above, plus additional E2E tests for:
  - Every page loads without console errors
  - Core user journeys (3-5 CRUD/workflow paths)
  - Form validation + success states
  - Mobile (375px) and desktop (1280px) viewports

## E2E Smoke Test

`clawy app create` generates `tests/smoke.test.js`. This is your most valuable test — it catches what users actually see:
- Console errors (JS exceptions, undefined functions, failed imports)
- Page errors (uncaught exceptions)
- Failed HTTP requests (404s, 500s, broken Caddy routes)
- Scaffolding not replaced

**Don't delete the scaffolded smoke test.** Add more tests alongside it.

### Template for Additional E2E Tests

```javascript
const puppeteer = require('puppeteer-core');

describe('<feature name>', () => {
  let browser, page;
  let consoleErrors = [], pageErrors = [], failedRequests = [];

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    page = await browser.newPage();
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()}`));
    await page.goto('http://localhost:<port>/', { waitUntil: 'networkidle2' });
  });

  afterAll(async () => { await browser.close(); });

  afterEach(() => {
    // These must pass in EVERY test — no console errors allowed
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test('loads without errors', async () => {
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  // Add interaction tests:
  // test('creates an item', async () => { ... });
  // test('deletes an item', async () => { ... });
});
```

## API Integration Tests

```javascript
const request = require('supertest');
const app = require('../server'); // export app, don't listen in test

describe('POST /api/items', () => {
  test('creates an item', async () => {
    const res = await request(app)
      .post('api/items')  // no leading slash!
      .send({ name: 'Test', value: 42 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  test('rejects invalid input', async () => {
    const res = await request(app)
      .post('api/items')
      .send({ name: '' }); // empty name
    expect(res.status).toBe(400);
  });
});
```

**Use relative paths** (`'api/items'` not `'/api/items'`) — leading slashes break under Caddy's `handle_path`.

## Regression Tests for Bugs

When a user reports a bug:
1. Write a Puppeteer test that reproduces the exact flow
2. Confirm the test fails (proves it catches the bug)
3. Fix the code
4. Run `npm test` — all tests must pass

## Running Tests

```bash
cd ~/apps/<app-name>
npm test                    # all tests
npx jest tests/smoke.test.js  # specific test file
npx jest --verbose          # detailed output
```

Run after every change — building, fixing, or updating.

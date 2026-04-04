# Debugging Guide

## First Moves

1. Reproduce in headed mode.
2. Capture a trace before rewriting selectors or waits.
3. Check whether the failure is selector drift, actionability, environment drift, shared state, or a real product regression.

## Inspector and Headed Runs

```bash
npx playwright test --debug
npx playwright test my-test.spec.ts --debug
npx playwright test --headed
```

```typescript
await page.pause();
```

## Trace Viewer

```bash
npx playwright test --trace on
npx playwright show-trace trace.zip
```

```typescript
use: {
  trace: 'retain-on-failure',
}
```

Start with traces for CI and flaky failures. Use screenshots and videos as supporting evidence, not as the primary debugging tool.

## Common Errors

### Element Not Found

Use explicit waits and confirm the right frame or shadow boundary before rewriting selectors. If the locator is ambiguous, improve the locator instead of clicking the first match.

```typescript
await page.waitForSelector(".element");
const frame = page.frameLocator("iframe");
await frame.locator(".element").click();
await page.click(".element", { timeout: 60000 });
```

### Flaky Click

Check visibility, scrolling, overlays, and disabled state before forcing the click.

```typescript
await page.locator(".btn").waitFor({ state: "visible" });
await page.locator(".btn").scrollIntoViewIfNeeded();
await page.locator(".btn").click();
```

Use `force: true` only after confirming that the overlay or disabled state is not the real bug.

If the click target keeps changing, inspect actionability conditions first: visible, stable, enabled, and actually receiving pointer events.

### Timeout in CI

Slow environments usually need better waits, traces, or fewer workers before they need bigger timeouts.

```typescript
export default defineConfig({
  timeout: 60000,
  expect: { timeout: 10000 },
});

await expect
  .poll(
    async () => {
      return await page.locator(".items").count();
    },
    { timeout: 30000 },
  )
  .toBeGreaterThan(5);
```

### Network Issues

```typescript
page.on("request", (request) => {
  console.log(">>", request.method(), request.url());
});

page.on("response", (response) => {
  console.log("<<", response.status(), response.url());
});

const responsePromise = page.waitForResponse("**/api/data");
await page.click(".load-data");
const response = await responsePromise;
```

## Failure Artifacts

```typescript
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== "passed") {
    await page.screenshot({
      path: `screenshots/${testInfo.title}.png`,
      fullPage: true,
    });
  }
});
```

## Console and Runtime Errors

```typescript
page.on("console", (msg) => {
  console.log("PAGE LOG:", msg.text());
});

page.on("pageerror", (error) => {
  console.log("PAGE ERROR:", error.message);
});
```

## Compare Local vs CI

| Check            | Command                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| Viewport         | `await page.viewportSize()`                                                   |
| User agent       | `await page.evaluate(() => navigator.userAgent)`                              |
| Timezone         | `await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)` |
| Network          | `page.on('request', ...)`                                                     |
| Shared auth/data | verify whether tests mutate the same account or fixtures                      |

## Debugging Checklist

1. Run with `--debug` or `--headed`.
2. Add `await page.pause()` before the failure point.
3. Capture trace, screenshot, and console output before changing selectors.
4. Check for iframes, shadow DOM, overlays, loading states, and shared auth or data collisions.
5. Compare viewport, network behavior, workers, and environment flags between local and CI.
6. Only then rewrite selectors, waits, fixtures, or test structure.

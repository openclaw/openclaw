# PR Task: Browser Tool Batch Actions, CSS Selectors, and Click Delay

## Context

OpenClaw's browser tool (`src/browser/`) uses Playwright for browser automation. Agents interact via `act` commands with `kind` (click, type, hover, etc.) and `ref` (element references from snapshots).

Current pain points:

1. Each action = separate tool call = AI inference roundtrip (~2s + tokens). No way to batch.
2. Must take a snapshot first to get refs. Can't use CSS selectors directly.
3. No hover-before-click delay — agents do 3 calls (hover, wait, click) for human-like interaction.

## Changes Required

### 1. CSS Selector Support (alongside ref)

**File: `src/browser/client-actions-core.ts`**

- Add optional `selector?: string` to click, type, hover, drag, scrollIntoView, select action types
- When `selector` is provided (and `ref` is not), use `page.locator(selector)` instead of `refLocator(page, ref)`

**File: `src/browser/pw-tools-core.interactions.ts`**

- In `clickViaPlaywright`, `typeViaPlaywright`, `hoverViaPlaywright`, etc:
  - Accept optional `selector` param
  - If `selector` provided: `const locator = page.locator(selector)`
  - If `ref` provided: `const locator = refLocator(page, ref)` (existing behavior)
  - Require at least one of ref/selector

**File: `src/browser/pw-tools-core.shared.ts`**

- Add helper: `requireRefOrSelector(ref?, selector?)` that validates at least one is provided

### 2. Click Delay (delayMs)

**File: `src/browser/client-actions-core.ts`**

- Add `delayMs?: number` to the `click` action type (already exists on `press`)

**File: `src/browser/pw-tools-core.interactions.ts`**

- In `clickViaPlaywright`:
  - If `delayMs` provided: hover first, wait delayMs, then click
  ```typescript
  if (opts.delayMs) {
    await locator.hover({ timeout });
    await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  // then click as before
  ```

### 3. Batch Actions

**File: `src/browser/client-actions-core.ts`**

- Add new batch type to `BrowserActRequest`:
  ```typescript
  | {
      kind: "batch";
      actions: BrowserActRequest[];  // recursive — array of existing action types
      targetId?: string;
      stopOnError?: boolean;  // default true
    }
  ```

**File: `src/browser/pw-tools-core.interactions.ts`**

- Add `batchViaPlaywright` function:
  ```typescript
  export async function batchViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    actions: BrowserActRequest[];
    stopOnError?: boolean;
  }): Promise<{ results: Array<{ ok: boolean; error?: string }> }> {
    const results = [];
    for (const action of opts.actions) {
      try {
        await executeSingleAction(action, opts.cdpUrl, opts.targetId);
        results.push({ ok: true });
      } catch (err) {
        results.push({ ok: false, error: err.message });
        if (opts.stopOnError !== false) break;
      }
    }
    return { results };
  }
  ```

**File: Where act requests are dispatched** (likely `client-actions-core.ts` or the server route handler)

- Add case for `kind: "batch"` that calls `batchViaPlaywright`

### Testing

- Add tests in relevant `.test.ts` files
- Test CSS selector resolves correctly
- Test batch executes actions in order
- Test batch stops on error when stopOnError=true
- Test delayMs adds hover before click

### Important Notes

- Follow existing code style exactly (imports, error handling patterns, etc.)
- Use `toAIFriendlyError` for error messages (existing pattern)
- Don't change any existing behavior — purely additive
- Run `pnpm build` to verify TypeScript compiles
- Check existing tests still pass: `pnpm test -- --grep browser`

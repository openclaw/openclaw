# Fix for auto-retry-on-failure hook load error

**Error:** `Failed to load hook auto-retry-on-failure: Identifier '.default' has already been declared`

**Cause:** In `/root/.openclaw/hooks/auto-retry-on-failure/handler.ts` there are two import lines that both bring in `HookHandler` (and related types) from different modules. That duplicate declaration breaks the module when it is loaded.

**Fix:** Use a single import and ensure the default export is a **function** (the internal hooks loader expects a function, not an object with `.handle`).

## 1. Fix the imports (remove duplicate)

**Replace the two import lines at the top:**

```ts
import type { HookHandler, HookEvent } from "openclaw/hooks";
import type { HookHandler, HookContext, ToolResult } from "@openclaw/types";
```

**With a single import.** If your runtime resolves `@openclaw/types`, use:

```ts
import type { HookHandler, HookContext, ToolResult } from "@openclaw/types";
```

If that package is not available in the hook environment, use minimal inline types and remove the duplicate:

```ts
// Minimal context shape expected by your logic (no external type package required)
type HookContext = {
  tool?: string;
  result?: { status?: string; error?: string };
  retry?: (...args: unknown[]) => unknown;
  state?: Record<string, unknown>;
};
```

Then remove any second `import type { HookHandler, ... }` so `HookHandler` is not declared twice.

## 2. Export a function, not an object

The loader expects the default export to be a **function** `(event) => ...`. Your handler is written as an object with a `.handle(ctx)` method. Either:

**Option A – Export the function that calls your logic:**

At the end of the file, instead of:

```ts
export default handler;
```

use:

```ts
export default async function (event: {
  type: string;
  action: string;
  context?: Record<string, unknown>;
}) {
  const ctx = event.context ?? {};
  await (handler as { handle: (c: unknown) => Promise<void> }).handle(ctx);
}
```

(Keep your existing `const handler = { async handle(ctx) { ... } };` and add this wrapper as the default export.)

**Option B – Flatten to a single async function:**

Change the handler so the default export is one async function that receives `event` and uses `event.context` where you currently use `ctx` (e.g. `const ctx = event.context as HookContext`), and export that function as default.

## Quick one-line fix (import only)

If you only fix the duplicate import for now, run on the server:

```bash
sed -i "s/^import type { HookHandler, HookEvent } from \"openclaw\/hooks\";$//" /root/.openclaw/hooks/auto-retry-on-failure/handler.ts
sed -i '/^[[:space:]]*$/N;/^\n$/d' /root/.openclaw/hooks/auto-retry-on-failure/handler.ts
```

Or edit manually: delete the first line  
`import type { HookHandler, HookEvent } from "openclaw/hooks";`  
and keep the second import. After that, if you see `Handler 'default' is not a function`, apply step 2 above so the default export is a function.

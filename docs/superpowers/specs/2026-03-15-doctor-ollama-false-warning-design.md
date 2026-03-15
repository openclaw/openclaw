# Fix: doctor false API key warning for Ollama provider

**Issue:** [#46584](https://github.com/openclaw/openclaw/issues/46584)
**Date:** 2026-03-15
**Status:** Approved

## Problem

When memory search provider is explicitly set to `ollama`, `openclaw doctor` reports "API key was not found" -- a false positive. Ollama runs locally and does not require an API key (`embeddings-ollama.ts:60-63` skips the Authorization header when no key is present).

The root cause is in `doctor-memory-search.ts`: the explicit provider branch only special-cases `local`, so `ollama` falls through to the "Remote provider -- check for API key" path, which incorrectly treats a missing key as a problem.

## Design

### Approach

Add an `ollama`-specific branch in `noteMemorySearchHealth()`, between the existing `local` branch and the "Remote provider" API key check. This mirrors the structure of the `local` branch.

### Logic

Three paths for `provider: "ollama"`:

1. **Gateway probe ready** -- silent return, no `note()` call.
2. **Gateway probe not ready / has error** -- informational `note()` with error detail, suggesting the user verify the ollama service is running.
3. **No probe information** -- informational `note()` without error detail, same suggestion.

In all three paths, the API key check is skipped entirely.

### Code change

**File:** `src/commands/doctor-memory-search.ts`

Insert after the closing `return;` of the `local` branch, before the `// Remote provider` comment:

```typescript
if (resolved.provider === "ollama") {
  // Ollama runs locally and does not require an API key.
  // If a gateway probe confirmed embeddings are ready, all good.
  if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
    return;
  }
  // No probe or probe not ready -- nudge the user to verify the service.
  const detail = opts?.gatewayMemoryProbe?.error?.trim();
  note(
    [
      'Memory search provider is set to "ollama".',
      "Ollama does not require an API key, but the ollama service must be running.",
      detail ? `Gateway probe: ${detail}` : null,
      "",
      `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "Memory search",
  );
  return;
}
```

### Tests

**File:** `src/commands/doctor-memory-search.test.ts`

Three new test cases:

| Test                     | Config                                      | Probe                                       | Expected                                                                                                         |
| ------------------------ | ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ollama + probe ready     | `provider: "ollama", local: {}, remote: {}` | `ready: true`                               | `note` not called                                                                                                |
| ollama + probe not ready | `provider: "ollama", local: {}, remote: {}` | `ready: false, error: "connection refused"` | `note` called, contains "does not require an API key" and error detail, does NOT contain "API key was not found" |
| ollama + no probe        | `provider: "ollama", local: {}, remote: {}` | (none)                                      | `note` called, contains "does not require an API key", does NOT contain "API key was not found"                  |

Key regression assertion: none of the ollama paths should ever output "API key was not found".

### Scope

- **Files changed:** 2 (`doctor-memory-search.ts`, `doctor-memory-search.test.ts`)
- **Lines added:** ~35 (15 logic + 20 test)
- **Lines removed:** 0
- **Risk:** Minimal -- only affects doctor diagnostic output for `provider: "ollama"`, no runtime behavior change.
- **`auto` mode unaffected:** `ollama` is not in the auto-mode provider detection loop (`["openai", "gemini", "voyage", "mistral"]`), so the new branch is never reached when `provider: "auto"`. No additional changes needed.

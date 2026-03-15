# Fix doctor Ollama false API key warning - Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `openclaw doctor` from falsely warning about a missing API key when memory search provider is explicitly set to `ollama`.

**Architecture:** Add an `ollama`-specific branch in `noteMemorySearchHealth()` that skips the API key check and instead verifies gateway probe status. Mirrors the existing `local` branch structure.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-doctor-ollama-false-warning-design.md`

---

## File Structure

| File                                        | Action | Responsibility                                 |
| ------------------------------------------- | ------ | ---------------------------------------------- |
| `src/commands/doctor-memory-search.ts`      | Modify | Add `ollama` branch in explicit provider check |
| `src/commands/doctor-memory-search.test.ts` | Modify | Add 3 test cases for ollama branch paths       |

---

## Chunk 1: Implementation

### Task 1: Add ollama tests and implementation

**Files:**

- Modify: `src/commands/doctor-memory-search.test.ts` (insert after the "still warns in auto mode when only ollama credentials exist" test, before `describe("detectLegacyWorkspaceDirs"`)
- Modify: `src/commands/doctor-memory-search.ts` (insert after the `local` branch's closing `return;`, before the `// Remote provider` comment)
- Test: `src/commands/doctor-memory-search.test.ts`

- [ ] **Step 1: Write the three failing tests**

Add these tests inside the existing `describe("noteMemorySearchHealth", ...)` block, after the "still warns in auto mode when only ollama credentials exist" test, before `describe("detectLegacyWorkspaceDirs")`:

```typescript
it("does not warn when ollama provider is set and gateway probe is ready", async () => {
  resolveMemorySearchConfig.mockReturnValue({
    provider: "ollama",
    local: {},
    remote: {},
  });

  await noteMemorySearchHealth(cfg, {
    gatewayMemoryProbe: { checked: true, ready: true },
  });

  expect(note).not.toHaveBeenCalled();
});

it("shows informational note when ollama provider is set and gateway probe is not ready", async () => {
  resolveMemorySearchConfig.mockReturnValue({
    provider: "ollama",
    local: {},
    remote: {},
  });

  await noteMemorySearchHealth(cfg, {
    gatewayMemoryProbe: { checked: true, ready: false, error: "connection refused" },
  });

  expect(note).toHaveBeenCalledTimes(1);
  const message = String(note.mock.calls[0]?.[0] ?? "");
  expect(message).toContain("ollama");
  expect(message).toContain("does not require an API key");
  expect(message).toContain("connection refused");
  expect(message).not.toContain("API key was not found");
  expect(note.mock.calls[0]?.[1]).toBe("Memory search");
});

it("shows informational note when ollama provider is set and no gateway probe", async () => {
  resolveMemorySearchConfig.mockReturnValue({
    provider: "ollama",
    local: {},
    remote: {},
  });

  await noteMemorySearchHealth(cfg);

  expect(note).toHaveBeenCalledTimes(1);
  const message = String(note.mock.calls[0]?.[0] ?? "");
  expect(message).toContain("ollama");
  expect(message).toContain("does not require an API key");
  expect(message).not.toContain("API key was not found");
  expect(note.mock.calls[0]?.[1]).toBe("Memory search");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/commands/doctor-memory-search.test.ts`

Expected: 3 failures. The first test ("does not warn when ollama provider is set and gateway probe is ready") will fail because `note` IS called (ollama falls through to the API key check path). The other two will fail because the note message contains "API key was not found" instead of "does not require an API key".

- [ ] **Step 3: Write the ollama branch implementation**

In `src/commands/doctor-memory-search.ts`, insert the following block after the `local` branch's closing `return;`, before the `// Remote provider -- check for API key` comment:

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

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm test src/commands/doctor-memory-search.test.ts`

Expected: All tests pass, including the 3 new ones and all existing tests.

- [ ] **Step 5: Run full checks**

Run: `pnpm build && pnpm check`

Expected: No type errors, no lint errors.

- [ ] **Step 6: Commit**

```bash
scripts/committer "fix: doctor false API key warning for ollama memory search provider (#46584)" src/commands/doctor-memory-search.ts src/commands/doctor-memory-search.test.ts
```

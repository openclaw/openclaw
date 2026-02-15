# PR Review: Add tool_invocation provenance for A2A tool calls

## Executive Summary

**Recommendation: APPROVE with minor suggestions**

The PR correctly identifies and fixes a gap in the provenance pipeline. The approach is sound and the implementation is minimal and targeted.

---

## 1. Correctness of Code Changes ✅

### The Problem is Real

Analysis of the current codebase confirms the discrepancy:

| Layer                              | `tool_invocation` | `skill` field | `mode` field | Status    |
| ---------------------------------- | ----------------- | ------------- | ------------ | --------- |
| **Source `input-provenance.ts`**   | ❌ Missing        | ❌ Missing    | ❌ Missing   | Needs fix |
| **Source `agent.ts` schema**       | ✅ Via spread     | ❌ Missing    | ❌ Missing   | Needs fix |
| **Bundled `pi-embedded-*.js`**     | ✅ Present        | ❌ Stripped   | ❌ Stripped  | Partial   |
| **Tools (agent_call/debate_call)** | ✅ Sending        | ✅ Sending    | ✅ Sending   | Working   |

The bundled files already include `tool_invocation` in the kind enum and `skill`/`mode` in the schema, but `normalizeInputProvenance()` still strips these fields because the source type doesn't include them.

**This indicates an incomplete prior change** - someone updated the bundled code or bundled files were regenerated from a different source state.

### Patch Correctness

The patch correctly:

1. **Adds `tool_invocation` to the kind enum** - Matches what tools already send
2. **Adds `skill?: string` to `InputProvenance` type** - Matches tool usage
3. **Adds `mode?: string` to `InputProvenance` type** - Matches tool usage
4. **Updates `normalizeInputProvenance()`** - Now preserves skill/mode
5. **Updates TypeBox schema** - Now validates skill/mode

The field ordering in the patch uses trailing annotations (comma on last line), which is consistent with TypeScript conventions.

---

## 2. Completeness of Approach ✅

### What's Covered

| Component         | File                  | Covered |
| ----------------- | --------------------- | ------- |
| Type definition   | `input-provenance.ts` | ✅      |
| Normalization     | `input-provenance.ts` | ✅      |
| Schema validation | `agent.ts`            | ✅      |

### What's Missing (Acceptable)

1. **Type guard utility** - Could add `isToolInvocationProvenance()` helper, but not required
2. **Documentation** - Could add JSDoc for new fields, but optional
3. **Migration guide** - Not needed since this is additive only

---

## 3. Edge Cases Identified

### 3.1 Type Safety Gap (Minor)

```typescript
// The new fields are optional, which is correct:
skill?: string;
mode?: string;
```

**Concern:** No runtime validation that `skill` is present when `kind === "tool_invocation"`.

**Suggestion:** Consider adding a guard or assertion helper:

```typescript
export function isToolInvocationProvenance(
  p: InputProvenance,
): p is InputProvenance & { skill: string } {
  return p.kind === "tool_invocation" && typeof p.skill === "string";
}
```

**Verdict:** Optional improvement, not blocking.

### 3.2 Mode Value Validation (Minor)

The `mode` field can be any string, but tools only send `"execute"` or `"critique"`.

**Suggestion:** Consider a union type:

```typescript
mode?: "execute" | "critique";
```

**Tradeoff:** Less flexible for future modes. Current approach (string) is safer.

**Verdict:** Keep as string - allows extensibility.

### 3.3 Backward Compatibility ✅

- Old agents calling new agents: No issue (new fields are optional)
- New agents calling old agents: Old agents ignore unknown fields

### 3.4 Missing sourceSessionKey Propagation (Pre-existing)

The PR doesn't address that `agent_call`/`debate_call` don't set `sourceSessionKey`. However, this is outside the PR scope and relates to #15141.

---

## 4. Test Adequacy ⚠️

### Current State

**No tests exist for `input-provenance.ts`.** The file contains only type definitions and utility functions, but no unit tests were found.

### Recommended Tests

```typescript
// test/sessions/input-provenance.test.ts

describe("input-provenance", () => {
  describe("normalizeInputProvenance", () => {
    it("should preserve skill and mode for tool_invocation", () => {
      const result = normalizeInputProvenance({
        kind: "tool_invocation",
        sourceTool: "agent_call",
        skill: "investigate",
        mode: "execute",
      });
      expect(result).toEqual({
        kind: "tool_invocation",
        sourceTool: "agent_call",
        skill: "investigate",
        mode: "execute",
      });
    });

    it("should strip whitespace from skill and mode", () => {
      const result = normalizeInputProvenance({
        kind: "tool_invocation",
        skill: "  investigate  ",
        mode: "  execute  ",
      });
      expect(result?.skill).toBe("investigate");
      expect(result?.mode).toBe("execute");
    });

    it("should handle missing skill/mode gracefully", () => {
      const result = normalizeInputProvenance({
        kind: "tool_invocation",
        sourceTool: "agent_call",
      });
      expect(result).toEqual({
        kind: "tool_invocation",
        sourceTool: "agent_call",
        sourceSessionKey: undefined,
        sourceChannel: undefined,
        skill: undefined,
        mode: undefined,
      });
    });
  });

  describe("INPUT_PROVENANCE_KIND_VALUES", () => {
    it("should include tool_invocation", () => {
      expect(INPUT_PROVENANCE_KIND_VALUES).toContain("tool_invocation");
    });
  });
});
```

### Integration Test

```typescript
// test/a2a/provenance.test.ts

describe("A2A Provenance", () => {
  it("should pass skill and mode through agent_call", async () => {
    // Integration test verifying end-to-end propagation
  });
});
```

**Verdict:** Tests recommended but not blocking. The PR description notes production verification was done.

---

## 5. Breaking Changes ✅

**None.** This is purely additive:

- New enum value: Backward compatible (agents that don't recognize it still parse)
- New optional fields: Backward compatible (existing code ignores them)
- Schema update: Adds optional fields, doesn't remove anything

### Verification

The `additionalProperties: false` in the schema means agents can only send defined fields. Since `skill` and `mode` are now defined, this is safe.

---

## 6. Additional Observations

### 6.1 Bundled vs Source Discrepancy

The bundled files already contain `tool_invocation` in the kind enum and `skill`/`mode` in the schema, but the source files don't. This suggests:

1. A prior bundled update wasn't reflected in source
2. Or the PR is updating files that were partially modified elsewhere

**Recommendation:** Ensure the source files are the single source of truth before merging.

### 6.2 Related PRs

The PR correctly references related work:

- #15154 - Session path resolution (merged)
- #10486 - A2A protocol plugin
- #7516 - Auto-inject identity headers
- #10999 - A2A announce delivery fix

### 6.3 Eight Bundled Files Mentioned

The PR description mentions "a patch for 8 bundled JS files" but only shows source patches. The bundled files will need regeneration via `pnpm build`.

---

## Summary

| Criterion        | Status     | Notes                                   |
| ---------------- | ---------- | --------------------------------------- |
| Correctness      | ✅ Pass    | Fixes real gap, implementation sound    |
| Completeness     | ✅ Pass    | Covers all required files               |
| Edge Cases       | ✅ Pass    | Minor suggestions only                  |
| Tests            | ⚠️ Suggest | No tests exist, but production verified |
| Breaking Changes | ✅ Pass    | Additive only                           |

**Final Verdict: APPROVE**

The PR is technically correct and ready to merge. I recommend:

1. Adding unit tests for the new fields (follow-up PR is acceptable)
2. Verifying source/bundled sync after build
3. Optional: Add helper function for type narrowing

---

_Review by Hephaestus (hephaestus agent)_
_2026-02-14_

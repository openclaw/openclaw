# Oppositional Review: PR-A2A-TOOL-INVOCATION

## 🚨 CRITICAL ISSUES - BLOCKING

### Issue #1: Tools Send Wrong `kind` Value

**The PR claims tools send `kind: "tool_invocation"`. This is FALSE.**

Examining the actual source code (`agent-call-tool.ts` lines 215-220, 234-240):

```typescript
inputProvenance: {
    kind: "inter_session" as const,  // ❌ NOT "tool_invocation"!
    sourceSessionKey: requesterSessionKey,
    sourceTool: "agent_call",
}
```

Same in `debate-call-tool.ts` lines 138-143:

```typescript
inputProvenance: {
    kind: "inter_session" as const,  // ❌ NOT "tool_invocation"!
    sourceSessionKey: params.requesterSessionKey,
    sourceTool: "debate_call",
}
```

**Impact:** Adding `tool_invocation` to the type is meaningless if tools don't USE it.

**Why bundled code shows different:** The bundled files were built from a fork or experimental branch where this was fixed. The source repo shows the actual current implementation.

**Required Fix:** Update BOTH tools to send `kind: "tool_invocation"` with skill/mode:

```typescript
inputProvenance: {
    kind: "tool_invocation" as const,  // ✅ CORRECT
    sourceSessionKey: requesterSessionKey,
    sourceTool: "agent_call",
    skill,
    mode,
}
```

---

### Issue #2: Tools Don't Send `skill` or `mode` in Provenance

**The PR claims tools already send skill/mode. This is FALSE.**

Looking at the tools, `skill` and `mode` are NEVER added to `inputProvenance`:

```typescript
// agent-call-tool.ts - provenance construction
inputProvenance: {
    kind: "inter_session" as const,
    sourceSessionKey: requesterSessionKey,
    sourceTool: "agent_call",
    // ❌ skill: NOT SET
    // ❌ mode: NOT SET
}
```

The variables `skill` and `mode` exist in the tool scope but aren't used in provenance!

**Impact:** Even with the type changes, the target agent will receive `skill: undefined, mode: undefined`.

**Required Fix:** Add skill/mode to provenance in both tools.

---

### Issue #3: Missing `sourceSessionKey` in Some Paths

`debate_call` invokes critics via `invokeAgentSkill()` helper, but:

```typescript
// debate-call-tool.ts line 110-115
inputProvenance: {
    kind: "inter_session" as const,
    sourceSessionKey: params.requesterSessionKey,  // Can be undefined!
    sourceTool: "debate_call",
}
```

When `requesterSessionKey` is undefined (e.g., calling from main without session context), the provenance chain is broken.

---

## ⚠️ MAJOR ISSUES - SHOULD FIX

### Issue #4: Type Narrowing Gap

The `mode` field uses strict enum in tool schema:

```typescript
mode: Type.Optional(
    Type.String({
        enum: ["execute", "critique"],  // Limited to these values
    }),
),
```

But `InputProvenance` type uses:

```typescript
mode?: string;  // Can be ANY string
```

This allows invalid modes to propagate through provenance if downstream code doesn't re-validate.

**Recommendation:** Add union type or document the intentional looseness:

```typescript
mode?: "execute" | "critique" | string;  // Explicit about primary modes
```

---

### Issue #5: No Runtime Validation of skill/mode Presence for `tool_invocation`

When `kind === "tool_invocation"`, the skill field SHOULD be present, but the type allows it to be absent. Runtime code could receive:

```typescript
{ kind: "tool_invocation", skill: undefined, mode: undefined }
```

This is technically valid per the type but semantically wrong.

**Recommendation:** Add validation in `normalizeInputProvenance()`:

```typescript
if (record.kind === "tool_invocation" && typeof record.skill !== "string") {
  console.warn("tool_invocation provenance missing skill");
}
```

---

### Issue #6: Bundled vs Source Discrepancy Unexplained

The PR doesn't explain why bundled files contain `tool_invocation` and `skill`/`mode` when source doesn't.

The bundled `pi-embedded-*.js` shows:

```javascript
inputProvenance: {
    kind: "tool_invocation",
    sourceTool: "agent_call",
    skill,
    mode
}
```

But source `agent-call-tool.ts` shows:

```typescript
inputProvenance: {
    kind: "inter_session" as const,
    sourceSessionKey: requesterSessionKey,
    sourceTool: "agent_call",
}
```

**Questions the PR must answer:**

1. Is the bundled code from a different branch?
2. Will the PR break existing behavior if bundled code relied on prior changes?
3. Should the PR include tool updates to match bundled behavior?

---

## 📝 DOCUMENTATION ISSUES

### Issue #7: PR Description Contradicts Source Code

| Claim in PR                                        | Actual Source Code            |
| -------------------------------------------------- | ----------------------------- |
| "They send `kind: 'tool_invocation'`"              | Sends `kind: "inter_session"` |
| "They send `skill` and `mode` fields"              | Not in provenance object      |
| "`normalizeInputProvenance()` strips these fields" | Fields never existed to strip |

The "problem" described in the PR doesn't exist in the form described. The REAL problem is that tools never send these fields at all.

---

### Issue #8: Use Case Example is Misleading

```
Atlas calls Clio.investigate({...})
  ↓
Clio sees provenance: {kind: "tool_invocation", skill: "investigate", mode: "execute"}
```

This is the DESIRED state, but current code would produce:

```
Clio sees provenance: {kind: "inter_session", sourceTool: "agent_call"}
```

---

## 🧪 TEST COVERAGE GAPS

### Issue #9: No Tests for New Type Fields

No tests verify:

1. `normalizeInputProvenance()` handles skill/mode
2. Type guards work with new fields
3. Invalid kind values are rejected
4. Empty strings are normalized to undefined

### Issue #10: No Integration Tests

No tests verify the provenance flows through:

1. `agent_call` → target session sees skill/mode
2. `debate_call` → participants see skill/mode
3. Normalization preserves all fields

---

## 🔒 SECURITY CONSIDERATIONS

### Issue #11: No Input Validation on skill/mode in Provenance

If skill/mode come from untrusted input, they could contain:

- Very long strings (DoS)
- Special characters that break logs
- Injection attempts if logged with improper escaping

**Current safeguards:** Tools validate skill with `validateSkillName()` and mode is enum-validated. But provenance is passed through without additional validation.

---

## 📊 Summary Matrix

| Issue                       | Severity    | Blocking? | Effort        |
| --------------------------- | ----------- | --------- | ------------- |
| #1 Wrong kind value         | 🔴 Critical | YES       | Low           |
| #2 skill/mode not sent      | 🔴 Critical | YES       | Low           |
| #3 Missing sourceSessionKey | 🟠 Major    | NO        | Medium        |
| #4 Type narrowing gap       | 🟡 Minor    | NO        | Low           |
| #5 No runtime validation    | 🟠 Major    | NO        | Low           |
| #6 Source/bundle mismatch   | 🟠 Major    | NO        | Investigation |
| #7-8 Documentation wrong    | 🟡 Minor    | NO        | Low           |
| #9-10 No tests              | 🟡 Minor    | NO        | Medium        |
| #11 Input validation        | 🟡 Minor    | NO        | Low           |

---

## Final Verdict

**🚫 REJECT - CRITICAL FIXES REQUIRED**

The PR adds fields to a type that nothing populates. This is equivalent to:

1. Adding a column to a database
2. Never writing any data to it
3. Claiming queries will now return data

**Required Before Merge:**

1. ✅ Update `agent-call-tool.ts` to send:
   - `kind: "tool_invocation"`
   - `skill: <value>`
   - `mode: <value>`

2. ✅ Update `debate-call-tool.ts` to send:
   - `kind: "tool_invocation"`
   - `skill: <value>`
   - `mode: <value>`

3. ✅ Explain source/bundled discrepancy

4. ✅ Update PR description to reflect actual current state

---

_Oppositional review by Hephaestus_
_2026-02-14_

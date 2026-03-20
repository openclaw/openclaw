# Review: Scope skill-injected env vars to prevent cross-skill leakage

**Branch:** `fix/exec-skill-env-sensitive-keys`
**Commit:** `aad4cc9a91`
**Reviewer:** Claude Opus 4.6
**Verdict:** CLEAN — no blocking findings.

---

## Changes Reviewed

| File                                 | Change                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/agents/skills/config.ts:96-109` | Modified `hasEnv` callback in `shouldIncludeSkill` to distinguish skill-injected env vars from host env vars |
| `src/agents/skills.test.ts:486-542`  | New test verifying cross-skill env var leakage prevention                                                    |

## Findings

### Blocking: None

### Non-blocking observations

1. **Logic is correct and minimal** (`src/agents/skills/config.ts:96-109`):
   The `hasEnv` callback now has three paths, all correct:
   - **Skill explicitly configures the env var** (via `skillConfig.env[envName]` or `skillConfig.apiKey` + `primaryEnv`): returns `true` — correct, this is the skill's own config.
   - **Host process.env has the value AND it was NOT injected by a skill override**: returns `true` — correct, genuine host env should satisfy eligibility.
   - **process.env has the value BUT it was injected by another skill's override** (`skillInjectedKeys.has(envName)` is true): returns `false` — correct, prevents cross-skill leakage.

   Edge case verified: when the host already has `OPENAI_API_KEY` set before any skill overrides, `acquireActiveSkillEnvKey` returns `false` at `env-overrides.ts:42-44` (externally managed), so the key is never tracked in `activeSkillEnvEntries` and `skillInjectedKeys.has()` returns `false`. Host env eligibility is preserved.

2. **Circular import** (`config.ts` ↔ `env-overrides.ts`):
   - `config.ts:10` imports `getActiveSkillEnvKeys` from `./env-overrides.js`
   - `env-overrides.ts:6` imports `resolveSkillConfig` from `./config.js`

   This is a circular dependency. However, it is **safe in ESM** because both imports are used only inside function bodies (not at module evaluation time). Node ESM resolves circular imports by providing a live binding reference — by the time either function is called, both modules are fully evaluated. **No action needed**, but worth documenting if the module structure evolves.

3. **`getActiveSkillEnvKeys()` creates a new `Set` on every call** (`env-overrides.ts:30`):
   Inside `hasEnv`, this is called once per env var per skill eligibility check. The cost is O(n) where n = number of active skill env keys (typically <10). This is negligible and the defensive copy prevents callers from mutating the internal map. No action needed.

4. **Test coverage is adequate** (`src/agents/skills.test.ts:486-542`):
   - Creates two skills requiring the same env var (`OPENAI_API_KEY`).
   - Configures only skill A with the key.
   - Applies env overrides, then checks: skill A eligible, skill B not eligible.
   - Uses `withClearedEnv` to isolate from ambient env state.
   - Verifies `process.env.OPENAI_API_KEY` is set (proving the leakage vector exists) before asserting skill B is excluded.

5. **Merge conflict resolution** (commit `83c11d182c` in `env-overrides.ts`):
   The diff shows the `allowedSensitiveKeys` loop (lines 169-173) and `normalizeResolvedSecretInputString` import are both present. Both main's changes and the branch's additions are correctly preserved. No conflict artifacts remain.

## Testing gaps (non-blocking)

- **No test for host-env-already-set scenario**: The test clears `OPENAI_API_KEY` before applying overrides. A complementary test where the host env already has `OPENAI_API_KEY` set (before any skill override) would verify that unrelated skills correctly see the host value as legitimate. This is covered by the implementation logic (`acquireActiveSkillEnvKey` returns false for externally managed keys) but not by a dedicated test.

## Residual Risk

- **Low**: The circular import between `config.ts` and `env-overrides.ts` is safe today but could become problematic if either module starts using top-level await or module-evaluation-time calls to the other module's exports.
- **Low**: `getActiveSkillEnvKeys()` returns a point-in-time snapshot. If skill overrides are applied/restored concurrently (e.g., async contexts), the snapshot could be stale. Current usage is synchronous, so this is not a practical concern.

## Validation

```
pnpm test -- src/agents/skills.test.ts
# Result: 15 passed (741ms)
```

## Summary

The fix correctly prevents cross-skill env var leakage by distinguishing between host-provided and skill-injected environment variables in `shouldIncludeSkill`. The implementation is minimal (10 net lines in `config.ts`), the logic handles all edge cases correctly, and the test directly validates the leakage scenario. The circular import is safe in ESM. No blocking issues found.

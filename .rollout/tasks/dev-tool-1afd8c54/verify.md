# Verification: Scope skill-injected env vars to prevent cross-skill leakage (PR #50432)

**Branch:** `fix/exec-skill-env-sensitive-keys`
**HEAD:** `aad4cc9a91` — `fix(skills): scope skill-injected env vars to prevent cross-skill leakage`
**Verified at:** 2026-03-20

## Spec Requirements Checklist

| #   | Requirement                                                                               | Status   | Evidence                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Branch rebased on origin/main with no conflict markers                                    | **PASS** | `grep -rn '<<<<<<\|>>>>>>\|=======' src/agents/skills/config.ts src/agents/skills/env-overrides.ts src/agents/skills.test.ts` returned exit code 1 (no matches). `git log --oneline origin/main..HEAD` shows branch commits on top of main.                                                                                                 |
| 2   | `shouldIncludeSkill` hasEnv callback distinguishes skill-injected vs host env vars        | **PASS** | `src/agents/skills/config.ts:96-109` — `hasEnv` callback first checks if the env var is configured for this specific skill (`skillConfig?.env?.[envName]` or `primaryEnv` match), returning `true` if so. Otherwise, it calls `getActiveSkillEnvKeys()` and only counts `process.env[envName]` if the key is NOT in the skill-injected set. |
| 3   | Sensitive-pattern env vars configured in `skills.entries.*.env` are allowed (test passes) | **PASS** | Test `"allows sensitive-pattern env vars explicitly configured in skills.entries.*.env"` (line 366) passes. Injects `GOG_KEYRING_PASSWORD` and `CUSTOM_SERVICE_TOKEN` via config and asserts they are set in `process.env`.                                                                                                                 |
| 4   | Dangerous host env vars still blocked (test passes)                                       | **PASS** | Test `"blocks dangerous host env overrides even when declared"` (line 405) passes. Attempts to inject `BASH_ENV` and `SHELL` via config and asserts they remain `undefined`.                                                                                                                                                                |
| 5   | Cross-skill leakage prevented (test passes)                                               | **PASS** | Test `"does not leak skill-injected env vars to unrelated skills for eligibility"` (line 486) passes. Skill A configures `OPENAI_API_KEY`; Skill B requires same key but has no config. After `applySkillEnvOverrides`, `shouldIncludeSkill` returns `true` for A but `false` for B.                                                        |
| 6   | All 15 tests in `skills.test.ts` pass                                                     | **PASS** | `pnpm test -- src/agents/skills.test.ts` output: `Test Files: 1 passed (1)`, `Tests: 15 passed (15)`, duration 845ms.                                                                                                                                                                                                                       |

## Code Evidence

### `hasEnv` callback (`src/agents/skills/config.ts:96-109`)

```typescript
hasEnv: (envName) => {
  // Check if this skill explicitly configures the env var
  const isConfiguredForThisSkill =
    Boolean(skillConfig?.env?.[envName]) ||
    Boolean(skillConfig?.apiKey && entry.metadata?.primaryEnv === envName);
  if (isConfiguredForThisSkill) {
    return true;
  }
  // Only count process.env if the value wasn't injected by another skill's overrides.
  const skillInjectedKeys = getActiveSkillEnvKeys();
  return Boolean(process.env[envName]) && !skillInjectedKeys.has(envName);
},
```

### Merge conflict resolution (`src/agents/skills/env-overrides.ts:169-189`)

Both `allowedSensitiveKeys` loop and `normalizeResolvedSecretInputString` are present and correctly integrated:

```typescript
// Allow all keys explicitly configured in skills.entries.*.env to pass sensitive-key checks.
for (const envKey of Object.keys(pendingOverrides)) {
  allowedSensitiveKeys.add(envKey);
}

const resolvedApiKey =
  normalizeResolvedSecretInputString({
    value: skillConfig.apiKey,
    path: `skills.entries.${skillKey}.apiKey`,
  }) ?? "";
```

## Test Output

```
> openclaw@2026.3.14 test /Users/travisxie/Desktop/openclaw
> node scripts/test-parallel.mjs -- src/agents/skills.test.ts

[test-parallel] start base workers=2 filters=1

 RUN  v4.1.0 /Users/travisxie/Desktop/openclaw

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  16:39:33
   Duration  845ms (transform 170ms, setup 32ms, import 448ms, tests 275ms, environment 0ms)

[test-parallel] done base code=0 elapsed=1.3s
```

## Verdict: **PASS** (clean)

All 6 spec requirements verified with mechanical evidence. No gaps found.

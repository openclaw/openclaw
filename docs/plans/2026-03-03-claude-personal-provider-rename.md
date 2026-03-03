# claude-personal Provider Rename Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all `claude-pro`/`claude-max` provider ID references with the single canonical ID `claude-personal`, update the CLI command name, guard the failover path so `claude-personal` sessions never silently cross into `anthropic` API auth, and update all documentation.

**Architecture:** `claude-personal` is the single provider ID for any Claude Pro/Max personal subscription. All prior string-comparison pairs (`=== "claude-pro" || === "claude-max"`) are replaced by the existing `isClaudeSubscriptionProvider()` helper or `SYSTEM_KEYCHAIN_PROVIDERS.has()`. The failover guard lives in `attempt.ts` where runtime selection happens: if the resolved provider is `claude-personal`, the fallback-to-Pi-runtime path must not allow it to re-resolve auth against `anthropic`. Docs are updated in English only (zh-CN is generated).

**Tech Stack:** TypeScript/ESM, Vitest, Mintlify docs

---

## Task 1: Strip legacy aliases from the two core constant files

Removes `claude-pro`/`claude-max` from the two sets that all routing logic reads.

**Files:**

- Modify: `src/agents/model-auth.ts:27`
- Modify: `src/agents/claude-sdk-policy-warning.ts:3`

**Step 1: Edit `model-auth.ts`**

Change:

```typescript
export const SYSTEM_KEYCHAIN_PROVIDERS = new Set(["claude-personal", "claude-pro", "claude-max"]);
```

To:

```typescript
export const SYSTEM_KEYCHAIN_PROVIDERS = new Set(["claude-personal"]);
```

**Step 2: Edit `claude-sdk-policy-warning.ts`**

Change:

```typescript
export const CLAUDE_SUBSCRIPTION_PROVIDERS = ["claude-pro", "claude-max"] as const;
```

To:

```typescript
export const CLAUDE_SUBSCRIPTION_PROVIDERS = ["claude-personal"] as const;
```

Also update the policy warning text to name the subscription generically:

```typescript
export const CLAUDE_SDK_POLICY_WARNING_LINES = [
  "Important Anthropic policy notice:",
  "Anthropic has stated that using the Claude Agent SDK for 24/7 autonomous bots is prohibited.",
  "Using a personal Claude subscription (Claude Pro or Max) for business purposes, or for people other than the subscriber, violates Anthropic Terms of Service.",
] as const;
```

**Step 3: Run type-check**

```bash
cd /Users/davidgarson/.codex/worktrees/30e2/openclaw && pnpm tsgo 2>&1 | head -60
```

Expected: errors only in files that still hard-code `"claude-pro"` / `"claude-max"` — those are the remaining tasks.

**Step 4: Commit**

```bash
scripts/committer "models: narrow SYSTEM_KEYCHAIN_PROVIDERS and CLAUDE_SUBSCRIPTION_PROVIDERS to claude-personal" \
  src/agents/model-auth.ts \
  src/agents/claude-sdk-policy-warning.ts
```

---

## Task 2: Update `auth.ts` — remove legacy aliases from `resolveTokenProvider`

The legacy alias mapping (`claude-pro` / `claude-max` → `claude-personal`) added during the partial migration is now removed. External callers passing old IDs will get `"custom"`, which is appropriate — they must update their config.

**Files:**

- Modify: `src/commands/models/auth.ts`

**Step 1: Update `resolveTokenProvider`**

Change:

```typescript
// Accept legacy claude-pro / claude-max aliases and the new canonical id
if (
  normalized === "claude-personal" ||
  normalized === "claude-pro" ||
  normalized === "claude-max"
) {
  return "claude-personal";
}
```

To:

```typescript
if (normalized === "claude-personal") {
  return "claude-personal";
}
```

**Step 2: Update the error message in `modelsAuthSetupClaudeProCommand`**

Change:

```typescript
throw new Error(
  "Only --provider claude-personal (or claude-pro / claude-max) is supported for setup-claude-pro.",
);
```

To:

```typescript
throw new Error("Only --provider claude-personal is supported for setup-claude-personal.");
```

**Step 3: Run type-check**

```bash
pnpm tsgo 2>&1 | head -60
```

**Step 4: Commit**

```bash
scripts/committer "auth: remove claude-pro/claude-max legacy aliases from resolveTokenProvider" \
  src/commands/models/auth.ts
```

---

## Task 3: Replace hard-coded checks in `attempt.ts` and `model.ts`

These two files contain the remaining runtime-dispatch logic that compares provider strings directly.

**Files:**

- Modify: `src/agents/pi-embedded-runner/run/attempt.ts`
- Modify: `src/agents/pi-embedded-runner/model.ts`

**Step 1: Fix `attempt.ts` runtime selector**

Find the function containing (around line 145-149):

```typescript
// Only the two system-keychain providers use the claude-sdk subprocess.
if (params.provider === "claude-pro" || params.provider === "claude-max") {
  return "claude-sdk";
}
```

Replace with — using the already-imported `SYSTEM_KEYCHAIN_PROVIDERS`:

```typescript
// Only system-keychain providers (claude-personal) use the claude-sdk subprocess.
if (SYSTEM_KEYCHAIN_PROVIDERS.has(params.provider)) {
  return "claude-sdk";
}
```

Verify `SYSTEM_KEYCHAIN_PROVIDERS` is imported at the top of the file; add the import if missing:

```typescript
import { SYSTEM_KEYCHAIN_PROVIDERS } from "../../model-auth.js";
```

**Step 2: Fix `model.ts` provider branch**

Find (around line 77):

```typescript
// claude-pro and claude-max run via the claude-sdk subprocess; resolve model
// metadata from the anthropic catalog for cost tracking and context budgeting,
// then preserve the provider so downstream routing still works.
if (provider === "claude-pro" || provider === "claude-max") {
```

Replace with:

```typescript
// claude-personal runs via the claude-sdk subprocess; resolve model
// metadata from the anthropic catalog for cost tracking and context budgeting,
// then preserve the provider so downstream routing still works.
if (SYSTEM_KEYCHAIN_PROVIDERS.has(provider)) {
```

Verify or add the import:

```typescript
import { SYSTEM_KEYCHAIN_PROVIDERS } from "../model-auth.js";
```

**Step 3: Run type-check**

```bash
pnpm tsgo 2>&1 | head -60
```

**Step 4: Commit**

```bash
scripts/committer "runner: use SYSTEM_KEYCHAIN_PROVIDERS.has() in attempt and model resolution" \
  src/agents/pi-embedded-runner/run/attempt.ts \
  src/agents/pi-embedded-runner/model.ts
```

---

## Task 4: Failover guard — prevent claude-personal → anthropic auth crossover

When `claude-personal` keychain auth is exhausted and the SDK falls back to Pi runtime, Pi runtime must not silently pick up `anthropic` API-key credentials for the same request. The fix: when the runtime falls back to Pi for a `claude-personal` session, the auth provider stays `claude-personal` — and since Pi runtime has no `claude-personal` API key, it will correctly surface an auth error rather than silently bill an API key.

**Files:**

- Read first: `src/agents/claude-sdk-runner/auth-resolution.ts` (the `fallBackToPiRuntime` closure)
- Read first: `src/agents/pi-embedded-runner/run/auth-profile-failover.ts` (how Pi runtime resolves auth after fallback)

**Step 1: Verify the invariant**

Read `auth-resolution.ts` and confirm that `fallBackToPiRuntime()` sets `runtimeOverride = "pi"` but does **not** change `authProvider`. If `authProvider` remains `"claude-personal"` after fallback, Pi runtime will attempt to find a `claude-personal` credential — failing cleanly when none exists — rather than falling through to `anthropic`. This is the correct behavior; confirm it in the code before touching anything.

**Step 2: Add an explicit guard if the invariant is not already enforced**

If `fallBackToPiRuntime()` or any downstream path changes `authProvider` to `"anthropic"` for model resolution purposes, add an assertion/guard in `auth-resolution.ts`:

```typescript
// When falling back from claude-sdk to Pi runtime for a claude-personal session,
// keep authProvider as "claude-personal". Pi runtime will fail auth cleanly
// rather than crossing into anthropic API-key credentials.
fallBackToPiRuntime: async () => {
  if (isSystemKeychain) {
    runtimeOverride = "pi";
    // authProvider intentionally unchanged — must remain "claude-personal"
    return true;
  }
  return false;
},
```

**Step 3: Write a regression test**

In `src/agents/claude-sdk-runner/auth-resolution.test.ts`, add a test:

```typescript
it("fallBackToPiRuntime preserves claude-personal as authProvider", async () => {
  const state = await createClaudeSdkAuthResolutionState({
    provider: "claude-personal",
    cfg: undefined,
    claudeSdkConfig: undefined,
    authStore: makeEmptyAuthStore(),
    agentDir: undefined,
    preferredProfileId: undefined,
    authProfileIdSource: undefined,
  });
  await state.fallBackToPiRuntime();
  expect(state.authProvider).toBe("claude-personal");
  // Must NOT be "anthropic" — that would silently cross provider boundaries
  expect(state.authProvider).not.toBe("anthropic");
});
```

**Step 4: Run the test**

```bash
pnpm test src/agents/claude-sdk-runner/auth-resolution.test.ts 2>&1 | tail -30
```

Expected: PASS (if invariant was already correct) or reveals the gap.

**Step 5: Commit**

```bash
scripts/committer "auth: guard claude-personal fallback to Pi runtime against anthropic auth crossover" \
  src/agents/claude-sdk-runner/auth-resolution.ts \
  src/agents/claude-sdk-runner/auth-resolution.test.ts
```

---

## Task 5: Rename CLI command `setup-claude-pro` → `setup-claude-personal`

Keep a hidden alias on the old name so existing scripts don't hard-fail, but point all output/docs at the new name.

**Files:**

- Modify: `src/cli/models-cli.ts` (around line 326)
- Modify: `src/commands/models/auth.ts` (function name)

**Step 1: Rename the exported function**

In `src/commands/models/auth.ts`, rename:

```typescript
export async function modelsAuthSetupClaudeProCommand(
```

To:

```typescript
export async function modelsAuthSetupClaudePersonalCommand(
```

**Step 2: Update `models-cli.ts`**

Change the command definition:

```typescript
auth
  .command("setup-claude-personal")
  .description("Create a claude-personal (Claude Pro/Max) system-keychain auth profile")
  .option("--provider <name>", "Provider id (default: claude-personal)")
  .option("--profile-id <id>", "Auth profile id (default: claude-personal:system-keychain)")
  .option("--yes", "Skip confirmation when interactive", false)
  .action(async (opts) => {
    await runModelsCommand(async () => {
      await modelsAuthSetupClaudePersonalCommand(
        {
          provider: opts.provider as string | undefined,
          profileId: opts.profileId as string | undefined,
          yes: Boolean(opts.yes),
        },
        defaultRuntime,
      );
    });
  });

// Backward-compat alias — hidden from help output
auth
  .command("setup-claude-pro", { hidden: true })
  .option("--provider <name>")
  .option("--profile-id <id>")
  .option("--yes", undefined, false)
  .action(async (opts) => {
    await runModelsCommand(async () => {
      await modelsAuthSetupClaudePersonalCommand(
        {
          provider: opts.provider as string | undefined,
          profileId: opts.profileId as string | undefined,
          yes: Boolean(opts.yes),
        },
        defaultRuntime,
      );
    });
  });
```

**Step 3: Update any import references** to use `modelsAuthSetupClaudePersonalCommand`.

**Step 4: Run type-check + build**

```bash
pnpm tsgo 2>&1 | head -40 && pnpm build 2>&1 | tail -20
```

**Step 5: Commit**

```bash
scripts/committer "cli: rename setup-claude-pro → setup-claude-personal, keep hidden alias" \
  src/cli/models-cli.ts \
  src/commands/models/auth.ts
```

---

## Task 6: Update tests

All test fixtures using `"claude-pro"` or `"claude-max"` as provider strings must be updated to `"claude-personal"`. Profile IDs change from `claude-pro:system-keychain` → `claude-personal:system-keychain`.

**Files:**

- Rename+update: `src/commands/models/auth.setup-claude-pro-disclaimer.test.ts` → `auth.setup-claude-personal-disclaimer.test.ts`
- Update: `src/agents/model-auth.test.ts`
- Update: `src/agents/claude-sdk-runner/auth-resolution.test.ts`
- Update: `src/agents/pi-embedded-runner/claude-sdk-runtime-failover.test.ts`
- Update: `src/agents/pi-embedded-runner/run/auth-profile-failover.test.ts`
- Update: `src/agents/pi-embedded-runner/run/attempt.test.ts`
- Update: `src/agents/pi-embedded-runner/run.overflow-compaction.loop.test.ts`
- Update: `src/agents/pi-embedded-runner/run.overflow-compaction.test.ts`
- Update: `src/agents/pi-embedded-runner/usage-reporting.test.ts`
- Update: `src/agents/pi-embedded-runner/run.overflow-compaction.mocks.shared.ts`
- Update: `src/gateway/gateway-claude-sdk-media-resume.live.test.ts`
- Update: `src/agents/claude-sdk-runner/create-session.test.ts`

**Step 1: Rename the disclaimer test file**

```bash
mv src/commands/models/auth.setup-claude-pro-disclaimer.test.ts \
   src/commands/models/auth.setup-claude-personal-disclaimer.test.ts
```

Update its contents: replace every `"claude-pro"` with `"claude-personal"` and `"claude-pro:system-keychain"` with `"claude-personal:system-keychain"`. Update the `describe` label and import.

**Step 2: Bulk-update remaining test files**

For each file listed above, replace:

- `"claude-pro"` → `"claude-personal"` (provider strings in fixtures)
- `"claude-max"` → `"claude-personal"` (provider strings in fixtures)
- `claude-pro:` → `claude-personal:` (profile ID prefixes)
- `claude-max:` → `claude-personal:` (profile ID prefixes)
- `new Set(["claude-pro"])` → `new Set(["claude-personal"])` (mock sets)
- `new Set(["claude-pro", "claude-max"])` → `new Set(["claude-personal"])` (mock sets)
- Description strings like `"uses claude-sdk runtime for system-keychain provider (claude-pro)"` → use `claude-personal`

**Step 3: Run the full test suite**

```bash
pnpm test 2>&1 | tail -40
```

Expected: all tests pass. No references to `claude-pro` or `claude-max` should remain in error output.

**Step 4: Commit**

```bash
scripts/committer "tests: migrate all claude-pro/claude-max fixtures to claude-personal" \
  src/commands/models/auth.setup-claude-personal-disclaimer.test.ts \
  src/agents/model-auth.test.ts \
  src/agents/claude-sdk-runner/auth-resolution.test.ts \
  src/agents/pi-embedded-runner/claude-sdk-runtime-failover.test.ts \
  src/agents/pi-embedded-runner/run/auth-profile-failover.test.ts \
  src/agents/pi-embedded-runner/run/attempt.test.ts \
  src/agents/pi-embedded-runner/run.overflow-compaction.loop.test.ts \
  src/agents/pi-embedded-runner/run.overflow-compaction.test.ts \
  src/agents/pi-embedded-runner/usage-reporting.test.ts \
  src/agents/pi-embedded-runner/run.overflow-compaction.mocks.shared.ts \
  src/gateway/gateway-claude-sdk-media-resume.live.test.ts \
  src/agents/claude-sdk-runner/create-session.test.ts
```

---

## Task 7: Update English documentation

Do not touch `docs/zh-CN/` — that is generated.

**Files to update:**

- `docs/concepts/claude-sdk-runtime.md`
- `docs/concepts/model-failover.md`
- `docs/concepts/model-providers.md`
- `docs/cli/models.md`
- `docs/cli/index.md`
- `docs/help/faq.md`
- `docs/providers/index.md`
- `docs/providers/claude-max-api-proxy.md` — rename to `docs/providers/claude-personal.md` and update `docs/docs.json`

**Step 1: Read each doc file before editing** to understand current content and section structure.

**Step 2: For each doc, replace:**

- `claude-pro` / `claude-max` provider IDs → `claude-personal`
- CLI command `setup-claude-pro` → `setup-claude-personal`
- Profile ID examples `claude-pro:system-keychain` / `claude-max:system-keychain` → `claude-personal:system-keychain`
- Explanatory text distinguishing Pro vs Max → collapse to "personal Claude subscription (Pro or Max)"
- Any hint that Pro and Max are different providers → clarify they share one provider ID

**Step 3: `docs/providers/claude-max-api-proxy.md`** — this doc is about a third-party proxy, not the native `claude-max` provider. Rename it to `claude-personal.md` and update its title and internal references. Update `docs/docs.json` navigation entry accordingly.

**Step 4: Verify no remaining references**

```bash
grep -r "claude-pro\|claude-max" docs/ --include="*.md" --exclude-dir=zh-CN
```

Expected: zero matches (or only references in historical/advisory context that are clearly labeled as deprecated).

**Step 5: Commit**

```bash
scripts/committer "docs: rename claude-pro/claude-max to claude-personal throughout" \
  docs/concepts/claude-sdk-runtime.md \
  docs/concepts/model-failover.md \
  docs/concepts/model-providers.md \
  docs/cli/models.md \
  docs/cli/index.md \
  docs/help/faq.md \
  docs/providers/index.md \
  docs/providers/claude-personal.md \
  docs/docs.json
```

---

## Task 8: Final verification

**Step 1: Grep for any remaining hard-coded strings in src/**

```bash
grep -r '"claude-pro"\|"claude-max"' src/ --include="*.ts" | grep -v "\.test\."
```

Expected: zero matches in non-test source files.

**Step 2: Full type-check**

```bash
pnpm tsgo 2>&1 | tail -10
```

Expected: no errors.

**Step 3: Full test run**

```bash
pnpm test 2>&1 | tail -20
```

Expected: all pass.

**Step 4: Lint**

```bash
pnpm check 2>&1 | tail -10
```

**Step 5: Commit any straggler fixes, then done.**

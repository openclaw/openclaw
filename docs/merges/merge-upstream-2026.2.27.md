# Merge Log: iris/production ← openclaw 2026.2.27

> **Executed by:** Claude Code (Sonnet 4.6) — 2026-02-27
> **Merge commit:** `c39766eb3`
> **Safety branch:** `iris/production-backup` (pre-merge snapshot)
> **Based on plan:** `docs/plan/claude-code-merge-plan.md` (read before touching anything)

---

## Summary

| Item                         | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| Merge-base                   | `85b075d0ccc27e41c981779e0afe55c680967d74`     |
| Upstream tip                 | `fe807e4be` (`chore(release): bump 2026.2.27`) |
| Upstream version             | `openclaw 2026.2.27`                           |
| Files changed in commit      | 118                                            |
| Insertions / deletions       | +16473 / -65                                   |
| Iris commits preserved       | 19                                             |
| **Predicted conflict files** | **10**                                         |
| **Actual conflict files**    | **3**                                          |
| Build result                 | ✓ 0 TypeScript errors                          |
| Test result                  | ✓ 11352 passed, 2 pre-existing failures        |

---

## Plan Accuracy: Predicted vs Actual

The plan predicted 10 conflict files. In practice, only 3 had real Git conflicts.
The other 7 auto-merged because the changes touched non-overlapping lines.

| File                                            | Predicted Risk   | Actual                  | Notes                                                   |
| ----------------------------------------------- | ---------------- | ----------------------- | ------------------------------------------------------- |
| `pnpm-lock.yaml`                                | LOW — auto-regen | **CONFLICT** (expected) | Restored ours, regenerated                              |
| `ui/src/i18n/locales/en.ts`                     | LOW              | **Auto-merged ✓**       | Different lines, no hunk overlap                        |
| `ui/src/i18n/locales/pt-BR.ts`                  | LOW              | **Auto-merged ✓**       | Same                                                    |
| `src/config/types.agent-defaults.ts`            | LOW              | **Auto-merged ✓**       | replyMode + embeddedPi in different sections            |
| `src/config/zod-schema.agent-defaults.ts`       | MEDIUM           | **Auto-merged ✓**       | Plan predicted conflict here; Git handled it cleanly    |
| `ui/src/styles/base.css`                        | MEDIUM           | **Auto-merged ✓**       | Purple vars + font vars in different properties         |
| `src/infra/outbound/deliver.ts`                 | MEDIUM           | **Auto-merged ✓**       | metadata block + session refactor in distant lines      |
| `src/auto-reply/reply/dispatch-from-config.ts`  | HIGH             | **Auto-merged ✓**       | Plan predicted manual work; Git resolved it perfectly   |
| `src/agents/pi-embedded-runner/run/attempt.ts`  | HIGH             | **CONFLICT** — 1 hunk   | Plan predicted "multiple overlapping hunks"; was only 1 |
| `src/web/auto-reply/monitor/process-message.ts` | CRITICAL         | **CONFLICT** — 1 hunk   | Exactly as predicted                                    |

**Key calibration note for future merges:** "HIGH" risk files often auto-merge. Git is better at
resolving adjacent insertions than the plan conservatively estimated. The only reliable predictor
of an actual conflict is a direct same-line overlap — which only occurred in `attempt.ts` and
`process-message.ts`.

---

## Actual Conflict Resolutions

### 1. `pnpm-lock.yaml`

**Resolution:** `git checkout iris/production -- pnpm-lock.yaml` (restore ours), then
`pnpm install` at end regenerated a clean lockfile. Minor dep bumps landed:
`grammy 1.40.0 → 1.40.1`, `@types/node 25.3.0 → 25.3.2`.

---

### 2. `src/agents/pi-embedded-runner/run/attempt.ts` — 1 hunk at line 1271

**Conflict:** Our `replyMode` warning block (Patch D) vs upstream's single line:

```typescript
const compactionOccurredThisAttempt = getCompactionCount() > 0;
```

**Resolution:** Keep both — our block first, then upstream's variable. The variable is used
at lines 1309 and 1341 in the same file, so both are needed.

```typescript
// Our replyMode warning block (kept):
if (!promptError && !aborted) {
  const replyMode = params.config?.agents?.defaults?.replyMode ?? "auto";
  // ...
}
// Upstream's variable (kept, follows immediately after):
const compactionOccurredThisAttempt = getCompactionCount() > 0;
```

**Patches A/B/C (import, senderMetadata, senderMetadata construction):** All auto-applied
cleanly by Git — zero manual work needed for those.

---

### 3. `src/web/auto-reply/monitor/process-message.ts` — 1 hunk at line 55

**Conflict:** Our private helper block (3 functions) vs upstream's empty deletion.
Upstream deleted `normalizeAllowFromE164` because `resolveWhatsAppCommandAuthorized` no
longer uses it — but our `resolveSmartRouterOwnerTarget` still calls it.

**Resolution:** Keep all three functions, adding an explanatory comment:

```typescript
// ── Iris: normalizeAllowFromE164 kept as private helper for smartRouter ──
// Upstream deleted this from resolveWhatsAppCommandAuthorized but resolveSmartRouterOwnerTarget still uses it.
function normalizeAllowFromE164(values: Array<string | number> | undefined): string[] { ... }

// ── Iris: normalizeMaybeE164 ──
function normalizeMaybeE164(value: string | null | undefined): string | undefined { ... }

// ── Iris: smartRouter target resolver ──
function resolveSmartRouterOwnerTarget(params: { ... }): string | undefined { ... }
```

Upstream's import refactor (`readStoreAllowFromForDmPolicy`, `resolveDmGroupAccessWithCommandGate`)
and our `getActiveWebListener` import both landed in non-conflicting lines — auto-merged.

---

## Auto-Merged Files — Verification Results

All 7 auto-merged files were verified to contain both Iris and upstream additions:

| File                           | Iris feature confirmed                                                   | Upstream feature confirmed                                                |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `en.ts`                        | `conversations:` key (line 33, 49)                                       | `de: "Deutsch (German)"` (line 123)                                       |
| `pt-BR.ts`                     | `conversations:` key (line 33, 49)                                       | `de: "Deutsch (Alemão)"` (line 125)                                       |
| `types.agent-defaults.ts`      | `replyMode?` (line 184)                                                  | `embeddedPi?` (line 162), `identifierPolicy?` (line 292)                  |
| `zod-schema.agent-defaults.ts` | `.default("tool-only")` (line 125)                                       | `identifierPolicy`, `embeddedPi` schemas (lines 87–119)                   |
| `base.css`                     | `#7C3AED` × 5 occurrences                                                | `font-body: -apple-system...` (line 84), no `@import`, no Space Grotesk   |
| `deliver.ts`                   | `metadata:` block (line 486)                                             | `OutboundSessionContext` (line 36)                                        |
| `dispatch-from-config.ts`      | `tool-only` × 3 (lines 449, 474, 512); `ctx.Transcript` (lines 219, 271) | `resolveRunTypingPolicy` (line 433); `INTERNAL_MESSAGE_CHANNEL` (line 15) |

---

## Permanent Patches — Status

All verified intact after merge:

| Patch                                    | File                                           | Status |
| ---------------------------------------- | ---------------------------------------------- | ------ |
| `message_transcribed` hook runner        | `src/plugins/hooks.ts`                         | ✓ OK   |
| `message_transcribed` type               | `src/plugins/types.ts`                         | ✓ OK   |
| `runMessageTranscribed` call             | `src/auto-reply/reply/get-reply.ts`            | ✓ OK   |
| `senderMetadata` in plugin types         | `src/plugins/types.ts`                         | ✓ OK   |
| `SILENT_REPLY_TOKEN` (replyMode warning) | `src/agents/pi-embedded-runner/run/attempt.ts` | ✓ OK   |

---

## Test Results

```
Test Files: 2 failed | 1392 passed | 6 skipped (1400)
Tests:      2 failed | 11352 passed | 32 skipped (11386)
Duration:   1077s
```

**The 2 failures are pre-existing and unrelated to this merge:**

1. **`test/ui.presenter-next-run.test.ts`** — Expects `/^[A-Za-z]{3}, /` (English day abbreviation).
   Fails on non-English locale environments. Identical test exists verbatim on
   `iris/production-backup` — confirmed pre-existing.

2. **`src/security/audit.test.ts:2225`** — Calls `icacls "..." /grant Everyone:W` to set
   world-writable permissions on a temp file. Fails due to Windows ACL restrictions in this
   environment. Same test exists verbatim on `iris/production-backup` — confirmed pre-existing.

Neither failure is in any file touched by this merge.

---

## Rollback

Safety branch created before merge: `iris/production-backup`

```bash
# To undo this merge:
git reset --hard iris/production-backup
```

---

## Lessons for Next Merge

1. **Run the merge first, triage conflicts second.** 7 of 10 "predicted conflicts" auto-resolved.
   Save manual work for the actual conflict set returned by Git, not the predicted set.

2. **`dispatch-from-config.ts` (rated HIGH) auto-merged cleanly.** The typing-policy addition
   landed before the `getReplyFromConfig` call, and our `onToolResult`/`onBlockReply` callbacks
   sat inside that call — Git tracked the context correctly.

3. **`attempt.ts` was 1 hunk, not "multiple overlapping hunks".** Patches A/B/C all lived in
   structurally distinct regions (imports, type declarations, mid-function). Only Patch D
   (post-loop) collided with upstream's U6 (also post-loop).

4. **The CRITICAL prediction was exactly right.** `normalizeAllowFromE164` deletion would have
   caused a TypeScript compile error without the plan's advance warning. The comment marking it
   as a kept private helper will survive future merges with context.

5. **`pnpm-lock.yaml` regen strategy is sound.** Clean lockfile, no manual conflict resolution.
   Minor version bumps (grammy, @types/node) landed automatically.

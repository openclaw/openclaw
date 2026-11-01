---
name: pr-simplify
description: "Simplify your own change to its smallest complete fix. Use before opening a PR, before pushing large repairs to one, or when asked to shrink a PR or clean up slop."
---

# Simplify the change

An editing pass by the change's author: run it on your own branch before you open the PR, and again before you push large repairs. It precedes review and never replaces it. Inherit the task's scope and repair authority; a review-only request gets findings instead of edits. The chosen maintainer workflow owns publication, review and merge.

**The diff is a proposal.** Passing tests show it works, not that its architecture or every added test is needed.

**Rules:** the root `AGENTS.md` sections "Design priorities", "One owner, complete cutover", "Runtime and code safeguards" and "Product and validation", plus the nearest scoped `AGENTS.md`. Steps 2 and 3 apply every rule to every changed file.

## 1. Re-derive the smallest complete fix

Read the user's outcome and latest scope, the complete diff against the target merge base, and retained proof. Reuse session context already gathered. Then ask:

> Starting from the base, what is the smallest complete fix using the owners already present? Would I still introduce this architecture?

Inspect the largest added modules, state, adapters and test scaffolding first. Read their direct callers and relevant history: apparently redundant behavior may protect a shipped configuration or an earlier regression. Scope is the changed system and the paths it replaces.

Trace every changed hunk to the stated outcome. A hunk that serves another goal leaves this change: drop it or move it to its own PR.

Count the non-mechanical changed lines. Above about 800, or about 500 for complex logic, name the smallest coherent stage that can land first and cut the change to that stage.

Done when you can state the defect, the required invariant, and the smallest complete fix in one sentence each, and every remaining hunk serves that fix.

## 2. Remove unnecessary architecture

Apply each supported simplification in the diff:

- **One decision owner.** Move repeated caller-side policy into the operation that owns the decision. Migrate affected callers and remove the old implementations, exports and repair branches. Different transports can share a decision while keeping their own delivery contracts.
- **Existing state first.** Challenge new schemas, managers, caches and combined representations. Reuse an existing owner when its lifetime, authority, atomicity and cleanup fit. Remove a proposed migration only when it is genuinely unnecessary; keep the migration that keeps existing config and state working after update. New state belongs in a field that means it.
- **Delete the redundant path.** Remove parallel renderers, duplicated parsers, fake lifecycle operations used only to obtain a result, derived state callers can already obtain, and wrappers that merely forward or rename. Prefer one simpler representation over fallback modes around the old one.
- **Polish last.** In every changed hunk, keep only what a maintainer of the surrounding file would write:
  - comments that explain ownership, lifecycle, ordering or constraints;
  - checks and `try`/`catch` blocks that match the surrounding module and guard real states;
  - real types instead of laundering casts (`as any`, `as unknown as T`, widen-then-assert);
  - variables and helpers that add domain meaning, remove duplication or simplify control flow;
  - shims, aliases, retries and fallbacks backed by a named shipped contract and removal plan;
  - naming, control flow, imports and formatting that match the surrounding file.

Preserve the requested fix and supported behavior, not the proposal's accidental design. Keep real domain differences and justified public compatibility. When history (`git log -p -S <symbol>`) leaves a path's purpose unclear, keep it and report it. Report new product decisions, breaking contracts, unrelated cleanup and destructive branch replacement as findings for the owner.

## 3. Keep tests for failures

For each added or changed test group and its setup helpers, name the distinct observable failure it catches.

Keep regressions for the actual defect and distinct boundaries: ordering, cancellation, stale authority, restart, rejection, real errors and affected consumer differences. Keep static contract guards that independently protect a real boundary. Remove duplicate same-path cases, mock echoes, incidental field-copy or wording assertions, assertions on statically defined values, tests that only prove removed logic is gone, tests of obsolete implementations, and scaffolding or test-only production hooks. Consolidate useful cases in an existing owner suite.

Removing tests never weakens the assertions, coverage of real boundaries or baselines that remain.

Done when every remaining test group has a named failure.

## 4. Prove the smaller change and hand it on

Batch the edits, then rerun the reproduction and focused checks for the changed contracts and affected consumers. Reuse proof whose inputs are unchanged. A preserved restart, upgrade or transport claim needs applicable proof. The existing workflow selects broader checks.

Done when the complete diff is inspected, every rule has a verdict for each changed file, supported simplifications are applied, superseded paths are unreachable and affected behavior still has proof. No change is a valid result when the existing shape is justified. Aim for net-negative code, not a deletion quota.

Report in the PR body or existing task evidence: the responsibility or machinery that disappeared, the behavior still protected, and production/test deltas against the merge base. Label a reduction against an earlier revision separately from the whole-change delta. Name any necessary remaining growth or unresolved decision.

Then open or update the PR. After later repairs, simplify only the new changes and the owners they touch before pushing them.

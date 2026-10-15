---
name: pr-simplify
description: "Simplify a prepared PR before review: remove unnecessary architecture, competing owners, low-value tests and diff slop while preserving behavior and shipped contracts. Use before the first review request of a nontrivial PR, after large repairs, or for requested PR-size reduction."
---

# Simplify the PR

An editing pass by the PR owner, not another review stage. Inherit the task's scope and repair authority; review-only requests get findings, not edits. The chosen maintainer workflow still owns publication, review and merge. Run this pass before review, never instead of it.

**The current implementation is a proposal, not a constraint.** Passing tests do not establish that its architecture or every added test is necessary. Remove the reasons for excess code before polishing its wording.

## 1. Re-derive the smallest fix

Read the user's outcome and latest scope, the complete PR diff against its target merge base, and retained proof. Use existing session context rather than repeating investigation. The rules for steps 2 and 3 are the root `AGENTS.md` sections "Design priorities", "One owner, complete cutover", "Runtime and code safeguards" and "Product and validation", plus the nearest scoped `AGENTS.md`. State the defect and required invariant in one sentence. Then ask:

> Starting from the base, what is the smallest complete fix using the owners already present? Would I still introduce this architecture?

Inspect the largest added modules, state, adapters and test scaffolding first. Read their direct callers and relevant history: apparently redundant behavior may protect a shipped configuration or an earlier regression. Scope is the changed system and the paths it replaces, not a repository-wide cleanup. Keep independent small PRs moving rather than making them wait for this pass.

## 2. Remove unnecessary architecture

Apply supported simplifications, not just a list of suggestions:

- **One decision owner.** Move repeated caller-side policy into the operation that owns the decision. Migrate affected callers and remove the old implementations, exports and repair branches. Different transports can share a decision without pretending their delivery contracts are identical.
- **Existing state first.** Challenge new schemas, managers, caches and combined representations. Reuse an existing owner only when its lifetime, authority, atomicity and cleanup fit. Remove a proposed migration and its machinery when they are genuinely unnecessary; preserve restart and released-user compatibility, including the migration that keeps existing config and state working after update. Never hide state in an unrelated field to avoid a schema change.
- **Delete the redundant path.** Remove parallel renderers, duplicated parsers, fake lifecycle operations used only to obtain a result, derived state that callers can already obtain, and wrappers that merely forward or rename. Prefer one simpler representation over more fallback modes around the old one.
- **Polish last.** In every changed hunk, keep only what a maintainer of the surrounding file would write:
  - comments that explain ownership, lifecycle, ordering or constraints, not narration or restated code;
  - checks and `try`/`catch` blocks that match the surrounding module and guard real states;
  - real types, not laundering casts such as `as any`, `as unknown as T` or widen-then-assert flows;
  - intermediate variables and helpers that add domain meaning, remove duplication or simplify control flow;
  - compatibility shims, aliases, retries and fallbacks only with a named shipped contract and removal plan;
  - naming, control flow, imports and formatting that match the surrounding file.

Preserve the requested fix and supported behavior, not the candidate's accidental design. Keep real domain differences and justified public compatibility. New product decisions, breaking contracts, unrelated cleanup and destructive branch replacement remain outside this pass's authority.

## 3. Keep tests for failures, not implementation lines

Inspect added and changed test groups with their setup helpers. What distinct observable failure would each catch?

Keep regressions for the actual defect and distinct boundaries: ordering, cancellation, stale authority, restart, rejection, real errors and affected consumer differences. Remove duplicate same-path cases, mock echoes, incidental field-copy or wording assertions, and tests of obsolete implementations; remove scaffolding and test-only production hooks that become unused. Keep static contract guards where they independently protect a real boundary.

Consolidate useful cases in an existing owner suite where possible. A large passing count is not a defense of redundant tests. Conversely, a negative line count is not permission to erase meaningful coverage, weaken assertions or change baselines. No per-test justification ledger or mandatory new test harness.

## 4. Prove the smaller change and hand it back

Batch the edits, then rerun the reproduction and focused checks for the changed contracts and affected consumers. Reuse proof whose inputs are unchanged. A preserved restart, upgrade or transport claim needs applicable proof, not just a passing helper. The existing workflow selects required broader checks; this pass does not add another full-suite or review cycle.

Finish when the complete diff has been inspected, every rule from step 1 has a verdict for each changed file, supported simplifications are applied, superseded paths are unreachable and affected behavior still has proof. No change is a valid result when the existing shape is justified. Prefer net-negative code, not a deletion quota; do not spend extra passes chasing a number.

Report briefly in existing task evidence: which responsibility or machinery disappeared, what behavior remains protected, and the production/test deltas against the PR base. Label any reduction against an earlier candidate separately; shrinking the last revision does not make the whole PR net-negative. Explain necessary remaining growth or a concrete unresolved decision without creating a new report file.

Return to the maintainer workflow before its final push and exact-head review. If later repairs change code, simplify the new changes and affected owners before the next review; do not restart an unchanged whole-PR pass.

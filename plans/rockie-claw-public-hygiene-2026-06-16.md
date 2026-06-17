# Rockie-Claw Public Hygiene and Ancestry Repair Plan

## Objective

Make `Rockielab/rockie-claw` credible as a public OpenClaw-derived repository for Rockie BYOK tenant runtimes by documenting the fork's purpose, documenting the Rockie-owned surface, and producing a safe ancestry-repair path for the squash-merged upstream catch-up in PR #99.

## Non-goals

- Do not force-push public `main` as part of this PR.
- Do not rewrite published history without a separate explicit maintainer approval.
- Do not move large OpenClaw core patches during this cascade unless the move is small, mechanical, and covered by existing tests.
- Do not publish Rockie-private operational details, tenant secrets, deployment credentials, or private customer/runtime specifics.

## Evidence

| Question | Command | Current evidence |
| --- | --- | --- |
| What did PR #99 merge? | `gh pr view 99 --repo Rockielab/rockie-claw --json headRefOid,mergeCommit,mergedAt` | PR head `b5eb09cbdc7242bbcbe3af767eb10816ac445c42`; squash merge `c35f6665ab57dcf64c0cd4cb66b879a672788db2`; merged `2026-06-16T11:01:25Z`. |
| Is current main the squash tree? | `git rev-parse origin/main^{tree} c35f6665ab57dcf64c0cd4cb66b879a672788db2^{tree}` | Both are `93d51edc21b8550be41c060bd10387b3ae93cd03`. |
| Is current main ancestry-preserving? | `git merge-base --is-ancestor b5eb09cbdc7242bbcbe3af767eb10816ac445c42 origin/main`; `git merge-base --is-ancestor d1b33a6040a47e39aa53500b818f9ed172b769de origin/main` | Both exit non-zero; the squash merge broke ancestry even though the commit objects exist locally. |
| What drift exists from PR #99 head to current main? | `git diff --name-status b5eb09cbdc7242bbcbe3af767eb10816ac445c42..origin/main` | Drift is concentrated in seven Rockie runtime/broker files: `Dockerfile.multitenant`, `apps/broker/README.md`, `apps/broker/chat_pty.go`, `apps/broker/chat_pty_test.go`, `apps/broker/main.go`, `apps/broker/skill_overlay.go`, `apps/broker/skill_overlay_test.go`. |
| How large is that drift? | `git diff --stat b5eb09cbdc7242bbcbe3af767eb10816ac445c42..origin/main` | `7 files changed, 1081 insertions(+), 144 deletions(-)`. |
| Where is Rockie's fork delta against OpenClaw anchor? | `git diff --dirstat=files,0 d1b33a6040a47e39aa53500b818f9ed172b769de..origin/main` | Main areas include `apps/broker/**`, `overlay/**`, runtime workflows, scripts/tests, and core patches in `src/agents/**`, `src/infra/**`, `src/process/**`, `src/secrets/**`, and `src/gateway/**`. |

## Milestones

### 1. Document the public positioning

Edit `README.md` so the first screen says:

- This repository is Rockie's packaged OpenClaw fork for BYOK tenant runtimes.
- Upstream OpenClaw remains the base project.
- Rockie-specific runtime code is intentionally isolated where possible.
- Public consumers should expect this repository to track OpenClaw while carrying Rockie tenant-runtime integration patches.

Keep the wording short and public-safe. Avoid internal fleet, customer, or secret-management details that increase future upstream conflicts.

### 2. Add a fork-surface and patch map

Create or update a public-facing document, preferably `docs/rockie-fork-surface.md`, with:

- Intended Rockie-owned prefixes:
  - `Dockerfile.multitenant`
  - `overlay/multitenant/**`
  - `overlay/tenant/**`
  - `apps/broker/**`
  - `overlay/multitenant/mcp-rockie/**`
  - runtime image and rollout workflows under `.github/workflows/**`
  - runtime rollout/build scripts under `scripts/**`
  - runtime tests under `overlay/multitenant/tests/**` and relevant `test/scripts/**`
- Core OpenClaw patches currently outside those prefixes, grouped by reason:
  - BYOK runtime sandbox and process execution support.
  - Gateway/auth hardening required for tenant runtime operation.
  - Agent tool and owner-authorization boundaries.
  - Secret/runtime platform integration.
  - Media and supervisor changes required by packaged runtime behavior.
- For each group, state whether it is a deliberate Rockie patch, a candidate to move behind overlay/plugin/config boundaries, or a follow-up needing design.

### 3. Produce a concrete ancestry-repair proof without rewriting history

Create or update a public-safe proof note, preferably `docs/upstream-ancestry-repair.md`, that includes:

- PR #99 was squash-merged as `c35f6665`, so GitHub cannot see upstream commit `d1b33a6` as an ancestor of `main`.
- The original PR head `b5eb09c` is the ancestry-preserving catch-up candidate.
- Current `main` is tree-equivalent to `c35f6665`, not to `b5eb09c`; the exact post-head drift is the seven-file broker/runtime delta listed above.
- A concrete proof artifact produced during implementation:
  1. Pin current main: record `git rev-parse origin/main` and `git rev-parse origin/main^{tree}`.
  2. Create a local proof branch from `b5eb09cbdc7242bbcbe3af767eb10816ac445c42`.
  3. Reapply exactly the seven-file drift from the pinned current main, either by cherry-picking the relevant post-PR-head commits when available or by checking out those paths from the pinned current main.
  4. Record the proof branch commit and tree.
  5. Run and record these checks:
     - `git merge-base --is-ancestor d1b33a6040a47e39aa53500b818f9ed172b769de <proof-branch>`
     - `git merge-base --is-ancestor b5eb09cbdc7242bbcbe3af767eb10816ac445c42 <proof-branch>`
     - `git diff --exit-code <pinned-current-main-tree> <proof-branch-tree>`
  6. Save the full command transcript or a concise reproducible summary in the proof note.
  7. Push the proof branch if it is needed for PR review, but do not retarget or merge `main`.
- Safest repository-owner repair path after this PR:
  1. Open a visible repair PR from the proof branch.
  2. Confirm the proof branch tree is identical to the pinned current `main` tree.
  3. Only after maintainer approval, use an ancestry-preserving repository-owner operation to move `main` onto that proof lineage.
- Future upstream-sync PRs must preserve upstream ancestry through real merge commits and must not be squash/rebase-merged.

Do not perform the repository-owner `main` update in this cascade.

### 4. Minimize obvious doc friction

Inspect `CONTRIBUTING.md`, `SECURITY.md`, and `KNOWN_AUDIT_DEFERRED.md`.

Make only small public-quality edits that:

- Point readers to the fork-surface map.
- Clarify how security reports should be filed for Rockie runtime packaging issues versus upstream OpenClaw issues.
- Avoid making broad unverified maintenance promises.

### 5. Verification

Run:

- `git diff --check`
- `git diff --name-status b5eb09cbdc7242bbcbe3af767eb10816ac445c42..origin/main`
- `git diff --stat b5eb09cbdc7242bbcbe3af767eb10816ac445c42..origin/main`
- The concrete ancestry proof checks from milestone 3, with pinned current-main commit/tree and proof-branch commit/tree.
- If the implementation edits only docs and the plan file: no runtime test is needed; record the commit as docs-only with `Verified: git diff --check; ancestry proof transcript recorded`.
- If any runtime files are edited: run the narrow relevant broker/runtime tests before commit.

## Risks and Rollback

- History repair is the highest-risk part. The implementation PR should document and prepare the repair path, not mutate public `main` history.
- The seven-file drift is large enough that tree-equivalence must be proven by Git, not prose.
- Public docs must avoid leaking private Rockie deployment details.
- A docs-only implementation without the pinned repair-branch proof artifact is not acceptable.
- If creating the proof branch exposes conflicts or non-identical trees, stop and document the exact drift instead of force-repairing history.

## Phase 3.5 Audit Readiness

Auditor should check:

- The plan distinguishes documentation/PR preparation from actual public history rewrite.
- The plan has reproducible commands for ancestry and drift evidence.
- The implementation scope is small enough for one cascade.
- The public-facing docs are clear without overexposing private internals.
- Future upstream-sync merge discipline is explicitly documented.

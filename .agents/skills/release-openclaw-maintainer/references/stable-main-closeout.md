# Stable main closeout

This gate starts only after stable publication. It is a narrow shipped-state
closeout, not permission to heal broader `main`. Stable publication is not
complete until `main` carries the actual shipped release state.

1. Start from fresh latest `main`. Use a same-repository PR targeting `main`,
   with branch `release/<version>-main-closeout` and exact title
   `chore(release): close out <version> on main`. `<version>` is the published
   stable `YYYY.M.PATCH` (or `YYYY.M.PATCH-N` correction), without the `v` prefix.
   Audit `release/YYYY.M.PATCH` against it and
   forward-port real fixes that are absent from `main`. Do not blindly merge
   release-only compatibility, test, or validation adapters into newer `main`.
2. Normally set `main` to the shipped stable version, not a speculative next
   train. For late closeout, do not downgrade an already-started later stable
   train; retain the validator's exact shipped-note and version checks. Run
   `pnpm release:prep` after any root version change, then
   `pnpm deps:npm-lock:check`.
3. Resolve the shipped section through `scripts/lib/release-changelog.mjs`
   so historical tags and current split artifacts use the same reader. Make
   `CHANGELOG/YYYY.M.PATCH.md` and its matching contribution record on `main`
   match the tagged release, and refresh the root index. If `main` already has
   an approved docs mirror, preserve that prose and verify its frozen record
   matches the shipped accounting; do not replace it with initial notes.
   Include the stable `appcast.xml` update when the mac
   release published one. `scripts/pr prepare-run` permits this closeout without
   an override when `v<version>` exists on origin and the changelog diff only adds
   or replaces that version's artifacts (or finalizes the existing unreleased
   entry); leave other release entries and records unchanged and keep the
   generated index consistent.
   `OPENCLAW_ALLOW_ROOT_CHANGELOG_PR=1` remains an explicit override
   for release automation outside this convention.
4. Do not add `YYYY.M.PATCH+1`, a beta version, or an empty future changelog
   section to `main` until the operator explicitly starts that release train.
5. Run `pnpm release:generated:check`, `pnpm deps:npm-lock:check`, and
   `OPENCLAW_TESTBOX=1 pnpm check:changed`. Push, then verify `origin/main`
   contains the exact shipped notes and the validator-accepted shipped-or-later
   stable version before calling the stable release done.
6. Keep repository variables `RELEASE_ROLLBACK_DRILL_ID` and
   `RELEASE_ROLLBACK_DRILL_DATE` current after each private rollback drill.
   `openclaw-stable-main-closeout.yml` starts from the `main` push carrying the
   accepted stable version and shipped changelog after stable publication, then binds immutable
   evidence to the published tag. App assets may still be pending; record
   `appPlatforms` states for macOS, Windows, and Android, with aggregate
   `apps: attached` only when every canonical platform asset contract is
   complete, including a lowercase `sha256:<64hex>` digest for every required
   asset. Otherwise record `apps: pending`. Require `appcast: verified`
   only once the complete macOS zip/DMG/dSYM set is attached; record
   `appcast: pending` otherwise. Later canonical app attachments do not
   invalidate the immutable closeout snapshot. Replay requires every recorded
   asset name and digest to match exactly and preserves the recorded app,
   recovery, and asset fields byte-for-byte while recomputing authoritative
   release fields. Do not declare stable complete until it writes the immutable
   closeout manifest to the GitHub release. The drill must be within 90 days;
   manual dispatch is only for repair/replay, and private rollback commands
   remain in the maintainer-only runbook.
7. A macOS build pulled from Sparkle on purpose (for example a crashing
   in-app update) is a third appcast state, not a contract failure. Withdraw
   it with a `main` commit whose subject is exactly
   `chore(release): withdraw the <version> macOS build from the Sparkle feed`
   and a `Refs #NNN` body line naming the incident; the closeout looks that
   marker up on `main` (`appcast.xml` history) only when the complete macOS
   asset set is attached and the newest `appcast.xml` entry is an older
   version than the release. It then records `appcast: withdrawn`,
   `appPlatforms.macos: withdrawn`, `apps: pending`, and
   `appcastWithdrawal: { commit, reason }` instead of the feed link checks;
   replay preserves those fields byte-for-byte. Any other feed mismatch still
   fails. The later hotfix release (for example `2026.9.7`) verifies its own
   appcast at its own closeout; the withdrawn record is never rewritten.

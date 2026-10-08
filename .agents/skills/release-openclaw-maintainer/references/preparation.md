# Release preparation

Read `docs/reference/RELEASING.md` for current public policy. For regular
releases, select the cut SHA once: use the operator's exact SHA or fetch
`origin/main` once and record its full SHA and CI state. Create a clean worktree
and `release/YYYY.M.PATCH` from it. Never absorb unrelated dirty files.

The release branch is the active queue. Moving main is a workflow/provenance
source, not an invitation to add fixes. Touch main before publication only for
an operator-requested change or a critical blocker owned there that cannot be
fixed or proven on the release branch. Keep that repair bounded, use
`$openclaw-pr-maintainer`, then return to the release. Defer ordinary
forward-ports until after publication.

## Version and channel

`YYYY.M.PATCH` uses a sequential monthly train number, not the calendar day.
Choose beta trains from stable/beta tags only; historical alpha-only tags do
not consume a train. Continue an existing beta train with its next `beta.N` when appropriate,
otherwise increment the highest stable/beta patch and start at `beta.1`.
Prefer `-beta.N`, never new numeric-only beta suffixes.

| Track           | Branch/version                                                 | Registry selector                                                |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Regular beta    | `release/YYYY.M.PATCH`, `YYYY.M.PATCH-beta.N`                  | `beta`                                                           |
| Regular stable  | `release/YYYY.M.PATCH`, `YYYY.M.PATCH`                         | `beta` by default; intentional publication/promotion to `latest` |
| Extended stable | `extended-stable/YYYY.M.33`, trailing completed month's `.33+` | `extended-stable`                                                |
| Development     | moving main                                                    | not a release                                                    |

Use the release preparation controller before manual version edits:

```bash
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --shadow
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --write
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --check
```

Shadow is nonmutating. Write aligns the owned root/macOS versions and the
version-generated metadata DAG; add `--android` only when Android is selected.
The controller's manifest is bound to the exact HEAD/worktree.
Check version-bearing package, app plist/Gradle, updating-doc, and Peekaboo
project fields against their platform contract. `appcast.xml` is generated at
macOS publication, not a blanket version-bump target. For fallback correction
tags `vYYYY.M.PATCH-N`, those source version fields remain `YYYY.M.PATCH`;
macOS needs a strictly higher numeric `APP_BUILD`.

Android is independently pinned in `apps/android/version.json`. If the stable
release should include its APK, prepare it before tagging with `--android` or
`pnpm android:version:pin -- --version YYYY.M.PATCH`.
An older pin causes candidate/publish to skip Android; an immutable tag cannot
be repaired later to add that platform.

## Selected changes and compatibility

When backport discovery is requested or part of planning, read
[backport discovery](backport-discovery.md), freeze the baseline and main SHA,
and obtain approval for the categorized ledger before mutating the branch.
Backports stay optional and operator-selected. An unspecified target means the
newest open release branch. Extended-stable preparation additionally uses
[its backport procedure](extended-stable-backports.md).

Before branching and before final publish, inspect
`src/plugins/compat/registry.ts` and
`src/commands/doctor/shared/deprecation-compat.ts`. A deprecated record due by
the release date must be safely removed and verified, or marked
`removal-pending` with an explicit maintainer-approved blocker. Revalidate due
pending records and their upgrade conditions. Preserve doctor repairs still
needed by supported upgrades; track them until maintainers approve removal.
Recheck replacement wording against current plugin ownership/config behavior.
For records whose `warningStarts` or `removeAfter` falls within seven days of
release, include Upcoming deprecations with code, date, replacement and
`docsPath` (or `/plugins/compatibility`).

Freeze the product-complete tree, including approved versions, fixes and
complete release notes, as **Code SHA**. If the notes are final, this is also
**Release SHA**. After this point admit only confirmed
product, package/provenance, security, or publication-blocking defects; defer
adjacent improvements. Validate that exact source and its publication bytes.

## Changelog and release notes

Use `$openclaw-changelog-update` for source-history inventory, human credit,
editorial grouping, renderer limits, and verification. Generate the complete
history manifest and notes during preparation; editorial work may overlap
Code validation. Refresh them for actual source changes, not tooling retries.
Beta notes use the stable-base
`## YYYY.M.PATCH` section in `CHANGELOG/YYYY.M.PATCH.md`, with Highlights,
Changes and Fixes. `CHANGELOG.md` is the generated index; the matching
`CHANGELOG/records/YYYY.M.PATCH.md` retains the complete contribution record.
Use the shared resolver and writer documented in the changelog skill. Canonical PR
provenance follows current `origin/main`; retain a release-branch PR only while
its change has not been forward-ported. Do not change root README as routine
release prep or prefill a future changelog section.

Before freezing Code SHA, verify and stamp the state and agent schema-history
tables alongside the changelog:

```bash
node scripts/release-schema-history.mjs YYYY.M.PATCH-beta.N
```

Use the exact approved version (stable cuts omit `-beta.N`). This stamps only
`Unreleased` schema rows in `docs/reference/database-schemas/{state,agent}-schema-history.md`;
existing release attributions and migration notes are preserved. Commit both
histories with the version and release notes before qualification, not as a
later changelog-only delta.

Before stamping, manually audit every `Unreleased` row against complete Git
history and release tags. A shallow checkout or missing tags cannot establish
that a row is unpublished. Find the bump with `git log -p -S
'OPENCLAW_STATE_SCHEMA_VERSION = N;' -- src/state` (use
`OPENCLAW_AGENT_SCHEMA_VERSION` for agents), following earlier constant owners
when needed. For the introducing commit, use `git tag --contains <sha> --sort=v:refname`
and select the first tag matching `^v[0-9]{4}\.[0-9]+\.[0-9]+$`.
If one exists, record that exact stable tag instead of the new cut; otherwise
record the earliest containing beta, or leave `Unreleased` for the stamping
step when neither exists. Inspect the tagged constant too: a release can
contain several development-only bumps and publish the highest version.
At stable promotion, audit beta-only cells the same way and replace them with
their first containing stable tag (or this approved stable cut if it is first).
Keep any earlier-beta provenance in the migration notes where useful.
This is a release checklist check, not a CI ancestry check: ordinary shallow
CI checkouts do not carry the complete release history needed to prove it.

When final notes were already included in the qualified Code SHA, retain that
same commit as Release SHA. If notes change afterward, commit only the release
changelog and optionally reuse Code evidence: the complete Code-to-Release
diff must include the selected release entry and only that entry, its matching
record, and root index, without renames or deletions. This records
`split-changelog-release-v1`, with fresh qualification of the changed package
bytes. Any other delta reenters product validation. Use the canonical
release-note renderer and verifier before
publication and closeout. The publish workflow owns GitHub page finalization
only after postpublish evidence succeeds.

## Correction release artifacts

Validate the frozen SHA with `--target-ref release/YYYY.M.PATCH-N` before tagging,
or the exact `vYYYY.M.PATCH-N` context afterward (`target_context_ref` in the
workflow). Artifacts must be prepared for that correction tag. Base-package
and Android APK reuse is allowed only when the correction and base tags resolve
to the same source commit; retain the APK's verification and add a record tying
it to the correction tag. Different-source corrections need their own package
validation and a higher Android `versionCode`. A base-tag validation run alone
does not authorize correction-tag publication.

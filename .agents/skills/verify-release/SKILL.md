---
name: verify-release
description: "Verify regular or extended-stable OpenClaw releases against the exact publication surfaces, workflow identities, package provenance, and published CLI smoke tests expected for that release track."
---

# Verify Release

Use this when asked whether an OpenClaw release is fully released, published,
promoted, smoke-tested, or live-verified. This is a verification skill, not a
publish skill; use `$release-openclaw-maintainer` before changing release state.

## Rules

- Resolve short suffixes like `.27` to the concrete CalVer version from the
  current date/context, then say the resolved version.
- Resolve the track first. Both tracks use the shared GitHub Release evidence
  ledger. Regular beta/stable also uses the platform graph; extended-stable
  uses its canonical branch, npm selector, and Gateway surfaces. Do not require
  one track's native or ClawHub artifacts from the other.
- Verify live state. Do not trust local checkout state, release notes, or old
  memory as current truth.
- If the checkout is dirty or divergent, use it only for scripts/reference.
  For version metadata, fetch from GitHub release/tag or unpack the tag tarball
  under `/tmp`.
- Verify selected npm plugins published successfully before core npm.
- Report ClawHub separately from core release readiness. Its pending or failed
  publication/verification never blocks core, GitHub finalization, main
  closeout, or the retrospective PR. Keep its exact run/attempt, owner, and next
  action visible; do not call ClawHub complete without public-byte proof.
- Never print secrets.
- Keep the final terse: `yes/no`, evidence bullets, caveats, cleanup.

## Regular beta/stable checks

For the regular orchestrated track, read [regular release checks](references/regular-release.md)
in full and complete every applicable check. Then run the shared published
package smoke and report the caveats below.

## Extended-stable checks

For extended-stable, read [extended-stable checks](references/extended-stable.md)
in full and complete every applicable check. Then run the shared published
package smoke and report the caveats below. Do not load the regular track
checklist for this track.

## Published package smoke

After the track-specific core publication checks pass, use a disposable
installation/cache with isolated OpenClaw state. Do not wait for independent
ClawHub verification to run this smoke:

- `npm exec --yes --package openclaw@<VERSION> -- openclaw --version`.
- Run at least one harmless command that touches the published CLI surface,
  for example `plugins --help` or `gateway --help`.

Do not start an extra local Gateway or run an ad hoc live model turn as a
preliminary release check. Use the canonical release-validation workflows and
publication evidence above; this does not remove any of their required lanes.
Run additional manual live checks only when explicitly requested.

## Caveats To Report

- Dist-tag caveat: stable `latest` is release truth; if optional `beta` mirrors
  still point at a beta version, report it as a caveat, not a stable-release
  blocker, unless the user asked to verify beta promotion.
- ClawHub caveat: distinguish “core release verified; ClawHub pending/failed”
  from “all selected publication surfaces verified.” The former still permits
  main closeout and the retrospective PR.
- Track caveat: name the track and intentionally absent surfaces. Do not call
  missing regular-release artifacts an extended-stable failure.
- Divergent checkout caveat: say when local source SHA differs from release tag
  or origin and which live sources were used instead.

---
summary: "Draft writing-profile contract, composer behavior, and qualification limits"
read_when:
  - Reviewing the proposed dictation writing-profile contract
  - Testing writing-profile settings and composer recovery
title: "Dictation writing profiles (draft)"
---

This implementation is a design-review draft for
[issue #205638](https://github.com/openclaw/openclaw/issues/205638).
The complete application-specific feature is **not qualified or complete**.
The proposal needs maintainer acceptance of profile ownership, the bounded
preference value, destination-context authority, and supported clients.

## What this draft supports

The Control UI's main chat composer can load manual/global writing profiles,
freeze the selected profile before opening the microphone, and expose its
selection reason and effective restrictions. The existing transcription session,
FIFO publication queue, and composer draft operation continue to own recording
and insertion. A profile never changes the request to agent mode.

The profile module loads when dictation is first used. The catalog is read through
the existing authenticated user-preference owner before capture. Profile controls
appear for a configured catalog or a recoverable transcript after that load.
The global default can be configured in Talk settings before the first recording.

All optional processing capabilities are currently unavailable on this route.
The transcript is preserved; selecting an email or chat register does not
paraphrase it. Punctuation, capitalization, filler removal, self-correction,
structure, and locale preferences may be saved, but their absence is shown in
inspection. Register is advisory. There is no additional model request.

| Client or integration                                 | Status in this draft                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| Main Control UI chat composer, manual/global profiles | Implemented; focused synthetic transport/DOM proof     |
| Control UI external application identity              | Unsupported; no collector                              |
| Control UI external browser origin                    | Unsupported; no collector                              |
| macOS Quick Chat writing-profile integration          | Not implemented or qualified                           |
| Windows/Linux native application matching             | Not implemented or qualified                           |
| Mobile, remote, headless profile integration          | Not qualified                                          |
| Semantic register rewriting                           | Disabled; no accepted processor or semantic evaluation |

Stable application identifiers and exact-origin selectors can be edited and
exported as settings. This is not evidence that a client can obtain those inputs.
The browser supplies no application identity or external origin to the resolver.
It never derives a destination from its own URL, another tab, a display name,
window title, clipboard, screenshot, history, or document content.

## Settings and session controls

Open **Settings → Talk → Writing profiles**. New profiles and imported profiles
start disabled. Enable the desired profile and the catalog explicitly, then
select a global default. An authenticated durable user identity is required to
save. A profileless or offline editor cannot write preferences.

The composer exposes a native selection control, selection reason, capability
status, captured-profile inspection, a session disable action, and original-text
review. Changing a profile selection affects subsequent recordings. Editing or
deleting a profile cannot reinterpret a recording already admitted by the owner.
Switching the draft, account, or connection retires its pending authority.

Original-text review is persistent while the receipt remains in the current
owner. It has no review timeout. **Reprocess unsent draft** creates a new preview
generation using the selected profile only while the draft and target are still
current. Because no processor is available, the preview preserves the original
text and does not insert or send it again. Unknown effects are never retried.

The original and comparison draft are each bounded to 65,536 JavaScript string
code units, retained only for the most recent receipt, and never persisted.
Oversized text is not truncated into a misleading recovery candidate. Cancellation,
account/connection retirement, or capture revocation releases recoverable content.
The actual committed/unknown effect outcome remains distinct from cancellation.

## Deterministic selection

The pure resolver uses this order:

1. An enabled explicit session override.
2. An enabled application plus exact-origin selector, using authorized context.
3. An enabled application selector, using authorized context.
4. The enabled global default.

Application identity is a typed stable platform identifier: a macOS bundle ID,
Windows AUMID, or Linux desktop ID. Labels never participate in matching.
Supported, consented, and trusted context flags must all be present. Missing or
untrusted identity uses the global fallback, with a visible reason.

Origins contain only HTTP(S) scheme, host, and port. URL normalization handles
case, IDN hosts, and default ports; non-default ports and different schemes remain
distinct. Paths, queries, fragments, credentials, and wildcard hosts are rejected,
including percent-encoded or Unicode forms that normalize to a wildcard.

Priority applies only within one specificity level. Equal-priority duplicate
selectors are rejected during settings validation. A conflicting internal input
also produces an explicit conflict result; array order never chooses the winner.

One frozen snapshot records profile/catalog revisions, context/consent/policy
revisions, capability state, selection reason, and effective policy. A profile
cannot widen capture, provider, refinement, sensitive-field, or mode authority.
The typed context inputs are a private proposal, not an accepted public P02 API.

## Storage, import, and rollback

The proposal uses the existing SQLite-backed `users.prefs` owner and the single
key `dictation.writingProfiles`. The proposed v1 catalog is bounded to 100 profiles,
20 selectors per profile, and 1 MiB of serialized UTF-8 JSON. Labels are limited
to 80 characters. Ordinary preferences retain the existing 4 KiB value bound.
No table, database schema version, or RPC method is added.

Every update or deletion requires the exact saved value in `expectedEntries`.
The existing transaction compares that value and applies the whole batch
atomically. An editor never substitutes a normalized value for its saved
comparator or automatically retries a stale mutation. Conflicts preserve unsaved
input. An unresolved reconnect preserves the local draft for review/export while
retiring write authority; a fresh saved receipt is required before another save.

Imports validate the complete document before one write, generate fresh opaque
revisions, and disable both the catalog and all profiles. Importing never opts
the user into processing. Validated v1 exports contain settings and selectors only;
application identifiers and origins can reveal workflow information. They contain
no audio, transcripts, provider credentials, browsing inventory, dictionary, or
page content. Exporting a quarantined future schema preserves its unrecognized
content without interpreting it; review that document before sharing it.

An absent key yields a disabled in-memory default without writing a new preference.
No historical profile schema existed at the inspected base; this draft does not
invent a version-zero migration. Unknown future versions are inactive, read-only,
and exportable. A future imported document is quarantined without replacing the
current saved catalog. Invalid batches leave the accepted record unchanged.

For rollback, disable the catalog before using an older client, and export the
settings if needed. This proposal does not migrate the database schema or delete
unrecognized records. Older Gateways retain their smaller generic write limit,
so they may reject edits to a catalog larger than 4 KiB. A real stable-version
upgrade/downgrade qualification remains required; it has not been substituted
with a fabricated legacy fixture.

## Diagnostics and performance

Profile diagnostics contain bounded status/reason enums, unavailable capability
names, capture eligibility, local generation count, and effect outcome. They omit
transcript text, imported labels, arbitrary IDs/revisions, origins, and selectors.
No profile data is added to the transcription request: the existing route remains
`mode: "transcription"`, `transport: "gateway-relay"`, `brain: "none"`.
The unchanged provider configuration may supply language or prompt hints. This
draft does not assert that all recognizer output is independent of context.

The proposed resolver target is p95 below 5 ms at 100 profiles × 20 selectors.
Run the committed network-free workload from the repository root:

```bash
node --expose-gc --import ./scripts/tsx.mjs scripts/bench-dictation-writing-profiles.mts /tmp/dictation-writing-profiles.benchmark.json
```

The workload reports 10,000 samples per warm scenario, cold module/first-call
timing, 200 fresh validation/import samples, interleaved immutable revisions,
memory, machine/runtime details, and source hashes. Import time is reported
separately from warm resolution. It does not measure native context access,
speech recognition, provider rewriting, true concurrent database writers, or
page-cache-cold startup. See the accompanying contribution evidence for observed
results and the exact tested revision.

## Required qualification before completing M05

The accepted M11 refinement and P02 context contracts were not found in the bounded
source/tracker audit. An actual native application identity and exact browser-origin
adapter must be implemented and qualified under the agreed consent contract.
Revocation after context-influenced STT dispatch must invalidate derived candidates;
the current route has no P02 context lineage and cannot establish that missing
integration's behavior.

Physical OS/provider permission tests, native focus/target changes, actual assistive
technology, large-text browser inspection, real prior-version migration/rollback,
and required exact-head CI remain distinct proof obligations. Resolver unit tests,
synthetic Gateway fixtures, and transcript-preservation cases do not satisfy them.

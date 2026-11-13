---
summary: "Prepare and activate pinned external Control UI translation memory without network-dependent builds."
title: "Control UI canonical memory"
read_when:
  - Preparing the external Control UI memory repository
  - Bootstrapping or recovering a pinned locale snapshot
---

# Control UI canonical memory

The external-memory path is explicitly activated by committing

a file named `ui/src/i18n/.i18n/memory-revision.json` and its generated build catalogs.
Until that bootstrap commit lands, the existing tracked-memory refresh remains active.
Installing the tooling alone does not migrate production or stop legacy publication.
No destination, repository, credential, or snapshot is provisioned by the tooling.

After activation, the separate Git repository is the sole canonical translation-memory
owner. Its `main` branch retains every published snapshot by fast-forward commits.
The source pin records its approved `owner/repository`, exact commit and per-locale
SHA-256 digests of the raw memory and derived build catalog. The source repository
tracks only the pin, `*.catalog.jsonl` build projections and existing locale metadata.
Core `*.tm.jsonl` files are restored transiently for translation generation, ignored
by Git and excluded from the activated refresh publisher. Plugin-local memories are
unchanged by this core-memory transition.

## Offline build contract

UI/Vite and public-session runtime/worker builds consume the same checked-in build
projections. They never fetch canonical storage. A source archive or shallow checkout
with its normal build dependencies can build the pinned translations offline, even
when the canonical repository is unavailable. Projections retain source hashes,
translation bytes, primary keys and grouped aliases, but omit generation/reuse
metadata. They are generated inputs, not another translation-authoring surface.

A missing or changed pinned projection fails rather than silently building English.
A newly registered source-only locale still uses the existing English fallback until
its first refresh. Existing stale-key fallback behavior is unchanged.

## Preparation and bootstrap

An administrator must select and provision a separate canonical repository and
install the chosen GitHub App there. Set these on the source repository:

- Variable `CONTROL_UI_MEMORY_REPOSITORY`: approved canonical `owner/repository`.
- Variable `CONTROL_UI_MEMORY_APP_CLIENT_ID`: that App's client ID.
- Secret `CONTROL_UI_MEMORY_APP_PRIVATE_KEY`: that App's private key.

Workers request contents-read tokens; the finalizer requests contents-write. The
source pin must match the configured repository before either token is minted.
Protect canonical `main` against deletion and force pushes, retain backups, and allow
the App's ordinary fast-forward publication. Retain every snapshot referenced by a
source commit; cache expiration or retranslation is not a recovery strategy.

Perform bootstrap in a dedicated source change, without mixing it with code changes.
Coordinate it with the locale refresh owner so the verified raw source does not move
between export and the bootstrap commit. The bootstrap command rejects mismatched
canonical bytes before removing local raw files.

```sh
# STORE is an already prepared local checkout of the approved canonical repository.
# These commands do not create a remote or choose credentials.
node --import ./scripts/tsx.mjs scripts/control-ui-i18n-memory.ts export "$STORE"
# Review, commit and publish this snapshot through the canonical repository's approved route.
# Verify that CANONICAL_COMMIT is retained on its remote main before proceeding.
node --import ./scripts/tsx.mjs scripts/control-ui-i18n-memory.ts bootstrap \
  "$STORE" "$CANONICAL_REPOSITORY" "$CANONICAL_COMMIT"
# Review the raw-file deletions, .i18n/.gitignore, catalogs and revision pin together.
# Validate offline UI/public-reader builds, then submit that bootstrap change normally.
```

Export copies the raw files byte-for-byte. Bootstrap compares every raw file against
the specified local canonical commit, generates catalogs and their digests, writes
the pin and ignores restored raw files. It does not prove remote publication: the
administrator's remote verification above is required before submitting the pin.
Nothing rewrites existing main history or deletes an old canonical snapshot.

## Refresh and failure behavior

Each worker restores the exact source pin, not whatever translations happen to be
latest in canonical storage. The finalizer restores its refreshed source pin before
admitting same-run worker memory. A changed pin invalidates old worker memory, just
like a canonical correction. Generation refreshes the derived build views locally.

The finalizer then commits and fast-forward-pushes raw memory to the configured
canonical repository. Only a successful push permits advancing the source pin and
opening the generated source PR. Rejected or uncertain pushes stop before that pin
change; no force push or destructive retry is used. A failed source PR can leave an
unused canonical snapshot, which remains retained. The last accepted source revision
still builds offline. Re-run the existing workflow to reconcile; do not purge history.

## Recovery and verification

```sh
# Restore exact raw bytes for generation, verification or export; no network in this command.
node --import ./scripts/tsx.mjs scripts/control-ui-i18n-memory.ts restore \
  "$STORE" "$CANONICAL_REPOSITORY"
pnpm ui:i18n:check
```

The local store must contain the pinned commit and blobs. Restore verifies all raw
digests before writing any file. Preserve the separate Git history/backups to recover
generation metadata. The checked-in build projections keep existing offline builds
working, but deliberately cannot reconstruct all discarded generation metadata.

Roll back by reverting the source pin/catalog change together, not by resetting the
canonical branch. Do not expire a canonical commit because it is no longer the latest
pin. Before activation, the original tracked source history also remains a recovery
source for the initial snapshot.

After activation, future source commits contain no new core raw-memory blobs; build
catalogs and revision pins still accumulate. An orphan branch in the same repository
would still be fetched by ordinary all-branch clones, so it is not this design.
Neither the transition nor local recompression removes existing reachable history or
claims to repair GitHub's historical pack representation.

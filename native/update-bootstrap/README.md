# Independent upgrade bootstrap

`openclaw-updater` is a native verifier/launcher. It does not load the installed
OpenClaw CLI, parse its config, activate plugins, acquire its execution authority,
or run a separate migration engine. It uses the maintained
[`tough` TUF verifier](https://docs.rs/tough/0.24.0/tough/struct.RepositoryLoader.html)
with expiry enforcement and a persistent rollback-protection datastore.

The release/installation owner must provision this native binary and a trusted
`<control-root>/metadata/root.json` out of band. There is deliberately no download
of an initial trust root, no bundled fixture key treated as production trust, and
no `--ignore-signatures` / `--ignore-expiry` path. Production signing custodians,
root rotation/recovery, distribution URLs and platform artifacts remain release
authorization inputs, not guessed implementation defaults.

## Distribution contract

All bootstrap paths are canonical, installation-owner controlled, and outside
both the replaced installation and every supplied agent workspace. Directories
are owner-only; files are regular, owner-only, single-link files without symlinks.

The catalog target is the same strict envelope used by the TypeScript owner:

```json
{
  "schemaVersion": 1,
  "catalog": {
    "schemaVersion": 1,
    "id": "...",
    "artifacts": [],
    "releases": [],
    "recipes": [],
    "adapters": [],
    "qualifications": []
  },
  "revokedRecipes": [],
  "revokedArtifactIds": []
}
```

Catalog artifact `id` maps to a **top-level TUF target** named `artifacts/<id>`.
The catalog length/SHA256 and signed TUF target length/SHA256 must agree. The
manifest artifact contains `runner-bundle.ts`'s version-1 manifest, with exact
platform, private Node runtime, sealed runner entrypoint, empty `externalModules`,
and every runtime/runner/native/data file mapped to its own artifact identity.
The sealed build owner emits `openclaw-updater.mjs` and existing recovery sidecars
`package-update-activation-recovery.mjs` / `managed-handoff-runtime.mjs`; include
those sidecars as pinned data artifacts when the selected execution engine needs
them. Bun SQLite and FreeBSD Koffi are not silently acquired: this initial native
launcher selects a qualified Node runtime, and every required addon/library must
be an explicit authenticated native-dependency artifact.
No package manager, lifecycle hook, script, floating dependency or source code is
executed while discovering/verifying the installation. Bundle retention uses
`<control-root>/runners/<manifest-sha256>/`; undeclared files, changed bytes,
symlinks, mismatched permissions and revoked dependencies block launch.

HTTPS distribution is supported. A canonical owner-private `file:` repository
outside installation/workspace roots is supported for offline provisioned bundles
and signed qualification fixtures. Cached runner files avoid re-downloading the
runtime, but **current authenticated metadata is still required for a new run**.
Original admitted-run recovery uses the separate retained-custody route below;
bootstrap never disables expiration for a fresh admission.

Rust/Node still rely on the qualified operating system's loader and system ABI.
The manifest closes application/addon dependencies; it does not claim an arbitrary
OS or compromised host is safe. Exact OS/runtime/native ABI classes need release
qualification, separately for x64 and arm64.

## Build and invocation

```sh
cargo build --release --locked --manifest-path native/update-bootstrap/Cargo.toml

/path/to/openclaw-updater \
  --control-root /owner-controlled/update-control \
  --installation /canonical/openclaw-installation \
  --workspace /canonical/agent-workspace \
  --metadata-url https://updates.example/metadata/ \
  --targets-url https://updates.example/targets/ \
  --catalog-target catalog.json \
  --manifest-artifact exact-runner-manifest-id \
  --verify-only
```

Replace `--verify-only` with `-- plan ...`, `-- apply ...`, `-- resume ...`, or
`-- status ...` to invoke the existing sealed command owner using the exact private
runtime. Supply that command owner's trust/planning arguments explicitly. The
bootstrap binds the selected `--installation`, strips inherited Node options,
plugin paths and update authority, and starts from the protected control directory.
It grants no execution lease. The command owner must independently authenticate
its selected catalog and obtain/revalidate existing execution ownership.

No installed Node/Bun executable is needed. The native binary starts independently,
verifies or downloads the exact authenticated private runtime, then launches it.
A missing root, runtime artifact or unsupported platform fails closed.

## Existing recovery ownership

The bootstrap detects legacy package-publication markers and original managed
handoff rows. Unresolved or unreadable records block launch; it never deletes,
repairs, resumes or adopts them. An `anchor-retired` package publication completion
receipt is inspection-only and accepted only when its original journal/parent
identities and installation match and its helper/anchor are absent. Hot/WAL
journals require original-owner inspection. The existing executor performs its own
more comprehensive state/recovery guard before any mutation.

A `bootstrap-active` file serializes this bootstrap's cache writers, not updater
leases. A crashed bootstrap leaves its marker for explicit owner inspection;
there is no automatic stale-lock takeover.

## Qualification

Cheap path/owner checks:

```sh
cargo test --locked --manifest-path native/update-bootstrap/Cargo.toml
```

Native first-hop tests are explicitly release-qualification tier because they
copy and authenticate actual Node executables and boot separate native processes:

```sh
cargo test --locked --features qualification \
  --manifest-path native/update-bootstrap/Cargo.toml
```

`OPENCLAW_TEST_NODE` optionally selects an explicit test runtime. Fixtures create
role-separated signed TUF metadata and isolated installations. Tests strip the
application runtime from `PATH`, inject a forbidden installed-loader import through
`NODE_OPTIONS`, verify private-runtime launch, and cover corrupted/expired/revoked
metadata/artifacts, missing provisioned roots, cached runtime retention, extra
code, original recovery preservation and cross-process metadata rollback.

Passing these fixture tests does not advertise a real historical release route.
Actual authenticated historical source/target transitions, maintenance/service
readiness, migration crashes and release signing must be qualified by their owners.

## Retained original-run launch

Add `--retained-run <original-uuid> --retained-ledger <canonical-operational-sqlite>`
only when launching `-- resume` or `-- status`. The ledger selector names the
original `update_runs` / `config_machine_state` store, **not** the separately
pinned native lease database. Both stores and their parent identities are checked.
The launcher binds `--run`, `--state-database` and `--installation` for the runner;
conflicting selectors and fresh `plan`/`apply` commands are refused.

This passive route requires the exact original row and immutable
`update.recipe-run.<uuid>` pointer, envelope and approved artifact hashes,
original native owner correlation, and the complete retained private runner
closure. It downloads no replacement runtime and creates no update run or lease.
The runner must still independently reacquire the original native authority.
Foreign or legacy package journals/handoffs are refused, never repaired here.
Retained-only bounded SQLite inspection copies a stable private main/WAL family,
streams source bytes through pinned no-follow descriptors and SHA-256 rechecks,
validates the WAL header and every frame checksum using page-bounded buffers, and
queries only that private copy. Capacity is measured on its actual volume against
the source family lengths and WAL expansion; no trust-artifact size cap applies. Source SQLite is never opened, checkpointed, or given a new SHM file. Torn,
corrupt, changing, or rollback-journal families fail closed. Fresh-launch recovery
owner detection still refuses WAL sidecars. This launcher does not recover the
operational database as a side effect of discovering custody.

An unchanged authenticated metadata generation recorded by that original durable
admission may be expired: the exception permits only this retained run's launch,
not fresh planning or activation. Changed known metadata requires ordinary current
TUF signature/rollback/expiry verification before applying its revocations; failure
preserves the original owner and blocks launch. Original and current known
revocations are both enforced. No signing keys or advertised classes are supplied
by this route.

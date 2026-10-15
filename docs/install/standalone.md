---
summary: "Build a standalone OpenClaw executable with Bun and a companion runtime directory"
read_when:
  - You want to build or package OpenClaw as a standalone executable
  - You need the standalone output or macOS signing contract
  - You are comparing JIT, bytecode, and experimental AOT builds
title: "Standalone builds"
---

The standalone builder packages OpenClaw and Bun into one executable, with a
companion `runtime/` directory for native libraries, plugins, and other resources.
This is also called a **fat binary** build. It runs without a separate Node or Bun
installation, but the executable and its sidecar must stay together.

Use this path to prepare application or deployment artifacts from a source
checkout. For a normal CLI installation, start with [Install](/install).

## Build the default JIT executable

Use the repository's pinned package manager and the production Bun pin in
`scripts/lib/openclaw-bun.json`. Install dependencies and finish the runtime build
before compiling the standalone executable:

```bash
pnpm install
pnpm build
scripts/stage-openclaw-bun.sh ./standalone-compiler darwin arm64
./standalone-compiler/bin/bun scripts/build-bun-standalone.mjs ./standalone-jit
./standalone-jit/openclaw --version
./standalone-jit/openclaw --help
```

This example targets Apple silicon. The builder supports macOS and Linux hosts;
Windows standalone builds are not supported. Build on the platform and architecture
where the result will run; choose a matching pinned Bun artifact. The staging helper
verifies the download's checksums and Bun identity. Use a fresh output directory
for each build so an earlier runtime snapshot cannot leak into the result.

The manifest reads the OpenClaw version and commit from `dist/build-info.json`.
Rerun `pnpm build` after source changes; changing the checkout alone does not update
the identity of an existing runtime build.

On macOS, database operations also require a supported SQLite library. Provision
one through the packaging owner or follow
[SQLite library selection](/install/bun-compatibility#sqlite-library-selection).
Compiling the executable does not provision that system dependency.

The build produces exactly these deliverables:

```text
standalone-jit/
├── openclaw
├── runtime/
└── manifest.json
```

Move or distribute the complete directory. `runtime/` is resolved relative to
the executable; moving only `openclaw` leaves required resources behind.

## Choose a compilation mode

| Mode     | Builder option  | Behavior                                                                            |
| -------- | --------------- | ----------------------------------------------------------------------------------- |
| JIT      | None            | Default. Embeds JavaScript and lets Bun compile it at runtime.                      |
| Bytecode | `--bytecode`    | Embeds Bun bytecode to reduce JavaScript parsing at startup. It still uses the JIT. |
| AOT      | `--compile-aot` | **Experimental.** Requires an AOT-capable Bun build and runs with the JIT disabled. |

```bash
./standalone-compiler/bin/bun scripts/build-bun-standalone.mjs ./standalone-bytecode --bytecode
```

The production-pinned Bun supports JIT and bytecode. It does not provide the
experimental AOT compiler. Selecting `--compile-aot` with a Bun that lacks that
capability stops with a diagnostic; it does not silently fall back to JIT or
bytecode. An AOT artifact needs its own runtime and signing qualification.

## Read the manifest

`manifest.json` describes the output for packaging and verification. Its version
1 contract is:

| Field           | Contents                                                                  |
| --------------- | ------------------------------------------------------------------------- |
| `schemaVersion` | Manifest schema version, `1`.                                             |
| `mode`          | `jit`, `bytecode`, or `aot`.                                              |
| `target`        | `platform` and `arch` for the compiled executable.                        |
| `bun`           | Compiler `version`, `revision`, `commit`, and `executableSha256`.         |
| `openclaw`      | OpenClaw `version` and source `commit`.                                   |
| `executable`    | Relative `path`, `sizeBytes`, and `sha256`.                               |
| `runtime`       | Relative `path`, `sizeBytes`, `sha256`, `fileCount`, and `symlinkCount`.  |
| `embedded`      | Counts for `workers`, `plugins`, `modules`, and `inlineWorkers`.          |
| `pruning`       | Applied `patterns`, `removedFiles`, and `removedBytes`.                   |
| `macos`         | macOS only: `hardenedRuntime` and the selected mode's `entitlements` map. |

Keep compiler provenance when signing or packaging the executable. Signing
changes its bytes: refresh `executable.sizeBytes` and `executable.sha256` after
signing. If packaging changes the sidecar, refresh its recorded inventory too.

The sidecar digest covers regular files and symbolic links, sorted by their
relative POSIX paths in UTF-16 lexical order. Each file contributes
`path\0file\0content-sha256\n`; each link contributes
`path\0symlink\0link-target\n`. Hash these UTF-8 records with SHA-256. Directory
entries and symlink targets are not counted again in `runtime.sizeBytes`.

### macOS signing

Sign the executable with hardened runtime and the exact entitlements declared in
`macos.entitlements`. Derive the entitlement plist from this map instead of
copying the entitlements for a separate `runtime/bin/bun` executable. The set is
mode-specific; bytecode is not a reason to disable JIT permissions.

Sign native sidecar libraries and addons according to the package's ownership
and signing policy. The runtime can load native code from installed plugins,
including plugins with a different signing identity. Validate the signed output
through the functional campaign below; a successful `--version` probe does not
exercise native plugin loading. See [macOS signing](/platforms/mac/signing).

## Update the complete artifact

The standalone executable is not a package-manager or git installation.
`openclaw update` refuses to modify it and displays a next step: update the owning
desktop application, or rebuild and replace the standalone output.
The generated `runtime/openclaw-install-owner.json` marker uses the existing
install-owner contract. Gateway/UI update requests follow the same boundary,
automatic package updates are disabled, and `openclaw update status` can still
report the host-managed installation.

Desktop packaging owns seeding the artifact, signing it, and replacing the
executable and sidecar together. For a manually managed deployment, build and
verify a fresh output directory, stop the Gateway through its current supervisor,
replace the complete artifact, then restart and verify readiness. Never copy a
new executable over an old sidecar or use npm, pnpm, or git to update the sidecar
in place. Keep user configuration and state outside the build output. Back up
state before upgrading; see [Updating](/install/updating).

## Runtime contents and limits

The builder embeds the application modules, bundled plugin entrypoints, worker
programs, and generated metadata needed by the runtime. It preserves lazy module
boundaries. The sidecar still contains JavaScript for metadata and dynamic
external plugins, plus native addons, libraries, templates, bundled and Custodian
skills, license notices, and other resources.
It is not an empty-resource or single-file distribution.

Pruning removes source maps and TypeScript declarations. It does not remove
JavaScript from the sidecar. The strict trace verifies that the exercised
application and worker paths use embedded JavaScript; external plugins or other
unexercised paths require their own proof.

Native dependencies must match the target platform and architecture. A
standalone build does not make an arbitrary plugin portable, provide a signing
identity, install a service, or migrate user state during compilation.

The executable is an OpenClaw launcher, not a general-purpose Bun CLI. The
builder embeds known worker and child programs. Plugins that use
`process.execPath` to run arbitrary scripts or Bun flags need a separate runtime
or their own standalone integration and qualification.

## Qualify an artifact before packaging

CI covers the builder's inexpensive pure contracts: worker discovery, manifest
shape, and code generation. Full standalone compilation and runtime campaigns
are manual because their resource cost is too high for routine PR checks.

For each production-pinned JIT and bytecode artifact:

1. Record compiler revision and checksum, OpenClaw commit, output sizes and
   hashes, and the mode-specific signing entitlements.
2. Use isolated HOME, configuration, state, workspace, and temporary directories.
   Reserve ports `19995` and `19996`; refuse to run if another process owns them.
   Sandbox Doctor so it cannot inspect or mutate the operator's live state or
   services.
3. Run one strict trace campaign and at least four functional campaigns per
   mode. Exercise version/help, config set/get/validate, Doctor, Gateway
   readiness, agent turns, and Gateway stop/restart. The trace must observe every
   JavaScript VM and worker, reconcile worker creation receipts, and find no
   disk JavaScript reads, resolutions, or cache entries on the exercised paths.
4. Run the signed functional campaign with only the declared entitlements.
   Remove each declared entitlement in a separate negative control and record
   the concrete failure that makes it necessary. Drop entitlements with no
   demonstrated requirement. Audit crashes by PID, launch window, executable
   path, and Mach-O UUID, including a delayed audit after the campaign.
5. Report three-run medians for elapsed seconds, retired instructions, and RSS
   for CLI operations, Gateway readiness, and agent turns. Separate peak CLI RSS
   from settled Gateway RSS and identify which processes each counter covers.
   Measure fresh-copy first launch separately with `cp -X`; exclude trace runs
   from performance medians.

Keep the commands, traces, manifests, signed-artifact identity, negative
controls, and results with the qualification report. A different compiler,
target, compilation mode, or native dependency set requires new evidence.

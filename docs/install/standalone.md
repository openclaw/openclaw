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

On macOS, the builder uses `scripts/build-mac-sqlite.sh` and the pin in
`scripts/lib/sqlite-macos.json` to include `runtime/lib/libsqlite3.dylib` for the
target architecture. It respects `OPENCLAW_MACOS_DEPLOYMENT_TARGET` (default
`15.0`). Standalone builds prefer this library before host discovery; an explicit
`OPENCLAW_SQLITE_LIBRARY` remains an override. Homebrew is not required to run
the artifact. See [SQLite library selection](/install/bun-compatibility#sqlite-library-selection).

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

AOT artifacts select the `embedded-aot` [runtime execution profile](/concepts/runtime-profiles).
Host Code Mode using the Node executor, QA expressions, and plugins fetched after
the build require dynamic execution and report an actionable error before
evaluating code. Run those features with a Node/Bun installation or a JIT/bytecode
standalone. An embedded guest runtime has its own qualification requirements;
OpenClaw does not silently switch executors.

### WebAssembly in AOT builds

AOT builds import the retained host WebAssembly assets at compile time, including
Photon, PDFium, Opus, the tree-sitter engine and Bash grammar, QuickJS and its
encoding extension, Matrix crypto, and the fs-safe archive parser. Byte-identical
assets share one compiler input. The existing lazy library loaders still read and
instantiate their own bytes; the registry adds no runtime loader or global patch.
Standard JIT and bytecode builds keep their existing packaging.

The inventory comes from the same resource plan as the sidecar, so omitted plugins
contribute no assets. `embedded.webAssembly` records each source, its byte size,
and SHA-256. Content-addressed imports also include these bytes in the shared
module graph fingerprint. The inline Opus payload is decoded during the build without evaluating
package code; an unsupported decoder shape stops the build. Compiled WASM adds
machine code to the AOT executable. Plugins installed after shipment are outside
this compile-time inventory.

For focused measurements with an AOT-capable compiler, run:

```bash
node scripts/bench-standalone-wasm.mjs "$AOT_BUN" ./wasm-probe
```

Choose a fresh output directory. The script compiles only small dependency
workloads, checks matching results in JIT and AOT, and reports interleaved CPU and
wall-time samples, including QuickJS module transfer to a real worker.

## Matched JIT support build

Use `--support-output` with AOT to produce a JIT companion from the **same staged
module graph, compiler, source commit, plugin selection, and resource snapshot**:

```bash
./aot-compiler/bin/bun scripts/build-bun-standalone.mjs ./standalone-aot --compile-aot --support-output ./standalone-support --plugins "$EMBEDDED_PLUGIN_IDS"
```

Both output directories must be fresh, separate, and outside each other. The
builder compiles both executables before publishing either output. The support
artifact has `mode: "jit"` and `build.flavor: "support"`; the AOT artifact has
`mode: "aot"` and `build.flavor: "standard"`. Compare `build.id`,
`openclaw.commit`, `build.pluginSetSha256`, and `build.moduleGraphSha256` before
reproducing an issue. Matching a version string alone is insufficient.

For breakpoints, the companion also retains the selected input runtime, its
source maps, and a copy of the matching ordinary Bun executable under `debug/`.
These are recorded separately in `debug.runtime` and `debug.executable`; compiled
virtual files are not available in Bun CLI mode. Use an isolated copy of the
reproduction state and launch the entry recorded in `build.debugEntry`:

```bash
./standalone-support/debug/bin/bun --inspect-brk ./standalone-support/debug/entry.mjs
```

The debug entry starts the selected source runtime with its build facts and
defaults to its bundled SQLite library, while preserving `OPENCLAW_SQLITE_LIBRARY`
overrides. Its bootstrap preload survives normal startup respawns. If a respawn
starts a new inspector listener, attach to the child's reported URL. Keep
`debug/` together with the companion; it is intentionally excluded from support
exports. The AOT artifact does not gain debugger permissions. The compiled JIT
companion and the source debugger use the same commit and selected plugins, but
source execution does not include the standalone compiler's adaptations. A JIT
reproduction can isolate a runtime-specific problem; it does not establish that
AOT behaves identically.

### Build each target on its matching host

The standalone builder uses the **compiler process's** OS and architecture and
rejects `--target`. Bun AOT cannot cross-compile. Run a matching compiler and
install the matching native dependencies separately for each row:

| Compiler host      | Native closure to qualify                                                   |
| ------------------ | --------------------------------------------------------------------------- |
| macOS arm64        | arm64 addons, SQLite library, hardened signing                              |
| macOS x64          | x64 addons and SQLite library; optional backends may lack x64 distributions |
| Linux x64, glibc   | x64 glibc addons and the oldest supported runtime libraries                 |
| Linux arm64, glibc | arm64 glibc addons and the oldest supported runtime libraries               |
| Linux x64, musl    | x64 musl addons; verify each optional backend is distributed for musl       |
| Linux arm64, musl  | arm64 musl addons; verify each optional backend is distributed for musl     |

These are separate build/qualification combinations, not a claim that every
backend supports every row. Windows, FreeBSD, and other architectures remain
unsupported by this builder. A compiler running as x64 under translation produces
x64 facts; it does not qualify arm64 native resources. Combining ordinary Bun
runtimes with `lipo` does not establish that combined AOT application images work.
Desktop packaging owns architecture selection and app signing.

## Select embedded plugins

By default, the builder embeds every plugin in the completed runtime build.
Use one `--plugins` option with a comma-separated list of plugin manifest IDs to
embed a selected set:

```bash
./standalone-compiler/bin/bun scripts/build-bun-standalone.mjs ./standalone-selected --plugins "$EMBEDDED_PLUGIN_IDS"
```

Set `EMBEDDED_PLUGIN_IDS` to the comma-separated IDs for the complete embedded
set, including required core plugins. The list is
independent of `--bytecode` or `--compile-aot`. Duplicate IDs are collapsed;
unknown IDs and empty list elements fail before the runtime snapshot is copied.
IDs come from `openclaw.plugin.json`, which can differ from the source directory
name. The selected plugins must already be present in `dist/extensions`; run
`pnpm build` first.

An omitted plugin must have an npm or ClawHub installation route in the existing
official external catalogs. Unpublished core plugins must remain embedded; the
error names the plugin to add. The repository's source-only dev/QA plugin class
is exempt. If a selected plugin declares `requiresPlugins`, include each required
plugin too; the builder reports a missing dependency instead of expanding the
selection silently. Desktop packaging owns its curated list and passes it through
this same option.

Omitted plugins contribute no entrypoints, plugin assets, or sidecar metadata.
Their exclusively owned chunks and dependencies are removed; dependencies needed
by retained code stay. Discovery sees only the selected set as bundled. Official
channel and provider catalogs keep offering omitted plugins for installation,
and configuration references receive the normal `openclaw plugins install`
guidance. On-demand installs use the normal plugin installer and configured state
directory; they do not modify the executable or its sidecar. Cached help for the
full build is discarded so help reflects the selected artifact. The package-manager
runtime in `runtime/npm/` is retained regardless of the plugin selection.

## Read the manifest

`manifest.json` describes the output for packaging and verification. Its version
1 contract is:

| Field           | Contents                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | Manifest schema version, `1`.                                                                                                                    |
| `build`         | Shared build `id`, `flavor` (`standard` or `support`), `pluginSetSha256`, `moduleGraphSha256`, and the support artifact's relative `debugEntry`. |
| `debug`         | Support only: debugger entry and bootstrap digests, ordinary Bun executable digest, and selected source-runtime inventory.                       |
| `nativeModules` | Target-selected native package names, versions, relative artifact paths, backend scope, and explicit `unverified` qualification.                 |
| `mode`          | `jit`, `bytecode`, or `aot`.                                                                                                                     |
| `target`        | `platform` and `arch` for the compiled executable.                                                                                               |
| `bun`           | Compiler `version`, `revision`, `commit`, and `executableSha256`.                                                                                |
| `openclaw`      | OpenClaw `version` and source `commit`.                                                                                                          |
| `executable`    | Relative `path`, `sizeBytes`, and `sha256`.                                                                                                      |
| `runtime`       | Relative `path`, `sizeBytes`, `sha256`, `fileCount`, `symlinkCount`, resource `categories`, and `sidecarPlugins`.                                |
| `embedded`      | Counts for `workers`, `plugins`, `modules`, and `inlineWorkers`.                                                                                 |
| `plugins`       | Sorted plugin ID arrays: `embedded` and `omitted`. The additive fields retain schema version `1`.                                                |
| `pruning`       | Resource `policy`, `removedFiles`, `removedBytes`, and `removedSymlinks`.                                                                        |
| `macos`         | macOS only: `hardenedRuntime` and the selected mode's `entitlements` map.                                                                        |

`nativeModules` records the selected native-resource inventory, including SQLite;
packaging does not load or execute optional addons to certify them. A listed
package is not proof that every backend works, and an omitted package is not a
claim of incompatibility. Qualify real operations on the exact signed artifact:
SQLite extensions, fs-safe rooted I/O, proc-safe identity/child operations, PTY
open/close, LanceDB vector/filter queries, ONNX with its selected execution
provider, and callback-heavy FFI integrations. Record target OS/architecture/libc,
package versions, signature identity, selected backend, and executable-memory
policy with that qualification. Repeat after changing any of those inputs.

Keep compiler provenance when signing or packaging the executable. Signing
changes its bytes: refresh `executable.sizeBytes` and `executable.sha256` after
signing. If packaging changes the sidecar, refresh its recorded inventory too.
If signing or packaging the support debugger, also refresh `debug.executable`
and `debug.runtime` after changing those bytes.

`runtime.categories` records `{ "files": number, "bytes": number }` for each
resource category. Its totals equal `runtime.fileCount` and `runtime.sizeBytes`.
`runtime.sidecarPlugins` is empty because bundled plugin code is embedded in the
executable. Browser scripts served as plugin assets are counted as resources.

`runtime.sqlite` records the selected SQLite version, compile options, and extension
loading support. For macOS it also records the bundled library's relative `path`,
`sha256`, public-domain license, and pinned source archive provenance. Linux uses
Bun's built-in SQLite after the builder verifies its version and required features.

The sidecar digest covers regular files and symbolic links, sorted by their
relative POSIX paths in UTF-16 lexical order. Each file contributes
`path\0file\0content-sha256\n`; each link contributes
`path\0symlink\0link-target\n`. Hash these UTF-8 records with SHA-256. Directory
entries and symlink targets are not counted again in `runtime.sizeBytes`.
Manifest generation rejects absolute symlinks, dangling symlinks, and links whose
resolved targets are outside `runtime/`, so links remain valid when the artifact moves.

### macOS signing

Sign the executable with hardened runtime and the exact entitlements declared in
`macos.entitlements`. Derive the entitlement plist from this map instead of
copying the entitlements for a separate `runtime/bin/bun` executable. The set is
mode-specific; bytecode is not a reason to disable JIT permissions.

Sign native sidecar libraries and addons according to the package's ownership
and signing policy. Sign `runtime/lib/libsqlite3.dylib` with the app's signing
identity and update its `runtime.sqlite.sha256` and the sidecar inventory after
signing. The runtime can load native code from installed plugins,
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

Worker and child-process targets come from the shared runtime-process manifest.
The same declarations resolve source workers, installed Node/Bun workers, and
selected plugin workers. The standalone builder requires every declared output
before compiling; a filename ending in `.worker.js` does not
declare an entry. Doctor database inspection, database discovery and backup,
update helpers, workspace leases, certificate warmup, directory watching, hashing,
and the shutdown watchdog use explicit module entries. Fixed eval workers are no longer extracted
from strings during standalone packaging.

The sealed single-file update-recovery helper uses its existing in-process hashing
fallback so its recorded recovery artifact remains self-contained. Normal
installations use the declared hashing workers.

Browser MCP and remote repository bootstrap scripts are generated from typed
sources into bundled script assets. Regenerate them with `pnpm runtime:scripts:gen`;
`pnpm runtime:scripts:check` verifies freshness before building. The runtime does
not need to serialize function bodies or retain loose JavaScript for these scripts.

The builder embeds the application modules, bundled plugin entrypoints, worker
programs, and generated metadata needed by the runtime. It preserves lazy module
boundaries. The sidecar contains the resources read from disk:

- Public documentation Markdown/MDX and its navigation metadata, plus workspace
  templates, including JSON team presets and workspace instructions.
- Bundled and Custodian skills, including their supporting files.
- Plugin manifests, package metadata, and assets such as browser scripts, styles,
  WebAssembly, SQL templates, browser extensions, and plugin-declared static files.
- Control UI static files.
- Session-card fonts, HTML export templates, and bundled hook metadata.
- Native addons, shared libraries, dependency resources, and their package and
  license metadata.
- Runtime identity and startup metadata, install-owner metadata, and license notices.

The builder removes embedded application and bundled plugin JavaScript, source
maps, declarations, development tooling, and package-manager links. Dependencies
that need disk resources use regular files in versioned `runtime/native/`
directories; the packaged sidecar has no symlinks or pnpm store. Immutable
executable metadata supplies bundled plugin source checks and Doctor contract
hashes. Installed plugins keep their normal filesystem admission and loading
rules and live in the configured state directory.

In JIT and bytecode builds, installed TypeScript plugins use the embedded Jiti
loader and Babel transformer. AOT builds admit only compiler-embedded plugin
modules; an install does not add code to the executable.
On-demand plugin installs use the declared npm runtime in `runtime/npm/` through
the standalone executable's Bun mode. This preserves npm registry authentication,
configuration, lockfile integrity checks, and the installer's disabled lifecycle
scripts without requiring a host Node, Bun, or npm installation. The manifest's
`runtime.packageManager` records the npm version, entrypoint, file count, and bytes;
the `packageManager` resource category includes its runtime dependencies and licenses.
Documentation, source maps, and TypeScript declarations are excluded from this closure.
Installed plugins resolve host SDK imports to the embedded image through the
existing native plugin resolvers; host SDK JavaScript is not restored on disk.

An installed plugin's `openclaw` peer can point to another copy of the same
standalone artifact, such as the desktop bundle before its runtime is seeded.
Peer admission compares the source commit, version, executable digest, and
sidecar digest from the two manifests. It remains read-only; the running image
supplies the SDK. Installing or explicitly repairing plugins rebinds their peer
links to the selected runtime. If the original copy is removed or a new build is
selected, run `openclaw doctor --fix` with the selected runtime before loading
those plugins. Loose Node and Bun installations still require the selected host
package path to match.

The builder captures constant conditional-export resolutions before compilation;
these modules remain lazy and do not require JavaScript in the sidecar.

Private `docs/internal/` content and the root documentation authoring instructions
(`docs/AGENTS.md` and `docs/CLAUDE.md`) are excluded from the snapshot and sidecar.

Bundled hook handlers and plugin helper programs use the executable's embedded
child entrypoints. Browser scripts and HTML export scripts remain physical assets
because they run in the browser rather than the OpenClaw process.

The resource policy is declarative and derived from the compiled dependency
graph. Runtime traces verify the exercised paths; they are not a frozen list of
files to ship. Browser JavaScript and skill scripts remain disk resources even
though application JavaScript executes from the image.

The builder validates the resource plan before compiling the executable. Hoisted
copies targeting the same resource path share one file when their content hashes
match; conflicting copies stop the build and identify both source paths.

Native dependencies must match the target platform and architecture. A
standalone build does not make an arbitrary plugin portable, provide a signing
identity, install a service, or migrate user state during compilation.

The executable is an OpenClaw launcher, not a general-purpose Bun CLI. The
builder embeds known worker and child programs. Plugins that use
`process.execPath` to run arbitrary scripts or Bun flags need a separate runtime
or their own standalone integration and qualification.

The shared `cli-invocation.mjs` module owns OpenClaw CLI launch arguments for
startup respawns, native hook relays, ACP and TUI launches, update helpers, and service launchers. A standalone invocation
passes CLI arguments directly to the executable, including root options such as
`--profile`; it does not prepend a script path or interpreter flags. A loose
Node or Bun invocation retains its runtime flags and entry script. Standalone
identity comes from the embedded runtime location or the adjacent manifest,
not the executable's filename. Parent-bound startup respawns retain cancellation
when their launcher exits: loose runtimes use a self-removing preload, while the
compiled child consumes a private parent-PID environment marker. Neither signal
is inherited by later detached update workers.

## Qualify an artifact before packaging

CI covers the builder's inexpensive pure contracts: worker discovery, manifest
shape, and code generation. Full standalone compilation and runtime campaigns
are manual because their resource cost is too high for routine PR checks.

For each production-pinned JIT and bytecode artifact:

1. Record compiler revision and checksum, OpenClaw commit, output sizes and
   hashes, and the mode-specific signing entitlements.
2. Use isolated HOME, configuration, state, workspace, and temporary directories.
   Pass the same explicit `--profile <isolated-name>` on every CLI launch,
   including version/help, Doctor, Gateway commands, and agent turns. Keep normal
   startup respawn and compile-cache behavior enabled.
   Reserve ports `19995` and `19996`; refuse to run if another process owns them.
   Sandbox Doctor so it cannot inspect or mutate the operator's live state or
   services.
3. Run one strict trace campaign and at least four functional campaigns per
   mode. Exercise version/help, config set/get/validate, Doctor, Gateway
   readiness, agent turns, and Gateway stop/restart. Exercise the running
   Gateway's restart request through its current supervisor and verify the
   replacement with health and another agent turn. For an external supervisor,
   consume the exact-PID restart handoff before starting the replacement.
   The trace must observe every JavaScript VM and worker, reconcile worker
   creation receipts, and find no disk JavaScript reads, resolutions, or cache
   entries on the exercised paths.
   Include a real Codex-backed reply and a tool-using turn. Verify the tool's
   result and observe the native hook child running `<executable> hooks relay`
   without a loose entry script. Reuse native Codex login with
   `appServer.homeScope: "user"`; keep OpenClaw state isolated and do not copy
   credentials into the artifact or test state.
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

### Sandboxed Doctor on macOS

SQLite snapshot workers use an authenticated local broker at
`<TMPDIR>/oc-br-*/resource.sock`. The shared snapshot owner uses this broker to
retain native cleanup custody independently of the staging worker. Loose and
standalone runtimes take the same path; embedded worker substitution does not
introduce this socket. A sandbox's `(deny network*)` also denies Unix-domain IPC,
even when file writes at the socket's path are allowed.

After the network denial, allow only bind and connect within the isolated root:

```scheme
(allow network-bind
  (local unix-socket (subpath (param "ISOLATED_ROOT"))))
(allow network-outbound
  (remote unix-socket (subpath (param "ISOLATED_ROOT"))))
```

Keep IP networking, the operator's home, Keychain, launchctl, and host SQLite
libraries denied. Neither operation contacts an IP network service. Bun
standalone cleanup reads process-group membership through macOS `libproc` without
executing `/bin/ps`; no process-exec allowance for `ps` is needed.

Doctor reports `SQLite (doctor process): <path> (<version>, extension loading enabled)`
in its **Database engines** diagnostic, including for isolated profiles and
host-managed installs. Packaging checks should assert that the path points to the
artifact's `runtime/lib/libsqlite3.dylib`. This diagnostic describes the library
selected by the Doctor process; it does not require host-service inspection.

Use a short, canonical temporary root: Darwin limits Unix socket paths to 103
bytes. The broker's fallback for longer paths is outside the isolated root and
should remain denied by the verifier.

The manual proof script clones the complete artifact into a fresh root and runs
version, Gateway help, and Doctor with `--profile standalone-verify` and a
60-second deadline. It keeps startup respawn enabled, so the checks also cover
profile arguments crossing a compiled CLI relaunch:

```bash
node scripts/verify-standalone-doctor.mjs ./standalone-jit
node scripts/verify-standalone-doctor.mjs ./standalone-jit --deny-local-ipc
```

The second command intentionally denies the broker socket and requires Doctor
to exit with an error, without reporting completion or hanging. Run both commands
for the signed JIT and bytecode artifacts.

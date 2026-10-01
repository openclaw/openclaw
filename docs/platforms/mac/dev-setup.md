---
summary: "Setup guide for developers working on the OpenClaw macOS app"
read_when:
  - Setting up the macOS development environment
title: "macOS dev setup"
---

# macOS developer setup

Build and run the OpenClaw macOS application from source.

The packaged app requires macOS 15.0 or later. The build host must also meet
the Xcode requirements below.

## Prerequisites

- **Xcode 26.4+** (Swift 6.3 toolchain), on the latest macOS available in
  Software Update.
- **Node.js 24.16+ or 26.1+ & pnpm** for the gateway, CLI, and packaging scripts.

macOS shell tooling uses the system `/bin/bash` (3.2); Homebrew Bash is not
required. Run scripts directly or with `/bin/bash`. Bash 5.3+ can stall on a
heredoc before its reader starts, leaving packaging or signing logs empty under
pipe-buffer pressure. Portable script entrypoints switch to `/bin/bash` on
macOS, and the streamed installers (`curl ... | bash`) do the same by capturing
the rest of their input into a private temporary file before re-executing, so
the documented install commands need no change.

## 1. Install dependencies

```bash
pnpm install
```

## 2. Build and package the app

```bash
./scripts/package-mac-app.sh
```

Outputs `dist/OpenClaw.app`. Packaging requires a real signing identity by
default and fails if none is available. Ad-hoc signing is an explicit opt-in;
it does not preserve TCC permissions. See [macOS signing](/platforms/mac/signing).

Packaging builds the JavaScript runtime and Control UI, then stages the full
canonical package with production dependencies under
`Contents/Resources/runtime/lib/node_modules/openclaw`. It retains the published
package's `files` filter, including its CLI, Gateway, Control UI, npm, and
optional `sqlite-vec`; on-demand plugins excluded from that package remain
excluded. The root tarball uses the repository-pinned pnpm packer; Corepack-only
setups are supported. `scripts/stage-mac-runtime.sh` installs the package with
build-time Node and npm, then stages Bun and SQLite. No Node executable or
npm/corepack/npx shims ship in the app.

The OpenClaw Bun fork is pinned in `scripts/lib/openclaw-bun-macos.json` and
downloaded by `scripts/stage-openclaw-bun-macos.sh`. Archives are cached under
`apps/macos/.build/openclaw-bun/<tag>/`, checked against pinned SHA-256 hashes,
and verified against the fork revision. `scripts/build-mac-sqlite.sh` builds
the pinned amalgamation in `scripts/lib/sqlite-macos.json`, cached under
`apps/macos/.build/sqlite/<version>/`. The resulting signed library supports
SQLite extensions without relying on Apple's system SQLite or Homebrew.

Packaging verifies the Bun revision, CLI version, Gateway help, SQLite and
`sqlite-vec` loading, native capabilities, and worker readiness in temporary
state before and after signing, then replaces the previous app. It also rejects
any Node executable in the app. `scripts/restart-mac.sh` uses the same path;
`SKIP_TSC=1` does not bypass the runtime build. Existing content-checked build
caches still avoid unnecessary declaration work.

The private worker preserves the app's saved desktop-sharing preference and
profile selection. Packaging checks startup with sharing enabled, disabled,
and unspecified, including named-profile launches, before and after signing.

Set `OPENCLAW_NODE_VERSION=<version>` when packaging to select a supported Node
version for the temporary package installation. If unset or empty, the CLI
installer's default applies. This build-time override does not change the
bundled Bun pin.

The runtime shares one JavaScript package across requested `BUILD_ARCHS`
architectures. Universal builds combine Bun and SQLite into universal binaries
and retain the separate arm64 and x64 Darwin native packages. Staging installs
each CPU's optional dependencies separately, merges matching shared files, and
combines distinct Mach-O slices at shared paths. Other shared-file conflicts
fail packaging. Single-architecture
builds retain only their compatible native payloads. Linux and Windows prebuilds
are removed; compatible JavaScript, WASM, and other resources remain intact.
Universal staging on Apple silicon requires Rosetta for x64 dependency install
hooks, which execute native code using a temporary x64 Node driver.

Packaging executes verification for each runnable architecture. Verifying
x86_64 on Apple silicon requires Rosetta; without it, packaging reports that
architecture's execution checks as skipped. Missing binary architectures or
nonportable native dependencies fail packaging. Downloads and package
installation need network access on the build host. A packaged app needs no
runtime download during onboarding: it seeds that payload into the profile's
state directory and hosts the Gateway with Bun. The stage script writes the
package's `openclaw-install-owner.json` marker so Gateway updates remain owned
by the app.

Packaging builds the MLX voice helper with Swift Build (`--build-system swiftbuild`)
and copies its SwiftPM resource bundles into `Contents/Resources`. The native
SwiftPM backend does not compile MLX's Metal shaders. Packaging fails if the
helper's `mlx-swift_Cmlx.bundle/Contents/Resources/default.metallib` is missing,
rather than shipping a helper that fails on its first speech request.

The private worker uses read-only core config bootstrap rather than Gateway-wide
Doctor preflight. Node plugin validation, MCP lifecycle, and node-owned identity
and exec-approval startup migrations remain enabled. See
[Gateway ownership](/platforms/mac/bundled-gateway) for the boundary.

Set `OPENCLAW_SKIP_MLX_TTS=1` to package a dev/proof build without the local
MLX voice helper. This skips the `openclaw-mlx-tts` binary and its large
mlx-swift Metal shader stack, which some beta Xcode toolchains cannot compile.
The resulting app has no on-device MLX voice; it is rejected for `release`
builds, which must ship the helper.

For dev run modes, signing flags, and Team ID troubleshooting, see
[apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md).
Fast dev loop from repo root: `scripts/restart-mac.sh` (add `--no-sign` for
ad-hoc signing; TCC permissions do not stick with `--no-sign`).

<Note>
Ad-hoc signed apps may trigger security prompts. If the app crashes
immediately with "Abort trap 6", see [Troubleshooting](#troubleshooting).
</Note>

## 3. Install the CLI and Gateway

On a fresh profile in a packaged app, choose **This Mac** during onboarding.
The app prepares its bundled Bun runtime, starts the Gateway as its child,
and creates the profile's terminal CLI shim. It does not invoke
`scripts/install-cli.sh`, install Node, or ask for an install channel.
Unbundled DEBUG builds retain the installer and channel chooser.

Runtime copies live at `<state>/runtime/<runtimeBuildId>/`. App-hosted children
and app-managed Bun LaunchAgents use concrete build paths; only the terminal
shim uses `runtime/current`. Post-update setup reseeds the payload and refreshes
app-owned Bun service pins before verifying health and collecting old builds.
See [Gateway on macOS](/platforms/mac/bundled-gateway).

For manual development recovery, install the matching CLI yourself. Read the
version from the app: choose **About OpenClaw** in the menu bar, or run
`openclaw-mac status --json`, which reports the app version and build.

The npm command below is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.

```bash
npm install -g openclaw@<version> --allow-scripts=openclaw
```

`pnpm add -g --allow-build=openclaw openclaw@<version>` and
`bun add -g --trust openclaw@<version>` also work. Bun's `--trust` allows the
OpenClaw lifecycle scripts for that install. Node remains the recommended
runtime for the Gateway itself.

## Run native tests safely

Run the full macOS app test suite in a disposable macOS VM or CI worker with
no operator credentials, config, or running Gateway. AppKit tests can show
windows, and WebKit starts helper processes. A temporary `HOME`, `TMPDIR`, or
named app profile alone is not a sandbox: fixed preferences domains and
Keychain access can still reach macOS services outside those directories.

The native test bundle links `OpenClawWebKitTestSupport`, which suppresses WebKit
Screen Time observation for every `WKWebView` in the test process. WebKit removes
its KVO observer on the main thread during deallocation while ScreenTime delivers
configuration on a private queue. Tearing down a windowed HTTP(S) web view right
after its first commit can hit this race and abort the process with
`NSInternalInconsistencyException`. Product builds keep Screen Time.

The `macos-swift` GitHub CI job builds the tests with the runner's normal
SwiftPM caches, then runs the built suite through `scripts/test-macos-native.mts`.
Each invocation selects private `HOME` and `CFFIXED_USER_HOME`,
`OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`, and short `TMPDIR` before any test
bundle loads. Tools honoring `TMPDIR` use that launcher-owned directory;
Foundation uses Darwin's per-user temp directory, owned and discarded by the
disposable OS worker. The full suite explicitly selects the default profile, preserving
its local Gateway lifecycle contracts. AppState lifecycle tests and the interactive
chat fixture run separately with a unique named profile; no test is run twice. The child environment excludes
inherited app settings and credentials while retaining toolchain and runtime
loader paths. Before Swift starts, the launcher creates an empty-password test
Keychain under its private `HOME/Library/Keychains`, unlocks it, disables automatic
locking for that resource, and sets the user-domain default and search list to
that file. This lets real catalog migration save without an interactive
login-Keychain creation prompt. Its Security preferences live in the private
`HOME/Library/Preferences`; common and dynamic Keychain domains remain unchanged.
Resources remain available for process-lifetime singletons and retained windows;
the launcher deletes its Keychain and files after the managed process group and
output pipes close. The disposable runner owns default preferences and system-service
state; named-profile preferences use a fresh domain and are also discarded with
the runner.
If process cleanup cannot be verified or Keychain deletion fails, the launcher
fails and retains its files for inspection.
CI environment markers only catch accidental invocation; they do not enforce
isolation or make an operator desktop safe.

For a focused rerun **inside that disposable macOS CI runner**, after the normal
test build:

```bash
node scripts/test-macos-native.mts named \
  --package-path apps/macos --build-system native --enable-code-coverage \
  --skip-build --filter "AppStateIsolationTests|ProfileChatPreferencesTests"
```

The ordinary CI invocation bounds Swift Testing parallelism to the runner's logical
CPU count, capped at 12. It runs three disjoint partitions sequentially with coverage
instrumentation: the default-profile suite, rendered Quick Chat in a fresh default-profile
process, and named-profile fixtures. The rendered partition preserves catalog, disclosure,
and shortcut order without sharing process-wide executor changes from other tests.
Both interactive fixtures use Swift Testing and start an AppKit-owned run loop before
exercising native menus, so XCTest does not have to regain its outer wait loop afterward. Historical targets
with the launcher keep their original default- and named-profile partitions.
Local `scripts/prepush-ci.sh` runs Swift lint/format checks and a release
build, but does not run native tests. For native changes it exits nonzero with a
requirement to obtain the exact commit's `macos-swift` CI result; local build
success is not native test success.

On an operator desktop, run only an audited subset inside an OS sandbox that
blocks operator files, preferences and Keychain services, unwanted network
access, and desktop/helper processes. A Swift test filter is not itself an
isolation boundary. If that boundary cannot be established, use the disposable
macOS environment instead.

Tests should own their resources: unique defaults suites with cleanup,
nonpersistent WebKit data stores, ephemeral loopback fixture endpoints, and
temporary files rooted in `FileManager.temporaryDirectory`. Unix-domain socket
fixtures require a short test-owned path there; an overlong path fails rather
than silently writing outside that directory. The cooperative `TestIsolation` helper
serializes and restores participating tests' environment and selected defaults
mutations. Config-only scopes also own a temporary state directory for config
health/audit writes and remove it when the async body finishes, including errors.
Callers still own their config fixture files and must join any async work before
leaving the scope. These unique fixture directories are cleaned by their owners;
remaining Foundation temporary files are discarded with the worker, not the
launcher's root. Never change `OPENCLAW_PROFILE` inside a test: `AppProfile`
and `AppDefaults` freeze their identity for the process. Tests needing another
singleton identity require a fresh process. The cooperative helper does not
isolate unrelated tests or the process from the host.

Swift Testing runs suites concurrently in one process, so never replace the
global executor (for example `withMainSerialExecutor` or
`uncheckedUseMainSerialExecutor` from ConcurrencyExtras). Its hook moves every
other suite's global jobs, actor work, and timer wakeups onto the main thread;
one non-yielding loop there starves the timeout that would cancel it, and the
job hangs until CI cancels it. To assert that a late reply changed nothing,
await the task that settles that reply, as provider wizard and manual-key
actions return it.

## Troubleshooting

### Build fails while freezing Peekaboo sources

If packaging stops at `Freezing authenticated Peekaboo sources in a read-only snapshot`,
check the `hdiutil` error on stderr. Routine image creation and attachment output stays
quiet, but failures such as `hdiutil: attach failed - Permission denied` are preserved.
Snapshot images and build outputs stay in the checkout. Their read-only mount directories
use macOS's per-user temporary location (`getconf DARWIN_USER_TEMP_DIR`), independently of
`TMPDIR`, so an external checkout does not need to support nested mounts. If attachment
still fails, check that location's mount permissions. Unverified cleanup retains the
mount directories and build locks at the paths printed in the error. This step runs before
signing; source verification and the read-only snapshot remain required.

### Build fails: toolchain or SDK mismatch

The macOS app build expects the latest macOS SDK and the Swift 6.3 toolchain
(Xcode 26.4+).

```bash
xcodebuild -version
xcrun swift --version
```

If versions don't match, update macOS/Xcode and re-run the build.

### Build fails: MLX voice helper Metal shaders

On a beta-only Xcode toolchain (for example Xcode 27 with the macOS 27 SDK),
only the `openclaw-mlx-tts` helper may fail while the main app builds fine. The
mlx-swift Metal compilation errors non-deterministically (a different `.metal`
file each run, `Could not read serialized diagnostics file` then a nonzero
`metal` exit), because the beta `metal` compiler and its separately downloaded
Metal Toolchain are still unstable. This is an upstream toolchain issue, not an
OpenClaw one.

If you do not need on-device MLX voice, skip the helper:

```bash
OPENCLAW_SKIP_MLX_TTS=1 ./scripts/package-mac-app.sh
```

Otherwise, install the Metal Toolchain
(`xcodebuild -downloadComponent MetalToolchain`) and build from a stable Xcode
release.

### App crashes on permission grant

If the app crashes when you try to allow **Speech Recognition** or
**Microphone** access, it may be a corrupted TCC cache or signature mismatch.

1. Reset TCC permissions for the debug bundle id:

   ```bash
   tccutil reset All ai.openclaw.mac.debug
   ```

2. If that fails, temporarily change `BUNDLE_ID` in
   [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)
   to force a clean slate from macOS.

### Gateway "Starting..." indefinitely

Check whether a zombie process holds the port:

```bash
openclaw gateway status
openclaw gateway stop

# If you're not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

If a manual run holds the port, stop it (Ctrl+C), or kill the PID found above
as a last resort.

## Related

- [macOS app](/platforms/macos)
- [Install overview](/install)

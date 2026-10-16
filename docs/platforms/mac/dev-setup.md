---
summary: "Setup guide for developers working on the OpenClaw macOS app"
read_when:
  - Setting up the macOS development environment
title: "macOS dev setup"
---

# macOS developer setup

Build and run the OpenClaw macOS application from source.

The packaged app requires macOS 26.2 or later. The build host must also meet
the Xcode requirements below.

## Prerequisites

- **Xcode 26.4+** (Swift 6.3 toolchain), on the latest macOS available in
  Software Update.
- **Node.js 24.16+ or 26.1+ & pnpm** for the gateway, CLI, and packaging scripts.
  SwiftPM and Xcode generate the Gateway protocol models with the first
  supported Node on `PATH`, then `/opt/homebrew/bin/node` or
  `/usr/local/bin/node`. Version-manager shims such as mise, asdf, or Volta
  resolve to the Node binary they launch.

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

Outputs `dist/OpenClaw.app`. By default this is a debug-configuration build
with the development bundle identifier `ai.openclaw.mac.debug`, meant to run
beside an installed release. To replace a release install, see
[Replace an installed release app](#replace-an-installed-release-app).
Packaging requires a real signing identity by default and fails if none is
available. Ad-hoc signing is an explicit opt-in; it does not preserve TCC
permissions. See [macOS signing](/platforms/mac/signing).

Packaging builds the same-commit JavaScript runtime and Control UI, then invokes
[`scripts/build-bun-standalone.mjs`](/install/standalone) with the production-pinned
Bun compiler. The app contains `Contents/Resources/runtime/openclaw`, its loose
`runtime/` sidecar, and a manifest. The sidecar includes the signed SQLite
library at `runtime/lib/libsqlite3.dylib`.
There is no separate Bun interpreter or installed `lib/node_modules/openclaw`
package in the app. The sidecar retains the builder's native dependencies and
resources, including same-commit plugins.

`OPENCLAW_MAC_RUNTIME_MODE=jit` is the default. Select
`OPENCLAW_MAC_RUNTIME_MODE=bytecode` to embed bytecode instead. Both modes use
exactly the entitlements declared by the builder manifest. Packaging checks the
manifest's version, commit, architecture, executable checksum, and complete
sidecar checksum before copying any artifact. Each app contains one architecture;
pass `BUILD_ARCHS=arm64` or `BUILD_ARCHS=x86_64` to select its matching builder
output. Both app and distribution packaging default to the host architecture.
Universal and multi-architecture requests fail before building. ARM64 is currently
qualified; Intel qualification awaits the builder's cross-compilation support.

For an existing build, `OPENCLAW_MAC_RUNTIME_PREBUILT=/path/to/output` skips
compilation while retaining every manifest check. The output must match this
checkout's exact commit and selected mode. This is a build input, not an app
runtime switch. Stale prebuilt output cannot be relabeled to match newer source.

The OpenClaw Bun fork has one shared pin in `scripts/lib/openclaw-bun.json`.
The compiler is staged outside the app and discarded after packaging.
The standalone builder supplies the pinned SQLite library with extension
loading. The executable selects its bundled library without an app-provided
environment override. The app needs no runtime download during onboarding.

Packaging verifies the relocated executable's version, Gateway help, Doctor,
and embedded node-worker readiness. Native portability and signature checks
cover the executable and sidecar. The canonical signer signs nested native code,
refreshes the packaged manifest checksums, then seals the enclosing app.
`SKIP_TSC=1` does not bypass the runtime build or provenance checks.

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

### Replace an installed release app

`scripts/package-mac-app.sh` defaults to `BUILD_CONFIG=debug` and
`BUNDLE_ID=ai.openclaw.mac.debug`. Copied over `/Applications/OpenClaw.app`,
that build is still a different app to macOS and to OpenClaw:

- The debug bundle ID has its own TCC grants and, for the default profile, its
  own `ai.openclaw.mac.debug` defaults domain. Packaging clears its Sparkle
  feed, so it never updates.
- Keychain items the release app created, such as `ai.openclaw.tls-pinning`,
  trust only the release app's code signature. Reading them raises
  login-keychain password prompts.
- The debug Swift configuration reads saved Gateway profiles from the separate
  `ai.openclaw.gateway-profiles.debug` Keychain service, so the release app's
  saved Gateways are missing.

To replace a release install, package the release identity from a clean
checkout:

```bash
BUILD_CONFIG=release BUILD_ARCHS=arm64 BUNDLE_ID=ai.openclaw.mac ./scripts/package-mac-app.sh
```

Release configuration runs `scripts/apple-release-source-check.sh`, which fails
unless the checkout is clean at the commit being built, and it requires the MLX
voice helper. Build Intel artifacts separately with `BUILD_ARCHS=x86_64` once the
builder supports that target. Release publishing must keep each architecture's
ZIP, DMG, and Sparkle update separate, including native-architecture routing for
existing universal installations. Before installing, check the designated requirement:

```bash
codesign -dr - dist/OpenClaw.app
```

The output must include `identifier "ai.openclaw.mac"`. Keychain and TCC access
follow the whole requirement, not just the identifier: sign with a Developer ID
Application identity from the same team as the installed app, or macOS still
treats the build as a different app. Sparkle stays enabled in this build, so a
newer published release can replace it.

Keep the default debug identity for development builds that run beside an
installed release.

### Shared Bun pin and repin gate

The JSON schema has top-level `tag`, `commit`, `revision`, and `artifacts`.
`artifacts` is keyed by `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`windows-arm64`, and `windows-x64`; each entry contains `asset`, `sha256`,
`executable`, and `executableSha256`. Windows entries also carry
`authenticodeSigned: true` and `testOnly: false`. These are a projection of the
published fork release's `manifest.json`, not independently maintained app or CI
pins. Unsigned Windows dry-run artifacts are not shippable.

Every repin requires both gates on the same published tag: CI's paired Bun-lane
replay and Bun-only smoke, plus the macOS runtime checks and two-binary test set.
Neither app nor CI advances when either gate fails. A Linux-only regression
also stops the shared repin. Preserve the last tag admitted by both gates while
investigating; a published prerelease alone is not admission. Record the exact
tag and gate evidence in the PR. See [CI runtime selection](/ci/pipeline#test-runtime-selection).

After the gates pass, download `manifest.json` and `SHA256SUMS` from that exact
release and verify the manifest and asset checksums. Regenerate all six entries together:

```sh
jq '{tag, commit: .bun.commit, revision: .bun.revision,
  artifacts: (.assets | map(
    select(.target | IN("darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64")) |
    {key: .target, value: ({asset: .name, sha256,
      executable: .executable.path, executableSha256: .executable.sha256} +
      (if .os == "windows" then {authenticodeSigned: .executable.authenticodeSigned,
        testOnly: .executable.testOnly} else {} end))}
  ) | from_entries)}' manifest.json > scripts/lib/openclaw-bun.json
```

Repin one shared owner in one PR and run the shared stager for all four Darwin/Linux
targets; execute native proofs on matching hosts (Rosetta can verify Darwin x64).
The signed Windows entries are available for Windows packaging integration. Do not advance an
individual artifact or copy the pin into an app or workflow.

## 3. Install the CLI and Gateway

On a fresh profile in a packaged app, choose **This Mac** during onboarding.
The app prepares its standalone runtime, starts the Gateway as its child,
and creates the profile's terminal CLI shim. It does not invoke
`scripts/install-cli.sh`, install Node, or ask for an install channel.
Unbundled DEBUG builds retain the installer and channel chooser.

Runtime copies live at `<state>/runtime/<runtimeBuildId>/`. App-hosted children
and app-managed LaunchAgents use concrete build paths; only the terminal
shim uses `runtime/current`. Post-update setup reseeds the payload and refreshes
app-owned service pins before verifying health and collecting old builds.
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
The release-only bundled recovery app-host lane keeps the disposable account’s
canonical home so the real CLI can manage its unique named-profile service. Its
state and preferences use that profile. The app host and Security commands share
the account’s user Keychain domain, selecting the launcher-owned empty-password
Keychain file; temporary files also remain launcher-owned. Cleanup removes
the profile state only after the service and its observed process group retire.
Unverified retirement retains both the profile state and temporary resources.

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

Work a test starts must end with the test, because the process outlives it.
Shut down Gateway channels and connections a test opens; their watchdog
otherwise keeps reconnecting through the test's fixture. Fake transports and
sockets must stop waiting when their read is cancelled, as the production stream
transports do: `AsyncTimeout` cancels and abandons the operation that loses its
race instead of joining it, so a fake that ignores cancellation keeps polling for
the rest of the run.

## Troubleshooting

### Build fails while freezing Peekaboo sources

If packaging stops at `Freezing authenticated Peekaboo sources in a read-only snapshot`,
check the `hdiutil` error on stderr. Routine image creation and attachment output stays
quiet, but failures such as `hdiutil: attach failed - Permission denied` are preserved.
A transient `Resource temporarily unavailable` attach failure is retried, up to three
attempts in total. If attachment fails before mounting, cleanup detaches the snapshot image
by device; if it stays attached, cleanup fails, retains the files, and prints the
`hdiutil detach /dev/diskN` command to run.
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
mlx-swift Metal compilation fails unpredictably (a different `.metal`
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

During a cold start, the Gateway can briefly hold the state database for schema
maintenance. The app waits for that custody to finish within its existing
readiness timeout, then continues automatic setup. It does not replace the
Gateway or create a new device identity while maintenance is active.

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

# Native packaging (source builds only)

Nothing here publishes binaries, packages, apps, or releases. Generated source and
Cargo.lock are checked in; `target/` and `dist/` are ignored. Keep the generated
wrapper and native library from the same source revision and locked UniFFI 0.31.2.
A source-built library does not imply a qualified mobile app or store submission.

## Apple

On a provisioned Mac with Xcode and Rust 1.99.0, install the five Rust targets in CI
(or explicitly provision them outside this script), then:

```sh
export RUSTUP_TOOLCHAIN=1.99.0
scripts/generate-bindings.sh
scripts/build-apple.sh
```

Targets:

- `aarch64-apple-darwin` + `x86_64-apple-darwin`: universal macOS slice.
- `aarch64-apple-ios`: iOS device slice.
- `aarch64-apple-ios-sim` + `x86_64-apple-ios`: universal simulator slice.

`OPENCLAW_IROH_APPLE_PLATFORMS=macos scripts/build-apple.sh` builds only the macOS slice.

`Cargo.lock` pins `libc` at 0.2.189 so the iOS slices build. `netdev` 0.46 (via iroh's
`netwatch` 0.19.3) uses `libc::in6_ifreq` on every Apple target, and `libc` 0.2.190
limited that type to macOS. On iOS, `netdev` falls back to default IPv6 address flags if
the system rejects that query. `scripts/check-pins.sh` fails CI if the pin drifts while
`netdev` 0.46.0–0.46.3 is locked. Lift the pin once the lockfile carries a `netdev` that
skips that code on iOS (0.47 already does). The `iroh native binding audit` workflow
checks the locked dependencies against RustSec weekly and on lockfile changes.

Output: `dist/apple/OpenClawIrohFFI.xcframework`, created by `xcodebuild
-create-xcframework`. Minimum deployment targets are macOS 15 and iOS 18, matching
OpenClawKit. No watchOS support. Add the XCFramework as a binary C target and
`generated/OpenClawIroh.swift` as its Swift wrapper target named `OpenClawIroh`.
Consumers must include the Rust dependency system frameworks at final link time
(Security, SystemConfiguration, Network, and CoreWLAN on macOS); verify the actual
app linker inputs for the target. No signing or app archive is performed here.

OpenClawKit's native transport is opt-in. Default builds do not resolve this package,
and if a node binding is requested they fail closed with "native transport not packaged".
Build the XCFramework first, then set `OPENCLAW_IROH_NATIVE=1` for every Swift build or
test command that consumes it. An opted-in build with no artifact fails SwiftPM
resolution; there is no automatic fallback. The generated Swift and header must come
from the same source revision as the native library. The Apple integration workflow
owns the SwiftPM package and adapter tests. Whether native becomes the default is a
separate maintainer decision.

CI builds all slices and typechecks the generated Swift wrapper on the host. An
Intel slice is **not** Intel runtime proof; iOS/simulator libraries are **not**
device lifecycle or app tests. Run consumer Swift integration tests, app linking,
Keychain, network changes, and background behavior in the owning app lanes before
shipping. The script prints byte sizes and SHA-256 for each packaged static slice.

## Android

CI pins **NDK 28.2.13676358 (r28c)** and **cargo-ndk 3.5.4**. It installs them on
the CI runner, never on an operator host. On an already provisioned host:

```sh
export RUSTUP_TOOLCHAIN=1.99.0
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
scripts/build-android.sh
```

Rust targets must be present: `aarch64-linux-android`, `armv7-linux-androideabi`,
`x86_64-linux-android`, and `i686-linux-android`. The build uses API 31, matching
the app's minimum SDK, and emits:

```text
dist/android/jniLibs/arm64-v8a/libopenclaw_iroh_ffi.so
dist/android/jniLibs/armeabi-v7a/libopenclaw_iroh_ffi.so
dist/android/jniLibs/x86_64/libopenclaw_iroh_ffi.so
dist/android/jniLibs/x86/libopenclaw_iroh_ffi.so
```

The script checks every ELF LOAD segment's alignment is at least 16 KiB and prints
size/hash per ABI. Android ZIP packaging alignment and runtime loading on a 16 KiB
device still require the app's AGP/device lane; ELF alignment alone does not prove
those. APK/AAB installed/download deltas have not been measured by this crate.

Add `generated/ai/openclaw/iroh/openclaw_iroh_ffi.kt` and
`android/ai/openclaw/iroh/OpenClawIrohAndroid.kt` to the app's generated Kotlin
source inputs and `dist/android/jniLibs` to its JNI library inputs. Reuse the app's
existing JNA 5.19.1 and coroutines 1.11.0; do not change their versions or package
upstream desktop iroh binaries. Configure the existing shrinker to preserve the
JNI entry point `ai.openclaw.iroh.OpenClawIrohAndroid.installNative` and UniFFI/JNA
native callbacks/types.

Call `OpenClawIrohAndroid.install(applicationContext)` from Application initialization
**before binding any endpoint**. The native entry validates Application type and
retains one process-lifetime global reference plus JavaVM for iroh system DNS.
Initialization failures throw and permit a later valid retry. This is the sole
`ndk-context` initializer; do not load another iroh library with a competing owner.
No Activity is retained. The Android JNI source is cross-built in CI; the Linux
transport tests do not execute it.

## Licenses and release gates

Our wrapper is MIT. iroh is MIT OR Apache-2.0; UniFFI is MPL-2.0, zeroize is
Apache-2.0 OR MIT, and JNI is MIT OR Apache-2.0. `zeroize` and `jni` were already
in the sibling's locked transitive graph; they are explicit direct dependencies
here only for seed erasure and Android Application/VM initialization. No iroh-ffi
source was copied. The new crate preserves versions of the sibling's existing
locked packages; added UniFFI generator/runtime packages are separately locked.

Before any distribution, produce a target-specific transitive license/notice
inventory from the locked graph (including iroh's default portmapper graph),
include the required notices in the owning app, and review MPL obligations.
`cargo metadata --locked --format-version 1` provides package/license/source inputs;
it is not by itself a completed license audit. Keep exact source SHA, toolchain,
NDK/Xcode version, deployment floors, library hashes and sizes with release evidence.
Release signing, notarization, store review, application size/performance and
mobile runtime testing are outside this crate's build-only CI.

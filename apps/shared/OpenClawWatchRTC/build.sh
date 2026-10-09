#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <watchos|watchsimulator|macosx> <output-directory> <architecture> [...]" >&2
  exit 2
fi

rtc_sdk="$1"
rtc_output="$2"
shift 2
rtc_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
rtc_toolchain=nightly-2026-10-01

if ! command -v cargo >/dev/null || ! command -v rustup >/dev/null; then
  echo "Watch voice requires Rust. Install rustup, then: rustup toolchain install $rtc_toolchain --profile minimal --component rust-src" >&2
  exit 1
fi
if ! rustup run "$rtc_toolchain" rustc --version >/dev/null 2>&1; then
  echo "Missing pinned Watch toolchain. Run: rustup toolchain install $rtc_toolchain --profile minimal --component rust-src" >&2
  exit 1
fi

mkdir -p "$rtc_output"
rtc_output="$(cd -- "$rtc_output" && pwd)"
rtc_sdk_path="$(xcrun --sdk "$rtc_sdk" --show-sdk-path)"
rtc_archives=()
for rtc_arch in "$@"; do
  rtc_no_asm=0
  case "$rtc_sdk/$rtc_arch" in
    watchos/arm64) rtc_target=aarch64-apple-watchos ;;
    watchos/arm64_32) rtc_target=arm64_32-apple-watchos; rtc_no_asm=1 ;;
    watchsimulator/arm64) rtc_target=aarch64-apple-watchos-sim ;;
    watchsimulator/x86_64) rtc_target=x86_64-apple-watchos-sim ;;
    macosx/arm64) rtc_target=aarch64-apple-darwin ;;
    macosx/x86_64) rtc_target=x86_64-apple-darwin ;;
    *) echo "Unsupported Watch voice build: $rtc_sdk/$rtc_arch" >&2; exit 2 ;;
  esac

  rtc_cached_archive=""
  if [[ -n "${OPENCLAW_WATCH_RTC_CACHE_DIR:-}" ]]; then
    # Cargo's build-std fingerprints use rust-src mtimes, which change on fresh
    # runners. Cache the finished slice by content instead of restoring target/.
    rtc_key="$(
      {
        (cd "$rtc_root" && {
          shasum -a 256 Cargo.toml Cargo.lock rust-toolchain.toml build.sh
          find src -type f -exec shasum -a 256 {} + | LC_ALL=C sort
        })
        rustup run "$rtc_toolchain" rustc -vV
        xcodebuild -version
        xcrun --sdk "$rtc_sdk" --show-sdk-version
        printf '%s\n' "$rtc_target" "$rtc_no_asm" "${WATCHOS_DEPLOYMENT_TARGET:-11.0}" \
          "${MACOSX_DEPLOYMENT_TARGET:-}" "${RUSTFLAGS:-}" "${CARGO_ENCODED_RUSTFLAGS:-}" \
          "${CARGO_BUILD_RUSTFLAGS:-}" "${CC:-}" "${CFLAGS:-}"
      } | shasum -a 256 | cut -d ' ' -f 1
    )"
    mkdir -p "$OPENCLAW_WATCH_RTC_CACHE_DIR"
    rtc_cached_archive="$OPENCLAW_WATCH_RTC_CACHE_DIR/$rtc_target-$rtc_key.a"
    if [[ -f "$rtc_cached_archive" && -f "$rtc_cached_archive.sha256" ]] &&
      [[ "$(shasum -a 256 "$rtc_cached_archive" | cut -d ' ' -f 1)" == "$(cat "$rtc_cached_archive.sha256")" ]]; then
      echo "Watch RTC: verified cache hit ($rtc_target)"
      rtc_archives+=("$rtc_cached_archive")
      continue
    fi
  fi

  # Tier-3 Watch targets require build-std. ILP32 uses AWS-LC's supported portable
  # implementation at Release opt-level 2; size optimization selects incompatible limbs.
  SDKROOT="$rtc_sdk_path" \
    WATCHOS_DEPLOYMENT_TARGET="${WATCHOS_DEPLOYMENT_TARGET:-11.0}" \
    AWS_LC_SYS_NO_ASM="$rtc_no_asm" AWS_LC_SYS_CMAKE_BUILDER=0 \
    cargo "+$rtc_toolchain" build --locked --release \
    --manifest-path "$rtc_root/Cargo.toml" --target-dir "$rtc_output/target" \
    --target "$rtc_target" -Z build-std=std,panic_unwind -j "${CARGO_BUILD_JOBS:-4}"
  rtc_archive="$rtc_output/target/$rtc_target/release/libopenclaw_watch_rtc.a"
  if [[ -n "$rtc_cached_archive" ]]; then
    cp "$rtc_archive" "$rtc_cached_archive"
    shasum -a 256 "$rtc_cached_archive" | cut -d ' ' -f 1 > "$rtc_cached_archive.sha256"
  fi
  rtc_archives+=("$rtc_archive")
done
xcrun lipo -create "${rtc_archives[@]}" -output "$rtc_output/libopenclaw_watch_rtc.a"

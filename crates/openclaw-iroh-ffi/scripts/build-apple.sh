#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Match the shared native package's deployment floors. Xcode/targets must already exist.
export MACOSX_DEPLOYMENT_TARGET=15.0
export IPHONEOS_DEPLOYMENT_TARGET=18.0
for target in aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo build --locked --release --lib --target "$target"
done
mkdir -p dist/apple/{macos,ios,simulator,headers}
lipo -create target/{aarch64,x86_64}-apple-darwin/release/libopenclaw_iroh_ffi.a \
  -output dist/apple/macos/libopenclaw_iroh_ffi.a
lipo -create target/{aarch64-apple-ios-sim,x86_64-apple-ios}/release/libopenclaw_iroh_ffi.a \
  -output dist/apple/simulator/libopenclaw_iroh_ffi.a
cp target/aarch64-apple-ios/release/libopenclaw_iroh_ffi.a dist/apple/ios/
cp generated/OpenClawIrohFFI.h dist/apple/headers/
cp generated/OpenClawIrohFFI.modulemap dist/apple/headers/module.modulemap
# xcodebuild refuses to overwrite existing output; remove only this script's generated bundle.
rm -rf dist/apple/OpenClawIrohFFI.xcframework
xcodebuild -create-xcframework \
  -library dist/apple/macos/libopenclaw_iroh_ffi.a -headers dist/apple/headers \
  -library dist/apple/ios/libopenclaw_iroh_ffi.a -headers dist/apple/headers \
  -library dist/apple/simulator/libopenclaw_iroh_ffi.a -headers dist/apple/headers \
  -output dist/apple/OpenClawIrohFFI.xcframework
find dist/apple -name '*.a' -exec wc -c {} \; -exec shasum -a 256 {} \;
# Compile the generated Swift against the host slice; cross build is not device-runtime proof.
swiftc -typecheck -I dist/apple/headers generated/OpenClawIroh.swift

#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
swift build --package-path "$repo_root/native" -c release
codesign --force --sign - "$repo_root/native/.build/release/facetime-audio-capture"
codesign --verify --strict "$repo_root/native/.build/release/facetime-audio-capture"

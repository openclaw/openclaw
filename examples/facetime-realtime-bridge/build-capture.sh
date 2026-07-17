#!/bin/sh
set -eu

swift build --package-path native -c release
codesign --force --sign - native/.build/release/facetime-audio-capture
codesign --verify --strict native/.build/release/facetime-audio-capture

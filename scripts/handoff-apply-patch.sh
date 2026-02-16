#!/usr/bin/env bash
set -euo pipefail

PATCH_DIR="${1:?usage: $0 <path-to-patches-dir>}"

git am "$PATCH_DIR"/*.patch

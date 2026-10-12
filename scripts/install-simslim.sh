#!/bin/bash

set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "usage: $0 <install-directory>" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "simslim requires macOS arm64" >&2
  exit 1
fi

readonly simslim_version="0.10.0"
readonly simslim_checksum="eec00b27f0694fa899fb3bbc71362309a9da11ec670f430633cfae855eaf4a1d"

umask 077
install_dir="$1"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

archive="$temp_dir/simslim.tar.gz"
extract_dir="$temp_dir/extract"

# This immutable GET can retry connection failures too; curl resets its output file.
curl --fail --location --silent --show-error \
  --connect-timeout 10 --max-time 120 \
  --retry 3 --retry-all-errors --retry-max-time 120 \
  --output "$archive" \
  "https://github.com/MobAI-App/simslim/releases/download/v$simslim_version/simslim-v$simslim_version-macos-arm64.tar.gz"
archive_checksum="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$archive_checksum" != "$simslim_checksum" ]]; then
  echo "simslim archive checksum mismatch" >&2
  exit 1
fi

mkdir -p "$install_dir" "$extract_dir"
tar -xzf "$archive" -C "$extract_dir" simslim
install -m 0755 "$extract_dir/simslim" "$install_dir/simslim"
installed_version="$("$install_dir/simslim" --version)"
if [[ "$installed_version" != "simslim $simslim_version" ]]; then
  echo "simslim version mismatch" >&2
  exit 1
fi

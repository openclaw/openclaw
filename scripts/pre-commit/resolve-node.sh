#!/usr/bin/env bash
# Resolve the newest nvm-managed Node when it is not already in PATH.
# Source this file; do not execute it directly.
#
# Cross-platform: avoids GNU-only `sort -V` (not supported by BSD sort on
# macOS). Instead, each semver component is zero-padded to five digits so
# that a plain lexicographic sort correctly selects the highest semantic
# version (e.g. v22.x wins over v18.x).
if ! command -v node >/dev/null 2>&1; then
  _nvm_node=$(
    for _p in "$HOME/.nvm/versions/node"/*/bin/node; do
      [[ -x "$_p" ]] || continue
      _ver="${_p%/bin/node}"; _ver="${_ver##*/v}"
      IFS=. read -r _ma _mi _pa <<< "$_ver"
      # Strip any non-numeric suffix so prerelease tags (e.g. "0-rc.1", "0-nightly")
      # do not make printf '%05d' fail under set -euo pipefail.
      # ${var%%pattern} removes the longest suffix matching pattern, so
      # "0-rc.1" → "0" and "14" → "14" (no-op when already numeric-only).
      _ma="${_ma%%[^0-9]*}"
      _mi="${_mi%%[^0-9]*}"
      _pa="${_pa%%[^0-9]*}"
      printf '%05d%05d%05d\t%s\n' "${_ma:-0}" "${_mi:-0}" "${_pa:-0}" "$_p"
    done | sort | tail -1 | cut -f2-
  )
  if [[ -x "$_nvm_node" ]]; then
    export PATH="$(dirname "$_nvm_node"):$PATH"
  fi
  unset _nvm_node _p _ver _ma _mi _pa
fi

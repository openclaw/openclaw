#!/usr/bin/env bash
# Resolve the newest nvm-managed Node when it is not already in PATH.
# Source this file; do not execute it directly.
#
# Uses `sort -V` (version-aware sort) so that semantic version order is
# respected — e.g. v22.x is chosen over v18.x even though "v1" sorts
# before "v2" lexicographically.
if ! command -v node >/dev/null 2>&1; then
  _nvm_node=$(
    ls -d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null \
      | sort -V \
      | tail -1
  )
  if [[ -x "$_nvm_node" ]]; then
    export PATH="$(dirname "$_nvm_node"):$PATH"
  fi
  unset _nvm_node
fi

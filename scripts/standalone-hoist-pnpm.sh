#!/usr/bin/env bash
# standalone-hoist-pnpm.sh — Hoist pnpm .pnpm packages to top-level node_modules
#
# The Next.js standalone build with pnpm stores traced dependencies inside
# .pnpm/<package>@<version>/node_modules/. Node's require() can't resolve
# bare imports like require('next') from that structure because the top-level
# symlinks that pnpm normally creates don't survive npm tarball packing.
#
# This script copies each package from .pnpm/*/node_modules/ to the
# standalone root node_modules/ so require() works in global npm installs,
# then removes .pnpm to avoid file duplication in the tarball.

set -euo pipefail

STANDALONE_NM="apps/web/.next/standalone/node_modules"

if [ ! -d "$STANDALONE_NM/.pnpm" ]; then
  echo "[standalone-hoist] no .pnpm directory found — skipping"
  exit 0
fi

echo "[standalone-hoist] hoisting .pnpm packages to top-level node_modules…"

for inner_nm in "$STANDALONE_NM"/.pnpm/*/node_modules; do
  [ -d "$inner_nm" ] || continue
  for pkg in "$inner_nm"/*; do
    [ -e "$pkg" ] || continue
    name="$(basename "$pkg")"

    if [[ "$name" == @* ]]; then
      # Scoped package dir (e.g. @next/) — merge children individually
      # so multiple .pnpm entries with different @scope children combine.
      mkdir -p "$STANDALONE_NM/$name"
      for child in "$pkg"/*; do
        [ -e "$child" ] || continue
        child_name="$(basename "$child")"
        [ -e "$STANDALONE_NM/$name/$child_name" ] || cp -r "$child" "$STANDALONE_NM/$name/$child_name"
      done
    else
      # Regular package — copy if not already present.
      [ -e "$STANDALONE_NM/$name" ] || cp -r "$pkg" "$STANDALONE_NM/$name"
    fi
  done
done

# Remove .pnpm to avoid double-shipping files in the npm tarball.
rm -rf "$STANDALONE_NM/.pnpm"

echo "[standalone-hoist] done"

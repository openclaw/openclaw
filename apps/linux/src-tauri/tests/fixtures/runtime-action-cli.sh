#!/bin/sh
case "$0" in
  */tools/node/bin/node) root=${0%/tools/node/bin/node} ;;
  */bin/openclaw) root=${0%/bin/openclaw} ;;
  */operator-cli) root=${0%/operator-cli} ;;
  */bun) root=${0%/bun} ;;
  *) printf 'unexpected fixture launcher\n' >&2; exit 8 ;;
esac
printf '%s\n' "$0" >> "$root/executables"
case "$*" in
  *--version*) printf 'OpenClaw 2026.10.1\n' ;;
  *'gateway status'*)
    /bin/cat "$root/state.json"
    if test -f "$root/next.json"; then /bin/mv "$root/next.json" "$root/state.json"; fi ;;
  *'gateway install'*)
    printf 'install\n' >> "$root/calls"
    printf '%s\n' "$@" > "$root/args"
    if test -f "$root/reject"; then printf 'changed pin or definition\n' >&2; exit 1; fi
    /bin/cp "$root/healthy.json" "$root/state.json"
    if test -f "$root/replacement-launcher"; then
      replacement=$(mktemp "$root/launcher.XXXXXX") || exit 1
      if ! /bin/cp "$root/replacement-launcher" "$replacement" ||
        ! chmod 700 "$replacement" || ! /bin/mv -f "$replacement" "$root/bin/openclaw"; then
        /bin/rm -f "$replacement"
        exit 1
      fi
    fi
    printf '{"ok":true}\n' ;;
  *) printf 'unexpected command\n' >&2; exit 8 ;;
esac

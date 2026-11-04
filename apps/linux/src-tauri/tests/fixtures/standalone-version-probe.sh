#!/bin/sh
[ "$HOME" = "$OPENCLAW_STATE_DIR" ] || exit 1
[ "$HOME" = "$TMPDIR" ] || exit 2
[ "$HOME" = "$TMP" ] || exit 3
[ "$HOME" = "$TEMP" ] || exit 4
[ "$OPENCLAW_CONFIG_PATH" = "$HOME/openclaw.json" ] || exit 5
[ -z "${CODEX_HOME-}" ] || exit 6
[ "$#" = 1 ] && [ "$1" = --version ] || exit 7
printf 'synthetic probe\n' > "$HOME/probe-ran"
printf 'OpenClaw 2026.10.1\n'

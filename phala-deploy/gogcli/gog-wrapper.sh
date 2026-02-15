#!/usr/bin/env bash
_GOG_ENV="${HOME}/.config/clawdi/gmail.env"
if [ -f "$_GOG_ENV" ]; then
  set -a
  . "$_GOG_ENV"
  set +a
fi
unset _GOG_ENV
exec /usr/local/bin/gog-bin "$@"

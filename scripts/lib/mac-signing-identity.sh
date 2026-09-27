#!/bin/bash
# Shared by app and distribution packaging so both sign with one selected identity.
ELEVATION_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"

select_identity() {
  local identities selected

  # `security` can return nonzero while still printing usable identities. Parse
  # its complete output once, but reject rows carrying a Keychain status suffix
  # such as `(CSSMERR_TP_NOT_TRUSTED)` after the quoted identity.
  identities="$(security find-identity -p codesigning -v 2>/dev/null)" || true
  selected="$(printf '%s\n' "$identities" | awk -F'\"' '
    NF >= 3 && $2 != "" && $3 ~ /^[[:space:]]*$/ {
      rank = 4
      if ($2 ~ /Developer ID Application/) rank = 1
      else if ($2 ~ /Apple Distribution/) rank = 2
      else if ($2 ~ /Apple Development/) rank = 3
      if (!(rank in first)) first[rank] = $2
    }
    END {
      for (rank = 1; rank <= 4; rank++) {
        if (rank in first) {
          print first[rank]
          exit
        }
      }
    }
  ')"
  if [ -z "$selected" ]; then
    return 1
  fi
  printf '%s\n' "$selected"
}

resolve_mac_signing_identity() {
  local IDENTITY="${SIGN_IDENTITY:-}"
  if [[ "${OPENCLAW_MAC_SIGNING_VARIANT:-standard}" == "elevation-host" && -z "$IDENTITY" ]]; then
    IDENTITY="$ELEVATION_IDENTITY"
  fi
  if [ -z "$IDENTITY" ]; then
    if ! IDENTITY="$(select_identity)"; then
      if [[ "${ALLOW_ADHOC_SIGNING:-}" == "1" ]]; then
        echo "WARN: No signing identity found. Falling back to ad-hoc signing (-)." >&2
        echo "      !!! WARNING: Ad-hoc signed apps do NOT persist TCC permissions (Accessibility, etc) !!!" >&2
        echo "      !!! You will need to re-grant permissions every time you restart the app.         !!!" >&2
        IDENTITY="-"
      else
        echo "ERROR: No signing identity found. Set SIGN_IDENTITY to a valid codesigning certificate." >&2
        echo "       Alternatively, set ALLOW_ADHOC_SIGNING=1 to fallback to ad-hoc signing (limitations apply)." >&2
        exit 1
      fi
    fi
  fi
  printf '%s\n' "$IDENTITY"
}

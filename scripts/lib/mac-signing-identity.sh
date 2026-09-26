#!/bin/bash
# Shared by app and distribution packaging so both sign with one selected identity.
ELEVATION_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)"

select_identity() {
  local preferred available first

  # Prefer a Developer ID Application cert.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Developer ID Application/ { print $2; exit }')"

  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Next, try Apple Distribution.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Apple Distribution/ { print $2; exit }')"
  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Then, try Apple Development.
  preferred="$(security find-identity -p codesigning -v 2>/dev/null \
    | awk -F'\"' '/Apple Development/ { print $2; exit }')"
  if [ -n "$preferred" ]; then
    echo "$preferred"
    return
  fi

  # Fallback to the first valid signing identity.
  available="$(security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*\"\\(.*\\)\"/\\1/p')"

  if [ -n "$available" ]; then
    first="$(printf '%s\n' "$available" | head -n1)"
    echo "$first"
    return
  fi

  return 1
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

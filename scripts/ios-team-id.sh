#!/usr/bin/env bash
set -euo pipefail

team_id="$(defaults read com.apple.dt.Xcode IDEProvisioningTeamIdentifiers 2>/dev/null | grep -Eo '[A-Z0-9]{10}' | head -n1 || true)"

if [[ -z "$team_id" ]]; then
  team_id="$(security find-identity -p codesigning -v 2>/dev/null | grep -Eo '\\([A-Z0-9]{10}\\)' | head -n1 | tr -d '()' || true)"
fi

if [[ -z "$team_id" ]]; then
  echo "No Apple Team ID found. Open Xcode or install signing certificates first." >&2
  exit 1
fi

echo "$team_id"

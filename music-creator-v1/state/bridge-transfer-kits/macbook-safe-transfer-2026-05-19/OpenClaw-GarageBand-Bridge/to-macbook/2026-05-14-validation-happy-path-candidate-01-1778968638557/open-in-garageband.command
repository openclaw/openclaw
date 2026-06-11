#!/bin/zsh
set -euo pipefail

JOB_DIR="${0:A:h}"
BRIDGE_ROOT="${JOB_DIR:h:h}"
AUDIO_FILE="${JOB_DIR}/audio/candidate-01.wav"
STATUS_DIR="${BRIDGE_ROOT}/from-macbook/2026-05-14-validation-happy-path-candidate-01-1778968638557"
STATUS_FILE="${STATUS_DIR}/imported.json"

mkdir -p "${STATUS_DIR}"
osascript "${JOB_DIR}/import-to-garageband.applescript" "${AUDIO_FILE}"

cat > "${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "jobId": "2026-05-14-validation-happy-path-candidate-01-1778968638557",
  "status": "opened_for_garageband_import",
  "audioFile": "${AUDIO_FILE}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nextAction": "Edit in GarageBand, then bounce/export WAV/AIFF/MP3 into this folder."
}
JSON

open "${STATUS_DIR}"
echo "GarageBand bridge status written to ${STATUS_FILE}"

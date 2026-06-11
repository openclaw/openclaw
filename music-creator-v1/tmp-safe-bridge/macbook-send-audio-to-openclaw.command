#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="${0:A:h}"
SOURCE_FILE="$(osascript -e 'POSIX path of (choose file with prompt "Choose a GarageBand bounce, stem, source song, or vocal audio file to send to OpenClaw")')"
KIND="$(osascript -e 'set choices to {"song", "stem", "vocal", "reference"}' -e 'set picked to choose from list choices with prompt "What kind of audio is this?" default items {"song"}' -e 'if picked is false then error number -128' -e 'item 1 of picked')"
DIRECTION="$(osascript -e 'text returned of (display dialog "What should OpenClaw add or do with this audio?" default answer "Add original vocals and complementary musical ideas.")')"
INBOX_ID="$(date -u +"%Y%m%dT%H%M%SZ")-${KIND}"
DEST_DIR="${BRIDGE_ROOT}/from-macbook/inbox/${INBOX_ID}"
AUDIO_DIR="${DEST_DIR}/audio"

mkdir -p "${AUDIO_DIR}"
cp "${SOURCE_FILE}" "${AUDIO_DIR}/${SOURCE_FILE:t}"
printf "%s\n" "${DIRECTION}" > "${DEST_DIR}/direction.txt"
cat > "${DEST_DIR}/request.json" <<JSON
{
  "schemaVersion": 1,
  "inboxId": "${INBOX_ID}",
  "kind": "${KIND}",
  "audioDirectory": "audio",
  "status": "sent_to_openclaw",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nextAction": "On Mac Studio, run bridge-import-garageband, then vocal-plan or bridge-export."
}
JSON

open "${DEST_DIR}"
echo "Sent GarageBand audio to OpenClaw inbox: ${INBOX_ID}"

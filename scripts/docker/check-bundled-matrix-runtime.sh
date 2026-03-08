#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${1:-}"
if [[ -z "$IMAGE_NAME" ]]; then
  echo "usage: $0 <docker-image>" >&2
  exit 64
fi

docker run --rm --entrypoint bash "$IMAGE_NAME" -lc '
  set -euo pipefail

  node -e "const { createRequire } = require(\"node:module\"); const req = createRequire(\"/app/extensions/matrix/src/matrix/deps.ts\"); console.log(req.resolve(\"@vector-im/matrix-bot-sdk\")); req(\"@vector-im/matrix-bot-sdk\"); console.log(req.resolve(\"@matrix-org/matrix-sdk-crypto-nodejs\")); req(\"@matrix-org/matrix-sdk-crypto-nodejs\");"
'

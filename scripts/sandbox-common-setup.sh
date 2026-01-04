#!/usr/bin/env bash
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-clawdis-sandbox:bookworm-slim}"
TARGET_IMAGE="${TARGET_IMAGE:-clawdis-sandbox-common:bookworm-slim}"
PACKAGES="${PACKAGES:-curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo}"
INSTALL_PNPM="${INSTALL_PNPM:-1}"
INSTALL_BUN="${INSTALL_BUN:-1}"
BUN_INSTALL_DIR="${BUN_INSTALL_DIR:-/opt/bun}"

if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  echo "Base image missing: ${BASE_IMAGE}"
  echo "Building base image via scripts/sandbox-setup.sh..."
  scripts/sandbox-setup.sh
fi

echo "Building ${TARGET_IMAGE} with: ${PACKAGES}"

docker build \
  -t "${TARGET_IMAGE}" \
  --build-arg INSTALL_PNPM="${INSTALL_PNPM}" \
  --build-arg INSTALL_BUN="${INSTALL_BUN}" \
  --build-arg BUN_INSTALL_DIR="${BUN_INSTALL_DIR}" \
  - <<EOF
FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
ARG INSTALL_PNPM=1
ARG INSTALL_BUN=1
ARG BUN_INSTALL_DIR=/opt/bun
ENV BUN_INSTALL=\${BUN_INSTALL_DIR}
ENV PATH="\${BUN_INSTALL_DIR}/bin:\${PATH}"
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ${PACKAGES} \\
  && rm -rf /var/lib/apt/lists/*
RUN if [ "\${INSTALL_PNPM}" = "1" ]; then npm install -g pnpm; fi
RUN if [ "\${INSTALL_BUN}" = "1" ]; then \\
  curl -fsSL https://bun.sh/install | bash; \\
  ln -sf "\${BUN_INSTALL_DIR}/bin/bun" /usr/local/bin/bun; \\
fi
EOF

cat <<NOTE
Built ${TARGET_IMAGE}.
To use it, set agent.sandbox.docker.image to "${TARGET_IMAGE}" and restart.
If you want a clean re-create, remove old sandbox containers:
  docker rm -f \$(docker ps -aq --filter label=clawdis.sandbox=1)
NOTE

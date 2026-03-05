#!/usr/bin/env bash

set -euo pipefail

IMAGE_URI="${1:?usage: verify-ecr-runtime-image.sh <image-uri>}"
REQUIRED_BINS=(
  aws
  jq
  gh
  git
  kubectl
  helm
  vault
  boundary
  argocd
  openclaw
)

CHECK_SCRIPT='
set -euo pipefail

for bin in "$@"; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing binary: $bin" >&2
    exit 1
  fi
done

aws --version >/dev/null 2>&1
jq --version >/dev/null
git --version >/dev/null
gh --version >/dev/null
kubectl version --client=true --output=yaml >/dev/null
helm version --short >/dev/null
vault --version >/dev/null
boundary version >/dev/null
argocd version --client >/dev/null
openclaw --help >/dev/null
'

docker run \
  --rm \
  --platform linux/amd64 \
  --entrypoint /bin/bash \
  "$IMAGE_URI" \
  -lc "$CHECK_SCRIPT" \
  -- "${REQUIRED_BINS[@]}"

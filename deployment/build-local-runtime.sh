#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_DIR="${SCRIPT_DIR}/bin/runtime"
BIN_DIR="${SCRIPT_DIR}/bin"

cd "${REPO_ROOT}"

echo "[build] compiling current repository..."
pnpm build
echo "[build] building Control UI assets..."
pnpm ui:build

echo "[build] staging runtime into deployment/bin/runtime..."
rm -rf "${RUNTIME_DIR}"
mkdir -p "${RUNTIME_DIR}"

cp "${REPO_ROOT}/openclaw.mjs" "${RUNTIME_DIR}/openclaw.mjs"
cp -R "${REPO_ROOT}/dist" "${RUNTIME_DIR}/dist"
cp "${REPO_ROOT}/package.json" "${RUNTIME_DIR}/package.json"
mkdir -p "${RUNTIME_DIR}/docs/reference"
cp -R "${REPO_ROOT}/docs/reference/templates" "${RUNTIME_DIR}/docs/reference/templates"
if [[ -f "${REPO_ROOT}/pnpm-lock.yaml" ]]; then
  cp "${REPO_ROOT}/pnpm-lock.yaml" "${RUNTIME_DIR}/pnpm-lock.yaml"
fi

if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "[error] missing node_modules at repo root" >&2
  echo "[hint] run: pnpm install" >&2
  exit 1
fi

echo "[build] bundling runtime dependencies into deployment/bin/runtime/node_modules..."
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "${REPO_ROOT}/node_modules/" "${RUNTIME_DIR}/node_modules/"
else
  cp -R "${REPO_ROOT}/node_modules" "${RUNTIME_DIR}/node_modules"
fi

if command -v node >/dev/null 2>&1; then
  OS_RAW="$(uname -s)"
  ARCH_RAW="$(uname -m)"
  case "${OS_RAW}" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    *)
      OS=""
      ;;
  esac
  case "${ARCH_RAW}" in
    x86_64 | amd64) ARCH="x86_64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      ARCH=""
      ;;
  esac
  if [[ -n "${OS}" && -n "${ARCH}" ]]; then
    TARGET_NODE="${BIN_DIR}/node-${OS}-${ARCH}"
    cp "$(command -v node)" "${TARGET_NODE}"
    chmod +x "${TARGET_NODE}"
    echo "[build] bundled node: ${TARGET_NODE}"
  fi
fi

echo "[build] done: ${RUNTIME_DIR}"

#!/usr/bin/env bash
# Install the pinned OpenGrep release asset without executing the upstream
# installer script. The upstream installer currently validates versions through
# a grep -q pipeline that can false-fail under pipefail on CI runners.

set -euo pipefail

VERSION="${OPENGREP_VERSION:-v1.19.0}"
PREFIX="${OPENGREP_PREFIX:-$HOME/.opengrep/cli}"
INST="${PREFIX}/${VERSION}"
LATEST="${PREFIX}/latest"

OS="${OS:-$(uname -s)}"
ARCH="${ARCH:-$(uname -m)}"

DIST=""
case "$OS:$ARCH" in
  Linux:x86_64 | Linux:amd64)
    if ldd /bin/sh 2>&1 | grep -qi musl; then
      DIST="opengrep_musllinux_x86"
    else
      DIST="opengrep_manylinux_x86"
    fi
    ;;
  Linux:aarch64 | Linux:arm64)
    if ldd /bin/sh 2>&1 | grep -qi musl; then
      DIST="opengrep_musllinux_aarch64"
    else
      DIST="opengrep_manylinux_aarch64"
    fi
    ;;
  Darwin:x86_64 | Darwin:amd64)
    DIST="opengrep_osx_x86"
    ;;
  Darwin:aarch64 | Darwin:arm64)
    DIST="opengrep_osx_arm64"
    ;;
esac

if [[ -z "$DIST" ]]; then
  echo "error: unsupported platform ${OS}/${ARCH}" >&2
  exit 1
fi

mkdir -p "$INST"
curl --fail --show-error --location --retry 3 --retry-delay 2 \
  "https://github.com/opengrep/opengrep/releases/download/${VERSION}/${DIST}" \
  --output "${INST}/opengrep"
chmod a+x "${INST}/opengrep"

INSTALLED_VERSION="$("${INST}/opengrep" --version | awk '{print $NF}')"
if [[ "$INSTALLED_VERSION" != "${VERSION#v}" ]]; then
  echo "error: expected OpenGrep ${VERSION#v}, got ${INSTALLED_VERSION}" >&2
  exit 1
fi

rm -f "$LATEST"
ln -s "$INST" "$LATEST"

echo "Installed OpenGrep ${VERSION} at ${INST}/opengrep"

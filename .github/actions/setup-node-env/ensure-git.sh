#!/usr/bin/env bash
set -euo pipefail

if git --no-lazy-fetch --version >/dev/null 2>&1; then
  git --version
  exit 0
fi

git --version || true
if ! grep -Eq '^ID=("ubuntu"|ubuntu)$' /etc/os-release; then
  echo "::error::CI requires Git 2.45 or newer with --no-lazy-fetch support. Provision this runner before retrying." >&2
  exit 1
fi

# Preserve capable images; only Ubuntu runners missing the guard need an upgrade.
# The Git project recommends this PPA: https://git-scm.com/install/linux
install_command=(env DEBIAN_FRONTEND=noninteractive)
if [[ "$(id -u)" != 0 ]]; then
  install_command=(sudo -n "${install_command[@]}")
fi
apt_options=(-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=0 -o DPkg::Lock::Timeout=30)
if ! command -v add-apt-repository >/dev/null 2>&1; then
  timeout --signal=TERM --kill-after=5s 120s "${install_command[@]}" \
    apt-get "${apt_options[@]}" update
  timeout --signal=TERM --kill-after=5s 120s "${install_command[@]}" \
    apt-get "${apt_options[@]}" install -y --no-install-recommends software-properties-common
fi
timeout --signal=TERM --kill-after=5s 120s "${install_command[@]}" \
  add-apt-repository --yes --no-update ppa:git-core/ppa
timeout --signal=TERM --kill-after=5s 120s "${install_command[@]}" \
  apt-get "${apt_options[@]}" update
timeout --signal=TERM --kill-after=5s 120s "${install_command[@]}" \
  apt-get "${apt_options[@]}" install -y --no-install-recommends git

git --version
if ! git --no-lazy-fetch --version >/dev/null 2>&1; then
  echo "::error::Git upgrade did not provide --no-lazy-fetch support (Git 2.45 or newer required)." >&2
  exit 1
fi

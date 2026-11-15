#!/usr/bin/env bash
set -euo pipefail

if git --no-lazy-fetch --version >/dev/null 2>&1; then
  git --version
  exit 0
fi

git --version || true
os_release=/etc/os-release
if ! grep -Eq '^ID=("ubuntu"|ubuntu)$' "$os_release"; then
  echo "::error::CI requires Git 2.45 or newer with --no-lazy-fetch support. Provision this runner before retrying." >&2
  exit 1
fi

codename=$( . "$os_release"; printf '%s' "${VERSION_CODENAME:-}" )
if [[ ! "$codename" =~ ^[a-z]+$ ]]; then
  echo "::error::Ubuntu VERSION_CODENAME is missing or invalid; cannot configure the Git PPA." >&2
  exit 1
fi

# Preserve capable images; only Ubuntu runners missing the guard need an upgrade.
# The Git project recommends this PPA: https://git-scm.com/install/linux
install_command=(env DEBIAN_FRONTEND=noninteractive)
if [[ "$(id -u)" != 0 ]]; then
  install_command=(sudo -n "${install_command[@]}")
fi
# Avoid add-apt-repository's Launchpad API discovery. Trust only the documented
# Git PPA signing key F911AB184317630C59970973E363C90F8F1B6217.
key='-----BEGIN PGP PUBLIC KEY BLOCK-----
Comment: Hostname:
Version: Hockeypuck 2.2

xsFNBGYo2OYBEADVRjI+o29u9izslaVr0Xqj8hpmo/2su/Iey1PgoS6A3hMxR4R4
eZ3u9dRh/gRHXNjxqRMfKj88G6ciqa/7ty8Vfc1eKl3z7yjL1pWOEzcGLKaSB8qd
MmsxCw31nFNEbzlymgK0+KPubQ5OrIzeSikpfDVGT4HLgO42ppGY+cVy2/bbNv6O
mmPXcw8gkxRCWFiGAO5jJYG1SyGbhr9Krbf6o+LDUJeDYPTQRMf702IYZ8Bp00ix
HyK2YOUNM14rr7092o2dw9GKxnJszF4cET+LxRddrREuB3sBlAZav/I0hZtQsKZ3
QTvpStf2MwIy8Ymj94+BsZaktP0d36wigGn8RWJHrhSVyjujS8YxWRWdjrLUI1ra
42pyIYZi39IXtsTM71rihQVrsEHbMQ7a5HGRK6eYyHVPrtsXXykNqhVPekLNiFWm
IekoSH1EwMsQv8y+k3nkCwTCkTHJaueB7awee0Zs5QBwbCm+qPyqCXoVDLEwdQOr
CHKAfNADtsFQsk/yiTC/+Lmtur/okp38VpJWXg8DphHFjd1KwqQ5E9qZi+tXs/JD
UXd93VBUdoGGaHK9fj/URxUBOVopGaOXGVYtGFWPn9q8MaNcrESZ48sXDfsVgUVD
RJ4puKLHjIUtDlCnMQO6lekIhEo4sxtbDnwIUmQp7B9l+U99u+uzBI96cQARAQAB
zShMYXVuY2hwYWQgUFBBIGZvciBVYnVudHUgR2l0IE1haW50YWluZXJzwsGOBBMB
CgA4FiEE+RGrGEMXYwxZlwlz42PJD48bYhcFAmYo2OYCGwMFCwkIBwIGFQoJCAsC
BBYCAwECHgECF4AACgkQ42PJD48bYhdwUQ//UFR3i/6zpizJMTA9mpz7hGC9IJV8
UDoWoaVgl+OR1Ldfz+jvr3K55LZyIMU1o6bbLqbEnoWa2VpRv2za/SCbPqo1igio
p97EJ2irGytFOhCDd+o3s0djfsXpA7jygAK6COnMx3ejnPhaBA194HbYDhp7KA5b
gZcqvYeRN1qk9QL99voFYeUWAPnqkLLrNuAcq9qTotmyYZQI61rdAH8P4odgMtU7
UiS4yLirkAiNCqT+TK07EXvaWSXcqZhgt1HmP+BZhrx/vLT4FlH52CCjamQWeFA2
mLKX/RSx/JTux1UDroX6L9JdUyMzOrLk22Zz9Tb3FK2ysHy72jRKmUv87ctIMcgD
u8BY3Mfe/Rw8vPMuBEaAsVfvWl7uYSt81dzjkxtt6ZvIFF5PBR2IhFJVosDbpSnk
g9/b22Ipjta3ULW8oOaNZjdcRNQ5StpApzZIUoZoP83ZWafwQoSrW7Rz3KvwYAdL
d3OAfuiW9i7YdLCkvaujBt6KA4tn56fcsp14FzLZrgcj+7XUpW4/yEJFHCCu5f2l
NWvN37suUTfzbMLZVS6rC1s3qrjOD+C3dvL/dCUlcTfrrsTcs/UnaVXFq0V6NLhA
ZZxOIVUedn7nGKbaecwTt6taIjpxj0jCBxWy6RcysIkv2xluRcl2UY+HapB8x1Dx
8giHUSvkXHr4c7I=
=uGON
-----END PGP PUBLIC KEY BLOCK-----'
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
printf '%s\n' "$key" > "$workdir/git-core-ppa.asc"
printf 'deb [signed-by=/etc/apt/keyrings/openclaw-git-core-ppa.asc] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu %s main\n' "$codename" > "$workdir/git-core-ppa.list"
"${install_command[@]}" install -d -o root -g root -m 0755 /etc/apt/keyrings
"${install_command[@]}" install -o root -g root -m 0644 "$workdir/git-core-ppa.asc" /etc/apt/keyrings/openclaw-git-core-ppa.asc
"${install_command[@]}" install -o root -g root -m 0644 "$workdir/git-core-ppa.list" /etc/apt/sources.list.d/openclaw-git-core-ppa.list
apt_options=(-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=0 -o DPkg::Lock::Timeout=30)
timeout --signal=TERM --kill-after=5s 120s "${install_command[@]}" \
  apt-get "${apt_options[@]}" update
# Fresh processes tolerate transient mirrors without enabling the native APT
# retries affected by CVE-2026-109518. All attempts share the existing deadline.
timeout --signal=TERM --kill-after=5s 120s bash -c '
  for attempt in 1 2 3; do
    if "$@"; then exit 0; else status=$?; fi
    if (( attempt == 3 )); then exit "$status"; fi
    echo "Git package install failed ($status); retrying after 2s." >&2
    sleep 2
  done
' -- "${install_command[@]}" apt-get "${apt_options[@]}" install -y --no-install-recommends git

git --version
if ! git --no-lazy-fetch --version >/dev/null 2>&1; then
  echo "::error::Git upgrade did not provide --no-lazy-fetch support (Git 2.45 or newer required)." >&2
  exit 1
fi

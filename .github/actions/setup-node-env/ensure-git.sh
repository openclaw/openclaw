#!/usr/bin/env bash
set -euo pipefail

if git --no-lazy-fetch --version >/dev/null 2>&1; then
  git --version
  exit 0
fi

git --version || true
os=$( . /etc/os-release; printf '%s/%s' "${ID:-}" "${VERSION_CODENAME:-}" )
if [[ "$os" != ubuntu/noble ]]; then
  echo "::error::CI requires Git 2.45 or newer with --no-lazy-fetch support. Provision this runner before retrying." >&2
  exit 1
fi

# Debian stable Git uses the same runtime library requirements as Noble's stock
# Git. Extract only; do not install packages, run maintainer scripts, or use apt.
version=2.47.3-0+deb13u1
case "${RUNNER_ARCH:-}" in
  X64)
    arch=amd64
    checksum=3e35662fd5c46add561703e54031a1d8ad9df45811927689f0a51122b13be722
    ;;
  ARM64)
    arch=arm64
    checksum=8c6b1e96b226211260d7814472215a8a1ed38ee37400c421d454391c1807cb5a
    ;;
  *) echo "::error::No pinned Git package for ${RUNNER_ARCH:-unknown architecture}. Provision Git 2.45 or newer on this runner." >&2; exit 1 ;;
esac

install_dir=$(mktemp -d "$RUNNER_TEMP/openclaw-git.XXXXXX")
trap 'rm -rf "$install_dir"' EXIT
package="pool/main/g/git/git_${version}_${arch}.deb"
archive="$install_dir/git.deb"
curl_options=(--fail --location --silent --show-error --connect-timeout 8 --max-time 25 --output "$archive")
# The snapshot retains exactly these bytes if the primary archive rotates the package out.
curl "${curl_options[@]}" "https://deb.debian.org/debian/$package" ||
  curl "${curl_options[@]}" "https://snapshot.debian.org/archive/debian/20250823T024047Z/$package"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --strict
dpkg-deb --extract "$archive" "$install_dir"
rm -- "$archive"

# Debian Git has an absolute default exec path. Keep external helpers (including
# HTTPS transport) matched to this binary rather than to the image's older Git.
mkdir "$install_dir/bin"
cat > "$install_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
package_usr=${0%/*}/../usr
export GIT_EXEC_PATH="$package_usr/lib/git-core"
exec "$package_usr/bin/git" "$@"
EOF
chmod +x "$install_dir/bin/git"
"$install_dir/bin/git" --no-lazy-fetch --version
printf '%s\n' "$install_dir/bin" >> "$GITHUB_PATH"
trap - EXIT

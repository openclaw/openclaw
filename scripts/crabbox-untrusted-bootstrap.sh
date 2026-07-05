#!/usr/bin/env bash
set -euo pipefail

node_version="24.15.0"
pnpm_spec="pnpm@11.2.2+sha512.36e6621fad506178936455e70247b8808ef4ec25797a9f437a93281a020484e2607f6a469a22e982987c3dbb8866e3071514ab10a4a1749e06edcd1ec118436f"

imds_token="$(
  /usr/bin/curl -fsS -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token
)"
iam_status="$(
  /usr/bin/curl -sS -o /dev/null -w "%{http_code}" \
    -H "X-aws-ec2-metadata-token: ${imds_token}" \
    http://169.254.169.254/latest/meta-data/iam/security-credentials/
)"
if [[ "$iam_status" != "404" ]]; then
  echo "refusing untrusted bootstrap: IAM credentials endpoint returned ${iam_status}" >&2
  exit 1
fi

case "$(/usr/bin/uname -m)" in
  x86_64) node_arch="x64" ;;
  aarch64 | arm64) node_arch="arm64" ;;
  *)
    echo "unsupported architecture: $(/usr/bin/uname -m)" >&2
    exit 2
    ;;
esac

archive="node-v${node_version}-linux-${node_arch}.tar.xz"
base_url="https://nodejs.org/dist/v${node_version}"
install_root="/opt/openclaw-untrusted-node-v${node_version}-${node_arch}"
corepack_home="/opt/openclaw-untrusted-corepack"
tmp_dir="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf -- "$tmp_dir"' EXIT

/usr/bin/curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 \
  -o "$tmp_dir/$archive" "$base_url/$archive"
/usr/bin/curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 \
  -o "$tmp_dir/SHASUMS256.txt" "$base_url/SHASUMS256.txt"
(
  cd "$tmp_dir"
  /usr/bin/grep "  ${archive}\$" SHASUMS256.txt | /usr/bin/sha256sum -c -
)

sudo /bin/rm -rf -- "$install_root" "$corepack_home"
sudo /usr/bin/mkdir -p "$install_root" "$corepack_home"
sudo /usr/bin/tar -xJf "$tmp_dir/$archive" -C "$install_root" --strip-components=1
sudo /usr/bin/env \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_HOME="$corepack_home" \
  PATH="$install_root/bin:/usr/bin:/bin" \
  "$install_root/bin/corepack" enable --install-directory "$install_root/bin"
sudo /usr/bin/env \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_HOME="$corepack_home" \
  PATH="$install_root/bin:/usr/bin:/bin" \
  "$install_root/bin/corepack" prepare "$pnpm_spec" --activate

for tool in node npm npx corepack pnpm pnpx; do
  if [[ -e "$install_root/bin/$tool" ]]; then
    sudo /usr/bin/ln -sfn "$install_root/bin/$tool" "/usr/local/bin/$tool"
  fi
done

/usr/local/bin/node --version
/usr/local/bin/pnpm --version
echo "untrusted Crabbox runtime bootstrap ready"

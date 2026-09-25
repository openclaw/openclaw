#!/usr/bin/env bash
set -euo pipefail

node_version="24.21.0"
pnpm_spec="pnpm@12.4.2+sha512.08adc6613180275c7c9edada39dcf08c9c61ad4e7eaf330a4f3461f102b0f907423454d117f98e72d47fef0616070644d7bffc973a6a57f5090a6d7c368b07c9"
# Keep exact formerly trusted pins so older contributor heads remain verifiable.
historical_pnpm_specs=(
  "pnpm@12.4.0+sha512.37536c26ed40ab4134b6511e09f6b27f3ebb45687468f2406ca3805279a4e5ca158c1931350ad9774d6ab2108d71b3dbaeb39943159294375e4d053e8e05685c"
  "pnpm@12.3.4+sha512.961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457"
  "pnpm@12.1.0+sha512.d9b8276d97f6ec86e49815877f91ee9f63cee61f2063b304e43b6dab8fa07ce8a9afd46d2facd39f921e6a9d06b3c75a81349c7b888c2d22886bae0229901037"
)

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <expected-head-sha> <command> [args...]" >&2
  exit 2
fi
expected_head_sha="$1"
shift
unset NODE_OPTIONS NODE_PATH COREPACK_NPM_REGISTRY COREPACK_INTEGRITY_KEYS COREPACK_ENV_FILE
export COREPACK_ENV_FILE=0

imds_token="$(
  /usr/bin/curl -fsS --connect-timeout 2 --max-time 5 -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" \
    http://169.254.169.254/latest/api/token
)"
iam_status="$(
  /usr/bin/curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w "%{http_code}" \
    -H "X-aws-ec2-metadata-token: ${imds_token}" \
    http://169.254.169.254/latest/meta-data/iam/security-credentials/
)"
if [[ "$iam_status" != "404" ]]; then
  echo "refusing untrusted bootstrap: IAM credentials endpoint returned ${iam_status}" >&2
  exit 1
fi

actual_head_sha="$(/usr/bin/git rev-parse HEAD)"
if [[ "$actual_head_sha" != "$expected_head_sha" ]]; then
  echo "refusing untrusted run: expected HEAD ${expected_head_sha}, got ${actual_head_sha}" >&2
  exit 1
fi

case "$(/usr/bin/uname -m)" in
  x86_64)
    node_arch="x64"
    node_sha256="fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
    ;;
  aarch64 | arm64)
    node_arch="arm64"
    node_sha256="6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2"
    ;;
  *)
    echo "unsupported architecture: $(/usr/bin/uname -m)" >&2
    exit 2
    ;;
esac

archive="node-v${node_version}-linux-${node_arch}.tar.xz"
base_url="https://nodejs.org/dist/v${node_version}"
install_root="/opt/openclaw-untrusted-node-v${node_version}-${node_arch}"
corepack_home="/opt/openclaw-untrusted-corepack"
archive_root="/opt/crabbox/toolchain-archives"
tmp_dir="$(/usr/bin/mktemp -d)"
run_home=""
# Invoked by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  /bin/rm -rf -- "$tmp_dir"
  if [[ -n "$run_home" ]]; then
    /bin/rm -rf -- "$run_home"
  fi
}
trap cleanup EXIT

verify_archive() {
  local name="$1" checksum="$2" algorithm="$3"
  printf '%s  %s\n' "$checksum" "$tmp_dir/$name" | "/usr/bin/sha${algorithm}sum" --check --status
}

copy_verified_archive() {
  local name="$1" checksum="$2" algorithm="$3"
  # Never verify a shared path and then extract it: authenticate the private copy.
  [[ -f "$archive_root/$name" ]] &&
    /bin/cp -- "$archive_root/$name" "$tmp_dir/$name" &&
    verify_archive "$name" "$checksum" "$algorithm"
}

if ! copy_verified_archive "$archive" "$node_sha256" 256; then
  /usr/bin/curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 \
    -o "$tmp_dir/$archive" "$base_url/$archive"
  if ! verify_archive "$archive" "$node_sha256" 256; then
    echo "refusing untrusted bootstrap: downloaded $archive differs from the trusted digest" >&2
    exit 1
  fi
fi

sudo /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash -s -- \
  "$install_root" "$tmp_dir/$archive" <<'INSTALL_NODE'
set -euo pipefail
umask 022
install_root="$1"
archive_path="$2"
/bin/rm -rf -- "$install_root"
/usr/bin/mkdir -p "$install_root"
/usr/bin/tar -xJf "$archive_path" -C "$install_root" --strip-components=1
INSTALL_NODE

candidate_package_json="$PWD/package.json"
pnpm_spec="$(
  cd "$install_root"
  "$install_root/bin/node" - "$candidate_package_json" "$pnpm_spec" "${historical_pnpm_specs[@]}" <<'PACKAGE_MANAGER'
const fs = require("node:fs");
const [file, ...approvedPins] = process.argv.slice(2);
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.error("refusing untrusted run: invalid package.json");
  process.exit(1);
}
if (!approvedPins.includes(pkg?.packageManager)) {
  console.error("refusing untrusted run: packageManager pin differs from trusted main or approved history");
  process.exit(1);
}
process.stdout.write(pkg.packageManager);
PACKAGE_MANAGER
)"

pnpm_version="${pnpm_spec#pnpm@}"
pnpm_version="${pnpm_version%%+*}"
pnpm_native_sha512=""
case "$pnpm_version:$node_arch" in
  12.4.2:x64)
    pnpm_native_sha512="fe96edd145536bc34c0e1cce58b4117d9e86f5138a5e524f66dc7ce3906ac967dcee10ab5978532c177bd323b6cbcf84f8858dde81ccd6cfc9b0840d1a4d72be"
    ;;
  12.4.2:arm64)
    pnpm_native_sha512="d9d4a20d7ca1c7e4531ec7b0c5ec7c7ff8d58ea417589da8a30e240951c459d64a781a60331bd9e9f1e44c050125782a85b2880c7bee3656413fb8097d458be4"
    ;;
esac
pnpm_archive="pnpm-${pnpm_version}.tgz"
pnpm_native_archive="exe.linux-${node_arch}-${pnpm_version}.tgz"
pnpm_seed=""
if [[ -n "$pnpm_native_sha512" ]] &&
  copy_verified_archive "$pnpm_archive" "${pnpm_spec##*+sha512.}" 512 &&
  copy_verified_archive "$pnpm_native_archive" "$pnpm_native_sha512" 512; then
  pnpm_seed="$tmp_dir"
fi

# Only public toolchain artifacts need shared access; keep caller state private.
sudo /usr/bin/env -i PATH=/usr/bin:/bin /bin/bash -s -- \
  "$install_root" "$corepack_home" "$pnpm_spec" "$pnpm_seed" "$node_arch" <<'INSTALL'
set -euo pipefail
umask 022
install_root="$1"
corepack_home="$2"
pnpm_spec="$3"
pnpm_seed="$4"
node_arch="$5"
/bin/rm -rf -- "$corepack_home"
/usr/bin/mkdir -p "$corepack_home"
if [[ -n "$pnpm_seed" ]]; then
  pnpm_version="${pnpm_spec#pnpm@}"
  pnpm_version="${pnpm_version%%+*}"
  pnpm_root="$corepack_home/v1/pnpm/$pnpm_version"
  /usr/bin/mkdir -p "$pnpm_root"
  /usr/bin/tar -xzf "$pnpm_seed/pnpm-${pnpm_version}.tgz" -C "$pnpm_root" --strip-components=1
  native_root="$pnpm_root/node_modules/@pnpm/exe.linux-${node_arch}"
  /usr/bin/mkdir -p "$native_root"
  /usr/bin/tar -xzf "$pnpm_seed/exe.linux-${node_arch}-${pnpm_version}.tgz" \
    -C "$native_root" --strip-components=1
  # Corepack 0.35's v1 cache format, generated only from authenticated archives.
  "$install_root/bin/node" - "$pnpm_root/.corepack" "$pnpm_spec" <<'METADATA'
const fs = require("node:fs");
const [file, spec] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  locator: { name: "pnpm", reference: spec.slice("pnpm@".length) },
  bin: { pnpm: "./bin/pnpm.mjs", pnpx: "./bin/pnpx.mjs" },
  hash: spec.slice(spec.indexOf("+") + 1),
}));
METADATA
  export COREPACK_ENABLE_NETWORK=0
fi
# Corepack must select and warm the approved pin outside the untrusted checkout.
cd "$install_root"
/usr/bin/env \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_HOME="$corepack_home" \
  PATH="$install_root/bin:/usr/bin:/bin" \
  "$install_root/bin/corepack" enable --install-directory "$install_root/bin"
/usr/bin/env \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_HOME="$corepack_home" \
  PATH="$install_root/bin:/usr/bin:/bin" \
  "$install_root/bin/corepack" prepare "$pnpm_spec" --activate
/usr/bin/env \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  COREPACK_HOME="$corepack_home" \
  PATH="$install_root/bin:/usr/bin:/bin" \
  "$install_root/bin/corepack" "$pnpm_spec" --version
INSTALL

for tool in node npm npx corepack pnpm pnpx; do
  if [[ -e "$install_root/bin/$tool" ]]; then
    sudo /usr/bin/ln -sfn "$install_root/bin/$tool" "/usr/local/bin/$tool"
  fi
done

/usr/local/bin/node --version

actual_package_manager="$(
  /usr/local/bin/node -e \
    'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); process.stdout.write(pkg.packageManager || "")'
)"
if [[ "$actual_package_manager" != "$pnpm_spec" ]]; then
  echo "refusing untrusted run: packageManager pin changed during bootstrap" >&2
  exit 1
fi

run_home="$(/usr/bin/mktemp -d)"
export HOME="$run_home"
export COREPACK_HOME="$corepack_home"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
/usr/local/bin/pnpm --version
/usr/local/bin/pnpm install --frozen-lockfile
command_status=0
"$@" || command_status=$?
exit "$command_status"

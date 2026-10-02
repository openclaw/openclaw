#!/bin/bash
set -euo pipefail

# Called after the canonical source build, before the app is signed. The npm
# artifact is only an installation source; the full published package is retained.
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="$1"
shift
[[ "$#" -gt 0 ]] || { echo "ERROR: No runtime architectures requested" >&2; exit 1; }
case "${OPENCLAW_MAC_SIGNING_VARIANT:-standard}" in
  standard|elevation-host) ;;
  *) echo "ERROR: Unknown Mac signing variant" >&2; exit 1 ;;
esac
# Scratch follows the caller's temp volume; only installed payloads need to
# share the destination volume so publishing remains a rename, not a copy.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-mac-runtime.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$(dirname "$DESTINATION")"
STAGE="$(cd "$(dirname "$DESTINATION")" && mktemp -d "$PWD/.openclaw-mac-runtime.XXXXXX")"
trap 'rm -rf "$STAGE" "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/home" "$SCRATCH/package"

# Lifecycle hooks must never see operator config, credentials, or state;
# installer main discovers launchd by UID even with a new HOME.
# Use the build's pinned pnpm packer, not the host npm's expanding file globs.
# Forward only its existing phase budgets; the packager owns defaults/validation.
TARBALL="$(env -i HOME="$SCRATCH/home" PATH="$PATH" TMPDIR="$SCRATCH" \
  OPENCLAW_DOCKER_PACKAGE_INVENTORY_TIMEOUT_MS="${OPENCLAW_DOCKER_PACKAGE_INVENTORY_TIMEOUT_MS:-}" \
  OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS="${OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS:-}" \
  OPENCLAW_DOCKER_PACKAGE_TARBALL_CHECK_TIMEOUT_MS="${OPENCLAW_DOCKER_PACKAGE_TARBALL_CHECK_TIMEOUT_MS:-}" \
  node "$ROOT_DIR/scripts/package-openclaw-for-docker.mjs" \
  --skip-build --pnpm-pack --allow-unreleased-changelog --output-dir "$SCRATCH/package" \
  --output-name openclaw.tgz)"
[[ -f "$TARBALL" ]] || { echo "ERROR: Canonical runtime package missing" >&2; exit 1; }

for arch in "$@"; do
  case "$arch" in arm64|x86_64) ;; *) echo "ERROR: Unsupported Mac runtime architecture: $arch" >&2; exit 1 ;; esac
done
# Node and npm exist only in scratch. npm selects optional packages for one CPU
# per install, even with --force. Lifecycle hooks also load native code, so each
# installation needs a matching build-time Node executable.
env -i HOME="$SCRATCH/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  TMPDIR="$SCRATCH" OPENCLAW_INSTALL_CLI_SH_NO_RUN=1 npm_config_os=darwin \
  OPENCLAW_NODE_VERSION="${OPENCLAW_NODE_VERSION:-}" \
  npm_config_omit=dev npm_config_include=optional \
  /bin/bash -c '
    set -euo pipefail
    source "$1/scripts/install-cli.sh"
    scratch="$2"
    OPENCLAW_VERSION="$3"
    stage="$4"
    tools_path="$PATH"
    shift 4
    for arch in "$@"; do
      PREFIX="$scratch/prefix-$arch"
      export npm_config_cpu="${arch/x86_64/x64}"
      install_node darwin "$npm_config_cpu"
      export PATH="$(node_dir)/bin:$tools_path"
      install_openclaw
      mkdir -p "$stage/installed-$arch/lib/node_modules"
      mv "$(node_dir)/lib/node_modules/openclaw" "$stage/installed-$arch/lib/node_modules/openclaw"
    done
  ' bash "$ROOT_DIR" "$SCRATCH" "$TARBALL" "$STAGE" "$@"

for arch in "$@"; do
node - "$STAGE/installed-$arch/lib/node_modules/openclaw" "$arch" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const archs = process.argv[3].split(" ").map(arch => arch === "x86_64" ? "x64" : arch);
function supports(values, target) {
  return !Array.isArray(values) || (!values.includes(`!${target}`) &&
    (!values.some(value => !value.startsWith("!")) || values.includes(target) || values.includes("any")));
}
function visit(dir, packageDirectory = false) {
  if (packageDirectory) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (!supports(pkg.os, "darwin") || !archs.some(arch => supports(pkg.cpu, arch))) {
        fs.rmSync(dir, { recursive: true }); return;
      }
      if (pkg.name === "npm") {
        // OpenClaw invokes npm-cli.js with Bun, never npm's Node shell shims.
        for (const command of ["npm", "npx"]) {
          for (const suffix of ["", ".cmd", ".ps1"]) {
            fs.rmSync(path.join(dir, "bin", command + suffix), { force: true });
          }
        }
      }
    }
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    // Executables are invoked explicitly with Bun. Do not retain npm's Node
    // shebang launchers, especially links to removed platform packages.
    const inModules = path.basename(dir) === "node_modules";
    if (inModules && entry.name === ".bin") { fs.rmSync(child, { recursive: true }); continue; }
    if (inModules && entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(child, { withFileTypes: true })) {
        if (scoped.isDirectory()) visit(path.join(child, scoped.name), true);
      }
    } else {
      visit(child, inModules);
    }
  }
}
visit(process.argv[2]);
JS

  runtime="$STAGE/runtime"
  [[ "$arch" = "$1" ]] || runtime="$STAGE/runtime-$arch"
  /usr/bin/python3 -B "$ROOT_DIR/scripts/materialize-mac-runtime.py" \
    "$STAGE/installed-$arch" "$runtime" "$STAGE" "$arch"
  if [[ "$runtime" != "$STAGE/runtime" ]]; then
    /usr/bin/python3 -B "$ROOT_DIR/scripts/materialize-mac-runtime.py" --merge "$runtime" "$STAGE/runtime"
  fi
done

cat > "$STAGE/runtime/lib/node_modules/openclaw/openclaw-install-owner.json" <<'JSON'
{"schemaVersion":1,"owner":"macos-app","displayName":"OpenClaw.app","updateHint":"Update OpenClaw.app to update this Gateway."}
JSON

/bin/bash "$ROOT_DIR/scripts/stage-openclaw-bun-macos.sh" "$STAGE/runtime" "$@"
sqlite_arch="$1"
[[ "$#" -eq 1 ]] || sqlite_arch=universal
/bin/bash "$ROOT_DIR/scripts/build-mac-sqlite.sh" "$sqlite_arch" "$STAGE/runtime"
# Execute after relocation so absolute wrappers or links cannot hide mistakes.
for arch in "$@"; do
  if /usr/bin/arch -"$arch" /usr/bin/true 2>/dev/null; then
    env -i HOME="$SCRATCH/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$SCRATCH" \
      OPENCLAW_SQLITE_LIBRARY="$STAGE/runtime/lib/libsqlite3.dylib" \
      /usr/bin/arch -"$arch" "$STAGE/runtime/bin/bun" "$ROOT_DIR/scripts/verify-mac-runtime.mjs" \
      "$STAGE/runtime" "$ROOT_DIR/dist/build-info.json"
  else
    echo "WARN: Runtime $arch verification skipped; install Rosetta to verify this architecture" >&2
  fi
done
[[ ! -e "$DESTINATION" && ! -L "$DESTINATION" ]] || { echo "ERROR: Runtime destination exists: $DESTINATION" >&2; exit 1; }
mv "$STAGE/runtime" "$DESTINATION"

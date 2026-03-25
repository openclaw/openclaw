#!/usr/bin/env bash

set -euo pipefail

# Bundle the current local OpenClaw build together with a minimal runtime
# profile so the target Mac installs THIS repository version instead of
# upstream openclaw@latest.

OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS_ROOT="${OPENCLAW_MAC_BUNDLE_OUTPUT_DIR:-${REPO_ROOT}/.artifacts/openclaw-mac-bundles}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_BASENAME="openclaw-mac-bundle-${TIMESTAMP}"
OUT_DIR="${ARTIFACTS_ROOT}/${OUT_BASENAME}"
OUT_TAR="${ARTIFACTS_ROOT}/${OUT_BASENAME}.tar.gz"
PACKAGE_DIR="${OUT_DIR}/packages"
LOCAL_PACKAGE_TGZ=""
LOCAL_PACKAGE_PATH=""

echo "Packing OpenClaw runtime profile from: ${OPENCLAW_HOME}"
echo "Using local repository: ${REPO_ROOT}"
echo "Writing bundle artifacts to: ${ARTIFACTS_ROOT}"

mkdir -p "${ARTIFACTS_ROOT}"
mkdir -p "${OUT_DIR}/.openclaw"
mkdir -p "${PACKAGE_DIR}"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -f "${src}" ]; then
    mkdir -p "$(dirname "${dst}")"
    cp "${src}" "${dst}"
    echo "  [profile] ${src} -> ${dst}"
  else
    echo "  [profile] skipped missing file: ${src}"
  fi
}

echo
echo "Building and packing local OpenClaw package..."
pushd "${REPO_ROOT}" >/dev/null
LOCAL_PACKAGE_TGZ="$(pnpm pack --pack-destination "${PACKAGE_DIR}" | tail -n 1 | tr -d '\r')"
popd >/dev/null

if [ -z "${LOCAL_PACKAGE_TGZ}" ]; then
  echo "Failed to produce local OpenClaw tarball" >&2
  exit 1
fi

if [[ "${LOCAL_PACKAGE_TGZ}" = /* ]]; then
  LOCAL_PACKAGE_PATH="${LOCAL_PACKAGE_TGZ}"
  LOCAL_PACKAGE_TGZ="$(basename "${LOCAL_PACKAGE_PATH}")"
else
  LOCAL_PACKAGE_PATH="${PACKAGE_DIR}/${LOCAL_PACKAGE_TGZ}"
fi

if [ ! -f "${LOCAL_PACKAGE_PATH}" ]; then
  echo "Failed to produce local OpenClaw tarball" >&2
  exit 1
fi

echo "  [package] ${LOCAL_PACKAGE_PATH}"

copy_if_exists "${OPENCLAW_HOME}/openclaw.json" "${OUT_DIR}/.openclaw/openclaw.json"
copy_if_exists "${OPENCLAW_HOME}/exec-approvals.json" "${OUT_DIR}/.openclaw/exec-approvals.json"
copy_if_exists "${OPENCLAW_HOME}/workspace/SOUL.md" "${OUT_DIR}/.openclaw/workspace/SOUL.md"

cat > "${OUT_DIR}/README-import.md" <<EOF
OpenClaw macOS runtime bundle
=============================

This bundle contains:

- packages/${LOCAL_PACKAGE_TGZ}
- .openclaw/openclaw.json
- .openclaw/exec-approvals.json
- .openclaw/workspace/SOUL.md

Important:

- Install the packaged local OpenClaw tarball from this bundle.
- Do NOT use \`npm install -g openclaw@latest\` on the target Mac, because the
  upstream package does not include the control-plane compatibility layer used
  by agent-bot-task-a.

To import on a target Mac:

1. Ensure Node.js (22.16+ or 24.x) is installed.

2. Extract this archive in your home directory:

   cd ~
   tar -xzf /path/to/${OUT_TAR}

3. Install THIS local OpenClaw build globally:

   npm install -g ~/${OUT_BASENAME}/packages/${LOCAL_PACKAGE_TGZ}

4. Restore the runtime profile:

   mkdir -p ~/.openclaw/workspace
   cp ~/${OUT_BASENAME}/.openclaw/openclaw.json ~/.openclaw/openclaw.json
   cp ~/${OUT_BASENAME}/.openclaw/exec-approvals.json ~/.openclaw/exec-approvals.json
   cp ~/${OUT_BASENAME}/.openclaw/workspace/SOUL.md ~/.openclaw/workspace/SOUL.md

5. Export the same bridge token used by the control plane:

   export OPENCLAW_BRIDGE_TOKEN=change-me
   export OPENCLAW_CONTROL_PLANE_STATE_FILE="\$HOME/.openclaw/control-plane-state.json"

6. Start the OpenClaw gateway:

   openclaw gateway --config ~/.openclaw/openclaw.json

7. Verify the compatibility routes:

   curl -i http://127.0.0.1:15661/__control-plane/runtime-context \\
     -H "x-openclaw-bridge-token: \$OPENCLAW_BRIDGE_TOKEN"

   curl -i -X POST http://127.0.0.1:15661/__control-plane/bootstrap \\
     -H "content-type: application/json" \\
     -H "x-openclaw-bridge-token: \$OPENCLAW_BRIDGE_TOKEN" \\
     -d '{}'

   curl -i -X POST http://127.0.0.1:15661/__control-plane/skills/snapshot/apply \\
     -H "content-type: application/json" \\
     -H "x-openclaw-bridge-token: \$OPENCLAW_BRIDGE_TOKEN" \\
     -d '{"snapshotId":"debug","packages":[]}'

Expected:

- runtime-context returns 200
- bootstrap no longer returns 404
- skills/snapshot/apply no longer returns 404
EOF

cat > "${OUT_DIR}/install-local-openclaw.sh" <<EOF
#!/usr/bin/env bash

set -euo pipefail

BUNDLE_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
PACKAGE_NAME="${LOCAL_PACKAGE_TGZ}"

mkdir -p "\$HOME/.openclaw/workspace"
npm install -g "\${BUNDLE_DIR}/packages/\${PACKAGE_NAME}"

if [ -f "\${BUNDLE_DIR}/.openclaw/openclaw.json" ]; then
  cp "\${BUNDLE_DIR}/.openclaw/openclaw.json" "\$HOME/.openclaw/openclaw.json"
fi
if [ -f "\${BUNDLE_DIR}/.openclaw/exec-approvals.json" ]; then
  cp "\${BUNDLE_DIR}/.openclaw/exec-approvals.json" "\$HOME/.openclaw/exec-approvals.json"
fi
if [ -f "\${BUNDLE_DIR}/.openclaw/workspace/SOUL.md" ]; then
  mkdir -p "\$HOME/.openclaw/workspace"
  cp "\${BUNDLE_DIR}/.openclaw/workspace/SOUL.md" "\$HOME/.openclaw/workspace/SOUL.md"
fi

echo "Installed local OpenClaw package: \${PACKAGE_NAME}"
echo "Next:"
echo "  export OPENCLAW_BRIDGE_TOKEN=<same token as control plane>"
echo "  export OPENCLAW_CONTROL_PLANE_STATE_FILE=\$HOME/.openclaw/control-plane-state.json"
echo "  openclaw gateway --config ~/.openclaw/openclaw.json"
EOF

chmod +x "${OUT_DIR}/install-local-openclaw.sh"

echo "Creating archive: ${OUT_TAR}"
tar -czf "${OUT_TAR}" -C "${ARTIFACTS_ROOT}" "${OUT_BASENAME}"

echo
echo "Done."
echo "Bundle path:"
echo "  ${OUT_TAR}"
echo
echo "Copy this archive to the target Mac, extract it, then follow README-import.md."

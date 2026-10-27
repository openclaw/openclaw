#!/usr/bin/env bash
set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
MODE="${1:?expected mode}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$HOME/.local/bin:$PATH"
mkdir -p "$OPENCLAW_STATE_DIR" "$XDG_CONFIG_HOME" "$HOME/.local/bin"
chmod 700 "$OPENCLAW_STATE_DIR" "$XDG_CONFIG_HOME"
echo '{}' >"$OPENCLAW_CONFIG_PATH"
openclaw_e2e_install_package /tmp/muse-install.log
node --input-type=module <<'NODE'
import fs from 'node:fs';
for (const name of ['muse', 'meta']) {
  const target = `/tmp/plugins/${name}`;
  fs.cpSync(`/candidate/${name}`, target, {recursive:true, filter: source => !source.split('/').includes('node_modules')});
  const file = `${target}/package.json`;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete manifest.devDependencies;
  fs.writeFileSync(file, JSON.stringify(manifest));
}
NODE
npm install --prefix /tmp/plugins/muse --omit=dev --ignore-scripts --no-audit --no-fund
# The candidate plugins are this checkout's sources, so the local-source trust prompt is expected.
openclaw_e2e_fixture_plugin_command openclaw -- plugins install --link --force /tmp/plugins/meta
openclaw_e2e_fixture_plugin_command openclaw -- plugins install --link --force /tmp/plugins/muse
if [ "$MODE" != live ]; then
  cat >"$HOME/.local/bin/muse" <<'BIN'
#!/usr/bin/env bash
exec node /tmp/plugins/muse/src/test-support/fake-muse.mjs "$@"
BIN
  chmod +x "$HOME/.local/bin/muse"
  touch "$MUSE_REQUEST_LOG"
else
  # Download the official installer without requiring curl in the shared bare image.
  node --input-type=module -e 'import fs from "node:fs"; const r=await fetch("https://dev.meta.ai/install.sh"); if(!r.ok) throw new Error(`Muse installer: ${r.status}`); fs.writeFileSync("/tmp/muse-install.sh", await r.text());'
  # The installer uses bash features (pipefail); Debian's sh is dash.
  bash /tmp/muse-install.sh
  node scripts/e2e/lib/muse-runtime/auth.mjs
fi

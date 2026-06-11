#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-"$HOME/.openclaw"}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PLUGIN_PATH="extensions/qqbot"
PLUGIN_ID=""
RESTART_GATEWAY=0

usage() {
  cat <<'EOF'
Usage: scripts/dev-plugin-local-runtime.sh [plugin-path] [--plugin-id <id>] [--restart-gateway]

Clean a local plugin dist directory, rebuild OpenClaw, rebuild that plugin's
runtime package, remove the stale npm package copy for the same package name,
inspect the active plugin source, and optionally restart the gateway.

This script does not uninstall plugins and does not edit openclaw.json. If the
plugin is not already linked/loaded from the local source path, it reports that
instead of changing config.

Defaults:
  plugin-path: extensions/qqbot

Environment:
  OPENCLAW_HOME          OpenClaw home directory. Defaults to ~/.openclaw.
  OPENCLAW_GATEWAY_PORT  Gateway port used with --restart-gateway. Defaults to 18789.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --restart-gateway)
      RESTART_GATEWAY=1
      shift
      ;;
    --plugin-id)
      if [[ "$#" -lt 2 ]]; then
        echo "--plugin-id requires a value" >&2
        exit 2
      fi
      PLUGIN_ID="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      PLUGIN_PATH="$1"
      shift
      ;;
  esac
done

cd "$ROOT"

plugin_dir="$(node - "$ROOT" "$PLUGIN_PATH" <<'NODE'
const path = require("node:path");

const root = process.argv[2];
const input = process.argv[3];
const resolved = path.resolve(root, input);
console.log(resolved);
NODE
)"

plugin_rel="$(node - "$ROOT" "$plugin_dir" <<'NODE'
const path = require("node:path");

const root = process.argv[2];
const pluginDir = process.argv[3];
const rel = path.relative(root, pluginDir);
if (rel.startsWith("..") || path.isAbsolute(rel)) {
  console.error(`plugin path must be inside repo: ${pluginDir}`);
  process.exit(2);
}
console.log(rel || ".");
NODE
)"

if [[ ! -f "$plugin_dir/package.json" ]]; then
  echo "plugin package.json not found: $plugin_rel/package.json" >&2
  exit 2
fi

plugin_meta="$(node - "$plugin_dir" "$PLUGIN_ID" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const pluginDir = process.argv[2];
const explicitId = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
let manifestId = "";
const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
if (fs.existsSync(manifestPath)) {
  manifestId = JSON.parse(fs.readFileSync(manifestPath, "utf8")).id || "";
}
const packageName = pkg.name || "";
const pluginId = explicitId || manifestId || packageName.replace(/^@[^/]+\//, "");
if (!packageName || !pluginId) {
  console.error("could not infer package name or plugin id; pass --plugin-id <id>");
  process.exit(2);
}
console.log(JSON.stringify({
  pluginId,
  packageName,
  packageVersion: pkg.version || "",
}));
NODE
)"

plugin_id="$(node -e 'const v=JSON.parse(process.argv[1]); console.log(v.pluginId)' "$plugin_meta")"
package_name="$(node -e 'const v=JSON.parse(process.argv[1]); console.log(v.packageName)' "$plugin_meta")"
package_version="$(node -e 'const v=JSON.parse(process.argv[1]); console.log(v.packageVersion)' "$plugin_meta")"

echo "[plugin-local] repo: $ROOT"
echo "[plugin-local] branch: $(git rev-parse --abbrev-ref HEAD)"
echo "[plugin-local] head: $(git rev-parse --short HEAD)"
echo "[plugin-local] plugin: $plugin_id ($package_name@$package_version)"
echo "[plugin-local] path: $plugin_rel"

plugin_dist="$plugin_dir/dist"
if [[ -e "$plugin_dist" || -L "$plugin_dist" ]]; then
  echo "[plugin-local] removing plugin dist: $plugin_rel/dist"
  rm -rf "$plugin_dist"
else
  echo "[plugin-local] plugin dist not present: $plugin_rel/dist"
fi

echo "[plugin-local] building OpenClaw"
pnpm build

echo "[plugin-local] building plugin package runtime"
node scripts/lib/plugin-npm-runtime-build.mjs "$plugin_rel"

npm_package_dir="$(node - "$OPENCLAW_HOME" "$package_name" <<'NODE'
const path = require("node:path");

const home = process.argv[2];
const packageName = process.argv[3];
console.log(path.join(home, "npm", "node_modules", ...packageName.split("/")));
NODE
)"

if [[ -e "$npm_package_dir" || -L "$npm_package_dir" ]]; then
  echo "[plugin-local] removing stale npm package copy for $package_name"
  rm -rf "$npm_package_dir"
else
  echo "[plugin-local] stale npm package copy not present for $package_name"
fi

echo "[plugin-local] refreshing plugin registry"
node dist/index.js plugins registry --refresh --json >/tmp/openclaw-plugin-local-registry.json

inspect_json="$(mktemp)"
trap 'rm -f "$inspect_json"' EXIT

echo "[plugin-local] inspecting canonical plugin source"
node dist/index.js plugins inspect "$plugin_id" --json >"$inspect_json"
node - "$inspect_json" "$plugin_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const raw = fs.readFileSync(process.argv[2], "utf8");
const expectedRoot = fs.realpathSync(process.argv[3]);
const jsonStart = raw.indexOf("{");
if (jsonStart < 0) {
  throw new Error(`plugins inspect did not print JSON:\n${raw}`);
}
const inspect = JSON.parse(raw.slice(jsonStart));
const rootDir = inspect.plugin?.rootDir ? fs.realpathSync(inspect.plugin.rootDir) : "";
const source = inspect.plugin?.source || "";
const local = rootDir === expectedRoot || source.startsWith(`${expectedRoot}${path.sep}`);
const summary = {
  pluginId: inspect.plugin?.id,
  source,
  rootDir: inspect.plugin?.rootDir,
  origin: inspect.plugin?.origin,
  status: inspect.plugin?.status,
  packageVersion: inspect.plugin?.version,
  activeLocalSource: local,
  installRecord: inspect.install,
};
console.log(JSON.stringify(summary, null, 2));
if (!local) {
  console.error(
    "active plugin source is not the local plugin path; this script did not change openclaw.json",
  );
  process.exitCode = 1;
}
NODE

if [[ "$RESTART_GATEWAY" -eq 1 ]]; then
  echo "[plugin-local] restarting gateway on port $GATEWAY_PORT"
  mapfile -t gateway_pids < <(
    pgrep -af "gateway --port ${GATEWAY_PORT}" |
      awk '{print $1}'
  )
  if [[ "${#gateway_pids[@]}" -gt 0 ]]; then
    echo "[plugin-local] stopping gateway pid(s): ${gateway_pids[*]}"
    kill "${gateway_pids[@]}"
    sleep 2
  fi
  mkdir -p "$OPENCLAW_HOME/logs"
  log_path="$OPENCLAW_HOME/logs/gateway-local-${plugin_id}.log"
  setsid node "$ROOT/dist/index.js" gateway --port "$GATEWAY_PORT" \
    >"$log_path" 2>&1 < /dev/null &
  gateway_pid="$!"
  sleep 3
  if ! kill -0 "$gateway_pid" 2>/dev/null; then
    echo "[plugin-local] gateway failed to stay running. Recent log:" >&2
    tail -80 "$log_path" >&2 || true
    exit 1
  fi
  echo "[plugin-local] started gateway pid $gateway_pid"
  echo "[plugin-local] log: $log_path"
else
  echo "[plugin-local] gateway not restarted. Restart it before expecting runtime changes."
fi

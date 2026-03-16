#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="openclaw-plugins-e2e"

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Running plugins Docker E2E..."
docker run --rm -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

if [ -f dist/index.mjs ]; then
  OPENCLAW_ENTRY="dist/index.mjs"
elif [ -f dist/index.js ]; then
  OPENCLAW_ENTRY="dist/index.js"
else
  echo "Missing dist/index.(m)js (build output):"
  ls -la dist || true
  exit 1
fi
export OPENCLAW_ENTRY

home_dir=$(mktemp -d "/tmp/openclaw-plugins-e2e.XXXXXX")
export HOME="$home_dir"

write_fixture_plugin() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"

  mkdir -p "$dir"
  cat > "$dir/package.json" <<JSON
{
  "name": "@openclaw/$id",
  "version": "$version",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
  cat > "$dir/index.js" <<JS
module.exports = {
  id: "$id",
  name: "$name",
  register(api) {
    api.registerGatewayMethod("$method", async () => ({ ok: true }));
  },
};
JS
  cat > "$dir/openclaw.plugin.json" <<'JSON'
{
  "id": "placeholder",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
  node - <<'NODE' "$dir/openclaw.plugin.json" "$id"
const fs = require("node:fs");
const file = process.argv[2];
const id = process.argv[3];
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
parsed.id = id;
fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
NODE
}

mkdir -p "$HOME/.openclaw/extensions/demo-plugin"

cat > "$HOME/.openclaw/extensions/demo-plugin/index.js" <<'JS'
module.exports = {
  id: "demo-plugin",
  name: "Demo Plugin",
  description: "Docker E2E demo plugin",
  register(api) {
    api.registerTool(() => null, { name: "demo_tool" });
    api.registerGatewayMethod("demo.ping", async () => ({ ok: true }));
    api.registerCli(() => {}, { commands: ["demo"] });
    api.registerService({ id: "demo-service", start: () => {} });
  },
};
JS
cat > "$HOME/.openclaw/extensions/demo-plugin/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin");
if (!plugin) throw new Error("plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}

const assertIncludes = (list, value, label) => {
  if (!Array.isArray(list) || !list.includes(value)) {
    throw new Error(`${label} missing: ${value}`);
  }
};

assertIncludes(plugin.toolNames, "demo_tool", "tool");
assertIncludes(plugin.gatewayMethods, "demo.ping", "gateway method");
assertIncludes(plugin.cliCommands, "demo", "cli command");
assertIncludes(plugin.services, "demo-service", "service");

const diagErrors = (data.diagnostics || []).filter((diag) => diag.level === "error");
if (diagErrors.length > 0) {
  throw new Error(`diagnostics errors: ${diagErrors.map((diag) => diag.message).join("; ")}`);
}

console.log("ok");
NODE

echo "Testing tgz install flow..."
pack_dir="$(mktemp -d "/tmp/openclaw-plugin-pack.XXXXXX")"
mkdir -p "$pack_dir/package"
cat > "$pack_dir/package/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-tgz",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat > "$pack_dir/package/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-tgz",
  name: "Demo Plugin TGZ",
  register(api) {
    api.registerGatewayMethod("demo.tgz", async () => ({ ok: true }));
  },
};
JS
cat > "$pack_dir/package/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-tgz",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
tar -czf /tmp/demo-plugin-tgz.tgz -C "$pack_dir" package

node "$OPENCLAW_ENTRY" plugins install /tmp/demo-plugin-tgz.tgz
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins2.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins2.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-tgz");
if (!plugin) throw new Error("tgz plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(plugin.gatewayMethods) || !plugin.gatewayMethods.includes("demo.tgz")) {
  throw new Error("expected gateway method demo.tgz");
}
console.log("ok");
NODE

echo "Testing install from local folder (plugins.load.paths)..."
dir_plugin="$(mktemp -d "/tmp/openclaw-plugin-dir.XXXXXX")"
cat > "$dir_plugin/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-dir",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat > "$dir_plugin/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-dir",
  name: "Demo Plugin DIR",
  register(api) {
    api.registerGatewayMethod("demo.dir", async () => ({ ok: true }));
  },
};
JS
cat > "$dir_plugin/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-dir",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

node "$OPENCLAW_ENTRY" plugins install "$dir_plugin"
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins3.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins3.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-dir");
if (!plugin) throw new Error("dir plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(plugin.gatewayMethods) || !plugin.gatewayMethods.includes("demo.dir")) {
  throw new Error("expected gateway method demo.dir");
}
console.log("ok");
NODE

echo "Testing install from npm spec (file:)..."
file_pack_dir="$(mktemp -d "/tmp/openclaw-plugin-filepack.XXXXXX")"
mkdir -p "$file_pack_dir/package"
cat > "$file_pack_dir/package/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-file",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat > "$file_pack_dir/package/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-file",
  name: "Demo Plugin FILE",
  register(api) {
    api.registerGatewayMethod("demo.file", async () => ({ ok: true }));
  },
};
JS
cat > "$file_pack_dir/package/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-file",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

node "$OPENCLAW_ENTRY" plugins install "file:$file_pack_dir/package"
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins4.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins4.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-file");
if (!plugin) throw new Error("file plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(plugin.gatewayMethods) || !plugin.gatewayMethods.includes("demo.file")) {
  throw new Error("expected gateway method demo.file");
}
console.log("ok");
NODE

echo "Testing marketplace install and update flows..."
marketplace_root="$HOME/.claude/plugins/marketplaces/fixture-marketplace"
mkdir -p "$HOME/.claude/plugins" "$marketplace_root/.claude-plugin"
write_fixture_plugin \
  "$marketplace_root/plugins/marketplace-shortcut" \
  "marketplace-shortcut" \
  "0.0.1" \
  "demo.marketplace.shortcut.v1" \
  "Marketplace Shortcut"
write_fixture_plugin \
  "$marketplace_root/plugins/marketplace-direct" \
  "marketplace-direct" \
  "0.0.1" \
  "demo.marketplace.direct.v1" \
  "Marketplace Direct"
cat > "$marketplace_root/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "Fixture Marketplace",
  "version": "1.0.0",
  "plugins": [
    {
      "name": "marketplace-shortcut",
      "version": "0.0.1",
      "description": "Shortcut install fixture",
      "source": "./plugins/marketplace-shortcut"
    },
    {
      "name": "marketplace-direct",
      "version": "0.0.1",
      "description": "Explicit marketplace fixture",
      "source": {
        "type": "path",
        "path": "./plugins/marketplace-direct"
      }
    }
  ]
}
JSON
cat > "$HOME/.claude/plugins/known_marketplaces.json" <<JSON
{
  "claude-fixtures": {
    "installLocation": "$marketplace_root",
    "source": {
      "type": "github",
      "repo": "openclaw/fixture-marketplace"
    }
  }
}
JSON

node "$OPENCLAW_ENTRY" plugins marketplace list claude-fixtures --json > /tmp/marketplace-list.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/marketplace-list.json", "utf8"));
const names = (data.plugins || []).map((entry) => entry.name).sort();
if (data.name !== "Fixture Marketplace") {
  throw new Error(`unexpected marketplace name: ${data.name}`);
}
if (!names.includes("marketplace-shortcut") || !names.includes("marketplace-direct")) {
  throw new Error(`unexpected marketplace plugins: ${names.join(", ")}`);
}
console.log("ok");
NODE

node "$OPENCLAW_ENTRY" plugins install marketplace-shortcut@claude-fixtures
node "$OPENCLAW_ENTRY" plugins install marketplace-direct --marketplace claude-fixtures
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins-marketplace.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace.json", "utf8"));
const getPlugin = (id) => {
  const plugin = (data.plugins || []).find((entry) => entry.id === id);
  if (!plugin) throw new Error(`plugin not found: ${id}`);
  if (plugin.status !== "loaded") {
    throw new Error(`unexpected status for ${id}: ${plugin.status}`);
  }
  return plugin;
};

const shortcut = getPlugin("marketplace-shortcut");
const direct = getPlugin("marketplace-direct");
if (shortcut.version !== "0.0.1") {
  throw new Error(`unexpected shortcut version: ${shortcut.version}`);
}
if (direct.version !== "0.0.1") {
  throw new Error(`unexpected direct version: ${direct.version}`);
}
if (!shortcut.gatewayMethods.includes("demo.marketplace.shortcut.v1")) {
  throw new Error("expected marketplace shortcut gateway method");
}
if (!direct.gatewayMethods.includes("demo.marketplace.direct.v1")) {
  throw new Error("expected marketplace direct gateway method");
}
console.log("ok");
NODE

node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
for (const id of ["marketplace-shortcut", "marketplace-direct"]) {
  const record = config.plugins?.installs?.[id];
  if (!record) throw new Error(`missing install record for ${id}`);
  if (record.source !== "marketplace") {
    throw new Error(`unexpected source for ${id}: ${record.source}`);
  }
  if (record.marketplaceSource !== "claude-fixtures") {
    throw new Error(`unexpected marketplace source for ${id}: ${record.marketplaceSource}`);
  }
  if (record.marketplacePlugin !== id) {
    throw new Error(`unexpected marketplace plugin for ${id}: ${record.marketplacePlugin}`);
  }
}
console.log("ok");
NODE

write_fixture_plugin \
  "$marketplace_root/plugins/marketplace-shortcut" \
  "marketplace-shortcut" \
  "0.0.2" \
  "demo.marketplace.shortcut.v2" \
  "Marketplace Shortcut"
node "$OPENCLAW_ENTRY" plugins update marketplace-shortcut --dry-run
node "$OPENCLAW_ENTRY" plugins update marketplace-shortcut
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins-marketplace-updated.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace-updated.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "marketplace-shortcut");
if (!plugin) throw new Error("updated marketplace plugin not found");
if (plugin.version !== "0.0.2") {
  throw new Error(`unexpected updated version: ${plugin.version}`);
}
if (!plugin.gatewayMethods.includes("demo.marketplace.shortcut.v2")) {
  throw new Error(`expected updated gateway method, got ${plugin.gatewayMethods.join(", ")}`);
}
console.log("ok");
NODE

echo "Running bundle MCP CLI-agent e2e..."
pnpm exec vitest run --config vitest.e2e.config.ts src/agents/cli-runner.bundle-mcp.e2e.test.ts
EOF

echo "OK"

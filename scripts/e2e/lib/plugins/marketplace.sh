run_plugins_marketplace_scenario() {
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
  cat >"$marketplace_root/.claude-plugin/marketplace.json" <<'JSON'
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
  cat >"$HOME/.claude/plugins/known_marketplaces.json" <<JSON
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

  node "$OPENCLAW_ENTRY" plugins marketplace list claude-fixtures --json >/tmp/marketplace-list.json

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

  run_logged install-marketplace-shortcut node "$OPENCLAW_ENTRY" plugins install marketplace-shortcut@claude-fixtures
  run_logged install-marketplace-direct node "$OPENCLAW_ENTRY" plugins install marketplace-direct --marketplace claude-fixtures
  node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-marketplace.json
  node "$OPENCLAW_ENTRY" plugins inspect marketplace-shortcut --json >/tmp/plugins-marketplace-shortcut-inspect.json
  node "$OPENCLAW_ENTRY" plugins inspect marketplace-direct --json >/tmp/plugins-marketplace-direct-inspect.json

  node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace.json", "utf8"));
const shortcutInspect = JSON.parse(
  fs.readFileSync("/tmp/plugins-marketplace-shortcut-inspect.json", "utf8"),
);
const directInspect = JSON.parse(
  fs.readFileSync("/tmp/plugins-marketplace-direct-inspect.json", "utf8"),
);
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
if (!shortcutInspect.gatewayMethods.includes("demo.marketplace.shortcut.v1")) {
  throw new Error("expected marketplace shortcut gateway method");
}
if (!directInspect.gatewayMethods.includes("demo.marketplace.direct.v1")) {
  throw new Error("expected marketplace direct gateway method");
}
console.log("ok");
NODE

  node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.join(process.env.HOME, ".openclaw", "plugins", "installs.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
const allowLegacyCompat = process.env.OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT === "1";
if (!allowLegacyCompat && !index.installRecords) {
  throw new Error("expected modern installRecords in installed plugin index");
}
const installRecords = allowLegacyCompat
  ? index.installRecords ?? index.records ?? config.plugins?.installs ?? {}
  : index.installRecords ?? {};
for (const id of ["marketplace-shortcut", "marketplace-direct"]) {
  const record = installRecords[id];
  if (!record) {
    if (allowLegacyCompat) {
      console.log(`legacy package did not persist marketplace install record for ${id}`);
      continue;
    }
    throw new Error(`missing marketplace install record for ${id}`);
  }
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
  run_logged update-marketplace-shortcut-dry-run node "$OPENCLAW_ENTRY" plugins update marketplace-shortcut --dry-run
  run_logged update-marketplace-shortcut node "$OPENCLAW_ENTRY" plugins update marketplace-shortcut
  node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-marketplace-updated.json
  node "$OPENCLAW_ENTRY" plugins inspect marketplace-shortcut --json >/tmp/plugins-marketplace-updated-inspect.json

  node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace-updated.json", "utf8"));
const inspect = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace-updated-inspect.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "marketplace-shortcut");
if (!plugin) throw new Error("updated marketplace plugin not found");
if (plugin.version !== "0.0.2") {
  throw new Error(`unexpected updated version: ${plugin.version}`);
}
if (!inspect.gatewayMethods.includes("demo.marketplace.shortcut.v2")) {
  throw new Error(`expected updated gateway method, got ${inspect.gatewayMethods.join(", ")}`);
}
console.log("ok");
NODE
}

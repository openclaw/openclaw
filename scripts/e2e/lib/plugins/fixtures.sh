record_fixture_plugin_trust() {
  local plugin_id="$1"
  local plugin_root="$2"
  local enabled="$3"
  node scripts/e2e/lib/plugins/assertions.mjs record-fixture-plugin-trust "$plugin_id" "$plugin_root" "$enabled"
}

write_demo_fixture_plugin() {
  local dir="$1"

  mkdir -p "$dir"
  cat >"$dir/index.js" <<'JS'
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
  write_fixture_manifest "$dir/openclaw.plugin.json" demo-plugin
}

write_fixture_plugin() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"

  mkdir -p "$dir"
  cat >"$dir/package.json" <<JSON
{
  "name": "@openclaw/$id",
  "version": "$version",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
  cat >"$dir/index.js" <<JS
module.exports = {
  id: "$id",
  name: "$name",
  register(api) {
    api.registerGatewayMethod("$method", async () => ({ ok: true }));
  },
};
JS
  write_fixture_manifest "$dir/openclaw.plugin.json" "$id"
}

write_fixture_manifest() {
  local file="$1"
  local id="$2"

  cat >"$file" <<'JSON'
{
  "id": "placeholder",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
  node scripts/e2e/lib/plugins/assertions.mjs set-manifest-id "$file" "$id"
}

pack_fixture_plugin() {
  local pack_dir="$1"
  local output_tgz="$2"
  local id="$3"
  local version="$4"
  local method="$5"
  local name="$6"

  mkdir -p "$pack_dir/package"
  write_fixture_plugin "$pack_dir/package" "$id" "$version" "$method" "$name"
  tar -czf "$output_tgz" -C "$pack_dir" package
}

write_claude_bundle_fixture() {
  local bundle_root="$1"

  mkdir -p "$bundle_root/.claude-plugin" "$bundle_root/commands"
  cat >"$bundle_root/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "claude-bundle-e2e"
}
JSON
  cat >"$bundle_root/commands/office-hours.md" <<'MD'
---
description: Help with architecture and rollout planning
---
Act as an engineering advisor.

Focus on:
$ARGUMENTS
MD
}

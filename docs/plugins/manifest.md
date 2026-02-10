---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Plugin manifest + JSON schema requirements (strict config validation)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are building a OpenClaw plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to ship a plugin config schema or debug plugin validation errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Plugin Manifest"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Plugin manifest (openclaw.plugin.json)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every plugin **must** ship a `openclaw.plugin.json` file in the **plugin root**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses this manifest to validate configuration **without executing plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
code**. Missing or invalid manifests are treated as plugin errors and block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
config validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See the full plugin system guide: [Plugins](/tools/plugin).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Required fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "voice-call",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "configSchema": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "object",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "additionalProperties": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "properties": {}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Required keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `id` (string): canonical plugin id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `configSchema` (object): JSON Schema for plugin config (inline).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional keys:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `kind` (string): plugin kind (example: `"memory"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels` (array): channel ids registered by this plugin (example: `["matrix"]`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `providers` (array): provider ids registered by this plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills` (array): skill directories to load (relative to the plugin root).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name` (string): display name for the plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `description` (string): short plugin summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `uiHints` (object): config field labels/placeholders/sensitive flags for UI rendering.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `version` (string): plugin version (informational).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## JSON Schema requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Every plugin must ship a JSON Schema**, even if it accepts no config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- An empty schema is acceptable (for example, `{ "type": "object", "additionalProperties": false }`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Schemas are validated at config read/write time, not at runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Validation behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown `channels.*` keys are **errors**, unless the channel id is declared by（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a plugin manifest.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, and `plugins.slots.*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  must reference **discoverable** plugin ids. Unknown ids are **errors**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a plugin is installed but has a broken or missing manifest or schema,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  validation fails and Doctor reports the plugin error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If plugin config exists but the plugin is **disabled**, the config is kept and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a **warning** is surfaced in Doctor + logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The manifest is **required for all plugins**, including local filesystem loads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime still loads the plugin module separately; the manifest is only for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  discovery + validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If your plugin depends on native modules, document the build steps and any（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  package-manager allowlist requirements (for example, pnpm `allow-build-scripts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm rebuild <package>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

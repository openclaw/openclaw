---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Strict config validation + doctor-only migrations"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Designing or implementing config validation behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Working on config migrations or doctor workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Handling plugin config schemas or plugin load gating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Strict Config Validation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Strict config validation (doctor-only migrations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reject unknown config keys everywhere** (root + nested).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Reject plugin config without a schema**; don’t load that plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remove legacy auto-migration on load**; migrations run via doctor only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Auto-run doctor (dry-run) on startup**; if invalid, block non-diagnostic commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Non-goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Backward compatibility on load (legacy keys do not auto-migrate).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Silent drops of unrecognized keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Strict validation rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config must match the schema exactly at every level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown keys are validation errors (no passthrough at root or nested).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `plugins.entries.<id>.config` must be validated by the plugin’s schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If a plugin lacks a schema, **reject plugin load** and surface a clear error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown `channels.<id>` keys are errors unless a plugin manifest declares the channel id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin manifests (`openclaw.plugin.json`) are required for all plugins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin schema enforcement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each plugin provides a strict JSON Schema for its config (inline in the manifest).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin load flow:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  1. Resolve plugin manifest + schema (`openclaw.plugin.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  2. Validate config against the schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  3. If missing schema or invalid config: block plugin load, record error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Error message includes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Plugin id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reason (missing schema / invalid config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Path(s) that failed validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Disabled plugins keep their config, but Doctor + logs surface a warning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Doctor flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor runs **every time** config is loaded (dry-run by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If config invalid:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Print a summary + actionable errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Instruct: `openclaw doctor --fix`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor --fix`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Applies migrations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Removes unknown keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Writes updated config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command gating (when config is invalid)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowed (diagnostic-only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw logs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw health`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw help`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Everything else must hard-fail with: “Config invalid. Run `openclaw doctor --fix`.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error UX format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Single summary header.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Grouped sections:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Unknown keys (full paths)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Legacy keys / migrations needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Plugin load failures (plugin id + reason + path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Implementation touchpoints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/config/zod-schema.ts`: remove root passthrough; strict objects everywhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/config/zod-schema.providers.ts`: ensure strict channel schemas.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/config/validation.ts`: fail on unknown keys; do not apply legacy migrations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/config/io.ts`: remove legacy auto-migrations; always run doctor dry-run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/config/legacy*.ts`: move usage to doctor only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `src/plugins/*`: add schema registry + gating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI command gating in `src/cli`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown key rejection (root + nested).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin missing schema → plugin load blocked with clear error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Invalid config → gateway startup blocked except diagnostic commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor dry-run auto; `doctor --fix` writes corrected config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

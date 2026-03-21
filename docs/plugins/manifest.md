---
summary: "Plugin manifest + JSON schema requirements (strict config validation)"
read_when:
  - You are building an OpenClaw plugin
  - You need to ship a plugin config schema or debug plugin validation errors
title: "Plugin Manifest"
---

# Plugin manifest (openclaw.plugin.json)

This page is for the **native OpenClaw plugin manifest** only.

For compatible bundle layouts, see [Plugin bundles](/plugins/bundles).

Compatible bundle formats use different manifest files:

- Codex bundle: `.codex-plugin/plugin.json`
- Claude bundle: `.claude-plugin/plugin.json` or the default Claude component
  layout without a manifest
- Cursor bundle: `.cursor-plugin/plugin.json`

OpenClaw auto-detects those bundle layouts too, but they are not validated
against the `openclaw.plugin.json` schema described here.

For compatible bundles, OpenClaw currently reads bundle metadata plus declared
skill roots, Claude command roots, Claude bundle `settings.json` defaults, and
supported hook packs when the layout matches OpenClaw runtime expectations.

Every native OpenClaw plugin **must** ship a `openclaw.plugin.json` file in the
**plugin root**. OpenClaw uses this manifest to validate configuration
**without executing plugin code**. Missing or invalid manifests are treated as
plugin errors and block config validation.

See the full plugin system guide: [Plugins](/tools/plugin).
For the native capability model and current external-compatibility guidance:
[Capability model](/plugins/architecture#public-capability-model).

## Required fields

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Required keys:

- `id` (string): canonical plugin id.
- `configSchema` (object): JSON Schema for plugin config (inline).

Optional keys:

- `kind` (string): plugin kind (examples: `"memory"`, `"context-engine"`).
- `channels` (array): channel ids registered by this plugin (channel capability; example: `["matrix"]`).
- `providers` (array): provider ids registered by this plugin (text inference capability).
- `providerAuthEnvVars` (object): auth env vars keyed by provider id. Use this
  when OpenClaw should resolve provider credentials from env without loading
  plugin runtime first.
- `providerAuthChoices` (array): cheap onboarding/auth-choice metadata keyed by
  provider + auth method. Use this when OpenClaw should show a provider in
  auth-choice pickers, preferred-provider resolution, and CLI help without
  loading plugin runtime first.
- `skills` (array): skill directories to load (relative to the plugin root).
- `name` (string): display name for the plugin.
- `description` (string): short plugin summary.
- `uiHints` (object): config field labels/placeholders/sensitive flags for UI rendering.
- `version` (string): plugin version (informational).

### `providerAuthChoices` shape

Each entry can declare:

- `provider`: provider id
- `method`: auth method id
- `choiceId`: stable onboarding/auth-choice id
- `choiceLabel` / `choiceHint`: picker label + short hint
- `groupId` / `groupLabel` / `groupHint`: grouped onboarding bucket metadata
- `optionKey` / `cliFlag` / `cliOption` / `cliDescription`: optional one-flag
  CLI wiring for simple auth flows such as API keys

Example:

```json
{
  "providerAuthChoices": [
    {
      "provider": "openrouter",
      "method": "api-key",
      "choiceId": "openrouter-api-key",
      "choiceLabel": "OpenRouter API key",
      "groupId": "openrouter",
      "groupLabel": "OpenRouter",
      "optionKey": "openrouterApiKey",
      "cliFlag": "--openrouter-api-key",
      "cliOption": "--openrouter-api-key <key>",
      "cliDescription": "OpenRouter API key"
    }
  ]
}
```

## JSON Schema requirements

- **Every plugin must ship a JSON Schema**, even if it accepts no config.
- An empty schema is acceptable (for example, `{ "type": "object", "additionalProperties": false }`).
- Schemas are validated at config read/write time, not at runtime.

## Validation behavior

- Unknown `channels.*` keys are **errors**, unless the channel id is declared by
  a plugin manifest.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, and `plugins.slots.*`
  must reference **discoverable** plugin ids. Unknown ids are **errors**.
- If a plugin is installed but has a broken or missing manifest or schema,
  validation fails and Doctor reports the plugin error.
- If plugin config exists but the plugin is **disabled**, the config is kept and
  a **warning** is surfaced in Doctor + logs.

See [Configuration reference](/gateway/configuration) for the full `plugins.*` schema.

## Notes

- The manifest is **required for native OpenClaw plugins**, including local filesystem loads.
- Runtime still loads the plugin module separately; the manifest is only for
  discovery + validation.
- `providerAuthEnvVars` is the cheap metadata path for auth probes, env-marker
  validation, and similar provider-auth surfaces that should not boot plugin
  runtime just to inspect env names.
- `providerAuthChoices` is the cheap metadata path for auth-choice pickers,
  `--auth-choice` resolution, preferred-provider mapping, and simple onboarding
  CLI flag registration before provider runtime loads. For runtime wizard
  metadata that requires provider code, see
  [Provider runtime hooks](/plugins/architecture#provider-runtime-hooks).
- Exclusive plugin kinds are selected through `plugins.slots.*`.
  - `kind: "memory"` is selected by `plugins.slots.memory`.
  - `kind: "context-engine"` is selected by `plugins.slots.contextEngine`
    (default: built-in `legacy`).
- If your plugin depends on native modules, document the build steps and any
  package-manager allowlist requirements (for example, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).

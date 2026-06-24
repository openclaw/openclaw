# custom-image-providers

OpenClaw plugin that exposes selected `models.providers.<id>` entries as image-generation providers using OpenAI-compatible `/images/generations` and `/images/edits` endpoints.

## What it does

- Reuses provider config already defined under `models.providers.<id>`
- Registers matching image-generation providers for selected provider ids
- Supports optional image-only API key overrides at the plugin config layer
- Works for providers whose image generation uses OpenAI-compatible JSON requests and `/images/generations` or `/images/edits`

## Deployment model

This plugin is portable across installations, but OpenClaw capability discovery currently relies on provider ids declared in `openclaw.plugin.json`.

That means the plugin can only expose image providers whose ids are listed in the manifest. To add a different provider id, update:

1. `openclaw.plugin.json` → `contracts.imageGenerationProviders`
2. `plugins.entries.custom-image-providers.config.providerIds`
3. `models.providers.<id>` in normal OpenClaw config

## Scope and limitations

This plugin assumes:

- generation endpoint: `.../images/generations`
- edit endpoint: `.../images/edits`
- bearer-auth or configured headers
- OpenAI-style response payloads containing image data or image URLs

Providers that need different paths, auth semantics, or non-OpenAI response formats require code changes.

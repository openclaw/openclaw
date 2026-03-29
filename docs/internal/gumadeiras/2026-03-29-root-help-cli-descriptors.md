---
title: "Root Help CLI Descriptor Loader Note"
summary: "Collect root-help plugin CLI descriptors through a dedicated non-activating loader path with validated config, awaited registration, and plugin-owned channel metadata."
author: "Gustavo Madeira Santana"
github_username: "gumadeiras"
created: "2026-03-29"
status: "implemented"
---

This note covers the final implementation on PR #57294 after review found two remaining gaps in the earlier branch state:

- root help still depended on an activating plugin loader path
- async `register()` implementations were still ignored during descriptor capture

Decision:

- Root help should be non-activating, not semantically different.
- That means `openclaw --help` should keep loader semantics for enable-state, per-plugin config, duplicate precedence, config validation, and memory-slot gating.
- Help should use a dedicated async CLI metadata collector instead of piggybacking on the general activating registry loader.
- Channel plugins should keep ownership of their own root-help metadata wherever possible.

Implementation shape:

- Add `loadOpenClawPluginCliRegistry()` in `src/plugins/loader.ts`.
- The collector reuses plugin discovery, manifest loading, duplicate precedence, enable-state resolution, config validation, and memory-slot gating.
- The collector always runs with `activate: false` and `cache: false`.
- The collector awaits `register(api)` so async plugin registration contributes CLI metadata.
- The collector only exposes `registerCli(...)` to plugin code; it does not activate services, tools, providers, or gateway handlers.
- `getPluginCliCommandDescriptors()` and root-help rendering are now async and route through the dedicated collector.
- `defineChannelPluginEntry(...)` gained an additive `registerCliMetadata(api)` seam so channel plugins can register root-help metadata without entering `registerFull(...)`, while full loads still collect the same CLI descriptors.
- `extensions/matrix/index.ts` moved its CLI descriptor registration onto that seam.
- `defineChannelPluginEntry(...)` now skips `setRuntime(...)` in `cli-metadata` mode so help rendering does not poison channel runtime stores with a fake runtime object.
- `registerPluginCliCommands()` still uses the normal full plugin loader so legacy channel plugins that wired CLI commands inside `registerFull(...)` keep working until they adopt `registerCliMetadata(...)`.

Why this replaced the earlier approach:

- The original manual import loop in `src/plugins/cli.ts` dropped `api.pluginConfig`, which broke config-dependent CLI plugins.
- The intermediate loader-flag approach still tied descriptor capture to the sync general loader path and left async `register()` unsupported.
- The dedicated collector keeps the special behavior narrow and explicit instead of broadening the general loader contract further.

Regression coverage added:

- A loader test that proves CLI metadata loads still receive validated `pluginConfig`.
- A loader test that proves channel CLI metadata capture uses the real channel entry, reports `registrationMode: "cli-metadata"`, and does not load `setupEntry`.
- A loader test that proves async plugin `register()` contributes CLI descriptors during metadata collection.
- A loader test that proves `cli-metadata` mode does not call `setRuntime(...)` for channel plugins.

---
title: "Root Help CLI Descriptor Loader Note"
summary: "Move root-help descriptor capture onto shared loader semantics while keeping channel plugins non-activating."
author: "Gustavo Madeira Santana"
github_username: "gumadeiras"
created: "2026-03-29"
status: "implemented"
---

This note covers the follow-up on PR #57294 after review found that the first descriptor-capture approach rebuilt plugin discovery and import logic inside `src/plugins/cli.ts`.

Decision:

- Root help should be non-activating, not semantically different.
- That means `openclaw --help` should keep loader semantics for enable-state, per-plugin config, config validation, and channel/plugin selection rules.
- The loader gets a dedicated CLI-metadata snapshot mode instead of `src/plugins/cli.ts` importing plugin entries by itself.

Implementation shape:

- Add `captureCliMetadataOnly` to `loadOpenClawPlugins()`.
- In that mode, enabled channel plugins load from their real entry file but receive `registrationMode: "setup-only"` so `registerFull(...)` work does not run.
- Non-channel plugins keep the normal validated loader path, including `pluginConfig`.
- `getPluginCliCommandDescriptors()` now asks the loader for a non-activating snapshot registry and reads `registry.cliRegistrars`.

Why this replaced the earlier approach:

- The manual import loop in `src/plugins/cli.ts` dropped `api.pluginConfig`, which broke config-dependent CLI plugins.
- It also drifted away from loader behavior around channel setup entry selection and plugin registration rules.

Regression coverage added:

- A loader test that proves CLI metadata snapshot loads still receive validated `pluginConfig`.
- A loader test that proves channel CLI metadata capture uses the real channel entry in `setup-only` mode instead of the package `setupEntry`.

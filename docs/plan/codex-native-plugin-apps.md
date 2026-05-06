---
title: Codex Native Plugin Apps
description: Milestone specs for removing OpenClaw Codex plugin dynamic tools and relying on Codex app-server native plugin support.
---

Draft implementation specification.

## 1. Milestone feature specs

### 1.1 Remove OpenClaw Codex plugin dynamic tools

Goal: remove the synthetic OpenClaw tool layer that converted configured Codex
plugins into OpenClaw dynamic tools.

User-visible behavior:

- Gateway tool discovery no longer exposes plugin tools for Codex-native apps.
- Codex-mode conversations no longer spawn a second ephemeral Codex thread just
  to invoke a Codex plugin.
- Existing Codex app-server turns continue to receive ordinary OpenClaw dynamic
  tools that are not native Codex plugin replacements.

Implementation scope:

- Delete the Codex plugin tool registration, inventory, activation, and invoker
  modules.
- Remove the Codex plugin wildcard tool contract from the bundled plugin
  manifest.
- Remove bridge-specific config schema, UI hints, docs, and tests.

Acceptance criteria:

- No bundled Codex manifest contract declares plugin-derived OpenClaw tools.
- No Codex plugin config key enables a synthetic OpenClaw tool bridge.
- Tool-contract tests keep generic wildcard coverage without referencing Codex
  plugins.

Verification:

- Targeted config, manifest, and plugin-tool tests.
- A live dev-gateway proof shows no Codex plugin dynamic tool appears while
  native plugin invocation still works.

### 1.2 Keep migration native to Codex app-server

Goal: preserve useful Codex plugin migration by activating selected plugins in
Codex app-server, not in OpenClaw's tool registry.

User-visible behavior:

- `openclaw migrate codex --plugin <name>` can still install or enable selected
  source-installed `openai-curated` Codex plugins.
- Migration enables the bundled `codex` plugin and updates `plugins.allow` only
  when needed for the Codex harness itself.
- Migration does not write tool allowlist entries or bridge config for Codex
  plugins.

Implementation scope:

- Keep app-server discovery through `plugin/list` and `app/list`.
- Keep apply-time `plugin/install` plus app, MCP server, and skill reloads.
- Report inaccessible or unauthorized apps on plugin items.
- Remove apply-time gating around bridge config.

Acceptance criteria:

- Selected plugins are installed through app-server APIs.
- Failed app authorization does not create fallback tool config.
- Restrictive plugin allowlists are updated only for the bundled `codex` plugin.

Verification:

- Migration provider tests for planning, selected plugin install, restrictive
  allowlists, and app authorization failures.

### 1.3 Invoke plugins in the main Codex session thread

Goal: rely on Codex app-server's native mention handling in the session thread
that OpenClaw already uses for Codex-mode turns.

User-visible behavior:

- Users invoke native Codex plugins with mention syntax such as
  `[@Google Calendar](plugin://google-calendar)` inside a Codex-mode message.
- Plugin calls share the same Codex transcript, approval semantics, and app
  authorization flow as ordinary Codex app-server plugin use.
- OpenClaw no longer duplicates plugin auth or transcript behavior.

Implementation scope:

- Keep OpenClaw forwarding user text to `turn/start` on the bound Codex thread.
- Document native mention usage in the Codex harness and migration docs.
- Do not add compatibility parsing or translation for the removed OpenClaw tool
  names.

Acceptance criteria:

- A TUI-submitted Codex-mode message containing a native plugin mention reaches
  the Codex app-server turn on the bound thread.
- The live behavior uses native plugin/app events, not an OpenClaw tool call.

Verification:

- Showboat demo against the dev gateway and TUI with logs or transcript
  evidence for the native plugin mention and resulting plugin behavior.

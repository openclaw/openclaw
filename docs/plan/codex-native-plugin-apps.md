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

### 1.2 Invoke plugins in the main Codex session thread

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

### 1.3 Migration activation

Goal: preserve useful Codex plugin migration by activating selected plugins in
Codex app-server, not in OpenClaw's tool registry.

This milestone is intentionally deferred to the stacked migration PR. The first
PR only lands the native invocation and configuration substrate that migration
uses.

## 2. Implementation plan

### 2.1 Remove the OpenClaw tool bridge as an invocation path

Codex-native apps should not be exposed as OpenClaw `codex_plugin_*` dynamic
tools. The native thread path keeps transcript, approval, and app authorization
inside the Codex app-server session.

### 2.2 Keep app-server plugin/app methods typed

OpenClaw still needs typed JSON-RPC coverage for native Codex plugin/app
configuration surfaces such as `plugin/list`, `plugin/install`, `app/list`, and
`hooks/list`. These methods are app-server control-plane calls, not OpenClaw
tool registrations.

### 2.3 Tolerate app-server permission-profile drift

Live app-server `thread/start` and `thread/resume` responses may contain newer
special filesystem path kinds before OpenClaw updates its generated schema.
Normalize unknown special path kinds to the stable `unknown` shape so native
plugin invocation is not blocked at thread startup.

### 2.4 Invoke native plugins from the bound Codex thread

Users invoke plugins with native Codex mention syntax, for example
`[@Google Calendar](plugin://google-calendar)`, in the same Codex-mode message
that OpenClaw forwards to `turn/start`.

### 2.5 Migrate selected plugins through app-server

Deferred to the stacked migration PR. That PR adds Codex source discovery,
planning, apply-time install/reload behavior, and migration CLI/docs updates.

### 2.6 PR 1 docs, tests, and proof

This PR owns:

- Harness docs for native mention usage and the removal of bridge tool
  semantics.
- App-server schema normalization tests for current live `permissionProfile`
  responses.
- Generic wildcard plugin-tool contract tests that keep OpenClaw's plugin tool
  registry behavior independent of Codex-native plugin ids.
- Showboat/dev-gateway/TUI proof that a native plugin mention reaches the main
  Codex app-server thread without a `codex_plugin_*` OpenClaw tool call.

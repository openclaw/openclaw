---
summary: "Plugin compatibility contracts, deprecation metadata, and migration expectations"
title: "Plugin compatibility"
read_when:
  - You maintain an OpenClaw plugin
  - You see a plugin compatibility warning
  - You are planning a plugin SDK or manifest migration
---

OpenClaw keeps older plugin contracts wired through named compatibility
adapters before removing them. This protects existing bundled and external
plugins while the SDK, manifest, setup, config, and agent runtime contracts
evolve.

## Compatibility registry

Plugin compatibility contracts are tracked in the core registry at
`src/plugins/compat/registry.ts`.

Each record has:

- a stable compatibility code
- status: `active`, `deprecated`, `removal-pending`, or `removed`
- owner: SDK, config, setup, channel, provider, plugin execution, agent runtime,
  or core
- introduction and deprecation dates when applicable
- replacement guidance
- docs, diagnostics, and tests that cover the old and new behavior

The registry is the source for maintainer planning and future plugin inspector
checks. If a plugin-facing behavior changes, add or update the compatibility
record in the same change that adds the adapter.

## Deprecation policy

OpenClaw should not remove a documented plugin contract in the same release
that introduces its replacement.

The migration sequence is:

1. Add the new contract.
2. Keep the old behavior wired through a named compatibility adapter.
3. Emit diagnostics or warnings when plugin authors can act.
4. Document the replacement and timeline.
5. Test both old and new paths.
6. Wait through the announced migration window.
7. Remove only with explicit breaking-release approval.

Deprecated records must include a warning start date, replacement, docs link,
and target removal date when known.

## Current compatibility areas

Current compatibility records include:

- legacy broad SDK imports such as `openclaw/plugin-sdk/compat`
- legacy hook-only plugin shapes and `before_agent_start`
- bundled plugin allowlist and enablement behavior
- legacy provider/channel env-var manifest metadata
- activation hints that are being replaced by manifest contribution ownership
- `embeddedHarness` and `agent-harness` naming aliases while public naming moves
  toward `agentRuntime`
- generated bundled channel config metadata fallback while registry-first
  `channelConfigs` metadata lands

New plugin code should prefer the replacement listed in the registry and in the
specific migration guide. Existing plugins can keep using a compatibility path
until the docs, diagnostics, and release notes announce a removal window.

## Release notes

Release notes should include upcoming plugin deprecations with target dates and
links to migration docs. That warning needs to happen before a compatibility
path moves to `removal-pending` or `removed`.

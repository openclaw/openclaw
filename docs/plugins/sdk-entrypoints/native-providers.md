---
summary: "Factory-form speech, transcription, and voice registration, and Computer Use providers"
title: "Plugin SDK native provider factories"
sidebarTitle: "Native providers"
read_when:
  - You are registering a speech, transcription, or realtime voice provider
  - You are building a node-local Computer Use plugin
---

Factory-form registration for native providers, and the node-local Computer
Use provider surface. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## Native provider factories

`registerSpeechProvider`, `registerRealtimeTranscriptionProvider`, and
`registerRealtimeVoiceProvider` accept either a complete provider descriptor or
a synchronous factory receiving `PluginCapabilityCatalogContext`:

```typescript
register(api) {
  api.registerRealtimeTranscriptionProvider((context) =>
    buildRealtimeTranscriptionProvider(context),
  );
}
```

Use the same plugin-owned factory for full registration and an optional
capability catalog. The host supplies native auth, request, and transport
operations; constructing a descriptor should not load execution SDK barrels,
read credentials, or start sessions. Keep that work in the descriptor's methods.
Factories must return synchronously; a thrown error or promise fails registration.

Full registration can bind its own broker or logger in the factory closure.
Do not substitute a catalog-only descriptor for one that requires those bindings.
Full plugin registration still owns harnesses, hooks, services, and lifecycle
callbacks; catalog entries alone do not establish runtime readiness.

Object registrations remain supported. Before publishing a plugin that uses
factory arguments, set its `compat.pluginApi` floor to a host release that
supports them; a lower `minHostVersion` does not override that API requirement.

## Computer Use providers

**Import:** `openclaw/plugin-sdk/computer-use`

Node-local Computer Use plugins register one provider through
`registerComputerUseProvider(api, provider)`. The helper owns the
`screen.snapshot` and dangerous `computer.act` command registrations and the
matching Gateway invoke policy; the provider owns availability, execution,
serialization, frame state, driver lifecycle, and cleanup.

The same entry point exports the canonical TypeBox schemas, static types, and
compiled validators for the two command payloads and the snapshot result. A
node host accepts one provider for the command pair; registering another
provider conflicts with the existing command registration instead of creating
a fallback stack.

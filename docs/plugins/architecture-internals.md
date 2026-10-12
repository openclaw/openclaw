---
summary: "Plugin architecture internals: load pipeline, registry, runtime hooks, HTTP routes, and reference tables"
read_when:
  - Implementing provider runtime hooks, channel lifecycle, or package packs
  - Debugging plugin load order or registry state
  - Adding a new plugin capability or context engine plugin
title: "Plugin architecture internals"
---

For the public capability model, plugin shapes, and ownership/execution
contracts, see [Plugin architecture](/plugins/architecture). This page covers
the internal mechanics: load pipeline, registry, runtime hooks, Gateway HTTP
routes, import paths, and schema tables.

## What each page covers

- [Load pipeline and registry](/plugins/architecture-internals/load-pipeline) — discovery, safety gates, manifest-first metadata, the plugin cache boundary, and the registry model.
- [Provider hooks and catalogs](/plugins/architecture-internals/provider-hooks) — the provider hook order table, a worked example, bundled hook shapes, and catalog merge order.
- [Core runtime helpers](/plugins/architecture-internals/runtime-helpers) — speech, media understanding, subagent, web search, and image generation through `api.runtime`.
- [Gateway routes](/plugins/architecture-internals/gateway-routes) — plugin HTTP endpoints and their auth, scope, replacement, and admission rules.
- [Channel surfaces](/plugins/architecture-internals/channel-surfaces) — conversation binding callbacks, message tool schemas, target resolution, directories, and inspection.
- [Packs and import paths](/plugins/architecture-internals/packaging) — SDK import subpaths, package packs, and channel catalog and install metadata.
- [Context engines](/plugins/architecture-internals/context-engines) — replacing session ingest, assembly, and compaction through the `contextEngine` slot.
- [New capability](/plugins/architecture-internals/new-capability) — the sequence, file checklist, and contract-test pattern for a capability core does not have yet.

## Where each section moved

Every section of the single-page version now lives on this page or on one of
the eight child pages below. The anchors from the single-page version still
resolve here.

### Load pipeline and registry

[Load pipeline and registry](/plugins/architecture-internals/load-pipeline) — Discovery, safety gates, manifest-first metadata, the plugin cache boundary, and the registry core reads from.

- <a id="load-pipeline"></a>[Load pipeline](/plugins/architecture-internals/load-pipeline#load-pipeline)
- <a id="manifest-first-behavior"></a>[Manifest-first behavior](/plugins/architecture-internals/load-pipeline#manifest-first-behavior)
- <a id="plugin-cache-boundary"></a>[Plugin cache boundary](/plugins/architecture-internals/load-pipeline#plugin-cache-boundary)
- <a id="registry-model"></a>[Registry model](/plugins/architecture-internals/load-pipeline#registry-model)

### Provider hooks and catalogs

[Provider hooks and catalogs](/plugins/architecture-internals/provider-hooks) — The provider hook order table, a worked provider example, bundled hook shapes, and model catalog registration.

- <a id="provider-runtime-hooks"></a>[Provider runtime hooks](/plugins/architecture-internals/provider-hooks#provider-runtime-hooks)
- <a id="hook-order-and-usage"></a>[Hook order and usage](/plugins/architecture-internals/provider-hooks#hook-order-and-usage)
- <a id="provider-example"></a>[Provider example](/plugins/architecture-internals/provider-hooks#provider-example)
- <a id="built-in-examples"></a>[Built-in examples](/plugins/architecture-internals/provider-hooks#built-in-examples)
- <a id="pass-through-catalog-providers"></a>[Pass-through catalog providers](/plugins/architecture-internals/provider-hooks#pass-through-catalog-providers)
- <a id="oauth-and-usage-endpoint-providers"></a>[OAuth and usage endpoint providers](/plugins/architecture-internals/provider-hooks#oauth-and-usage-endpoint-providers)
- <a id="replay-and-transcript-cleanup-families"></a>[Replay and transcript cleanup families](/plugins/architecture-internals/provider-hooks#replay-and-transcript-cleanup-families)
- <a id="catalog-only-providers"></a>[Catalog-only providers](/plugins/architecture-internals/provider-hooks#catalog-only-providers)
- <a id="anthropic-specific-stream-helpers"></a>[Anthropic-specific stream helpers](/plugins/architecture-internals/provider-hooks#anthropic-specific-stream-helpers)
- <a id="provider-catalogs"></a>[Provider catalogs](/plugins/architecture-internals/provider-hooks#provider-catalogs)

### Core runtime helpers

[Core runtime helpers](/plugins/architecture-internals/runtime-helpers) — Speech, media understanding, subagent, web search, and image generation helpers exposed through `api.runtime`.

- <a id="runtime-helpers"></a>[Runtime helpers](/plugins/architecture-internals/runtime-helpers#runtime-helpers)
- <a id="api-runtime-imagegeneration"></a><a id="api.runtime.imagegeneration"></a>[`api.runtime.imageGeneration`](/plugins/architecture-internals/runtime-helpers#api-runtime-imagegeneration)

### Gateway routes

[Gateway routes](/plugins/architecture-internals/gateway-routes) — Registering plugin HTTP endpoints on the Gateway, and their auth, scope, replacement, and admission rules.

- <a id="gateway-http-routes"></a>[Gateway HTTP routes](/plugins/architecture-internals/gateway-routes#gateway-http-routes)

### Channel surfaces

[Channel surfaces](/plugins/architecture-internals/channel-surfaces) — Conversation binding callbacks, message tool schemas, target resolution, config-backed directories, and read-only inspection.

- <a id="conversation-binding-callbacks"></a>[Conversation binding callbacks](/plugins/architecture-internals/channel-surfaces#conversation-binding-callbacks)
- <a id="message-tool-schemas"></a>[Message tool schemas](/plugins/architecture-internals/channel-surfaces#message-tool-schemas)
- <a id="channel-target-resolution"></a>[Channel target resolution](/plugins/architecture-internals/channel-surfaces#channel-target-resolution)
- <a id="config-backed-directories"></a>[Config-backed directories](/plugins/architecture-internals/channel-surfaces#config-backed-directories)
- <a id="read-only-channel-inspection"></a>[Read-only channel inspection](/plugins/architecture-internals/channel-surfaces#read-only-channel-inspection)

### Packs and import paths

[Packs and import paths](/plugins/architecture-internals/packaging) — Plugin SDK import subpaths, multi-extension package packs, and channel catalog and install metadata.

- <a id="plugin-sdk-import-paths"></a>[Plugin SDK import paths](/plugins/architecture-internals/packaging#plugin-sdk-import-paths)
- <a id="package-packs"></a>[Package packs](/plugins/architecture-internals/packaging#package-packs)
- <a id="channel-catalog-metadata"></a>[Channel catalog metadata](/plugins/architecture-internals/packaging#channel-catalog-metadata)

### Context engines

[Context engines](/plugins/architecture-internals/context-engines) — Taking over session ingest, assembly, and compaction through the `contextEngine` slot.

- <a id="context-engine-plugins"></a>[Context engine plugins](/plugins/architecture-internals/context-engines#context-engine-plugins)

### New capability

[New capability](/plugins/architecture-internals/new-capability) — The sequence, file checklist, and contract-test pattern for adding a capability the plugin API does not have yet.

- <a id="adding-a-new-capability"></a>[Adding a new capability](/plugins/architecture-internals/new-capability#adding-a-new-capability)
- <a id="capability-checklist"></a>[Capability checklist](/plugins/architecture-internals/new-capability#capability-checklist)
- <a id="capability-template"></a>[Capability template](/plugins/architecture-internals/new-capability#capability-template)

## Related

- [Plugin architecture](/plugins/architecture) — public capability model and shapes
- [Plugin SDK subpaths](/plugins/sdk-subpaths)
- [Plugin SDK setup](/plugins/sdk-setup)
- [Building plugins](/plugins/building-plugins)

# OpenClaw Charter

API contracts, scope boundaries, and compatibility commitments. Things this repo promises to other code (extensions, plugins, downstream apps).

## Public surfaces

| Surface | Definition files |
|---|---|
| Plugin SDK | `src/plugin-sdk/*` (entrypoints listed in `scripts/lib/plugin-sdk-entrypoints.json` + `package.json`) |
| Channel contract | `src/plugin-sdk/channel-contract.ts`, `src/channels/plugins/types.plugin.ts`, `src/channels/plugins/types.core.ts`, `src/channels/plugins/types.adapters.ts`, `src/plugin-sdk/core.ts` |
| Provider contract | `src/plugin-sdk/provider-entry.ts`, `src/plugin-sdk/provider-auth.ts`, `src/plugin-sdk/provider-catalog-shared.ts`, `src/plugin-sdk/provider-model-shared.ts`, `src/plugins/types.ts` |
| Gateway protocol | `src/gateway/protocol/schema.ts`, `src/gateway/protocol/schema/*.ts`, `src/gateway/protocol/index.ts` |
| Bundled-plugin contract | `src/plugins/contracts/registry.ts`, `src/plugins/types.ts`, `src/plugins/*-public-artifacts.ts` (per-domain: provider, document-extractor, web-content-extractor, web-provider, provider-contract) |
| Config | exported config types + zod/schema surfaces + schema help/labels + generated metadata + config baselines + user-facing gateway/config payloads |

Per-package boundary guides (read when you touch the surface): `src/plugin-sdk/AGENTS.md`, `src/channels/AGENTS.md`, `src/plugins/AGENTS.md`, `src/gateway/protocol/AGENTS.md`, plus the bundled-plugin-tree `AGENTS.md`. Topology in `CHITTY.md`.

## Boundary rules

### Core stays extension-agnostic

- Adding a bundled or third-party extension MUST NOT require unrelated core edits just to teach core that the extension exists.
- No hardcoded extension/provider/channel/capability id lists, maps, or named special cases in core when a manifest, capability, registry, or plugin-owned contract can express the same behavior.
- No ad-hoc reads of `plugins.entries.<id>.config` from unrelated core code. Use a generic seam (`resolveSyntheticAuth`, public SDK helpers, manifest metadata, plugin auto-enable hooks) and honor plugin disablement plus `SecretRef` semantics.
- Vendor-owned tools and settings live in the owning plugin. Do not add provider-specific tool config, secret collection, or runtime enablement to core `tools.*` surfaces unless the tool is intentionally core-owned.
- Extension-owned compatibility behavior (legacy repairs, detection rules, onboarding, auth detection, provider defaults) belongs to the owning extension. Core may orchestrate generic doctor/config flows.
- For legacy config specifically, prefer doctor-owned repair paths over startup/load-time core migrations. Don't add new plugin-specific legacy migration logic to shared core/runtime surfaces when `openclaw doctor --fix` can own it.
- When a test asserts extension-specific behavior, keep that coverage in the owning extension when feasible. Core tests assert generic contracts and registry/capability behavior.

### Refactor trigger

If core code or tests name a specific extension/provider/channel for extension-owned behavior, refactor toward a generic registry/capability/plugin-owned seam. Don't add another special case.

### Extension-side rules

- Extensions cross into core ONLY through `openclaw/plugin-sdk/*`, manifest metadata, and documented runtime helpers. Do not import `src/**`, `src/plugin-sdk-internal/**`, or another extension's `src/**` from extension production code.
- Inside an extension package, do not import that same extension via `openclaw/plugin-sdk/<extension>`. Route internal imports through a local `./api.ts` or `./runtime-api.ts` barrel; keep the `plugin-sdk/<extension>` path as the external contract only.
- Inside a bundled plugin package, do not use relative imports/exports that resolve outside that package root. If shared code belongs in the plugin SDK, import `openclaw/plugin-sdk/<subpath>` instead of reaching into `src/plugin-sdk/**` or other repo paths via `../`.
- `openclaw/plugin-sdk/<subpath>` is the only public cross-package contract for extension-facing SDK code. If an extension needs a new seam, add a public subpath first; do not reach into `src/plugin-sdk/**` by relative path.
- Core code and tests must NOT deep-import bundled plugin internals (`src/**`, `onboard.js`). If core needs a helper, expose it through that plugin's `api.ts` and, when it's a real cross-package contract, through `src/plugin-sdk/<id>.ts`.

### Channel boundary

`src/channels/**` is core implementation, not a plugin contract. Plugin authors needing a new seam get it added to the Plugin SDK; do not point them at channel internals.

### Provider boundary

Core owns the generic inference loop. Provider plugins own provider-specific behavior through registration and typed hooks. Don't reach into unrelated core internals from provider code.

### Gateway protocol boundary

Protocol changes are contract changes. Prefer additive evolution. Incompatible changes require explicit versioning, docs, and client/codegen follow-through.

### Config contract

- Canonical public config = exported config types + zod/schema surfaces + schema help/labels + generated config metadata + config baselines + user-facing gateway/config payloads. Keep all aligned.
- Retiring a public config key removes it from every public surface above; backward compatibility lives only in raw-config migration / `openclaw doctor --fix`. Do not reintroduce removed legacy aliases into public types/schema/help/baselines "for convenience". If old configs still need to load, handle that in `legacy.migrations.*`, config ingest, or doctor.
- `hooks.internal.entries` is canonical; `hooks.internal.handlers` is compatibility-only input and must NOT be re-exposed in public schema/help/baseline surfaces.

### Bundled plugin contract

- Manifest metadata, runtime registration, public SDK exports, and contract tests must stay aligned. No hidden paths around the declared plugin interfaces.

## Compatibility commitments

- Third-party plugins exist in the wild. Don't break them casually.
- New plugin seams MUST be added as documented, backwards-compatible, versioned contracts.

## Prompt cache stability (correctness contract)

- Treat prompt-cache stability as correctness/perf-critical, not cosmetic.
- Code that assembles model or tool payloads from maps, sets, registries, plugin lists, MCP catalogs, filesystem reads, or network results MUST make ordering deterministic before building the request.
- Do not rewrite older transcript/history bytes on every turn unless intentionally invalidating the cached prefix. Legacy cleanup, pruning, normalization, and migration logic must preserve recent prompt bytes when possible.
- If truncation/compaction is required, mutate newest/tail content first so the cached prefix stays byte-identical for as long as possible.
- Cache-sensitive changes require a regression test proving turn-to-turn prefix stability or deterministic request assembly. Helper-local tests alone are insufficient.

## Test boundary contract

- Extension-owned coverage lives in the owning bundled plugin package when feasible.
- If core tests need bundled plugin behavior, consume it through public `src/plugin-sdk/<id>.ts` facades or the plugin's `api.ts`, not private extension modules.
- Core tests assert generic contracts and registry/capability behavior, not extension internals.

## Restricted surfaces

Files covered by security-focused `CODEOWNERS` rules: do not edit unless a listed owner explicitly asked or is reviewing with you. Treat those paths as restricted surfaces, not drive-by cleanup.

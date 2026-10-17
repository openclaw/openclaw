# Extensions Boundary

Bundled plugins. Same boundary as third-party plugins.

## Public Contracts

- Docs:
  - `docs/plugins/building-plugins.md`
  - `docs/plugins/architecture.md`
  - `docs/plugins/sdk-overview.md`
  - `docs/plugins/sdk-entrypoints.md`
  - `docs/plugins/sdk-runtime.md`
  - `docs/plugins/sdk-channel-plugins.md`
  - `docs/plugins/sdk-provider-plugins.md`
  - `docs/plugins/manifest.md`
- Definition files:
  - `src/plugin-sdk/plugin-entry.ts`
  - `src/plugin-sdk/core.ts`
  - `src/plugin-sdk/provider-entry.ts`
  - `src/plugin-sdk/channel-contract.ts`
  - `scripts/lib/plugin-sdk-entrypoints.json`
  - `package.json`

## Boundary Rules

- Extension production imports: `openclaw/plugin-sdk/*` + own local barrels (`./api.ts`, `./runtime-api.ts`).
- Never import core internals from `src/**`, `src/channels/**`, `src/plugin-sdk-internal/**`, or another extension's `src/**`.
- No relative imports escaping current extension package root.
- Accurate metadata in `openclaw.plugin.json` + package `openclaw` block: discovery/setup without executing plugin code.
- Plugin runtime dependencies → owning plugin package. Runtime peer: declare/provide in plugin `package.json`; never move to root unless root/package dist owns import. Runtime never installs deps; repair points = install/update/doctor.
- Package-ownership dependency assertions → generic contracts (`package-manifest.contract.test.ts`, `extension-runtime-dependencies.contract.test.ts`), not plugin e2e tests.
- `src/**`, `onboard.ts`, other local helpers private unless intentionally promoted through `api.ts` + matching `src/plugin-sdk/<id>.ts` facade if needed.
- Core/core tests needing bundled plugin helper: export from `api.ts` first, never deep-import extension internals.
- Provider auth, onboarding, catalog selection, vendor-only product behavior: plugin-local. Never move to core merely because two providers look similar.
- Before new provider-local `wrapStreamFn`, `buildReplayPolicy`, `normalizeToolSchemas`, `inspectToolSchemas`, or compat patch helper: check existing behavior via `openclaw/plugin-sdk/*`. Shared family helpers first.
- Two bundled providers sharing replay policy shape, tool-schema compat rewrite, payload patch, or stream-wrapper chain: stop copying. Extract shared helper + migrate both call sites in same change.
- Prefer named provider-family helpers over repeated raw option bags. OpenAI-style Anthropic tool payload compat, Gemini schema cleanup, XAI compat patch: named shared helper, never inline policy knobs again.
- Separate control-plane metadata/runtime logic. Discovery, config validation, setup hints, onboarding hints, activation planning: manifest/descriptors whenever possible.
- Setup truly needing runtime execution: explicit declared setup/runtime surface; never accidental runtime imports in metadata flows.
- Plugin work outliving originating caller/turn: active service-owned capability required. Never retain/extend caller-bound Gateway handles; revalidate service generation at effect boundary.
- Never eager global registry seeding/import-time side effects for plugin availability. Manifest ownership + targeted activation.
- Core hot-path plugin-owned static data: lightweight top-level artifact (`gateway-auth-api.ts`, `message-tool-api.ts`, similarly narrow `*-api.ts`). Artifact + full plugin reuse same local helper; fast paths must not drift from runtime behavior.

## Expanding The Boundary

- Changes to a shared SDK contract: use [plugin-sdk-impact](../.agents/skills/plugin-sdk-impact/SKILL.md) for public consumer evidence and coverage before proposing deprecation, removal, or incompatible behavior.
- Extension needing new seam: add/replace typed Plugin SDK subpath, never reach into core.
- ALL bundled plugins → modern SDK seams in same change. No extension-local compat paths for internal callers.
- First-party plugins always release together with the host: support only the current host version. No older-host fallbacks, capability probes or legacy adapters for released hosts. Third-party SDK compatibility follows the SDK deprecation policy instead.
- Intentional contract expansion: update docs, exported subpath list, package exports, API/contract checks in same change.

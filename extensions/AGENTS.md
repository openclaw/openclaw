# Extensions Boundary

Bundled plugins. Same boundary as third-party plugins.

## Public Contracts

- Docs:
  - `docs/plugins/building-plugins.md`
  - `docs/plugins/sdk-channel-plugins.md`
  - `docs/plugins/sdk-provider-plugins.md`
  - `docs/plugins/manifest.md`
- Definition files:
  - `src/plugin-sdk/channel-contract.ts`
- SDK docs and definition files: [SDK guide](../src/plugin-sdk/AGENTS.md).

## Boundary Rules

- Production imports: `openclaw/plugin-sdk/*` + own local barrels (`./api.ts`, `./runtime-api.ts`) only. Enforced by `pnpm lint:extensions:no-src-outside-plugin-sdk` and `pnpm lint:extensions:no-relative-outside-package`.
- Accurate metadata in `openclaw.plugin.json` + package `openclaw` block: discovery/setup without executing plugin code.
- Plugin runtime dependencies → owning plugin package. Runtime peer: declare/provide in plugin `package.json`; never move to root unless root/package dist owns import. Runtime never installs deps; repair points = install/update/doctor.
- Package-ownership dependency assertions → generic contracts (`package-manifest.contract.test.ts`, `extension-runtime-dependencies.contract.test.ts`), not plugin e2e tests.
- `src/**`, `onboard.ts`, other local helpers private unless intentionally promoted through `api.ts`. Core/core tests needing bundled plugin helper: import from `api.ts`, never deep-import extension internals.
- Provider auth, onboarding, catalog selection, vendor-only product behavior: plugin-local. Never move to core merely because two providers look similar. Host policy every provider shares (sign-in flow, native-runtime consent) stays core.
- Sign-in: the Models page and `/login <provider>` through the running Gateway, with no terminal-only step or restart. Setup persists the connection only; catalog rows (models, prices, effort lists) stay out of config and `models.json`.
- Native CLI runtimes (Claude Code, Codex, Copilot CLI, OpenCode): the CLI owns login, tokens and model menu. Read its status and menu; keep no token copies or static model tables.
- Classify provider refusals by cause (model unavailable, free tier/funding, auth expired, quota) and name the next step. Model-level refusals never prompt re-sign-in or cool down the key.
- Provider transport compat (`wrapStreamFn`, `buildReplayPolicy`, `normalizeToolSchemas`, `inspectToolSchemas`, payload patches): reuse a named shared `openclaw/plugin-sdk/*` family helper, never raw option bags or inline policy knobs (examples: OpenAI-style Anthropic tool payload compat, Gemini schema cleanup, XAI compat patch). Second copy: extract one helper and migrate both call sites in same change. Vendor attribution headers: one helper, on discovery and every transport.
- Plugin work outliving originating caller/turn: active service-owned capability required. Never retain/extend caller-bound Gateway handles; revalidate service generation at effect boundary.
- Never eager global registry seeding/import-time side effects for plugin availability. Manifest ownership + targeted activation (`src/plugins/contracts/runtime-import-side-effects.contract.test.ts`).
- Core hot-path plugin-owned static data: lightweight top-level artifact (`gateway-auth-api.ts`, `message-tool-api.ts`, similarly narrow `*-api.ts`). Artifact + full plugin reuse same local helper; fast paths must not drift from runtime behavior.

## Expanding The Boundary

- Extension needing new seam: add/replace typed Plugin SDK subpath, never reach into core.
- First-party plugins always release together with the host: support only the current host version. No older-host fallbacks, capability probes or legacy adapters for released hosts. Third-party SDK compatibility follows the SDK deprecation policy instead.
- Intentional contract expansion: follow [SDK guide](../src/plugin-sdk/AGENTS.md#expanding-the-boundary).

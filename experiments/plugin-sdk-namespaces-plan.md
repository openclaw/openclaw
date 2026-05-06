# Plugin SDK Namespaces Plan

## TL;DR

OpenClaw should introduce a few clear SDK namespaces like `plugin`, `channel`,
and `provider`, instead of keeping so much of the public surface flat.

The safe way to do that is:

- add thin ESM facade entrypoints, not TypeScript `namespace`
- keep the root `openclaw/plugin-sdk` surface small
- replace flat registration methods on `OpenClawPluginApi` with namespace groups
- ship the cutover in one coordinated release instead of dragging old flat APIs
  along
- forbid leaf modules from importing back through namespace facades

That gives plugin authors a cleaner SDK that feels closer to VS Code, without
turning the SDK into a giant barrel or creating circular import problems.

## Goal

Introduce public namespaces to the OpenClaw Plugin SDK so the surface feels
closer to the VS Code extension API, while keeping the implementation tight,
isolated, and resistant to circular imports.

This plan is about the public SDK shape. It is not a proposal to merge
everything into one giant barrel.

## Why This Is Worth Doing

Today the Plugin SDK has three visible problems:

- The public package export surface is large and mostly flat.
- `src/plugin-sdk/core.ts` and `src/plugin-sdk/index.ts` carry too many
  unrelated meanings.
- `OpenClawPluginApi` is still a flat registration API even though
  `api.runtime` already proves grouped namespaces work well.

The result is harder docs, harder discovery, and too many helper names that
look equally important even when they are not.

## Current Facts In The Repo

- Package exports are generated from a flat entrypoint list in
  `src/plugin-sdk/entrypoints.ts` and `scripts/lib/plugin-sdk-entrypoints.json`.
- The root `openclaw/plugin-sdk` entry is intentionally tiny in
  `src/plugin-sdk/index.ts`.
- `api.runtime` is already a successful namespace model. It groups behavior as
  `agent`, `subagent`, `media`, `imageGeneration`, `webSearch`, `tools`,
  `channel`, `events`, `logging`, `state`, `tts`, `mediaUnderstanding`, and
  `modelAuth` in `src/plugins/runtime/index.ts`.
- The main plugin registration API is still flat in `OpenClawPluginApi` in
  `src/plugins/types.ts`.
- The concrete API object is assembled in `src/plugins/registry.ts`, and a
  second partial copy exists in `src/plugins/captured-registration.ts`.

Those facts suggest a path that is low-risk:

- keep leaf modules as the source of truth
- add namespace facades on top
- cut docs, examples, and templates over in the same release as the namespace
  model

## Design Principles

### 1. Do Not Use TypeScript `namespace`

Use normal ESM modules and package exports.

The SDK already ships as package export subpaths. The namespace model should be
implemented as public facade modules, not TypeScript `namespace` syntax.

### 2. Keep The Root Tiny

Do not turn `openclaw/plugin-sdk` into a giant VS Code-style monolith.

The closest safe equivalent is:

- a tiny root for shared types and a few universal values
- a small number of explicit namespace entrypoints
- optional ergonomic aggregation only after the namespace surfaces settle

### 3. Namespace Facades Must Be Thin

Namespace entrypoints should contain no real business logic.

They should only:

- re-export stable leaves
- assemble small namespace objects

That keeps cycles and accidental coupling down.

### 4. Types Stay Direct And Easy To Import

Like VS Code, namespaces should mostly group behavior. Common types should stay
directly importable from the root or the owning domain surface.

Examples:

- `ChannelPlugin`
- `ProviderPlugin`
- `OpenClawPluginApi`
- `PluginRuntime`

### 5. Do Not Namespace Everything At Once

Only namespace areas that already have a clear public identity.

Phase 1 should focus on:

- `plugin`
- `channel`
- `provider`

`runtime` already has a good public namespace shape on `api.runtime` and should
not be reopened as a giant package-export family in the first pass.

## Proposed Public Model

### Namespace Entry Points

Canonical public entrypoints:

- `openclaw/plugin-sdk/plugin`
- `openclaw/plugin-sdk/channel`
- `openclaw/plugin-sdk/provider`
- `openclaw/plugin-sdk/runtime`
- `openclaw/plugin-sdk/testing`

What each should mean:

- `plugin`
  - plugin entry helpers
  - shared plugin definition helpers
  - plugin-facing config schema helpers that are truly universal
- `channel`
  - channel entry helpers
  - chat-channel builders
  - stable channel-facing contracts and helpers
- `provider`
  - provider entry helpers
  - auth, catalog, models, onboard, stream, usage, and provider registration helpers
- `runtime`
  - the existing `api.runtime` story and runtime-related public helpers that are
    truly stable
- `testing`
  - plugin author testing helpers

### Nested Leaves

Under those namespaces, the long-term canonical leaves should become nested:

- `openclaw/plugin-sdk/channel/setup`
- `openclaw/plugin-sdk/channel/pairing`
- `openclaw/plugin-sdk/channel/reply-pipeline`
- `openclaw/plugin-sdk/channel/contract`
- `openclaw/plugin-sdk/channel/targets`
- `openclaw/plugin-sdk/channel/actions`
- `openclaw/plugin-sdk/channel/inbound`
- `openclaw/plugin-sdk/channel/lifecycle`
- `openclaw/plugin-sdk/channel/policy`
- `openclaw/plugin-sdk/channel/feedback`
- `openclaw/plugin-sdk/channel/config-schema`
- `openclaw/plugin-sdk/channel/config-helpers`

- `openclaw/plugin-sdk/provider/auth`
- `openclaw/plugin-sdk/provider/catalog`
- `openclaw/plugin-sdk/provider/models`
- `openclaw/plugin-sdk/provider/onboard`
- `openclaw/plugin-sdk/provider/stream`
- `openclaw/plugin-sdk/provider/usage`
- `openclaw/plugin-sdk/provider/web-search`

Not every current flat subpath needs a namespaced replacement. The goal is to
promote the stable public domains, not to preserve every current export forever.

## What Happens To `core`

`core` is overloaded today. In a namespace model it should shrink, not grow.

Target split:

- plugin-wide entry helpers move toward `plugin`
- channel builders and channel-oriented shared helpers move toward `channel`
- `core` stops being a first-class public destination and shrinks to the
  smallest possible remaining shared surface

Rule: no new public API should be added to `core` once namespace entrypoints
exist.

## Proposed `OpenClawPluginApi` Shape

Keep context fields flat:

- `id`
- `name`
- `version`
- `description`
- `source`
- `rootDir`
- `registrationMode`
- `config`
- `pluginConfig`
- `runtime`
- `logger`
- `resolvePath`

Move registration behavior behind namespaces:

| Current flat method                  | Proposed namespace location               |
| ------------------------------------ | ----------------------------------------- |
| `registerTool`                       | `api.tool.register`                       |
| `registerHook`                       | `api.hook.register`                       |
| `on`                                 | `api.hook.on`                             |
| `registerHttpRoute`                  | `api.http.registerRoute`                  |
| `registerChannel`                    | `api.channel.register`                    |
| `registerProvider`                   | `api.provider.register`                   |
| `registerSpeechProvider`             | `api.provider.registerSpeech`             |
| `registerMediaUnderstandingProvider` | `api.provider.registerMediaUnderstanding` |
| `registerImageGenerationProvider`    | `api.provider.registerImageGeneration`    |
| `registerWebSearchProvider`          | `api.provider.registerWebSearch`          |
| `registerGatewayMethod`              | `api.gateway.registerMethod`              |
| `registerCli`                        | `api.cli.register`                        |
| `registerService`                    | `api.service.register`                    |
| `registerInteractiveHandler`         | `api.interactive.register`                |
| `registerCommand`                    | `api.command.register`                    |
| `registerContextEngine`              | `api.contextEngine.register`              |
| `registerMemoryPromptSection`        | `api.memory.registerPromptSection`        |

The cutover should replace the flat methods in one coordinated change.

That gives plugin authors a clearer public shape and avoids carrying two public
registration models at the same time.

## Example Public Usage

Proposed style:

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin";
import { channel } from "openclaw/plugin-sdk/channel";
import { provider } from "openclaw/plugin-sdk/provider";
import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";

const chatPlugin: ChannelPlugin = channel.createChatPlugin({
  id: "demo",
  /* ... */
});

export default definePluginEntry({
  id: "demo",
  register(api: OpenClawPluginApi) {
    api.channel.register(chatPlugin);
    api.command.register({
      name: "status",
      description: "Show plugin status",
      run: async () => ({ text: "ok" }),
    });
  },
});
```

This is close to the VS Code mental model:

- grouped behavior
- direct types
- obvious public areas

without requiring a single monolithic root import.

## Optional Ergonomic Surface

If the project later wants the closest possible VS Code feel, add a dedicated
opt-in facade such as `openclaw/plugin-sdk/sdk`.

That facade can assemble:

- `plugin`
- `channel`
- `provider`
- `runtime`
- `testing`

It should not be phase 1.

Why:

- it is the highest-risk barrel from a cycle and weight perspective
- it is easier to add once the namespace surfaces already exist
- it preserves the root `openclaw/plugin-sdk` entry as a small type-oriented
  surface

## Internal Implementation Rules

These rules are the important part. Without them, namespaces will rot into
barrels and cycles.

### Rule 1: Namespace Facades Are One-Way

Namespace entrypoints may import leaf modules.

Leaf modules may not import their namespace entrypoint.

Examples:

- allowed: `src/plugin-sdk/channel.ts` importing `./channel-setup.ts`
- forbidden: `src/plugin-sdk/channel-setup.ts` importing `./channel.ts`

### Rule 1A: Allowed Dependency Directions Must Be Explicit

The allowed directions should be:

- namespace facade -> leaves in the same namespace
- leaf -> local implementation helpers
- leaf -> dedicated shared internal leaf
- leaf -> another leaf in the same namespace only by direct relative import,
  never through the namespace facade

The forbidden directions should be:

- leaf -> its own namespace facade
- leaf -> another namespace facade
- namespace facade -> another namespace facade
- channel leaf -> provider leaf, or provider leaf -> channel leaf, unless the
  dependency is first extracted into a shared internal leaf

Short version:

- facades point downward
- leaves never point back upward
- cross-namespace sharing must go sideways through a shared internal leaf, not
  directly through another public namespace

### Rule 1B: If Two Namespaces Need Each Other, Extract A Shared Leaf

If `channel` and `provider` start needing each other directly, that is the sign
that the seam is wrong.

Do not allow:

- `src/plugin-sdk/channel/*` importing from `src/plugin-sdk/provider/*`
- `src/plugin-sdk/provider/*` importing from `src/plugin-sdk/channel/*`

Instead:

- extract the shared logic into a dedicated internal leaf
- let both sides depend on that leaf
- keep the public namespaces separate

This is the main cycle-prevention rule. Shared logic moves to a lower layer
before it creates a back-edge.

### Rule 2: No Public-Specifier Self-Imports Inside The SDK

Files inside `src/plugin-sdk/**` should never import from
`openclaw/plugin-sdk/...`.

They should import local source files directly.

### Rule 3: Shared Code Lives In Shared Leaves

If `channel` and `provider` need the same implementation detail, move that code
to a shared leaf instead of importing one namespace from the other.

Good shared homes:

- a dedicated internal shared leaf
- a very small shared core leaf only if it has a precise, stable reason to
  exist
- existing domain-neutral helpers

Bad pattern:

- `provider/*` importing from `channel/index`
- `channel/*` importing from `provider/index`

### Rule 4: Assemble The API Surface Once

`OpenClawPluginApi` should be built by one canonical factory.

`src/plugins/registry.ts` and `src/plugins/captured-registration.ts` should stop
hand-building separate versions of the API object.

That factory can expose:

- the namespaced shape only

from the same underlying implementation.

### Rule 5: Namespace Entry Files Stay Small

Namespace facades should stay close to pure exports. If a namespace file grows
real orchestration logic, split that logic back into leaf modules.

### Dependency Shape

The intended import graph is:

```text
public facade
  -> same-namespace leaves
    -> local helpers
    -> shared internal leaves
```

Not this:

```text
channel facade -> provider facade
channel leaf -> channel facade
provider leaf -> channel leaf
```

Concrete examples:

- allowed: `src/plugin-sdk/channel.ts` -> `./channel/setup.ts`
- allowed: `src/plugin-sdk/channel/setup.ts` -> `./_internal/channel-shared.ts`
- allowed: `src/plugin-sdk/provider/auth.ts` -> `../_internal/provider-shared.ts`
- forbidden: `src/plugin-sdk/channel/setup.ts` -> `./channel.ts`
- forbidden: `src/plugin-sdk/channel/setup.ts` -> `../provider/index.ts`
- forbidden: `src/plugin-sdk/channel.ts` -> `./provider.ts`

## Migration Strategy

This should be a cutover, not a long overlap period.

That means:

- one coordinated release
- one migration guide
- one docs/templates/test update
- one public SDK shape after the release

## Phase 1: Extract The Canonical API Builder

Do this first, before changing the public surface.

Why:

- it removes duplicated API assembly
- it gives one place to switch the public shape
- it reduces cutover risk

Implementation:

- extract one canonical API builder from `src/plugins/registry.ts` and
  `src/plugins/captured-registration.ts`
- make that builder assemble the new namespaced registration API

## Phase 2: Add Canonical Namespace Entrypoints

Add:

- `plugin`
- `channel`
- `provider`

as thin public facades over existing flat leaves.

Implementation detail:

- the first pass can re-export current flat files
- do not move source layout and package exports in the same commit if it can be
  avoided

Examples:

- `src/plugin-sdk/channel/setup.ts` can initially re-export from
  `../channel-setup.js`
- `src/plugin-sdk/provider/auth.ts` can initially re-export from
  `../provider-auth.js`

This lets the public namespace story land before the internal source move,
without forcing all implementation files to move in the same commit.

## Phase 3: Cut Public API, Docs, And Templates Together

In the same release:

- docs prefer namespaced entrypoints
- templates prefer namespaced imports
- tests and examples switch to the namespaced shape
- `OpenClawPluginApi` changes to the namespaced registration model
- flat registration methods are removed instead of carried as aliases

## Phase 4: Remove The Old Public Story

After the cutover release lands:

- stop documenting superseded flat leaves as public API
- keep only the namespace model in author-facing docs
- remove any leftover flat registration surface that survived only as
  transitional scaffolding during implementation

## What Should Not Be Namespaced In Phase 1

To keep the refactor tight, do not force these into the first milestone:

- every `*-runtime` helper subpath
- extension-branded public subpaths
- one-off utilities that do not yet have a stable domain home
- the root `openclaw/plugin-sdk` barrel

If a subpath is only public because history leaked it, namespace work should not
promote it.

## Guardrails And Validation

The namespace rollout should ship with explicit checks.

### Existing Checks To Reuse

- `src/plugin-sdk/subpaths.test.ts`
- `src/plugin-sdk/runtime-api-guardrails.test.ts`
- `pnpm build` for `[CIRCULAR_REEXPORT]` warnings
- `pnpm plugin-sdk:api:check`

### New Checks To Add

- namespace facade files may only re-export or compose approved leaves
- leaf files under a namespace may not import their parent `index` facade
- leaf files under one namespace may not import another namespace facade
- cross-namespace leaf imports should fail unless the target is an approved
  shared internal leaf
- namespace facades may not import other namespace facades
- no new API should be added to `core` once namespace facades exist
- `OpenClawPluginApi` must not expose both flat and namespaced registration
  methods after cutover

## Recommended End State

The elegant end state is:

- a tiny root
- a few first-class namespaces
- direct types
- a grouped `api` registration surface
- stable leaves under each namespace
- no reverse imports from leaves back into namespace facades

That gives OpenClaw a VS Code-like feel where the public SDK has clear domains,
but still respects the repo's existing build, lazy-loading, and package-boundary
constraints.

## Short Recommendation

If this work starts soon, the first implementation step should be:

1. extract one canonical `OpenClawPluginApi` builder
2. switch that builder to the namespaced registration shape
3. add `plugin`, `channel`, and `provider` facade entrypoints
4. cut docs, templates, and examples over in the same release
5. remove the old flat registration story instead of maintaining dual public APIs

That sequence keeps the refactor elegant and minimizes the chance that
namespaces become another layer of accidental coupling.

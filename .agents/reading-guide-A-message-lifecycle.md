# Reading Guide A — Message Lifecycle (bird's-eye tour)

Use case: follow a single inbound message: channel extension -> plugin loader -> plugin-sdk seam -> channel core -> gateway protocol -> agent -> outbound streaming. Open each stop at the barrel/entry level only. Do not dive into implementations on this pass.

## 1. Channel extension (representative)

Path: `extensions/telegram/`

- Role: one bundled plugin that adapts an external messaging surface into OpenClaw.
- Public seams visible at top level: `api.ts`, `runtime-api.ts`, `openclaw.plugin.json`, `package.json` (plus `src/` for internals — do not open yet).
- What to look for:
  - Which symbols the plugin re-exports through `api.ts` vs lazy-only `runtime-api.ts`.
  - How `openclaw.plugin.json` declares capabilities/contracts (manifest-first control plane).
  - Where the line sits between "config / metadata" and "runtime behavior".

## 2. Plugin loader + registry

Path: `src/plugins/loader.ts`, `src/plugins/registry-types.ts`

- Role: discovers plugin manifests, wires bundled plugins, exposes them to core.
- Correction: there is no plain `registry.ts`; the registry surface is split across `registry-types.ts` and `registry-empty.ts` (plus many `*-registry.ts` siblings such as `channel-catalog-registry.ts`).
- What to look for:
  - How a manifest becomes a live registration.
  - Which registrations are transitional "broad mutable" lists vs manifest-declared.
  - Where third-party plugins would hook in (no hidden paths).

## 3. Plugin SDK public barrels

Path: `src/plugin-sdk/index.ts`

- Role: the only seam plugins are allowed to import from core.
- Confirmed siblings: `core.ts`, `channel-setup.ts`, `channel-streaming.ts` (all exist).
- What to look for:
  - Which concrete types a channel plugin receives at setup time.
  - Where streaming primitives are shaped so plugins don't touch channel internals.
  - Any "deprecated / versioned" exports that hint at contract evolution.

Ref: `src/plugin-sdk/channel-streaming.ts:1`

## 4. Channel core

Path: `src/channels/`

- Role: in-core support for channel bindings, sessions, allowlists, draft streaming — independent of any one messaging surface.
- Shape note: flat TS files, no per-channel subdirectories; per-surface code lives in `extensions/`. A `plugins/` subfolder holds core-side plugin glue.
- What to look for:
  - Seams named `channel-*` that mirror SDK barrels (e.g. `draft-stream-loop.ts`, `session.ts`, `registry.ts`).
  - Boundaries that must stay extension-agnostic.
  - Where inbound debounce / run-state / conversation-binding live — these gate whether a message reaches an agent.

## 5. Gateway protocol

Path: `src/gateway/protocol/index.ts`, `src/gateway/protocol/schema.ts`

- Role: wire contract between gateway client and server.
- What to look for:
  - Which frame/session/push/command files under `schema/` own versioned shapes.
  - Whether a change is additive (safe) or incompatible (needs versioning + docs + client follow-through).
  - `src/gateway/protocol/AGENTS.md` for the rules before proposing any change.

## 6. Agent entry

Path: `src/agents/agent-command.ts`

- Role: command dispatch into the agent runtime / inference loop for a resolved session.
- Correction: there is no `agent-runtime.ts` at the top of `src/agents/`; start from `agent-command.ts` and follow its imports into `agent-harness.ts`, `agent-runtime-config.ts`, and the transport-stream files.
- What to look for:
  - How a channel-delivered payload becomes an agent invocation.
  - Where provider-specific vs generic inference-loop code split.
  - Hooks that the outbound stream will later reconnect to.

## 7. Streaming contract

Path: `docs/concepts/streaming.md`

- Role: declares that external messaging surfaces MUST NOT emit token-delta channel messages; previews/blocks use message edits/chunks with final/fallback delivery.
- Why this matters here: the outbound half of Use Case A only makes sense once you internalize this rule — it's the invariant the channel/SDK streaming seams exist to enforce.

## 3 friction questions to collect while reading

Fill these in as you go; they become good PRs or docs later.

1. Where (if anywhere) does core still special-case a bundled channel/provider id that a manifest field could express?
2. Which "broad mutable registry" in `src/plugins/` feels transitional, and what manifest-declared replacement would retire it?
3. Where does the inbound path decide to drop/debounce a message before any agent sees it — and is that decision observable in logs?

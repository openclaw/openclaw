---
summary: "OpenClaw plugins/extensions: discovery, config, and safety"
read_when:
  - Adding or modifying plugins/extensions
  - Documenting plugin install or load rules
title: "Plugins"
---

# Plugins (Extensions)

## Quick start (new to plugins?)

A plugin is just a **small code module** that extends OpenClaw with extra
features (commands, tools, and Gateway RPC).

Most of the time, you’ll use plugins when you want a feature that’s not built
into core OpenClaw yet (or you want to keep optional features out of your main
install).

Fast path:

1. See what’s already loaded:

```bash
openclaw plugins list
```

2. Install an official plugin (example: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

Npm specs are **registry-only** (package name + optional **exact version** or
**dist-tag**). Git/URL/file specs and semver ranges are rejected.

Bare specs and `@latest` stay on the stable track. If npm resolves either of
those to a prerelease, OpenClaw stops and asks you to opt in explicitly with a
prerelease tag such as `@beta`/`@rc` or an exact prerelease version.

3. Restart the Gateway, then configure under `plugins.entries.<id>.config`.

See [Voice Call](/plugins/voice-call) for a concrete example plugin.
Looking for third-party listings? See [Community plugins](/plugins/community).

## Architecture

OpenClaw's plugin system has four layers:

1. **Manifest + discovery**
   OpenClaw finds candidate plugins from configured paths, workspace roots,
   global extension roots, and bundled extensions. Discovery reads
   `openclaw.plugin.json` plus package metadata first.
2. **Enablement + validation**
   Core decides whether a discovered plugin is enabled, disabled, blocked, or
   selected for an exclusive slot such as memory.
3. **Runtime loading**
   Enabled plugins are loaded in-process via jiti and register capabilities into
   a central registry.
4. **Surface consumption**
   The rest of OpenClaw reads the registry to expose tools, channels, provider
   setup, hooks, HTTP routes, CLI commands, and services.

The important design boundary:

- discovery + config validation should work from **manifest/schema metadata**
  without executing plugin code
- runtime behavior comes from the plugin module's `register(api)` path

That split lets OpenClaw validate config, explain missing/disabled plugins, and
build UI/schema hints before the full runtime is active.

## Execution model

Plugins run **in-process** with the Gateway. They are not sandboxed. A loaded
plugin has the same process-level trust boundary as core code.

Implications:

- a plugin can register tools, network handlers, hooks, and services
- a plugin bug can crash or destabilize the gateway
- a malicious plugin is equivalent to arbitrary code execution inside the
  OpenClaw process

Use allowlists and explicit install/load paths for non-bundled plugins. Treat
workspace plugins as development-time code, not production defaults.

Important trust note:

- `plugins.allow` trusts **plugin ids**, not source provenance.
- A workspace plugin with the same id as a bundled plugin intentionally shadows
  the bundled copy when that workspace plugin is enabled/allowlisted.
- This is normal and useful for local development, patch testing, and hotfixes.

## Available plugins (official)

- Microsoft Teams is plugin-only as of 2026.1.15; install `@openclaw/msteams` if you use Teams.
- Memory (Core) — bundled memory search plugin (enabled by default via `plugins.slots.memory`)
- Memory (LanceDB) — bundled long-term memory plugin (auto-recall/capture; set `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (provider auth) — bundled as `google-antigravity-auth` (disabled by default)
- Gemini CLI OAuth (provider auth) — bundled as `google-gemini-cli-auth` (disabled by default)
- GitHub Copilot provider runtime — bundled as `github-copilot` (enabled by default)
- OpenAI Codex provider runtime — bundled as `openai-codex` (enabled by default)
- OpenRouter provider runtime — bundled as `openrouter` (enabled by default)
- Qwen OAuth (provider auth) — bundled as `qwen-portal-auth` (disabled by default)
- Copilot Proxy (provider auth) — local VS Code Copilot Proxy bridge; distinct from built-in `github-copilot` device login (bundled, disabled by default)

OpenClaw plugins are **TypeScript modules** loaded at runtime via jiti. **Config
validation does not execute plugin code**; it uses the plugin manifest and JSON
Schema instead. See [Plugin manifest](/plugins/manifest).

Plugins can register:

- Gateway RPC methods
- Gateway HTTP routes
- Agent tools
- CLI commands
- Background services
- Context engines
- Provider auth flows and model catalogs
- Provider runtime hooks for dynamic model ids, transport normalization, capability metadata, stream wrapping, cache TTL policy, and runtime auth exchange
- Optional config validation
- **Skills** (by listing `skills` directories in the plugin manifest)
- **Auto-reply commands** (execute without invoking the AI agent)

Plugins run **in‑process** with the Gateway, so treat them as trusted code.
Tool authoring guide: [Plugin agent tools](/plugins/agent-tools).

## Provider runtime hooks

Provider plugins now have two layers:

- config-time hooks: `catalog` / legacy `discovery`
- runtime hooks: `resolveDynamicModel`, `prepareDynamicModel`, `normalizeResolvedModel`, `capabilities`, `prepareExtraParams`, `wrapStreamFn`, `isCacheTtlEligible`, `prepareRuntimeAuth`

OpenClaw still owns the generic agent loop, failover, transcript handling, and
tool policy. These hooks are the seam for provider-specific behavior without
needing a whole custom inference transport.

### Hook order

For model/provider plugins, OpenClaw uses hooks in this rough order:

1. `catalog`
   Publish provider config into `models.providers` during `models.json`
   generation.
2. built-in/discovered model lookup
   OpenClaw tries the normal registry/catalog path first.
3. `resolveDynamicModel`
   Sync fallback for provider-owned model ids that are not in the local
   registry yet.
4. `prepareDynamicModel`
   Async warm-up only on async model resolution paths, then
   `resolveDynamicModel` runs again.
5. `normalizeResolvedModel`
   Final rewrite before the embedded runner uses the resolved model.
6. `capabilities`
   Provider-owned transcript/tooling metadata used by shared core logic.
7. `prepareExtraParams`
   Provider-owned request-param normalization before generic stream option wrappers.
8. `wrapStreamFn`
   Provider-owned stream wrapper after generic wrappers are applied.
9. `isCacheTtlEligible`
   Provider-owned prompt-cache policy for proxy/backhaul providers.
10. `prepareRuntimeAuth`
    Exchanges a configured credential into the actual runtime token/key just
    before inference.

### Which hook to use

- `catalog`: publish provider config and model catalogs into `models.providers`
- `resolveDynamicModel`: handle pass-through or forward-compat model ids that are not in the local registry yet
- `prepareDynamicModel`: async warm-up before retrying dynamic resolution (for example refresh provider metadata cache)
- `normalizeResolvedModel`: rewrite a resolved model's transport/base URL/compat before inference
- `capabilities`: publish provider-family and transcript/tooling quirks without hardcoding provider ids in core
- `prepareExtraParams`: set provider defaults or normalize provider-specific per-model params before generic stream wrapping
- `wrapStreamFn`: add provider-specific headers/payload/model compat patches while still using the normal `pi-ai` execution path
- `isCacheTtlEligible`: decide whether provider/model pairs should use cache TTL metadata
- `prepareRuntimeAuth`: exchange a configured credential into the actual short-lived runtime token/key used for requests

Rule of thumb:

- provider owns a catalog or base URL defaults: use `catalog`
- provider accepts arbitrary upstream model ids: use `resolveDynamicModel`
- provider needs network metadata before resolving unknown ids: add `prepareDynamicModel`
- provider needs transport rewrites but still uses a core transport: use `normalizeResolvedModel`
- provider needs transcript/provider-family quirks: use `capabilities`
- provider needs default request params or per-provider param cleanup: use `prepareExtraParams`
- provider needs request headers/body/model compat wrappers without a custom transport: use `wrapStreamFn`
- provider needs proxy-specific cache TTL gating: use `isCacheTtlEligible`
- provider needs a token exchange or short-lived request credential: use `prepareRuntimeAuth`

If the provider needs a fully custom wire protocol or custom request executor,
that is a different class of extension. These hooks are for provider behavior
that still runs on OpenClaw's normal inference loop.

### Example

```ts
api.registerProvider({
  id: "example-proxy",
  label: "Example Proxy",
  auth: [],
  catalog: {
    order: "simple",
    run: async (ctx) => {
      const apiKey = ctx.resolveProviderApiKey("example-proxy").apiKey;
      if (!apiKey) {
        return null;
      }
      return {
        provider: {
          baseUrl: "https://proxy.example.com/v1",
          apiKey,
          api: "openai-completions",
          models: [{ id: "auto", name: "Auto" }],
        },
      };
    },
  },
  resolveDynamicModel: (ctx) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "example-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }),
  prepareRuntimeAuth: async (ctx) => {
    const exchanged = await exchangeToken(ctx.apiKey);
    return {
      apiKey: exchanged.token,
      baseUrl: exchanged.baseUrl,
      expiresAt: exchanged.expiresAt,
    };
  },
});
```

### Built-in examples

- OpenRouter uses `catalog` plus `resolveDynamicModel` and
  `prepareDynamicModel` because the provider is pass-through and may expose new
  model ids before OpenClaw's static catalog updates.
- GitHub Copilot uses `catalog`, `resolveDynamicModel`, and
  `capabilities` plus `prepareRuntimeAuth` because it needs model fallback
  behavior, Claude transcript quirks, and a GitHub token -> Copilot token exchange.
- OpenAI Codex uses `catalog`, `resolveDynamicModel`, and
  `normalizeResolvedModel` plus `prepareExtraParams` because it still runs on
  core OpenAI transports but owns its transport/base URL normalization and
  default transport choice.
- OpenRouter uses `capabilities`, `wrapStreamFn`, and `isCacheTtlEligible`
  to keep provider-specific request headers, routing metadata, reasoning
  patches, and prompt-cache policy out of core.

## Load pipeline

At startup, OpenClaw does roughly this:

1. discover candidate plugin roots
2. read `openclaw.plugin.json` and package metadata
3. reject unsafe candidates
4. normalize plugin config (`plugins.enabled`, `allow`, `deny`, `entries`,
   `slots`, `load.paths`)
5. decide enablement for each candidate
6. load enabled modules via jiti
7. call `register(api)` and collect registrations into the plugin registry
8. expose the registry to commands/runtime surfaces

The safety gates happen **before** runtime execution. Candidates are blocked
when the entry escapes the plugin root, the path is world-writable, or path
ownership looks suspicious for non-bundled plugins.

### Manifest-first behavior

The manifest is the control-plane source of truth. OpenClaw uses it to:

- identify the plugin
- discover declared channels/skills/config schema
- validate `plugins.entries.<id>.config`
- augment Control UI labels/placeholders
- show install/catalog metadata

The runtime module is the data-plane part. It registers actual behavior such as
hooks, tools, commands, or provider flows.

### What the loader caches

OpenClaw keeps short in-process caches for:

- discovery results
- manifest registry data
- loaded plugin registries

These caches reduce bursty startup and repeated command overhead. They are safe
to think of as short-lived performance caches, not persistence.

## Runtime helpers

Plugins can access selected core helpers via `api.runtime`. For telephony TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Notes:

- Uses core `messages.tts` configuration (OpenAI or ElevenLabs).
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- Edge TTS is not supported for telephony.

For STT/transcription, plugins can call:

```ts
const { text } = await api.runtime.stt.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // Optional when MIME cannot be inferred reliably:
  mime: "audio/ogg",
});
```

Notes:

- Uses core media-understanding audio configuration (`tools.media.audio`) and provider fallback order.
- Returns `{ text: undefined }` when no transcription output is produced (for example skipped/unsupported input).

## Gateway HTTP routes

Plugins can expose HTTP endpoints with `api.registerHttpRoute(...)`.

```ts
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",
  match: "exact",
  handler: async (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;
  },
});
```

Route fields:

- `path`: route path under the gateway HTTP server.
- `auth`: required. Use `"gateway"` to require normal gateway auth, or `"plugin"` for plugin-managed auth/webhook verification.
- `match`: optional. `"exact"` (default) or `"prefix"`.
- `replaceExisting`: optional. Allows the same plugin to replace its own existing route registration.
- `handler`: return `true` when the route handled the request.

Notes:

- `api.registerHttpHandler(...)` is obsolete. Use `api.registerHttpRoute(...)`.
- Plugin routes must declare `auth` explicitly.
- Exact `path + match` conflicts are rejected unless `replaceExisting: true`, and one plugin cannot replace another plugin's route.
- Overlapping routes with different `auth` levels are rejected. Keep `exact`/`prefix` fallthrough chains on the same auth level only.

## Plugin SDK import paths

Use SDK subpaths instead of the monolithic `openclaw/plugin-sdk` import when
authoring plugins:

- `openclaw/plugin-sdk/core` for generic plugin APIs, provider auth types, and shared helpers.
- `openclaw/plugin-sdk/compat` for bundled/internal plugin code that needs broader shared runtime helpers than `core`.
- `openclaw/plugin-sdk/telegram` for Telegram channel plugins.
- `openclaw/plugin-sdk/discord` for Discord channel plugins.
- `openclaw/plugin-sdk/slack` for Slack channel plugins.
- `openclaw/plugin-sdk/signal` for Signal channel plugins.
- `openclaw/plugin-sdk/imessage` for iMessage channel plugins.
- `openclaw/plugin-sdk/whatsapp` for WhatsApp channel plugins.
- `openclaw/plugin-sdk/line` for LINE channel plugins.
- `openclaw/plugin-sdk/msteams` for the bundled Microsoft Teams plugin surface.
- Bundled extension-specific subpaths are also available:
  `openclaw/plugin-sdk/acpx`, `openclaw/plugin-sdk/bluebubbles`,
  `openclaw/plugin-sdk/copilot-proxy`, `openclaw/plugin-sdk/device-pair`,
  `openclaw/plugin-sdk/diagnostics-otel`, `openclaw/plugin-sdk/diffs`,
  `openclaw/plugin-sdk/feishu`,
  `openclaw/plugin-sdk/google-gemini-cli-auth`, `openclaw/plugin-sdk/googlechat`,
  `openclaw/plugin-sdk/irc`, `openclaw/plugin-sdk/llm-task`,
  `openclaw/plugin-sdk/lobster`, `openclaw/plugin-sdk/matrix`,
  `openclaw/plugin-sdk/mattermost`, `openclaw/plugin-sdk/memory-core`,
  `openclaw/plugin-sdk/memory-lancedb`,
  `openclaw/plugin-sdk/minimax-portal-auth`,
  `openclaw/plugin-sdk/nextcloud-talk`, `openclaw/plugin-sdk/nostr`,
  `openclaw/plugin-sdk/open-prose`, `openclaw/plugin-sdk/phone-control`,
  `openclaw/plugin-sdk/qwen-portal-auth`, `openclaw/plugin-sdk/synology-chat`,
  `openclaw/plugin-sdk/talk-voice`, `openclaw/plugin-sdk/test-utils`,
  `openclaw/plugin-sdk/thread-ownership`, `openclaw/plugin-sdk/tlon`,
  `openclaw/plugin-sdk/twitch`, `openclaw/plugin-sdk/voice-call`,
  `openclaw/plugin-sdk/zalo`, and `openclaw/plugin-sdk/zalouser`.

## Provider catalogs

Provider plugins can define model catalogs for inference with
`registerProvider({ catalog: { run(...) { ... } } })`.

`catalog.run(...)` returns the same shape OpenClaw writes into
`models.providers`:

- `{ provider }` for one provider entry
- `{ providers }` for multiple provider entries

Use `catalog` when the plugin owns provider-specific model ids, base URL
defaults, or auth-gated model metadata.

`catalog.order` controls when a plugin's catalog merges relative to OpenClaw's
built-in implicit providers:

- `simple`: plain API-key or env-driven providers
- `profile`: providers that appear when auth profiles exist
- `paired`: providers that synthesize multiple related provider entries
- `late`: last pass, after other implicit providers

Later providers win on key collision, so plugins can intentionally override a
built-in provider entry with the same provider id.

Compatibility:

- `discovery` still works as a legacy alias
- if both `catalog` and `discovery` are registered, OpenClaw uses `catalog`

Compatibility note:

- `openclaw/plugin-sdk` remains supported for existing external plugins.
- New and migrated bundled plugins should use channel or extension-specific
  subpaths; use `core` for generic surfaces and `compat` only when broader
  shared helpers are required.

## Read-only channel inspection

If your plugin registers a channel, prefer implementing
`plugin.config.inspectAccount(cfg, accountId)` alongside `resolveAccount(...)`.

Why:

- `resolveAccount(...)` is the runtime path. It is allowed to assume credentials
  are fully materialized and can fail fast when required secrets are missing.
- Read-only command paths such as `openclaw status`, `openclaw status --all`,
  `openclaw channels status`, `openclaw channels resolve`, and doctor/config
  repair flows should not need to materialize runtime credentials just to
  describe configuration.

Recommended `inspectAccount(...)` behavior:

- Return descriptive account state only.
- Preserve `enabled` and `configured`.
- Include credential source/status fields when relevant, such as:
  - `tokenSource`, `tokenStatus`
  - `botTokenSource`, `botTokenStatus`
  - `appTokenSource`, `appTokenStatus`
  - `signingSecretSource`, `signingSecretStatus`
- You do not need to return raw token values just to report read-only
  availability. Returning `tokenStatus: "available"` (and the matching source
  field) is enough for status-style commands.
- Use `configured_unavailable` when a credential is configured via SecretRef but
  unavailable in the current command path.

This lets read-only commands report “configured but unavailable in this command
path” instead of crashing or misreporting the account as not configured.

Performance note:

- Plugin discovery and manifest metadata use short in-process caches to reduce
  bursty startup/reload work.
- Set `OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE=1` or
  `OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE=1` to disable these caches.
- Tune cache windows with `OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS` and
  `OPENCLAW_PLUGIN_MANIFEST_CACHE_MS`.

## Discovery & precedence

OpenClaw scans, in order:

1. Config paths

- `plugins.load.paths` (file or directory)

2. Workspace extensions

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Global extensions

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Bundled extensions (shipped with OpenClaw, mostly disabled by default)

- `<openclaw>/extensions/*`

Most bundled plugins must be enabled explicitly via
`plugins.entries.<id>.enabled` or `openclaw plugins enable <id>`.

Default-on bundled plugin exceptions:

- `device-pair`
- `phone-control`
- `talk-voice`
- active memory slot plugin (default slot: `memory-core`)

Installed plugins are enabled by default, but can be disabled the same way.

Workspace plugins are **disabled by default** unless you explicitly enable them
or allowlist them. This is intentional: a checked-out repo should not silently
become production gateway code.

Hardening notes:

- If `plugins.allow` is empty and non-bundled plugins are discoverable, OpenClaw logs a startup warning with plugin ids and sources.
- Candidate paths are safety-checked before discovery admission. OpenClaw blocks candidates when:
  - extension entry resolves outside plugin root (including symlink/path traversal escapes),
  - plugin root/source path is world-writable,
  - path ownership is suspicious for non-bundled plugins (POSIX owner is neither current uid nor root).
- Loaded non-bundled plugins without install/load-path provenance emit a warning so you can pin trust (`plugins.allow`) or install tracking (`plugins.installs`).

Each plugin must include a `openclaw.plugin.json` file in its root. If a path
points at a file, the plugin root is the file's directory and must contain the
manifest.

If multiple plugins resolve to the same id, the first match in the order above
wins and lower-precedence copies are ignored.

That means:

- workspace plugins intentionally shadow bundled plugins with the same id
- `plugins.allow: ["foo"]` authorizes the active `foo` plugin by id, even when
  the active copy comes from the workspace instead of the bundled extension root
- if you need stricter provenance control, use explicit install/load paths and
  inspect the resolved plugin source before enabling it

### Enablement rules

Enablement is resolved after discovery:

- `plugins.enabled: false` disables all plugins
- `plugins.deny` always wins
- `plugins.entries.<id>.enabled: false` disables that plugin
- workspace-origin plugins are disabled by default
- allowlists restrict the active set when `plugins.allow` is non-empty
- allowlists are **id-based**, not source-based
- bundled plugins are disabled by default unless:
  - the bundled id is in the built-in default-on set, or
  - you explicitly enable it, or
  - channel config implicitly enables the bundled channel plugin
- exclusive slots can force-enable the selected plugin for that slot

In current core, bundled default-on ids include local/provider helpers such as
`ollama`, `sglang`, `vllm`, plus `device-pair`, `phone-control`, and
`talk-voice`.

### Package packs

A plugin directory may include a `package.json` with `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

If your plugin imports npm deps, install them in that directory so
`node_modules` is available (`npm install` / `pnpm install`).

Security guardrail: every `openclaw.extensions` entry must stay inside the plugin
directory after symlink resolution. Entries that escape the package directory are
rejected.

Security note: `openclaw plugins install` installs plugin dependencies with
`npm install --ignore-scripts` (no lifecycle scripts). Keep plugin dependency
trees "pure JS/TS" and avoid packages that require `postinstall` builds.

### Channel catalog metadata

Channel plugins can advertise onboarding metadata via `openclaw.channel` and
install hints via `openclaw.install`. This keeps the core catalog data-free.

Example:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw can also merge **external channel catalogs** (for example, an MPM
registry export). Drop a JSON file at one of:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Or point `OPENCLAW_PLUGIN_CATALOG_PATHS` (or `OPENCLAW_MPM_CATALOG_PATHS`) at
one or more JSON files (comma/semicolon/`PATH`-delimited). Each file should
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## Plugin IDs

Default plugin ids:

- Package packs: `package.json` `name`
- Standalone file: file base name (`~/.../voice-call.ts` → `voice-call`)

If a plugin exports `id`, OpenClaw uses it but warns when it doesn’t match the
configured id.

## Registry model

Loaded plugins do not directly mutate random core globals. They register into a
central plugin registry.

The registry tracks:

- plugin records (identity, source, origin, status, diagnostics)
- tools
- legacy hooks and typed hooks
- channels
- providers
- gateway RPC handlers
- HTTP routes
- CLI registrars
- background services
- plugin-owned commands

Core features then read from that registry instead of talking to plugin modules
directly. This keeps loading one-way:

- plugin module -> registry registration
- core runtime -> registry consumption

That separation matters for maintainability. It means most core surfaces only
need one integration point: "read the registry", not "special-case every plugin
module".

## Config

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Fields:

- `enabled`: master toggle (default: true)
- `allow`: allowlist (optional)
- `deny`: denylist (optional; deny wins)
- `load.paths`: extra plugin files/dirs
- `slots`: exclusive slot selectors such as `memory` and `contextEngine`
- `entries.<id>`: per‑plugin toggles + config

Config changes **require a gateway restart**.

Validation rules (strict):

- Unknown plugin ids in `entries`, `allow`, `deny`, or `slots` are **errors**.
- Unknown `channels.<id>` keys are **errors** unless a plugin manifest declares
  the channel id.
- Plugin config is validated using the JSON Schema embedded in
  `openclaw.plugin.json` (`configSchema`).
- If a plugin is disabled, its config is preserved and a **warning** is emitted.

### Disabled vs missing vs invalid

These states are intentionally different:

- **disabled**: plugin exists, but enablement rules turned it off
- **missing**: config references a plugin id that discovery did not find
- **invalid**: plugin exists, but its config does not match the declared schema

OpenClaw preserves config for disabled plugins so toggling them back on is not
destructive.

## Plugin slots (exclusive categories)

Some plugin categories are **exclusive** (only one active at a time). Use
`plugins.slots` to select which plugin owns the slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
      contextEngine: "legacy", // or a plugin id such as "lossless-claw"
    },
  },
}
```

Supported exclusive slots:

- `memory`: active memory plugin (`"none"` disables memory plugins)
- `contextEngine`: active context engine plugin (`"legacy"` is the built-in default)

If multiple plugins declare `kind: "memory"` or `kind: "context-engine"`, only
the selected plugin loads for that slot. Others are disabled with diagnostics.

### Context engine plugins

Context engine plugins own session context orchestration for ingest, assembly,
and compaction. Register them from your plugin with
`api.registerContextEngine(id, factory)`, then select the active engine with
`plugins.slots.contextEngine`.

Use this when your plugin needs to replace or extend the default context
pipeline rather than just add memory search or hooks.

## Control UI (schema + labels)

The Control UI uses `config.schema` (JSON Schema + `uiHints`) to render better forms.

OpenClaw augments `uiHints` at runtime based on discovered plugins:

- Adds per-plugin labels for `plugins.entries.<id>` / `.enabled` / `.config`
- Merges optional plugin-provided config field hints under:
  `plugins.entries.<id>.config.<field>`

If you want your plugin config fields to show good labels/placeholders (and mark secrets as sensitive),
provide `uiHints` alongside your JSON Schema in the plugin manifest.

Example:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins install @openclaw/voice-call --pin # store exact resolved name@version
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` only works for npm installs tracked under `plugins.installs`.
If stored integrity metadata changes between updates, OpenClaw warns and asks for confirmation (use global `--yes` to bypass prompts).

Plugins may also register their own top‑level commands (example: `openclaw voicecall`).

## Plugin API (overview)

Plugins export either:

- A function: `(api) => { ... }`
- An object: `{ id, name, configSchema, register(api) { ... } }`

`register(api)` is where plugins attach behavior. Common registrations include:

- `registerTool`
- `registerHook`
- `on(...)` for typed lifecycle hooks
- `registerChannel`
- `registerProvider`
- `registerHttpRoute`
- `registerCommand`
- `registerCli`
- `registerContextEngine`
- `registerService`

Context engine plugins can also register a runtime-owned context manager:

```ts
export default function (api) {
  api.registerContextEngine("lossless-claw", () => ({
    info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
}
```

Then enable it in config:

```json5
{
  plugins: {
    slots: {
      contextEngine: "lossless-claw",
    },
  },
}
```

## Plugin hooks

Plugins can register hooks at runtime. This lets a plugin bundle event-driven
automation without a separate hook pack install.

### Example

```ts
export default function register(api) {
  api.registerHook(
    "command:new",
    async () => {
      // Hook logic here.
    },
    {
      name: "my-plugin.command-new",
      description: "Runs when /new is invoked",
    },
  );
}
```

Notes:

- Register hooks explicitly via `api.registerHook(...)`.
- Hook eligibility rules still apply (OS/bins/env/config requirements).
- Plugin-managed hooks show up in `openclaw hooks list` with `plugin:<id>`.
- You cannot enable/disable plugin-managed hooks via `openclaw hooks`; enable/disable the plugin instead.

### Agent lifecycle hooks (`api.on`)

For typed runtime lifecycle hooks, use `api.on(...)`:

```ts
export default function register(api) {
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      return {
        prependSystemContext: "Follow company style guide.",
      };
    },
    { priority: 10 },
  );
}
```

Important hooks for prompt construction:

- `before_model_resolve`: runs before session load (`messages` are not available). Use this to deterministically override `modelOverride` or `providerOverride`.
- `before_prompt_build`: runs after session load (`messages` are available). Use this to shape prompt input.
- `before_agent_start`: legacy compatibility hook. Prefer the two explicit hooks above.

Core-enforced hook policy:

- Operators can disable prompt mutation hooks per plugin via `plugins.entries.<id>.hooks.allowPromptInjection: false`.
- When disabled, OpenClaw blocks `before_prompt_build` and ignores prompt-mutating fields returned from legacy `before_agent_start` while preserving legacy `modelOverride` and `providerOverride`.

`before_prompt_build` result fields:

- `prependContext`: prepends text to the user prompt for this run. Best for turn-specific or dynamic content.
- `systemPrompt`: full system prompt override.
- `prependSystemContext`: prepends text to the current system prompt.
- `appendSystemContext`: appends text to the current system prompt.

Prompt build order in embedded runtime:

1. Apply `prependContext` to the user prompt.
2. Apply `systemPrompt` override when provided.
3. Apply `prependSystemContext + current system prompt + appendSystemContext`.

Merge and precedence notes:

- Hook handlers run by priority (higher first).
- For merged context fields, values are concatenated in execution order.
- `before_prompt_build` values are applied before legacy `before_agent_start` fallback values.

Migration guidance:

- Move static guidance from `prependContext` to `prependSystemContext` (or `appendSystemContext`) so providers can cache stable system-prefix content.
- Keep `prependContext` for per-turn dynamic context that should stay tied to the user message.

## Provider plugins (model auth)

Plugins can register **model providers** so users can run OAuth or API-key
setup inside OpenClaw, surface provider setup in onboarding/model-pickers, and
contribute implicit provider discovery.

Provider plugins are the modular extension seam for model-provider setup. They
are not just "OAuth helpers" anymore.

### Provider plugin lifecycle

A provider plugin can participate in five distinct phases:

1. **Auth**
   `auth[].run(ctx)` performs OAuth, API-key capture, device code, or custom
   setup and returns auth profiles plus optional config patches.
2. **Non-interactive setup**
   `auth[].runNonInteractive(ctx)` handles `openclaw onboard --non-interactive`
   without prompts. Use this when the provider needs custom headless setup
   beyond the built-in simple API-key paths.
3. **Wizard integration**
   `wizard.onboarding` adds an entry to `openclaw onboard`.
   `wizard.modelPicker` adds a setup entry to the model picker.
4. **Implicit discovery**
   `discovery.run(ctx)` can contribute provider config automatically during
   model resolution/listing.
5. **Post-selection follow-up**
   `onModelSelected(ctx)` runs after a model is chosen. Use this for provider-
   specific work such as downloading a local model.

This is the recommended split because these phases have different lifecycle
requirements:

- auth is interactive and writes credentials/config
- non-interactive setup is flag/env-driven and must not prompt
- wizard metadata is static and UI-facing
- discovery should be safe, quick, and failure-tolerant
- post-select hooks are side effects tied to the chosen model

### Provider auth contract

`auth[].run(ctx)` returns:

- `profiles`: auth profiles to write
- `configPatch`: optional `openclaw.json` changes
- `defaultModel`: optional `provider/model` ref
- `notes`: optional user-facing notes

Core then:

1. writes the returned auth profiles
2. applies auth-profile config wiring
3. merges the config patch
4. optionally applies the default model
5. runs the provider's `onModelSelected` hook when appropriate

That means a provider plugin owns the provider-specific setup logic, while core
owns the generic persistence and config-merge path.

### Provider non-interactive contract

`auth[].runNonInteractive(ctx)` is optional. Implement it when the provider
needs headless setup that cannot be expressed through the built-in generic
API-key flows.

The non-interactive context includes:

- the current and base config
- parsed onboarding CLI options
- runtime logging/error helpers
- agent/workspace dirs
- `resolveApiKey(...)` to read provider keys from flags, env, or existing auth
  profiles while honoring `--secret-input-mode`
- `toApiKeyCredential(...)` to convert a resolved key into an auth-profile
  credential with the right plaintext vs secret-ref storage

Use this surface for providers such as:

- self-hosted OpenAI-compatible runtimes that need `--custom-base-url` +
  `--custom-model-id`
- provider-specific non-interactive verification or config synthesis

Do not prompt from `runNonInteractive`. Reject missing inputs with actionable
errors instead.

### Provider wizard metadata

`wizard.onboarding` controls how the provider appears in grouped onboarding:

- `choiceId`: auth-choice value
- `choiceLabel`: option label
- `choiceHint`: short hint
- `groupId`: group bucket id
- `groupLabel`: group label
- `groupHint`: group hint
- `methodId`: auth method to run

`wizard.modelPicker` controls how a provider appears as a "set this up now"
entry in model selection:

- `label`
- `hint`
- `methodId`

When a provider has multiple auth methods, the wizard can either point at one
explicit method or let OpenClaw synthesize per-method choices.

OpenClaw validates provider wizard metadata when the plugin registers:

- duplicate or blank auth-method ids are rejected
- wizard metadata is ignored when the provider has no auth methods
- invalid `methodId` bindings are downgraded to warnings and fall back to the
  provider's remaining auth methods

### Provider discovery contract

`discovery.run(ctx)` returns one of:

- `{ provider }`
- `{ providers }`
- `null`

Use `{ provider }` for the common case where the plugin owns one provider id.
Use `{ providers }` when a plugin discovers multiple provider entries.

The discovery context includes:

- the current config
- agent/workspace dirs
- process env
- a helper to resolve the provider API key and a discovery-safe API key value

Discovery should be:

- fast
- best-effort
- safe to skip on failure
- careful about side effects

It should not depend on prompts or long-running setup.

### Discovery ordering

Provider discovery runs in ordered phases:

- `simple`
- `profile`
- `paired`
- `late`

Use:

- `simple` for cheap environment-only discovery
- `profile` when discovery depends on auth profiles
- `paired` for providers that need to coordinate with another discovery step
- `late` for expensive or local-network probing

Most self-hosted providers should use `late`.

### Good provider-plugin boundaries

Good fit for provider plugins:

- local/self-hosted providers with custom setup flows
- provider-specific OAuth/device-code login
- implicit discovery of local model servers
- post-selection side effects such as model pulls

Less compelling fit:

- trivial API-key-only providers that differ only by env var, base URL, and one
  default model

Those can still become plugins, but the main modularity payoff comes from
extracting behavior-rich providers first.

Register a provider via `api.registerProvider(...)`. Each provider exposes one
or more auth methods (OAuth, API key, device code, etc.). Those methods can
power:

- `openclaw models auth login --provider <id> [--method <id>]`
- `openclaw onboard`
- model-picker “custom provider” setup entries
- implicit provider discovery during model resolution/listing

Example:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
  wizard: {
    onboarding: {
      choiceId: "acme",
      choiceLabel: "AcmeAI",
      groupId: "acme",
      groupLabel: "AcmeAI",
      methodId: "oauth",
    },
    modelPicker: {
      label: "AcmeAI (custom)",
      hint: "Connect a self-hosted AcmeAI endpoint",
      methodId: "oauth",
    },
  },
  discovery: {
    order: "late",
    run: async () => ({
      provider: {
        baseUrl: "https://acme.example/v1",
        api: "openai-completions",
        apiKey: "${ACME_API_KEY}",
        models: [],
      },
    }),
  },
});
```

Notes:

- `run` receives a `ProviderAuthContext` with `prompter`, `runtime`,
  `openUrl`, and `oauth.createVpsAwareHandlers` helpers.
- `runNonInteractive` receives a `ProviderAuthMethodNonInteractiveContext`
  with `opts`, `resolveApiKey`, and `toApiKeyCredential` helpers for
  headless onboarding.
- Return `configPatch` when you need to add default models or provider config.
- Return `defaultModel` so `--set-default` can update agent defaults.
- `wizard.onboarding` adds a provider choice to `openclaw onboard`.
- `wizard.modelPicker` adds a “setup this provider” entry to the model picker.
- `discovery.run` returns either `{ provider }` for the plugin’s own provider id
  or `{ providers }` for multi-provider discovery.
- `discovery.order` controls when the provider runs relative to built-in
  discovery phases: `simple`, `profile`, `paired`, or `late`.
- `onModelSelected` is the post-selection hook for provider-specific follow-up
  work such as pulling a local model.

### Register a messaging channel

Plugins can register **channel plugins** that behave like built‑in channels
(WhatsApp, Telegram, etc.). Channel config lives under `channels.<id>` and is
validated by your channel plugin code.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

Notes:

- Put config under `channels.<id>` (not `plugins.entries`).
- `meta.label` is used for labels in CLI/UI lists.
- `meta.aliases` adds alternate ids for normalization and CLI inputs.
- `meta.preferOver` lists channel ids to skip auto-enable when both are configured.
- `meta.detailLabel` and `meta.systemImage` let UIs show richer channel labels/icons.

### Channel onboarding hooks

Channel plugins can define optional onboarding hooks on `plugin.onboarding`:

- `configure(ctx)` is the baseline setup flow.
- `configureInteractive(ctx)` can fully own interactive setup for both configured and unconfigured states.
- `configureWhenConfigured(ctx)` can override behavior only for already configured channels.

Hook precedence in the wizard:

1. `configureInteractive` (if present)
2. `configureWhenConfigured` (only when channel status is already configured)
3. fallback to `configure`

Context details:

- `configureInteractive` and `configureWhenConfigured` receive:
  - `configured` (`true` or `false`)
  - `label` (user-facing channel name used by prompts)
  - plus the shared config/runtime/prompter/options fields
- Returning `"skip"` leaves selection and account tracking unchanged.
- Returning `{ cfg, accountId? }` applies config updates and records account selection.

### Write a new messaging channel (step‑by‑step)

Use this when you want a **new chat surface** (a "messaging channel"), not a model provider.
Model provider docs live under `/providers/*`.

1. Pick an id + config shape

- All channel config lives under `channels.<id>`.
- Prefer `channels.<id>.accounts.<accountId>` for multi‑account setups.

2. Define the channel metadata

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` control CLI/UI lists.
- `meta.docsPath` should point at a docs page like `/channels/<id>`.
- `meta.preferOver` lets a plugin replace another channel (auto-enable prefers it).
- `meta.detailLabel` and `meta.systemImage` are used by UIs for detail text/icons.

3. Implement the required adapters

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (chat types, media, threads, etc.)
- `outbound.deliveryMode` + `outbound.sendText` (for basic send)

4. Add optional adapters as needed

- `setup` (wizard), `security` (DM policy), `status` (health/diagnostics)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (message actions), `commands` (native command behavior)

5. Register the channel in your plugin

- `api.registerChannel({ plugin })`

Minimal config example:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

Minimal channel plugin (outbound‑only):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Load the plugin (extensions dir or `plugins.load.paths`), restart the gateway,
then configure `channels.<id>` in your config.

### Agent tools

See the dedicated guide: [Plugin agent tools](/plugins/agent-tools).

### Register a gateway RPC method

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Register CLI commands

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Register auto-reply commands

Plugins can register custom slash commands that execute **without invoking the
AI agent**. This is useful for toggle commands, status checks, or quick actions
that don't need LLM processing.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

Command handler context:

- `senderId`: The sender's ID (if available)
- `channel`: The channel where the command was sent
- `isAuthorizedSender`: Whether the sender is an authorized user
- `args`: Arguments passed after the command (if `acceptsArgs: true`)
- `commandBody`: The full command text
- `config`: The current OpenClaw config

Command options:

- `name`: Command name (without the leading `/`)
- `nativeNames`: Optional native-command aliases for slash/menu surfaces. Use `default` for all native providers, or provider-specific keys like `discord`
- `description`: Help text shown in command lists
- `acceptsArgs`: Whether the command accepts arguments (default: false). If false and arguments are provided, the command won't match and the message falls through to other handlers
- `requireAuth`: Whether to require authorized sender (default: true)
- `handler`: Function that returns `{ text: string }` (can be async)

Example with authorization and arguments:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

Notes:

- Plugin commands are processed **before** built-in commands and the AI agent
- Commands are registered globally and work across all channels
- Command names are case-insensitive (`/MyStatus` matches `/mystatus`)
- Command names must start with a letter and contain only letters, numbers, hyphens, and underscores
- Reserved command names (like `help`, `status`, `reset`, etc.) cannot be overridden by plugins
- Duplicate command registration across plugins will fail with a diagnostic error

### Register background services

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Naming conventions

- Gateway methods: `pluginId.action` (example: `voicecall.status`)
- Tools: `snake_case` (example: `voice_call`)
- CLI commands: kebab or camel, but avoid clashing with core commands

## Skills

Plugins can ship a skill in the repo (`skills/<name>/SKILL.md`).
Enable it with `plugins.entries.<id>.enabled` (or other config gates) and ensure
it’s present in your workspace/managed skills locations.

## Distribution (npm)

Recommended packaging:

- Main package: `openclaw` (this repo)
- Plugins: separate npm packages under `@openclaw/*` (example: `@openclaw/voice-call`)

Publishing contract:

- Plugin `package.json` must include `openclaw.extensions` with one or more entry files.
- Entry files can be `.js` or `.ts` (jiti loads TS at runtime).
- `openclaw plugins install <npm-spec>` uses `npm pack`, extracts into `~/.openclaw/extensions/<id>/`, and enables it in config.
- Config key stability: scoped packages are normalized to the **unscoped** id for `plugins.entries.*`.

## Example plugin: Voice Call

This repo includes a voice‑call plugin (Twilio or log fallback):

- Source: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Tool: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Config (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (optional `statusCallbackUrl`, `twimlUrl`)
- Config (dev): `provider: "log"` (no network)

See [Voice Call](/plugins/voice-call) and `extensions/voice-call/README.md` for setup and usage.

## Safety notes

Plugins run in-process with the Gateway. Treat them as trusted code:

- Only install plugins you trust.
- Prefer `plugins.allow` allowlists.
- Remember that `plugins.allow` is id-based, so an enabled workspace plugin can
  intentionally shadow a bundled plugin with the same id.
- Restart the Gateway after changes.

## Testing plugins

Plugins can (and should) ship tests:

- In-repo plugins can keep Vitest tests under `src/**` (example: `src/plugins/voice-call.plugin.test.ts`).
- Separately published plugins should run their own CI (lint/build/test) and validate `openclaw.extensions` points at the built entrypoint (`dist/index.js`).

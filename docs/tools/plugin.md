---
summary: "OpenClaw plugins/extensions: discovery, config, and safety"
read_when:
  - Adding or modifying plugins/extensions
  - Documenting plugin install or load rules
  - Working with Codex/Claude-compatible plugin bundles
title: "Plugins"
---

# Plugins (Extensions)

## Quick start (new to plugins?)

A plugin is either:

- a native **OpenClaw plugin** (`openclaw.plugin.json` + runtime module), or
- a compatible **bundle** (`.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`)

Both show up under `openclaw plugins`, but only native OpenClaw plugins execute
runtime code in-process.

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
Need the bundle compatibility details? See [Plugin bundles](/plugins/bundles).

For compatible bundles, install from a local directory or archive:

```bash
openclaw plugins install ./my-bundle
openclaw plugins install ./my-bundle.tgz
```

For Claude marketplace installs, list the marketplace first, then install by
marketplace entry name:

```bash
openclaw plugins marketplace list <marketplace-name>
openclaw plugins install <plugin-name>@<marketplace-name>
```

OpenClaw resolves known Claude marketplace names from
`~/.claude/plugins/known_marketplaces.json`. You can also pass an explicit
marketplace source with `--marketplace`.

## Conversation binding callbacks

Plugins that bind a conversation can now react when an approval is resolved.

Use `api.onConversationBindingResolved(...)` to receive a callback after a bind
request is approved or denied:

```ts
export default {
  id: "my-plugin",
  register(api) {
    api.onConversationBindingResolved(async (event) => {
      if (event.status === "approved") {
        // A binding now exists for this plugin + conversation.
        console.log(event.binding?.conversationId);
        return;
      }

      // The request was denied; clear any local pending state.
      console.log(event.request.conversation.conversationId);
    });
  },
};
```

Callback payload fields:

- `status`: `"approved"` or `"denied"`
- `decision`: `"allow-once"`, `"allow-always"`, or `"deny"`
- `binding`: the resolved binding for approved requests
- `request`: the original request summary, detach hint, sender id, and
  conversation metadata

This callback is notification-only. It does not change who is allowed to bind a
conversation, and it runs after core approval handling finishes.

## Public capability model

Capabilities are the public plugin model. Every native OpenClaw plugin
registers against one or more capability types:

| Capability          | Registration method                           | Example plugins           |
| ------------------- | --------------------------------------------- | ------------------------- |
| Text inference      | `api.registerProvider(...)`                   | `openai`, `anthropic`     |
| Speech              | `api.registerSpeechProvider(...)`             | `elevenlabs`, `microsoft` |
| Media understanding | `api.registerMediaUnderstandingProvider(...)` | `openai`, `google`        |
| Image generation    | `api.registerImageGenerationProvider(...)`    | `openai`, `google`        |
| Web search          | `api.registerWebSearchProvider(...)`          | `google`                  |
| Channel / messaging | `api.registerChannel(...)`                    | `msteams`, `matrix`       |

A plugin that registers zero capabilities but provides hooks, tools, or
services is a **legacy hook-only** plugin. That shape is still fully supported.

### Plugin shapes

OpenClaw classifies every loaded plugin into a shape based on its actual
registration behavior (not just static metadata):

- **plain-capability** — registers exactly one capability type (for example a
  provider-only plugin like `mistral`)
- **hybrid-capability** — registers multiple capability types (for example
  `openai` owns text inference, speech, media understanding, and image
  generation)
- **hook-only** — registers only hooks (typed or custom), no capabilities,
  tools, commands, or services
- **non-capability** — registers tools, commands, services, or routes but no
  capabilities

Use `openclaw plugins inspect <id>` to see a plugin's shape and capability
breakdown. See [CLI reference](/cli/plugins#inspect) for details.

### Capability labels

Plugin capabilities use two stability labels:

- `public` — stable, documented, and safe to depend on
- `experimental` — may change between releases

### Legacy hooks

The `before_agent_start` hook remains supported as a compatibility path for
hook-only plugins. Legacy real-world plugins still depend on it.

Direction:

- keep it working
- document it as legacy
- prefer `before_model_resolve` for model/provider override work
- prefer `before_prompt_build` for prompt mutation work
- remove only after real usage drops and fixture coverage proves migration safety

## Architecture

OpenClaw's plugin system has four layers:

1. **Manifest + discovery**
   OpenClaw finds candidate plugins from configured paths, workspace roots,
   global extension roots, and bundled extensions. Discovery reads native
   `openclaw.plugin.json` manifests plus supported bundle manifests first.
2. **Enablement + validation**
   Core decides whether a discovered plugin is enabled, disabled, blocked, or
   selected for an exclusive slot such as memory.
3. **Runtime loading**
   Native OpenClaw plugins are loaded in-process via jiti and register
   capabilities into a central registry. Compatible bundles are normalized into
   registry records without importing runtime code.
4. **Surface consumption**
   The rest of OpenClaw reads the registry to expose tools, channels, provider
   setup, hooks, HTTP routes, CLI commands, and services.

The important design boundary:

- discovery + config validation should work from **manifest/schema metadata**
  without executing plugin code
- native runtime behavior comes from the plugin module's `register(api)` path

That split lets OpenClaw validate config, explain missing/disabled plugins, and
build UI/schema hints before the full runtime is active.

### Channel plugins and the shared message tool

Channel plugins do not need to register a separate send/edit/react tool for
normal chat actions. OpenClaw keeps one shared `message` tool in core, and
channel plugins own the channel-specific discovery and execution behind it.

The current boundary is:

- core owns the shared `message` tool host, prompt wiring, session/thread
  bookkeeping, and execution dispatch
- channel plugins own scoped action discovery, capability discovery, and any
  channel-specific schema fragments
- channel plugins execute the final action through their action adapter

For channel plugins, the preferred SDK surface is
`ChannelMessageActionAdapter.describeMessageTool(...)`. That unified discovery
call lets a plugin return its visible actions, capabilities, and schema
contributions together so those pieces do not drift apart.

Core passes runtime scope into that discovery step. Important fields include:

- `accountId`
- `currentChannelId`
- `currentThreadTs`
- `currentMessageId`
- `sessionKey`
- `sessionId`
- `agentId`
- trusted inbound `requesterSenderId`

That matters for context-sensitive plugins. A channel can hide or expose
message actions based on the active account, current room/thread/message, or
trusted requester identity without hardcoding channel-specific branches in the
core `message` tool.

This is why embedded-runner routing changes are still plugin work: the runner is
responsible for forwarding the current chat/session identity into the plugin
discovery boundary so the shared `message` tool exposes the right channel-owned
surface for the current turn.

## Capability ownership model

OpenClaw treats a native plugin as the ownership boundary for a **company** or a
**feature**, not as a grab bag of unrelated integrations.

That means:

- a company plugin should usually own all of that company's OpenClaw-facing
  surfaces
- a feature plugin should usually own the full feature surface it introduces
- channels should consume shared core capabilities instead of re-implementing
  provider behavior ad hoc

Examples:

- the bundled `openai` plugin owns OpenAI model-provider behavior and OpenAI
  speech + media-understanding + image-generation behavior
- the bundled `elevenlabs` plugin owns ElevenLabs speech behavior
- the bundled `microsoft` plugin owns Microsoft speech behavior
- the bundled `google` plugin owns Google model-provider behavior plus Google
  media-understanding + image-generation + web-search behavior
- the bundled `minimax`, `mistral`, `moonshot`, and `zai` plugins own their
  media-understanding backends
- the `voice-call` plugin is a feature plugin: it owns call transport, tools,
  CLI, routes, and runtime, but it consumes core TTS/STT capability instead of
  inventing a second speech stack

The intended end state is:

- OpenAI lives in one plugin even if it spans text models, speech, images, and
  future video
- another vendor can do the same for its own surface area
- channels do not care which vendor plugin owns the provider; they consume the
  shared capability contract exposed by core

This is the key distinction:

- **plugin** = ownership boundary
- **capability** = core contract that multiple plugins can implement or consume

So if OpenClaw adds a new domain such as video, the first question is not
"which provider should hardcode video handling?" The first question is "what is
the core video capability contract?" Once that contract exists, vendor plugins
can register against it and channel/feature plugins can consume it.

If the capability does not exist yet, the right move is usually:

1. define the missing capability in core
2. expose it through the plugin API/runtime in a typed way
3. wire channels/features against that capability
4. let vendor plugins register implementations

This keeps ownership explicit while avoiding core behavior that depends on a
single vendor or a one-off plugin-specific code path.

### Capability layering

Use this mental model when deciding where code belongs:

- **core capability layer**: shared orchestration, policy, fallback, config
  merge rules, delivery semantics, and typed contracts
- **vendor plugin layer**: vendor-specific APIs, auth, model catalogs, speech
  synthesis, image generation, future video backends, usage endpoints
- **channel/feature plugin layer**: Slack/Discord/voice-call/etc. integration
  that consumes core capabilities and presents them on a surface

For example, TTS follows this shape:

- core owns reply-time TTS policy, fallback order, prefs, and channel delivery
- `openai`, `elevenlabs`, and `microsoft` own synthesis implementations
- `voice-call` consumes the telephony TTS runtime helper

That same pattern should be preferred for future capabilities.

### Multi-capability company plugin example

A company plugin should feel cohesive from the outside. If OpenClaw has shared
contracts for models, speech, media understanding, and web search, a vendor can
own all of its surfaces in one place:

```ts
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import {
  buildOpenAISpeechProvider,
  createPluginBackedWebSearchProvider,
  describeImageWithModel,
  transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk";

const plugin: OpenClawPluginDefinition = {
  id: "exampleai",
  name: "ExampleAI",
  register(api) {
    api.registerProvider({
      id: "exampleai",
      // auth/model catalog/runtime hooks
    });

    api.registerSpeechProvider(
      buildOpenAISpeechProvider({
        id: "exampleai",
        // vendor speech config
      }),
    );

    api.registerMediaUnderstandingProvider({
      id: "exampleai",
      capabilities: ["image", "audio", "video"],
      async describeImage(req) {
        return describeImageWithModel({
          provider: "exampleai",
          model: req.model,
          input: req.input,
        });
      },
      async transcribeAudio(req) {
        return transcribeOpenAiCompatibleAudio({
          provider: "exampleai",
          model: req.model,
          input: req.input,
        });
      },
    });

    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "exampleai-search",
        // credential + fetch logic
      }),
    );
  },
};

export default plugin;
```

What matters is not the exact helper names. The shape matters:

- one plugin owns the vendor surface
- core still owns the capability contracts
- channels and feature plugins consume `api.runtime.*` helpers, not vendor code
- contract tests can assert that the plugin registered the capabilities it
  claims to own

### Capability example: video understanding

OpenClaw already treats image/audio/video understanding as one shared
capability. The same ownership model applies there:

1. core defines the media-understanding contract
2. vendor plugins register `describeImage`, `transcribeAudio`, and
   `describeVideo` as applicable
3. channels and feature plugins consume the shared core behavior instead of
   wiring directly to vendor code

That avoids baking one provider's video assumptions into core. The plugin owns
the vendor surface; core owns the capability contract and fallback behavior.

If OpenClaw adds a new domain later, such as video generation, use the same
sequence again: define the core capability first, then let vendor plugins
register implementations against it.

Need a concrete rollout checklist? See
[Capability Cookbook](/tools/capability-cookbook).

## Compatible bundles

OpenClaw also recognizes two compatible external bundle layouts:

- Codex-style bundles: `.codex-plugin/plugin.json`
- Claude-style bundles: `.claude-plugin/plugin.json` or the default Claude
  component layout without a manifest
- Cursor-style bundles: `.cursor-plugin/plugin.json`

Claude marketplace entries can point at any of these compatible bundles, or at
native OpenClaw plugin sources. OpenClaw resolves the marketplace entry first,
then runs the normal install path for the resolved source.

They are shown in the plugin list as `format=bundle`, with a subtype of
`codex` or `claude` in verbose/info output.

See [Plugin bundles](/plugins/bundles) for the exact detection rules, mapping
behavior, and current support matrix.

Today, OpenClaw treats these as **capability packs**, not native runtime
plugins:

- supported now: bundled `skills`
- supported now: Claude `commands/` markdown roots, mapped into the normal
  OpenClaw skill loader
- supported now: Claude bundle `settings.json` defaults for embedded Pi agent
  settings (with shell override keys sanitized)
- supported now: bundle MCP config, merged into embedded Pi agent settings as
  `mcpServers`, with supported stdio bundle MCP tools exposed during embedded
  Pi agent turns
- supported now: Cursor `.cursor/commands/*.md` roots, mapped into the normal
  OpenClaw skill loader
- supported now: Codex bundle hook directories that use the OpenClaw hook-pack
  layout (`HOOK.md` + `handler.ts`/`handler.js`)
- detected but not wired yet: other declared bundle capabilities such as
  agents, Claude hook automation, Cursor rules/hooks metadata, app/LSP
  metadata, output styles

That means bundle install/discovery/list/info/enablement all work, and bundle
skills, Claude command-skills, Claude bundle settings defaults, and compatible
Codex hook directories load when the bundle is enabled. Supported bundle MCP
servers may also run as subprocesses for embedded Pi tool calls when they use
supported stdio transport, but bundle runtime modules are not loaded
in-process.

Bundle hook support is limited to the normal OpenClaw hook directory format
(`HOOK.md` plus `handler.ts`/`handler.js` under the declared hook roots).
Vendor-specific shell/JSON hook runtimes, including Claude `hooks.json`, are
only detected today and are not executed directly.

## Execution model

Native OpenClaw plugins run **in-process** with the Gateway. They are not
sandboxed. A loaded native plugin has the same process-level trust boundary as
core code.

Implications:

- a native plugin can register tools, network handlers, hooks, and services
- a native plugin bug can crash or destabilize the gateway
- a malicious native plugin is equivalent to arbitrary code execution inside
  the OpenClaw process

Compatible bundles are safer by default because OpenClaw currently treats them
as metadata/content packs. In current releases, that mostly means bundled
skills.

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
- Anthropic provider runtime — bundled as `anthropic` (enabled by default)
- BytePlus provider catalog — bundled as `byteplus` (enabled by default)
- Cloudflare AI Gateway provider catalog — bundled as `cloudflare-ai-gateway` (enabled by default)
- Google web search + Gemini CLI OAuth — bundled as `google` (web search auto-loads it; provider auth stays opt-in)
- GitHub Copilot provider runtime — bundled as `github-copilot` (enabled by default)
- Hugging Face provider catalog — bundled as `huggingface` (enabled by default)
- Kilo Gateway provider runtime — bundled as `kilocode` (enabled by default)
- Kimi Coding provider catalog — bundled as `kimi-coding` (enabled by default)
- MiniMax provider catalog + usage + OAuth — bundled as `minimax` (enabled by default; owns `minimax` and `minimax-portal`)
- Mistral provider capabilities — bundled as `mistral` (enabled by default)
- Model Studio provider catalog — bundled as `modelstudio` (enabled by default)
- Moonshot provider runtime — bundled as `moonshot` (enabled by default)
- NVIDIA provider catalog — bundled as `nvidia` (enabled by default)
- ElevenLabs speech provider — bundled as `elevenlabs` (enabled by default)
- Microsoft speech provider — bundled as `microsoft` (enabled by default; legacy `edge` input maps here)
- OpenAI provider runtime — bundled as `openai` (enabled by default; owns both `openai` and `openai-codex`)
- OpenCode Go provider capabilities — bundled as `opencode-go` (enabled by default)
- OpenCode Zen provider capabilities — bundled as `opencode` (enabled by default)
- OpenRouter provider runtime — bundled as `openrouter` (enabled by default)
- Qianfan provider catalog — bundled as `qianfan` (enabled by default)
- Qwen OAuth (provider auth + catalog) — bundled as `qwen-portal-auth` (enabled by default)
- Synthetic provider catalog — bundled as `synthetic` (enabled by default)
- Together provider catalog — bundled as `together` (enabled by default)
- Venice provider catalog — bundled as `venice` (enabled by default)
- Vercel AI Gateway provider catalog — bundled as `vercel-ai-gateway` (enabled by default)
- Volcengine provider catalog — bundled as `volcengine` (enabled by default)
- Xiaomi provider catalog + usage — bundled as `xiaomi` (enabled by default)
- Z.AI provider runtime — bundled as `zai` (enabled by default)
- Copilot Proxy (provider auth) — local VS Code Copilot Proxy bridge; distinct from built-in `github-copilot` device login (bundled, disabled by default)

Native OpenClaw plugins are **TypeScript modules** loaded at runtime via jiti.
**Config validation does not execute plugin code**; it uses the plugin manifest
and JSON Schema instead. See [Plugin manifest](/plugins/manifest).

Native OpenClaw plugins can register capabilities and surfaces:

**Capabilities** (public plugin model):

- Text inference providers (model catalogs, auth, runtime hooks)
- Speech providers
- Media understanding providers
- Image generation providers
- Web search providers
- Channel / messaging connectors

**Surfaces** (supporting infrastructure):

- Gateway RPC methods and HTTP routes
- Agent tools
- CLI commands
- Background services
- Context engines
- Optional config validation
- **Skills** (by listing `skills` directories in the plugin manifest)
- **Auto-reply commands** (execute without invoking the AI agent)

Native OpenClaw plugins run **in‑process** with the Gateway, so treat them as trusted code.
Tool authoring guide: [Plugin agent tools](/plugins/agent-tools).

Think of these registrations as **capability claims**. A plugin is not supposed
to reach into random internals and "just make it work." It should register
against explicit surfaces that OpenClaw understands, validates, and can expose
consistently across config, onboarding, status, docs, and runtime behavior.

## Contracts and enforcement

The plugin API surface is intentionally typed and centralized in
`OpenClawPluginApi`. That contract defines the supported registration points and
the runtime helpers a plugin may rely on.

Why this matters:

- plugin authors get one stable internal standard
- core can reject duplicate ownership such as two plugins registering the same
  provider id
- startup can surface actionable diagnostics for malformed registration
- contract tests can enforce bundled-plugin ownership and prevent silent drift

There are two layers of enforcement:

1. **runtime registration enforcement**
   The plugin registry validates registrations as plugins load. Examples:
   duplicate provider ids, duplicate speech provider ids, and malformed
   registrations produce plugin diagnostics instead of undefined behavior.
2. **contract tests**
   Bundled plugins are captured in contract registries during test runs so
   OpenClaw can assert ownership explicitly. Today this is used for model
   providers, speech providers, web search providers, and bundled registration
   ownership.

The practical effect is that OpenClaw knows, up front, which plugin owns which
surface. That lets core and channels compose seamlessly because ownership is
declared, typed, and testable rather than implicit.

### What belongs in a contract

Good plugin contracts are:

- typed
- small
- capability-specific
- owned by core
- reusable by multiple plugins
- consumable by channels/features without vendor knowledge

Bad plugin contracts are:

- vendor-specific policy hidden in core
- one-off plugin escape hatches that bypass the registry
- channel code reaching straight into a vendor implementation
- ad hoc runtime objects that are not part of `OpenClawPluginApi` or
  `api.runtime`

When in doubt, raise the abstraction level: define the capability first, then
let plugins plug into it.

## Export boundary

OpenClaw exports capabilities, not implementation convenience.

Keep capability registration public. Trim non-contract helper exports:

- bundled-plugin-specific helper subpaths
- runtime plumbing subpaths not intended as public API
- vendor-specific convenience helpers
- setup/onboarding helpers that are implementation details

## Plugin inspection

Use `openclaw plugins inspect <id>` for deep plugin introspection. This is the
canonical command for understanding a plugin's shape and registration behavior.

```bash
openclaw plugins inspect openai
openclaw plugins inspect openai --json
```

The inspect report shows:

- identity, load status, source, and root
- plugin shape (plain-capability, hybrid-capability, hook-only, non-capability)
- capability mode and registered capabilities
- hooks (typed and custom), tools, commands, services
- channel registration
- config policy flags
- diagnostics
- whether the plugin uses the legacy `before_agent_start` hook
- install metadata

Classification comes from actual registration behavior, not just static
metadata.

Summary commands remain summary-focused:

- `plugins list` — compact inventory
- `plugins status` — operational summary
- `doctor` — issue-focused diagnostics
- `plugins inspect` — deep detail

## Provider runtime hooks

Provider plugins now have two layers:

- manifest metadata: `providerAuthEnvVars` for cheap env-auth lookup before
  runtime load, plus `providerAuthChoices` for cheap onboarding/auth-choice
  labels and CLI flag metadata before runtime load
- config-time hooks: `catalog` / legacy `discovery`
- runtime hooks: `resolveDynamicModel`, `prepareDynamicModel`, `normalizeResolvedModel`, `capabilities`, `prepareExtraParams`, `wrapStreamFn`, `formatApiKey`, `refreshOAuth`, `buildAuthDoctorHint`, `isCacheTtlEligible`, `buildMissingAuthMessage`, `suppressBuiltInModel`, `augmentModelCatalog`, `isBinaryThinking`, `supportsXHighThinking`, `resolveDefaultThinkingLevel`, `isModernModelRef`, `prepareRuntimeAuth`, `resolveUsageAuth`, `fetchUsageSnapshot`

OpenClaw still owns the generic agent loop, failover, transcript handling, and
tool policy. These hooks are the extension surface for provider-specific behavior without
needing a whole custom inference transport.

Use manifest `providerAuthEnvVars` when the provider has env-based credentials
that generic auth/status/model-picker paths should see without loading plugin
runtime. Use manifest `providerAuthChoices` when onboarding/auth-choice CLI
surfaces should know the provider's choice id, group labels, and simple
one-flag auth wiring without loading provider runtime. Keep provider runtime
`envVars` for operator-facing hints such as onboarding labels or OAuth
client-id/client-secret setup vars.

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
9. `formatApiKey`
   Provider-owned auth-profile formatter used when a stored auth profile needs
   to become the runtime `apiKey` string.
10. `refreshOAuth`
    Provider-owned OAuth refresh override for custom refresh endpoints or
    refresh-failure policy.
11. `buildAuthDoctorHint`
    Provider-owned repair hint appended when OAuth refresh fails.
12. `isCacheTtlEligible`
    Provider-owned prompt-cache policy for proxy/backhaul providers.
13. `buildMissingAuthMessage`
    Provider-owned replacement for the generic missing-auth recovery message.
14. `suppressBuiltInModel`
    Provider-owned stale upstream model suppression plus optional user-facing
    error hint.
15. `augmentModelCatalog`
    Provider-owned synthetic/final catalog rows appended after discovery.
16. `isBinaryThinking`
    Provider-owned on/off reasoning toggle for binary-thinking providers.
17. `supportsXHighThinking`
    Provider-owned `xhigh` reasoning support for selected models.
18. `resolveDefaultThinkingLevel`
    Provider-owned default `/think` level for a specific model family.
19. `isModernModelRef`
    Provider-owned modern-model matcher used by live profile filters and smoke
    selection.
20. `prepareRuntimeAuth`
    Exchanges a configured credential into the actual runtime token/key just
    before inference.
21. `resolveUsageAuth`
    Resolves usage/billing credentials for `/usage` and related status
    surfaces.
22. `fetchUsageSnapshot`
    Fetches and normalizes provider-specific usage/quota snapshots after auth
    is resolved.

### Which hook to use

- `catalog`: publish provider config and model catalogs into `models.providers`
- `resolveDynamicModel`: handle pass-through or forward-compat model ids that are not in the local registry yet
- `prepareDynamicModel`: async warm-up before retrying dynamic resolution (for example refresh provider metadata cache)
- `normalizeResolvedModel`: rewrite a resolved model's transport/base URL/compat before inference
- `capabilities`: publish provider-family and transcript/tooling quirks without hardcoding provider ids in core
- `prepareExtraParams`: set provider defaults or normalize provider-specific per-model params before generic stream wrapping
- `wrapStreamFn`: add provider-specific headers/payload/model compat patches while still using the normal `pi-ai` execution path
- `formatApiKey`: turn a stored auth profile into the runtime `apiKey` string without hardcoding provider token blobs in core
- `refreshOAuth`: own OAuth refresh for providers that do not fit the shared `pi-ai` refreshers
- `buildAuthDoctorHint`: append provider-owned auth repair guidance when refresh fails
- `isCacheTtlEligible`: decide whether provider/model pairs should use cache TTL metadata
- `buildMissingAuthMessage`: replace the generic auth-store error with a provider-specific recovery hint
- `suppressBuiltInModel`: hide stale upstream rows and optionally return a provider-owned error for direct resolution failures
- `augmentModelCatalog`: append synthetic/final catalog rows after discovery and config merging
- `isBinaryThinking`: expose binary on/off reasoning UX without hardcoding provider ids in `/think`
- `supportsXHighThinking`: opt specific models into the `xhigh` reasoning level
- `resolveDefaultThinkingLevel`: keep provider/model default reasoning policy out of core
- `isModernModelRef`: keep live/smoke model family inclusion rules with the provider
- `prepareRuntimeAuth`: exchange a configured credential into the actual short-lived runtime token/key used for requests
- `resolveUsageAuth`: resolve provider-owned credentials for usage/billing endpoints without hardcoding token parsing in core
- `fetchUsageSnapshot`: own provider-specific usage endpoint fetch/parsing while core keeps summary fan-out and formatting

Rule of thumb:

- provider owns a catalog or base URL defaults: use `catalog`
- provider accepts arbitrary upstream model ids: use `resolveDynamicModel`
- provider needs network metadata before resolving unknown ids: add `prepareDynamicModel`
- provider needs transport rewrites but still uses a core transport: use `normalizeResolvedModel`
- provider needs transcript/provider-family quirks: use `capabilities`
- provider needs default request params or per-provider param cleanup: use `prepareExtraParams`
- provider needs request headers/body/model compat wrappers without a custom transport: use `wrapStreamFn`
- provider stores extra metadata in auth profiles and needs a custom runtime token shape: use `formatApiKey`
- provider needs a custom OAuth refresh endpoint or refresh failure policy: use `refreshOAuth`
- provider needs provider-owned auth repair guidance after refresh failure: use `buildAuthDoctorHint`
- provider needs proxy-specific cache TTL gating: use `isCacheTtlEligible`
- provider needs a provider-specific missing-auth recovery hint: use `buildMissingAuthMessage`
- provider needs to hide stale upstream rows or replace them with a vendor hint: use `suppressBuiltInModel`
- provider needs synthetic forward-compat rows in `models list` and pickers: use `augmentModelCatalog`
- provider exposes only binary thinking on/off: use `isBinaryThinking`
- provider wants `xhigh` on only a subset of models: use `supportsXHighThinking`
- provider owns default `/think` policy for a model family: use `resolveDefaultThinkingLevel`
- provider owns live/smoke preferred-model matching: use `isModernModelRef`
- provider needs a token exchange or short-lived request credential: use `prepareRuntimeAuth`
- provider needs custom usage/quota token parsing or a different usage credential: use `resolveUsageAuth`
- provider needs a provider-specific usage endpoint or payload parser: use `fetchUsageSnapshot`

If the provider needs a fully custom wire protocol or custom request executor,
that is a different class of extension. These hooks are for provider behavior
that still runs on OpenClaw's normal inference loop.

### Provider Example

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
  resolveUsageAuth: async (ctx) => {
    const auth = await ctx.resolveOAuthToken();
    return auth ? { token: auth.token } : null;
  },
  fetchUsageSnapshot: async (ctx) => {
    return await fetchExampleProxyUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
  },
});
```

### Built-in examples

- Anthropic uses `resolveDynamicModel`, `capabilities`, `buildAuthDoctorHint`,
  `resolveUsageAuth`, `fetchUsageSnapshot`, `isCacheTtlEligible`,
  `resolveDefaultThinkingLevel`, and `isModernModelRef` because it owns Claude
  4.6 forward-compat, provider-family hints, auth repair guidance, usage
  endpoint integration, prompt-cache eligibility, and Claude default/adaptive
  thinking policy.
- OpenAI uses `resolveDynamicModel`, `normalizeResolvedModel`, and
  `capabilities` plus `buildMissingAuthMessage`, `suppressBuiltInModel`,
  `augmentModelCatalog`, `supportsXHighThinking`, and `isModernModelRef`
  because it owns GPT-5.4 forward-compat, the direct OpenAI
  `openai-completions` -> `openai-responses` normalization, Codex-aware auth
  hints, Spark suppression, synthetic OpenAI list rows, and GPT-5 thinking /
  live-model policy.
- OpenRouter uses `catalog` plus `resolveDynamicModel` and
  `prepareDynamicModel` because the provider is pass-through and may expose new
  model ids before OpenClaw's static catalog updates.
- GitHub Copilot uses `catalog`, `auth`, `resolveDynamicModel`, and
  `capabilities` plus `prepareRuntimeAuth` and `fetchUsageSnapshot` because it
  needs provider-owned device login, model fallback behavior, Claude transcript
  quirks, a GitHub token -> Copilot token exchange, and a provider-owned usage
  endpoint.
- OpenAI Codex uses `catalog`, `resolveDynamicModel`,
  `normalizeResolvedModel`, `refreshOAuth`, and `augmentModelCatalog` plus
  `prepareExtraParams`, `resolveUsageAuth`, and `fetchUsageSnapshot` because it
  still runs on core OpenAI transports but owns its transport/base URL
  normalization, OAuth refresh fallback policy, default transport choice,
  synthetic Codex catalog rows, and ChatGPT usage endpoint integration.
- Google AI Studio and Gemini CLI OAuth use `resolveDynamicModel` and
  `isModernModelRef` because they own Gemini 3.1 forward-compat fallback and
  modern-model matching; Gemini CLI OAuth also uses `formatApiKey`,
  `resolveUsageAuth`, and `fetchUsageSnapshot` for token formatting, token
  parsing, and quota endpoint wiring.
- OpenRouter uses `capabilities`, `wrapStreamFn`, and `isCacheTtlEligible`
  to keep provider-specific request headers, routing metadata, reasoning
  patches, and prompt-cache policy out of core.
- Moonshot uses `catalog` plus `wrapStreamFn` because it still uses the shared
  OpenAI transport but needs provider-owned thinking payload normalization.
- Kilocode uses `catalog`, `capabilities`, `wrapStreamFn`, and
  `isCacheTtlEligible` because it needs provider-owned request headers,
  reasoning payload normalization, Gemini transcript hints, and Anthropic
  cache-TTL gating.
- Z.AI uses `resolveDynamicModel`, `prepareExtraParams`, `wrapStreamFn`,
  `isCacheTtlEligible`, `isBinaryThinking`, `isModernModelRef`,
  `resolveUsageAuth`, and `fetchUsageSnapshot` because it owns GLM-5 fallback,
  `tool_stream` defaults, binary thinking UX, modern-model matching, and both
  usage auth + quota fetching.
- Mistral, OpenCode Zen, and OpenCode Go use `capabilities` only to keep
  transcript/tooling quirks out of core.
- Catalog-only bundled providers such as `byteplus`, `cloudflare-ai-gateway`,
  `huggingface`, `kimi-coding`, `modelstudio`, `nvidia`, `qianfan`,
  `synthetic`, `together`, `venice`, `vercel-ai-gateway`, and `volcengine` use
  `catalog` only.
- Qwen portal uses `catalog`, `auth`, and `refreshOAuth`.
- MiniMax and Xiaomi use `catalog` plus usage hooks because their `/usage`
  behavior is plugin-owned even though inference still runs through the shared
  transports.

## Load pipeline

At startup, OpenClaw does roughly this:

1. discover candidate plugin roots
2. read native or compatible bundle manifests and package metadata
3. reject unsafe candidates
4. normalize plugin config (`plugins.enabled`, `allow`, `deny`, `entries`,
   `slots`, `load.paths`)
5. decide enablement for each candidate
6. load enabled native modules via jiti
7. call native `register(api)` hooks and collect registrations into the plugin registry
8. expose the registry to commands/runtime surfaces

The safety gates happen **before** runtime execution. Candidates are blocked
when the entry escapes the plugin root, the path is world-writable, or path
ownership looks suspicious for non-bundled plugins.

### Manifest-first behavior

The manifest is the control-plane source of truth. OpenClaw uses it to:

- identify the plugin
- discover declared channels/skills/config schema or bundle capabilities
- validate `plugins.entries.<id>.config`
- augment Control UI labels/placeholders
- show install/catalog metadata

For native plugins, the runtime module is the data-plane part. It registers
actual behavior such as hooks, tools, commands, or provider flows.

### What the loader caches

OpenClaw keeps short in-process caches for:

- discovery results
- manifest registry data
- loaded plugin registries

These caches reduce bursty startup and repeated command overhead. They are safe
to think of as short-lived performance caches, not persistence.

## Runtime helpers

Plugins can access selected core helpers via `api.runtime`. For TTS:

```ts
const clip = await api.runtime.tts.textToSpeech({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const voices = await api.runtime.tts.listVoices({
  provider: "elevenlabs",
  cfg: api.config,
});
```

Notes:

- `textToSpeech` returns the normal core TTS output payload for file/voice-note surfaces.
- Uses core `messages.tts` configuration and provider selection.
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- `listVoices` is optional per provider. Use it for vendor-owned voice pickers or setup flows.
- Voice listings can include richer metadata such as locale, gender, and personality tags for provider-aware pickers.
- OpenAI and ElevenLabs support telephony today. Microsoft does not.

Plugins can also register speech providers via `api.registerSpeechProvider(...)`.

```ts
api.registerSpeechProvider({
  id: "acme-speech",
  label: "Acme Speech",
  isConfigured: ({ config }) => Boolean(config.messages?.tts),
  synthesize: async (req) => {
    return {
      audioBuffer: Buffer.from([]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    };
  },
});
```

Notes:

- Keep TTS policy, fallback, and reply delivery in core.
- Use speech providers for vendor-owned synthesis behavior.
- Legacy Microsoft `edge` input is normalized to the `microsoft` provider id.
- The preferred ownership model is company-oriented: one vendor plugin can own
  text, speech, image, and future media providers as OpenClaw adds those
  capability contracts.

For image/audio/video understanding, plugins register one typed
media-understanding provider instead of a generic key/value bag:

```ts
api.registerMediaUnderstandingProvider({
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: async (req) => ({ text: "..." }),
  transcribeAudio: async (req) => ({ text: "..." }),
  describeVideo: async (req) => ({ text: "..." }),
});
```

Notes:

- Keep orchestration, fallback, config, and channel wiring in core.
- Keep vendor behavior in the provider plugin.
- Additive expansion should stay typed: new optional methods, new optional
  result fields, new optional capabilities.
- If OpenClaw adds a new capability such as video generation later, define the
  core capability contract first, then let vendor plugins register against it.

For media-understanding runtime helpers, plugins can call:

```ts
const image = await api.runtime.mediaUnderstanding.describeImageFile({
  filePath: "/tmp/inbound-photo.jpg",
  cfg: api.config,
  agentDir: "/tmp/agent",
});

const video = await api.runtime.mediaUnderstanding.describeVideoFile({
  filePath: "/tmp/inbound-video.mp4",
  cfg: api.config,
});
```

For audio transcription, plugins can use either the media-understanding runtime
or the older STT alias:

```ts
const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // Optional when MIME cannot be inferred reliably:
  mime: "audio/ogg",
});
```

Notes:

- `api.runtime.mediaUnderstanding.*` is the preferred shared surface for
  image/audio/video understanding.
- Uses core media-understanding audio configuration (`tools.media.audio`) and provider fallback order.
- Returns `{ text: undefined }` when no transcription output is produced (for example skipped/unsupported input).
- `api.runtime.stt.transcribeAudioFile(...)` remains as a compatibility alias.

Plugins can also launch background subagent runs through `api.runtime.subagent`:

```ts
const result = await api.runtime.subagent.run({
  sessionKey: "agent:main:subagent:search-helper",
  message: "Expand this query into focused follow-up searches.",
  provider: "openai",
  model: "gpt-4.1-mini",
  deliver: false,
});
```

Notes:

- `provider` and `model` are optional per-run overrides, not persistent session changes.
- OpenClaw only honors those override fields for trusted callers.
- For plugin-owned fallback runs, operators must opt in with `plugins.entries.<id>.subagent.allowModelOverride: true`.
- Use `plugins.entries.<id>.subagent.allowedModels` to restrict trusted plugins to specific canonical `provider/model` targets, or `"*"` to allow any target explicitly.
- Untrusted plugin subagent runs still work, but override requests are rejected instead of silently falling back.

For web search, plugins can consume the shared runtime helper instead of
reaching into the agent tool wiring:

```ts
const providers = api.runtime.webSearch.listProviders({
  config: api.config,
});

const result = await api.runtime.webSearch.search({
  config: api.config,
  args: {
    query: "OpenClaw plugin runtime helpers",
    count: 5,
  },
});
```

Plugins can also register web-search providers via
`api.registerWebSearchProvider(...)`.

Notes:

- Keep provider selection, credential resolution, and shared request semantics in core.
- Use web-search providers for vendor-specific search transports.
- `api.runtime.webSearch.*` is the preferred shared surface for feature/channel plugins that need search behavior without depending on the agent tool wrapper.

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

- `openclaw/plugin-sdk/core` for the smallest generic plugin-facing contract.
- Domain subpaths such as `openclaw/plugin-sdk/channel-config-helpers`,
  `openclaw/plugin-sdk/channel-config-schema`,
  `openclaw/plugin-sdk/channel-policy`,
  `openclaw/plugin-sdk/lazy-runtime`,
  `openclaw/plugin-sdk/reply-history`,
  `openclaw/plugin-sdk/routing`,
  `openclaw/plugin-sdk/runtime-store`, and
  `openclaw/plugin-sdk/directory-runtime` for shared runtime/config helpers.
- `openclaw/plugin-sdk/compat` remains as a legacy migration surface for older
  external plugins. Bundled plugins should not use it, and non-test imports emit
  a one-time deprecation warning outside test environments.
- Bundled extension internals remain private. External plugins should use only
  `openclaw/plugin-sdk/*` subpaths. OpenClaw core/test code may use the repo
  public entry points under `extensions/<id>/index.js`, `api.js`, `runtime-api.js`,
  `setup-entry.js`, and narrowly scoped files such as `login-qr-api.js`. Never
  import `extensions/<id>/src/*` from core or from another extension.
- Repo entry point split:
  `extensions/<id>/api.js` is the helper/types barrel,
  `extensions/<id>/runtime-api.js` is the runtime-only barrel,
  `extensions/<id>/index.js` is the bundled plugin entry,
  and `extensions/<id>/setup-entry.js` is the setup plugin entry.
- `openclaw/plugin-sdk/telegram` for Telegram channel plugin types and shared channel-facing helpers. Built-in Telegram implementation internals stay private to the bundled extension.
- `openclaw/plugin-sdk/discord` for Discord channel plugin types and shared channel-facing helpers. Built-in Discord implementation internals stay private to the bundled extension.
- `openclaw/plugin-sdk/slack` for Slack channel plugin types and shared channel-facing helpers. Built-in Slack implementation internals stay private to the bundled extension.
- `openclaw/plugin-sdk/signal` for Signal channel plugin types and shared channel-facing helpers. Built-in Signal implementation internals stay private to the bundled extension.
- `openclaw/plugin-sdk/imessage` for iMessage channel plugin types and shared channel-facing helpers. Built-in iMessage implementation internals stay private to the bundled extension.
- `openclaw/plugin-sdk/whatsapp` for WhatsApp channel plugin types and shared channel-facing helpers. Built-in WhatsApp implementation internals stay private to the bundled extension.
- `openclaw/plugin-sdk/line` for LINE channel plugins.
- `openclaw/plugin-sdk/msteams` for the bundled Microsoft Teams plugin surface.
- Bundled extension-specific subpaths are also available:
  `openclaw/plugin-sdk/acpx`, `openclaw/plugin-sdk/bluebubbles`,
  `openclaw/plugin-sdk/copilot-proxy`, `openclaw/plugin-sdk/device-pair`,
  `openclaw/plugin-sdk/diagnostics-otel`, `openclaw/plugin-sdk/diffs`,
  `openclaw/plugin-sdk/feishu`, `openclaw/plugin-sdk/googlechat`,
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
  subpaths; use `core` plus explicit domain subpaths for generic surfaces, and
  treat `compat` as migration-only.

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

4. Bundled extensions (shipped with OpenClaw; mixed default-on/default-off)

- `<openclaw>/extensions/*`

Many bundled provider plugins are enabled by default so model catalogs/runtime
hooks stay available without extra setup. Others still require explicit
enablement via `plugins.entries.<id>.enabled` or
`openclaw plugins enable <id>`.

Default-on bundled plugin examples:

- `byteplus`
- `cloudflare-ai-gateway`
- `device-pair`
- `github-copilot`
- `huggingface`
- `kilocode`
- `kimi-coding`
- `minimax`
- `minimax`
- `modelstudio`
- `moonshot`
- `nvidia`
- `ollama`
- `openai`
- `openrouter`
- `phone-control`
- `qianfan`
- `qwen-portal-auth`
- `sglang`
- `synthetic`
- `talk-voice`
- `together`
- `venice`
- `vercel-ai-gateway`
- `vllm`
- `volcengine`
- `xiaomi`
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

Each native OpenClaw plugin must include a `openclaw.plugin.json` file in its
root. If a path points at a file, the plugin root is the file's directory and
must contain the manifest.

Compatible bundles may instead provide one of:

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`

Bundle directories are discovered from the same roots as native plugins.

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

In current core, bundled default-on ids include the local/provider helpers
above plus the active memory slot plugin.

### Package packs

A plugin directory may include a `package.json` with `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"],
    "setupEntry": "./src/setup-entry.ts"
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

Optional: `openclaw.setupEntry` can point at a lightweight setup-only module.
When OpenClaw needs setup surfaces for a disabled channel plugin, or
when a channel plugin is enabled but still unconfigured, it loads `setupEntry`
instead of the full plugin entry. This keeps startup and setup lighter
when your main plugin entry also wires tools, hooks, or other runtime-only
code.

Optional: `openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen`
can opt a channel plugin into the same `setupEntry` path during the gateway's
pre-listen startup phase, even when the channel is already configured.

Use this only when `setupEntry` fully covers the startup surface that must exist
before the gateway starts listening. In practice, that means the setup entry
must register every channel-owned capability that startup depends on, such as:

- channel registration itself
- any HTTP routes that must be available before the gateway starts listening
- any gateway methods, tools, or services that must exist during that same window

If your full entry still owns any required startup capability, do not enable
this flag. Keep the plugin on the default behavior and let OpenClaw load the
full entry during startup.

Example:

```json
{
  "name": "@scope/my-channel",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

### Channel catalog metadata

Channel plugins can advertise setup/discovery metadata via `openclaw.channel` and
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
- Native plugin config is validated using the JSON Schema embedded in
  `openclaw.plugin.json` (`configSchema`).
- Compatible bundles currently do not expose native OpenClaw config schemas.
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
openclaw plugins inspect <id>
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

`openclaw plugins list` shows the top-level format as `openclaw` or `bundle`.
Verbose list/info output also shows bundle subtype (`codex` or `claude`) plus
detected bundle capabilities.

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
- `registerSpeechProvider`
- `registerMediaUnderstandingProvider`
- `registerWebSearchProvider`
- `registerHttpRoute`
- `registerCommand`
- `registerCli`
- `registerContextEngine`
- `registerService`

In practice, `register(api)` is also where a plugin declares **ownership**.
That ownership should map cleanly to either:

- a vendor surface such as OpenAI, ElevenLabs, or Microsoft
- a feature surface such as Voice Call

Avoid splitting one vendor's capabilities across unrelated plugins unless there
is a strong product reason to do so. The default should be one plugin per
vendor/feature, with core capability contracts separating shared orchestration
from vendor-specific behavior.

## Adding a new capability

When a plugin needs behavior that does not fit the current API, do not bypass
the plugin system with a private reach-in. Add the missing capability.

Recommended sequence:

1. define the core contract
   Decide what shared behavior core should own: policy, fallback, config merge,
   lifecycle, channel-facing semantics, and runtime helper shape.
2. add typed plugin registration/runtime surfaces
   Extend `OpenClawPluginApi` and/or `api.runtime` with the smallest useful
   typed capability surface.
3. wire core + channel/feature consumers
   Channels and feature plugins should consume the new capability through core,
   not by importing a vendor implementation directly.
4. register vendor implementations
   Vendor plugins then register their backends against the capability.
5. add contract coverage
   Add tests so ownership and registration shape stay explicit over time.

This is how OpenClaw stays opinionated without becoming hardcoded to one
provider's worldview.

### Capability checklist

When you add a new capability, the implementation should usually touch these
surfaces together:

- core contract types in `src/<capability>/types.ts`
- core runner/runtime helper in `src/<capability>/runtime.ts`
- plugin API registration surface in `src/plugins/types.ts`
- plugin registry wiring in `src/plugins/registry.ts`
- plugin runtime exposure in `src/plugins/runtime/*` when feature/channel
  plugins need to consume it
- capture/test helpers in `src/test-utils/plugin-registration.ts`
- ownership/contract assertions in `src/plugins/contracts/registry.ts`
- operator/plugin docs in `docs/`

If one of those surfaces is missing, that is usually a sign the capability is
not fully integrated yet.

### Capability template

Minimal pattern:

```ts
// core contract
export type VideoGenerationProviderPlugin = {
  id: string;
  label: string;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

// plugin API
api.registerVideoGenerationProvider({
  id: "openai",
  label: "OpenAI",
  async generateVideo(req) {
    return await generateOpenAiVideo(req);
  },
});

// shared runtime helper for feature/channel plugins
const clip = await api.runtime.videoGeneration.generateFile({
  prompt: "Show the robot walking through the lab.",
  cfg,
});
```

Contract test pattern:

```ts
expect(findVideoGenerationProviderIdsForPlugin("openai")).toEqual(["openai"]);
```

That keeps the rule simple:

- core owns the capability contract + orchestration
- vendor plugins own vendor implementations
- feature/channel plugins consume runtime helpers
- contract tests keep ownership explicit

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

Provider plugins are the modular extension surface for model-provider setup.
They are not just "OAuth helpers" anymore.

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
   `wizard.setup` adds an entry to `openclaw onboard`.
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
- agent/workspace dirs so the provider can persist auth into the same scoped
  store used by the rest of onboarding
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

Provider auth/onboarding metadata can live in two layers:

- manifest `providerAuthChoices`: cheap labels, grouping, `--auth-choice`
  ids, and simple CLI flag metadata available before runtime load
- runtime `wizard.setup` / `auth[].wizard`: richer behavior that depends on
  loaded provider code

Use manifest metadata for static labels/flags. Use runtime wizard metadata when
setup depends on dynamic auth methods, method fallback, or runtime validation.

`wizard.setup` controls how the provider appears in grouped onboarding:

- `choiceId`: auth-choice value
- `choiceLabel`: option label
- `choiceHint`: short hint
- `groupId`: group bucket id
- `groupLabel`: group label
- `groupHint`: group hint
- `methodId`: auth method to run
- `modelAllowlist`: optional post-auth allowlist policy (`allowedKeys`, `initialSelections`, `message`)

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
    setup: {
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
  `openUrl`, `oauth.createVpsAwareHandlers`, `secretInputMode`, and
  `allowSecretRefPrompt` helpers/state. Onboarding/configure flows can use
  these to honor `--secret-input-mode` or offer env/file/exec secret-ref
  capture, while `openclaw models auth` keeps a tighter prompt surface.
- `runNonInteractive` receives a `ProviderAuthMethodNonInteractiveContext`
  with `opts`, `agentDir`, `resolveApiKey`, and `toApiKeyCredential` helpers
  for headless onboarding.
- Return `configPatch` when you need to add default models or provider config.
- Return `defaultModel` so `--set-default` can update agent defaults.
- `wizard.setup` adds a provider choice to onboarding surfaces such as
  `openclaw onboard` / `openclaw setup --wizard`.
- `wizard.setup.modelAllowlist` lets the provider narrow the follow-up model
  allowlist prompt during onboarding/configure.
- `wizard.modelPicker` adds a “setup this provider” entry to the model picker.
- `deprecatedProfileIds` lets the provider own `openclaw doctor` cleanup for
  retired auth-profile ids.
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

### Channel setup hooks

Preferred setup split:

- `plugin.setup` owns account-id normalization, validation, and config writes.
- `plugin.setupWizard` lets the host run the common wizard flow while the channel only supplies status, credential, DM allowlist, and channel-access descriptors.

`plugin.setupWizard` is best for channels that fit the shared pattern:

- one account picker driven by `plugin.config.listAccountIds`
- optional preflight/prepare step before prompting (for example installer/bootstrap work)
- optional env-shortcut prompt for bundled credential sets (for example paired bot/app tokens)
- one or more credential prompts, with each step either writing through `plugin.setup.applyAccountConfig` or a channel-owned partial patch
- optional non-secret text prompts (for example CLI paths, base URLs, account ids)
- optional channel/group access allowlist prompts resolved by the host
- optional DM allowlist resolution (for example `@username` -> numeric id)
- optional completion note after setup finishes

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

- `setup` (validation + config writes), `setupWizard` (host-owned wizard), `security` (DM policy), `status` (health/diagnostics)
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
- Optional: `openclaw.setupEntry` may point at a lightweight setup-only entry for disabled or still-unconfigured channel setup.
- Optional: `openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen` may opt a channel plugin into using `setupEntry` during pre-listen gateway startup, but only when that setup entry completely covers the plugin's startup-critical surface.
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

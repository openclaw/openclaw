---
summary: "OpenClaw plugins/extensions: discovery, config, and safety"
read_when:
  - Adding or modifying plugins/extensions
  - Documenting plugin install or load rules
  - Working with Codex/Claude-compatible plugin bundles
title: "Plugins"
---

# Plugins (Extensions)

## Quick start

A plugin is either:

- a native **OpenClaw plugin** (`openclaw.plugin.json` + runtime module), or
- a compatible **bundle** (`.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`)

Both show up under `openclaw plugins`, but only native OpenClaw plugins execute
runtime code in-process.

1. See what is already loaded:

```bash
openclaw plugins list
```

2. Install an official plugin (example: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

Npm specs are registry-only. See [install rules](/cli/plugins#install) for
details on pinning, prerelease gating, and supported spec formats.

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

## Available plugins (official)

### Installable plugins

These are published to npm and installed with `openclaw plugins install`:

| Plugin          | Package                | Docs                               |
| --------------- | ---------------------- | ---------------------------------- |
| Matrix          | `@openclaw/matrix`     | [Matrix](/channels/matrix)         |
| Microsoft Teams | `@openclaw/msteams`    | [MS Teams](/channels/msteams)      |
| Nostr           | `@openclaw/nostr`      | [Nostr](/channels/nostr)           |
| Voice Call      | `@openclaw/voice-call` | [Voice Call](/plugins/voice-call)  |
| Zalo            | `@openclaw/zalo`       | [Zalo](/channels/zalo)             |
| Zalo Personal   | `@openclaw/zalouser`   | [Zalo Personal](/plugins/zalouser) |

Microsoft Teams is plugin-only as of 2026.1.15.

### Bundled plugins

These ship with OpenClaw and are enabled by default unless noted.

**Memory:**

- `memory-core` -- bundled memory search (default via `plugins.slots.memory`)
- `memory-lancedb` -- long-term memory with auto-recall/capture (set `plugins.slots.memory = "memory-lancedb"`)

**Model providers** (all enabled by default):

`anthropic`, `byteplus`, `cloudflare-ai-gateway`, `github-copilot`, `google`, `huggingface`, `kilocode`, `kimi-coding`, `minimax`, `mistral`, `modelstudio`, `moonshot`, `nvidia`, `openai`, `opencode`, `opencode-go`, `openrouter`, `qianfan`, `qwen-portal-auth`, `synthetic`, `together`, `venice`, `vercel-ai-gateway`, `volcengine`, `xiaomi`, `zai`

**Speech providers** (enabled by default):

`elevenlabs`, `microsoft`

**Other bundled:**

- `copilot-proxy` -- VS Code Copilot Proxy bridge (disabled by default)

## Compatible bundles

OpenClaw also recognizes compatible external bundle layouts:

- Codex-style bundles: `.codex-plugin/plugin.json`
- Claude-style bundles: `.claude-plugin/plugin.json` or the default Claude
  component layout without a manifest
- Cursor-style bundles: `.cursor-plugin/plugin.json`

They are shown in the plugin list as `format=bundle`, with a subtype of
`codex`, `claude`, or `cursor` in verbose/inspect output.

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
- Morph — bundled fast compaction (33k tok/s) and AI-powered codebase search. Set `compaction.provider = "morph"` and configure API key via `MORPH_API_KEY` env var or plugin config. See [Compaction](/concepts/compaction).
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

Native OpenClaw plugins run in-process with the Gateway (see
[Execution model](#execution-model) for trust implications).
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
- `entries.<id>`: per-plugin toggles + config

Config changes **require a gateway restart**. See
[Configuration reference](/configuration) for the full config schema.

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

## Discovery and precedence

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

Installed plugins are enabled by default, but can be disabled the same way.

Workspace plugins are **disabled by default** unless you explicitly enable them
or allowlist them. This is intentional: a checked-out repo should not silently
become production gateway code.

If multiple plugins resolve to the same id, the first match in the order above
wins and lower-precedence copies are ignored.

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
Declare `kind` in your [plugin manifest](/plugins/manifest).

## Plugin IDs

Default plugin ids:

- Package packs: `package.json` `name`
- Standalone file: file base name (`~/.../voice-call.ts` -> `voice-call`)

If a plugin exports `id`, OpenClaw uses it but warns when it does not match the
configured id.

## Inspection

```bash
openclaw plugins inspect openai        # deep detail on one plugin
openclaw plugins inspect openai --json # machine-readable
openclaw plugins list                  # compact inventory
openclaw plugins status                # operational summary
openclaw plugins doctor                # issue-focused diagnostics
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
openclaw plugins install @openclaw/voice-call   # install from npm
openclaw plugins install @openclaw/voice-call --pin # store exact resolved name@version
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

See [`openclaw plugins` CLI reference](/cli/plugins) for full details on each
command (install rules, inspect output, marketplace installs, uninstall).

Plugins may also register their own top-level commands (example:
`openclaw voicecall`).

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

See [Plugin manifest](/plugins/manifest) for the manifest file format.

## Further reading

- [Plugin architecture and internals](/plugins/architecture) -- capability model,
  ownership model, contracts, load pipeline, runtime helpers, and developer API
  reference
- [Building extensions](/plugins/building-extensions)
- [Plugin bundles](/plugins/bundles)
- [Plugin manifest](/plugins/manifest)
- [Plugin agent tools](/plugins/agent-tools)
- [Capability Cookbook](/tools/capability-cookbook)
- [Community plugins](/plugins/community)

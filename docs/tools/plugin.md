---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw plugins/extensions: discovery, config, and safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying plugins/extensions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Documenting plugin install or load rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Plugins"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Plugins (Extensions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start (new to plugins?)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A plugin is just a **small code module** that extends OpenClaw with extra（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
features (commands, tools, and Gateway RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most of the time, you’ll use plugins when you want a feature that’s not built（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
into core OpenClaw yet (or you want to keep optional features out of your main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
install).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fast path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. See what’s already loaded:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Install an official plugin (example: Voice Call):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Restart the Gateway, then configure under `plugins.entries.<id>.config`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Voice Call](/plugins/voice-call) for a concrete example plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Available plugins (official)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Microsoft Teams is plugin-only as of 2026.1.15; install `@openclaw/msteams` if you use Teams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory (Core) — bundled memory search plugin (enabled by default via `plugins.slots.memory`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory (LanceDB) — bundled long-term memory plugin (auto-recall/capture; set `plugins.slots.memory = "memory-lancedb"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Matrix](/channels/matrix) — `@openclaw/matrix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Nostr](/channels/nostr) — `@openclaw/nostr`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Zalo](/channels/zalo) — `@openclaw/zalo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google Antigravity OAuth (provider auth) — bundled as `google-antigravity-auth` (disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gemini CLI OAuth (provider auth) — bundled as `google-gemini-cli-auth` (disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Qwen OAuth (provider auth) — bundled as `qwen-portal-auth` (disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Copilot Proxy (provider auth) — local VS Code Copilot Proxy bridge; distinct from built-in `github-copilot` device login (bundled, disabled by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw plugins are **TypeScript modules** loaded at runtime via jiti. **Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
validation does not execute plugin code**; it uses the plugin manifest and JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Schema instead. See [Plugin manifest](/plugins/manifest).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can register:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway RPC methods（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway HTTP handlers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Background services（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optional config validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Skills** (by listing `skills` directories in the plugin manifest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Auto-reply commands** (execute without invoking the AI agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins run **in‑process** with the Gateway, so treat them as trusted code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool authoring guide: [Plugin agent tools](/plugins/agent-tools).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Runtime helpers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can access selected core helpers via `api.runtime`. For telephony TTS:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const result = await api.runtime.tts.textToSpeechTelephony({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  text: "Hello from OpenClaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cfg: api.config,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses core `messages.tts` configuration (OpenAI or ElevenLabs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Edge TTS is not supported for telephony.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Discovery & precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw scans, in order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Config paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `plugins.load.paths` (file or directory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Workspace extensions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `<workspace>/.openclaw/extensions/*.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `<workspace>/.openclaw/extensions/*/index.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Global extensions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/extensions/*.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/extensions/*/index.ts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Bundled extensions (shipped with OpenClaw, **disabled by default**)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `<openclaw>/extensions/*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bundled plugins must be enabled explicitly via `plugins.entries.<id>.enabled`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or `openclaw plugins enable <id>`. Installed plugins are enabled by default,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
but can be disabled the same way.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each plugin must include a `openclaw.plugin.json` file in its root. If a path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
points at a file, the plugin root is the file's directory and must contain the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
manifest.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If multiple plugins resolve to the same id, the first match in the order above（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wins and lower-precedence copies are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Package packs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A plugin directory may include a `package.json` with `openclaw.extensions`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "my-pack",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "openclaw": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "extensions": ["./src/safety.ts", "./src/tools.ts"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
becomes `name/<fileBase>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your plugin imports npm deps, install them in that directory so（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`node_modules` is available (`npm install` / `pnpm install`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Channel catalog metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel plugins can advertise onboarding metadata via `openclaw.channel` and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
install hints via `openclaw.install`. This keeps the core catalog data-free.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "name": "@openclaw/nextcloud-talk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "openclaw": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "extensions": ["./index.ts"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "channel": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "id": "nextcloud-talk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "label": "Nextcloud Talk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "selectionLabel": "Nextcloud Talk (self-hosted)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "docsPath": "/channels/nextcloud-talk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "docsLabel": "nextcloud-talk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "order": 65,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "aliases": ["nc-talk", "nc"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "install": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "npmSpec": "@openclaw/nextcloud-talk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "localPath": "extensions/nextcloud-talk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "defaultChoice": "npm"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can also merge **external channel catalogs** (for example, an MPM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
registry export). Drop a JSON file at one of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/mpm/plugins.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/mpm/catalog.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/plugins/catalog.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or point `OPENCLAW_PLUGIN_CATALOG_PATHS` (or `OPENCLAW_MPM_CATALOG_PATHS`) at（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
one or more JSON files (comma/semicolon/`PATH`-delimited). Each file should（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin IDs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default plugin ids:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Package packs: `package.json` `name`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Standalone file: file base name (`~/.../voice-call.ts` → `voice-call`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a plugin exports `id`, OpenClaw uses it but warns when it doesn’t match the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
configured id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allow: ["voice-call"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    deny: ["untrusted-plugin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    load: { paths: ["~/Projects/oss/voice-call-extension"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "voice-call": { enabled: true, config: { provider: "twilio" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`: master toggle (default: true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allow`: allowlist (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deny`: denylist (optional; deny wins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `load.paths`: extra plugin files/dirs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `entries.<id>`: per‑plugin toggles + config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Config changes **require a gateway restart**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Validation rules (strict):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown plugin ids in `entries`, `allow`, `deny`, or `slots` are **errors**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown `channels.<id>` keys are **errors** unless a plugin manifest declares（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the channel id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin config is validated using the JSON Schema embedded in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openclaw.plugin.json` (`configSchema`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a plugin is disabled, its config is preserved and a **warning** is emitted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin slots (exclusive categories)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some plugin categories are **exclusive** (only one active at a time). Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`plugins.slots` to select which plugin owns the slot:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slots: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      memory: "memory-core", // or "none" to disable memory plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If multiple plugins declare `kind: "memory"`, only the selected one loads. Others（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
are disabled with diagnostics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Control UI (schema + labels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI uses `config.schema` (JSON Schema + `uiHints`) to render better forms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw augments `uiHints` at runtime based on discovered plugins:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Adds per-plugin labels for `plugins.entries.<id>` / `.enabled` / `.config`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Merges optional plugin-provided config field hints under:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `plugins.entries.<id>.config.<field>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want your plugin config fields to show good labels/placeholders (and mark secrets as sensitive),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provide `uiHints` alongside your JSON Schema in the plugin manifest.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "id": "my-plugin",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "configSchema": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "type": "object",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "additionalProperties": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "properties": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "apiKey": { "type": "string" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "region": { "type": "string" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "uiHints": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "apiKey": { "label": "API Key", "sensitive": true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "region": { "label": "Region", "placeholder": "us-east-1" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins info <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/voice-call # relative path ok（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./plugin.tgz           # install from a local tarball（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./plugin.zip           # install from a local zip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/voice-call # install from npm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins update <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins update --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins enable <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins disable <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`plugins update` only works for npm installs tracked under `plugins.installs`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins may also register their own top‑level commands (example: `openclaw voicecall`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin API (overview)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins export either:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A function: `(api) => { ... }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- An object: `{ id, name, configSchema, register(api) { ... } }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can ship hooks and register them at runtime. This lets a plugin bundle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
event-driven automation without a separate hook pack install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function register(api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  registerPluginHooksFromDir(api, "./hooks");（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hook directories follow the normal hook structure (`HOOK.md` + `handler.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hook eligibility rules still apply (OS/bins/env/config requirements).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin-managed hooks show up in `openclaw hooks list` with `plugin:<id>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You cannot enable/disable plugin-managed hooks via `openclaw hooks`; enable/disable the plugin instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Provider plugins (model auth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can register **model provider auth** flows so users can run OAuth or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
API-key setup inside OpenClaw (no external scripts needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Register a provider via `api.registerProvider(...)`. Each provider exposes one（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or more auth methods (OAuth, API key, device code, etc.). These methods power:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw models auth login --provider <id> [--method <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
api.registerProvider({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  id: "acme",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  label: "AcmeAI",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  auth: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      id: "oauth",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      label: "OAuth",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      kind: "oauth",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      run: async (ctx) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // Run OAuth flow and return auth profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        return {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          profiles: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              profileId: "acme:default",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              credential: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                type: "oauth",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                provider: "acme",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                access: "...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                refresh: "...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                expires: Date.now() + 3600 * 1000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          defaultModel: "acme/opus-1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `run` receives a `ProviderAuthContext` with `prompter`, `runtime`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `openUrl`, and `oauth.createVpsAwareHandlers` helpers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Return `configPatch` when you need to add default models or provider config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Return `defaultModel` so `--set-default` can update agent defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Register a messaging channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can register **channel plugins** that behave like built‑in channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(WhatsApp, Telegram, etc.). Channel config lives under `channels.<id>` and is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
validated by your channel plugin code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const myChannel = {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  id: "acmechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  meta: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id: "acmechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    label: "AcmeChat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    selectionLabel: "AcmeChat (API)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    docsPath: "/channels/acmechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    blurb: "demo channel plugin.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    aliases: ["acme"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  capabilities: { chatTypes: ["direct"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resolveAccount: (cfg, accountId) =>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        accountId,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  outbound: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    deliveryMode: "direct",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sendText: async () => ({ ok: true }),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerChannel({ plugin: myChannel });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Put config under `channels.<id>` (not `plugins.entries`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.label` is used for labels in CLI/UI lists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.aliases` adds alternate ids for normalization and CLI inputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.preferOver` lists channel ids to skip auto-enable when both are configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.detailLabel` and `meta.systemImage` let UIs show richer channel labels/icons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Write a new messaging channel (step‑by‑step)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this when you want a **new chat surface** (a “messaging channel”), not a model provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model provider docs live under `/providers/*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Pick an id + config shape（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All channel config lives under `channels.<id>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `channels.<id>.accounts.<accountId>` for multi‑account setups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Define the channel metadata（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` control CLI/UI lists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.docsPath` should point at a docs page like `/channels/<id>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.preferOver` lets a plugin replace another channel (auto-enable prefers it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `meta.detailLabel` and `meta.systemImage` are used by UIs for detail text/icons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Implement the required adapters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config.listAccountIds` + `config.resolveAccount`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `capabilities` (chat types, media, threads, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `outbound.deliveryMode` + `outbound.sendText` (for basic send)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Add optional adapters as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `setup` (wizard), `security` (DM policy), `status` (health/diagnostics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `actions` (message actions), `commands` (native command behavior)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Register the channel in your plugin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `api.registerChannel({ plugin })`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    acmechat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: { token: "ACME_TOKEN", enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal channel plugin (outbound‑only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const plugin = {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  id: "acmechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  meta: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id: "acmechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    label: "AcmeChat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    selectionLabel: "AcmeChat (API)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    docsPath: "/channels/acmechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    blurb: "AcmeChat messaging channel.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    aliases: ["acme"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  capabilities: { chatTypes: ["direct"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resolveAccount: (cfg, accountId) =>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        accountId,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  outbound: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    deliveryMode: "direct",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sendText: async ({ text }) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // deliver `text` to your channel here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      return { ok: true };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerChannel({ plugin });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Load the plugin (extensions dir or `plugins.load.paths`), restart the gateway,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
then configure `channels.<id>` in your config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Agent tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See the dedicated guide: [Plugin agent tools](/plugins/agent-tools).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Register a gateway RPC method（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    respond(true, { ok: true });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Register CLI commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerCli(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ({ program }) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      program.command("mycmd").action(() => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        console.log("Hello");（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { commands: ["mycmd"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  );（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Register auto-reply commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can register custom slash commands that execute **without invoking the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
AI agent**. This is useful for toggle commands, status checks, or quick actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
that don't need LLM processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerCommand({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    name: "mystatus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    description: "Show plugin status",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    handler: (ctx) => ({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      text: `Plugin is running! Channel: ${ctx.channel}`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Command handler context:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `senderId`: The sender's ID (if available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel`: The channel where the command was sent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `isAuthorizedSender`: Whether the sender is an authorized user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `args`: Arguments passed after the command (if `acceptsArgs: true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commandBody`: The full command text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config`: The current OpenClaw config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Command options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name`: Command name (without the leading `/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `description`: Help text shown in command lists（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `acceptsArgs`: Whether the command accepts arguments (default: false). If false and arguments are provided, the command won't match and the message falls through to other handlers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireAuth`: Whether to require authorized sender (default: true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `handler`: Function that returns `{ text: string }` (can be async)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example with authorization and arguments:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
api.registerCommand({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  name: "setmode",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  description: "Set plugin mode",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  acceptsArgs: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  requireAuth: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  handler: async (ctx) => {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    const mode = ctx.args?.trim() || "default";（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    await saveMode(mode);（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    return { text: `Mode set to: ${mode}` };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
});（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin commands are processed **before** built-in commands and the AI agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands are registered globally and work across all channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command names are case-insensitive (`/MyStatus` matches `/mystatus`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Command names must start with a letter and contain only letters, numbers, hyphens, and underscores（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reserved command names (like `help`, `status`, `reset`, etc.) cannot be overridden by plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Duplicate command registration across plugins will fail with a diagnostic error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Register background services（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export default function (api) {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  api.registerService({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    id: "my-service",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    start: () => api.logger.info("ready"),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    stop: () => api.logger.info("bye"),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  });（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Naming conventions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway methods: `pluginId.action` (example: `voicecall.status`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: `snake_case` (example: `voice_call`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI commands: kebab or camel, but avoid clashing with core commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can ship a skill in the repo (`skills/<name>/SKILL.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable it with `plugins.entries.<id>.enabled` (or other config gates) and ensure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
it’s present in your workspace/managed skills locations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Distribution (npm)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended packaging:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Main package: `openclaw` (this repo)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: separate npm packages under `@openclaw/*` (example: `@openclaw/voice-call`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Publishing contract:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin `package.json` must include `openclaw.extensions` with one or more entry files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Entry files can be `.js` or `.ts` (jiti loads TS at runtime).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw plugins install <npm-spec>` uses `npm pack`, extracts into `~/.openclaw/extensions/<id>/`, and enables it in config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config key stability: scoped packages are normalized to the **unscoped** id for `plugins.entries.*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Example plugin: Voice Call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This repo includes a voice‑call plugin (Twilio or log fallback):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Source: `extensions/voice-call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skill: `skills/voice-call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw voicecall start|status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool: `voice_call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- RPC: `voicecall.start`, `voicecall.status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (optional `statusCallbackUrl`, `twimlUrl`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config (dev): `provider: "log"` (no network)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Voice Call](/plugins/voice-call) and `extensions/voice-call/README.md` for setup and usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins run in-process with the Gateway. Treat them as trusted code:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only install plugins you trust.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `plugins.allow` allowlists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restart the Gateway after changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugins can (and should) ship tests:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In-repo plugins can keep Vitest tests under `src/**` (example: `src/plugins/voice-call.plugin.test.ts`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Separately published plugins should run their own CI (lint/build/test) and validate `openclaw.extensions` points at the built entrypoint (`dist/index.js`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

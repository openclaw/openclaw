---
summary: "Clawdbot plugins/extensions: discovery, config, and safety"
read_when:
  - Adding or modifying plugins/extensions
  - Documenting plugin install or load rules
---
# Plugins (Extensions)

Clawdbot plugins are **TypeScript modules** loaded at runtime via jiti. They can
register:

- Gateway RPC methods
- Agent tools
- CLI commands
- Background services
- Optional config validation

Plugins run **in‑process** with the Gateway, so treat them as trusted code.

## Discovery & precedence

Clawdbot scans, in order:

1) Global extensions
- `~/.clawdbot/extensions/*.ts`
- `~/.clawdbot/extensions/*/index.ts`

2) Workspace extensions
- `<workspace>/.clawdbot/extensions/*.ts`
- `<workspace>/.clawdbot/extensions/*/index.ts`

3) Config paths
- `plugins.load.paths` (file or directory)

### Package packs

A plugin directory may include a `package.json` with `clawdbot.extensions`:

```json
{
  "name": "my-pack",
  "clawdbot": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

If your plugin imports npm deps, install them in that directory so
`node_modules` is available (`npm install` / `pnpm install`).

## Plugin IDs

Default plugin ids:

- Package packs: `package.json` `name`
- Standalone file: file base name (`~/.../voice-call.ts` → `voice-call`)

If a plugin exports `id`, Clawdbot uses it but warns when it doesn’t match the
configured id.

## Config

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } }
    }
  }
}
```

Fields:
- `enabled`: master toggle (default: true)
- `allow`: allowlist (optional)
- `deny`: denylist (optional; deny wins)
- `load.paths`: extra plugin files/dirs
- `entries.<id>`: per‑plugin toggles + config

Config changes **require a gateway restart**.

## CLI

```bash
clawdbot plugins list
clawdbot plugins info <id>
clawdbot plugins install <path>
clawdbot plugins enable <id>
clawdbot plugins disable <id>
clawdbot plugins doctor
```

Plugins may also register their own top‑level commands (example: `clawdbot voicecall`).

## Plugin API (overview)

Plugins export either:

- A function: `(api) => { ... }`
- An object: `{ id, name, configSchema, register(api) { ... } }`

### Register a tool

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

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
  api.registerCli(({ program }) => {
    program.command("mycmd").action(() => {
      console.log("Hello");
    });
  }, { commands: ["mycmd"] });
}
```

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

## Example plugin: Voice Call

This repo includes a voice‑call plugin (Twilio or log fallback):

- Source: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `clawdbot voicecall start|status`
- Tool: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Config (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (optional `statusCallbackUrl`, `twimlUrl`)
- Config (dev): `provider: "log"` (no network)

See `extensions/voice-call/README.md` for setup and usage.

## Safety notes

Plugins run in-process with the Gateway. Treat them as trusted code:

- Only install plugins you trust.
- Prefer `plugins.allow` allowlists.
- Restart the Gateway after changes.

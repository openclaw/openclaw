---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "All configuration options for ~/.openclaw/openclaw.json with examples"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying config fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Configuration 🔧（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw reads an optional **JSON5** config from `~/.openclaw/openclaw.json` (comments + trailing commas allowed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the file is missing, OpenClaw uses safe-ish defaults (embedded Pi agent + per-sender sessions + workspace `~/.openclaw/workspace`). You usually only need a config to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- restrict who can trigger the bot (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- control group allowlists + mention behavior (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- customize message prefixes (`messages`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- set the agent's workspace (`agents.defaults.workspace` or `agents.list[].workspace`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- tune the embedded agent defaults (`agents.defaults`) and session behavior (`session`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- set per-agent identity (`agents.list[].identity`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **New to configuration?** Check out the [Configuration Examples](/gateway/configuration-examples) guide for complete examples with detailed explanations!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Strict config validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw only accepts configurations that fully match the schema.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unknown keys, malformed types, or invalid values cause the Gateway to **refuse to start** for safety.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When validation fails:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Gateway does not boot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only diagnostic commands are allowed (for example: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw doctor` to see the exact issues.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw doctor --fix` (or `--yes`) to apply migrations/repairs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Doctor never writes changes unless you explicitly opt into `--fix`/`--yes`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Schema + UI hints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway exposes a JSON Schema representation of the config via `config.schema` for UI editors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Control UI renders a form from this schema, with a **Raw JSON** editor as an escape hatch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Channel plugins and extensions can register schema + UI hints for their config, so channel settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
stay schema-driven across apps without hard-coded forms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hints (labels, grouping, sensitive fields) ship alongside the schema so clients can render（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
better forms without hard-coding config knowledge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Apply + restart (RPC)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `config.apply` to validate + write the full config and restart the Gateway in one step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It writes a restart sentinel and pings the last active session after the Gateway comes back.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Warning: `config.apply` replaces the **entire config**. If you want to change only a few keys,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use `config.patch` or `openclaw config set`. Keep a backup of `~/.openclaw/openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Params:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `raw` (string) — JSON5 payload for the entire config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `baseHash` (optional) — config hash from `config.get` (required when a config already exists)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` (optional) — last active session key for the wake-up ping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `note` (optional) — note to include in the restart sentinel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `restartDelayMs` (optional) — delay before restart (default 2000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (via `gateway call`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call config.get --params '{}' # capture payload.hash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call config.apply --params '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "baseHash": "<hash-from-config.get>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "restartDelayMs": 1000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Partial updates (RPC)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `config.patch` to merge a partial update into the existing config without clobbering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
unrelated keys. It applies JSON merge patch semantics:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- objects merge recursively（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `null` deletes a key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- arrays replace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Like `config.apply`, it validates, writes the config, stores a restart sentinel, and schedules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the Gateway restart (with an optional wake when `sessionKey` is provided).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Params:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `raw` (string) — JSON5 payload containing just the keys to change（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `baseHash` (required) — config hash from `config.get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` (optional) — last active session key for the wake-up ping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `note` (optional) — note to include in the restart sentinel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `restartDelayMs` (optional) — delay before restart (default 2000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call config.get --params '{}' # capture payload.hash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call config.patch --params '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "baseHash": "<hash-from-config.get>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "restartDelayMs": 1000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Minimal config (recommended starting point)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Build the default image once with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Self-chat mode (recommended for group control)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To prevent the bot from responding to WhatsApp @-mentions in groups (only respond to specific text triggers):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: { workspace: "~/.openclaw/workspace" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Allowlist is DMs only; including your own number enables self-chat mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15555550123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: { "*": { requireMention: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config Includes (`$include`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Split your config into multiple files using the `$include` directive. This is useful for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Organizing large configs (e.g., per-client agent definitions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sharing common settings across environments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keeping sensitive configs separate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Basic usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ~/.openclaw/openclaw.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: { port: 18789 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Include a single file (replaces the key's value)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { $include: "./agents.json5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Include multiple files (deep-merged in order)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  broadcast: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ~/.openclaw/agents.json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults: { sandbox: { mode: "all", scope: "session" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Merge behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Single file**: Replaces the object containing `$include`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Array of files**: Deep-merges files in order (later files override earlier ones)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **With sibling keys**: Sibling keys are merged after includes (override included values)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sibling keys + arrays/primitives**: Not supported (included content must be an object)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Sibling keys override included values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  $include: "./base.json5", // { a: 1, b: 2 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  b: 99, // Result: { a: 1, b: 99 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Nested includes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Included files can themselves contain `$include` directives (up to 10 levels deep):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// clients/mueller.json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { $include: "./mueller/agents.json5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  broadcast: { $include: "./mueller/broadcast.json5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Path resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Relative paths**: Resolved relative to the including file（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Absolute paths**: Used as-is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Parent directories**: `../` references work as expected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "$include": "./sub/config.json5" }      // relative（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "$include": "/etc/openclaw/base.json5" } // absolute（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{ "$include": "../shared/common.json5" }   // parent dir（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Missing file**: Clear error with resolved path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Parse error**: Shows which included file failed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Circular includes**: Detected and reported with include chain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example: Multi-client legal setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ~/.openclaw/openclaw.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: { port: 18789, auth: { token: "secret" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Common agent defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: { mode: "all", scope: "session" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Merge agent lists from all clients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Merge broadcast configs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  broadcast: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: { whatsapp: { groupPolicy: "allowlist" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ~/.openclaw/clients/mueller/agents.json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// ~/.openclaw/clients/mueller/broadcast.json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Env vars + `.env`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw reads env vars from the parent process (shell, launchd/systemd, CI, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Additionally, it loads:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `.env` from the current working directory (if present)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a global fallback `.env` from `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Neither `.env` file overrides existing env vars.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can also provide inline env vars in config. These are only applied if the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
process env is missing the key (same non-overriding rule):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    OPENROUTER_API_KEY: "sk-or-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    vars: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      GROQ_API_KEY: "gsk-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/environment](/help/environment) for full precedence and sources.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `env.shellEnv` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Opt-in convenience: if enabled and none of the expected keys are set yet, OpenClaw runs your login shell and imports only the missing expected keys (never overrides).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This effectively sources your shell profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    shellEnv: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      timeoutMs: 15000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Env var equivalent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_LOAD_SHELL_ENV=1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Env var substitution in config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can reference environment variables directly in any config string value using（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`${VAR_NAME}` syntax. Variables are substituted at config load time, before validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "vercel-gateway": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${VERCEL_GATEWAY_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "${OPENCLAW_GATEWAY_TOKEN}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Rules:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only uppercase env var names are matched: `[A-Z_][A-Z0-9_]*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Missing or empty env vars throw an error at config load（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Escape with `$${VAR}` to output a literal `${VAR}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Works with `$include` (included files also get substitution)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Inline substitution:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      custom: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Auth storage (OAuth + API keys)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw stores **per-agent** auth profiles (OAuth + API keys) in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `<agentDir>/auth-profiles.json` (default: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See also: [/concepts/oauth](/concepts/oauth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy OAuth imports:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/credentials/oauth.json` (or `$OPENCLAW_STATE_DIR/credentials/oauth.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The embedded Pi agent maintains a runtime cache at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `<agentDir>/auth.json` (managed automatically; don’t edit manually)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy agent dir (pre multi-agent):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/agent/*` (migrated by `openclaw doctor` into `~/.openclaw/agents/<defaultAgentId>/agent/*`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Overrides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OAuth dir (legacy import only): `OPENCLAW_OAUTH_DIR`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent dir (default agent root override): `OPENCLAW_AGENT_DIR` (preferred), `PI_CODING_AGENT_DIR` (legacy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On first use, OpenClaw imports `oauth.json` entries into `auth-profiles.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `auth`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional metadata for auth profiles. This does **not** store secrets; it maps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
profile IDs to a provider + mode (and optional email) and defines the provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rotation order used for failover.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  auth: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profiles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "anthropic:work": { provider: "anthropic", mode: "api_key" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    order: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      anthropic: ["anthropic:me@example.com", "anthropic:work"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.list[].identity`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional per-agent identity used for defaults and UX. This is written by the macOS onboarding assistant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If set, OpenClaw derives defaults (only when you haven’t set them explicitly):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.ackReaction` from the **active agent**’s `identity.emoji` (falls back to 👀)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].groupChat.mentionPatterns` from the agent’s `identity.name`/`identity.emoji` (so “@Samantha” works in groups across Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `identity.avatar` accepts a workspace-relative image path or a remote URL/data URL. Local files must live inside the agent workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`identity.avatar` accepts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workspace-relative path (must stay within the agent workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `http(s)` URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `data:` URI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        identity: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          name: "Samantha",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          theme: "helpful sloth",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          emoji: "🦥",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          avatar: "avatars/samantha.png",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `wizard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Metadata written by CLI wizards (`onboard`, `configure`, `doctor`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  wizard: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    lastRunAt: "2026-01-01T00:00:00.000Z",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    lastRunVersion: "2026.1.4",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    lastRunCommit: "abc1234",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    lastRunCommand: "configure",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    lastRunMode: "local",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `logging`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default log file: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you want a stable path, set `logging.file` to `/tmp/openclaw/openclaw.log`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Console output can be tuned separately via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `logging.consoleLevel` (defaults to `info`, bumps to `debug` when `--verbose`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool summaries can be redacted to avoid leaking secrets:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `logging.redactSensitive` (`off` | `tools`, default: `tools`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `logging.redactPatterns` (array of regex strings; overrides defaults)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  logging: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    level: "info",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    file: "/tmp/openclaw/openclaw.log",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    consoleLevel: "info",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    consoleStyle: "pretty",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    redactSensitive: "tools",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    redactPatterns: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Example: override defaults with your own rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.whatsapp.dmPolicy`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls how WhatsApp direct chats (DMs) are handled:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"pairing"` (default): unknown senders get a pairing code; owner must approve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"allowlist"`: only allow senders in `channels.whatsapp.allowFrom` (or paired allow store)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"open"`: allow all inbound DMs (**requires** `channels.whatsapp.allowFrom` to include `"*"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"disabled"`: ignore all inbound DMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pairing codes expire after 1 hour; the bot only sends a pairing code when a new request is created. Pending DM pairing requests are capped at **3 per channel** by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pairing approvals:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw pairing list whatsapp`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw pairing approve whatsapp <code>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.whatsapp.allowFrom`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlist of E.164 phone numbers that may trigger WhatsApp auto-replies (**DMs only**).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If empty and `channels.whatsapp.dmPolicy="pairing"`, unknown senders will receive a pairing code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For groups, use `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing", // pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15555550123", "+447700900123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      textChunkLimit: 4000, // optional outbound chunk size (chars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      chunkMode: "length", // optional chunking mode (length | newline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 50, // optional inbound media cap (MB)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.whatsapp.sendReadReceipts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls whether inbound WhatsApp messages are marked as read (blue ticks). Default: `true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Self-chat mode always skips read receipts, even when enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-account override: `channels.whatsapp.accounts.<id>.sendReadReceipts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: { sendReadReceipts: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.whatsapp.accounts` (multi-account)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run multiple WhatsApp accounts in one gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {}, // optional; keeps the default id stable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        personal: {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        biz: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // authDir: "~/.openclaw/credentials/whatsapp/biz",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound commands default to account `default` if present; otherwise the first configured account id (sorted).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The legacy single-account Baileys auth dir is migrated by `openclaw doctor` into `whatsapp/default`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run multiple accounts per channel (each account has its own `accountId` and optional `name`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          name: "Primary bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          botToken: "123456:ABC...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        alerts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          name: "Alerts bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          botToken: "987654:XYZ...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `default` is used when `accountId` is omitted (CLI + routing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Env tokens only apply to the **default** account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base channel settings (group policy, mention gating, etc.) apply to all accounts unless overridden per account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `bindings[].match.accountId` to route each account to a different agents.defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Group chat mention gating (`agents.list[].groupChat` + `messages.groupChat`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group messages default to **require mention** (either metadata mention or regex patterns). Applies to WhatsApp, Telegram, Discord, Google Chat, and iMessage group chats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Mention types:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Metadata mentions**: Native platform @-mentions (e.g., WhatsApp tap-to-mention). Ignored in WhatsApp self-chat mode (see `channels.whatsapp.allowFrom`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Text patterns**: Regex patterns defined in `agents.list[].groupChat.mentionPatterns`. Always checked regardless of self-chat mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mention gating is enforced only when mention detection is possible (native mentions or at least one `mentionPattern`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    groupChat: { historyLimit: 50 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`messages.groupChat.historyLimit` sets the global default for group history context. Channels can override with `channels.<channel>.historyLimit` (or `channels.<channel>.accounts.*.historyLimit` for multi-account). Set `0` to disable history wrapping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### DM history limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DM conversations use session-based history managed by the agent. You can limit the number of user turns retained per DM session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmHistoryLimit: 30, // limit DM sessions to 30 user turns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dms: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123456789": { historyLimit: 50 }, // per-user override (user ID)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Resolution order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Per-DM override: `channels.<provider>.dms[userId].historyLimit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Provider default: `channels.<provider>.dmHistoryLimit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. No limit (all history retained)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supported providers: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent override (takes precedence when set, even `[]`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mention gating defaults live per channel (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). When `*.groups` is set, it also acts as a group allowlist; include `"*"` to allow all groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To respond **only** to specific text triggers (ignoring native @-mentions):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Include your own number to enable self-chat mode (ignore native @-mentions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15555550123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: { "*": { requireMention: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupChat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Only these text patterns will trigger responses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mentionPatterns: ["reisponde", "@openclaw"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Group policy (per channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `channels.*.groupPolicy` to control whether group/room messages are accepted at all:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15551234567"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["tg:123456789", "@alice"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    signal: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15551234567"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["chat_id:123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    msteams: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["user@org.com"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      guilds: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        GUILD_ID: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channels: { help: { allow: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channels: { "#general": { allow: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"open"`: groups bypass allowlists; mention-gating still applies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"disabled"`: block all group/room messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"allowlist"`: only allow groups/rooms that match the configured allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.defaults.groupPolicy` sets the default when a provider’s `groupPolicy` is unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams use `groupAllowFrom` (fallback: explicit `allowFrom`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord/Slack use channel allowlists (`channels.discord.guilds.*.channels`, `channels.slack.channels`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group DMs (Discord/Slack) are still controlled by `dm.groupEnabled` + `dm.groupChannels`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default is `groupPolicy: "allowlist"` (unless overridden by `channels.defaults.groupPolicy`); if no allowlist is configured, group messages are blocked.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-agent routing (`agents.list` + `bindings`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run multiple isolated agents (separate workspace, `agentDir`, sessions) inside one Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inbound messages are routed to an agent via bindings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[]`: per-agent overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `id`: stable agent id (required).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `default`: optional; when multiple are set, the first wins and a warning is logged.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    If none are set, the **first entry** in the list is the default agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `name`: display name for the agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `workspace`: default `~/.openclaw/workspace-<agentId>` (for `main`, falls back to `agents.defaults.workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `agentDir`: default `~/.openclaw/agents/<agentId>/agent`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `model`: per-agent default model, overrides `agents.defaults.model` for that agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - string form: `"provider/model"`, overrides only `agents.defaults.model.primary`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - object form: `{ primary, fallbacks }` (fallbacks override `agents.defaults.model.fallbacks`; `[]` disables global fallbacks for that agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `identity`: per-agent name/theme/emoji (used for mention patterns + ack reactions).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `groupChat`: per-agent mention-gating (`mentionPatterns`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `sandbox`: per-agent sandbox config (overrides `agents.defaults.sandbox`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `mode`: `"off"` | `"non-main"` | `"all"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `scope`: `"session"` | `"agent"` | `"shared"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `workspaceRoot`: custom sandbox workspace root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `docker`: per-agent docker overrides (e.g. `image`, `network`, `env`, `setupCommand`, limits; ignored when `scope: "shared"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `browser`: per-agent sandboxed browser overrides (ignored when `scope: "shared"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `prune`: per-agent sandbox pruning overrides (ignored when `scope: "shared"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `subagents`: per-agent sub-agent defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `allowAgents`: allowlist of agent ids for `sessions_spawn` from this agent (`["*"]` = allow any; default: only same agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `tools`: per-agent tool restrictions (applied before sandbox tool policy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `profile`: base tool profile (applied before allow/deny)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `allow`: array of allowed tool names（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `deny`: array of denied tool names (deny wins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults`: shared agent defaults (model, workspace, sandbox, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bindings[]`: routes inbound messages to an `agentId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `match.channel` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `match.accountId` (optional; `*` = any account; omitted = default account)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `match.peer` (optional; `{ kind: direct|group|channel, id }`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `match.guildId` / `match.teamId` (optional; channel-specific)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Deterministic match order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `match.peer`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `match.guildId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `match.teamId`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. `match.accountId` (exact, no peer/guild/team)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. `match.accountId: "*"` (channel-wide, no peer/guild/team)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. default agent (`agents.list[].default`, else first list entry, else `"main"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Within each match tier, the first matching entry in `bindings` wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Per-agent access profiles (multi-agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each agent can carry its own sandbox + tool policy. Use this to mix access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
levels in one gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Full access** (personal agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Read-only** tools + workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No filesystem access** (messaging/session tools only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
additional examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full access (no sandbox):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-personal",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sandbox: { mode: "off" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read-only tools + read-only workspace:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mode: "all",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          scope: "agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          workspaceAccess: "ro",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allow: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_spawn",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "session_status",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No filesystem access (messaging/session tools enabled):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "public",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspace: "~/.openclaw/workspace-public",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          mode: "all",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          scope: "agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          workspaceAccess: "none",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allow: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "sessions_spawn",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "session_status",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "whatsapp",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "slack",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "discord",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "gateway",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deny: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "edit",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "apply_patch",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "exec",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "process",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "browser",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "canvas",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "nodes",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "cron",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "gateway",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "image",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: two WhatsApp accounts → two agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "work", workspace: "~/.openclaw/workspace-work" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bindings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    whatsapp: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        personal: {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        biz: {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `tools.agentToAgent` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agent-to-agent messaging is opt-in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    agentToAgent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allow: ["home", "work"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `messages.queue`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls how inbound messages behave when an agent run is already active.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    queue: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      debounceMs: 1000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cap: 20,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      drop: "summarize", // old | new | summarize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      byChannel: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        whatsapp: "collect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        telegram: "collect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        discord: "collect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        imessage: "collect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        webchat: "collect",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `messages.inbound`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Debounce rapid inbound messages from the **same sender** so multiple back-to-back（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
messages become a single agent turn. Debouncing is scoped per channel + conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and uses the most recent message for reply threading/IDs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    inbound: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      debounceMs: 2000, // 0 disables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      byChannel: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        whatsapp: 5000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        slack: 1500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        discord: 1500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debounce batches **text-only** messages; media/attachments flush immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control commands (e.g. `/queue`, `/new`) bypass debouncing so they stay standalone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `commands` (chat command handling)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls how chat commands are enabled across connectors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  commands: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    native: "auto", // register native commands when supported (auto)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    text: true, // parse slash commands in chat messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: false, // allow ! (alias: /bash) (host-only; requires tools.elevated allowlists)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bashForegroundMs: 2000, // bash foreground window (0 backgrounds immediately)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    config: false, // allow /config (writes to disk)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    debug: false, // allow /debug (runtime-only overrides)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    restart: false, // allow /restart + gateway restart tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allowFrom: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "*": ["user1"], // optional per-provider command allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      discord: ["user:123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    useAccessGroups: true, // enforce access-group allowlists/policies for commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Text commands must be sent as a **standalone** message and use the leading `/` (no plain-text aliases).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.text: false` disables parsing chat messages for commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.native: "auto"` (default) turns on native commands for Discord/Telegram and leaves Slack off; unsupported channels stay text-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `commands.native: true|false` to force all, or override per channel with `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool or `"auto"`). `false` clears previously registered commands on Discord/Telegram at startup; Slack commands are managed in the Slack app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.telegram.customCommands` adds extra Telegram bot menu entries. Names are normalized; conflicts with native commands are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.bash: true` enables `! <cmd>` to run host shell commands (`/bash <cmd>` also works as an alias). Requires `tools.elevated.enabled` and allowlisting the sender in `tools.elevated.allowFrom.<channel>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.bashForegroundMs` controls how long bash waits before backgrounding. While a bash job is running, new `! <cmd>` requests are rejected (one at a time).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.config: true` enables `/config` (reads/writes `openclaw.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.<provider>.configWrites` gates config mutations initiated by that channel (default: true). This applies to `/config set|unset` plus provider-specific auto-migrations (Telegram supergroup ID changes, Slack channel ID changes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.debug: true` enables `/debug` (runtime-only overrides).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.restart: true` enables `/restart` and the gateway tool restart action.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.allowFrom` sets a per-provider allowlist for command execution. When configured, it is the **only**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  authorization source for commands and directives (channel allowlists/pairing and `commands.useAccessGroups` are ignored).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Use `"*"` for a global default; provider-specific keys (for example `discord`) override it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `commands.useAccessGroups: false` allows commands to bypass access-group allowlists/policies when `commands.allowFrom`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  is not set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slash commands and directives are only honored for **authorized senders**. If `commands.allowFrom` is set,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  authorization comes solely from that list; otherwise it is derived from channel allowlists/pairing plus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `commands.useAccessGroups`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `web` (WhatsApp web channel runtime)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WhatsApp runs through the gateway’s web channel (Baileys Web). It starts automatically when a linked session exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `web.enabled: false` to keep it off by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  web: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeatSeconds: 60,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reconnect: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      initialMs: 2000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxMs: 120000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      factor: 1.4,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      jitter: 0.2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxAttempts: 0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.telegram` (bot transport)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw starts Telegram only when a `channels.telegram` config section exists. The bot token is resolved from `channels.telegram.botToken` (or `channels.telegram.tokenFile`), with `TELEGRAM_BOT_TOKEN` as a fallback for the default account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `channels.telegram.enabled: false` to disable automatic startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support lives under `channels.telegram.accounts` (see the multi-account section above). Env tokens only apply to the default account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `channels.telegram.configWrites: false` to block Telegram-initiated config writes (including supergroup ID migrations and `/config set|unset`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "your-bot-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing", // pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["tg:123456789"], // optional; "open" requires ["*"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "-1001234567890": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowFrom: ["@admin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPrompt: "Keep answers brief.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          topics: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "99": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              requireMention: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              skills: ["search"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              systemPrompt: "Stay on topic.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      customCommands: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { command: "backup", description: "Git backup" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        { command: "generate", description: "Create an image" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      historyLimit: 50, // include last N group messages as context (0 disables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "first", // off | first | all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      linkPreview: true, // toggle outbound link previews（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      streamMode: "partial", // off | partial | block (draft streaming; separate from block streaming)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      draftChunk: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // optional; only for streamMode=block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minChars: 200,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxChars: 800,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        breakPreference: "paragraph", // paragraph | newline | sentence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      reactionNotifications: "own", // off | own | all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      retry: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // outbound retry policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        attempts: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minDelayMs: 400,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxDelayMs: 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        jitter: 0.1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      network: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // transport overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        autoSelectFamily: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      proxy: "socks5://localhost:9050",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      webhookUrl: "https://example.com/telegram-webhook", // requires webhookSecret（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      webhookSecret: "secret",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      webhookPath: "/telegram-webhook",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Draft streaming notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses Telegram `sendMessageDraft` (draft bubble, not a real message).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires **private chat topics** (message_thread_id in DMs; bot has topics enabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/reasoning stream` streams reasoning into the draft, then sends the final answer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Retry policy defaults and behavior are documented in [Retry policy](/concepts/retry).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.discord` (bot transport)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure the Discord bot by setting the bot token and optional gating:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support lives under `channels.discord.accounts` (see the multi-account section above). Env tokens only apply to the default account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "your-bot-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 8, // clamp inbound media size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowBots: false, // allow bot-authored messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // tool action gates (false disables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        reactions: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        stickers: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        polls: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        permissions: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        messages: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        threads: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pins: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        search: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        memberInfo: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        roleInfo: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        roles: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channelInfo: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voiceStatus: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        events: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        moderation: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "off", // off | first | all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true, // disable all DMs when false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        policy: "pairing", // pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupEnabled: false, // enable group DMs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupChannels: ["openclaw-dm"], // optional group DM allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      guilds: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "123456789012345678": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // guild id (preferred) or slug（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          slug: "friends-of-openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          requireMention: false, // per-guild default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          reactionNotifications: "own", // off | own | all | allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          users: ["987654321098765432"], // optional per-guild user allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            general: { allow: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            help: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              allow: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              requireMention: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              users: ["987654321098765432"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              skills: ["docs"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              systemPrompt: "Short answers only.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      historyLimit: 20, // include last N guild messages as context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      textChunkLimit: 2000, // optional outbound text chunk size (chars)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      chunkMode: "length", // optional chunking mode (length | newline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxLinesPerMessage: 17, // soft max lines per message (Discord UI clipping)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      retry: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // outbound retry policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        attempts: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minDelayMs: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxDelayMs: 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        jitter: 0.1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw starts Discord only when a `channels.discord` config section exists. The token is resolved from `channels.discord.token`, with `DISCORD_BOT_TOKEN` as a fallback for the default account (unless `channels.discord.enabled` is `false`). Use `user:<id>` (DM) or `channel:<id>` (guild channel) when specifying delivery targets for cron/CLI commands; bare numeric IDs are ambiguous and rejected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Guild slugs are lowercase with spaces replaced by `-`; channel keys use the slugged channel name (no leading `#`). Prefer guild ids as keys to avoid rename ambiguity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bot-authored messages are ignored by default. Enable with `channels.discord.allowBots` (own messages are still filtered to prevent self-reply loops).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reaction notification modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: no reaction events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `own`: reactions on the bot's own messages (default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `all`: all reactions on all messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist`: reactions from `guilds.<id>.users` on all messages (empty list disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Outbound text is chunked by `channels.discord.textChunkLimit` (default 2000). Set `channels.discord.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking. Discord clients can clip very tall messages, so `channels.discord.maxLinesPerMessage` (default 17) splits long multi-line replies even when under 2000 chars.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Retry policy defaults and behavior are documented in [Retry policy](/concepts/retry).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.googlechat` (Chat API webhook)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Google Chat runs over HTTP webhooks with app-level auth (service account).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support lives under `channels.googlechat.accounts` (see the multi-account section above). Env vars only apply to the default account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    googlechat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      serviceAccountFile: "/path/to/service-account.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audienceType: "app-url", // app-url | project-number（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audience: "https://gateway.example.com/googlechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      webhookPath: "/googlechat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botUser: "users/1234567890", // optional; improves mention detection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        policy: "pairing", // pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowFrom: ["users/1234567890"], // optional; "open" requires ["*"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "spaces/AAAA": { allow: true, requireMention: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: { reactions: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      typingIndicator: "message",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 20,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Service account JSON can be inline (`serviceAccount`) or file-based (`serviceAccountFile`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Env fallbacks for the default account: `GOOGLE_CHAT_SERVICE_ACCOUNT` or `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `audienceType` + `audience` must match the Chat app’s webhook auth config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `spaces/<spaceId>` or `users/<userId|email>` when setting delivery targets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.slack` (socket mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Slack runs in Socket Mode and requires both a bot token and app token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    slack: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "xoxb-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      appToken: "xapp-...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dm: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        policy: "pairing", // pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupEnabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupChannels: ["G123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        C123: { allow: true, requireMention: true, allowBots: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "#general": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allow: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          requireMention: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowBots: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          users: ["U123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          skills: ["docs"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPrompt: "Short answers only.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      historyLimit: 50, // include last N channel/group messages as context (0 disables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowBots: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      reactionNotifications: "own", // off | own | all | allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      reactionAllowlist: ["U123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      replyToMode: "off", // off | first | all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      thread: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        historyScope: "thread", // thread | channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        inheritParent: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        reactions: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        messages: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        pins: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        memberInfo: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        emojiList: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      slashCommand: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sessionPrefix: "slack:slash",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ephemeral: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      textChunkLimit: 4000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      chunkMode: "length",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 20,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support lives under `channels.slack.accounts` (see the multi-account section above). Env tokens only apply to the default account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw starts Slack when the provider is enabled and both tokens are set (via config or `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Use `user:<id>` (DM) or `channel:<id>` when specifying delivery targets for cron/CLI commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `channels.slack.configWrites: false` to block Slack-initiated config writes (including channel ID migrations and `/config set|unset`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bot-authored messages are ignored by default. Enable with `channels.slack.allowBots` or `channels.slack.channels.<id>.allowBots`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reaction notification modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: no reaction events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `own`: reactions on the bot's own messages (default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `all`: all reactions on all messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist`: reactions from `channels.slack.reactionAllowlist` on all messages (empty list disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Thread session isolation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.slack.thread.historyScope` controls whether thread history is per-thread (`thread`, default) or shared across the channel (`channel`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.slack.thread.inheritParent` controls whether new thread sessions inherit the parent channel transcript (default: false).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Slack action groups (gate `slack` tool actions):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Action group | Default | Notes                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| reactions    | enabled | React + list reactions |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| messages     | enabled | Read/send/edit/delete  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| pins         | enabled | Pin/unpin/list         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| memberInfo   | enabled | Member info            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| emojiList    | enabled | Custom emoji list      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.mattermost` (bot token)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mattermost ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install it first: `openclaw plugins install @openclaw/mattermost` (or `./extensions/mattermost` from a git checkout).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mattermost requires a bot token plus the base URL for your server:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mattermost: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      botToken: "mm-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      baseUrl: "https://chat.example.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      chatmode: "oncall", // oncall | onmessage | onchar（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      oncharPrefixes: [">", "!"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      textChunkLimit: 4000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      chunkMode: "length",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw starts Mattermost when the account is configured (bot token + base URL) and enabled. The token + base URL are resolved from `channels.mattermost.botToken` + `channels.mattermost.baseUrl` or `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` for the default account (unless `channels.mattermost.enabled` is `false`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Chat modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `oncall` (default): respond to channel messages only when @mentioned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `onmessage`: respond to every channel message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `onchar`: respond when a message starts with a trigger prefix (`channels.mattermost.oncharPrefixes`, default `[">", "!"]`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Access control:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default DMs: `channels.mattermost.dmPolicy="pairing"` (unknown senders get a pairing code).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Public DMs: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groups: `channels.mattermost.groupPolicy="allowlist"` by default (mention-gated). Use `channels.mattermost.groupAllowFrom` to restrict senders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support lives under `channels.mattermost.accounts` (see the multi-account section above). Env vars only apply to the default account.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `channel:<id>` or `user:<id>` (or `@username`) when specifying delivery targets; bare ids are treated as channel ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.signal` (signal-cli)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Signal reactions can emit system events (shared reaction tooling):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    signal: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      reactionNotifications: "own", // off | own | all | allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      historyLimit: 50, // include last N group messages as context (0 disables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reaction notification modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: no reaction events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `own`: reactions on the bot's own messages (default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `all`: all reactions on all messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist`: reactions from `channels.signal.reactionAllowlist` on all messages (empty list disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels.imessage` (imsg CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw spawns `imsg rpc` (JSON-RPC over stdio). No daemon or port required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    imessage: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliPath: "imsg",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dbPath: "~/Library/Messages/chat.db",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remoteHost: "user@gateway-host", // SCP for remote attachments when using SSH wrapper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dmPolicy: "pairing", // pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      historyLimit: 50, // include last N group messages as context (0 disables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      includeAttachments: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 16,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      service: "auto",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      region: "US",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account support lives under `channels.imessage.accounts` (see the multi-account section above).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires Full Disk Access to the Messages DB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The first send will prompt for Messages automation permission.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer `chat_id:<id>` targets. Use `imsg chats --limit 20` to list chats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.imessage.cliPath` can point to a wrapper script (e.g. `ssh` to another Mac that runs `imsg rpc`); use SSH keys to avoid password prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For remote SSH wrappers, set `channels.imessage.remoteHost` to fetch attachments via SCP when `includeAttachments` is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example wrapper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#!/usr/bin/env bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
exec ssh -T gateway-host imsg "$@"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults.workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sets the **single global workspace directory** used by the agent for file operations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default: `~/.openclaw/workspace`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `agents.defaults.sandbox` is enabled, non-main sessions can override this with their（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
own per-scope workspaces under `agents.defaults.sandbox.workspaceRoot`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults.repoRoot`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional repository root to show in the system prompt’s Runtime line. If unset, OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tries to detect a `.git` directory by walking upward from the workspace (and current（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
working directory). The path must exist to be used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults.skipBootstrap`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disables automatic creation of the workspace bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this for pre-seeded deployments where your workspace files come from a repo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { skipBootstrap: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults.bootstrapMaxChars`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Max characters of each workspace bootstrap file injected into the system prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
before truncation. Default: `20000`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a file exceeds this limit, OpenClaw logs a warning and injects a truncated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
head/tail with a marker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { bootstrapMaxChars: 20000 } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults.userTimezone`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Sets the user’s timezone for **system prompt context** (not for timestamps in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message envelopes). If unset, OpenClaw uses the host timezone at runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { userTimezone: "America/Chicago" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults.timeFormat`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls the **time format** shown in the system prompt’s Current Date & Time section.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default: `auto` (OS preference).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `messages`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls inbound/outbound prefixes and optional ack reactions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Messages](/concepts/messages) for queueing, sessions, and streaming context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    responsePrefix: "🦞", // or "auto"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ackReaction: "👀",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ackReactionScope: "group-mentions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    removeAckAfterReply: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`responsePrefix` is applied to **all outbound replies** (tool summaries, block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
streaming, final replies) across channels unless already present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Overrides can be configured per channel and per account:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.<channel>.responsePrefix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.<channel>.accounts.<id>.responsePrefix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Resolution order (most specific wins):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `channels.<channel>.accounts.<id>.responsePrefix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. `channels.<channel>.responsePrefix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. `messages.responsePrefix`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Semantics:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `undefined` falls through to the next level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `""` explicitly disables the prefix and stops the cascade.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"auto"` derives `[{identity.name}]` for the routed agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Overrides apply to all channels, including extensions, and to every outbound reply kind.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `messages.responsePrefix` is unset, no prefix is applied by default. WhatsApp self-chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
replies are the exception: they default to `[{identity.name}]` when set, otherwise（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`[openclaw]`, so same-phone conversations stay legible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set it to `"auto"` to derive `[{identity.name}]` for the routed agent (when set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Template variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `responsePrefix` string can include template variables that resolve dynamically:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable          | Description            | Example                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ---------------------- | --------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{model}`         | Short model name       | `claude-opus-4-6`, `gpt-4o` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{modelFull}`     | Full model identifier  | `anthropic/claude-opus-4-6` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{provider}`      | Provider name          | `anthropic`, `openai`       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{thinkingLevel}` | Current thinking level | `high`, `low`, `off`        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{identity.name}` | Agent identity name    | (same as `"auto"` mode)     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Variables are case-insensitive (`{MODEL}` = `{model}`). `{think}` is an alias for `{thinkingLevel}`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unresolved variables remain as literal text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    responsePrefix: "[{model} | think:{thinkingLevel}]",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example output: `[claude-opus-4-6 | think:high] Here's my response...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WhatsApp inbound prefix is configured via `channels.whatsapp.messagePrefix` (deprecated:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`messages.messagePrefix`). Default stays **unchanged**: `"[openclaw]"` when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels.whatsapp.allowFrom` is empty, otherwise `""` (no prefix). When using（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`"[openclaw]"`, OpenClaw will instead use `[{identity.name}]` when the routed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent has `identity.name` set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`ackReaction` sends a best-effort emoji reaction to acknowledge inbound messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on channels that support reactions (Slack/Discord/Telegram/Google Chat). Defaults to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
active agent’s `identity.emoji` when set, otherwise `"👀"`. Set it to `""` to disable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`ackReactionScope` controls when reactions fire:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group-mentions` (default): only when a group/room requires mentions **and** the bot was mentioned（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group-all`: all group/room messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `direct`: direct messages only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `all`: all messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`removeAckAfterReply` removes the bot’s ack reaction after a reply is sent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(Slack/Discord/Telegram/Google Chat only). Default: `false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `messages.tts`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable text-to-speech for outbound replies. When on, OpenClaw generates audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
using ElevenLabs or OpenAI and attaches it to responses. Telegram uses Opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
voice notes; other channels send MP3 audio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  messages: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      auto: "always", // off | always | inbound | tagged（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "final", // final | all (include tool/block replies)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      provider: "elevenlabs",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      summaryModel: "openai/gpt-4.1-mini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      modelOverrides: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxTextLength: 4000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      timeoutMs: 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      prefsPath: "~/.openclaw/settings/tts.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      elevenlabs: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "elevenlabs_api_key",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.elevenlabs.io",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voiceId: "voice_id",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        modelId: "eleven_multilingual_v2",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        seed: 42,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        applyTextNormalization: "auto",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        languageCode: "en",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voiceSettings: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          stability: 0.5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          similarityBoost: 0.75,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          style: 0.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          useSpeakerBoost: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          speed: 1.0,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      openai: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "openai_api_key",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "gpt-4o-mini-tts",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        voice: "alloy",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.tts.auto` controls auto‑TTS (`off`, `always`, `inbound`, `tagged`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/tts off|always|inbound|tagged` sets the per‑session auto mode (overrides config).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.tts.enabled` is legacy; doctor migrates it to `messages.tts.auto`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prefsPath` stores local overrides (provider/limit/summarize).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxTextLength` is a hard cap for TTS input; summaries are truncated to fit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `summaryModel` overrides `agents.defaults.model.primary` for auto-summary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Accepts `provider/model` or an alias from `agents.defaults.models`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `modelOverrides` enables model-driven overrides like `[[tts:...]]` tags (on by default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/tts limit` and `/tts summary` control per-user summarization settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apiKey` values fall back to `ELEVENLABS_API_KEY`/`XI_API_KEY` and `OPENAI_API_KEY`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevenlabs.baseUrl` overrides the ElevenLabs API base URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `elevenlabs.voiceSettings` supports `stability`/`similarityBoost`/`style` (0..1),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `useSpeakerBoost`, and `speed` (0.5..2.0).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `talk`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults for Talk mode (macOS/iOS/Android). Voice IDs fall back to `ELEVENLABS_VOICE_ID` or `SAG_VOICE_ID` when unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`apiKey` falls back to `ELEVENLABS_API_KEY` (or the gateway’s shell profile) when unset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`voiceAliases` lets Talk directives use friendly names (e.g. `"voice":"Clawd"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  talk: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    voiceId: "elevenlabs_voice_id",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    voiceAliases: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      Clawd: "EXAVITQu4vr4xnSDxMaL",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      Roger: "CwhRBWXzGAHq8TQ4Fs17",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    modelId: "eleven_v3",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    outputFormat: "mp3_44100_128",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    apiKey: "elevenlabs_api_key",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    interruptOnSpeech: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls the embedded agent runtime (model/thinking/verbose/timeouts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.models` defines the configured model catalog (and acts as the allowlist for `/model`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.model.primary` sets the default model; `agents.defaults.model.fallbacks` are global failovers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.imageModel` is optional and is **only used if the primary model lacks image input**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each `agents.defaults.models` entry can include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `alias` (optional model shortcut, e.g. `/opus`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `params` (optional provider-specific API params passed through to the model request).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`params` is also applied to streaming runs (embedded agent + compaction). Supported keys today: `temperature`, `maxTokens`. These merge with call-time options; caller-supplied values win. `temperature` is an advanced knob—leave unset unless you know the model’s defaults and need a change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-sonnet-4-5-20250929": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          params: { temperature: 0.6 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "openai/gpt-5.2": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          params: { maxTokens: 8192 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Z.AI GLM-4.x models automatically enable thinking mode unless you:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- set `--thinking off`, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- define `agents.defaults.models["zai/<model>"].params.thinking` yourself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw also ships a few built-in alias shorthands. Defaults only apply when the model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is already present in `agents.defaults.models`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `opus` -> `anthropic/claude-opus-4-6`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sonnet` -> `anthropic/claude-sonnet-4-5`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gpt` -> `openai/gpt-5.2`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gpt-mini` -> `openai/gpt-5-mini`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gemini` -> `google/gemini-3-pro-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gemini-flash` -> `google/gemini-3-flash-preview`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you configure the same alias name (case-insensitive) yourself, your value wins (defaults never override).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: Opus 4.6 primary with MiniMax M2.1 fallback (hosted MiniMax):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-opus-4-6": { alias: "opus" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "minimax/MiniMax-M2.1": { alias: "minimax" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        primary: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        fallbacks: ["minimax/MiniMax-M2.1"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
MiniMax auth: set `MINIMAX_API_KEY` (env) or configure `models.providers.minimax`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents.defaults.cliBackends` (CLI fallback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional CLI backends for text-only fallback runs (no tool calls). These are useful as a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backup path when API providers fail. Image pass-through is supported when you configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
an `imageArg` that accepts file paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI backends are **text-first**; tools are always disabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions are supported when `sessionArg` is set; session ids are persisted per backend.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For `claude-cli`, defaults are wired in. Override the command path if PATH is minimal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (launchd/systemd).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliBackends: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "claude-cli": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          command: "/opt/homebrew/bin/claude",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "my-cli": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          command: "my-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          args: ["--json"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          output: "json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          modelArg: "--model",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          sessionArg: "--session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          sessionMode: "existing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPromptArg: "--system",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPromptWhen: "first",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          imageArg: "--image",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          imageMode: "repeat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-opus-4-6": { alias: "Opus" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "openrouter/deepseek/deepseek-r1:free": {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "zai/glm-4.7": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          alias: "GLM",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          params: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            thinking: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              type: "enabled",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              clear_thinking: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        primary: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        fallbacks: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "openrouter/deepseek/deepseek-r1:free",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "openrouter/meta-llama/llama-3.3-70b-instruct:free",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      imageModel: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      thinkingDefault: "low",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      verboseDefault: "off",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      elevatedDefault: "on",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      timeoutSeconds: 600,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mediaMaxMb: 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        every: "30m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        target: "last",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxConcurrent: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      subagents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "minimax/MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxConcurrent: 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        archiveAfterMinutes: 60,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      exec: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        backgroundMs: 10000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        timeoutSec: 1800,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cleanupMs: 1800000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      contextTokens: 200000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents.defaults.contextPruning` (tool-result pruning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.contextPruning` prunes **old tool results** from the in-memory context right before a request is sent to the LLM.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It does **not** modify the session history on disk (`*.jsonl` remains complete).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is intended to reduce token usage for chatty agents that accumulate large tool outputs over time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
High level:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never touches user/assistant messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Protects the last `keepLastAssistants` assistant messages (no tool results after that point are pruned).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Protects the bootstrap prefix (nothing before the first user message is pruned).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `adaptive`: soft-trims oversized tool results (keep head/tail) when the estimated context ratio crosses `softTrimRatio`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Then hard-clears the oldest eligible tool results when the estimated context ratio crosses `hardClearRatio` **and**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    there’s enough prunable tool-result bulk (`minPrunableToolChars`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `aggressive`: always replaces eligible tool results before the cutoff with the `hardClear.placeholder` (no ratio checks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Soft vs hard pruning (what changes in the context sent to the LLM):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Soft-trim**: only for _oversized_ tool results. Keeps the beginning + end and inserts `...` in the middle.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Before: `toolResult("…very long output…")`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - After: `toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hard-clear**: replaces the entire tool result with the placeholder.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Before: `toolResult("…very long output…")`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - After: `toolResult("[Old tool result content cleared]")`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes / current limitations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool results containing **image blocks are skipped** (never trimmed/cleared) right now.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The estimated “context ratio” is based on **characters** (approximate), not exact tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the session doesn’t contain at least `keepLastAssistants` assistant messages yet, pruning is skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In `aggressive` mode, `hardClear.enabled` is ignored (eligible tool results are always replaced with `hardClear.placeholder`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default (adaptive):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { contextPruning: { mode: "adaptive" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To disable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { contextPruning: { mode: "off" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults (when `mode` is `"adaptive"` or `"aggressive"`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `keepLastAssistants`: `3`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `softTrimRatio`: `0.3` (adaptive only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hardClearRatio`: `0.5` (adaptive only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minPrunableToolChars`: `50000` (adaptive only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (adaptive only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (aggressive, minimal):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: { defaults: { contextPruning: { mode: "aggressive" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (adaptive tuned):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      contextPruning: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        mode: "adaptive",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        keepLastAssistants: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        softTrimRatio: 0.3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        hardClearRatio: 0.5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minPrunableToolChars: 50000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // Optional: restrict pruning to specific tools (deny wins; supports "*" wildcards)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: { deny: ["browser", "canvas"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/concepts/session-pruning](/concepts/session-pruning) for behavior details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents.defaults.compaction` (reserve headroom + memory flush)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.compaction.mode` selects the compaction summarization strategy. Defaults to `default`; set `safeguard` to enable chunked summarization for very long histories. See [/concepts/compaction](/concepts/compaction).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.compaction.reserveTokensFloor` enforces a minimum `reserveTokens`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
value for Pi compaction (default: `20000`). Set it to `0` to disable the floor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.compaction.memoryFlush` runs a **silent** agentic turn before（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
auto-compaction, instructing the model to store durable memories on disk (e.g.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`memory/YYYY-MM-DD.md`). It triggers when the session token estimate crosses a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
soft threshold below the compaction limit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memoryFlush.enabled`: `true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memoryFlush.softThresholdTokens`: `4000`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: built-in defaults with `NO_REPLY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Note: memory flush is skipped when the session workspace is read-only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (`agents.defaults.sandbox.workspaceAccess: "ro"` or `"none"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (tuned):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      compaction: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        mode: "safeguard",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        reserveTokensFloor: 24000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        memoryFlush: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          softThresholdTokens: 6000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPrompt: "Session nearing compaction. Store durable memories now.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Block streaming:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (default off).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel overrides: `*.blockStreaming` (and per-account variants) to force block streaming on/off.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Non-Telegram channels require an explicit `*.blockStreaming: true` to enable block replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingBreak`: `"text_end"` or `"message_end"` (default: text_end).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingChunk`: soft chunking for streamed blocks. Defaults to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  800–1200 chars, prefers paragraph breaks (`\n\n`), then newlines, then sentences.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.blockStreamingCoalesce`: merge streamed blocks before sending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Defaults to `{ idleMs: 1000 }` and inherits `minChars` from `blockStreamingChunk`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  with `maxChars` capped to the channel text limit. Signal/Slack/Discord/Google Chat default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  to `minChars: 1500` unless overridden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Channel overrides: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `channels.googlechat.blockStreamingCoalesce`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (and per-account variants).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.humanDelay`: randomized pause between **block replies** after the first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Modes: `off` (default), `natural` (800–2500ms), `custom` (use `minMs`/`maxMs`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Per-agent override: `agents.list[].humanDelay`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    agents: { defaults: { humanDelay: { mode: "natural" } } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  See [/concepts/streaming](/concepts/streaming) for behavior + chunking details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Typing indicators:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.typingMode`: `"never" | "instant" | "thinking" | "message"`. Defaults to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `instant` for direct chats / mentions and `message` for unmentioned group chats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session.typingMode`: per-session override for the mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.typingIntervalSeconds`: how often the typing signal is refreshed (default: 6s).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session.typingIntervalSeconds`: per-session override for the refresh interval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  See [/concepts/typing-indicators](/concepts/typing-indicators) for behavior details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.model.primary` should be set as `provider/model` (e.g. `anthropic/claude-opus-4-6`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Aliases come from `agents.defaults.models.*.alias` (e.g. `Opus`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you omit the provider, OpenClaw currently assumes `anthropic` as a temporary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
deprecation fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Z.AI models are available as `zai/<model>` (e.g. `zai/glm-4.7`) and require（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`ZAI_API_KEY` (or legacy `Z_AI_API_KEY`) in the environment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.heartbeat` configures periodic heartbeat runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `every`: duration string (`ms`, `s`, `m`, `h`); default unit minutes. Default:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `30m`. Set `0m` to disable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model`: optional override model for heartbeat runs (`provider/model`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `includeReasoning`: when `true`, heartbeats will also deliver the separate `Reasoning:` message when available (same shape as `/reasoning on`). Default: `false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session`: optional session key to control which session the heartbeat runs in. Default: `main`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp, chat id for Telegram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `target`: optional delivery channel (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). Default: `last`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prompt`: optional override for the heartbeat body (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Overrides are sent verbatim; include a `Read HEARTBEAT.md` line if you still want the file read.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery (default: 300).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent heartbeats:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `agents.list[].heartbeat` to enable or override heartbeat settings for a specific agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If any agent entry defines `heartbeat`, **only those agents** run heartbeats; defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  become the shared baseline for those agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeats run full agent turns. Shorter intervals burn more tokens; be mindful（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
of `every`, keep `HEARTBEAT.md` tiny, and/or choose a cheaper `model`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.exec` configures background exec defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `backgroundMs`: time before auto-background (ms, default 10000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutSec`: auto-kill after this runtime (seconds, default 1800)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cleanupMs`: how long to keep finished sessions in memory (ms, default 1800000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `notifyOnExit`: enqueue a system event + request heartbeat when backgrounded exec exits (default true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `applyPatch.enabled`: enable experimental `apply_patch` (OpenAI/OpenAI Codex only; default false)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `applyPatch.allowModels`: optional allowlist of model ids (e.g. `gpt-5.2` or `openai/gpt-5.2`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Note: `applyPatch` is only under `tools.exec`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.web` configures web search + fetch tools:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.search.enabled` (default: true when key is present)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.search.apiKey` (recommended: set via `openclaw configure --section web`, or use `BRAVE_API_KEY` env var)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.search.maxResults` (1–10, default 5)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.search.timeoutSeconds` (default 30)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.search.cacheTtlMinutes` (default 15)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.enabled` (default true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.maxChars` (default 50000)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.maxCharsCap` (default 50000; clamps maxChars from config/tool calls)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.timeoutSeconds` (default 30)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.cacheTtlMinutes` (default 15)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.userAgent` (optional override)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.readability` (default true; disable to use basic HTML cleanup only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.firecrawl.enabled` (default true when an API key is set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.firecrawl.apiKey` (optional; defaults to `FIRECRAWL_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.firecrawl.baseUrl` (default [https://api.firecrawl.dev](https://api.firecrawl.dev))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.firecrawl.onlyMainContent` (default true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.firecrawl.maxAgeMs` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.web.fetch.firecrawl.timeoutSeconds` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.media` configures inbound media understanding (image/audio/video):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.models`: shared model list (capability-tagged; used after per-cap lists).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.concurrency`: max concurrent capability runs (default 2).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `enabled`: opt-out switch (default true when models are configured).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `prompt`: optional prompt override (image/video append a `maxChars` hint automatically).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `maxChars`: max output characters (default 500 for image/video; unset for audio).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `maxBytes`: max media size to send (defaults: image 10MB, audio 20MB, video 50MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `timeoutSeconds`: request timeout (defaults: image 60s, audio 60s, video 120s).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `language`: optional audio hint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `attachments`: attachment policy (`mode`, `maxAttachments`, `prefer`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `scope`: optional gating (first match wins) with `match.channel`, `match.chatType`, or `match.keyPrefix`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `models`: ordered list of model entries; failures or oversize media fall back to the next entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each `models[]` entry:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Provider entry (`type: "provider"` or omitted):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `model`: model id override (required for image; defaults to `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo` for audio providers, and `gemini-3-flash-preview` for video).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `profile` / `preferredProfile`: auth profile selection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - CLI entry (`type: "cli"`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `command`: executable to run.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `args`: templated args (supports `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `capabilities`: optional list (`image`, `audio`, `video`) to gate a shared entry. Defaults when omitted: `openai`/`anthropic`/`minimax` → image, `google` → image+audio+video, `groq` → audio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` can be overridden per entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If no models are configured (or `enabled: false`), understanding is skipped; the model still receives the original attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider auth follows the standard model auth order (auth profiles, env vars like `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, or `models.providers.*.apiKey`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxBytes: 20971520,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        scope: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          default: "deny",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          rules: [{ action: "allow", match: { chatType: "direct" } }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { provider: "openai", model: "gpt-4o-mini-transcribe" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      video: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxBytes: 52428800,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.subagents` configures sub-agent defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model`: default model for spawned sub-agents (string or `{ primary, fallbacks }`). If omitted, sub-agents inherit the caller’s model unless overridden per agent or per call.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxConcurrent`: max concurrent sub-agent runs (default 1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `archiveAfterMinutes`: auto-archive sub-agent sessions after N minutes (default 60; set `0` to disable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (deny wins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minimal`: `session_status` only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `full`: no restriction (same as unset)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent override: `agents.list[].tools.profile`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (messaging-only by default, allow Slack + Discord tools too):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profile: "messaging",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allow: ["slack", "discord"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (coding profile, but deny exec/process everywhere):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profile: "coding",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    deny: ["group:runtime"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.byProvider` lets you **further restrict** tools for specific providers (or a single `provider/model`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent override: `agents.list[].tools.byProvider`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Order: base profile → provider profile → allow/deny policies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider keys accept either `provider` (e.g. `google-antigravity`) or `provider/model`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(e.g. `openai/gpt-5.2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (keep global coding profile, but minimal tools for Google Antigravity):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profile: "coding",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    byProvider: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "google-antigravity": { profile: "minimal" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (provider/model-specific allowlist):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allow: ["group:fs", "group:runtime", "sessions_list"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    byProvider: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.allow` / `tools.deny` configure a global tool allow/deny policy (deny wins).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Matching is case-insensitive and supports `*` wildcards (`"*"` means all tools).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is applied even when the Docker sandbox is **off**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (disable browser/canvas everywhere):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: { deny: ["browser", "canvas"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool groups (shorthands) work in **global** and **per-agent** tool policies:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:runtime`: `exec`, `bash`, `process`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:fs`: `read`, `write`, `edit`, `apply_patch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:memory`: `memory_search`, `memory_get`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:web`: `web_search`, `web_fetch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:ui`: `browser`, `canvas`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:automation`: `cron`, `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:messaging`: `message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:nodes`: `nodes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `group:openclaw`: all built-in OpenClaw tools (excludes provider plugins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`tools.elevated` controls elevated (host) exec access:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`: allow elevated mode (default true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowFrom`: per-channel allowlists (empty = disabled)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `whatsapp`: E.164 numbers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `telegram`: chat ids or usernames（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `discord`: user ids or usernames (falls back to `channels.discord.dm.allowFrom` if omitted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `signal`: E.164 numbers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `imessage`: handles/chat ids（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `webchat`: session ids or usernames（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    elevated: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        whatsapp: ["+15555550123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        discord: ["steipete", "1234567890123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent override (further restrict):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "family",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          elevated: { enabled: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can only further restrict (both must allow).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/elevated on|off|ask|full` stores state per session key; inline directives apply to a single message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Elevated `exec` runs on the host and bypasses sandboxing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool policy still applies; if `exec` is denied, elevated cannot be used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.maxConcurrent` sets the maximum number of embedded agent runs that can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
execute in parallel across sessions. Each session is still serialized (one run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
per session key at a time). Default: 1.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents.defaults.sandbox`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional **Docker sandboxing** for the embedded agent. Intended for non-main（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sessions so they cannot access your host system.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Sandboxing](/gateway/sandboxing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults (if enabled):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- scope: `"agent"` (one container + workspace per agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Debian bookworm-slim based image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- agent workspace access: `workspaceAccess: "none"` (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"none"`: use a per-scope sandbox workspace under `~/.openclaw/sandboxes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `"ro"`: keep the sandbox workspace at `/workspace`, and mount the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"rw"`: mount the agent workspace read/write at `/workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- auto-prune: idle > 24h OR age > 7d（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- tool policy: allow only `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (deny wins)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - configure via `tools.sandbox.tools`, override per-agent via `agents.list[].tools.sandbox.tools`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - tool group shorthands supported in sandbox policy: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- optional sandboxed browser (Chromium + CDP, noVNC observer)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- hardening knobs: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Warning: `scope: "shared"` means a shared container and shared workspace. No（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cross-session isolation. Use `scope: "session"` for per-session isolation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy: `perSession` is still supported (`true` → `scope: "session"`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`false` → `scope: "shared"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`setupCommand` runs **once** after the container is created (inside the container via `sh -lc`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For package installs, ensure network egress, a writable root FS, and a root user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        mode: "non-main", // off | non-main | all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        scope: "agent", // session | agent | shared (agent is default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspaceAccess: "none", // none | ro | rw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        workspaceRoot: "~/.openclaw/sandboxes",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        docker: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          image: "openclaw-sandbox:bookworm-slim",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          containerPrefix: "openclaw-sbx-",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          workdir: "/workspace",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          readOnlyRoot: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          tmpfs: ["/tmp", "/var/tmp", "/run"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          network: "none",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          user: "1000:1000",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          capDrop: ["ALL"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          env: { LANG: "C.UTF-8" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          setupCommand: "apt-get update && apt-get install -y git curl jq",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          pidsLimit: 256,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          memory: "1g",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          memorySwap: "2g",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          cpus: 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ulimits: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            nofile: { soft: 1024, hard: 2048 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            nproc: 256,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          seccompProfile: "/path/to/seccomp.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          apparmorProfile: "openclaw-sandbox",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          dns: ["1.1.1.1", "8.8.8.8"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          extraHosts: ["internal.service:10.0.0.5"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          image: "openclaw-sandbox-browser:bookworm-slim",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          containerPrefix: "openclaw-sbx-browser-",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          cdpPort: 9222,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          vncPort: 5900,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          noVncPort: 6080,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          headless: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enableNoVnc: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowHostControl: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowedControlUrls: ["http://10.0.0.42:18791"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowedControlPorts: [18791],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          autoStart: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          autoStartTimeoutMs: 12000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        prune: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          idleHours: 24, // 0 disables idle pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          maxAgeDays: 7, // 0 disables max-age pruning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sandbox: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allow: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "exec",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "process",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "read",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "write",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "edit",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "apply_patch",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_list",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_history",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "sessions_spawn",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          "session_status",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Build the default sandbox image once with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: sandbox containers default to `network: "none"`; set `agents.defaults.sandbox.docker.network`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to `"bridge"` (or your custom network) if the agent needs outbound access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: inbound attachments are staged into the active workspace at `media/inbound/*`. With `workspaceAccess: "rw"`, that means files are written into the agent workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: `docker.binds` mounts additional host directories; global and per-agent binds are merged.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Build the optional browser image with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/sandbox-browser-setup.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `agents.defaults.sandbox.browser.enabled=true`, the browser tool uses a sandboxed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Chromium instance (CDP). If noVNC is enabled (default when headless=false),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the noVNC URL is injected into the system prompt so the agent can reference it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This does not require `browser.enabled` in the main config; the sandbox control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
URL is injected per session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.defaults.sandbox.browser.allowHostControl` (default: false) allows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sandboxed sessions to explicitly target the **host** browser control server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
via the browser tool (`target: "host"`). Leave this off if you want strict（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sandbox isolation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Allowlists for remote control:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowedControlUrls`: exact control URLs permitted for `target: "custom"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowedControlHosts`: hostnames permitted (hostname only, no port).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowedControlPorts`: ports permitted (defaults: http=80, https=443).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Defaults: all allowlists are unset (no restriction). `allowHostControl` defaults to false.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models` (custom providers + base URLs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses the **pi-coding-agent** model catalog. You can add custom providers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(LiteLLM, local OpenAI-compatible servers, Anthropic proxies, etc.) by writing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/agents/<agentId>/agent/models.json` or by defining the same schema inside your（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw config under `models.providers`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider-by-provider overview + examples: [/concepts/model-providers](/concepts/model-providers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `models.providers` is present, OpenClaw writes/merges a `models.json` into（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/agents/<agentId>/agent/` on startup:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- default behavior: **merge** (keeps existing providers, overrides on name)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- set `models.mode: "replace"` to overwrite the file contents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Select the model via `agents.defaults.model.primary` (provider/model).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "custom-proxy/llama-3.1-8b" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "custom-proxy/llama-3.1-8b": {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "custom-proxy": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "http://localhost:4000/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "LITELLM_KEY",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-completions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "llama-3.1-8b",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Llama 3.1 8B",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 128000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 32000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### OpenCode Zen (multi-model proxy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenCode Zen is a multi-model gateway with per-model endpoints. OpenClaw uses（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the built-in `opencode` provider from pi-ai; set `OPENCODE_API_KEY` (or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`OPENCODE_ZEN_API_KEY`) from [https://opencode.ai/auth](https://opencode.ai/auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model refs use `opencode/<modelId>` (example: `opencode/claude-opus-4-6`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you enable an allowlist via `agents.defaults.models`, add each model you plan to use.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Shortcut: `openclaw onboard --auth-choice opencode-zen`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "opencode/claude-opus-4-6" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Z.AI (GLM-4.7) — provider alias support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Z.AI models are available via the built-in `zai` provider. Set `ZAI_API_KEY`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
in your environment and reference the model by provider/model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Shortcut: `openclaw onboard --auth-choice zai-api-key`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "zai/glm-4.7" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "zai/glm-4.7": {} },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `z.ai/*` and `z-ai/*` are accepted aliases and normalize to `zai/*`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `ZAI_API_KEY` is missing, requests to `zai/*` will fail with an auth error at runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example error: `No API key found for provider "zai".`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Z.AI’s general API endpoint is `https://api.z.ai/api/paas/v4`. GLM coding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  requests use the dedicated Coding endpoint `https://api.z.ai/api/coding/paas/v4`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The built-in `zai` provider uses the Coding endpoint. If you need the general（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  endpoint, define a custom provider in `models.providers` with the base URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  override (see the custom providers section above).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use a fake placeholder in docs/configs; never commit real API keys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Moonshot AI (Kimi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use Moonshot's OpenAI-compatible endpoint:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { MOONSHOT_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "moonshot/kimi-k2.5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      moonshot: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.moonshot.ai/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${MOONSHOT_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-completions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "kimi-k2.5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "Kimi K2.5",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 256000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `MOONSHOT_API_KEY` in the environment or use `openclaw onboard --auth-choice moonshot-api-key`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model ref: `moonshot/kimi-k2.5`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For the China endpoint, either:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Run `openclaw onboard --auth-choice moonshot-api-key-cn` (wizard will set `https://api.moonshot.cn/v1`), or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Manually set `baseUrl: "https://api.moonshot.cn/v1"` in `models.providers.moonshot`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Kimi Coding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use Moonshot AI's Kimi Coding endpoint (Anthropic-compatible, built-in provider):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { KIMI_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "kimi-coding/k2p5" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `KIMI_API_KEY` in the environment or use `openclaw onboard --auth-choice kimi-code-api-key`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model ref: `kimi-coding/k2p5`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Synthetic (Anthropic-compatible)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use Synthetic's Anthropic-compatible endpoint:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { SYNTHETIC_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      synthetic: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.synthetic.new/anthropic",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${SYNTHETIC_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "anthropic-messages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "hf:MiniMaxAI/MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "MiniMax M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 192000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 65536,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `SYNTHETIC_API_KEY` or use `openclaw onboard --auth-choice synthetic-api-key`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model ref: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Base URL should omit `/v1` because the Anthropic client appends it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Local models (LM Studio) — recommended setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/gateway/local-models](/gateway/local-models) for the current local guidance. TL;DR: run MiniMax M2.1 via LM Studio Responses API on serious hardware; keep hosted models merged for fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### MiniMax M2.1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use MiniMax M2.1 directly without LM Studio:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: { primary: "minimax/MiniMax-M2.1" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "anthropic/claude-opus-4-6": { alias: "Opus" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "minimax/MiniMax-M2.1": { alias: "Minimax" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      minimax: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.minimax.io/anthropic",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${MINIMAX_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "anthropic-messages",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            id: "MiniMax-M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            name: "MiniMax M2.1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            reasoning: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            input: ["text"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            // Pricing: update in models.json if you need exact cost tracking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            contextWindow: 200000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            maxTokens: 8192,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `MINIMAX_API_KEY` environment variable or use `openclaw onboard --auth-choice minimax-api`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Available model: `MiniMax-M2.1` (default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update pricing in `models.json` if you need exact cost tracking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Cerebras (GLM 4.6 / 4.7)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use Cerebras via their OpenAI-compatible endpoint:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  env: { CEREBRAS_API_KEY: "sk-..." },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        primary: "cerebras/zai-glm-4.7",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        fallbacks: ["cerebras/zai-glm-4.6"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "merge",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    providers: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cerebras: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        baseUrl: "https://api.cerebras.ai/v1",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "${CEREBRAS_API_KEY}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        api: "openai-completions",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `cerebras/zai-glm-4.7` for Cerebras; use `zai/glm-4.7` for Z.AI direct.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `CEREBRAS_API_KEY` in the environment or config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Supported APIs: `openai-completions`, `openai-responses`, `anthropic-messages`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `google-generative-ai`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `authHeader: true` + `headers` for custom auth needs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Override the agent config root with `OPENCLAW_AGENT_DIR` (or `PI_CODING_AGENT_DIR`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if you want `models.json` stored elsewhere (default: `~/.openclaw/agents/main/agent`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `session`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls session scoping, reset policy, reset triggers, and where the session store is written.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scope: "per-sender",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    dmScope: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    identityLinks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      alice: ["telegram:123456789", "discord:987654321012345678"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reset: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "daily",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      atHour: 4,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      idleMinutes: 60,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resetByType: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      thread: { mode: "daily", atHour: 4 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      direct: { mode: "idle", idleMinutes: 240 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      group: { mode: "idle", idleMinutes: 120 },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resetTriggers: ["/new", "/reset"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Default is already per-agent under ~/.openclaw/agents/<agentId>/sessions/sessions.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // You can override with {agentId} templating:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    maintenance: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "warn",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      pruneAfter: "30d",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxEntries: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      rotateBytes: "10mb",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Direct chats collapse to agent:<agentId>:<mainKey> (default: "main").（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mainKey: "main",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    agentToAgent: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Max ping-pong reply turns between requester/target (0–5).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxPingPongTurns: 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sendPolicy: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      default: "allow",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mainKey`: direct-chat bucket key (default: `"main"`). Useful when you want to “rename” the primary DM thread without changing `agentId`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Sandbox note: `agents.defaults.sandbox.mode: "non-main"` uses this key to detect the main session. Any session key that does not match `mainKey` (groups/channels) is sandboxed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dmScope`: how DM sessions are grouped (default: `"main"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `main`: all DMs share the main session for continuity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `per-peer`: isolate DMs by sender id across channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `per-channel-peer`: isolate DMs per channel + sender (recommended for multi-user inboxes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `per-account-channel-peer`: isolate DMs per account + channel + sender (recommended for multi-account inboxes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Secure DM mode (recommended): set `session.dmScope: "per-channel-peer"` when multiple people can DM the bot (shared inboxes, multi-person allowlists, or `dmPolicy: "open"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `identityLinks`: map canonical ids to provider-prefixed peers so the same person shares a DM session across channels when using `per-peer`, `per-channel-peer`, or `per-account-channel-peer`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Example: `alice: ["telegram:123456789", "discord:987654321012345678"]`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reset`: primary reset policy. Defaults to daily resets at 4:00 AM local time on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `mode`: `daily` or `idle` (default: `daily` when `reset` is present).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `atHour`: local hour (0-23) for the daily reset boundary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `idleMinutes`: sliding idle window in minutes. When daily + idle are both configured, whichever expires first wins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `resetByType`: per-session overrides for `direct`, `group`, and `thread`. Legacy `dm` key is accepted as an alias for `direct`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If you only set legacy `session.idleMinutes` without any `reset`/`resetByType`, OpenClaw stays in idle-only mode for backward compatibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `heartbeatIdleMinutes`: optional idle override for heartbeat checks (daily reset still applies when enabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agentToAgent.maxPingPongTurns`: max reply-back turns between requester/target (0–5, default 5).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendPolicy.default`: `allow` or `deny` fallback when no rule matches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sendPolicy.rules[]`: match by `channel`, `chatType` (`direct|group|room`), or `keyPrefix` (e.g. `cron:`). First deny wins; otherwise allow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maintenance`: session store maintenance settings for pruning, capping, and rotation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `mode`: `"warn"` (default) warns the active session (best-effort delivery) when it would be evicted without enforcing maintenance. `"enforce"` applies pruning and rotation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pruneAfter`: remove entries older than this duration (for example `"30m"`, `"1h"`, `"30d"`). Default "30d".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `maxEntries`: cap the number of session entries kept (default 500).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `rotateBytes`: rotate `sessions.json` when it exceeds this size (for example `"10kb"`, `"1mb"`, `"10mb"`). Default "10mb".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `skills` (skills config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls bundled allowlist, install preferences, extra skill folders, and per-skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
overrides. Applies to **bundled** skills and `~/.openclaw/skills` (workspace skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
still win on name conflicts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowBundled`: optional allowlist for **bundled** skills only. If set, only those（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bundled skills are eligible (managed/workspace skills unaffected).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `load.extraDirs`: additional skill directories to scan (lowest precedence).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `install.preferBrew`: prefer brew installers when available (default: true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `install.nodeManager`: node installer preference (`npm` | `pnpm` | `yarn`, default: npm).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `entries.<skillKey>`: per-skill config overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-skill fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`: set `false` to disable a skill even if it’s bundled/installed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `env`: environment variables injected for the agent run (only if not already set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `apiKey`: optional convenience for skills that declare a primary env var (e.g. `nano-banana-pro` → `GEMINI_API_KEY`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allowBundled: ["gemini", "peekaboo"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    load: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    install: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      preferBrew: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      nodeManager: "npm",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "nano-banana-pro": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        apiKey: "GEMINI_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        env: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          GEMINI_API_KEY: "GEMINI_KEY_HERE",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      peekaboo: { enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sag: { enabled: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `plugins` (extensions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls plugin discovery, allow/deny, and per-plugin config. Plugins are loaded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
from `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, plus any（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`plugins.load.paths` entries. **Config changes require a gateway restart.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/plugin](/tools/plugin) for full usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled`: master toggle for plugin loading (default: true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allow`: optional allowlist of plugin ids; when set, only listed plugins load.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deny`: optional denylist of plugin ids (deny wins).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `load.paths`: extra plugin files or directories to load (absolute or `~`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `entries.<pluginId>`: per-plugin overrides.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `enabled`: set `false` to disable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `config`: plugin-specific config object (validated by the plugin if provided).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allow: ["voice-call"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    load: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      paths: ["~/Projects/oss/voice-call-extension"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    entries: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "voice-call": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        config: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          provider: "twilio",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `browser` (openclaw-managed browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can start a **dedicated, isolated** Chrome/Brave/Edge/Chromium instance for openclaw and expose a small loopback control service.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profiles can point at a **remote** Chromium-based browser via `profiles.<name>.cdpUrl`. Remote（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
profiles are attach-only (start/stop/reset are disabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`browser.cdpUrl` remains for legacy single-profile configs and as the base（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scheme/host for profiles that only set `cdpPort`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- enabled: `true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- evaluateEnabled: `true` (set `false` to disable `act:evaluate` and `wait --fn`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- control service: loopback only (port derived from `gateway.port`, default `18791`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CDP URL: `http://127.0.0.1:18792` (control service + 1, legacy single-profile)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- profile color: `#FF4500` (lobster-orange)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Note: the control server is started by the running gateway (OpenClaw.app menubar, or `openclaw gateway`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-detect order: default browser if Chromium-based; otherwise Chrome → Brave → Edge → Chromium → Chrome Canary.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    evaluateEnabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaultProfile: "chrome",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profiles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      openclaw: { cdpPort: 18800, color: "#FF4500" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      work: { cdpPort: 18801, color: "#0066CC" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    color: "#FF4500",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Advanced:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // headless: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // noSandbox: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // attachOnly: false, // set true when tunneling a remote CDP to localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `ui` (Appearance)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional accent color used by the native apps for UI chrome (e.g. Talk Mode bubble tint).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If unset, clients fall back to a muted light-blue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ui: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    seamColor: "#FF4500", // hex (RRGGBB or #RRGGBB)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // Optional: Control UI assistant identity override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // If unset, the Control UI uses the active agent identity (config or IDENTITY.md).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    assistant: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      name: "OpenClaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      avatar: "CB", // emoji, short text, or image URL/data URI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway` (Gateway server mode + bind)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `gateway.mode` to explicitly declare whether this machine should run the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- mode: **unset** (treated as “do not auto-start”)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- bind: `loopback`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- port: `18789` (single port for WS + HTTP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "local", // or "remote"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    port: 18789, // WS + HTTP multiplex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "loopback",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // controlUi: { enabled: true, basePath: "/openclaw" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // auth: { mode: "token", token: "your-token" } // token gates WS + Control UI access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    // tailscale: { mode: "off" | "serve" | "funnel" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control UI base path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.controlUi.basePath` sets the URL prefix where the Control UI is served.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Examples: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: root (`/`) (unchanged).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.controlUi.root` sets the filesystem root for Control UI assets (default: `dist/control-ui`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.controlUi.allowInsecureAuth` allows token-only auth for the Control UI when（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  device identity is omitted (typically over HTTP). Default: `false`. Prefer HTTPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (Tailscale Serve) or `127.0.0.1`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.controlUi.dangerouslyDisableDeviceAuth` disables device identity checks for the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Control UI (token/password only). Default: `false`. Break-glass only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related docs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Control UI](/web/control-ui)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Web overview](/web)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Tailscale](/gateway/tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Remote access](/gateway/remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Trusted proxies:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.trustedProxies`: list of reverse proxy IPs that terminate TLS in front of the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When a connection comes from one of these IPs, OpenClaw uses `x-forwarded-for` (or `x-real-ip`) to determine the client IP for local pairing checks and HTTP auth/local checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only list proxies you fully control, and ensure they **overwrite** incoming `x-forwarded-for`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway` refuses to start unless `gateway.mode` is set to `local` (or you pass the override flag).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.port` controls the single multiplexed port used for WebSocket + HTTP (control UI, hooks, A2UI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI Chat Completions endpoint: **disabled by default**; enable with `gateway.http.endpoints.chatCompletions.enabled: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Precedence: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > default `18789`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway auth is required by default (token/password or Tailscale Serve identity). Non-loopback binds require a shared token/password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The onboarding wizard generates a gateway token by default (even on loopback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.token` is **only** for remote CLI calls; it does not enable local gateway auth. `gateway.token` is ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auth and Tailscale:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.auth.mode` sets the handshake requirements (`token` or `password`). When unset, token auth is assumed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.auth.token` stores the shared token for token auth (used by the CLI on the same machine).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gateway.auth.mode` is set, only that method is accepted (plus optional Tailscale headers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.auth.password` can be set here, or via `OPENCLAW_GATEWAY_PASSWORD` (recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.auth.allowTailscale` allows Tailscale Serve identity headers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (`tailscale-user-login`) to satisfy auth when the request arrives on loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  with `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`. OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  verifies the identity by resolving the `x-forwarded-for` address via（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `tailscale whois` before accepting it. When `true`, Serve requests do not need（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a token/password; set `false` to require explicit credentials. Defaults to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `true` when `tailscale.mode = "serve"` and auth mode is not `password`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.tailscale.mode: "serve"` uses Tailscale Serve (tailnet only, loopback bind).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.tailscale.mode: "funnel"` exposes the dashboard publicly; requires auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.tailscale.resetOnExit` resets Serve/Funnel config on shutdown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote client defaults (CLI):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.url` sets the default Gateway WebSocket URL for CLI calls when `gateway.mode = "remote"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.transport` selects the macOS remote transport (`ssh` default, `direct` for ws/wss). When `direct`, `gateway.remote.url` must be `ws://` or `wss://`. `ws://host` defaults to port `18789`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.token` supplies the token for remote calls (leave unset for no auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.password` supplies the password for remote calls (leave unset for no auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS app behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw.app watches `~/.openclaw/openclaw.json` and switches modes live when `gateway.mode` or `gateway.remote.url` changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `gateway.mode` is unset but `gateway.remote.url` is set, the macOS app treats it as remote mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When you change connection mode in the macOS app, it writes `gateway.mode` (and `gateway.remote.url` + `gateway.remote.transport` in remote mode) back to the config file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "remote",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      url: "ws://gateway.tailnet:18789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "your-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      password: "your-password",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Direct transport example (macOS app):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "remote",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      transport: "direct",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      url: "wss://gateway.example.ts.net",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "your-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway.reload` (Config hot reload)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway watches `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`) and applies changes automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hybrid` (default): hot-apply safe changes; restart the Gateway for critical changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hot`: only apply hot-safe changes; log when a restart is required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `restart`: restart the Gateway on any config change.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: disable hot reload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reload: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      mode: "hybrid",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      debounceMs: 300,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Hot reload matrix (files + impact)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Files watched:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hot-applied (no full gateway restart):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (Gmail watcher restarted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser` (browser control server restart)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron` (cron service restart + concurrency update)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.heartbeat` (heartbeat runner restart)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `web` (WhatsApp web channel restart)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `telegram`, `discord`, `signal`, `imessage` (channel restarts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard` (dynamic reads)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Requires full Gateway restart:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway` (port/bind/auth/control UI/tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bridge` (legacy)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `discovery`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvasHost`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `plugins`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Any unknown/unsupported config path (defaults to restart for safety)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-instance isolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To run multiple gateways on one host (for redundancy or a rescue bot), isolate per-instance state + config and use unique ports:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH` (per-instance config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR` (sessions/creds)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.workspace` (memories)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.port` (unique per instance)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Convenience flags (CLI):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw --dev …` → uses `~/.openclaw-dev` + shifts ports from base `19001`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw --profile <name> …` → uses `~/.openclaw-<name>` (port via config/env/flags)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Gateway runbook](/gateway) for the derived port mapping (gateway/browser/canvas).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Multiple gateways](/gateway/multiple-gateways) for browser/CDP port isolation details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_STATE_DIR=~/.openclaw-a \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 19001（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `hooks` (Gateway webhooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable a simple HTTP webhook endpoint on the Gateway HTTP server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- enabled: `false`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- path: `/hooks`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- maxBodyBytes: `262144` (256 KB)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hooks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    token: "shared-secret",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    path: "/hooks",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    presets: ["gmail"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    transformsDir: "~/.openclaw/hooks",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mappings: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        match: { path: "gmail" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        action: "agent",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        wakeMode: "now",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        name: "Gmail",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sessionKey: "hook:gmail:{{messages[0].id}}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        deliver: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: "last",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "openai/gpt-5.2-mini",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Requests must include the hook token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Authorization: Bearer <token>` **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-token: <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Endpoints:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /hooks/<name>` → resolved via `hooks.mappings`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/hooks/agent` always posts a summary into the main session (and can optionally trigger an immediate heartbeat via `wakeMode: "now"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Mapping notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `match.path` matches the sub-path after `/hooks` (e.g. `/hooks/gmail` → `gmail`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `match.source` matches a payload field (e.g. `{ source: "gmail" }`) so you can use a generic `/hooks/ingest` path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Templates like `{{messages[0].subject}}` read from the payload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `transform` can point to a JS/TS module that returns a hook action.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deliver: true` sends the final reply to a channel; `channel` defaults to `last` (falls back to WhatsApp).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If there is no prior delivery route, set `channel` + `to` explicitly (required for Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model` overrides the LLM for this hook run (`provider/model` or alias; must be allowed if `agents.defaults.models` is set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gmail helper config (used by `openclaw webhooks gmail setup` / `run`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hooks: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    gmail: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      account: "openclaw@gmail.com",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      topic: "projects/<project-id>/topics/gog-gmail-watch",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      subscription: "gog-gmail-watch-push",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      pushToken: "shared-push-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      includeBody: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      maxBytes: 20000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      renewEveryMinutes: 720,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Optional: use a cheaper model for Gmail hook processing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Falls back to agents.defaults.model.fallbacks, then primary, on auth/rate-limit/timeout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Optional: default thinking level for Gmail hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      thinking: "off",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model override for Gmail hooks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks.gmail.model` specifies a model to use for Gmail hook processing (defaults to session primary).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Accepts `provider/model` refs or aliases from `agents.defaults.models`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Falls back to `agents.defaults.model.fallbacks`, then `agents.defaults.model.primary`, on auth/rate-limit/timeouts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `agents.defaults.models` is set, include the hooks model in the allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- At startup, warns if the configured model is not in the model catalog or allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hooks.gmail.thinking` sets the default thinking level for Gmail hooks and is overridden by per-hook `thinking`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway auto-start:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `gog gmail watch serve` on boot and auto-renews the watch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to disable the auto-start (for manual runs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid running a separate `gog gmail watch serve` alongside the Gateway; it will（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  fail with `listen tcp 127.0.0.1:8788: bind: address already in use`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: when `tailscale.mode` is on, OpenClaw defaults `serve.path` to `/` so（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tailscale can proxy `/gmail-pubsub` correctly (it strips the set-path prefix).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need the backend to receive the prefixed path, set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`hooks.gmail.tailscale.target` to a full URL (and align `serve.path`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `canvasHost` (LAN/tailnet Canvas file server + live reload)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Gateway serves a directory of HTML/CSS/JS over HTTP so iOS/Android nodes can simply `canvas.navigate` to it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default root: `~/.openclaw/workspace/canvas`  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default port: `18793` (chosen to avoid the openclaw browser CDP port `18792`)  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The server listens on the **gateway bind host** (LAN or Tailnet) so nodes can reach it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The server:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- serves files under `canvasHost.root`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- injects a tiny live-reload client into served HTML（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- watches the directory and broadcasts reloads over a WebSocket endpoint at `/__openclaw__/ws`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- auto-creates a starter `index.html` when the directory is empty (so you see something immediately)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- also serves A2UI at `/__openclaw__/a2ui/` and is advertised to nodes as `canvasHostUrl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (always used by nodes for Canvas/A2UI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable live reload (and file watching) if the directory is large or you hit `EMFILE`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- config: `canvasHost: { liveReload: false }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  canvasHost: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    root: "~/.openclaw/workspace/canvas",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    port: 18793,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    liveReload: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Changes to `canvasHost.*` require a gateway restart (config reload will restart).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Disable with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- config: `canvasHost: { enabled: false }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- env: `OPENCLAW_SKIP_CANVAS_HOST=1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `bridge` (legacy TCP bridge, removed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current builds no longer include the TCP bridge listener; `bridge.*` config keys are ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes connect over the Gateway WebSocket. This section is kept for historical reference.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Gateway could expose a simple TCP bridge for nodes (iOS/Android), typically on port `18790`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- enabled: `true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- port: `18790`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- bind: `lan` (binds to `0.0.0.0`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bind modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `lan`: `0.0.0.0` (reachable on any interface, including LAN/Wi‑Fi and Tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tailnet`: bind only to the machine’s Tailscale IP (recommended for Vienna ⇄ London)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `loopback`: `127.0.0.1` (local only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `auto`: prefer tailnet IP if present, else `lan`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
TLS:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bridge.tls.enabled`: enable TLS for bridge connections (TLS-only when enabled).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bridge.tls.autoGenerate`: generate a self-signed cert when no cert/key are present (default: true).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bridge.tls.certPath` / `bridge.tls.keyPath`: PEM paths for the bridge certificate + private key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bridge.tls.caPath`: optional PEM CA bundle (custom roots or future mTLS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When TLS is enabled, the Gateway advertises `bridgeTls=1` and `bridgeTlsSha256` in discovery TXT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
records so nodes can pin the certificate. Manual connections use trust-on-first-use if no（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fingerprint is stored yet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auto-generated certs require `openssl` on PATH; if generation fails, the bridge will not start.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bridge: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    port: 18790,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bind: "tailnet",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tls: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // Uses ~/.openclaw/bridge/tls/bridge-{cert,key}.pem when omitted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      // keyPath: "~/.openclaw/bridge/tls/bridge-key.pem"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `discovery.mdns` (Bonjour / mDNS broadcast mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Controls LAN mDNS discovery broadcasts (`_openclaw-gw._tcp`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `minimal` (default): omit `cliPath` + `sshPort` from TXT records（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `full`: include `cliPath` + `sshPort` in TXT records（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `off`: disable mDNS broadcasts entirely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hostname: defaults to `openclaw` (advertises `openclaw.local`). Override with `OPENCLAW_MDNS_HOSTNAME`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  discovery: { mdns: { mode: "minimal" } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS‑SD)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, the Gateway writes a unicast DNS-SD zone for `_openclaw-gw._tcp` under `~/.openclaw/dns/` using the configured discovery domain (example: `openclaw.internal.`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To make iOS/Android discover across networks (Vienna ⇄ London), pair this with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- a DNS server on the gateway host serving your chosen domain (CoreDNS is recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale **split DNS** so clients resolve that domain via the gateway DNS server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One-time setup helper (gateway host):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw dns setup --apply（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  discovery: { wideArea: { enabled: true } },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Media model template variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Template placeholders are expanded in `tools.media.*.models[].args` and `tools.media.models[].args` (and any future templated argument fields).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Variable           | Description                                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------ | ------------------------------------------------------------------------------- | -------- | ------- | ---------- | ----- | ------ | -------- | ------- | ------- | --- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{Body}}`         | Full inbound message body                                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{RawBody}}`      | Raw inbound message body (no history/sender wrappers; best for command parsing) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents)                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{From}}`         | Sender identifier (E.164 for WhatsApp; may differ per channel)                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{To}}`           | Destination identifier                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{MessageSid}}`   | Channel message id (when available)                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{SessionId}}`    | Current session UUID                                                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{IsNewSession}}` | `"true"` when a new session was created                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{MediaUrl}}`     | Inbound media pseudo-URL (if present)                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{MediaPath}}`    | Local media path (if downloaded)                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{MediaType}}`    | Media type (image/audio/document/…)                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{Transcript}}`   | Audio transcript (when enabled)                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{Prompt}}`       | Resolved media prompt for CLI entries                                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{MaxChars}}`     | Resolved max output chars for CLI entries                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{ChatType}}`     | `"direct"` or `"group"`                                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{GroupSubject}}` | Group subject (best effort)                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{GroupMembers}}` | Group members preview (best effort)                                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{SenderName}}`   | Sender display name (best effort)                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{SenderE164}}`   | Sender phone number (best effort)                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `{{Provider}}`     | Provider hint (whatsapp                                                         | telegram | discord | googlechat | slack | signal | imessage | msteams | webchat | …)  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cron (Gateway scheduler)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cron is a Gateway-owned scheduler for wakeups and scheduled jobs. See [Cron jobs](/automation/cron-jobs) for the feature overview and CLI examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cron: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    maxConcurrentRuns: 2,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sessionRetention: "24h",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fields:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionRetention`: how long to keep completed cron run sessions before pruning. Accepts a duration string like `"24h"` or `"7d"`. Use `false` to disable pruning. Default is 24h.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
_Next: [Agent Runtime](/concepts/agent)_ 🦞（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

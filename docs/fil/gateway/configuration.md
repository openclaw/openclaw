---
summary: "Lahat ng opsyon sa configuration para sa ~/.openclaw/openclaw.json na may mga halimbawa"
read_when:
  - Pagdaragdag o pagbabago ng mga field ng config
title: "Konpigurasyon"
---

# Konpigurasyon 🔧

Binabasa ng OpenClaw ang opsyonal na **JSON5** config mula sa `~/.openclaw/openclaw.json` (pinapayagan ang mga komento + trailing commas).

Kung nawawala ang file, gagamit ang OpenClaw ng medyo‑ligtas na default (embedded Pi agent + per‑sender sessions + workspace `~/.openclaw/workspace`). Karaniwan ay kailangan mo lamang ng config upang:

- limitahan kung sino ang puwedeng mag‑trigger ng bot (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, atbp.)
- kontrolin ang mga group allowlist + asal ng pag‑mention (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- i‑customize ang mga prefix ng mensahe (`messages`)
- itakda ang workspace ng agent (`agents.defaults.workspace` o `agents.list[].workspace`)
- i‑tune ang mga default ng embedded agent (`agents.defaults`) at asal ng session (`session`)
- itakda ang identity kada agent (`agents.list[].identity`)

> **Bago sa configuration?** Tingnan ang gabay na [Configuration Examples](/gateway/configuration-examples) para sa mga kumpletong halimbawa na may detalyadong paliwanag!

## Mahigpit na pag‑validate ng config

Tumatanggap lamang ang OpenClaw ng mga configuration na ganap na tumutugma sa schema.
Ang mga hindi kilalang key, maling uri, o hindi valid na halaga ay magdudulot na **tumangging mag‑start** ang Gateway para sa kaligtasan.

Kapag pumalya ang validation:

- Hindi magbo‑boot ang Gateway.
- Mga diagnostic command lang ang pinapayagan (halimbawa: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Patakbuhin ang `openclaw doctor` para makita ang eksaktong mga isyu.
- Patakbuhin ang `openclaw doctor --fix` (o `--yes`) para mag‑apply ng migrations/repairs.

Hindi kailanman nagsusulat ng pagbabago ang Doctor maliban kung tahasan kang mag‑opt in sa `--fix`/`--yes`.

## Schema + mga UI hint

The Gateway exposes a JSON Schema representation of the config via `config.schema` for UI editors.
The Control UI renders a form from this schema, with a **Raw JSON** editor as an escape hatch.

Maaaring mag‑register ang mga channel plugin at extension ng schema + mga UI hint para sa kanilang config, kaya nananatiling schema‑driven ang mga setting ng channel sa iba’t ibang app nang walang hard‑coded na form.

Ang mga hint (label, grouping, sensitive fields) ay kasama sa schema para makapag‑render ang mga client ng mas maayos na mga form nang hindi kino‑code ang kaalaman sa config.

## I‑apply + i‑restart (RPC)

Use `config.apply` to validate + write the full config and restart the Gateway in one step.
It writes a restart sentinel and pings the last active session after the Gateway comes back.

Warning: `config.apply` replaces the **entire config**. If you want to change only a few keys,
use `config.patch` or `openclaw config set`. Keep a backup of `~/.openclaw/openclaw.json`.

Mga parameter:

- `raw` (string) — JSON5 payload para sa buong config
- `baseHash` (opsyonal) — config hash mula sa `config.get` (kailangan kapag may umiiral na config)
- `sessionKey` (opsyonal) — huling aktibong session key para sa wake‑up ping
- `note` (opsyonal) — note na isasama sa restart sentinel
- `restartDelayMs` (opsyonal) — delay bago mag‑restart (default 2000)

Halimbawa (sa pamamagitan ng `gateway call`):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Mga bahagyang update (RPC)

Use `config.patch` to merge a partial update into the existing config without clobbering
unrelated keys. It applies JSON merge patch semantics:

- recursive na nag‑me‑merge ang mga object
- `null` ay nagtatanggal ng key
- pinapalitan ang mga array  
  Katulad ng `config.apply`, ito ay nagva‑validate, nagsusulat ng config, nagtatago ng restart sentinel, at nag‑iiskedyul
  ng restart ng Gateway (na may opsyonal na wake kapag ibinigay ang `sessionKey`).

Mga parameter:

- `raw` (string) — JSON5 payload na naglalaman lang ng mga key na babaguhin
- `baseHash` (kailangan) — config hash mula sa `config.get`
- `sessionKey` (opsyonal) — huling aktibong session key para sa wake‑up ping
- `note` (opsyonal) — note na isasama sa restart sentinel
- `restartDelayMs` (opsyonal) — delay bago mag‑restart (default 2000)

Halimbawa:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Minimal na config (inirerekomendang panimulang punto)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Buuin ang default image nang isang beses gamit ang:

```bash
scripts/sandbox-setup.sh
```

## Self‑chat mode (inirerekomenda para sa kontrol ng grupo)

Para pigilan ang bot na tumugon sa WhatsApp @‑mentions sa mga grupo (tutugon lang sa mga partikular na text trigger):

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Mga Config Include (`$include`)

Split your config into multiple files using the `$include` directive. This is useful for:

- Pag‑oorganisa ng malalaking config (hal., per‑client na depinisyon ng agent)
- Pagbabahagi ng mga karaniwang setting sa iba’t ibang environment
- Paghiwalay ng mga sensitibong config

### Pangunahing paggamit

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### Asal ng pag‑merge

- **Isang file**: Pinapalitan ang object na naglalaman ng `$include`
- **Array ng mga file**: Deep‑merge ayon sa pagkakasunod (ang mga huli ang nangingibabaw)
- **May katabing key**: Ang mga katabing key ay nira‑merge pagkatapos ng includes (ina‑override ang mga included value)
- **Katabing key + array/primitives**: Hindi suportado (dapat object ang included na nilalaman)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### Mga nested include

Maaaring maglaman ang mga included file mismo ng mga direktibang `$include` (hanggang 10 antas ang lalim):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### Resolusyon ng path

- **Relative na path**: Nireresolba kaugnay ng nag‑iinclude na file
- **Absolute na path**: Ginagamit kung ano ito
- **Mga parent directory**: Gumagana ayon sa inaasahan ang mga reference na `../`

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Pag‑hawak ng error

- **Nawawalang file**: Malinaw na error na may resolved na path
- **Parse error**: Ipinapakita kung aling included file ang pumalya
- **Circular include**: Natutukoy at iniuulat kasama ang include chain

### Halimbawa: Multi‑client na legal na setup

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

## Mga karaniwang opsyon

### Mga env var + `.env`

Binabasa ng OpenClaw ang mga env var mula sa parent process (shell, launchd/systemd, CI, atbp.).

Dagdag pa rito, nilo‑load nito ang:

- `.env` mula sa kasalukuyang working directory (kung mayroon)
- isang global fallback na `.env` mula sa `~/.openclaw/.env` (aka `$OPENCLAW_STATE_DIR/.env`)

Hindi ina‑override ng alinmang `.env` file ang mga umiiral na env var.

You can also provide inline env vars in config. These are only applied if the
process env is missing the key (same non-overriding rule):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

Tingnan ang [/environment](/help/environment) para sa buong precedence at mga source.

### `env.shellEnv` (opsyonal)

Opt-in convenience: if enabled and none of the expected keys are set yet, OpenClaw runs your login shell and imports only the missing expected keys (never overrides).
This effectively sources your shell profile.

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Katumbas na env var:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Substitution ng env var sa config

You can reference environment variables directly in any config string value using
`${VAR_NAME}` syntax. Variables are substituted at config load time, before validation.

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**Mga patakaran:**

- Uppercase lang na pangalan ng env var ang tinatapatan: `[A-Z_][A-Z0-9_]*`
- Ang nawawala o walang laman na env var ay magtataas ng error sa pag‑load ng config
- I‑escape gamit ang `$${VAR}` para maglabas ng literal na `${VAR}`
- Gumagana kasama ng `$include` (kasama ring nasu‑substitute ang mga included file)

**Inline substitution:**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"
      },
    },
  },
}
```

### Auth storage (OAuth + API keys)

OpenClaw stores **per-agent** auth profiles (OAuth + API keys) in:

- `<agentDir>/auth-profiles.json` (default: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

See also: [/concepts/oauth](/concepts/oauth)

Legacy OAuth imports:

- `~/.openclaw/credentials/oauth.json` (or `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

The embedded Pi agent maintains a runtime cache at:

- `<agentDir>/auth.json` (managed automatically; don’t edit manually)

Legacy agent dir (pre multi-agent):

- `~/.openclaw/agent/*` (migrated by `openclaw doctor` into `~/.openclaw/agents/<defaultAgentId>/agent/*`)

Overrides:

- OAuth dir (legacy import only): `OPENCLAW_OAUTH_DIR`
- Agent dir (default agent root override): `OPENCLAW_AGENT_DIR` (preferred), `PI_CODING_AGENT_DIR` (legacy)

On first use, OpenClaw imports `oauth.json` entries into `auth-profiles.json`.

### `auth`

Optional metadata for auth profiles. This does **not** store secrets; it maps
profile IDs to a provider + mode (and optional email) and defines the provider
rotation order used for failover.

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

Optional per-agent identity used for defaults and UX. This is written by the macOS onboarding assistant.

If set, OpenClaw derives defaults (only when you haven’t set them explicitly):

- `messages.ackReaction` from the **active agent**’s `identity.emoji` (falls back to 👀)
- `agents.list[].groupChat.mentionPatterns` from the agent’s `identity.name`/`identity.emoji` (so “@Samantha” works in groups across Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)
- `identity.avatar` accepts a workspace-relative image path or a remote URL/data URL. Local files must live inside the agent workspace.

`identity.avatar` accepts:

- Workspace-relative path (must stay within the agent workspace)
- `http(s)` URL
- `data:` URI

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

### `wizard`

Metadata written by CLI wizards (`onboard`, `configure`, `doctor`).

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

### `logging`

- Default log file: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- If you want a stable path, set `logging.file` to `/tmp/openclaw/openclaw.log`.
- Console output can be tuned separately via:
  - `logging.consoleLevel` (defaults to `info`, bumps to `debug` when `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Tool summaries can be redacted to avoid leaking secrets:
  - `logging.redactSensitive` (`off` | `tools`, default: `tools`)
  - `logging.redactPatterns` (array of regex strings; overrides defaults)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Example: override defaults with your own rules.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

### `channels.whatsapp.dmPolicy`

Controls how WhatsApp direct chats (DMs) are handled:

- `"pairing"` (default): unknown senders get a pairing code; owner must approve
- `"allowlist"`: only allow senders in `channels.whatsapp.allowFrom` (or paired allow store)
- `"open"`: allow all inbound DMs (**requires** `channels.whatsapp.allowFrom` to include `"*"`)
- `"disabled"`: ignore all inbound DMs

Pairing codes expire after 1 hour; the bot only sends a pairing code when a new request is created. Pending DM pairing requests are capped at **3 per channel** by default.

Pairing approvals:

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

Allowlist of E.164 phone numbers that may trigger WhatsApp auto-replies (**DMs only**).
If empty and `channels.whatsapp.dmPolicy="pairing"`, unknown senders will receive a pairing code.
For groups, use `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // optional outbound chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      mediaMaxMb: 50, // optional inbound media cap (MB)
    },
  },
}
```

### `channels.whatsapp.sendReadReceipts`

Controls whether inbound WhatsApp messages are marked as read (blue ticks). Default: `true`.

Self-chat mode always skips read receipts, even when enabled.

Per-account override: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (multi-account)

Run multiple WhatsApp accounts in one gateway:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // optional; keeps the default id stable
        personal: {},
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

Mga tala:

- Outbound commands default to account `default` if present; otherwise the first configured account id (sorted).
- The legacy single-account Baileys auth dir is migrated by `openclaw doctor` into `whatsapp/default`.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

Run multiple accounts per channel (each account has its own `accountId` and optional `name`):

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

Mga tala:

- `default` is used when `accountId` is omitted (CLI + routing).
- Env tokens only apply to the **default** account.
- Base channel settings (group policy, mention gating, etc.) apply to all accounts unless overridden per account.
- Use `bindings[].match.accountId` to route each account to a different agents.defaults.

### Group chat mention gating (`agents.list[].groupChat` + `messages.groupChat`)

Group messages default to **require mention** (either metadata mention or regex patterns). Applies to WhatsApp, Telegram, Discord, Google Chat, and iMessage group chats.

**Mention types:**

- **Metadata mentions**: Native platform @-mentions (e.g., WhatsApp tap-to-mention). Ignored in WhatsApp self-chat mode (see `channels.whatsapp.allowFrom`).
- **Text patterns**: Regex patterns defined in `agents.list[].groupChat.mentionPatterns`. Always checked regardless of self-chat mode.
- Mention gating is enforced only when mention detection is possible (native mentions or at least one `mentionPattern`).

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` sets the global default for group history context. Channels can override with `channels.<channel>.historyLimit` (or `channels.<channel>.accounts.*.historyLimit` for multi-account). Set `0` to disable history wrapping.

#### DM history limits

DM conversations use session-based history managed by the agent. You can limit the number of user turns retained per DM session:

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30, // limit DM sessions to 30 user turns
      dms: {
        "123456789": { historyLimit: 50 }, // per-user override (user ID)
      },
    },
  },
}
```

Ayos ng resolusyon:

1. Per-DM override: `channels.<provider>.dms[userId].historyLimit`
2. Provider default: `channels.<provider>.dmHistoryLimit`
3. Walang limitasyon (lahat ng history ay pinananatili)

Mga suportadong provider: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Per-agent override (mas may prayoridad kapag nakatakda, kahit `[]`):

```json5
{
  agents: {
    list: [
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },
    ],
  },
}
```

Ang mga default ng mention gating ay naka-live kada channel (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). Kapag nakatakda ang `*.groups`, nagsisilbi rin itong group allowlist; isama ang `"*"` upang pahintulutan ang lahat ng grupo.

Upang tumugon **lamang** sa mga partikular na text trigger (hindi papansinin ang native @-mentions):

```json5
{
  channels: {
    whatsapp: {
      // Include your own number to enable self-chat mode (ignore native @-mentions).
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          // Only these text patterns will trigger responses
          mentionPatterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### Patakaran ng grupo (per channel)

Use `channels.*.groupPolicy` to control whether group/room messages are accepted at all:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: {
          channels: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
  },
}
```

Mga tala:

- `"open"`: nilalampasan ng mga grupo ang mga allowlist; nananatiling naaangkop ang mention-gating.
- `"disabled"`: hinaharangan ang lahat ng mensahe sa grupo/room.
- `"allowlist"`: only allow groups/rooms that match the configured allowlist.
- Itinatakda ng `channels.defaults.groupPolicy` ang default kapag hindi nakatakda ang `groupPolicy` ng isang provider.
- Gumagamit ang WhatsApp/Telegram/Signal/iMessage/Microsoft Teams ng `groupAllowFrom` (fallback: tahasang `allowFrom`).
- Gumagamit ang Discord/Slack ng mga channel allowlist (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- Ang Group DMs (Discord/Slack) ay kontrolado pa rin ng `dm.groupEnabled` + `dm.groupChannels`.
- Default is `groupPolicy: "allowlist"` (unless overridden by `channels.defaults.groupPolicy`); if no allowlist is configured, group messages are blocked.

### Multi-agent routing (`agents.list` + `bindings`)

Magpatakbo ng maraming nakahiwalay na agent (hiwalay na workspace, `agentDir`, mga session) sa loob ng iisang Gateway.
Ang mga inbound na mensahe ay niruruta sa isang agent sa pamamagitan ng bindings.

- `agents.list[]`: per-agent overrides.
  - `id`: matatag na agent id (kinakailangan).
  - `default`: opsyonal; kapag marami ang nakatakda, ang una ang mananaig at magla-log ng babala.
    If none are set, the **first entry** in the list is the default agent.
  - `name`: display name for the agent.
  - `workspace`: default `~/.openclaw/workspace-<agentId>` (for `main`, falls back to `agents.defaults.workspace`).
  - `agentDir`: default na `~/.openclaw/agents/<agentId>/agent`.
  - `model`: per-agent default model, overrides `agents.defaults.model` for that agent.
    - string form: `"provider/model"`, overrides only `agents.defaults.model.primary`
    - anyong object: `{ primary, fallbacks }` (ina-override ng fallbacks ang `agents.defaults.model.fallbacks`; ang `[]` ay nagdi-disable ng mga global fallback para sa agent na iyon)
  - `identity`: per-agent na pangalan/tema/emoji (ginagamit para sa mga mention pattern + ack reactions).
  - `groupChat`: per-agent na mention-gating (`mentionPatterns`).
  - `sandbox`: per-agent na sandbox config (ina-override ang `agents.defaults.sandbox`).
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: "none" | "ro" | "rw"
    - `scope`: "session" | "agent" | "shared"
    - `workspaceRoot`: custom na root ng sandbox workspace
    - `docker`: mga override ng docker kada agent (hal. `image`, `network`, `env`, `setupCommand`, limits; hindi pinapansin kapag `scope: "shared"`)
    - `browser`: mga override ng sandboxed browser kada agent (hindi pinapansin kapag `scope: "shared"`)
    - `prune`: mga override ng sandbox pruning kada agent (hindi pinapansin kapag `scope: "shared"`)
  - `subagents`: mga default ng sub-agent kada agent.
    - `allowAgents`: allowlist ng mga agent id para sa `sessions_spawn` mula sa agent na ito (`["*"]` = payagan ang alinman; default: parehong agent lang)
  - `tools`: mga restriksyon ng tool kada agent (ina-apply bago ang sandbox tool policy).
    - `profile`: base tool profile (ina-apply bago ang allow/deny)
    - `allow`: array ng mga pinapayagang pangalan ng tool
    - `deny`: array ng mga ipinagbabawal na pangalan ng tool (panalo ang deny)
- `agents.defaults`: mga shared na default ng agent (model, workspace, sandbox, atbp.).
- `bindings[]`: niruruta ang mga papasok na mensahe papunta sa isang `agentId`.
  - `match.channel` (kinakailangan)
  - `match.accountId` (opsyonal; `*` = anumang account; kapag wala = default na account)
  - `match.peer` (opsyonal; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (opsyonal; partikular sa channel)

Deterministikong pagkakasunud-sunod ng pagtutugma:

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (eksakto, walang peer/guild/team)
5. `match.accountId: "*"` (saklaw ng channel, walang peer/guild/team)
6. default na agent (`agents.list[].default`, kung hindi ay unang entry sa listahan, kung hindi ay `"main"`)

Sa loob ng bawat tier ng pagtutugma, ang unang tumugmang entry sa `bindings` ang mananalo.

#### Per‑agent access profiles (multi‑agent)

Maaaring magdala ang bawat agent ng sarili nitong sandbox + tool policy. Gamitin ito para paghaluin ang mga antas ng access

- sa iisang gateway:
- **Buong access** (personal na agent)
- **Read-only** na mga tool + workspace

**Walang access sa filesystem** (mga tool lang sa messaging/session)

Tingnan ang [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) para sa precedence at
karagdagang mga halimbawa.

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

Buong access (walang sandbox):

```json5
Read-only na mga tool + read-only na workspace:
```

{
agents: {
list: [
{
id: "family",
workspace: "~/.openclaw/workspace-family",
sandbox: {
mode: "all",
scope: "agent",
workspaceAccess: "ro",
},
tools: {
allow: [
"read",
"sessions_list",
"sessions_history",
"sessions_send",
"sessions_spawn",
"session_status",
],
deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
},
},
],
},
}

```json5
Walang access sa filesystem (naka-enable ang mga tool sa messaging/session):
```

{
agents: {
list: [
{
id: "public",
workspace: "~/.openclaw/workspace-public",
sandbox: {
mode: "all",
scope: "agent",
workspaceAccess: "none",
},
tools: {
allow: [
"sessions_list",
"sessions_history",
"sessions_send",
"sessions_spawn",
"session_status",
"whatsapp",
"telegram",
"slack",
"discord",
"gateway",
],
deny: [
"read",
"write",
"edit",
"apply_patch",
"exec",
"process",
"browser",
"canvas",
"nodes",
"cron",
"gateway",
"image",
],
},
},
],
},
}

```json5
Halimbawa: dalawang WhatsApp account → dalawang agent:
```

### {&#xA;agents: {&#xA;list: [&#xA;{ id: "home", default: true, workspace: "~/.openclaw/workspace-home" },&#xA;{ id: "work", workspace: "~/.openclaw/workspace-work" },&#xA;],&#xA;},&#xA;bindings: [&#xA;{ agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },&#xA;{ agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },&#xA;],&#xA;channels: {&#xA;whatsapp: {&#xA;accounts: {&#xA;personal: {},&#xA;biz: {},&#xA;},&#xA;},&#xA;},&#xA;}

Opt-in ang agent-to-agent messaging:

```json5
Ang pagmemensahe sa pagitan ng mga agent ay opt-in:
```

### {&#xA;tools: {&#xA;agentToAgent: {&#xA;enabled: false,&#xA;allow: ["home", "work"],&#xA;},&#xA;},&#xA;}

Kinokontrol kung paano kumikilos ang mga inbound na mensahe kapag may aktibong agent run na.

```json5
Kinokontrol kung paano kumikilos ang mga papasok na mensahe kapag may aktibong run na ang agent.
```

### {&#xA;messages: {&#xA;queue: {&#xA;mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)&#xA;debounceMs: 1000,&#xA;cap: 20,&#xA;drop: "summarize", // old | new | summarize&#xA;byChannel: {&#xA;whatsapp: "collect",&#xA;telegram: "collect",&#xA;discord: "collect",&#xA;imessage: "collect",&#xA;webchat: "collect",&#xA;},&#xA;},&#xA;},&#xA;}

`messages.inbound` Ang debouncing ay naka-scope per channel + pag-uusap
at ginagamit ang pinakahuling mensahe para sa reply threading/IDs.

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Mga tala:

- {
  messages: {
  inbound: {
  debounceMs: 2000, // 0 disables
  byChannel: {
  whatsapp: 5000,
  slack: 1500,
  discord: 1500,
  },
  },
  },
  }
- Control commands (e.g. `/queue`, `/new`) bypass debouncing so they stay standalone.

### `commands` (chat command handling)

Controls how chat commands are enabled across connectors.

```json5
{
  commands: {
    native: "auto", // register native commands when supported (auto)
    text: true, // parse slash commands in chat messages
    bash: false, // allow ! (alias: /bash) (host-only; requires tools.elevated allowlists)
    bashForegroundMs: 2000, // bash foreground window (0 backgrounds immediately)
    config: false, // allow /config (writes to disk)
    debug: false, // allow /debug (runtime-only overrides)
    restart: false, // allow /restart + gateway restart tool
    useAccessGroups: true, // enforce access-group allowlists/policies for commands
  },
}
```

Mga tala:

- Text commands must be sent as a **standalone** message and use the leading `/` (no plain-text aliases).
- `commands.text: false` disables parsing chat messages for commands.
- `commands.native: "auto"` (default) turns on native commands for Discord/Telegram and leaves Slack off; unsupported channels stay text-only.
- Set `commands.native: true|false` to force all, or override per channel with `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool or `"auto"`). `false` clears previously registered commands on Discord/Telegram at startup; Slack commands are managed in the Slack app.
- `channels.telegram.customCommands` adds extra Telegram bot menu entries. Names are normalized; conflicts with native commands are ignored.
- `commands.bash: true` enables `! <cmd>` to run host shell commands (`/bash <cmd>` also works as an alias). Requires `tools.elevated.enabled` and allowlisting the sender in `tools.elevated.allowFrom.<channel>`.
- `commands.bashForegroundMs` controls how long bash waits before backgrounding. While a bash job is running, new `! <cmd>` requests are rejected (one at a time).
- `commands.config: true` enables `/config` (reads/writes `openclaw.json`).
- `channels.<provider>.configWrites` gates config mutations initiated by that channel (default: true). This applies to `/config set|unset` plus provider-specific auto-migrations (Telegram supergroup ID changes, Slack channel ID changes).
- `commands.debug: true` enables `/debug` (runtime-only overrides).
- `commands.restart: true` enables `/restart` and the gateway tool restart action.
- `commands.useAccessGroups: false` allows commands to bypass access-group allowlists/policies.
- Slash commands and directives are only honored for **authorized senders**. Authorization is derived from
  channel allowlists/pairing plus `commands.useAccessGroups`.

### `web` (WhatsApp web channel runtime)

WhatsApp runs through the gateway’s web channel (Baileys Web). It starts automatically when a linked session exists.
Set `web.enabled: false` to keep it off by default.

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

### `channels.telegram` (bot transport)

OpenClaw starts Telegram only when a `channels.telegram` config section exists. The bot token is resolved from `channels.telegram.botToken` (or `channels.telegram.tokenFile`), with `TELEGRAM_BOT_TOKEN` as a fallback for the default account.
Set `channels.telegram.enabled: false` to disable automatic startup.
Multi-account support lives under `channels.telegram.accounts` (see the multi-account section above). Env tokens only apply to the default account.
Set `channels.telegram.configWrites: false` to block Telegram-initiated config writes (including supergroup ID migrations and `/config set|unset`).

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // optional; "open" requires ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50, // include last N group messages as context (0 disables)
      replyToMode: "first", // off | first | all
      linkPreview: true, // toggle outbound link previews
      streamMode: "partial", // off | partial | block (draft streaming; separate from block streaming)
      draftChunk: {
        // optional; only for streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        // transport overrides
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook", // requires webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

Draft streaming notes:

- Uses Telegram `sendMessageDraft` (draft bubble, not a real message).
- Requires **private chat topics** (message_thread_id in DMs; bot has topics enabled).
- `/reasoning stream` ay nag-i-stream ng pangangatwiran sa draft, saka ipinapadala ang pinal na sagot.
  Ang mga default at asal ng retry policy ay nakadokumento sa [Retry policy](/concepts/retry).

### `channels.discord` (bot transport)

Configure the Discord bot by setting the bot token and optional gating:
Multi-account support lives under `channels.discord.accounts` (see the multi-account section above). Env tokens only apply to the default account.

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8, // clamp inbound media size
      allowBots: false, // allow bot-authored messages
      actions: {
        // tool action gates (false disables)
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true, // disable all DMs when false
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])
        groupEnabled: false, // enable group DMs
        groupChannels: ["openclaw-dm"], // optional group DM allowlist
      },
      guilds: {
        "123456789012345678": {
          // guild id (preferred) or slug
          slug: "friends-of-openclaw",
          requireMention: false, // per-guild default
          reactionNotifications: "own", // off | own | all | allowlist
          users: ["987654321098765432"], // optional per-guild user allowlist
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20, // include last N guild messages as context
      textChunkLimit: 2000, // optional outbound text chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      maxLinesPerMessage: 17, // soft max lines per message (Discord UI clipping)
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Sinisimulan ng OpenClaw ang Discord lamang kapag may umiiral na `channels.discord` na seksyon ng config. 1. Ang token ay kinukuha mula sa `channels.discord.token`, na may `DISCORD_BOT_TOKEN` bilang fallback para sa default account (maliban kung `channels.discord.enabled` ay `false`). 2. Gamitin ang `user:<id>` (DM) o `channel:<id>` (guild channel) kapag tinutukoy ang mga delivery target para sa cron/CLI commands; ang mga numeric ID na walang prefix ay hindi malinaw at tinatanggihan.
3. Ang mga guild slug ay lowercase na may mga espasyong pinalitan ng `-`; ang mga channel key ay gumagamit ng slugged na pangalan ng channel (walang leading `#`). Prefer guild ids as keys to avoid rename ambiguity.
5. Ang mga mensaheng gawa ng bot ay binabalewala bilang default. 6. I-enable gamit ang `channels.discord.allowBots` (ang sariling mga mensahe ay sinasala pa rin upang maiwasan ang self-reply loops).
7. Mga mode ng notification para sa reaksyon:

- `off`: walang reaction event.
- `own`: mga reaction sa sariling mensahe ng bot (default).
- `all`: lahat ng reaction sa lahat ng mensahe.
- 8. `allowlist`: mga reaksyon mula sa `guilds.<id>9. .users` sa lahat ng mensahe (ang walang laman na listahan ay nagdi-disable).
  9. Ang outbound na teksto ay hinahati-hati ayon sa `channels.discord.textChunkLimit` (default 2000). Itakda ang `channels.discord.chunkMode="newline"` upang hatiin sa mga blangkong linya (mga hangganan ng talata) bago ang length chunking. Maaaring putulin ng mga Discord client ang napakataas na mensahe, kaya ang `channels.discord.maxLinesPerMessage` (default 17) ay naghahati ng mahahabang multi-line na sagot kahit mas mababa sa 2000 chars.
  10. Ang mga default at pag-uugali ng retry policy ay dokumentado sa [Retry policy](/concepts/retry).

### 14. `channels.googlechat` (Chat API webhook)

Ang Google Chat ay tumatakbo sa pamamagitan ng HTTP webhooks na may app-level auth (service account).
Ang suporta sa multi-account ay nasa ilalim ng `channels.googlechat.accounts` (tingnan ang seksyon ng multi-account sa itaas). 17. Ang mga env var ay nalalapat lamang sa default account.

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; improves mention detection
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // optional; "open" requires ["*"]
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Mga tala:

- Maaaring inline (`serviceAccount`) o naka-file (`serviceAccountFile`) ang Service account JSON.
- Mga env fallback para sa default na account: `GOOGLE_CHAT_SERVICE_ACCOUNT` o `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- 21. Dapat magtugma ang `audienceType` + `audience` sa webhook auth config ng Chat app.
- 22. Gamitin ang `spaces/<spaceId>` o `users/<userId|email>` kapag nagtatakda ng mga delivery target.

### 23. `channels.slack` (socket mode)

24. Ang Slack ay tumatakbo sa Socket Mode at nangangailangan ng parehong bot token at app token:

```json5
25. {
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50, // include last N channel/group messages as context (0 disables)
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

26. Ang suporta sa multi-account ay nasa ilalim ng `channels.slack.accounts` (tingnan ang seksyong multi-account sa itaas). 27. Ang mga env token ay nalalapat lamang sa default account.

28. Sinisimulan ng OpenClaw ang Slack kapag naka-enable ang provider at parehong token ay naka-set (sa pamamagitan ng config o `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Gamitin ang `user:<id>` (DM) o `channel:<id>` kapag tinutukoy ang mga delivery target para sa mga utos ng cron/CLI.
    Itakda ang `channels.slack.configWrites: false` upang harangan ang mga config write na pinasimulan ng Slack (kasama ang mga channel ID migration at `/config set|unset`).

Ang mga mensaheng isinulat ng bot ay hindi pinapansin bilang default. I-enable gamit ang `channels.slack.allowBots` o `channels.slack.channels.<id>.allowBots`

Mga mode ng notification ng reaction:

- `off`: walang reaction event.
- `own`: mga reaction sa sariling mensahe ng bot (default).
- `all`: lahat ng reaction sa lahat ng mensahe.
- 35. `allowlist`: mga reaksyon mula sa `channels.slack.reactionAllowlist` sa lahat ng mensahe (ang walang laman na listahan ay nagdi-disable).

36. Isolation ng thread session:

- Kinokontrol ng `channels.slack.thread.historyScope` kung ang thread history ay per-thread (`thread`, default) o ibinabahagi sa buong channel (`channel`).
- 38. Kinokontrol ng `channels.slack.thread.inheritParent` kung ang mga bagong thread session ay nagmamana ng transcript ng parent channel (default: false).

Mga Slack action group (nagga-gate ng mga aksyon ng `slack` tool):

| Action group | Default | Notes                    |
| ------------ | ------- | ------------------------ |
| reactions    | enabled | React + list reactions   |
| messages     | enabled | Basa/padala/edit/delete  |
| pins         | enabled | Pin/unpin/list           |
| memberInfo   | enabled | Impormasyon ng miyembro  |
| emojiList    | enabled | Listahan ng custom emoji |

### `channels.mattermost` (bot token)

Ang Mattermost ay ipinapadala bilang plugin at hindi kasama sa core install.
I-install muna ito: `openclaw plugins install @openclaw/mattermost` (o `./extensions/mattermost` mula sa isang git checkout).

42. Nangangailangan ang Mattermost ng bot token kasama ang base URL ng iyong server:

```json5
1. {
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

44. Sinisimulan ng OpenClaw ang Mattermost kapag naka-configure ang account (bot token + base URL) at naka-enable. 45. Ang token + base URL ay kinukuha mula sa `channels.mattermost.botToken` + `channels.mattermost.baseUrl` o `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` para sa default account (maliban kung `channels.mattermost.enabled` ay `false`).

46. Mga chat mode:

- 2. `oncall` (default): tumugon sa mga mensahe sa channel lamang kapag na-@mention.
- `onmessage`: tumugon sa bawat mensahe sa channel.
- 3. `onchar`: tumugon kapag ang isang mensahe ay nagsisimula sa trigger prefix (`channels.mattermost.oncharPrefixes`, default `[">", "!"]`).

49. Kontrol sa access:

- 4. Default DMs: `channels.mattermost.dmPolicy="pairing"` (ang mga hindi kilalang nagpadala ay nakakakuha ng pairing code).
- Pampublikong DM: `channels.mattermost.dmPolicy="open"` kasama ang `channels.mattermost.allowFrom=["*"]`.
- Groups: `channels.mattermost.groupPolicy="allowlist"` by default (mention-gated). Use `channels.mattermost.groupAllowFrom` to restrict senders.

Multi-account support lives under `channels.mattermost.accounts` (see the multi-account section above). Env vars only apply to the default account.
Use `channel:<id>` or `user:<id>` (or `@username`) when specifying delivery targets; bare ids are treated as channel ids.

### `channels.signal` (signal-cli)

Signal reactions can emit system events (shared reaction tooling):

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // include last N group messages as context (0 disables)
    },
  },
}
```

Reaction notification modes:

- `off`: walang reaction event.
- `own`: mga reaction sa sariling mensahe ng bot (default).
- `all`: lahat ng reaction sa lahat ng mensahe.
- `allowlist`: reactions from `channels.signal.reactionAllowlist` on all messages (empty list disables).

### `channels.imessage` (imsg CLI)

OpenClaw spawns `imsg rpc` (JSON-RPC over stdio). No daemon or port required.

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host", // SCP for remote attachments when using SSH wrapper
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50, // include last N group messages as context (0 disables)
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

Multi-account support lives under `channels.imessage.accounts` (see the multi-account section above).

Mga tala:

- Requires Full Disk Access to the Messages DB.
- The first send will prompt for Messages automation permission.
- Prefer `chat_id:<id>` targets. Use `imsg chats --limit 20` to list chats.
- `channels.imessage.cliPath` can point to a wrapper script (e.g. `ssh` to another Mac that runs `imsg rpc`); use SSH keys to avoid password prompts.
- For remote SSH wrappers, set `channels.imessage.remoteHost` to fetch attachments via SCP when `includeAttachments` is enabled.

Halimbawang wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

Sets the **single global workspace directory** used by the agent for file operations.

Default: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

If `agents.defaults.sandbox` is enabled, non-main sessions can override this with their
own per-scope workspaces under `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

Optional repository root to show in the system prompt’s Runtime line. If unset, OpenClaw
tries to detect a `.git` directory by walking upward from the workspace (and current
working directory). The path must exist to be used.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

Disables automatic creation of the workspace bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md`).

Use this for pre-seeded deployments where your workspace files come from a repo.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

Max characters of each workspace bootstrap file injected into the system prompt
before truncation. Default: `20000`.

When a file exceeds this limit, OpenClaw logs a warning and injects a truncated
head/tail with a marker.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

Sets the user’s timezone for **system prompt context** (not for timestamps in
message envelopes). If unset, OpenClaw uses the host timezone at runtime.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

Controls the **time format** shown in the system prompt’s Current Date & Time section.
Default: `auto` (OS preference).

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `mga Mensahe`

Controls inbound/outbound prefixes and optional ack reactions.
See [Messages](/concepts/messages) for queueing, sessions, and streaming context.

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` is applied to **all outbound replies** (tool summaries, block
streaming, final replies) across channels unless already present.

Overrides can be configured per channel and per account:

- `channels.<channel>.responsePrefix`
- `channels.<channel>.accounts.<id>.responsePrefix`

Ayos ng resolusyon (pinaka-espesipiko ang nananalo):

1. `channels.<channel>.accounts.<id>.responsePrefix`
2. `channels.<channel>.responsePrefix`
3. `messages.responsePrefix`

Semantics:

- `undefined` falls through to the next level.
- `""` explicitly disables the prefix and stops the cascade.
- `"auto"` derives `[{identity.name}]` for the routed agent.

Overrides apply to all channels, including extensions, and to every outbound reply kind.

If `messages.responsePrefix` is unset, no prefix is applied by default. WhatsApp self-chat
replies are the exception: they default to `[{identity.name}]` when set, otherwise
`[openclaw]`, so same-phone conversations stay legible.
Set it to `"auto"` to derive `[{identity.name}]` for the routed agent (when set).

#### Template variables

The `responsePrefix` string can include template variables that resolve dynamically:

| Variable          | Description            | Example                                    |
| ----------------- | ---------------------- | ------------------------------------------ |
| `{model}`         | Short model name       | `claude-opus-4-6`, `gpt-4o`                |
| `{modelFull}`     | Full model identifier  | `anthropic/claude-opus-4-6`                |
| `{provider}`      | Provider name          | `anthropic`, `openai`                      |
| `{thinkingLevel}` | Current thinking level | `high`, `low`, `off`                       |
| `{identity.name}` | Agent identity name    | (same as `"auto"` mode) |

Variables are case-insensitive (`{MODEL}` = `{model}`). `{think}` is an alias for `{thinkingLevel}`.
Unresolved variables remain as literal text.

```json5
{
  messages: {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

Example output: `[claude-opus-4-6 | think:high] Here's my response...`

WhatsApp inbound prefix is configured via `channels.whatsapp.messagePrefix` (deprecated:
`messages.messagePrefix`). Default stays **unchanged**: `"[openclaw]"` when
`channels.whatsapp.allowFrom` is empty, otherwise `""` (no prefix). When using
`"[openclaw]"`, OpenClaw will instead use `[{identity.name}]` when the routed
agent has `identity.name` set.

`ackReaction` sends a best-effort emoji reaction to acknowledge inbound messages
on channels that support reactions (Slack/Discord/Telegram/Google Chat). Defaults to the
active agent’s `identity.emoji` when set, otherwise `"👀"`. Set it to `""` to disable.

`ackReactionScope` controls when reactions fire:

- `group-mentions` (default): only when a group/room requires mentions **and** the bot was mentioned
- `group-all`: all group/room messages
- `direct`: direct messages only
- `all`: all messages

`removeAckAfterReply` removes the bot’s ack reaction after a reply is sent
(Slack/Discord/Telegram/Google Chat only). Default: `false`.

#### `messages.tts`

I-enable ang text-to-speech para sa mga palabas na sagot. Kapag naka-on, ang OpenClaw ay bumubuo ng audio
gamit ang ElevenLabs o OpenAI at ikinakabit ito sa mga tugon. Gumagamit ang Telegram ng Opus
voice notes; ang ibang mga channel ay nagpapadala ng MP3 audio.

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all (include tool/block replies)
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

Mga tala:

- Kinokontrol ng `messages.tts.auto` ang awtomatikong TTS (`off`, `always`, `inbound`, `tagged`).
- 5. `/tts off|always|inbound|tagged` itinatakda ang per‑session auto mode (ina-override ang config).
- Legacy ang `messages.tts.enabled`; inililipat ito ng doctor sa `messages.tts.auto`.
- Iniimbak ng `prefsPath` ang mga lokal na override (provider/limit/summarize).
- Ang `maxTextLength` ay isang mahigpit na limit para sa TTS input; ang mga buod ay pinuputol upang magkasya.
- Ino-override ng `summaryModel` ang `agents.defaults.model.primary` para sa auto-summary.
  - Tumatanggap ng `provider/model` o isang alias mula sa `agents.defaults.models`.
- Pinapagana ng `modelOverrides` ang mga model-driven override gaya ng mga tag na `[[tts:...]]` (naka-on bilang default).
- Kinokontrol ng `/tts limit` at `/tts summary` ang mga setting ng pagbubuod bawat user.
- Ang mga value ng `apiKey` ay nagfa-fallback sa `ELEVENLABS_API_KEY`/`XI_API_KEY` at `OPENAI_API_KEY`.
- Ina-override ng `elevenlabs.baseUrl` ang base URL ng ElevenLabs API.
- 6. `elevenlabs.voiceSettings` ay sumusuporta sa `stability`/`similarityBoost`/`style` (0..1),
     `useSpeakerBoost`, at `speed` (0.5..2.0).

### `talk`

Mga default para sa Talk mode (macOS/iOS/Android). Ang mga Voice ID ay nagfa-fallback sa `ELEVENLABS_VOICE_ID` o `SAG_VOICE_ID` kapag hindi nakatakda.
7. Ang `apiKey` ay babalik sa `ELEVENLABS_API_KEY` (o sa shell profile ng gateway) kapag hindi nakatakda.
Pinapayagan ng `voiceAliases` ang mga Talk directive na gumamit ng mga madaling tandaan na pangalan (hal. `"voice":"Clawd"`).

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### `agents.defaults`

Kinokontrol ang naka-embed na agent runtime (model/pag-iisip/verbose/timeouts).
Tinutukoy ng `agents.defaults.models` ang naka-configure na katalogo ng modelo (at nagsisilbing allowlist para sa `/model`).
Itinatakda ng `agents.defaults.model.primary` ang default na modelo; ang `agents.defaults.model.fallbacks` ay mga pandaigdigang failover.
Opsyonal ang `agents.defaults.imageModel` at **ginagamit lamang kung ang primary model ay walang image input**.
Ang bawat entry sa `agents.defaults.models` ay maaaring magsama ng:

- `alias` (opsyonal na shortcut ng modelo, hal. `/opus`).
- 8. `params` (opsyonal na provider‑specific API params na ipinapasa diretso sa model request).

Ang `params` ay inilalapat din sa mga streaming run (embedded agent + compaction). Mga sinusuportahang key sa ngayon: `temperature`, `maxTokens`. Pinag-iisa ang mga ito sa mga opsyon sa oras ng tawag; nangingibabaw ang mga value na ibinigay ng tumatawag. Ang `temperature` ay isang advanced na setting—iwanang hindi nakatakda maliban kung alam mo ang mga default ng modelo at kailangan ng pagbabago.

Halimbawa:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5.2": {
          params: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

9. Awtomatikong ina-enable ng mga Z.AI GLM-4.x model ang thinking mode maliban kung ikaw ay:

- 10. magtakda ng `--thinking off`, o
- ikaw mismo ang magtakda ng `agents.defaults.models["zai/<model>"].params.thinking`.

11. Nagpapadala rin ang OpenClaw ng ilang built‑in alias shorthands. 12. Nalalapat lamang ang defaults kapag ang model ay
    nasa `agents.defaults.models` na:

- `opus` -> `anthropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- 13. `gpt` -> `openai/gpt-5.2`
- 14. `gpt-mini` -> `openai/gpt-5-mini`
- 15. `gemini` -> `google/gemini-3-pro-preview`
- 16. `gemini-flash` -> `google/gemini-3-flash-preview`

17. Kung iko-configure mo mismo ang parehong alias name (hindi case‑sensitive), ang halaga mo ang mananaig (hindi kailanman nag-o-override ang defaults).

18. Halimbawa: Opus 4.6 primary na may MiniMax M2.1 fallback (hosted MiniMax):

```json5
19. {
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

20. MiniMax auth: itakda ang `MINIMAX_API_KEY` (env) o i-configure ang `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI fallback)

21. Opsyonal na mga CLI backend para sa text‑only na fallback runs (walang tool calls). 22. Kapaki‑pakinabang ang mga ito bilang
    backup na landas kapag pumalya ang mga API provider. 23. Sinusuportahan ang image pass‑through kapag nag-configure ka ng
    isang `imageArg` na tumatanggap ng mga file path.

Mga tala:

- 24. Ang mga CLI backend ay **text‑first**; palaging naka-disable ang mga tool.
- 25. Sinusuportahan ang mga session kapag nakatakda ang `sessionArg`; ang mga session id ay ipinapersist kada backend.
- 26. Para sa `claude-cli`, naka-wire in ang defaults. 27. I-override ang command path kung minimal ang PATH
      (launchd/systemd).

Halimbawa:

```json5
28. {
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4.7": {
          alias: "GLM",
          params: {
            thinking: {
              type: "enabled",
              clear_thinking: false,
            },
          },
        },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        target: "last",
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        cleanupMs: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### 29. `agents.defaults.contextPruning` (pagpu-prune ng tool-result)

30. Ang `agents.defaults.contextPruning` ay nagpu-prune ng **mga lumang tool result** mula sa in‑memory context bago pa ipadala ang request sa LLM.
    Hindi nito **binabago** ang session history sa disk (`*.jsonl` ay nananatiling kumpleto).

Layunin nitong bawasan ang paggamit ng token para sa mga chatty agent na nag-iipon ng malalaking tool output sa paglipas ng panahon.

High level:

- 31. Hindi kailanman hinahawakan ang mga mensahe ng user/assistant.
- 32. Pinoprotektahan ang huling `keepLastAssistants` na mga mensahe ng assistant (walang mga tool result pagkatapos ng puntong iyon ang pinu-prune).
- 33. Pinoprotektahan ang bootstrap prefix (walang anumang bago ang unang mensahe ng user ang pinu-prune).
- 34. Mga mode:
  - 35. `adaptive`: soft‑trim ng sobrang laki na mga tool result (panatilihin ang simula/dulo) kapag lumampas ang tinatayang context ratio sa `softTrimRatio`.
        Pagkatapos ay hard-clears ang pinakalumang eligible na mga tool result kapag lumampas ang tinatayang context ratio sa `hardClearRatio` **at**
        may sapat na prunable na dami ng tool-result (`minPrunableToolChars`).
  - 36. `aggressive`: palaging pinapalitan ang mga karapat-dapat na tool result bago ang cutoff ng `hardClear.placeholder` (walang ratio checks).

37. Soft vs hard pruning (ano ang nagbabago sa context na ipinapadala sa LLM):

- 38. **Soft‑trim**: para lamang sa _sobrang laki_ na mga tool result. 39. Pinananatili ang simula + dulo at naglalagay ng `...` sa gitna.
  - 40. Bago: `toolResult("…very long output…")`
  - After: `toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")`
- 42. **Hard‑clear**: pinapalitan ang buong tool result ng placeholder.
  - Before: `toolResult("…very long output…")`
  - Pagkatapos: `toolResult("[Old tool result content cleared]")`

44. Mga tala / kasalukuyang limitasyon:

- Ang mga tool result na naglalaman ng **image blocks ay nilalaktawan** (hindi kailanman tine-trim/ni-clear) sa ngayon.
- Ang tinatayang “context ratio” ay nakabatay sa **mga karakter** (approximate), hindi eksaktong mga token.
- Kung ang session ay wala pang kahit `keepLastAssistants` na assistant message, nilalaktawan ang pruning.
- Sa `aggressive` mode, hindi pinapansin ang `hardClear.enabled` (ang mga eligible na tool result ay palaging pinapalitan ng `hardClear.placeholder`).

45. Default (adaptive):

```json5
46. {
  agents: { defaults: { contextPruning: { mode: "adaptive" } } },
}
```

47. Para i-disable:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

48. Defaults (kapag ang `mode` ay `"adaptive"` o `"aggressive"`):

- `keepLastAssistants`: `3`
- 49. `softTrimRatio`: `0.3` (adaptive lamang)
- `hardClearRatio`: `0.5` (adaptive lamang)
- 50. `minPrunableToolChars`: `50000` (adaptive lamang)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (adaptive only)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

Halimbawa (aggressive, minimal):

```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } } },
}
```

Halimbawa (adaptive na naka-tune):

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        // Optional: restrict pruning to specific tools (deny wins; supports "*" wildcards)
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

See [/concepts/session-pruning](/concepts/session-pruning) for behavior details.

#### `agents.defaults.compaction` (nagre-reserba ng headroom + pag-flush ng memory)

`agents.defaults.compaction.mode` pumipili ng estratehiya ng buod para sa compaction. Default ay `default`; itakda ang `safeguard` upang paganahin ang chunked summarization para sa napakahahabang history. Tingnan ang [/concepts/compaction](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor` nagpapatupad ng minimum na halaga ng `reserveTokens`
para sa Pi compaction (default: `20000`). Itakda ito sa `0` upang i-disable ang floor.

`agents.defaults.compaction.memoryFlush` nagpapatakbo ng isang **tahimik** na agentic turn bago ang
auto-compaction, na nag-uutos sa model na mag-imbak ng matitibay na alaala sa disk (hal.
`memory/YYYY-MM-DD.md`). Nati-trigger ito kapag ang pagtatantya ng session token ay tumawid sa isang
soft threshold na mas mababa sa compaction limit.

Mga legacy na default:

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: mga built-in na default na may `NO_REPLY`
- Tandaan: nilalaktawan ang memory flush kapag ang session workspace ay read-only
  (`agents.defaults.sandbox.workspaceAccess: "ro"` o `"none"`).

Halimbawa (na-tune):

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

I-block ang streaming:

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (default ay off).

- Mga channel override: `*.blockStreaming` (at mga variant kada account) upang pilitin ang block streaming na naka-on/off.
  Ang mga non-Telegram na channel ay nangangailangan ng tahasang `*.blockStreaming: true` upang paganahin ang block replies.

- `agents.defaults.blockStreamingBreak`: `"text_end"` o `"message_end"` (default: text_end).

- `agents.defaults.blockStreamingChunk`: soft chunking para sa mga streamed block. Default ay
  800–1200 chars, mas pinipili ang mga break ng talata (`\n\n`), pagkatapos ay mga newline, pagkatapos ay mga pangungusap.
  Halimbawa:

  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```

- `agents.defaults.blockStreamingCoalesce`: pagsamahin ang mga streamed block bago ipadala.
  Default ay `{ idleMs: 1000 }` at minamana ang `minChars` mula sa `blockStreamingChunk`
  na may `maxChars` na nililimitahan sa channel text limit. Signal/Slack/Discord/Google Chat ay default
  sa `minChars: 1500` maliban kung i-override.
  Mga channel override: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`,
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,
  `channels.googlechat.blockStreamingCoalesce`
  (at mga variant kada account).

- `agents.defaults.humanDelay`: random na paghinto sa pagitan ng **block replies** pagkatapos ng una.
  Mga mode: `off` (default), `natural` (800–2500ms), `custom` (gamitin ang `minMs`/`maxMs`).
  Per-agent override: `agents.list[].humanDelay`.
  Halimbawa:

  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } } },
  }
  ```

  See [/concepts/streaming](/concepts/streaming) for behavior + chunking details.

Mga typing indicator:

- `agents.defaults.typingMode`: `"never" | "instant" | "thinking" | "message"`. Default ay
  `instant` para sa mga direct chat / mention at `message` para sa mga group chat na walang mention.
- `session.typingMode`: override kada session para sa mode.
- `agents.defaults.typingIntervalSeconds`: gaano kadalas nire-refresh ang typing signal (default: 6s).
- `session.typingIntervalSeconds`: per-session override for the refresh interval.
  Tingnan ang [/concepts/typing-indicators](/concepts/typing-indicators) para sa mga detalye ng behavior.

`agents.defaults.model.primary` ay dapat itakda bilang `provider/model` (hal. `anthropic/claude-opus-4-6`).
Ang mga alias ay nagmumula sa `agents.defaults.models.*.alias` (hal. `Opus`).
Kung aalisin mo ang provider, kasalukuyang ina-assume ng OpenClaw ang `anthropic` bilang pansamantalang
deprecation fallback.
Ang mga modelong Z.AI ay available bilang `zai/<model>` (hal. `zai/glm-4.7`) at nangangailangan ng
`ZAI_API_KEY` (o legacy na `Z_AI_API_KEY`) sa environment.

`agents.defaults.heartbeat` kino-configure ang mga pana-panahong heartbeat run:

- `every`: duration string (`ms`, `s`, `m`, `h`); default na unit ay minutes. Default:
  `30m`. Itakda ang `0m` upang i-disable.
- `model`: opsyonal na override na model para sa mga heartbeat run (`provider/model`).
- `includeReasoning`: kapag `true`, maghahatid din ang mga heartbeat ng hiwalay na `Reasoning:` na mensahe kapag available (kaparehong anyo ng `/reasoning on`). Default: `false`.
- `session`: opsyonal na session key upang kontrolin kung saang session tatakbo ang heartbeat. Default: `main`.
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp, chat id for Telegram).
- `target`: optional delivery channel (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). Default: `last`.
- `prompt`: opsyonal na override para sa heartbeat body (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Overrides are sent verbatim; include a `Read HEARTBEAT.md` line if you still want the file read.
- `ackMaxChars`: pinakamataas na bilang ng karakter na pinapayagan pagkatapos ng `HEARTBEAT_OK` bago ihatid (default: 300).

Per-agent na heartbeats:

- Itakda ang `agents.list[].heartbeat` upang paganahin o i-override ang mga setting ng heartbeat para sa isang partikular na agent.
- Kung may anumang agent entry na nagde-define ng `heartbeat`, **tanging ang mga agent na iyon** ang magpapatakbo ng heartbeats; ang mga default ay magiging shared baseline para sa mga agent na iyon.

Heartbeats run full agent turns. Mas maiikling interval ay kumokonsumo ng mas maraming token; mag-ingat sa `every`, panatilihing maliit ang `HEARTBEAT.md`, at/o pumili ng mas murang `model`.

`tools.exec` ay nagko-configure ng mga default ng background exec:

- `backgroundMs`: oras bago awtomatikong mag-background (ms, default 10000)
- `timeoutSec`: auto-kill after this runtime (seconds, default 1800)
- `cleanupMs`: how long to keep finished sessions in memory (ms, default 1800000)
- `notifyOnExit`: enqueue a system event + request heartbeat when backgrounded exec exits (default true)
- `applyPatch.enabled`: enable experimental `apply_patch` (OpenAI/OpenAI Codex only; default false)
- `applyPatch.allowModels`: opsyonal na allowlist ng mga model id (hal. `gpt-5.2` o `openai/gpt-5.2`)
  Tandaan: ang `applyPatch` ay nasa ilalim lamang ng `tools.exec`.

`tools.web` ay nagko-configure ng web search + fetch tools:

- `tools.web.search.enabled` (default: true kapag naroroon ang key)
- `tools.web.search.apiKey` (inirerekomenda: itakda sa pamamagitan ng `openclaw configure --section web`, o gamitin ang `BRAVE_API_KEY` env var)
- `tools.web.search.maxResults` (1–10, default 5)
- `tools.web.search.timeoutSeconds` (default 30)
- `tools.web.search.cacheTtlMinutes` (default 15)
- `tools.web.fetch.enabled` (default true)
- `tools.web.fetch.maxChars` (default 50000)
- `tools.web.fetch.maxCharsCap` (default 50000; clamps maxChars from config/tool calls)
- `tools.web.fetch.timeoutSeconds` (default 30)
- `tools.web.fetch.cacheTtlMinutes` (default 15)
- `tools.web.fetch.userAgent` (opsyonal na override)
- `tools.web.fetch.readability` (default true; disable to use basic HTML cleanup only)
- `tools.web.fetch.firecrawl.enabled` (default true when an API key is set)
- `tools.web.fetch.firecrawl.apiKey` (opsyonal; default sa `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (default [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (default true)
- `tools.web.fetch.firecrawl.maxAgeMs` (opsyonal)
- `tools.web.fetch.firecrawl.timeoutSeconds` (opsyonal)

`tools.media` configures inbound media understanding (image/audio/video):

- `tools.media.models`: shared model list (capability-tagged; used after per-cap lists).
- `tools.media.concurrency`: maximum na sabayang capability runs (default 2).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - `enabled`: opt-out switch (default true when models are configured).
  - `prompt`: optional prompt override (image/video append a `maxChars` hint automatically).
  - `maxChars`: max output characters (default 500 for image/video; unset for audio).
  - `maxBytes`: maximum na laki ng media na ipapadala (mga default: image 10MB, audio 20MB, video 50MB).
  - `timeoutSeconds`: timeout ng request (mga default: image 60s, audio 60s, video 120s).
  - `language`: opsyonal na audio hint.
  - `attachments`: attachment policy (`mode`, `maxAttachments`, `prefer`).
  - `scope`: opsyonal na gating (unang tugma ang nananalo) gamit ang `match.channel`, `match.chatType`, o `match.keyPrefix`.
  - `models`: nakaayos na listahan ng mga model entry; ang mga failure o sobrang laking media ay babagsak sa susunod na entry.
- Each `models[]` entry:
  - Provider entry (`type: "provider"` o tinanggal):
    - `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, atbp).
    - `model`: override ng model id (kinakailangan para sa image; default sa `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo` para sa mga audio provider, at `gemini-3-flash-preview` para sa video).
    - `profile` / `preferredProfile`: pagpili ng auth profile.
  - CLI entry (`type: "cli"`):
    - `command`: executable to run.
    - `args`: templated args (supports `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).
  - `capabilities`: optional list (`image`, `audio`, `video`) to gate a shared entry. Defaults when omitted: `openai`/`anthropic`/`minimax` → image, `google` → image+audio+video, `groq` → audio.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` can be overridden per entry.

If no models are configured (or `enabled: false`), understanding is skipped; the model still receives the original attachments.

Provider auth follows the standard model auth order (auth profiles, env vars like `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, or `models.providers.*.apiKey`).

Halimbawa:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` configures sub-agent defaults:

- `model`: default model for spawned sub-agents (string or `{ primary, fallbacks }`). If omitted, sub-agents inherit the caller’s model unless overridden per agent or per call.
- `maxConcurrent`: max concurrent sub-agent runs (default 1)
- `archiveAfterMinutes`: auto-archive sub-agent sessions after N minutes (default 60; set `0` to disable)
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (deny wins)

`tools.profile` sets a **base tool allowlist** before `tools.allow`/`tools.deny`:

- `minimal`: `session_status` lamang
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: walang restriksyon (katulad ng unset)

Per-agent override: `agents.list[].tools.profile`.

Halimbawa (messaging-only bilang default, payagan din ang Slack + Discord tools):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Halimbawa (coding profile, pero i-deny ang exec/process kahit saan):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

`tools.byProvider` lets you **further restrict** tools for specific providers (or a single `provider/model`).
Per-agent override: `agents.list[].tools.byProvider`.

Order: base profile → provider profile → allow/deny policies.
Provider keys accept either `provider` (e.g. `google-antigravity`) or `provider/model`
(e.g. `openai/gpt-5.2`).

Halimbawa (panatilihin ang global coding profile, pero minimal na mga tool para sa Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Example (provider/model-specific allowlist):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

`tools.allow` / `tools.deny` configure a global tool allow/deny policy (deny wins).
Matching is case-insensitive and supports `*` wildcards (`"*"` means all tools).
This is applied even when the Docker sandbox is **off**.

Example (disable browser/canvas everywhere):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

Tool groups (shorthands) work in **global** and **per-agent** tool policies:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: lahat ng built-in na OpenClaw tools (hindi kasama ang provider plugins)

`tools.elevated` controls elevated (host) exec access:

- `enabled`: allow elevated mode (default true)
- `allowFrom`: per-channel allowlists (empty = disabled)
  - `whatsapp`: E.164 numbers
  - `telegram`: chat ids or usernames
  - `discord`: user ids or usernames (falls back to `channels.discord.dm.allowFrom` if omitted)
  - `signal`: E.164 numbers
  - `imessage`: handles/chat ids
  - `webchat`: session ids or usernames

Halimbawa:

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

Per-agent override (further restrict):

```json5
{
  agents: {
    list: [
      {
        id: "family",
        tools: {
          elevated: { enabled: false },
        },
      },
    ],
  },
}
```

Mga tala:

- `tools.elevated` is the global baseline. `agents.list[].tools.elevated` can only further restrict (both must allow).
- `/elevated on|off|ask|full` stores state per session key; inline directives apply to a single message.
- Elevated `exec` runs on the host and bypasses sandboxing.
- Tool policy still applies; if `exec` is denied, elevated cannot be used.

`agents.defaults.maxConcurrent` sets the maximum number of embedded agent runs that can
execute in parallel across sessions. Each session is still serialized (one run
per session key at a time). Default: 1.

### `agents.defaults.sandbox`

Optional **Docker sandboxing** for the embedded agent. Intended for non-main
sessions so they cannot access your host system.

Details: [Sandboxing](/gateway/sandboxing)

Defaults (if enabled):

- scope: `"agent"` (one container + workspace per agent)
- Debian bookworm-slim based image
- agent workspace access: `workspaceAccess: "none"` (default)
  - `"none"`: use a per-scope sandbox workspace under `~/.openclaw/sandboxes`
- `"ro"`: keep the sandbox workspace at `/workspace`, and mount the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`)
  - `"rw"`: mount the agent workspace read/write at `/workspace`
- auto-prune: idle > 24h O edad > 7d
- tool policy: allow only `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (deny wins)
  - configure via `tools.sandbox.tools`, override per-agent via `agents.list[].tools.sandbox.tools`
  - tool group shorthands supported in sandbox policy: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- optional sandboxed browser (Chromium + CDP, noVNC observer)
- hardening knobs: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

Warning: `scope: "shared"` means a shared container and shared workspace. No
cross-session isolation. Use `scope: "session"` for per-session isolation.

Legacy: `perSession` is still supported (`true` → `scope: "session"`,
`false` → `scope: "shared"`).

`setupCommand` runs **once** after the container is created (inside the container via `sh -lc`).
For package installs, ensure network egress, a writable root FS, and a root user.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Build the default sandbox image once with:

```bash
scripts/sandbox-setup.sh
```

Note: sandbox containers default to `network: "none"`; set `agents.defaults.sandbox.docker.network`
to `"bridge"` (or your custom network) if the agent needs outbound access.

Note: inbound attachments are staged into the active workspace at `media/inbound/*`. With `workspaceAccess: "rw"`, that means files are written into the agent workspace.

Note: `docker.binds` mounts additional host directories; global and per-agent binds are merged.

Build the optional browser image with:

```bash
scripts/sandbox-browser-setup.sh
```

When `agents.defaults.sandbox.browser.enabled=true`, the browser tool uses a sandboxed
Chromium instance (CDP). If noVNC is enabled (default when headless=false),
the noVNC URL is injected into the system prompt so the agent can reference it.
This does not require `browser.enabled` in the main config; the sandbox control
URL is injected per session.

`agents.defaults.sandbox.browser.allowHostControl` (default: false) allows
sandboxed sessions to explicitly target the **host** browser control server
via the browser tool (`target: "host"`). Leave this off if you want strict
sandbox isolation.

Allowlists for remote control:

- `allowedControlUrls`: exact control URLs permitted for `target: "custom"`.
- `allowedControlHosts`: hostnames permitted (hostname only, no port).
- `allowedControlPorts`: ports permitted (defaults: http=80, https=443).
  Defaults: all allowlists are unset (no restriction). `allowHostControl` defaults to false.

### `models` (custom providers + base URLs)

OpenClaw uses the **pi-coding-agent** model catalog. You can add custom providers
(LiteLLM, local OpenAI-compatible servers, Anthropic proxies, etc.) by writing
`~/.openclaw/agents/<agentId>/agent/models.json` or by defining the same schema inside your
OpenClaw config under `models.providers`.
Provider-by-provider overview + examples: [/concepts/model-providers](/concepts/model-providers).

When `models.providers` is present, OpenClaw writes/merges a `models.json` into
`~/.openclaw/agents/<agentId>/agent/` on startup:

- default behavior: **merge** (keeps existing providers, overrides on name)
- set `models.mode: "replace"` to overwrite the file contents

Select the model via `agents.defaults.model.primary` (provider/model).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3.1-8b" },
      models: {
        "custom-proxy/llama-3.1-8b": {},
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

### OpenCode Zen (multi-model proxy)

OpenCode Zen is a multi-model gateway with per-model endpoints. OpenClaw uses
the built-in `opencode` provider from pi-ai; set `OPENCODE_API_KEY` (or
`OPENCODE_ZEN_API_KEY`) from [https://opencode.ai/auth](https://opencode.ai/auth).

Mga tala:

- Model refs use `opencode/<modelId>` (example: `opencode/claude-opus-4-6`).
- Kung mag-e-enable ka ng allowlist sa pamamagitan ng `agents.defaults.models`, idagdag ang bawat modelong balak mong gamitin.
- Shortcut: `openclaw onboard --auth-choice opencode-zen`.

````json5
```
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```
````

### Z.AI (GLM-4.7) — provider alias support

Z.AI models are available via the built-in `zai` provider. Set `ZAI_API_KEY`
in your environment and reference the model by provider/model.

Shortcut: `openclaw onboard --auth-choice zai-api-key`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

Mga tala:

- `z.ai/*` and `z-ai/*` are accepted aliases and normalize to `zai/*`.
- If `ZAI_API_KEY` is missing, requests to `zai/*` will fail with an auth error at runtime.
- Example error: `No API key found for provider "zai".`
- Z.AI’s general API endpoint is `https://api.z.ai/api/paas/v4`. GLM coding
  requests use the dedicated Coding endpoint `https://api.z.ai/api/coding/paas/v4`.
  Ginagamit ng built-in na `zai` provider ang Coding endpoint. Kung kailangan mo ang pangkalahatang
  endpoint, mag-define ng custom provider sa `models.providers` na may base URL
  override (tingnan ang seksyon ng custom providers sa itaas).
- Gumamit ng pekeng placeholder sa mga docs/config; huwag kailanman mag-commit ng totoong API keys.

### Moonshot AI (Kimi)

Use Moonshot's OpenAI-compatible endpoint:

````json5
```
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```
````

Mga tala:

- Set `MOONSHOT_API_KEY` in the environment or use `openclaw onboard --auth-choice moonshot-api-key`.
- Model ref: `moonshot/kimi-k2.5`.
- Para sa China endpoint, alinman sa:
  - Run `openclaw onboard --auth-choice moonshot-api-key-cn` (wizard will set `https://api.moonshot.cn/v1`), or
  - Manually set `baseUrl: "https://api.moonshot.cn/v1"` in `models.providers.moonshot`.

### Kimi Coding

Use Moonshot AI's Kimi Coding endpoint (Anthropic-compatible, built-in provider):

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

Mga tala:

- Itakda ang `KIMI_API_KEY` sa environment o gamitin ang `openclaw onboard --auth-choice kimi-code-api-key`.
- Model ref: `kimi-coding/k2p5`.

### Synthetic (Anthropic-compatible)

Gamitin ang Anthropic-compatible endpoint ng Synthetic:

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Mga tala:

- Set `SYNTHETIC_API_KEY` or use `openclaw onboard --auth-choice synthetic-api-key`.
- Model ref: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`.
- Dapat alisin sa base URL ang `/v1` dahil idinadagdag ito ng Anthropic client.

### Mga lokal na modelo (LM Studio) — inirerekomendang setup

Tingnan ang [/gateway/local-models](/gateway/local-models) para sa kasalukuyang lokal na gabay. TL;DR: patakbuhin ang MiniMax M2.1 sa pamamagitan ng LM Studio Responses API sa seryosong hardware; panatilihing pinagsama ang mga hosted model para sa fallback.

### MiniMax M2.1

Gamitin ang MiniMax M2.1 nang direkta nang walang LM Studio:

````json5
```
{
  agent: {
    model: { primary: "minimax/MiniMax-M2.1" },
    models: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2.1": { alias: "Minimax" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            // Pricing: update in models.json if you need exact cost tracking.
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```
````

Mga tala:

- Itakda ang environment variable na `MINIMAX_API_KEY` o gamitin ang `openclaw onboard --auth-choice minimax-api`.
- Available na modelo: `MiniMax-M2.1` (default).
- I-update ang pagpepresyo sa `models.json` kung kailangan mo ng eksaktong pagsubaybay ng gastos.

### Cerebras (GLM 4.6 / 4.7)

Gamitin ang Cerebras sa pamamagitan ng kanilang OpenAI-compatible endpoint:

````json5
```
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```
````

Mga tala:

- Gamitin ang `cerebras/zai-glm-4.7` para sa Cerebras; gamitin ang `zai/glm-4.7` para sa direktang Z.AI.
- Itakda ang `CEREBRAS_API_KEY` sa environment o config.

Mga tala:

- Mga suportadong API: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`
- Gamitin ang `authHeader: true` + `headers` para sa mga custom na pangangailangan sa auth.
- I-override ang agent config root gamit ang `OPENCLAW_AGENT_DIR` (o `PI_CODING_AGENT_DIR`)
  kung gusto mong maimbak ang `models.json` sa ibang lokasyon (default: `~/.openclaw/agents/main/agent`).

### `session`

Kinokontrol ang session scoping, reset policy, reset triggers, at kung saan isinusulat ang session store.

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // Default is already per-agent under ~/.openclaw/agents/<agentId>/sessions/sessions.json
    // You can override with {agentId} templating:
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    // Direct chats collapse to agent:<agentId>:<mainKey> (default: "main").
    mainKey: "main",
    agentToAgent: {
      // Max ping-pong reply turns between requester/target (0–5).
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

Mga field:

- `mainKey`: susi ng bucket para sa direct chat (default: `"main"`). Kapaki-pakinabang kapag gusto mong “palitan ang pangalan” ng pangunahing DM thread nang hindi binabago ang `agentId`.
  - Sandbox note: `agents.defaults.sandbox.mode: "non-main"` ay gumagamit ng key na ito para tukuyin ang pangunahing session. Anumang session key na hindi tumutugma sa `mainKey` (mga group/channel) ay naka-sandbox.
- `dmScope`: kung paano pinapangkat ang mga DM session (default: `"main"`).
  - `main`: lahat ng DM ay nagbabahagi ng pangunahing session para sa tuloy-tuloy na konteksto.
  - `per-peer`: ihiwalay ang mga DM ayon sa sender id sa iba’t ibang channel.
  - `per-channel-peer`: ihiwalay ang mga DM ayon sa channel + sender (inirerekomenda para sa mga multi-user inbox).
  - `per-account-channel-peer`: ihiwalay ang mga DM ayon sa account + channel + sender (inirerekomenda para sa mga multi-account inbox).
  - Secure DM mode (inirerekomenda): itakda ang `session.dmScope: "per-channel-peer"` kapag maraming tao ang maaaring mag-DM sa bot (mga shared inbox, multi-person allowlists, o `dmPolicy: "open"`).
- `identityLinks`: imapa ang mga canonical id sa mga peer na may provider prefix upang ang iisang tao ay magbahagi ng iisang DM session sa iba’t ibang channel kapag gumagamit ng `per-peer`, `per-channel-peer`, o `per-account-channel-peer`.
  - Halimbawa: `alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `reset`: pangunahing patakaran sa pag-reset. Default sa araw-araw na reset tuwing 4:00 AM lokal na oras sa gateway host.
  - `mode`: `daily` o `idle` (default: `daily` kapag may `reset`).
  - `atHour`: lokal na oras (0–23) para sa hangganan ng araw-araw na reset.
  - `idleMinutes`: sliding idle window sa minuto. Kapag parehong naka-configure ang daily + idle, kung alin ang unang mag-expire ang masusunod.
- `resetByType`: mga override kada session para sa `dm`, `group`, at `thread`.
  - Kung itatakda mo lamang ang legacy `session.idleMinutes` nang walang anumang `reset`/`resetByType`, mananatili ang OpenClaw sa idle-only mode para sa backward compatibility.
- `heartbeatIdleMinutes`: opsyonal na idle override para sa heartbeat checks (nalalapat pa rin ang daily reset kapag naka-enable).
- `agentToAgent.maxPingPongTurns`: pinakamataas na bilang ng reply-back turns sa pagitan ng requester/target (0–5, default 5).
- `sendPolicy.default`: `allow` o `deny` na fallback kapag walang tumugmang rule.
- `sendPolicy.rules[]`: pagtutugma ayon sa `channel`, `chatType` (`direct|group|room`), o `keyPrefix` (hal. `cron:`). Unang `deny` ang mananaig; kung wala, `allow`.

### `skills` (config ng skills)

Kinokontrol ang bundled allowlist, mga preference sa pag-install, dagdag na skill folders, at mga per-skill override. Nalalapat sa **bundled** skills at `~/.openclaw/skills` (nananaig pa rin ang workspace skills kapag may banggaan ng pangalan).

Mga field:

- `allowBundled`: opsyonal na allowlist para lamang sa **bundled** na skills. Kapag itinakda, ang mga nakalistang bundled skills lang ang maaaring gamitin (hindi apektado ang managed/workspace skills).
- `load.extraDirs`: karagdagang mga directory ng skill na i-scan (pinakamababang precedence).
- `install.preferBrew`: unahin ang mga brew installer kapag available (default: true).
- `install.nodeManager`: preference sa node installer (`npm` | `pnpm` | `yarn`, default: npm).
- \`entries.<skillKey>\`\`: mga override ng config kada skill.

Mga field kada-skill:

- `enabled`: itakda ang `false` para i-disable ang isang skill kahit bundled/installed ito.
- `env`: mga environment variable na ini-inject para sa agent run (kung hindi pa naka-set).
- `apiKey`: opsyonal na kaginhawaan para sa mga skill na nagdedeklara ng pangunahing env var (hal. `nano-banana-pro` → `GEMINI_API_KEY`).

Halimbawa:

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm",
    },
    entries: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

### `plugins` (mga extension)

Kinokontrol ang plugin discovery, allow/deny, at per-plugin config. Ine-load ang mga plugin
mula sa `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, pati na rin ang anumang
`plugins.load.paths` na entry. **Nangangailangan ng gateway restart ang mga pagbabago sa config.**
Tingnan ang [/plugin](/tools/plugin) para sa buong paggamit.

Mga field:

- `enabled`: pangunahing toggle para sa pag-load ng plugin (default: true).
- `allow`: opsyonal na allowlist ng mga plugin id; kapag nakatakda, tanging ang mga nakalista lang ang ilo-load.
- `deny`: opsyonal na denylist ng mga plugin id (mas nangingibabaw ang deny).
- `load.paths`: dagdag na mga plugin file o direktoryo na ilo-load (absolute o `~`).
- \`entries.<pluginId>\`\`: mga override kada plugin.
  - `enabled`: itakda sa `false` upang i-disable.
  - `config`: plugin-specific na config object (bine-validate ng plugin kung ibinigay).

Halimbawa:

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    load: {
      paths: ["~/Projects/oss/voice-call-extension"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser` (browser na pinamamahalaan ng openclaw)

Maaaring magsimula ang OpenClaw ng isang **dedikado, hiwalay** na Chrome/Brave/Edge/Chromium instance para sa openclaw at magbukas ng maliit na loopback control service.
Maaaring tumuro ang mga profile sa isang **remote** na Chromium-based browser sa pamamagitan ng `profiles.<name>`.cdpUrl\`. Remote
profiles are attach-only (start/stop/reset are disabled).

Nanatili ang `browser.cdpUrl` para sa mga legacy single-profile config at bilang base scheme/host para sa mga profile na `cdpPort` lang ang itinakda.

Mga default:

- enabled: `true`
- evaluateEnabled: `true` (itakda sa `false` para i-disable ang `act:evaluate` at `wait --fn`)
- control service: loopback lamang (port na nagmumula sa `gateway.port`, default `18791`)
- CDP URL: `http://127.0.0.1:18792` (control service + 1, legacy single-profile)
- kulay ng profile: `#FF4500` (lobster-orange)
- Tandaan: sinisimulan ang control server ng tumatakbong gateway (OpenClaw.app menubar, o `openclaw gateway`).
- Auto-detect na pagkakasunod-sunod: default browser kung Chromium-based; kung hindi, Chrome → Brave → Edge → Chromium → Chrome Canary.

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    defaultProfile: "chrome",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // Advanced:
    // headless: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false, // set true when tunneling a remote CDP to localhost
  },
}
```

### `ui` (Itsura)

Opsyonal na accent color na ginagamit ng mga native app para sa UI chrome (hal. Talk Mode bubble tint).

Kapag hindi nakatakda, babalik ang mga kliyente sa isang muted na light-blue.

```json5
{
  ui: {
    seamColor: "#FF4500", // hex (RRGGBB or #RRGGBB)
    // Optional: Control UI assistant identity override.
    // If unset, the Control UI uses the active agent identity (config or IDENTITY.md).
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // emoji, short text, or image URL/data URI
    },
  },
}
```

### `gateway` (Gateway server mode + bind)

Use `gateway.mode` to explicitly declare whether this machine should run the Gateway.

Mga default:

- mode: **hindi nakatakda** (itinuturing bilang “huwag awtomatikong magsimula”)
- bind: `loopback`
- port: `18789` (iisang port para sa WS + HTTP)

```json5
{
  gateway: {
    mode: "local", // or "remote"
    port: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // controlUi: { enabled: true, basePath: "/openclaw" }
    // auth: { mode: "token", token: "your-token" } // token gates WS + Control UI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  },
}
```

Control UI base path:

- `gateway.controlUi.basePath` sets the URL prefix where the Control UI is served.
- Examples: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- Default: root (`/`) (unchanged).
- `gateway.controlUi.root` sets the filesystem root for Control UI assets (default: `dist/control-ui`).
- `gateway.controlUi.allowInsecureAuth` allows token-only auth for the Control UI when
  device identity is omitted (typically over HTTP). Default: `false`. Prefer HTTPS
  (Tailscale Serve) or `127.0.0.1`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` disables device identity checks for the
  Control UI (token/password only). Default: `false`. Break-glass only.

Kaugnay na docs:

- [Control UI](/web/control-ui)
- [Web overview](/web)
- [Tailscale](/gateway/tailscale)
- [Remote access](/gateway/remote)

Mga pinagkakatiwalaang proxy:

- `gateway.trustedProxies`: list of reverse proxy IPs that terminate TLS in front of the Gateway.
- When a connection comes from one of these IPs, OpenClaw uses `x-forwarded-for` (or `x-real-ip`) to determine the client IP for local pairing checks and HTTP auth/local checks.
- Only list proxies you fully control, and ensure they **overwrite** incoming `x-forwarded-for`.

Mga tala:

- `openclaw gateway` refuses to start unless `gateway.mode` is set to `local` (or you pass the override flag).
- `gateway.port` controls the single multiplexed port used for WebSocket + HTTP (control UI, hooks, A2UI).
- OpenAI Chat Completions endpoint: **disabled by default**; enable with `gateway.http.endpoints.chatCompletions.enabled: true`.
- Precedence: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > default `18789`.
- Gateway auth is required by default (token/password or Tailscale Serve identity). Non-loopback binds require a shared token/password.
- The onboarding wizard generates a gateway token by default (even on loopback).
- `gateway.remote.token` is **only** for remote CLI calls; it does not enable local gateway auth. `gateway.token` is ignored.

Auth and Tailscale:

- `gateway.auth.mode` sets the handshake requirements (`token` or `password`). When unset, token auth is assumed.
- `gateway.auth.token` stores the shared token for token auth (used by the CLI on the same machine).
- When `gateway.auth.mode` is set, only that method is accepted (plus optional Tailscale headers).
- `gateway.auth.password` can be set here, or via `OPENCLAW_GATEWAY_PASSWORD` (recommended).
- `gateway.auth.allowTailscale` allows Tailscale Serve identity headers
  (`tailscale-user-login`) to satisfy auth when the request arrives on loopback
  with `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host`. OpenClaw
  verifies the identity by resolving the `x-forwarded-for` address via
  `tailscale whois` before accepting it. When `true`, Serve requests do not need
  a token/password; set `false` to require explicit credentials. Defaults to
  `true` when `tailscale.mode = "serve"` and auth mode is not `password`.
- `gateway.tailscale.mode: "serve"` uses Tailscale Serve (tailnet only, loopback bind).
- `gateway.tailscale.mode: "funnel"` exposes the dashboard publicly; requires auth.
- `gateway.tailscale.resetOnExit` resets Serve/Funnel config on shutdown.

Remote client defaults (CLI):

- `gateway.remote.url` sets the default Gateway WebSocket URL for CLI calls when `gateway.mode = "remote"`.
- `gateway.remote.transport` selects the macOS remote transport (`ssh` default, `direct` for ws/wss). When `direct`, `gateway.remote.url` must be `ws://` or `wss://`. `ws://host` defaults to port `18789`.
- `gateway.remote.token` supplies the token for remote calls (leave unset for no auth).
- `gateway.remote.password` supplies the password for remote calls (leave unset for no auth).

macOS app behavior:

- OpenClaw.app watches `~/.openclaw/openclaw.json` and switches modes live when `gateway.mode` or `gateway.remote.url` changes.
- If `gateway.mode` is unset but `gateway.remote.url` is set, the macOS app treats it as remote mode.
- When you change connection mode in the macOS app, it writes `gateway.mode` (and `gateway.remote.url` + `gateway.remote.transport` in remote mode) back to the config file.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Direct transport example (macOS app):

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "your-token",
    },
  },
}
```

### `gateway.reload` (Config hot reload)

The Gateway watches `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`) and applies changes automatically.

Mga Mode:

- `hybrid` (default): hot-apply safe changes; restart the Gateway for critical changes.
- `hot`: only apply hot-safe changes; log when a restart is required.
- `restart`: restart the Gateway on any config change.
- `off`: disable hot reload.

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300,
    },
  },
}
```

#### Hot reload matrix (files + impact)

Files watched:

- `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH`)

Hot-applied (no full gateway restart):

- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (Gmail watcher restarted)
- `browser` (browser control server restart)
- `cron` (cron service restart + concurrency update)
- `agents.defaults.heartbeat` (heartbeat runner restart)
- `web` (WhatsApp web channel restart)
- `telegram`, `discord`, `signal`, `imessage` (channel restarts)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard` (dynamic reads)

Requires full Gateway restart:

- `gateway` (port/bind/auth/control UI/tailscale)
- `bridge` (legacy)
- `discovery`
- `canvasHost`
- `mga Plugin`
- Any unknown/unsupported config path (defaults to restart for safety)

### Multi-instance isolation

To run multiple gateways on one host (for redundancy or a rescue bot), isolate per-instance state + config and use unique ports:

- `OPENCLAW_CONFIG_PATH` (per-instance config)
- `OPENCLAW_STATE_DIR` (sessions/creds)
- `agents.defaults.workspace` (memories)
- `gateway.port` (unique per instance)

Convenience flags (CLI):

- `openclaw --dev …` → uses `~/.openclaw-dev` + shifts ports from base `19001`
- `openclaw --profile <name> …` → uses `~/.openclaw-<name>` (port via config/env/flags)

See [Gateway runbook](/gateway) for the derived port mapping (gateway/browser/canvas).
See [Multiple gateways](/gateway/multiple-gateways) for browser/CDP port isolation details.

Halimbawa:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

### `hooks` (Gateway webhooks)

Enable a simple HTTP webhook endpoint on the Gateway HTTP server.

Mga default:

- enabled: `false`
- path: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  },
}
```

Requests must include the hook token:

- `Authorization: Bearer <token>` **or**
- `x-openclaw-token: <token>`

Endpoints:

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
- `POST /hooks/<name>` → resolved via `hooks.mappings`

`/hooks/agent` always posts a summary into the main session (and can optionally trigger an immediate heartbeat via `wakeMode: "now"`).

Mapping notes:

- `match.path` matches the sub-path after `/hooks` (e.g. `/hooks/gmail` → `gmail`).
- `match.source` matches a payload field (e.g. `{ source: "gmail" }`) so you can use a generic `/hooks/ingest` path.
- Templates like `{{messages[0].subject}}` read from the payload.
- `transform` can point to a JS/TS module that returns a hook action.
- `deliver: true` sends the final reply to a channel; `channel` defaults to `last` (falls back to WhatsApp).
- If there is no prior delivery route, set `channel` + `to` explicitly (required for Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams).
- `model` overrides the LLM for this hook run (`provider/model` or alias; must be allowed if `agents.defaults.models` is set).

Gmail helper config (used by `openclaw webhooks gmail setup` / `run`):

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // Optional: use a cheaper model for Gmail hook processing
      // Falls back to agents.defaults.model.fallbacks, then primary, on auth/rate-limit/timeout
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      // Optional: default thinking level for Gmail hooks
      thinking: "off",
    },
  },
}
```

Model override for Gmail hooks:

- `hooks.gmail.model` specifies a model to use for Gmail hook processing (defaults to session primary).
- Accepts `provider/model` refs or aliases from `agents.defaults.models`.
- Falls back to `agents.defaults.model.fallbacks`, then `agents.defaults.model.primary`, on auth/rate-limit/timeouts.
- If `agents.defaults.models` is set, include the hooks model in the allowlist.
- At startup, warns if the configured model is not in the model catalog or allowlist.
- `hooks.gmail.thinking` sets the default thinking level for Gmail hooks and is overridden by per-hook `thinking`.

Gateway auto-start:

- If `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts
  `gog gmail watch serve` on boot and auto-renews the watch.
- Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to disable the auto-start (for manual runs).
- Avoid running a separate `gog gmail watch serve` alongside the Gateway; it will
  fail with `listen tcp 127.0.0.1:8788: bind: address already in use`.

Note: when `tailscale.mode` is on, OpenClaw defaults `serve.path` to `/` so
Tailscale can proxy `/gmail-pubsub` correctly (it strips the set-path prefix).
If you need the backend to receive the prefixed path, set
`hooks.gmail.tailscale.target` to a full URL (and align `serve.path`).

### `canvasHost` (LAN/tailnet Canvas file server + live reload)

The Gateway serves a directory of HTML/CSS/JS over HTTP so iOS/Android nodes can simply `canvas.navigate` to it.

Default root: `~/.openclaw/workspace/canvas`  
Default port: `18793` (chosen to avoid the openclaw browser CDP port `18792`)  
The server listens on the **gateway bind host** (LAN or Tailnet) so nodes can reach it.

The server:

- serves files under `canvasHost.root`
- injects a tiny live-reload client into served HTML
- watches the directory and broadcasts reloads over a WebSocket endpoint at `/__openclaw__/ws`
- auto-creates a starter `index.html` when the directory is empty (so you see something immediately)
- also serves A2UI at `/__openclaw__/a2ui/` and is advertised to nodes as `canvasHostUrl`
  (always used by nodes for Canvas/A2UI)

Disable live reload (and file watching) if the directory is large or you hit `EMFILE`:

- config: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

Changes to `canvasHost.*` require a gateway restart (config reload will restart).

I-disable gamit ang:

- config: `canvasHost: { enabled: false }`
- env: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge` (legacy TCP bridge, removed)

Current builds no longer include the TCP bridge listener; `bridge.*` config keys are ignored.
Nodes connect over the Gateway WebSocket. This section is kept for historical reference.

Legacy behavior:

- The Gateway could expose a simple TCP bridge for nodes (iOS/Android), typically on port `18790`.

Mga default:

- enabled: `true`
- port: `18790`
- bind: `lan` (binds to `0.0.0.0`)

Bind modes:

- `lan`: `0.0.0.0` (reachable on any interface, including LAN/Wi‑Fi and Tailscale)
- `tailnet`: bind only to the machine’s Tailscale IP (recommended for Vienna ⇄ London)
- `loopback`: `127.0.0.1` (local only)
- `auto`: prefer tailnet IP if present, else `lan`

TLS:

- `bridge.tls.enabled`: enable TLS for bridge connections (TLS-only when enabled).
- `bridge.tls.autoGenerate`: generate a self-signed cert when no cert/key are present (default: true).
- `bridge.tls.certPath` / `bridge.tls.keyPath`: PEM paths for the bridge certificate + private key.
- `bridge.tls.caPath`: optional PEM CA bundle (custom roots or future mTLS).

When TLS is enabled, the Gateway advertises `bridgeTls=1` and `bridgeTlsSha256` in discovery TXT
records so nodes can pin the certificate. Manual connections use trust-on-first-use if no
fingerprint is stored yet.
Auto-generated certs require `openssl` on PATH; if generation fails, the bridge will not start.

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet",
    tls: {
      enabled: true,
      // Uses ~/.openclaw/bridge/tls/bridge-{cert,key}.pem when omitted.
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/.openclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns` (Bonjour / mDNS broadcast mode)

Controls LAN mDNS discovery broadcasts (`_openclaw-gw._tcp`).

- `minimal` (default): omit `cliPath` + `sshPort` from TXT records
- `full`: include `cliPath` + `sshPort` in TXT records
- `off`: disable mDNS broadcasts entirely
- Hostname: defaults to `openclaw` (advertises `openclaw.local`). Override with `OPENCLAW_MDNS_HOSTNAME`.

```json5
{
  discovery: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS‑SD)

When enabled, the Gateway writes a unicast DNS-SD zone for `_openclaw-gw._tcp` under `~/.openclaw/dns/` using the configured discovery domain (example: `openclaw.internal.`).

To make iOS/Android discover across networks (Vienna ⇄ London), pair this with:

- a DNS server on the gateway host serving your chosen domain (CoreDNS is recommended)
- Tailscale **split DNS** so clients resolve that domain via the gateway DNS server

One-time setup helper (gateway host):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## Media model template variables

Ang mga template placeholder ay pinalalawak sa `tools.media.*.models[].args` at `tools.media.models[].args` (at anumang mga susunod na templated argument fields).

\| Variable           | Description                                                                     |
\| ------------------ | ------------------------------------------------------------------------------- | -------- | ------- | ---------- | ----- | ------ | -------- | ------- | ------- | --- |
\| `{{Body}}`         | Full inbound message body                                                       |
\| `{{RawBody}}`      | Raw inbound message body (no history/sender wrappers; best for command parsing) |
\| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents)                     |
\| `{{From}}`         | Sender identifier (E.164 for WhatsApp; may differ per channel)                  |
\| `{{To}}`           | Destination identifier                                                          |
\| `{{MessageSid}}`   | Channel message id (when available)                                             |
\| `{{SessionId}}`    | Current session UUID                                                            |
\| `{{IsNewSession}}` | `"true"` when a new session was created                                         |
\| `{{MediaUrl}}`     | Inbound media pseudo-URL (if present)                                           |
\| `{{MediaPath}}`    | Local media path (if downloaded)                                                |
\| `{{MediaType}}`    | Media type (image/audio/document/…)                                             |
\| `{{Transcript}}`   | Audio transcript (when enabled)                                                 |
\| `{{Prompt}}`       | Resolved media prompt for CLI entries                                           |
\| `{{MaxChars}}`     | Resolved max output chars for CLI entries                                       |
\| `{{ChatType}}`     | `"direct"` or `"group"`                                                         |
\| `{{GroupSubject}}` | Group subject (best effort)                                                     |
\| `{{GroupMembers}}` | Group members preview (best effort)                                             |
\| `{{SenderName}}`   | Sender display name (best effort)                                               |
\| `{{SenderE164}}`   | Sender phone number (best effort)                                               |
\| `{{Provider}}`     | Provider hint (whatsapp                                                         | telegram | discord | googlechat | slack | signal | imessage | msteams | webchat | …)  |

## Cron (Gateway scheduler)

Cron is a Gateway-owned scheduler for wakeups and scheduled jobs. See [Cron jobs](/automation/cron-jobs) for the feature overview and CLI examples.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_Next: [Agent Runtime](/concepts/agent)_ 🦞

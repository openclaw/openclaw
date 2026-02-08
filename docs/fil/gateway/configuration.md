---
summary: "Lahat ng opsyon sa configuration para sa ~/.openclaw/openclaw.json na may mga halimbawa"
read_when:
  - Pagdaragdag o pagbabago ng mga field ng config
title: "Konpigurasyon"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:19Z
---

# Konpigurasyon 🔧

Binabasa ng OpenClaw ang opsyonal na **JSON5** config mula sa `~/.openclaw/openclaw.json` (pinapayagan ang mga komento + trailing commas).

Kung wala ang file, gumagamit ang OpenClaw ng mga ligtas‑na‑default (embedded Pi agent + per‑sender sessions + workspace `~/.openclaw/workspace`). Karaniwan, kailangan mo lang ng config para:

- limitahan kung sino ang puwedeng mag‑trigger ng bot (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, atbp.)
- kontrolin ang mga group allowlist + asal ng pag‑mention (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- i‑customize ang mga prefix ng mensahe (`messages`)
- itakda ang workspace ng agent (`agents.defaults.workspace` o `agents.list[].workspace`)
- i‑tune ang mga default ng embedded agent (`agents.defaults`) at asal ng session (`session`)
- itakda ang identity kada agent (`agents.list[].identity`)

> **Bago sa configuration?** Tingnan ang gabay na [Configuration Examples](/gateway/configuration-examples) para sa mga kumpletong halimbawa na may detalyadong paliwanag!

## Mahigpit na pag‑validate ng config

Tumatanggap lang ang OpenClaw ng mga configuration na ganap na tumutugma sa schema.
Ang mga hindi kilalang key, maling uri, o invalid na value ay magdudulot na **tumangging mag‑start** ang Gateway para sa kaligtasan.

Kapag pumalya ang validation:

- Hindi magbo‑boot ang Gateway.
- Mga diagnostic command lang ang pinapayagan (halimbawa: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Patakbuhin ang `openclaw doctor` para makita ang eksaktong mga isyu.
- Patakbuhin ang `openclaw doctor --fix` (o `--yes`) para mag‑apply ng migrations/repairs.

Hindi kailanman nagsusulat ng pagbabago ang Doctor maliban kung tahasan kang mag‑opt in sa `--fix`/`--yes`.

## Schema + mga UI hint

Naglalantad ang Gateway ng JSON Schema na representasyon ng config sa pamamagitan ng `config.schema` para sa mga UI editor.
Ang Control UI ay nagre‑render ng form mula sa schema na ito, na may **Raw JSON** editor bilang escape hatch.

Maaaring mag‑register ang mga channel plugin at extension ng schema + mga UI hint para sa kanilang config, kaya nananatiling schema‑driven ang mga setting ng channel sa iba’t ibang app nang walang hard‑coded na form.

Ang mga hint (label, grouping, sensitive fields) ay kasama sa schema para makapag‑render ang mga client ng mas maayos na mga form nang hindi kino‑code ang kaalaman sa config.

## I‑apply + i‑restart (RPC)

Gamitin ang `config.apply` para i‑validate + isulat ang buong config at i‑restart ang Gateway sa isang hakbang.
Nagsusulat ito ng restart sentinel at pini‑ping ang huling aktibong session pagkatapos bumalik ang Gateway.

Babala: Pinapalitan ng `config.apply` ang **buong config**. Kung ilang key lang ang babaguhin mo,
gamitin ang `config.patch` o `openclaw config set`. Magtabi ng backup ng `~/.openclaw/openclaw.json`.

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

Gamitin ang `config.patch` para i‑merge ang bahagyang update sa umiiral na config nang hindi binubura
ang mga hindi kaugnay na key. Ipinapatupad nito ang JSON merge patch semantics:

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

Hatiin ang iyong config sa maraming file gamit ang direktibang `$include`. Kapaki‑pakinabang ito para sa:

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

Maaari ka ring magbigay ng inline na env var sa config. Iina‑apply lang ang mga ito kung
kulang ang process env ng key (parehong non‑overriding na patakaran):

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

Opsyonal na kaginhawaan: kapag naka‑enable at wala pa sa inaasahang mga key ang nakaset, pinapatakbo ng OpenClaw ang iyong login shell at ini‑import lang ang mga kulang na inaasahang key (hindi kailanman nag‑o‑override).
Epektibo nitong sini‑source ang iyong shell profile.

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

Maaari mong i‑reference ang mga environment variable direkta sa alinmang string value ng config gamit ang
`${VAR_NAME}` syntax. Ang mga variable ay pinapalitan sa oras ng pag‑load ng config, bago ang validation.

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

---

_Next: [Agent Runtime](/concepts/agent)_ 🦞

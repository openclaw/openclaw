---
summary: "Alle konfigurationsmuligheder for ~/.openclaw/openclaw.json med eksempler"
read_when:
  - Tilføjelse eller ændring af konfigurationsfelter
title: "Konfiguration"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:53Z
---

# Konfiguration 🔧

OpenClaw læser en valgfri **JSON5**-konfiguration fra `~/.openclaw/openclaw.json` (kommentarer + afsluttende kommaer er tilladt).

Hvis filen mangler, bruger OpenClaw sikre-ish standardindstillinger (indlejret Pi-agent + sessioner pr. afsender + workspace `~/.openclaw/workspace`). Du har typisk kun brug for en konfiguration for at:

- begrænse hvem der kan trigge botten (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, osv.)
- styre gruppetilladelseslister + mention-adfærd (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- tilpasse beskedpræfikser (`messages`)
- sætte agentens workspace (`agents.defaults.workspace` eller `agents.list[].workspace`)
- finjustere standardindstillingerne for den indlejrede agent (`agents.defaults`) og session-adfærd (`session`)
- sætte identitet pr. agent (`agents.list[].identity`)

> **Ny i konfiguration?** Tjek guiden [Configuration Examples](/gateway/configuration-examples) for komplette eksempler med detaljerede forklaringer!

## Streng konfigurationsvalidering

OpenClaw accepterer kun konfigurationer, der fuldt ud matcher skemaet.
Ukendte nøgler, forkerte typer eller ugyldige værdier får Gateway til at **nægte at starte** af sikkerhedshensyn.

Når valideringen fejler:

- Gateway starter ikke.
- Kun diagnostiske kommandoer er tilladt (for eksempel: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Kør `openclaw doctor` for at se de præcise problemer.
- Kør `openclaw doctor --fix` (eller `--yes`) for at anvende migreringer/reparationer.

Doctor skriver aldrig ændringer, medmindre du eksplicit tilvælger `--fix`/`--yes`.

## Skema + UI-hints

Gateway eksponerer en JSON Schema-repræsentation af konfigurationen via `config.schema` til UI-editorer.
Control UI renderer en formular ud fra dette skema, med en **Raw JSON**-editor som nødudgang.

Kanal-plugins og udvidelser kan registrere skema + UI-hints for deres konfiguration, så kanalindstillinger
forbliver skemadrevne på tværs af apps uden hardcodede formularer.

Hints (labels, gruppering, følsomme felter) leveres sammen med skemaet, så klienter kan rendere
bedre formularer uden at hardcode viden om konfigurationen.

## Anvend + genstart (RPC)

Brug `config.apply` til at validere + skrive hele konfigurationen og genstarte Gateway i ét trin.
Den skriver en genstarts-sentinel og pinger den senest aktive session, efter Gateway er oppe igen.

Advarsel: `config.apply` erstatter **hele konfigurationen**. Hvis du kun vil ændre få nøgler,
så brug `config.patch` eller `openclaw config set`. Bevar en backup af `~/.openclaw/openclaw.json`.

Parametre:

- `raw` (string) — JSON5-payload for hele konfigurationen
- `baseHash` (valgfri) — konfigurations-hash fra `config.get` (påkrævet når en konfiguration allerede findes)
- `sessionKey` (valgfri) — nøgle for senest aktive session til wake-up ping
- `note` (valgfri) — note, der inkluderes i genstarts-sentinellen
- `restartDelayMs` (valgfri) — forsinkelse før genstart (standard 2000)

Eksempel (via `gateway call`):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Delvise opdateringer (RPC)

Brug `config.patch` til at merge en delvis opdatering ind i den eksisterende konfiguration uden at overskrive
urelaterede nøgler. Den anvender JSON merge patch-semantik:

- objekter merges rekursivt
- `null` sletter en nøgle
- arrays erstattes
  Ligesom `config.apply` validerer den, skriver konfigurationen, gemmer en genstarts-sentinel og planlægger
  Gateway-genstarten (med en valgfri wake når `sessionKey` er angivet).

Parametre:

- `raw` (string) — JSON5-payload, der kun indeholder de nøgler, der skal ændres
- `baseHash` (påkrævet) — konfigurations-hash fra `config.get`
- `sessionKey` (valgfri) — nøgle for senest aktive session til wake-up ping
- `note` (valgfri) — note, der inkluderes i genstarts-sentinellen
- `restartDelayMs` (valgfri) — forsinkelse før genstart (standard 2000)

Eksempel:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Minimal konfiguration (anbefalet startpunkt)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Byg standardbilledet én gang med:

```bash
scripts/sandbox-setup.sh
```

## Self-chat-tilstand (anbefalet til gruppestyring)

For at forhindre botten i at svare på WhatsApp @-mentions i grupper (kun svare på specifikke tekst-triggere):

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

## Konfigurations-inkluderinger (`$include`)

Opdel din konfiguration i flere filer ved hjælp af `$include`-direktivet. Dette er nyttigt til:

- Organisering af store konfigurationer (fx agentdefinitioner pr. klient)
- Deling af fælles indstillinger på tværs af miljøer
- Adskillelse af følsomme konfigurationer

### Grundlæggende brug

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

### Merge-adfærd

- **Enkelt fil**: Erstatter objektet, der indeholder `$include`
- **Array af filer**: Deep-merger filer i rækkefølge (senere filer overskriver tidligere)
- **Med søskendenøgler**: Søskendenøgler merges efter includes (overskriver inkluderede værdier)
- **Søskendenøgler + arrays/primitiver**: Ikke understøttet (inkluderet indhold skal være et objekt)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### Indlejrede includes

Inkluderede filer kan selv indeholde `$include`-direktiver (op til 10 niveauer dybt):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### Stiopløsning

- **Relative stier**: Opløses relativt til den inkluderende fil
- **Absolutte stier**: Bruges som de er
- **Overordnede mapper**: `../`-referencer virker som forventet

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Fejlhåndtering

- **Manglende fil**: Klar fejl med den opløste sti
- **Parse-fejl**: Viser hvilken inkluderet fil der fejlede
- **Cirkulære includes**: Detekteres og rapporteres med include-kæde

### Eksempel: Multi-klient juridisk opsætning

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

## Almindelige indstillinger

### Miljøvariabler + `.env`

OpenClaw læser miljøvariabler fra forældreprocessen (shell, launchd/systemd, CI, osv.).

Derudover indlæser den:

- `.env` fra den aktuelle arbejdsmappe (hvis til stede)
- en global fallback `.env` fra `~/.openclaw/.env` (alias `$OPENCLAW_STATE_DIR/.env`)

Ingen af `.env`-filerne overskriver eksisterende miljøvariabler.

Du kan også angive inline-miljøvariabler i konfigurationen. Disse anvendes kun, hvis
procesmiljøet mangler nøglen (samme ikke-overskrivningsregel):

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

Se [/environment](/help/environment) for fuld præcedens og kilder.

### `env.shellEnv` (valgfri)

Valgfri bekvemmelighed: hvis aktiveret og ingen af de forventede nøgler endnu er sat,
kører OpenClaw din login-shell og importerer kun de manglende forventede nøgler (overskriver aldrig).
Dette svarer i praksis til at source din shell-profil.

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

Miljøvariabel-ækvivalent:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Substitution af miljøvariabler i konfigurationen

Du kan referere direkte til miljøvariabler i enhver konfigurations-strengværdi ved hjælp af
`${VAR_NAME}`-syntaks. Variabler substitueres ved indlæsning af konfigurationen, før validering.

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

**Regler:**

- Kun store bogstaver i env-var-navne matches: `[A-Z_][A-Z0-9_]*`
- Manglende eller tomme env-vars giver fejl ved konfigurationsindlæsning
- Escap med `$${VAR}` for at outputte en bogstavelig `${VAR}`
- Virker med `$include` (inkluderede filer får også substitution)

**Inline-substitution:**

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

### Auth-lagring (OAuth + API-nøgler)

OpenClaw gemmer **pr. agent** auth-profiler (OAuth + API-nøgler) i:

- `<agentDir>/auth-profiles.json` (standard: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

Se også: [/concepts/oauth](/concepts/oauth)

Legacy OAuth-importer:

- `~/.openclaw/credentials/oauth.json` (eller `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

Den indlejrede Pi-agent vedligeholder en runtime-cache i:

- `<agentDir>/auth.json` (administreres automatisk; redigér ikke manuelt)

Legacy agent-mappe (før multi-agent):

- `~/.openclaw/agent/*` (migreres af `openclaw doctor` til `~/.openclaw/agents/<defaultAgentId>/agent/*`)

Overrides:

- OAuth-mappe (kun legacy import): `OPENCLAW_OAUTH_DIR`
- Agent-mappe (standard agent-root override): `OPENCLAW_AGENT_DIR` (foretrukken), `PI_CODING_AGENT_DIR` (legacy)

Ved første brug importerer OpenClaw `oauth.json`-poster til `auth-profiles.json`.

### `auth`

Valgfri metadata for auth-profiler. Dette gemmer **ikke** hemmeligheder; det mapper
profil-id’er til en udbyder + tilstand (og valgfri email) og definerer
udbyder-rotationsrækkefølgen, der bruges til failover.

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

Valgfri identitet pr. agent, brugt til standarder og UX. Dette skrives af macOS-introduktionsassistenten.

Hvis sat, afleder OpenClaw standarder (kun når du ikke har sat dem eksplicit):

- `messages.ackReaction` fra den **aktive agent**s `identity.emoji` (falder tilbage til 👀)
- `agents.list[].groupChat.mentionPatterns` fra agentens `identity.name`/`identity.emoji` (så “@Samantha” virker i grupper på tværs af Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)
- `identity.avatar` accepterer en workspace-relativ billedsti eller en fjern URL/data-URL. Lokale filer skal ligge inden for agentens workspace.

`identity.avatar` accepterer:

- Workspace-relativ sti (skal forblive inden for agentens workspace)
- `http(s)`-URL
- `data:`-URI

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

Metadata skrevet af CLI-opsætningsguides (`onboard`, `configure`, `doctor`).

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

- Standard logfil: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Hvis du vil have en stabil sti, så sæt `logging.file` til `/tmp/openclaw/openclaw.log`.
- Konsol-output kan justeres separat via:
  - `logging.consoleLevel` (standard `info`, øges til `debug` når `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Værktøjssammendrag kan redigeres for at undgå læk af hemmeligheder:
  - `logging.redactSensitive` (`off` | `tools`, standard: `tools`)
  - `logging.redactPatterns` (array af regex-strenge; overskriver standarder)

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

Styrer hvordan WhatsApp direkte chats (DM’er) håndteres:

- `"pairing"` (standard): ukendte afsendere får en parringskode; ejeren skal godkende
- `"allowlist"`: tillad kun afsendere i `channels.whatsapp.allowFrom` (eller parret tilladelseslager)
- `"open"`: tillad alle indgående DM’er (**kræver** at `channels.whatsapp.allowFrom` inkluderer `"*"`)
- `"disabled"`: ignorér alle indgående DM’er

Parringskoder udløber efter 1 time; botten sender kun en parringskode, når en ny anmodning oprettes. Ventende DM-parringsanmodninger er som standard begrænset til **3 pr. kanal**.

Parringsgodkendelser:

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

Tilladelsesliste over E.164-telefonnumre, der må trigge WhatsApp auto-svar (**kun DM’er**).
Hvis tom og `channels.whatsapp.dmPolicy="pairing"`, vil ukendte afsendere modtage en parringskode.
For grupper bruges `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

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

Styrer om indgående WhatsApp-beskeder markeres som læst (blå flueben). Standard: `true`.

Self-chat-tilstand springer altid læsekvitteringer over, selv når aktiveret.

Override pr. konto: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (multi-konto)

Kør flere WhatsApp-konti i én gateway:

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

Noter:

- Udgående kommandoer bruger som standard konto `default` hvis til stede; ellers den første konfigurerede konto-id (sorteret).
- Den legacy single-konto Baileys auth-mappe migreres af `openclaw doctor` til `whatsapp/default`.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

Kør flere konti pr. kanal (hver konto har sin egen `accountId` og valgfri `name`):

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

Noter:

- `default` bruges, når `accountId` udelades (CLI + routing).
- Env-tokens gælder kun for **standard**kontoen.
- Basis-kanalindstillinger (gruppepolitik, mention-gating, osv.) gælder for alle konti, medmindre de overskrives pr. konto.
- Brug `bindings[].match.accountId` til at route hver konto til forskellige agents.defaults.

### Mention-gating i gruppechats (`agents.list[].groupChat` + `messages.groupChat`)

Gruppebeskeder kræver som standard **mention** (enten metadata-mention eller regex-mønstre). Gælder for WhatsApp, Telegram, Discord, Google Chat og iMessage-gruppechats.

**Mention-typer:**

- **Metadata-mentions**: Native platform @-mentions (fx WhatsApp tap-to-mention). Ignoreres i WhatsApp self-chat-tilstand (se `channels.whatsapp.allowFrom`).
- **Tekstmønstre**: Regex-mønstre defineret i `agents.list[].groupChat.mentionPatterns`. Tjekkes altid uanset self-chat-tilstand.
- Mention-gating håndhæves kun, når mention-detektion er mulig (native mentions eller mindst én `mentionPattern`).

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

`messages.groupChat.historyLimit` sætter den globale standard for gruppehistorik-kontekst. Kanaler kan overskrive med `channels.<channel>.historyLimit` (eller `channels.<channel>.accounts.*.historyLimit` for multi-konto). Sæt `0` for at deaktivere historik-wrapping.

#### DM-historikgrænser

DM-samtaler bruger sessionsbaseret historik styret af agenten. Du kan begrænse antallet af brugerturns, der bevares pr. DM-session:

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

Opløsningsrækkefølge:

1. Override pr. DM: `channels.<provider>.dms[userId].historyLimit`
2. Udbyder-standard: `channels.<provider>.dmHistoryLimit`
3. Ingen grænse (al historik bevares)

Understøttede udbydere: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Override pr. agent (har forrang når sat, selv `[]`):

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

Mention-gating-standarder lever pr. kanal (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). Når `*.groups` er sat, fungerer den også som en gruppetilladelsesliste; inkluder `"*"` for at tillade alle grupper.

For kun at svare på specifikke tekst-triggere (ignorere native @-mentions):

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

### Gruppepolitik (pr. kanal)

Brug `channels.*.groupPolicy` til at styre, om gruppe-/rum-beskeder overhovedet accepteres:

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

Noter:

- `"open"`: grupper omgår tilladelseslister; mention-gating gælder stadig.
- `"disabled"`: bloker alle gruppe-/rum-beskeder.
- `"allowlist"`: tillad kun grupper/rum, der matcher den konfigurerede tilladelsesliste.
- `channels.defaults.groupPolicy` sætter standarden, når en udbyders `groupPolicy` er usat.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams bruger `groupAllowFrom` (fallback: eksplicit `allowFrom`).
- Discord/Slack bruger kanal-tilladelseslister (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- Gruppe-DM’er (Discord/Slack) styres stadig af `dm.groupEnabled` + `dm.groupChannels`.
- Standard er `groupPolicy: "allowlist"` (medmindre overskrevet af `channels.defaults.groupPolicy`); hvis ingen tilladelsesliste er konfigureret, blokeres gruppebeskeder.

_..._

_Næste: [Agent Runtime](/concepts/agent)_ 🦞

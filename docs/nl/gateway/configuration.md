---
summary: "Alle configuratieopties voor ~/.openclaw/openclaw.json met voorbeelden"
read_when:
  - Toevoegen of wijzigen van configvelden
title: "Configuratie"
---

# Configuratie 🔧

OpenClaw leest een optionele **JSON5**-config uit `~/.openclaw/openclaw.json` (commentaar + afsluitende komma’s toegestaan).

Als het bestand ontbreekt, gebruikt OpenClaw veilige-achtige standaardwaarden (ingebedde Pi-agent + per-afzender sessies + werkruimte `~/.openclaw/workspace`). Meestal heb je alleen een config nodig om:

- te beperken wie de bot kan activeren (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, enz.)
- groeps-toegestane lijsten + mention-gedrag te beheren (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- berichtprefixen aan te passen (`messages`)
- de werkruimte van de agent in te stellen (`agents.defaults.workspace` of `agents.list[].workspace`)
- de standaardinstellingen van de ingebedde agent (`agents.defaults`) en sessiegedrag (`session`) af te stemmen
- per-agent identiteit in te stellen (`agents.list[].identity`)

> **Nieuw met configuratie?** Bekijk de gids [Configuration Examples](/gateway/configuration-examples) voor volledige voorbeelden met gedetailleerde uitleg!

## Strikte configvalidatie

OpenClaw accepteert alleen configuraties die volledig overeenkomen met het schema.
Onbekende sleutels, onjuist gevormde typen of ongeldige waarden zorgen ervoor dat de Gateway **weigert te starten** om veiligheidsredenen.

Wanneer validatie faalt:

- De Gateway start niet.
- Alleen diagnostische opdrachten zijn toegestaan (bijvoorbeeld: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Voer `openclaw doctor` uit om de exacte problemen te zien.
- Voer `openclaw doctor --fix` (of `--yes`) uit om migraties/reparaties toe te passen.

Doctor schrijft nooit wijzigingen weg tenzij je expliciet kiest voor `--fix`/`--yes`.

## Schema + UI-hints

De Gateway stelt een JSON Schema-weergave van de config beschikbaar via `config.schema` voor UI-editors.
De Control UI rendert een formulier vanuit dit schema, met een **Raw JSON**-editor als ontsnappingsluik.

Kanaalplugins en extensies kunnen schema + UI-hints registreren voor hun config, zodat kanaalinstellingen
schema-gedreven blijven in alle apps zonder hardgecodeerde formulieren.

Hints (labels, groepering, gevoelige velden) worden samen met het schema geleverd zodat clients
betere formulieren kunnen renderen zonder hardgecodeerde kennis van de config.

## Toepassen + herstarten (RPC)

Gebruik `config.apply` om de volledige config te valideren + weg te schrijven en de Gateway in één stap te herstarten.
Dit schrijft een herstart-sentinel en pingt de laatst actieve sessie nadat de Gateway weer online is.

Waarschuwing: `config.apply` vervangt de **volledige config**. Als je slechts enkele sleutels wilt wijzigen,
gebruik `config.patch` of `openclaw config set`. Houd een back-up van `~/.openclaw/openclaw.json` bij.

Params:

- `raw` (string) — JSON5-payload voor de volledige config
- `baseHash` (optioneel) — confighash van `config.get` (vereist wanneer er al een config bestaat)
- `sessionKey` (optioneel) — sleutel van de laatst actieve sessie voor de wake-up ping
- `note` (optioneel) — notitie om op te nemen in de herstart-sentinel
- `restartDelayMs` (optioneel) — vertraging vóór herstart (standaard 2000)

Voorbeeld (via `gateway call`):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Gedeeltelijke updates (RPC)

Gebruik `config.patch` om een gedeeltelijke update samen te voegen met de bestaande config zonder
onverwante sleutels te overschrijven. Het past JSON merge patch-semantiek toe:

- objecten worden recursief samengevoegd
- `null` verwijdert een sleutel
- arrays worden vervangen
  Net als `config.apply` valideert het, schrijft de config weg, slaat een herstart-sentinel op en plant
  de Gateway-herstart (met een optionele wake wanneer `sessionKey` is opgegeven).

Params:

- `raw` (string) — JSON5-payload met alleen de te wijzigen sleutels
- `baseHash` (vereist) — confighash van `config.get`
- `sessionKey` (optioneel) — sleutel van de laatst actieve sessie voor de wake-up ping
- `note` (optioneel) — notitie om op te nemen in de herstart-sentinel
- `restartDelayMs` (optioneel) — vertraging vóór herstart (standaard 2000)

Voorbeeld:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Minimale config (aanbevolen startpunt)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Bouw de standaardimage één keer met:

```bash
scripts/sandbox-setup.sh
```

## Zelf-chatmodus (aanbevolen voor groepscontrole)

Om te voorkomen dat de bot reageert op WhatsApp-@-mentions in groepen (alleen reageren op specifieke teksttriggers):

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

## Config-includes (`$include`)

Splits je config in meerdere bestanden met behulp van de `$include`-directive. Dit is handig voor:

- Het organiseren van grote configs (bijv. per-client agentdefinities)
- Het delen van gemeenschappelijke instellingen tussen omgevingen
- Het gescheiden houden van gevoelige configs

### Basisgebruik

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

### Samenvoeggedrag

- **Enkel bestand**: Vervangt het object dat `$include` bevat
- **Array van bestanden**: Diep samenvoegen in volgorde (latere bestanden overschrijven eerdere)
- **Met sibling-sleutels**: Sibling-sleutels worden na includes samengevoegd (overschrijven inbegrepen waarden)
- **Sibling-sleutels + arrays/primitieven**: Niet ondersteund (ingesloten inhoud moet een object zijn)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### Geneste includes

Ingesloten bestanden kunnen zelf `$include`-directives bevatten (tot 10 niveaus diep):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### Pad resolutie

- **Relatieve paden**: Opgelost relatief aan het insluitende bestand
- **Absolute paden**: Ongewijzigd gebruikt
- **Bovenliggende mappen**: `../`-referenties werken zoals verwacht

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Fout bij behandeling

- **Ontbrekend bestand**: Duidelijke fout met opgelost pad
- **Parsefout**: Toont welk ingesloten bestand faalde
- **Circulaire includes**: Gedetecteerd en gerapporteerd met include-keten

### Voorbeeld: Multi-client juridische setup

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

## Veelvoorkomende opties

### Env vars + `.env`

OpenClaw leest omgevingsvariabelen uit het bovenliggende proces (shell, launchd/systemd, CI, enz.).

Daarnaast laadt het:

- `.env` uit de huidige werkdirectory (indien aanwezig)
- een globale fallback `.env` uit `~/.openclaw/.env` (oftewel `$OPENCLAW_STATE_DIR/.env`)

Geen van beide `.env`-bestanden overschrijft bestaande env vars.

Je kunt ook inline env vars in de config opgeven. Deze worden alleen toegepast als de
procesomgeving de sleutel mist (dezelfde niet-overschrijvende regel):

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

Zie [/environment](/help/environment) voor volledige prioriteit en bronnen.

### `env.shellEnv` (optioneel)

Opt-in gemak: indien ingeschakeld en geen van de verwachte sleutels nog is ingesteld,
start OpenClaw je login-shell en importeert alleen de ontbrekende verwachte sleutels (nooit overschrijven).
Dit komt effectief neer op het sourcen van je shellprofiel.

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

Env-var equivalent:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Env-var substitutie in config

Je kunt omgevingsvariabelen direct refereren in elke config-stringwaarde met de
`${VAR_NAME}`-syntaxis. Variabelen worden vervangen bij het laden van de config, vóór validatie.

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

**Regels:**

- Alleen hoofdletter-env-varnamen worden gematcht: `[A-Z_][A-Z0-9_]*`
- Ontbrekende of lege env vars veroorzaken een fout bij het laden van de config
- Escapen met `$${VAR}` om een letterlijke `${VAR}` uit te voeren
- Werkt met `$include` (ingesloten bestanden krijgen ook substitutie)

**Inline substitutie:**

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

### Auth opslag (OAuth + API keys)

Openlaw bewaart **per agent** auth-profielen (OAuth + API-sleutels) in:

- `<agentDir>/auth-profiles.json` (standaard: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

Zie ook: [/concepts/oauth](/concepts/oauth)

Oude OAuth importeren:

- `~/.openclaw/credentials/oauth.json` (of `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

De ingesloten Pi agent onderhoudt een runtime cache op:

- `<agentDir>/auth.json` (automatisch beheerd; niet handmatig bewerken)

Oude agent dir (pre multi-agent):

- `~/.openclaw/agent/*` (gemigreerd door `openclaw doctor` naar `~/.openclaw/agents/<defaultAgentId>/agent/*`)

Overrides:

- OAuth dir (legacy import alleen): `OPENCLAW_OAUTH_DIR`
- Agent dir (standaard agent root overschrijven): `OPENCLAW_AGENT_DIR` (geprefereerd), `PI_CODING_AGENT_DIR` (legacy)

Bij het eerste gebruik importeert OpenClaw invoergegevens `oauth.json` in `auth-profiles.json`.

### `authenticatie`

Optionele metadata voor autorisatieprofielen. Dit bevat **geen** winkelgeheimen; het kaarten
profiel IDs aan een provider + modus (en optionele e-mail) en definieert de rotatie volgorde van provider
die wordt gebruikt voor mislukking.

```json5
{
  auth: {
    profiles: {
      "anthropic:me@examplee. { provider: "anthropic", mode: "oauth", email: "me@example. },
      "antthropic:werk": { provider: "anthropic", modus: "api_key" },
    },
    order: {
      antthropice: ["anthropic:me@example. ", "antthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

Optionele per-agent identiteit gebruikt voor standaardwaarden en UX. Dit wordt geschreven door de macOS onboarding-assistent.

Als dit is ingesteld, ontleent OpenClaw standaard (alleen wanneer je ze niet expliciet hebt ingesteld):

- `messages.ackReaction` van de **actieve agent**'s `identity.emoji` (terugvalt naar 👀)
- `agents.list[].groupChat.mentionPatterns` van de agent `identity.name`/`identity.emoji` (dus “@Samantha” werkt in groepen over de verschillende Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)
- `identity.avatar` accepteert een workspace-relative image pad of een externe URL/data URL. Lokale bestanden moeten in de medewerker werkruimte wonen.

`identity.avatar` accepteert:

- Workspace-relatief pad (moet binnen de medewerkerwerkruimte blijven)
- `http(s)` URL
- `data:` URI

```json5
{
  agents: {
    lijst: [
      {
        id: "main",
        identiteit: {
          naam: "Samantha",
          thema: "nuttige sloth",
          emoji: "🦥",
          avatar: "avatars/samantha. ng",
        },
      },
    ],
  },
}
```

### `wizard`

Metadata geschreven door CLI wizards (`onboard`, `configure`, `doctor`).

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

- Standaard logboekbestand: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Als je een stabiele route wilt, zet `logging.file` naar `/tmp/openclaw/openclaw.log`.
- Console uitvoer kan apart worden afgestemd:
  - `logging.consoleLevel` (standaard `info`, bumps to `debug` when `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Gereedschap samenvattingen kunnen worden gewijzigd om lekken te voorkomen:
  - `logging.redactSensitive` (`off`tools`, standaard: `tools\`)
  - `logging.redactPatterns` (array van regex strings; Overschrijft standaarden)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw og",
    consoleLevel: "info",
    consoleStijl: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Voorbeeld: override defaults met uw eigen regels.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']? ([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

### `channels.whatsapp.dmPolicy`

Bepaalt hoe de directe chats van WhatsApp (DMs) worden behandeld:

- `"pairing"` (standaard): onbekende afzenders krijgen een koppelingscode; eigenaar moet goedkeuren
- `"allowlist"`: alleen afzenders toestaan in `channels.whatsapp.allowFrom` (of gekoppelde toestemming winkel)
- `"open"`: sta alle inkomende DMs (**requires** `channels.whatsapp.allowFrom` toe om `"*"`) toe te voegen
- `"uitgeschakeld"`: negeer alle inkomende DMs

Koppeling codes verlopen na 1 uur; de bot stuurt alleen een koppelcode wanneer een nieuwe aanvraag wordt aangemaakt. In afwachting van DM pairing verzoeken worden standaard op **3 per kanaal** geplakt.

Koppeling goedkeuringen:

- `openclaw pairing list whatsapp`
- `openclaw pairing keurt whatsapp <code>`

### `channels.whatsapp.allowFrom`

Lijst van E.164 telefoonnummers toestaan, waarmee automatische WhatsApp antwoorden kunnen worden gestart (**alleen DM**).
Indien leeg en `channels.whatsapp.dmPolicy="pairing"`, zullen onbekende afzenders een koppelingscode ontvangen.
Voor groepen, gebruik `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "koppelen", // koppelen &gling-allowlist open open
      allowFrom: ["+155550123", "+447700900123"],
      textChunkLimit: 4000, // optionele uitgaande chunk grootte (tekens)
      chunkMode: "length", // optionele chunking modus (lengte ~newline)
      mediaMaxMb: 50, // optionele inkomende mediakap (MB)
    },
  },
}
```

### `channels.whatsapp.sendReadReceipts`

Hiermee bepaalt u of inkomende WhatsApp-berichten zijn gemarkeerd als gelezen (blauwe tikken). Standaard: `true`.

Zelf-chat modus slaat altijd leesbevestigingen over, zelfs als dit is ingeschakeld.

Per-account overschrijven: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (multi-account)

Voer meerdere WhatsApp-accounts uit met één gateway:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // optioneel; houdt de standaard id stabiel
        persoonlijk: {},
        biz: {
          // Optionele overschrijving. Standaard: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/. penclaw/inloggegevens/whatsapp/biz",
        },
      },
    },
  },
}
```

Notities:

- Uitgaande commando's standaard naar account `default` als aanwezig; anders het eerste geconfigureerde account id (gesorteerd).
- De legacy enkele account Baileys auth dir is gemigreerd door `openclaw doctor` naar `whatsapp/default`.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signa.accounts` / `channels.imessage.accounts`

Voer meerdere accounts per kanaal uit (elk account heeft zijn eigen `accountId` en optioneel `naam`):

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC... ,
        },
        waarschuwingen: {
          naam: "Alerts bot",
          botToken: "987654:XYZ. .",
        },
      },
    },
  },
}
```

Notities:

- `default` wordt gebruikt wanneer `accountId` is weggelaten (CLI + routing).
- Env tokens zijn alleen van toepassing op het **standaard** account.
- Basiskanaal instellingen (groepsbeleid, vermelding gating, etc.) Van toepassing op alle accounts tenzij deze per account overschreven worden.
- Gebruik `bindings[].match.accountId` om elk account naar een andere agents.standaard te verplaatsen.

### Groepschat vermelden gating (`agents.list[].groupChat` + `messages.groupChat`)

Groepsberichten standaard op **vereisen vermelding** (hetzij metadata vermelding of regex patronen). Van toepassing op WhatsApp, Telegram, Discord, Google Chat, en iMessage groepsgesprekken.

**Vermeld types:**

- **Metadata vermeldingen**: Native platform @-vermeldt (bijv. WhatsApp tap-to-mention). Genegeerd in WhatsApp self-chat modus (zie `channels.whatsapp.allowFrom`).
- **Tekstpatronen**: Regex patronen gedefinieerd in `agents.list[].groupChat.mentionPatterns`. Altijd gecontroleerd, ongeacht de zelf-chatmodus.
- Het vermelden van gating is alleen afgedwongen wanneer vermelding detectie mogelijk is (native vermeldt of ten minste één `mentionPattern`).

```json5
{
  berichten: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    lijst: [{ id: "main", groepChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` stelt de algemene standaard in voor de groepsgeschiedenis context. Kanalen kunnen met `kanalen overschrijven.<channel>.historyLimit` (of `channels.<channel>.accounts.*.historyLimit` voor multi-account). Zet `0` aan om geschiedenisterugloop uit te schakelen.

#### DM geschiedenis limieten

DM-gesprekken gebruiken sessie-gebaseerde geschiedenis beheerd door de agent. Je kunt het aantal gebruikers beperken dat de gebruiker bewaard blijft per DM sessie:

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30, // beperken van DM sessies tot 30 gebruikers draait
      dms: {
        "123456789": { historyLimit: 50 }, // Gebruikersoverschrijving (gebruiker ID)
      },
    },
  },
}
```

Resolutievolgorde:

1. Per-DM overschrijven: `kanalen.<provider>.dms[userId].historyLimit`
2. Provider standaard: `kanalen.<provider>.dmHistoryLimit`
3. Geen limiet (alle geschiedenis behouden)

Ondersteunde providers: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Per-agent overschrijving (heeft voorrang op de reeks, zelfs `[]`):

```json5
{
  agents: {
    lijst: [
      { id: "werk", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "persoonlijk", groupChat: { mentionPatterns: ["@homebot", "\\+155550999"] } },
    ],
  },
}
```

Vermelding gating standaard live per kanaal (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). Wanneer `*.groups` is ingesteld, fungeert het ook als een groepsallowlist; inclusief `*"` om alle groepen toe te staan.

Om **alleen** te reageren op specifieke teksttriggers (negeer native @-mentions):

```json5
{
  channels: {
    whatsapp: {
      // Bevat je eigen nummer om self-chat mode in te schakelen (negeer native @-mentions).
      allowVan: ["+155550123"],
      groepen: { "*": { requireMention: true } },
    },
  },
  agents: {
    lijst: [
      {
        id: "main",
        groepChat: {
          // Alleen deze tekst patronen zullen reacties veroorzaken
          mention Patterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### Groepsbeleid (per kanaal)

Gebruik `channels.*.groupPolicy` om te bepalen of groeps- en kamerberichten worden geaccepteerd:

```json5
{
  channels: {
    whatsapp: {
      groepbeleid: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groepsbeleid: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signaal: {
      groupPolicy: "allowlist",
      groepstoelating van: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groepAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org. om"],
    },
    discord: {
      groepbeleid: "allowlist",
      gilden: {
        GUILD_ID: {
          kanalen: { help: { allow: true } },
        },
      },
    },
    slack: {
      groepbeleid: "allowlist",
      kanalen: { "#general": { allow: true } },
    },
  },
}
```

Notities:

- `"open"`: groepen bypass allowlists; vermeldings-gating is nog steeds van toepassing.
- `"Uitgeschakeld"`: blokkeer alle groep/room berichten.
- `"allowlist"`: alleen groepsruimten toestaan die overeenkomen met de geconfigureerde allowlist.
- `channels.defaults.groupPolicy` stelt de standaard in wanneer een provider `groupPolicy` is vrijgegeven.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams gebruiken `groupAllowFrom` (fallback: explicit `allowFrom`).
- Discord/Slack gebruikt kanaal allowlists (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- Group DMs (Discord/Slack) worden nog steeds bestuurd door `dm.groupEnabled` + `dm.groupChannels`.
- Standaard is `groupPolicy: "allowlist"(tenzij overschreven door `channels.defaults.groupPolicy\`); als er geen toegestane lijst is geconfigureerd, worden groepsberichten geblokkeerd.

### Multi-agent routering (`agents.list` + `bindings`)

Voer meerdere geïsoleerde agenten uit (gescheiden werkruimte, `agentDir`, sessies) binnen één Gateway.
Binnenkomende berichten worden naar een agent doorgestuurd via bindingen.

- `agents.list[]`: per-agent overrides.
  - `id`: stable agent id (verplicht).
  - `default`: optioneel; als er meerdere zijn ingesteld, wint de eerste en wordt een waarschuwing gelogd.
    Als er geen één is ingesteld, is de **eerste invoer** in de lijst de standaard agent.
  - `naam`: toon naam voor de agent.
  - `workspace`: standaard `~/.openclaw/workspace-<agentId>` (voor `main`, daalt terug naar `agents.defaults.workspace`).
  - `agentDir`: standaard `~/.openclaw/agents/<agentId>/agent`.
  - `model`: per agent standaard model, overschrijft `agents.defaults.model` voor die agent.
    - tekenreeksformulier: `"provider/model"`, overschrijft alleen `agents.defaults.model.primary`
    - object formulier: `{ primary, fallbacks }` (overschrijft `agents.defaults.model.fallbacks`; `[]` schakelt globale fallbacks voor die agent)
  - `identity`: per-agent name/theme/emoji (gebruikt voor vermelding patronen + ack reactions).
  - `groupChat`: per-agent vermeld-gating (`mentionPatterns`).
  - `sandbox`: per-agent sandbox config (overschrijft `agents.defaults.sandbox`).
    - `mode`: `"off"` /h `"niet-main"` (Engels)
    - `workspaceAccess`: `"none"` Ο`"ro"` ~`"rw"`
    - `scope`: `"session"` credentials `"agent" `"shared"\`
    - `workspaceRoot`: aangepaste sandbox werkruimte root
    - `docker`: per-agent docker overrides (bijv. `image`, `netwerk`, `env`, `setupCommand`, limits; genegeerd wanneer `scope: "shared"`)
    - `browser`: per-agent sandboxed browser overschrijvingen (genegeerd wanneer `scope: "gedeeld"`)
    - `prune`: per-agent sandbox overschrijvingen verwijderen (genegeerd wanneer `scope: "gedeeld"`)
  - `subagents`: per agent sub-agent standaard.
    - `allowAgents`: allowlist van agent ids voor `sessions_spawn` van deze agent (`["*"]` = sta iedereen toe; standaard: alleen dezelfde agent)
  - `tools`: per-agent tool restricties (toegepast voor het sandbox tool beleid).
    - `profile`: basis tool profiel (toegepast voor allow/deny)
    - `allow`: array van toegestane toolnamen
    - `deny`: array van ontkende tool namen (deny wins)
- `agents.defaults`: gedeelde agent standaard (model, werkruimte, sandbox, etc.).
- `bindings[]`: stuurt inkomende berichten door naar een `agentId`.
  - `match.channel` (verplicht)
  - `match.accountId` (optioneel; `*` = elk account; weggelaten = standaard account)
  - `match.peer` (optioneel; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (optioneel; channel-specific)

Deterministische match volgorde:

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (exact, geen peer/guild/team)
5. `match.accountId: "*"` (kanaalbreed, geen peer/guild/team)
6. standaard agent (`agents.list[].default`, anders eerste lijst invoer, anders \`"main")

Binnen elke match rang, wint het eerste overeenkomende item in `bindings`

#### Per‑agent toegangsprofielen (multi‑agent)

Elke agent kan zijn eigen sandbox + gereedschapsbeleid dragen. Gebruik dit om toegang
levels te mengen in één gateway:

- **Volledige toegang** (persoonlijke agent)
- **Alleen lezen** tools + workspace
- **Geen bestandssysteem toegang** (alleen berichten/sessie-hulpmiddelen)

Zie [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) voor voorrang en
extra voorbeelden.

Volledige toegang (geen sandbox):

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

Alleen-lezen tools + alleen-lezen-werkruimte:

```json5
{
  agents: {
    lijst: [
      {
        id: "familie",
        werkruimte: "~/. penclaw/workspace-family",
        sandbox: {
          modus: "alle",
          scope: "agent",
          Werkruimte: "ro",
        },
        hulpmiddelen: {
          toestaan: [
            "gelezen",
            "sessies_list",
            "sessions_historie",
            "sessions_send",
            "sessies_spawn",
            "session_status",
          ],
          weigering: ["write", "bewerk", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

Geen bestandssysteem toegang (messaging/session tools ingeschakeld):

```json5
{
  agents: {
    lijst: [
      {
        id: "openbaar",
        werkruimte: "~/. penclaw/workspace-public",
        sandbox: {
          modus: "alle",
          scope: "agent",
          workspaceAccess: "geen",
        },
        hulpmiddelen: {
          toestaan: [
            "sessions_list",
            "sessies_historie",
            "sessions_send",
            "sessies_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          weigering: [
            "gelezen",
            "schrijven",
            "bewerken",
            "apply_patch",
            "exec",
            "proces",
            "browser",
            "canvas",
            "nodes",
            "kreet",
            "gateway",
            "afbeelding",
          ],
        },
      },
    ],
  },
}
```

Voorbeeld: twee WhatsApp-accounts → twee agents:

```json5
{
  agents: {
    lijst: [
      { id: "home", standaard: waar, workspace: "~/. penclaw/workspace-home" },
      { id: "work", workspace: "~/. penclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  kanalen: {
    whatsapp: {
      accounts: {
        persoonlijk: {},
        biz: {},
      },
    },
  },
}
```

### `tools.agentToAgent` (optioneel)

Medewerkers berichten sturen is opt-in:

```json5
{
  tools: {
    agentToAgent: {
      ingeschakeld: false,
      allow: ["home", "work"],
    },
  },
}
```

### `berichten.wachtrij`

Bepaalt hoe inkomende berichten zich gedragen wanneer een agent al actief is.

```json5
{
  berichten: {
    wachtrij: {
      modus: "collect", // sturer ½ followup follow up waar je brug-backlog (steer+backlog ok) ½ interrupt (wachtrij=steer legacy)
      debounceMs: 1000,
      cap: 20,
      drop: "samenvatting", // oude, nieuw, samenvatting
      byChannel: {
        whatsapp: "collect",
        telegram: "verzamelen",
        discord: "verzamelen",
        impressie: "verzamelen",
        webchat: "verzamelen",
      },
    },
  },
}
```

### `messages.inbound`

Snel inkomende berichten van de **dezelfde afzender** deblokkeren, zodat meerdere back-to-back
berichten één medewerker worden. Debouncing is gescopeerd per kanaal + gesprek
en gebruikt het meest recente bericht voor antwoord-threading/ID's.

```json5
{
  berichten: {
    ingebonden: {
      debounceMs: 2000, // 0 schakelt
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notities:

- Debounce batches **alleen tekst** berichten; media en bijlagen onmiddellijk flush
- Bestuur commando's (bijv. `/queue`, `/new`) bypass debouncing zodat ze zelfstandig blijven.

### `commands` (chatopdracht afhandeling)

Hiermee bepaalt u hoe chatcommando's worden ingeschakeld via connectors.

```json5
{
  commando's: {
    native: "auto", // native commando's registreren wanneer deze worden ondersteund (auto)
    tekst: waar, // parseer slash commando's in chatberichten
    bash: false, // sta toe! (alias: /bash) (alleen host-only; vereist hulpmiddelen. Verhoogd allowlists)
    bashForegroundMs: 2000, // bash vooreground window (0 achtergronden onmiddellijk)
    config: false, // sta /config (writes to disk)
    debug: false, // Sta /debug (runtime-only overrides)
    opnieuw start: false, // sta /herstart + gateway herstart tool
    useAccessGroups: true // afdwingen van toegang-groep toegestaan/beleid voor opdrachten
  },
}
```

Notities:

- Tekst commando's moeten worden verzonden als een **standalone** bericht en gebruik het toonaangevende `/` (geen platte-tekst alias).
- `commands.text: valse` schakelt het verwerken van chatberichten uit voor commando's.
- `commands.native: "auto"` (standaard) schakelt oorspronkelijke commando's in voor Discord/Telegram en laat Slack uit; niet-ondersteunde kanalen blijven text-only.
- Stel `commands.native: true000000false` in om alles te forceren, of overschrijf per kanaal met `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool of `"auto"). `false\` verwijdert eerder geregistreerde commando's op Discord/Telegram bij het opstarten; Slack commando's worden beheerd in de Slack app.
- `channels.telegram.customCommands` voegt extra Telegram bot menu-items toe. Namen worden genormaliseerd; conflicten met inheemse commando's worden genegeerd.
- `commands.bash: waar` staat `! <cmd>` om host commando's uit te voeren (`/bash <cmd>` werkt ook als een alias). Vereist `tools.elevated.enabled` en sta het vermelden van de afzender toe in `tools.elevated.allowFrom.<channel>`.
- `commands.bashForegroundMs` bepaalt hoe lang bash wacht voor de achtergrond. Wanneer een bash job wordt uitgevoerd, nieuwe `! <cmd>` verzoeken worden afgewezen (één tegelijk).
- `commands.config: true` stelt `/config` in (reads/writes `openclaw.json`).
- `kanalen.<provider>.configWrites` gates config mutaties geïnitieerd door dat kanaal (standaard: true). Dit geldt voor `/config set+unnamed@@0 unset` plus provider-specifieke auto-migraties (Telegram supergroup ID wijzigingen, Slack channel ID wijzigingen).
- `commands.debug: true` activeert `/debug` (runtime-only overrides).
- `commands.restart: true` stelt `/restart` in en de gateway tool start de actie opnieuw op.
- `commands.useAccessGroups: false` staat commando's toe om toegang tot de lists/policy te omzeilen.
- Slash-opdrachten en directives worden alleen gehonoreerd voor **geautoriseerde afzenders**. Autorisatie is afgeleid van
  channel allowlists/pairing plus `commands.useAccessGroups`.

### `web` (WhatsApp web channel runtime)

WhatsApp draait door het webkanaal van het gateway's (Baileys Web). Het start automatisch wanneer een gekoppelde sessie bestaat.
Zet `web.enabled: false` aan om deze standaard uit te zetten.

```json5
{
  web: {
    enabled: waar,
    heartbeatSeconden: 60,
    opnieuw verbinden: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1. ,
      jitter: 0. ,
      maxPotempts: 0,
    },
  },
}
```

### `channels.telegram` (bot transport)

OpenClaw start Telegram alleen wanneer een `channels.telegram` config sectie bestaat. Het bot-token is opgelost van `channels.telegram.botToken` (of `channels.telegram.tokenFile`), met `TELEGRAMAM_BOT_TOKEN` als terugval voor het standaardaccount.
Stel `channels.telegram.enabled: false` in om automatisch opstarten uit te schakelen.
Multi-account ondersteuning leeft onder `channels.telegram.accounts` (zie het meervoudige account gedeelte hierboven). Env tokens zijn alleen van toepassing op de standaard account.
Stel `channels.telegram.configWrites: false` in om Telegram-geïnitieerde config writes te blokkeren (inclusief supergroep ID migraties en `/config setăunset`).

```json5
{
  channels: {
    telegram: {
      ingeschakeld: waar,
      botToken: "jouw-bot-token",
      dmPolicy: "koppelen", // Pauzeer Allowlist open open
      allowlist disabled 
 allowFrom: ["tg:123456789"], // optioneel; "open" vereist ["*"]
      groepen: {
        "*": { requireMention: true },
        "-10034567890": {
          allowFrom: ["@admin"],
          systeemsnel: "Houd antwoorden kort. ,
          onderwerpen: {
            "99": {
              requiretion: false,
              vaardigheden: ["zoeken"],
              systeemsnelheid: "Blijf op onderwerp. ,
            },
          },
        },
      },
      customCommandos: [
        { commando: "backup", beschrijving: "Git backup" },
        { commando: "genereren", beschrijving: "Maak een afbeelding" },
      ],
      historyLimiet: 50, // bevat laatste N groepsberichten als context (0 uitgeschakeld)
      replyToMode: "eerste", // korting op Ctrl+all
      linkPreview: true // schakel uitgaande link previews
      streamMode: "partial", // af van ×partiële partiële blok (draft streaming; scheiden van blok streaming)
      draftChunk: {
        // optioneel; alleen voor streamMode=block
        minuten: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraaf duwt nieuwe-regel zin
      },
      acties: { reactions: true, sendMessage: true }, // tool actie poorten (false disables)
      reactionmeldingen: "own", // korting op Ctrl+own own all
      mediaMaxMb: 5,
      opnieuw: {
        // uitgaande herprobeer beleid
        pogingen: 3,
        minVertragingen: 400,
        maxDelayMs: 30000,
        jitter: 0. ,
      },
      netwerk: {
        // transport overschrijvingen
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://voorbeeld. om/telegram-webhook", // vereist webhookSecret
      webhookSecret: "geheim",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

Concept streaming notities:

- Gebruikt Telegram `sendMessageDraft` (conceptbubbel, geen echt bericht).
- Vereist **privé chat onderwerpen** (message_thread_id in DMs; bot heeft topics ingeschakeld).
- `/reasoning stream` streams redeneren in het ontwerp, stuurt dan het definitieve antwoord.
  Probeer de standaardinstellingen en het gedrag opnieuw in [Probeer beleid](/concepts/retry).

### `kanalen.discord` (bot transport)

Configureer de Discord bot door het instellen van de bot token en optionele gating:
Multi-account ondersteuning levens onder `channels.discord.accounts` (zie de multi-account sectie hierboven). Env tokens zijn alleen van toepassing op de standaard account.

```json5
{
  kanalen: {
    discord: {
      ingeschakeld: waar,
      token: "jouw-bot-token",
      mediaMaxMb: 8, // klem inkomende mediagrootte
      staat bots toe: false, // toestaan van door bot-authored berichten
      acties: {
        // tool actie poorten (false disables)
        reacties: true
        stickers: waar,
        polls: waar,
        rechten: waar,
        berichten: waar,
        threads: waar,
        pinnen: waar,
        zoeken: waar,
        lidInfo: waar,
        roleInfo: waar,
        rollen: false,
        kanaal: waar,
        voiceStatus: waar,
        gebeurtenissen: waar,
        moderatie: false,
      },
      replyToMode: "uit", // korting om eerst
      dm: {
        ingeschakeld: waar, // schakel alle DM's uit wanneer er vals
        -beleid is: "koppelen", // paireren ± allowlist open open uitgeschakeld
        allowFrom: ["1234567890", "steihuis"], // optionele DM allowlist ("open" vereist ["*"])
        groupEnabled: false, // activeer groep DMs
        groupChannels: ["openclaw-dm"], // optionele groep DM allowlist
      },
      guilds: {
        "123456789012345678": {
          // guild id (prefereerd) of slug
          slug: "friends-of-openclaw",
          benodigdheden: false, // per guild standaard
          reactiemeldingen: "eigen", // korting op Eigen eigen quad all allowlist
          gebruikers: ["987654321098765432"], // optioneel per gilde gebruiker toelaat lijst
          kanalen: {
            generaal: { allow: true },
            hulp: {
              toestaan: waar,
              vereisten: waar,
              gebruikers: ["987654321098765432"],
              vaardigheden: ["docs"],
              systeemsnelheid: "Korte antwoorden. ,
            },
          },
        },
      },
      historyLimiet: 20, // bevat laatste N gilde berichten als context
      textChunkLimit: 2000, // optionele uitgaande tekstchunk grootte (tekens)
      chunkMode: "length", // optionele chunking modus (lengte/nieuwregel)
      maxLinesPerMessage: 17, // zachte max regels per bericht (Discord UI clipping)
      opnieuw proberen: {
        // uitgaande opnieuw proberen beleid
        pogingen: 3,
        MinDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0. ,
      },
    },
  },
}
```

OpenKlauw start Discord alleen als een `channels.discord` config sectie bestaat. De token wordt opgelost van `channels.discord.token`, met `DISCORD_BOT_TOKEN` als een terugval voor het standaardaccount (tenzij `channels.discord.enabled` is `false`). Gebruik `gebruiker:<id>` (DM) of `kanaal:<id>` (gilde kanaal) bij het specificeren van leveringsdoelen voor cron/CLI commando's; blote numerieke ID's zijn dubbelzinnig en afgewezen.
Gilde slugs zijn kleine letters met spaties vervangen door `-`; kanaal sleutels gebruiken de slugged kanaal naam (geen leading `#`). Voorkeur gilde-id's als sleutels om dubbelzinnigheid te hernoemen.
Onderschreven berichten worden standaard genegeerd. Inschakelen met `channels.discord.allowBots` (eigen berichten zijn nog steeds gefilterd om self-reply loops te voorkomen).
Reactie notificatiemodus:

- `off`: geen reactiegebeurtenissen.
- `own`: reacties op de eigen berichten van de bot (standaard).
- `all`: alle reacties op alle berichten.
- `allowlist`: reacties van `guilds.<id>.users` op alle berichten (lege lijst schakelt uit).
  Uitgaande tekst is gechunked met `channels.discord.textChunkLimit` (standaard 2000). Stel `channels.discord.chunkMode="newline"` in om op lege regels (alinea-grenzen) te splitsen voor de lengte van het chunken. Discord clients kunnen zeer lange berichten clip maken, dus `channels.discord.maxLinesPerMessage` (standaard 17) splits veel reacties met meerdere regels, zelfs wanneer je minder dan 2000 tekens hebt.
  Probeer de standaardinstellingen en het gedrag opnieuw in [Probeer beleid](/concepts/retry).

### `kanalen.googlechat` (Chat API webhook)

Google Chat draait over HTTP webhooks met app-niveau authenticatie (service account).
Multi-account ondersteunt levens onder `channels.googlechat.accounts` (zie het meervoudige account gedeelte hierboven). Env vars is alleen van toepassing op de standaard account.

```json5
{
  channels: {
    googlechat: {
      ingeschakeld: waar,
      serviceAccountFile: "/path/to/service-account. son",
      audienceType: "app-url", // app-url reached. project-number
      audience: "https://gateway.example. om/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optioneel; verbetert detectie
      dm: {
        ingeschakeld: waar,
        beleid: "koppelen", // Pauze allowlist paramopen open open
        allowFrom: ["users/1234567890"], // optioneel; "open" vereist ["*"]
      },
      groepbeleid: "allowlist",
      groepen: {
        "spaties/AAA": { allow: true, requireMention: true },
      },
      acties: { reactions: true },
      typingIndicator: "bericht",
      mediaMaxMb: 20,
    },
  },
}
```

Notities:

- Service account JSON kan inline (`serviceAccount`) of bestand gebaseerd zijn (`serviceAccountFile`).
- Env fallbacks voor de standaard account: `GOOGLE_CHAT_SERVICE_ACCOUNT` of `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `audienceType` + `audience` moet overeenkomen met de webhook authenticatie configuratie van de Chat app.
- Gebruik `spaties/<spaceId>` of `users/<userId|email>` bij het instellen van leveringsdoelen.

### `kanalen.slack` (socket modus)

Slack draait in Socket Mode en vereist zowel een bot token als app token:

```json5
{
  kanalen: {
    slack: {
      ingeschakeld: waar,
      botToken: "xoxb-. .",
      appToken: "xapp-... ,
      dm: {
        ingeschakeld: waar,
        beleid: "koppelen", // Koppelen ± allowlist open open
        allowFrom: ["U123", "U456", "*"], // optioneel; "open" vereist ["*"]
        groepIngeschakeld: false,
        groepkanalen: ["G123"],
      },
      kanalen: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          toestaan: waar,
          vereisten: waar,
          staat boten toe: onwaar,
          gebruikers: ["U123"],
          vaardigheden: ["docs"],
          systeemPrompt: "Korte antwoorden. ,
        },
      },
      historyLimiet: 50, // voeg laatst N kanaal/groep berichten als context (0 is uitgeschakeld)
      staat toe: false,
      reactiemeldingen: "eigen", // Afwezigheid van signatures eigen kill is voor iedereen
      reactionAllowlist: ["U123"],
      replyToMode: "uit", // korting eerst
      thread: {
        historyScope: "thread", // thread ½ kanaal
        erfenis: false,
      },
      acties: {
        reacties: waar,
        berichten: waar,
        pinnen: waar,
        lidInfo: waar,
        emojiList: waar,
      },
      slashCommand: {
        ingeschakeld: waar,
        naam: "openclaw",
        sessionprefix: "slack:slash",
        ephemeral: true
      },
      textChunkLimit: 4000,
      chunkModus: "lengte",
      mediaMaxMb: 20,
    },
  },
}
```

Multi-account ondersteunt levens onder `channels.slack.accounts` (zie het meervoudige account gedeelte hierboven). Env tokens zijn alleen van toepassing op de standaard account.

OpenKlauw start Slack wanneer de provider is ingeschakeld en beide tokens zijn ingesteld (via configuratie of `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Gebruik `user:<id>` (DM) of `kanaal:<id>` bij het opgeven van leverdoelen voor cron/CLI commando's.
Stel `channels.slack.configWrites: false` in om Slack-geïnitieerde config writes te blokkeren (inclusief kanaal ID migraties en `/config set₀ unset`).

Onderschreven berichten worden standaard genegeerd. Inschakelen met `channels.slack.allowBots` of `channels.slack.channels.<id>.allowBots`.

Reactie notificatiemodus:

- `off`: geen reactiegebeurtenissen.
- `own`: reacties op de eigen berichten van de bot (standaard).
- `all`: alle reacties op alle berichten.
- `allowlist`: reacties van `channels.slack.reactionAllowlist` op alle berichten (lege lijst uitgeschakeld).

Gesprek sessie isolatie:

- `channels.slack.thread.historyScope` bepaalt of de geschiedenis per thread is (`thread`, standaard) of gedeeld over het kanaal (`kanaal`).
- `channels.slack.thread.inheritParent` bepaalt of nieuwe thread sessies het bovenliggende kanaal transcript overnemen (standaard: false).

Slack actiegroepen (gate `slack` tool acties):

| Actiegroep | Standaard    | Opmerkingen                          |
| ---------- | ------------ | ------------------------------------ |
| reactions  | ingeschakeld | Reageren + reacties lijst            |
| messages   | ingeschakeld | Lezen/verzenden/bewerken/verwijderen |
| pins       | ingeschakeld | Pinnen/ontpinnen/lijsten             |
| memberInfo | ingeschakeld | Lid informatie                       |
| emojiList  | ingeschakeld | Aangepaste emojilijst                |

### `kanalen.matterste` (bot token)

Mattermost wordt geleverd als plugin en is niet gebundeld met de kerninstallatie.
Installeer het eerst: `openclaw plugins installeert @openclaw/mattermost` (of `./extensions/mattermost` van een git checkout).

Mattermost vereist een bot token plus de basis URL voor uw server:

```json5
{
  kanalen: {
    matterste: {
      ingeschakeld: waar,
      botToken: "mm-token",
      baseUrl: "https://chat. xample.
      dmPolicy: "pairing",
      chatmode: "oncall", // onheus _PARAM0onchar
      oncharfixes: [">", "! ],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

OpenClaw start Mattermost wanneer het account is geconfigureerd (bot token + basis URL) en ingeschakeld. De token + base URL wordt opgelost van `channels.mattermost.botToken` + `channels.mattermost.baseUrl` of `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` voor het standaard account (tenzij `channels.mattermost.enabled` is `false`).

Chat modi:

- `oncall` (standaard): reageer alleen op kanaal berichten wanneer @mentioned.
- `onmessage`: reageer op elk kanaalbericht.
- `onchar`: reageer wanneer een bericht begint met een triggerprefix (`channels.mattermost.oncharPrefixes`, standaard `[">", "!"]`).

Toegang besturing:

- Standaard DMs: `channels.mattermost.dmPolicy="pairing"` (onbekende afzenders krijgen een koppelcode).
- Openbare DM's: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.
- Groepen: `channels.mattermost.groupPolicy="allowlist"` standaard (vermelding-gated). Gebruik `channels.mattermeestst.groupAllowFrom` om afzenders te beperken.

Multi-account ondersteuning leeft onder `channels.mattermost.accounts` (zie het meervoudige account gedeelte hierboven). Env vars is alleen van toepassing op de standaard account.
Gebruik `kanaal:<id>` of `user:<id>` (of `@username`) wanneer je een leveringsdoel opgeeft; blote iden worden behandeld als kanaalid's.

### `kanalen.signal` (signal-cli)

Signaal-reacties kunnen systeemgebeurtenissen uitzenden (gedeelde tool voor reacties):

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

Reactie notificatiemodus:

- `off`: geen reactiegebeurtenissen.
- `own`: reacties op de eigen berichten van de bot (standaard).
- `all`: alle reacties op alle berichten.
- `allowlist`: reacties van `channels.signal.reactionAllowlist` op alle berichten (lege lijst uitgeschakeld).

### `channels.imessage` (imsg CLI)

OpenClaw spawnt `imsg rpc` (JSON-RPC over stdio). Geen daemon of poort vereist.

```json5
{
  kanalen: {
    imessage: {
      ingeschakeld: waar,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat. b",
      remoteHost: "user@gateway-host", // SCP voor externe bijlagen bij gebruik van SSH wrapper
      dmPolicy: "pairing", // paireren ½ allowlist open open
      allowFrom: ["+15555550123", "user@example". om", "chat_id:123"],
      historyLimiet: 50, // bevat laatste N groepsberichten als context (0 uitgeschakeld)
      inclusief: onwaar,
      mediaMaxMb: 16,
      service: "auto",
      regio: "VS",
    },
  },
}
```

Multi-account ondersteunt levens onder `channels.imessage.accounts` (zie het meervoudige account gedeelte hierboven).

Notities:

- Volledige schijf toegang tot de Berichten DB vereist.
- De eerste verzending zal om berichten automatiseringstoestemming vragen.
- Voorkeur `chat_id:<id>` doelwitten. Gebruik `imsg chats --limit 20` om chats weer te geven.
- `channels.imessage.cliPath` kan naar een wrapper script verwijzen (bijv. `ssh` naar een andere Mac die `imsg rpc`); gebruik SSH keys om wachtwoord aanwijzingen te vermijden.
- Voor externe SSH wrappers, stel `channels.imessage.remoteHost` in om bijlagen via SCP op te halen wanneer `includeAttachments` is ingeschakeld.

Voorbeeld-wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

Stelt de **enkele globale werkruimte map** in die gebruikt wordt door de agent voor bestandsbewerkingen.

Standaard: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Als `agents.defaults.sandbox` is ingeschakeld, kunnen niet-hoofdsessies dit overschrijven met hun
eigen bereik werkruimtes onder `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

Optionele opslagplaats root om te tonen in de Runtime lijn van het systeem in de prompt. Indien losgezet, probeert OpenClaw
een `.git` map te detecteren door opwaarts te lopen van de werkruimte (en huidige
werkmap). Het pad moet bestaan om te kunnen gebruiken.

```json5
{
  agents: { repoRoot: "~/Projects/openclaw" } },
 } }
```

### `agents.defaults.skipBootstrap`

Schakelt automatisch aanmaken van de werkruimte bootstrap bestanden uit (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, en `BOOTSTRAP.md`).

Gebruik dit voor vooraf opgehangen implementaties waar uw werkruimte bestanden uit een repo.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

Max tekens van elke werkruimte bootstrap bestand geïnjecteerd in de systeem prompt
voor truncatie. Standaard: `20000`.

Wanneer een bestand deze limiet overschrijdt, logt OpenClaw een waarschuwing en injecteert een afgekapte
head/tail met een marker.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

Stelt de tijdzone van de gebruiker in voor **systeemprompt context** (niet voor tijdstempels in
bericht enveloppen). Indien losgezet, gebruikt OpenClaw de host tijdzone op runtime.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

Bepaalt het **tijdsformaat** dat in de huidige datum- en tijdsectie van het systeem wordt weergegeven.
Standaard: `auto` (OS voorkeur).

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto γ12 ² 24
 } }
```

### `berichten`

Bepaalt binnengrenzen/uitgaande voorvoegsels en optionele ack reacties.
Zie [Messages](/concepts/messages) voor wachtrij, sessies en streaming context.

```json5
{
  berichten: {
    responsePrefix: "🦞", // of "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterRepy: false,
  },
}
```

`responsePrefix` wordt toegepast op **alle uitgaande antwoorden** (tool summaries, block
streaming, laatste antwoorden) op kanalen tenzij deze al aanwezig zijn.

Overrides kunnen per kanaal en per account worden geconfigureerd:

- `channels.<channel>.responsePrefix`
- `channels.<channel>.accounts.<id>.responsePrefix`

Resolutievolgorde (meest specifiek wint):

1. `channels.<channel>.accounts.<id>.responsePrefix`
2. `channels.<channel>.responsePrefix`
3. `messages.responsePrefix`

Hallo:

- `undefined` valt door naar het volgende level.
- `""` schakelt expliciet de prefix uit en stopt de cascade.
- `"auto"` ontleent `[{identity.name}]` voor de routed agent.

Overrides gelden voor alle kanalen, inclusief extensies, en voor elk uitgaande antwoord soort.

Als `messages.responsePrefix` niet is ingesteld, wordt er geen prefix standaard toegepast. WhatsApp self-chat
antwoorden zijn de uitzondering: ze worden standaard ingesteld op `[{identity.name}]` als ze zijn ingesteld, anders is
`[openclaw]`, dus gesprekken van dezelfde telefoon blijven leesbaar.
Zet het op `"auto"` om `[{identity.name}]` af te leiden voor de routed agent (wanneer ingesteld).

#### Template variabelen

De `responsePrefix` string kan sjabloonvariabelen bevatten die dynamisch oplossen:

| Variabele         | Beschrijving               | Voorbeeld                                         |
| ----------------- | -------------------------- | ------------------------------------------------- |
| `{model}`         | Korte modelnaam            | `claude-opus-4-6`, `gpt-4o`                       |
| `{modelFull}`     | Volledig model id          | `anthropic/claude-opus-4-6`                       |
| `{provider}`      | Naam leverancier           | `anthropic`, `openai`                             |
| `{thinkingLevel}` | Huidig gedachtenniveau     | `hoog`, `laag`, `off`                             |
| `{identity.name}` | Naam medewerker identiteit | (hetzelfde als `"auto"` modus) |

Variabelen zijn hoofdletterongevoelig (`{MODEL}` = `{model}`). `{think}` is een alias voor `{thinkingLevel}`.
Onopgeloste variabelen blijven als letterlijke tekst.

```json5
{
  berichten: {
    responsePrefix: "[{model} think:{thinkingLevel}]",
  },
}
```

Voorbeeld uitvoer: `[claude-opus-4-6 think:high] Hier is mijn reactie...`

WhatsApp inkomende prefix is geconfigureerd via `channels.whatsapp.messagePrefix` (verouderd:
`messages.messagePrefix`). Standaard blijft **ongewijzigd**: `"[openclaw]"` als
`channels.whatsapp.allowFrom` leeg is, anders `""` (geen prefix). Wanneer je
`"[openclaw]"`, zal OpenClaw `[{identity.name}]` gebruiken wanneer de routed
agent `identity.name` is ingesteld.

`ackReaction` stuurt een beste emoji reactie om inkomende berichten
te erkennen op kanalen die reacties ondersteunen (Slack/Discord/Telegram/Google Chat). Standaard de
actieve agent zijn `identity.emoji` wanneer ingesteld, anders `"👀"`. Zet het op `""` om uit te schakelen.

`ackReactionScope` besturingselementen bij vuurreacties:

- `group-mentions` (standaard): alleen wanneer een groep/kamer vereist **en** de bot is genoemd
- `group-all`: alle groeps/room berichten
- `direct`: verstuur alleen berichten
- `alle`: alle berichten

`removeAckAfterReply` verwijdert de ack reactie van de bot nadat een antwoord is verzonden
(Slack/Discord/Telegram/Google Chat). Standaard: `false`.

#### `berichten.tts`

Tekst-naar-spraak inschakelen voor uitgaande antwoorden. Wanneer ingeschakeld, genereert OpenClaw audio
met ElevenLabs of OpenAI en hecht het aan reacties. Telegram maakt gebruik van Opus
spraak notities; andere kanalen sturen MP3 audio.

```json5
{
  berichten: {
    tts: {
      auto: "altijd", // korting altijd ≤ inbound inbound
      mode: "final", // eindig elk (inclusief antwoorden op tool/blokkeringen)
      provider: "elevenlabs",
      samenvattyModel: "openai/gpt-4. -mini",
      modelOverrides: {
        enabled: true,
      },
      maxTextLengte: 4000,
      timeouts: 30000,
      prefsPath: "~/. penclaw/instellingen/tts. son",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api. levenlabs. o",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalisatie: "auto",
        languageCode: "en",
        voiceSettings: {
          stabiliteit: 0. ,
          vergelijkbare Boost: 0. 5,
          stijl: 0. ,
          useSpeakerBoost: waar,
          snelheid: 1. ,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        stem: "alloy",
      },
    },
  },
}
```

Notities:

- `messages.tts.auto` bestuurt autogithub.com/TTS (`off`, `always`, `inbound`, `tagged`).
- `/tts off000000always+unnamed@@0 ongegrensd` stelt de per/h sessie automatische instelling in (overrides config).
- `messages.tts.enabled` is legacy; doctor migreert het naar `messages.tts.auto`.
- `prefsPath` slaat lokale overrides op (provider/limit/summarize).
- `maxTextLength` is een harde bovengrens voor TTS input; samenvattingen zijn afgekapt om te passen.
- `samenvatting Model` overschrijft `agents.defaults.model.primary` voor auto-samenvatting.
  - Accepteert `provider/model` of een alias van `agents.defaults.models`.
- `modelOverrides` maakt model-gedreven overschrijvingen mogelijk, zoals `[[tts:...]]` tags (standaard aan).
- `/tts limit` and `/tts summary` control per-user summarization settings.
- `apiKey` waarden vallen terug naar `ELEVENLABS_API_KEY`/`XI_API_KEY` en `OPENAI_API_KEY`.
- `elevenlabs.baseUrl` overschrijft de ElevenLabs API basis URL.
- `elevenlabs.voiceSettings` ondersteunt `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost`, en `speed` (0.5..2.0).

### `Spraak`

Standaard Talk-modus (macOS/iOS/Android). Stem IDs vallen terug naar `ELEVENLABS_VOICE_ID` of `SAG_VOICE_ID` wanneer deze niet ingesteld is.
`apiKey` valt terug naar `ELEVENLABS_API_KEY` (of de gateway’s shell profile) wanneer deze niet ingesteld is.
`voiceAliases` laat Gesprek richtlijnen vriendelijke namen gebruiken (bijv. \`"voice":"lawd").

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Klaar: "EXAVITQu4vr4xnSDxMaL",
      Roost: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormaat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: waar,
  },
}
```

### `agents.standaard`

Bepaalt de runtime van de ingesloten agent (model/dunking/extense/timeouts).
`agents.defaults.models` definieert de geconfigureerde model catalogus (en fungeert als de allowlist voor `/model`).
`agents.defaults.model.primary` stelt het standaardmodel in, `agents.defaults.model.fallbacks` zijn globale failovers.
`agents.defaults.imageModel` is optioneel en wordt **alleen gebruikt als het primaire model geen afbeelding heeft input**.
Elk `agents.defaults.models` item kan bevatten:

- `alias` (optioneel model snelkoppeling, bijv. `/opus`).
- `params` (optionele provider-specifieke API parameters doorgegeven aan het modelverzoek).

`params` wordt ook toegepast op streamingstypes (ingesloten agent + compactie). Ondersteunde sleutels vandaag: `temperature`, `maxTokens`. Deze samenvoegen met call-time opties; Bijgeleverde waarden win. `temperature` is een geavanceerde knob—laat deze leeg tenzij je de standaard weet en een verandering van het model nodig hebt.

Voorbeeld:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5. ": {
          params: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Z.AI GLM-4.x modellen staan automatisch de manier van denken toe, tenzij jij:

- zet `--nadenken uit`, of
- definieer `agents.defaults.models["zai/<model>"].params.thinking` zelf.

OpenClaw verzendt ook een paar ingebouwde alias shorthands. Standaardwaarden zijn alleen van toepassing als het model
al aanwezig is in `agents.defaults.models`:

- `opus` -> `anthropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

Als je dezelfde alias naam (hoofdlettergevoelig) zelf configureert, wint je waarde (standaard wordt nooit overschreden).

Voorbeeld: Opus 4.6 primair met MiniMax M2.1 terugval (gehost MiniMax):

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2. ": { alias: "minimax" },
      },
      model: {
        primair: "anthropic/claude-opus-4-6",
        terugvalt: ["minimax/MiniMax-M2. "],
      },
    },
  },
}
```

MiniMax auth: stel `MINIMAX_API_KEY` (env) in of configureer `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI terugval)

Optionele CLI-backends voor alleen tekst-fallback draait (geen tool calls). Dit is handig als een
backup pad wanneer API providers mislukken. Afbeelding pass-through wordt ondersteund wanneer je
een `imageArg` configureert die bestandspaden accepteert.

Notities:

- CLI backends zijn **text-first**; hulpmiddelen zijn altijd uitgeschakeld.
- Sessies worden ondersteund wanneer `sessionArg` is ingesteld; sessie id's worden per backend.
- Voor `claude-cli`, worden standaard bedraden. Overschrijf het opdrachtpad als de PATH minimaal
  is (launchd/system).

Voorbeeld:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          commando: "my-cli",
          args: ["--json"],
          uitvoer: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessiemodus: "Bestaat",
          systemPromptArg: "--system",
          systemPromptWhen: "eerste",
          afbeelding: "--afbeelding",
          afbeeldingsmodus: "herhalen",
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
        "zai/glm-4. ": {
          alias: "GLM",
          params: {
            dunking: {
              type: "enabled",
              clear_thinking: onwaar,
            },
          },
        },
      },
      model: {
        primair: "anthropic/claude-opus-4-6",
        terugvalt: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3. -70b-instruct:gratis",
        ],
      },
      imageModel: {
        primair: "openrouter/qwen/qwen-2. -vl-72b-instruct:free",
        gevallen terug: ["openrouter/google/gemini-2. -flash-vision:free"],
      },
      denkstandaard: "laag",
      verboseStandaard: "uit",
      standaardinstelling: "aan",
      time-outseconden: 600,
      mediaMaxMb: 5,
      hartjes: {
        elke: "30m",
        doel: "laat",
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2. ",
        maxConcurrent: 1,
        archiveAfterMinuten: 60,
      },
      exec: {
        achtergronden: 10000,
        timeout: 1800,
        schoonmaakapparaten: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### `agents.defaults.contextPruning` (tool-result pruning)

`agents.defaults.contextPruning` verwijdert **oude tool resultaten** van de in-memory context rechts voordat een verzoek naar de LLM wordt verzonden.
Het wijzigt **niet** de sessie geschiedenis op schijf (`*.jsonl` blijft complete).

Dit is bedoeld om het token gebruik van chatagenten die grote gereedschappen in de loop der tijd verzamelen te verminderen.

Hoog niveau:

- Nooit gebruiker/assistent berichten aanraken.
- Beschermt de laatste `keepLastAssistants` assistenten berichten (geen tool resultaten na dat punt zijn verwijderd).
- Beschermt het bootstrap voorvoegsel (niets voordat het eerste gebruikersbericht is verwijderd).
- Modus:
  - `adaptive`: soft-trims overmaat aan gereedschap (houd hoofd/tail) wanneer de geschatte context ratio `softTrimRatio` kruist.
    Daarna moet je de oudste geschikte tool wissen wanneer de geschatte context ratio `hardClearRatio` **en**
    overschrijdt. Er is genoeg schattige tool-resultaat bulk (`minPrunableToolChars`).
  - `agressieve`: vervangt altijd geschikte gereedschap resultaten voor de cutoff door `hardClear.placeholder` (geen ratio controleerd).

Soft vs hard snoeien (welke wijzigingen in de context verzonden naar het LLM):

- Soft-trim\*\*: alleen voor _overgrootte_ werkresultaten. Houdt het begin + einde en voegt `...` in het midden.
  - Voor: `toolResult("…zeer lange uitvoer…")`
  - Na: `toolResult("HEAD…\n...\n…TAIL\n\n[Resultaat Gereedschap: …]")`
- **Hard-clear**: vervangt het volledige resultaat door de placeholder.
  - Voor: `toolResult("…zeer lange uitvoer…")`
  - Nade: `toolResult("[Oude tool result content cleared]")`

Opmerkingen / huidige beperkingen:

- Resultaten met **afbeeldingsblokken worden overgeslagen** (nooit ingekort) op dit moment.
- De geschatte "context ratio" is gebaseerd op **karakters** (bij benadering inbegrepen), niet op exacte tokens.
- Als de sessie ten minste `keepLastAssistants` assistenten nog niet bevat, wordt printen overgeslagen.
- In de `agressive` modus, wordt `hardClear.enabled` genegeerd (geschikte tool resultaten worden altijd vervangen door `hardClear.placeholder`).

Standaard (adaptief):

```json5
{
  agents: { contextPruning: { mode: "adaptive" } },
 } } } } } } } } } } } } } }
```

Om uit te schakelen:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } },
 } } } } } } } } } } } } } }
```

Standaard (wanneer `mode` `"adaptive"` of `"agressieve"` is):

- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3` (alleen adaptief)
- `hardClearRatio`: `0.5` (alleen adaptief)
- `minPrunableToolChars`: `50000` (alleen adaptief)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (alleen adaptief)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

Voorbeeld (agressief, minimaal):

```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } },
 } } } } } } } } } }
```

Voorbeeld (adaptief afgestemd):

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastLastAssistants: 3,
        softTrimRatio: 0. ,
        hardClearRatio: 0. ,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { ingeschakeld: waar, placeholder: "[Oude tool result content cleared]" },
        // Optioneel: beperken tot specifieke tools (weiger wins; ondersteunt "*" jokertekens)
        hulpmiddelen: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

Zie [/concepts/session-pruning](/concepts/session-pruning) voor gedragsdetails.

#### `agents.defaults.compaction` (reserveer hoofdkamer + geheugen flush)

`agents.defaults.compaction.mode` selecteert de compactie samenvattingsstrategie. Standaard `default`; stel \`security in om chunked summarization in te schakelen voor zeer lange histories. Zie [/concepts/compaction](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor` forceert een minimum `reserveTokens`
waarde voor Pi compactie (standaard: `20000`). Zet het op `0` om de vloer uit te schakelen.

`agents.defaults.compaction.memoryFlush` draait een **silent** agentische draai voor
auto-compactie, die het model instrueert om duurzame herinneringen op te slaan op schijf (bijv.
`memory/YY-MM-D.md`). Het activeert wanneer de sessie token een
zachte drempel overschrijdt onder de compactie limiet.

Legacy standaard:

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: ingebouwde standaard met `NO_REPLY`
- Opmerking: de geheugenflush wordt overgeslagen wanneer de sessie-werkruimte alleen-lezen-
  (`agents.defaults.sandbox.workspaceAccess: "ro"` or `"none"`).

Voorbeeld (aangepast):

```json5
{
  agents: {
    defaults: {
      komaction: {
        mode: "security d",
        reserveTokensFloor: 24000,
        geheugenFlush: {
          ingeschakeld: waar,
          softThresholdTokens: 6000,
          systemPrompt: "Sessie nadert compact. Sla duurzame herinneringen nu op.",
          prompt: "Schrijf blijvende notities naar geheugen/YYYY-MM-DD. ; antwoord met NO_REPLY als er niets op te slaan is. ,
        },
      },
    },
  },
}
```

Blokkeer streamen:

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (standaard uit).

- Kanaal overschrijven: `*.blockStreaming` (en per-account varianten) om streaming gedwongen aan of uit te schakelen.
  Voor niet-Telegram-kanalen zijn expliciete `*.blockStreaming: true` nodig om antwoorden te blokkeren.

- `agents.defaults.blockStreamingBreak`: `"text_end"` or `"""message_end"` (standaard: text_end).

- `agents.defaults.blockStreamingChunk`: soft chunking voor gestreamde blokken. Standaard
  800–1200 tekens, geeft de voorkeur aan alinea-pauzes (`\n\n`), dan nieuwkomers, en vervolgens zinnen.
  Voorbeeld:

  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
   } }
  ```

- `agents.defaults.blockStreamingCoalesce`: voeg gestreamde blokken samen voor het verzenden.
  Standaard ingesteld op `{ idleMs: 1000 }` en erft `minChars` van `blockStreamingChunk`
  met `maxChars` gemaximaliseerd aan het kanaal tekstlimiet. Signal/Slack/Discord/Google Chat standaard
  naar `minChars: 1500` tenzij dit wordt overschreven.
  Channel overrides: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`,
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,
  `channels.googlechat.blockStreamingCoalesce`
  (and per-account variants).

- `agents.defaults.humanDelay`: willekeurige pauze tussen **blok antwoorden** na de eerste.
  Modes: `off` (standaard), `natuurlijk` (800–2500ms), `custom` (gebruik `minMs`/`maxMs`).
  Overschrijven Per-agent: `agents.list[].humanDelay`.
  Voorbeeld:

  ```json5
  {
    agents: { humanDelay: { mode: "natural" } },
   } } } } } } } } } } } } }
  ```

  Zie [/concepts/streaming](/concepten/streaming) voor gedrag + details in stukken snijden.

Typen indicatoren:

- `agents.defaults.typingMode`: `"nooit" Onmiddellijk "instant" (INT "bezinnen"! bericht"`. Standaard
  `instant` voor directe chats / vermeldingen en `message` voor ongenoemde groeps-chats.
- `session.typingMode`: per-session override voor de modus.
- `agents.defaults.typingIntervalSeconds`: hoe vaak het typingssignaal wordt vernieuwd (standaard: 6s).
- `session.typingIntervalSeconds`: per sessie overschrijving voor de refresh interval.
  Zie [/concepts/typing-indicators](/concepten/typing-indicators) voor gedragsdetails.

`agents.defaults.model.primary` moet worden ingesteld als `provider/model` (bijv. `anthropic/claude-opus-4-6`).
Aliassen komen van `agents.defaults.models.*.alias` (bijv. `Opus`).
Als u de provider weglaat, veronderstelt OpenClaw momenteel `antthropic` als een tijdelijke
deprecation fallback.
Z.AI modellen zijn beschikbaar als `zai/<model>` (bijv. `zai/glm-4.7`) en vereisen
`ZAI_API_KEY` (of legacy `Z_AI_API_KEY`) in de omgeving.

`agents.defaults.heartbeat` configureert periodieke heartbeat runs:

- `every`: duration string (`ms`, `s`, `m`, `h`); standaard unit minuten. Standaard:
  `30m`. Zet `0m` om uit te schakelen.
- `model`: optioneel override model voor heartbeat run (`provider/model`).
- `includeReasoning`: Wanneer `true`, zal heartbeats ook het aparte `Reasoning:` bericht leveren indien beschikbaar (dezelfde vorm als `/reasoning on`). Standaard: `false`.
- `session`: optionele sessie sleutel om te bepalen in welke sessie de heartbeat plaatsvindt. Standaard: `main`.
- `to`: optionele ontvanger override (kanaal-specifieke id, bijv. E.164 voor WhatsApp, chat id voor Telegram).
- `target`: optioneel uitleveringskanaal (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). Standaard: `laatste`.
- `prompt`: optionele overschrijving voor het hart-lichaam (standaard: `Lees HEARTBEAT.md als het bestaat (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Overrides worden verbatim verzonden; inclusief een `Lees HEARTBEAT.md` regel als je het bestand nog wilt lezen.
- `ackMaxChars`: max tekens toegestaan na `HEARTBEAT_OK` voor levering (standaard: 300).

Per-agent heartbeats:

- Stel `agents.list[].heartbeat` in of overschrijf hartebeat instellingen voor een specifieke agent.
- Als een agent item `heartbeat` definieert, **alleen die agents** draaien hartbekken; standaard
  wordt de gedeelde baseline voor die agents.

Heartbeats voeren volledige agent-beurten uit. Korter intervallen branden meer tokens; wees bewust
van `every`, behoud `HEARTBEAT.md` tiny, en/of kies een goedkoper `model`.

`tools.exec` configureert achtergrond-exec standaarden:

- `backgroundMs`: tijd voor auto-achtergrond (ms, standaard 10000)
- `timeoutSec`: auto-kill na deze runtime (seconden, standaard 1800)
- `cleanupMs`: hoe lang de beëindigde sessies in het geheugen te houden (ms, standaard 1800000)
- `notifyOnExit`: enque een systeem event + verzoek hartebeat wanneer de achtergrond exec exits (standaard waar)
- `applyPatch.enabled`: schakel experimentele `apply_patch` in (alleen OpenAI/OpenAI Codex; standaard false)
- `applyPatch.allowModels`: optionele allowlist van model id's (bijv. `gpt-5.2` of `openai/gpt-5.2`)
  Opmerking: `applyPatch` staat alleen onder `tools.exec`.

`tools.web` configureert web search + fetch tools:

- `tools.web.search.enabled` (standaard: true wanneer de sleutel aanwezig is)
- `tools.web.search.apiKey` (aanbevolen: set via `openclaw configureren --section web`, of gebruik `BRAVE_API_KEY` env var)
- `tools.web.search.maxResults` (1-10, standaard 5)
- `tools.web.search.timeoutSeconds` (standaard 30)
- `tools.web.search.cacheTtlMinutes` (standaard 15)
- `tools.web.fetch.enabled` (standaard waar)
- `tools.web.fetch.maxChars` (standaard 50000)
- `tools.web.fetch.maxCharsCap` (standaard 50000; duwt maxChars in config/tool calls)
- `tools.web.fetch.timeoutSeconds` (standaard 30)
- `tools.web.fetch.cacheTtlMinutes` (standaard 15)
- `tools.web.fetch.userAgent` (optionele override)
- `tools.web.fetch.readability` (standaard waar; uitschakelen om alleen HTML opruimen te gebruiken)
- `tools.web.fetch.firecrawl.enabled` (standaard waar wanneer een API sleutel is ingesteld)
- `tools.web.fetch.firecrawl.apiKey` (optioneel; standaard `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (standaard [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (standaard waar)
- `tools.web.fetch.firecrawl.maxAgeMs` (optioneel)
- `tools.web.fetch.firecrawl.timeoutSeconds` (optioneel)

`tools.media` configureert inkomende media-begrip (image/audio/video):

- `tools.media.models`: gedeelde modellijst (capability-tagged; gebruikt na per-cap lists).
- `tools.media.concurrency`: max gelijktijdige capaciteit draait (standaard 2).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - `enabled`: opt-out schakelaar (standaard true wanneer modellen zijn geconfigureerd).
  - `prompt`: optioneel prompt override (afbeelding / video voeg automatisch een `maxChars` hint toe).
  - `maxChars`: max output karakters (standaard 500 voor image/video; unset voor audio).
  - `maxBytes`: max mediagrootte om te verzenden (standaard: afbeelding 10MB, audio 20MB, video 50MB).
  - `timeoutSeconds`: verzoektime-out (standaard: afbeelding 60s, audio 60s, video 120s).
  - `language`: optionele audio hint.
  - `attachments`: attachment policy (`mode`, `maxAttachments`, `prefer`).
  - `scope`: optionele gating (eerste match wint) met `match.channel`, `match.chatType`, of `match.keyPrefix`.
  - `models`: geordende lijst van model items; mislukte of te grote media vallen terug naar de volgende invoer.
- Elke `models[]` invoer:
  - Zoekmachine item (`type: "provider"` of weggelaten):
    - `provider`: API providerid (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc).
    - `model`: model id override (vereist voor afbeelding; standaard `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo` voor audio providers, en `gemini-3-flash-preview` voor video).
    - `profile` / `preferredProfile`: authprofiel selectie.
  - CLI item (\`type: "cli"):
    - `command`: uitvoerbaar om te gebruiken.
    - `args`: getemplated args (ondersteund `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).
  - `capabilities`: optionele lijst (`image`, `audio`, `video`) om een gedeelde invoer te gaten. Standaard wanneer weggewezen: `openai`/`anthropic`/`minimax` → afbeelding, `google` → image+audio+video, `groq` → audio.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` kan worden overschreven per invoer.

Als geen modellen zijn geconfigureerd (of `enabled: false`), wordt begrip overgeslagen; het model ontvangt nog steeds de oorspronkelijke bijlagen.

Provider authenticatie volgt de standaard model auth-volgorde (auth-profielen, env vars zoals `OPENAI_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, of `models.*.apiKey`).

Voorbeeld:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: waar,
        maxBytes: 20971520,
        toepassingsgebied: {
          standaard: "weigeren",
          regels: [{ actie: "toestaan", match: { chatType: "direct" } }],
        },
        modellen: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "fluister", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        ingeschakeld: waar,
        maxBytes: 52428800,
        modellen: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` configureert sub-agent standaard:

- `model`: standaard model voor spawned sub-agents (string of `{ primary, fallbacks }`). Indien weggelaten erft subagenten het model van de caller, tenzij dit wordt overschreven per agent of per oproep.
- `maxConcurrent`: max gelijktijdige sub-agent draait (standaard 1)
- `archiveAfterMinutes`: auto-archiveer sub-agent sessies na N minuten (standaard 60; zet `0` om uit te schakelen)
- Functiebeleid Per-subagent: `tools.subagents.allow` / `tools.subagents.tools.deny` (geen wins)

`tools.profile` zet een **base tool allowlist** voor `tools.allow`/`tools.deny`:

- `minimal`: alleen `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: geen beperking (zelfde als niet ingesteld)

Per-agent override: `agents.list[].tools.profile`.

Voorbeeld (standaard alleen messaging, maar ook Slack + Discord-tools toestaan):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Voorbeeld (coding-profiel, maar exec/process overal weigeren):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

`tools.byProvider` laat je tools voor specifieke aanbieders **verder beperken** (of een enkele `provider/model`).
Per-agent override: `agents.list[].tools.byProvider`.

Bestelling: basisprofiel → providerprofiel → beleid toestaan/weigeren.
Provider keys accepteren `provider` (bijv. `google-antigravity`) of `provider/model`
(bijv. `openai/gpt-5.2`).

Voorbeeld (globaal coding-profiel behouden, maar minimale tools voor Google Antigravity):

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

Voorbeeld (provider/model-specifieke allowlist):

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

`tools.allow` / `tools.deny` configureer een globale tool allow/deny policy (weiger wins).
Overeenkomen is hoofdletterongevoelig en ondersteunt `*` jokertekens (`"*"` betekent alle tools).
Dit wordt toegepast, zelfs als de Docker sandbox **uit** is.

Voorbeeld (schakel browser/canvas overal uit):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

Hulpgroepen (shorthands) werken in **global** en **per agent** instrumentbeleid:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle ingebouwde OpenClaw-tools (sluit provider-plugins uit)

`tools.elevated` besturingselementen verheven (host) exec access:

- `ingeschakeld`: verhoogde modus toestaan (standaard true)
- `allowFrom`: per-channel allowlists (leeg = uitgeschakeld)
  - `whatsapp`: E.164 getallen
  - `telegram`: chat ids of gebruikersnamen
  - `discord`: user ids of usernames (val terug naar `channels.discord.dm.allowFrom` indien niet aanwezig)
  - `signaal`: E.164 getallen
  - `imessage`: handles/chat ids
  - `webchat`: sessie ids of gebruikersnamen

Voorbeeld:

```json5
{
  hulpmiddelen: {
    hoog: {
      ingeschakeld: waar,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steihuis", "1234567890123"],
      },
    },
  },
}
```

Overschrijven per agent (verdere beperking):

```json5
{
  agents: {
    lijst: [
      {
        id: "familie",
        hulpmiddelen: {
          hoog: { enabled: false },
        },
      },
    ],
  },
}
```

Notities:

- `tools.elevated` is de globale baseline. `agents.list[].tools.elevated` kan alleen verder beperken (beide moeten toestaan).
- \`/hooggelegen oplaadstand per sessie sleutel; inlinerichtlijnen zijn van toepassing op één enkel bericht.
- Verhoogd `exec` draait op de host en bypasses sandboxing.
- Het gereedschapsbeleid is nog steeds van toepassing; als 'exec' wordt geweigerd, kan de hoogte niet worden gebruikt.

`agents.defaults.maxConcurrent` bepaalt het maximum aantal ingebedde agenten dat
in parallelle sessies kan uitvoeren. Elke sessie is nog steeds geserialiseerd (één uitvoeren
per sessie sleutel tegelijk). Standaard: 1.

### `agents.defaults.sandbox`

Optionele **Docker sandboxing** voor het ingesloten agent. Bedoeld voor niet-hoofd
sessies zodat ze geen toegang hebben tot uw hosting-systeem.

Details: [Sandboxing](/gateway/sandboxing)

Standaardwaarden (indien ingeschakeld):

- scope: `"agent"` (één container + werkruimte per agent)
- Debiaanse boekenworm-slim gebaseerde afbeelding
- agent werkruimte toegang: `workspaceAccess: "none"` (standaard)
  - `"none": gebruik een sandbox werkruimte per bereik onder `~/.openclaw/sandboxes\`
- `"ro"`: behoud de sandbox werkruimte op `/workspace`, en koppel de agent werkruimte read-only op `/agent` (schakelt `write`/`edit`/`apply_patch`)
  - `"rw": mount the agent workspace read/write at at `/workspace\`
- automatisch opruimen: inactief > 24u OF leeftijd > 7d
- tool policy: alleen `exec`, `process`, `read`, `edit`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_status` (deny wins)
  - configureren via `tools.sandbox.tools`, override per-agent via `agents.list[].tools.sandbox.tools`
  - tool group shorthands ondersteund in sandbox beleid: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (zie [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- optionele sandboxed browser (Chromium + CDP, noVNC observer)
- hardening knobs: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmormorProfile`

Waarschuwing: `scope: "gedeeld"` betekent een gedeelde container en gedeelde werkruimte. Geen
kruissessie isolatie. Gebruik `scope: "session"` voor per-session isolatie.

Legacy: `perSession` wordt nog steeds ondersteund (`true` → `scope: "session"`,
`false` → `scope: "Gedeelt"`).

`setupCommand` draait **once** nadat de container is gemaakt (binnen de container via `sh -lc`).
Zorg ervoor dat de netwerkegress, een beschrijfbare root FS, en een rootgebruiker worden geïnstalleerd

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // korting Onafhankelijk van niet-hoofdindex alle
        toepassingsgebied: "agent", // Sessieliemand, gedeeld (agent is standaard)
        workspaceAccess: "geen", // geen ½ ro wwrw
        workspaceRoot: "~/. penclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: waar,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          netwerk: "geen",
          gebruiker: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C. TF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent overschrijven (multi-agent): agents. ist[].sandbox.docker.
          Pidslimiet: 256,
          geheugen: "1g",
          geheugenSwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp. son",
          apmorProfile: "openclaw-sandbox",
          dns: ["1. .1.1", "8.8. "],
          extraHosts: ["internal.service:10.0.0. "],
          binds: ["/var/run/docker.sock:/var/run/docker. ock", "/home/user/source:/source:rw"],
        },
        browser: {
          ingeschakeld: false,
          afbeelding: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          hoofdstuk: onjuist,
          enableNoVnc: waar,
          Staat HostControl: false,
          allowedControlUrls: ["http://10. .0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0. 2"],
          toegestane Bedieningspoorten: [18791],
          autostart: waar,
          autoStartTimeouts: 12000,
        },
        prune: {
          idleHours: 24, // 0 schakelt inactieve printing
          maxAgeDays: 7, // 0 schakelt max-age pruning
        } uit,
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "proces",
          "lezen",
          "schrijven",
          "bewerken",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        weigering: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Bouw éénmaal de standaard sandbox-afbeelding:

```bash
scripts/sandbox-setup.sh
```

Opmerking: sandbox containers standaard op `netwerk: "none"`; zet `agents.defaults.sandbox.docker.netwerk`
op `"bridge"` (of je eigen netwerk) als de agent uitgaande toegang nodig heeft.

Opmerking: inkomende bijlagen bevinden zich in de actieve werkruimte op `media/binnenland/*`. Met `workspaceAccess: "rw"`, dat betekent dat bestanden in de agent worden geschreven.

Opmerking: `docker.binds` koppelt extra host directories; globale en per-agent binds worden samengevoegd.

Bouw de optionele browserafbeelding met:

```bash
scripts/sandbox-browser-setup.sh
```

Wanneer `agents.defaults.sandbox.browser.enabled=true`, gebruikt de browsertool een sandboxed
Chromium-instantie (CDP). Als noVNC is ingeschakeld (standaard wanneer headless=false),
de noVNC URL wordt geïnjecteerd in het systeem prompt zodat de agent het kan verwijzen.
Dit vereist geen `browser.enabled` in het hoofd config; de sandbox control
URL is geïnjecteerd per sessie.

`agents.defaults.sandbox.browser.allowHostControl` (standaard: false) stelt
sandboxed sessies in staat om expliciet op de **host** browser control server
te richten via de browser tool (`target: "host"`). Laat dit af als je een strikt
sandbox-isolatie wil.

Lijsten toestaan voor extern besturingselement:

- `allowedControlUrls`: exacte URL's toegestaan voor `target: "custom"`.
- `allowedControlHosts`: hostnamen toegestaan (hostnaam alleen, geen poort).
- `allowedControlPorts`: poorten toegestaan (standaardwaarden: http=80, https=443).
  Standaard: alle toegestane lijsten zijn uitgeschakeld (geen beperking). `allowHostControl` standaard is niet waar.

### `model` (custom providers + base URLs)

OpenClaw maakt gebruik van de **pi-coding-agent** modelcatalogus. U kunt aangepaste aanbieders
(LiteLLM, lokale OpenAI-compatibele servers, Anthropische proxes, enz.) toevoegen door
`~/.openclaw/agents/<agentId>/agent/models.json` te schrijven of door hetzelfde schema te definiëren in je
OpenClaw config onder `models.providers`.
Overzicht van de aanbieder-door-provider + voorbeelden: [/concepts/model-providers](/concepts/model-providers).

Wanneer `models.providers` aanwezig is, schrijft OpenClaw schrijven/voegt een `models.json` samen met
`~/.openclaw/agents/<agentId>/agent/` bij het opstarten:

- standaard gedrag: **samengevoegd** (houdt bestaande providers, overschrijft op naam)
- zet `models.mode: "replace"` om de bestandsinhoud te overschrijven

Selecteer het model via `agents.defaults.model.primary` (provider/model).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3. -8b" },
      models: {
        "custom-proxy/llama-3. -8b": {},
      },
    },
  },
  modellen: {
    modus: "samenvoegen",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completies",
        modellen: [
          {
            id: "llama-3. -8b",
            naam: "Llama 3. 8B",
            redenering: false,
            invoer: ["tekst"],
            kosten: { invoer: 0, uitvoer: 0, cacheRead: 0, cacheWrite: 0 },
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

OpenCode Zen is een multi-model gateway met per-model eindpunten. OpenClaw gebruikt
de ingebouwde `opencode` provider van pi-ai; zet `OPENCODE_API_KEY` (of
`OPENCODE_ZEN_API_KEY`) van [https://opencode.ai/auth](https://opencode.ai/auth).

Notities:

- Model refs gebruik `opencode/<modelId>` (voorbeeld: `opencode/claude-opus-4-6`).
- Als u een allowlist inschakelt via `agents.defaults.models`, voeg dan elk model toe dat u van plan bent te gebruiken.
- Snelkoppeling: `openclaw onboard --auth-choice opencode-zen`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

### Z.AI (GLM-4.7) - provider alias ondersteuning

Z.AI modellen zijn beschikbaar via de ingebouwde `zai` provider. Zet `ZAI_API_KEY`
in uw omgeving en verwijs naar het model per provider/model.

Snelkoppeling: `openclaw onboard --auth-choice zai-api-key`.

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

Notities:

- `z.ai/*` en `z-ai/*` zijn geaccepteerde aliassen en normaliseer naar `zai/*`.
- Als `ZAI_API_KEY` ontbreekt, zullen verzoeken naar `zai/*` mislukken met een authenticatiefout tijdens het runtime.
- Voorbeeld fout: `Geen API-sleutel gevonden voor provider "zai".`
- Z.AI's algemene API eindpunt is `https://api.z.ai/api/paas/v4`. GLM coding
  verzoeken gebruiken het dedicated Coding endpoint `https://api.z.ai/api/coding/paas/v4`.
  De ingebouwde `zai` provider maakt gebruik van het eindpunt van de code. Als u het algemene
  eindpunt nodig heeft, definieer dan een aangepaste provider in `models.providers` met de base URL
  override (zie de aangepaste providers sectie hierboven).
- Gebruik valse placeholder in documenten/config; commit nooit echte API-sleutels.

### Moonshot AI (Kimi)

Gebruik het OpenAI-compatibele eindpunt van Moonshot:

```json5
{
  env: { MOONSHOT_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2. " },
      models: { "moonshot/kimi-k2. ": { alias: "Kimi K2. " } },
    },
  },
  models: {
    modus: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api. oonschot. i/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completies",
        modellen: [
          {
            id: "kimi-k2. ",
            naam: "Kimi K2. ",
            redenering: false,
            invoer: ["tekst"],
            kosten: { invoer: 0, uitvoer: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notities:

- Zet `MOONSHOT_API_KEY` in de omgeving of gebruik `openclaw onboard --auth-choice moonshot-api-key`.
- Model ref: `moonshot/kimi-k2.5`.
- Voor het eindpunt van China:
  - Voer `openclaw onboard --auth-choice moonshot-api-key-cn` uit (wizard zal `https://api.moonshot.cn/v1` instellen), of
  - Zet handmatig `baseUrl: "https://api.moonshot.cn/v1"` in `models.providers.moonshot`.

### Kimi Coding

Gebruik het moonshot AI's Kimi Coding endpoint (anthropic-compatibel, ingebouwde provider):

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

Notities:

- Zet `KIMI_API_KEY` in de omgeving of gebruik `openclaw onboard --auth-choice kimi-code-api-key`.
- Model ref: `kimi-coding/k2p5`.

### Synthetisch (anthropic-compatibel)

Gebruik synthetisch antroping-compatibel eindpunt:

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

Notities:

- Stel `SYNTHETIC_API_KEY` in of gebruik `openclaw onboard --auth-choice synthetic-api-key`.
- Model ref: `synthetisch/hf:MiniMaxAI/MiniMax-M2.1`.
- Basis URL moet `/v1` weglaten omdat de Anthropische client deze toevoegt.

### Lokale modellen (LM Studio) - aanbevolen instelling

Bekijk [/gateway/local-models](/gateway/local-models) voor de huidige lokale handleiding. TL;DR: voer MiniMax M2.1 uit via LM Studio Responses API met ernstige hardware; houd gehoste modellen samengevoegd voor fallback.

### MiniMax M2.1

Gebruik MiniMax M2.1 direct zonder LM Studio:

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2. " },
    models: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2. ": { alias: "Minimax" },
    },
  },
  models: {
    modus: "samenvoegen",
    providers: {
      minimax: {
        baseUrl: "https://api. onmax. o/antthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-berichten",
        modellen: [
          {
            id: "MiniMax-M2. ",
            naam: "MiniMax M2. ",
            redenering: false,
            invoer: ["tekst"],
            // Prijs: update in modellen. zoon als je exacte kosten nodig hebt.
            kosten: { invoer: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notities:

- Stel `MINIMAX_API_KEY` omgevingsvariabele in of gebruik `openclaw onboard --auth-choice minimax-api`.
- Beschikbaar model: `MiniMax-M2.1` (standaard).
- Werk de prijzen bij in `models.json` als je exacte kosten tracking nodig hebt.

### Granen (GLM 4.6 / 4.7)

Gebruik Cerebras via hun OpenAI-compatibel eindpunt:

```json5
{
  env: { CEREBRAS_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: {
        primair: "cerebras/zai-glm-4. ",
        terugvalt: ["cerebras/zai-glm-4. "],
      },
      models: {
        "cerebras/zai-glm-4. ": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4. (Cerebras)" },
      },
    },
  },
  models: {
    modus: "samenvoegen",
    providers: {
      cerebras: {
        baseUrl: "https://api. erebras. i/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completies",
        models: [
          { id: "zai-glm-4. ", naam: "GLM 4. (Cerebras)" },
          { id: "zai-glm-4.6", naam: "GLM 4. (Cerebras)" },
        ],
      },
    },
  },
}
```

Notities:

- Gebruik `cerebras/zai-glm-4.7` voor Cerebras; gebruik `zai/glm-4.7` voor Z.AI direct.
- Zet `CEREBRAS_API_KEY` in de omgeving of configureer.

Notities:

- Ondersteunde API's: `openai-completions`, `openai-respons`, `anthropic-messages`,
  `google-generative-ai`
- Gebruik `authHeader: true` + `headers` voor aangepaste autorisaties.
- Overschrijf de agent config root met `OPENCLAW_AGENT_DIR` (of `PI_CODING_AGENT_DIR`)
  als je `models.json` elders wilt opslaan (standaard: `~/.openclaw/agents/main/agent`).

### `sessie`

Bepaalt sessiesscope, reset beleid, reset triggers, en waar de sessie-winkel is geschreven.

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      altijd: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "dagelijkse",
      atUur: 4,
      idleMinuts: 60,
    },
    resetByType: {
      thread: { mode: "dagelijkse", atUur: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      groep: { mode: "inactief", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // standaard is al per-agent onder ~/. penclaw/agents/<agentId>/sessions.json
    // Je kunt overschrijven met {agentId} template:
    winkel: "~/. penclaw/agents/{agentId}/sessions.json",
    // Direct chats collapse to agent:<agentId>:<mainKey> (standaard: "main").
    mainKey: "main",
    agentToAgent: {
      // Max ping-pong-antwoord draait tussen aanvrager/doel (0–5).
      maxPingPongTurns: 5,
    },
    verzendbeleid: {
      regels: [{ actie: "deny", match: { channel: "discord", chatType: "groep" } }],
      standaard: "toestaan",
    },
  },
}
```

Velden

- `mainKey`: direct-chat bucket sleutel (standaard: `"main"`). Nuttig wanneer je de primaire DM thread wilt "hernoemen" zonder `agentId` te veranderen.
  - Sandbox notitie: `agents.defaults.sandbox.mode: "niet-main" gebruikt deze sleutel om de hoofdsessie te detecteren. Elke sessiesleutel die niet overeenkomt met `mainKey\` (groepen/kanalen) is sandboxed.
- `dmScope`: hoe DM sessies gegroepeerd zijn (standaard: `"main"`).
  - `main`: alle DMs delen de hoofdsessie voor continuïteit.
  - `per-peer`: isoleer DMs door afzender-id via verschillende kanalen.
  - `per-channel-peer`: isoleer DMs per kanaal + afzender (aanbevolen voor multi-user inboxes).
  - `per-account-channel-peer`: isoleer DMs per account + kanaal + afzender (aanbevolen voor postvak in meerdere accounts).
  - Secure DM mode (aanbevolen): zet `session.dmScope: "per-channel-peer"` wanneer meerdere mensen de bot kunnen PM (shared inboxes, multi-person allowlists, or `dmPolicy: "open"`).
- `identityLinks`: kaart canonical ids aan provider-prefixed peers zodat dezelfde persoon een DM sessie deelt over kanalen wanneer hij `per-peer`, `per-channel-peer` of `per-account-channel-peer` gebruikt.
  - Voorbeeld: `alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `reset`: primair herstelbeleid. Standaard ingesteld op dagelijkse resets om 4:00 uur lokale tijd op de gateway host.
  - `mode`: `daily` or `idle` (standaard: `daily` wanneer `reset` aanwezig is).
  - `atHour`: lokaal uur (0-23) voor de dagelijkse reset grens.
  - `idleMinutes`: glijden inactief venster in minuten. Als dagelijkse + inactiviteit beide zijn geconfigureerd, wint degene die het eerst verloopt.
- `resetByType`: per-session overrides voor `dm`, `group`, and `thread`.
  - Als u alleen oudere `session.idleMinutes` hebt ingesteld zonder `reset`/`resetByType`, blijft OpenClaw in idle-only modus voor backward compatibiliteit.
- `heartbeatIdleMinutes`: optionele inactieve overschrijving voor hartebeat controles (dagelijkse reset is nog steeds van toepassing wanneer ingeschakeld).
- `agentToAgent.maxPingPongTurns`: max Reply-back draait tussen aanvrager/doel (0–5, standaard 5).
- `sendPolicy.default`: `allow` or `deny` fallback when no rule matches.
- `sendPolicy.rules[]`: match by `channel`, `chatType` (`directvoices groupquad room`), of `keyPrefix` (bijv. `cron:`). Eerste weigering van winden; anders toestaan.

### `vaardigheden` (vaardigheden configuratie)

Bediening bundelde toegestane lijst, installeer voorkeuren, extra vaardigheidsmappen, en per vaardigheids
overrides. Van toepassing op **gebundelde** vaardigheden en `~/.openclaw/vaardigheden` (werkruimte
wint nog steeds bij naamconflicten).

Velden

- `allowBundled`: optionele toegestane lijst voor **alleen gebundelde** skills. Als dit is ingesteld, komen alleen die
  gebundelde vaardigheden in aanmerking (beheerde/werkruimte vaardigheden zijn ongebeïnvloedd).
- `load.extraDirs`: aanvullende skill-mappen om te scannen (laagste prioriteit).
- `install.preferBrew`: geef de voorkeur aan brew-installers wanneer beschikbaar (standaard: true).
- `install.nodeManager`: node installer preferentie (`npm` ρ`pnpm`yarn\`, default: npm).
- `entries.<skillKey>`: per-skill configuratie overschrijven.

Velden per skill:

- `enabled`: stel `false` in om een skill uit te schakelen, zelfs als deze gebundeld/geïnstalleerd is.
- `env`: omgevingsvariabelen die worden geïnjecteerd voor de agent-run (alleen als ze nog niet zijn ingesteld).
- `apiKey`: optioneel gemak voor vaardigheden die een primaire env var verklaren (bijv. `nano-banana-pro` → `GEMINI_API_KEY`).

Voorbeeld:

```json5
{
  vaardigheden: {
    allowBundled: ["gemini", "peekaboo"],
    Laden: {
      extraDirs: ["~/Projects/agent-scripts/vaardigheden", "~/Projects/os/some-skill-pack/vaardigheden"],
    },
    installatie: {
      preferBrew: waar,
      nodeManager: "npm",
    },
    invoeren: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboos: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

### `plugins` (extensies)

Controleert plugin ontdekking, toestaan/weiger en per plugin configuratie. Plugins zijn geladen
van `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, plus any
`plugins.load.paths` items. **Config wijzigingen vereisen een gateway herstart.**
Zie [/plugin](/tools/plugin) voor volledig gebruik.

Velden

- `enabled`: hoofdschakelaar voor laden van plugin (standaard: true).
- `Toestaan`: optionele toegestane lijst van plugin ids; indien ingesteld, alleen plugins laden.
- `deny`: optionele denylist van plugin id's (weigering van wins).
- `load.paths`: extra plugin bestanden of mappen om te laden (absoluut of `~`).
- `invoert.<pluginId>`: per-plugin overschrijven.
  - `ingeschakeld`: stel `false` in om uit te schakelen.
  - `config`: plugin-specifieke config object (gevalideerd door de plugin indien opgegeven).

Voorbeeld:

```json5
{
  plugins: {
    enabled: true
    allow: ["voice-call"],
    Laden: {
      paden: ["~/Projects/oss/voice-call-extension"],
    },
    invoer: {
      "voice-call": {
        ingeschakeld: waar,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser` (openclaw-managed browser)

OpenClaw kan beginnen met een **toegewijd, geïsoleerde** Chrome/Brave/Edge/Chromium installatie voor openclaw en een kleine loopbackcontrol service blootstellen.
Profielen kunnen naar een Chrome-gebaseerde browser op **remote** wijzen via `profielen.<name>.cdpUrl`. Externe
profielen zijn alleen bijlage (start/stop/reset is uitgeschakeld).

`browser.cdpUrl` blijft voor legacy single profiel configs en als het basis
schema/host voor profielen die alleen `cdpPort` instellen.

Standaarden:

- enabled: `true`
- evaluateEnabled: `true` (set `false` om `act:evaluate` en `wacht --fn`) uit te schakelen
- service: alleen loopback (poort afgeleid van `gateway.port`, standaard `18791`)
- CDP URL: `http://127.0.1:18792` (control service + 1, legacy single-profiel)
- profielkleur: `#FF4500` (kreeft oranje)
- Opmerking: de control server is gestart door de lopende gateway (OpenClaw.app menubar of `openclaw gateway`).
- Auto-detecteer volgorde: standaard browser als Chromium-gebaseerd; anders Chrome → Brave → Edge → Chromium → Chrome Canary.

```json5
{
  browser: {
    ingeschakeld: waar,
    evaluateEnabled: waar,
    // cdpUrl: "http://127. .0. :18792", // legacy single profile override
    defaultProfile: "chrome",
    profielen: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      werkt: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10. .0.42:9222", kleur: "#00AA00" },
    },
    color: "#FF4500",
    // Geavanceerd:
    // headles: false,
    // noSandbox: false,
    // executablePath: "/Applicaties/Brave Browser. pp/Contents/MacOS/Brave Browser",
    // bijlage: onwaar, // zet waar wanneer een remote CDP wordt getunneld naar localhost
  },
}
```

### 'ui' (Goedgekeurd)

Optionele accentkleur die wordt gebruikt door de native apps voor UI-chrome (bijv. Talk-modus bubble tint).

Als dit niet is ingesteld, vallen klanten terug naar een gedempte lichtblauw.

```json5
{
  ui: {
    seamColor: "#FF4500", // hex (RRGGBB of #RRGGBB)
    // Optioneel: Control UI assistant identity override.
    // Indien niet ingesteld, gebruikt de Control UI de actieve medewerkeridentiteit (config of IDENTITY. d).
    assistent: {
      naam: "OpenClaw",
      avatar: "CB", // emoji, korte tekst, of afbeelding URL/data URI
    },
  },
}
```

### `gateway` (Gateway server mode + bind)

Gebruik `gateway.mode` om expliciet te verklaren of deze machine de Gateway moet uitvoeren.

Standaarden:

- modus: **unset** (behandeld als "niet automatisch starten")
- bind: `loopback`
- poort: `18789` (enkele poort voor WS + HTTP)

```json5
{
  gateway: {
    mode: "local", // of "remote"
    poort: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // gecontroleerd Ui: { enabled: true basePath: "/openclaw" }
    // auth: { mode: "token", token: "your-token" } // tokens poorten WS + Control UI toegang
    // tailscale: { mode: "off" ~"serve" ## "funnel" }
  }, }

```

Controle UI basispad:

- `gateway.controlUi.basePath` stelt de URL prefix in waar de Control UI wordt geserveerd.
- Voorbeelden: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- Standaard: root (`/`) (ongewijzigd).
- `gateway.controlUi.root` stelt de filesystem root voor Control UI assets in (standaard: `dist/control-ui`).
- `gateway.controlUi.allowInsecureAuth` staat token-only authenticatie voor de Control UI toe wanneer
  de apparaatidentiteit wordt weggelaten (meestal via HTTP). Standaard: `false`. Liever HTTPS
  (Tailscale Serve) of `127.0.0.1`.
- 'gateway.controlUi.gevaarlijk' yDisableDeviceAuth' schakelt identiteitscontroles voor de
  Control UI uit (alleen token/wachtwoord). Standaard: `false`. Alleen Breekglas

Gerelateerde documentatie:

- [Control UI](/web/control-ui)
- [Web overzicht](/web)
- [Tailscale](/gateway/tailscale)
- [Toegang op afstand](/gateway/remote)

Vertrouwde proxies:

- `gateway.trustedProxies`: lijst van reverse-proxy IPs die TLS voor de Gateway beëindigen.
- Wanneer een verbinding van een van deze IP-adressen komt, OpenClaw gebruikt `x-forwarded-for` (of `x-real-ip`) om de client IP te bepalen voor lokale pairing checks en HTTP auth/lokale controles.
- Laat alleen proxy's zien die u volledig beheert, en zorg ervoor dat ze **overwrite** inkomende `x-forwarded-voor` zijn.

Notities:

- `openclaw gateway` weigert te starten tenzij `gateway.mode` is ingesteld op `local` (of je passeert de override vlag).
- `gateway.port` controleert de enkele meervoudige poort die gebruikt wordt voor WebSocket + HTTP (bedien UI, hooks, A2UI).
- OpenAI Chat Voltooien eindpunt: **standaard uitgeschakeld**; in te schakelen met `gateway.http.endpoints.chatCompletions.enabled: true`.
- Voorkeur: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > standaard `18789`.
- Gateway authth is standaard vereist (token/wachtwoord of Tailscale Serve identiteit). Non-loopback binds vereisen een gedeelde token/wachtwoord.
- De onboarding wizard genereert standaard een gateway token (zelfs bij loopback).
- `gateway.remote.token` is **alleen** voor externe CLI aanroepen; het maakt geen lokale gateway auth. `gateway.token` wordt genegeerd.

Authenticatie en afmeting:

- `gateway.auth.mode` stelt de handshake vereisten in (`token` of `password`). Wanneer niet ingesteld, wordt token authenticatie aangenomen.
- `gateway.auth.token` slaat het gedeelde token voor token authenticatie op (gebruikt door de CLI op dezelfde machine).
- Wanneer `gateway.auth.mode` is ingesteld, wordt alleen die methode geaccepteerd (plus optionele Tailscale headers).
- `gateway.auth.password` kan hier ingesteld worden, of via `OPENCLAW_GATEWAY_PASSWORD` (aanbevolen).
- `gateway.auth.allowTailscale` staat Tailscale Serve identity headers
  (`tailscale-user-login`) toe om tevreden te zijn met authenticatie wanneer het verzoek op loopback
  komt met `x-forwarded-for`, `x-forwarded-proto`, en `x-forwarded-host`. Openklauw
  verifieert de identiteit door het `x-forwarded-voor` adres via
  `tailscale whois` op te lossen voordat je het accepteert. Wanneer `true`, Serve verzoeken geen
  een token/wachtwoord nodig hebben, zet `false` op expliciete inloggegevens. Standaard naar
  `true` wanneer `tailscale.mode = "serve"` en autorisatiemodus niet `wachtwoord` is.
- `gateway.tailscale.mode: "serve"` gebruikt Tailscale Serve (tailnet alleen, loopbackbind).
- `gateway.tailscale.mode: "funnel"` legt het dashboard publiek bloot; vereist auth.
- `gateway.tailscale.resetOnExit` reset Serve/Funnel config bij uitschakelen.

Standaardinstellingen voor externe client (CLI):

- `gateway.remote.url` stelt de standaard Gateway WebSocket URL voor CLI oproepen wanneer `gateway.mode = "remote"`.
- `gateway.remote.transport` selecteert macOS remote transport (`ssh` standaard, `direct` voor ws/wss). Wanneer `direct`, `gateway.remote.url` moet `ws://` of `wss://`. `ws://host` standaard op poort `18789`.
- `gateway.remote.token` vult het token in voor externe oproepen (laat deze niet ingesteld voor geen authenticatie).
- `gateway.remote.password` vult het wachtwoord in voor externe oproepen (laat deze niet instellen voor geen authenticatie).

macOS app gedrag:

- OpenClaw.app kijkt naar `~/.openclaw/openclaw.json` en schakelt modi live wanneer `gateway.mode` of `gateway.remote.url` verandert.
- Als `gateway.mode` is unset maar `gateway.remote.url` is ingesteld, behandelt de macOS app het als externe modus.
- Wanneer u de verbindingsmodus wijzigt in de macOS app, schrijft deze `gateway.mode` (en `gateway.remote.url` + `gateway.remote.transport` in de externe modus) terug naar het configuratiebestand.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      wachtwoord: "your-password",
    },
  },
}
```

Rechtstreeks transport voorbeeld (macOS app):

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "jouw-token",
    },
  },
}
```

### `gateway.reload` (Config hot reload)

De Gateway kijkt naar `~/.openclaw/openclaw.json` (of `OPENCLAW_CONFIG_PATH`) en past de wijzigingen automatisch toe.

Modi:

- `hybrid` (standaard): hot-apply veilige wijzigingen toe; herstart de Gateway voor kritieke veranderingen.
- `hot`: pas alleen hot-safe wijzigingen toe; log wanneer een herstart vereist is.
- `restart`: herstart de Gateway bij elke wijziging van de configuratie.
- `uit`: hot herladen uitschakelen.

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

#### Matrix voor snelle herladen (bestanden + impact)

Bekeken bestanden:

- `~/.openclaw/openclaw.json` (of `OPENCLAW_CONFIG_PATH`)

Hot-applied (geen volledige gateway herstart):

- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (Gmail watcher opnieuw gestart)
- `browser` (browser control server herstart)
- `cron` (cron service herstart + concurrency update)
- `agents.defaults.heartbeat` (heartbeat runner herstart)
- `web` (opnieuw opstarten WhatsApp)
- `telegram`, `discord`, `signal`, `imessage` (opnieuw starten)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `talk`, `identity`, `wizard` (dynamische reads)

Vereist volledige Gateway herstart:

- `gateway` (port/bind/auth/control UI/tailscale)
- `bridge` (erf)
- `discovery`
- `canvasHost`
- `plugins`
- Elk onbekend/niet-ondersteund configuratiepad (standaard om te herstarten voor veiligheid)

### Multi-instance isolatie

Voor het uitvoeren van meerdere gateways op één host (voor ontslag of een reddingsbode), isoleer de staat per instantie + config en gebruik unieke ports:

- `OPENCLAW_CONFIG_PATH` (per instantie config)
- `OPENCLAW_STATE_DIR` (sessies/credits)
- `agents.defaults.workspace` (geheugen)
- `gateway.port` (uniek per instantie)

Gunstige vlaggen (CLI):

- `openclaw --dev …` → gebruikt `~/.openclaw-dev` + shifts ports van base `19001`
- `openclaw --profile <name> …` → gebruikt `~/.openclaw-<name>` (poort via config/env/flags)

Zie [Gateway runbook] (/gateway) voor de afgeleide poort mapping (gateway/browser/canvas).
Zie [Meerdere gateways](/gateway/multiple-gateways) voor browser/CDP poort isolatie details.

Voorbeeld:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

### `hooks` (Gateway webhooks)

Schakel een eenvoudig HTTP webhook eindpunt in op de Gateway HTTP-server.

Standaarden:

- ingeschakeld: `false`
- pad: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    enabled: true
    token: "Shared-secret",
    pad: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/. penklauw/hooks",
    toewijzingen: [
      {
        match: { path: "gmail" },
        actie: "agent",
        wakeModus: "nu",
        naam: "Gmail",
        sessieKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "Van: {{messages[0].from}}\nBetreft: {{messages[0].subject}}\n{{messages[0].snippet}}",
        levering: waar,
        kanaal: "laat",
        model: "openai/gpt-5. -mini",
      },
    ],
  },
}
```

Verzoeken moeten de haak token bevatten:

- `Autorisatie: Voordrager <token>` **of**
- `x-openclaw-token: <token>`

Eindpunten:

- `POST /hooks/wake` → `{ text, mode?: "now"format@@6format@@7"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, kanaal?, naar?, denk?, timeoutSeconds? }`
- `POST /hooks/<name>` → opgelost via `hooks.mappings`

`/hooks/agent` plaatst altijd een samenvatting in de hoofdsessie (en kan optioneel direct een hartenslag activeren via `wakeMode: "nu"`).

Aantekeningen toewijzen:

- `match.path` komt overeen met het subpad na `/hooks` (bijv. `/hooks/gmail` → `gmail`).
- `match.source` komt overeen met een payload veld (bijv. `{ source: "gmail" }`) zodat je een generiek `/hooks/ingest` pad kunt gebruiken.
- Sjablonen zoals `{{messages[0].subject}}` uit de payload gelezen.
- `transform` kan wijzen naar een JS/TS module die een hook actie teruggeeft.
- `deliver: true` stuurt het laatste antwoord naar een kanaal; `channel` standaard naar `last` (val terug naar WhatsApp).
- Als er geen eerdere verzendroute is, zet `channel` + `to` expliciet (vereist voor Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams).
- `model` overschrijft de LLM voor deze hook run (`provider/model` of alias; moet toegestaan zijn als `agents.defaults.models` is ingesteld).

Gmail helper configuratie (gebruikt door `openclaw webhooks gmail setup` / `run`):

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.
      onderwerp: "projects/<project-id>/topics/gog-gmail-watch",
      abonnement "gog-gmail-watch-push",
      pushToken: "Shared-push-token",
      hookUrl: "http://127. .0.1:18789/hooks/gmail",
      includeBody: waar,
      maxBytes: 20000,
      vernieuwingen EveryMinutes: 720,
      serve: { bind: "127. .0. ", poort: 8788, pad: "/" },
      tailschaal: { mode: "funnel", pad: "/gmail-pubsub" },

      // Optioneel: gebruik een goedkoper model voor Gmail hook verwerking
      // Falls back to agents. Model allbacks, dan primair, op auth/rate-limit/timeout
      model: "openrouter/meta-llama/llama-3. -70b-instruct:free",
      // Optioneel: standaard denkniveau voor Gmail haks
      denkt: "uit",
    },
  },
}
```

Model overschrijving voor Gmail hooks:

- `hooks.gmail.model` geeft een model aan om te gebruiken voor Gmail hook verwerking (standaard sessie primaire).
- Accepteert `provider/model` refs of aliassen van `agents.defaults.models`.
- Terugvallen naar `agents.defaults.model.fallbacks`, dan `agents.defaults.model.primary`, op auth/rate-limit/timeouts.
- Als `agents.defaults.models` is ingesteld, voeg het hooks model toe aan de allowlist.
- waarschuwt u bij het opstarten als het geconfigureerde model niet in de model catalogus of allowlist staat.
- `hooks.gmail.thinking` bepaalt het standaard denkniveau voor Gmail haks en wordt overschreven door per-hook `denken`.

Gateway auto-start:

- Als `hooks.enabled=true` en `hooks.gmail.account` is ingesteld, start de Gateway
  `gog gmail watch serve` bij het opstarten en automatisch vernieuwen van het horloge.
- Stel `OPENCLAW_SKIP_GMAIL_WATCHER=1` in om de auto-start uit te schakelen (voor handmatige uitvoering).
- Vermijd het gebruiken van een aparte `gog gmail watch serve` naast de Gateway; het zal
  mislukt met `listen tcp 127.0.0.1:8788: bind: adres al in gebruik`.

Opmerking: wanneer `tailscale.mode` is ingeschakeld, standaard `serve.path` naar `/` dus
Tailscale kan proxy `/gmail-pubsub` correct zijn (het verwijdert het set-path voorvoegsel).
Als u het backend nodig heeft om het prefixeerde pad te ontvangen, stel
`hooks.gmail.tailscale.target` in op een volledige URL (en voeg `serve.path`).

### `canvasHost` (LAN/tailnet Canvas bestand server + live herladen)

De Gateway dient een map van HTML/CSS/JS over HTTP zodat iOS/Android nodes simpelweg `canvas.navigate` kunnen gebruiken.

Standaard root: `~/. penclaw/workspace/canvas`  
standaardpoort: `18793` (gekozen om de openclaw browser CDP poort `18792`)  
De server luistert naar de **gateway bind host** (LAN of Tailnet) zodat nodes het kunnen bereiken.

De server:

- dient bestanden onder `canvasHost.root`
- injecteert een kleine live-reload client in geserveerde HTML
- kijkt naar de map en zendt herlaadt een WebSocket eindpunt op `/__openclaw__/ws`
- maak automatisch een starter `index.html` aan als de map leeg is (zodat je direct iets ziet)
- ook dient A2UI bij `/__openclaw__/a2ui/` en wordt geadverteerd voor nodes als `canvasHostUrl`
  (altijd gebruikt door nodes voor Canvas/A2UI)

Schakel live herladen (en bestanden bekijken) uit als de map groot is of als je `EMFILE` raakt:

- config: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    poort: 18793,
    liveReload: true,
  },
}
```

Wijzigingen in `canvasHost.*` vereisen een gateway herstart (configuratie herladen wordt herstart).

Uitschakelen met:

- config: `canvasHost: { enabled: false }`
- env: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge` (oudere TCP bridge, verwijderd)

Huidige builds bevatten niet langer de TCP bridge luisteraar; `bridge.*` config keys worden genegeerd.
Nodes verbinden via de Gateway WebSocket. Dit gedeelte wordt bewaard voor historische referenties.

Legacy gedrag:

- De Gateway kan een eenvoudige TCP-brug voor nodes (iOS/Android) weergeven, meestal op poort `18790`.

Standaarden:

- enabled: `true`
- poort: `18790`
- bind: `lan` (bindt aan `0.0.0`)

Bind modes:

- `lan`: `0.0.0` (bereikbaar op elke interface, inclusief LAN/WiīFi en Tailscale)
- `tailnet`: bind alleen aan het Tailscale IP van de machine (aanbevolen voor Vienna Universal London)
- `loopback`: `127.0.0.1` (alleen lokaal)
- `auto`: prefereer een tailnet IP indien aanwezig, anders `lan`

VL:

- `bridge.tls.enabled`: schakel TLS in voor bridge verbindingen (TLS-alleen wanneer ingeschakeld).
- `bridge.tls.autoGenerate`: genereer een zelf ondertekend cert wanneer er geen cert/key aanwezig is (standaard: true).
- `bridge.tls.certPath` / `bridge.tls.keyPath`: PEM paden voor de bridge certificaat + private key.
- `bridge.tls.caPath`: optionele PEM CA bundel (aangepaste wortels of toekomstige mTLS).

Als TLS is ingeschakeld, adverteert de Gateway `bridgeTls=1` en `bridgeTlsSha256` bij het ontdekken van TXT
records zodat nodes het certificaat kunnen pinnen. Handmatige verbindingen gebruiken trust-on-first-use als er nog geen
vingerafdruk is opgeslagen.
Auto-gegenereerde certs vereisen `openssl` op PATH; als de generatie faalt, zal de bridge niet starten.

```json5
{
  bridge: {
    enabled: waar,
    poort: 18790,
    bind: "tailnet",
    tls: {
      ingeschakeld: waar,
      // Gebruikt ~/. penclaw/bridge/tls/bridge-{cert,key}. wanneer weggelaten.
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/. penclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns` (Bonjour / mDNS broadcast modus)

Controleert LAN mDNS discovery uitzendingen (`_openclaw-gw._tcp`).

- `minimal` (standaard): omit `cliPath` + `sshPort` van TXT records
- `full`: inclusief `cliPath` + `sshPort` in TXT records
- `off`: schakel mDNS uitzendingen volledig uit
- Hostname: standaard aan `openclaw` (adverteert `openclaw.local`). Overschrijven met `OPENCLAW_MDNS_HOSTNAME`.

```json5
{
  discovery: { mdns: { mode: "minimal" } },
 } } } }
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNSformat@@2- SD)

Wanneer ingeschakeld, schrijft de Gateway een unicast DNS-SD zone voor `_openclaw-gw._tcp` onder `~/.openclaw/dns/` in het gebruik van het geconfigureerde discovery domein (voorbeeld: `openclaw.internal.`).

Koppel dit met het volgende om iOS/Android te laten ontdekken op netwerken (Vienna Vienns. Londen).

- een DNS-server op de gateway host die uw gekozen domein bedient (CoreDNS is aanbevolen)
- Tailscale **split DNS** zodat klanten dat domein oplossen via de gateway DNS server

Eenmalige setup helper (gateway host):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## Media model sjabloonvariabelen

Template placeholders zijn uitgebreid in `tools.media.*.models[].args` en `tools.media.models[].args` (en eventuele toekomstige getemplated argumentvelden).

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

## Cron (Gateway planner)

Cron is een Gateway-eigendom planner voor wakeps en geplande taken. Zie [Cron jobs](/automation/cron-jobs) voor het functieoverzicht en CLI-voorbeelden.

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

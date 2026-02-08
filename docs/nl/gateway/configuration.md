---
summary: "Alle configuratieopties voor ~/.openclaw/openclaw.json met voorbeelden"
read_when:
  - Toevoegen of wijzigen van configvelden
title: "Configuratie"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:36Z
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

### Padresolutie

- **Relatieve paden**: Opgelost relatief aan het insluitende bestand
- **Absolute paden**: Ongewijzigd gebruikt
- **Bovenliggende mappen**: `../`-referenties werken zoals verwacht

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Foutafhandeling

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

---

_Next: [Agent Runtime](/concepts/agent)_ 🦞

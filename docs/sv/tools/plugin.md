---
summary: "OpenClaw‑plugins/tillägg: upptäckt, konfiguration och säkerhet"
read_when:
  - När du lägger till eller ändrar plugins/tillägg
  - När du dokumenterar regler för plugin‑installation eller inläsning
title: "Plugins"
---

# Plugins (Tillägg)

## Snabbstart (ny med plugins?)

Ett plugin är helt enkelt en **liten kodmodul** som utökar OpenClaw med extra
funktioner (kommandon, verktyg och Gateway RPC).

Oftast använder du plugins när du vill ha en funktion som ännu inte är inbyggd
i OpenClaw‑kärnan (eller när du vill hålla valfria funktioner borta från din
huvudinstallation).

Snabb väg:

1. Se vad som redan är laddat:

```bash
openclaw plugins list
```

2. Installera ett officiellt plugin (exempel: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Starta om Gateway, konfigurera sedan under `plugins.entries.<id>.config`.

Se [Voice Call](/plugins/voice-call) för ett konkret exempel på ett plugin.

## Tillgängliga plugins (officiella)

- Microsoft Teams är endast plugin‑baserat från och med 2026‑01‑15; installera `@openclaw/msteams` om du använder Teams.
- Memory (Core) — medföljande minnessökningsplugin (aktiverat som standard via `plugins.slots.memory`)
- Memory (LanceDB) — medföljande plugin för långtidsminne (automatisk återkallelse/insamling; sätt `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (leverantörsautentisering) — medföljer som `google-antigravity-auth` (inaktiverat som standard)
- Gemini CLI OAuth (leverantörsautentisering) — medföljer som `google-gemini-cli-auth` (inaktiverat som standard)
- Qwen OAuth (leverantörsautentisering) — medföljer som `qwen-portal-auth` (inaktiverat som standard)
- Copilot Proxy (leverantörsautentisering) — lokal VS Code Copilot Proxy‑brygga; skild från inbyggd `github-copilot` enhetsinloggning (medföljer, inaktiverad som standard)

OpenClaw-plugins är **TypeScript-moduler** laddade vid körning via jiti. **Validering av Config
kör inte plugin-kod**; den använder plugin-manifestet och JSON
Schema istället. Se [Plugin manifest](/plugins/manifest).

Plugins kan registrera:

- Gateway RPC‑metoder
- Gateway HTTP‑hanterare
- Agentverktyg
- CLI‑kommandon
- Bakgrundstjänster
- Valfri konfigvalidering
- **Skills** (genom att lista `skills`‑kataloger i plugin‑manifestet)
- **Auto‑svar‑kommandon** (körs utan att AI‑agenten anropas)

Plugins kör **in-process** med Gateway, så behandla dem som betrodd kod.
Verktygsförfattarguide: [Verktyg för Plugin agent](/plugins/agent-tools).

## Runtime‑hjälpare

Plugins kan komma åt valda kärnhjälpare via `api.runtime`. För telefoni TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Noteringar:

- Använder kärnkonfigurationen `messages.tts` (OpenAI eller ElevenLabs).
- Returnerar PCM ljudbuffert + samplingshastighet. Plugins måste återskapa/koda för leverantörer.
- Edge TTS stöds inte för telefoni.

## Upptäckt och prioritet

OpenClaw skannar, i ordning:

1. Konfigsökvägar

- `plugins.load.paths` (fil eller katalog)

2. Workspace‑tillägg

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Globala tillägg

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Medföljande tillägg (levereras med OpenClaw, **inaktiverade som standard**)

- `<openclaw>/extensions/*`

Paketerade plugins måste aktiveras uttryckligen via `plugins.entries.<id>.enabled`
eller `openclaw plugins aktivera <id>`. Installerade plugins är aktiverade som standard,
men kan inaktiveras på samma sätt.

Varje plugin måste innehålla en 'openclaw.plugin.json' fil i sin rot. Om en sökväg
pekar på en fil, är plugin roten filens katalog och måste innehålla
manifestet.

Om flera plugins löses till samma id vinner den första träffen i ordningen ovan,
och kopior med lägre prioritet ignoreras.

### Paketpaket

En plugin‑katalog kan innehålla en `package.json` med `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Varje post blir en plugin. Om paketet visar flera tillägg blir plugin id
`namn/<fileBase>`.

Om ditt plugin importerar npm‑beroenden, installera dem i den katalogen så att
`node_modules` finns tillgänglig (`npm install` / `pnpm install`).

### Metadata för kanalkatalog

Kanalplugins kan annonsera onboarding metadata via `openclaw.channel` och
installera tips via `openclaw.install`. Detta håller kärnkatalogen data-fri.

Exempel:

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

OpenClaw kan också slå samman **externa kanalkataloger** (till exempel en MPM
registerexport). Släpp en JSON-fil på en av:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Eller peka `OPENCLAW_PLUGIN_CATALOG_PATHS` (eller `OPENCLAW_MPM_CATALOG_PATHS`) på
en eller flera JSON-filer (komma/semicolon/`PATH`-avgränsad). Varje fil ska
innehålla `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## Plugin‑ID:n

Standard‑plugin‑ID:n:

- Paketpaket: `package.json` `name`
- Fristående fil: filens basnamn (`~/.../voice-call.ts` → `voice-call`)

Om ett plugin exporterar `id` använder OpenClaw det, men varnar när det inte matchar
det konfigurerade id:t.

## Konfig

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

Fält:

- `enabled`: huvudbrytare (standard: true)
- `allow`: tillåtelselista (valfri)
- `deny`: spärrlista (valfri; spärr vinner)
- `load.paths`: extra plugin‑filer/kataloger
- `entries.<id>`: per-plugin växlar + konfiguration

Konfigändringar **kräver omstart av gateway**.

Valideringsregler (strikta):

- Okända plugin‑ID:n i `entries`, `allow`, `deny` eller `slots` är **fel**.
- Okända `kanaler.<id>` nycklar är **fel** om inte ett plugin manifest deklarerar
  kanal-id.
- Plugin‑konfig valideras med JSON Schema som är inbäddat i
  `openclaw.plugin.json` (`configSchema`).
- Om ett plugin är inaktiverat bevaras dess konfig och en **varning** utfärdas.

## Plugin‑platser (exklusiva kategorier)

Vissa pluginkategorier är **exklusiva** (endast en aktiv åt gången). Använd
`plugins.slots` för att välja vilken plugin som äger platsen:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Om flera plugins deklarerar `kind: "memory"`, laddar endast den valda en. Andra
är inaktiverade med diagnostik.

## Control UI (schema + etiketter)

Control UI använder `config.schema` (JSON Schema + `uiHints`) för att rendera bättre formulär.

OpenClaw utökar `uiHints` vid körning baserat på upptäckta plugins:

- Lägger till per-plugin-etiketter för `plugins.entries.<id>` / `.enabled` / `.config`
- Sammanfogar valfria plugin-tillhandahållna konfigurationsfälts ledtrådar under:
  `plugins.entries.<id>.config.<field>`

Om du vill att dina plugin‑konfigfält ska visa bra etiketter/platshållare (och markera hemligheter som känsliga),
tillhandahåll `uiHints` tillsammans med ditt JSON Schema i plugin‑manifestet.

Exempel:

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
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` fungerar endast för npm‑installationer som spåras under `plugins.installs`.

Plugins kan också registrera egna kommandon på toppnivå (exempel: `openclaw voicecall`).

## Plugin‑API (översikt)

Plugins exporterar antingen:

- En funktion: `(api) => { ... }`
- Ett objekt: `{ id, namn, configSchema, register(api) { ... } }`

## Plugin‑hooks

Plugins kan skeppa krokar och registrera dem vid körning. Detta låter en plugin bunt
händelse-driven automatisering utan en separat krok pack installera.

### Exempel

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Noteringar:

- Hook‑kataloger följer den normala hook‑strukturen (`HOOK.md` + `handler.ts`).
- Regler för hook‑behörighet gäller fortfarande (OS/binärer/miljö/konfig‑krav).
- Plugin‑hanterade hooks visas i `openclaw hooks list` med `plugin:<id>`.
- Du kan inte aktivera/inaktivera plugin‑hanterade hooks via `openclaw hooks`; aktivera/inaktivera pluginet i stället.

## Leverantörsplugins (modellautentisering)

Plugins kan registrera flöden för **modell‑leverantörsautentisering** så att användare kan köra OAuth eller
API‑nyckel‑konfigurering inuti OpenClaw (inga externa skript behövs).

Registrera en leverantör via `api.registerLeverantör(...)`. Varje leverantör exponerar en
eller flera auth metoder (OAuth, API-nyckel, enhetskod, etc.). Dessa metoder makt:

- `openclaw models auth login --provider <id> [--method <id>]`

Exempel:

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
});
```

Noteringar:

- `run` tar emot en `ProviderAuthContext` med hjälpare för `prompter`, `runtime`,
  `openUrl` och `oauth.createVpsAwareHandlers`.
- Returnera `configPatch` när du behöver lägga till standardmodeller eller leverantörskonfig.
- Returnera `defaultModel` så att `--set-default` kan uppdatera agentstandarder.

### Registrera en meddelandekanal

Plugins kan registrera **kanalplugins** som beter sig som inbyggda kanaler
(WhatsApp, Telegram, etc.). Channel config lever under `kanaler.<id>` och är
validerad av din kanal plugin kod.

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

Noteringar:

- Sätt konfigurationen under `kanaler.<id>` (inte `plugins.entries`).
- `meta.label` används för etiketter i CLI/UI‑listor.
- `meta.aliases` lägger till alternativa id:n för normalisering och CLI‑inmatningar.
- `meta.preferOver` listar kanal‑ID:n som ska hoppas över vid auto‑aktivering när båda är konfigurerade.
- `meta.detailLabel` och `meta.systemImage` låter UI:er visa rikare kanaletiketter/ikoner.

### Skriv en ny meddelandekanal (steg‑för‑steg)

Använd detta när du vill ha en **ny chatt yta** (en “meddelandekanal”), inte en modellleverantör.
Modell leverantörsdokument lever under `/providers/*`.

1. Välj ett id + konfigform

- Alla kanalkonfigurationer lever under `kanaler.<id>`.
- Föredrar `kanaler.<id>.accounts.<accountId>` för inställningar för flera konton.

2. Definiera kanalens metadata

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` styr CLI/UI‑listor.
- `meta.docsPath` ska peka på en dokumentsida som `/channels/<id>`.
- `meta.preferOver` låter ett plugin ersätta en annan kanal (auto‑aktivering föredrar den).
- `meta.detailLabel` och `meta.systemImage` används av UI:er för detaljtext/ikoner.

3. Implementera de obligatoriska adaptrarna

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (chatttyper, media, trådar osv.)
- `outbound.deliveryMode` + `outbound.sendText` (för grundläggande sändning)

4. Lägg till valfria adaptrar vid behov

- `setup` (guide), `security` (DM‑policy), `status` (hälsa/diagnostik)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (meddelandeåtgärder), `commands` (inbyggt kommandobeteende)

5. Registrera kanalen i ditt plugin

- `api.registerChannel({ plugin })`

Minimalt konfigexempel:

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

Minimalt kanalplugin (endast utgående):

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

Ladda plugin (extensions dir eller `plugins.load.paths`), starta om gateway,
och konfigurera sedan `kanaler.<id>` i din konfiguration.

### Agentverktyg

Se den dedikerade guiden: [Plugin agent tools](/plugins/agent-tools).

### Registrera en gateway‑RPC‑metod

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Registrera CLI‑kommandon

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

### Registrera auto‑svar‑kommandon

Plugins kan registrera anpassade snedstreckskommandon som kör **utan att åberopa
AI-agenten**. Detta är användbart för att växla kommandon, statuskontroller eller snabbåtgärder
som inte behöver LLM-behandling.

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

Kommandots hanterarkontext:

- `senderId`: Avsändarens ID (om tillgängligt)
- `channel`: Kanalen där kommandot skickades
- `isAuthorizedSender`: Om avsändaren är auktoriserad
- `args`: Argument som skickas efter kommandot (om `acceptsArgs: true`)
- `commandBody`: Hela kommandotexten
- `config`: Aktuell OpenClaw‑konfig

Kommandoalternativ:

- `name`: Kommandonamn (utan inledande `/`)
- `description`: Hjälptext som visas i kommandolistor
- `accepterarArgs`: Om kommandot accepterar argument (standard: false). Om falskt och argument anges, kommer kommandot inte att matcha och meddelandet faller igenom till andra hanterare
- `requireAuth`: Om auktoriserad avsändare krävs (standard: true)
- `handler`: Funktion som returnerar `{ text: string }` (kan vara async)

Exempel med auktorisering och argument:

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

Noteringar:

- Plugin‑kommandon behandlas **före** inbyggda kommandon och AI‑agenten
- Kommandon registreras globalt och fungerar över alla kanaler
- Kommandonamn är skiftlägesokänsliga (`/MyStatus` matchar `/mystatus`)
- Kommandonamn måste börja med en bokstav och endast innehålla bokstäver, siffror, bindestreck och understreck
- Reserverade kommandonamn (som `help`, `status`, `reset`, etc.) kan inte åsidosättas av plugins
- Dubblettregistrering av kommandon över plugins misslyckas med ett diagnostiskt fel

### Registrera bakgrundstjänster

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Namnkonventioner

- Gateway‑metoder: `pluginId.action` (exempel: `voicecall.status`)
- Verktyg: `snake_case` (exempel: `voice_call`)
- CLI‑kommandon: kebab eller camel, men undvik kollisioner med kärnkommandon

## Skills

Plugins kan skicka en färdighet i repo (`skills/<name>/SKILL.md`).
Aktivera det med `plugins.entries.<id>.enabled` (eller andra konfiguration grindar) och se till att
är närvarande i din arbetsyta / hanterade färdigheter platser.

## Distribution (npm)

Rekommenderad paketering:

- Huvudpaket: `openclaw` (detta repo)
- Plugins: separata npm‑paket under `@openclaw/*` (exempel: `@openclaw/voice-call`)

Publiceringskontrakt:

- Plugin‑`package.json` måste inkludera `openclaw.extensions` med en eller flera startfiler.
- Startfiler kan vara `.js` eller `.ts` (jiti laddar TS vid körning).
- `openclaw plugins install <npm-spec>` använder `npm pack`, extraherar till `~/.openclaw/extensions/<id>/` och aktiverar det i konfig.
- Stabilitet för konfignycklar: scoped‑paket normaliseras till det **oscopade** id:t för `plugins.entries.*`.

## Exempelplugin: Voice Call

Detta repo innehåller ett voice‑call‑plugin (Twilio eller logg‑fallback):

- Källa: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Verktyg: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Konfig (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (valfritt `statusCallbackUrl`, `twimlUrl`)
- Konfig (dev): `provider: "log"` (inget nätverk)

Se [Voice Call](/plugins/voice-call) och `extensions/voice-call/README.md` för konfigurering och användning.

## Säkerhetsnoteringar

Plugins kör i processen med Gateway. Behandla dem som betrodd kod:

- Installera endast plugins du litar på.
- Föredra `plugins.allow`‑tillåtelselistor.
- Starta om Gateway efter ändringar.

## Testning av plugins

Plugins kan (och bör) leverera tester:

- Plugins i repot kan ha Vitest‑tester under `src/**` (exempel: `src/plugins/voice-call.plugin.test.ts`).
- Separat publicerade plugins bör köra egen CI (lint/build/test) och validera att `openclaw.extensions` pekar på den byggda startpunkten (`dist/index.js`).

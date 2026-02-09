---
summary: "OpenClaw-plugins/extensies: discovery, configuratie en veiligheid"
read_when:
  - Plugins/extensies toevoegen of wijzigen
  - Plugin-installatie- of laadregels documenteren
title: "Plugins"
---

# Plugins (Extensies)

## Snelle start (nieuw met plugins?)

Een plugin is gewoon een **kleine codemodule** die OpenClaw uitbreidt met extra
functies (opdrachten, tools en Gateway RPC).

Meestal gebruik je plugins wanneer je een functie wilt die nog niet in de
kern van OpenClaw zit (of wanneer je optionele functies buiten je hoofdinstallatie
wilt houden).

Snelle route:

1. Bekijk wat er al is geladen:

```bash
openclaw plugins list
```

2. Installeer een officiële plugin (voorbeeld: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Herstart de Gateway en configureer vervolgens onder `plugins.entries.<id>.config`.

Zie [Voice Call](/plugins/voice-call) voor een concreet voorbeeld van een plugin.

## Beschikbare plugins (officieel)

- Microsoft Teams is sinds 2026.1.15 alleen via een plugin beschikbaar; installeer `@openclaw/msteams` als je Teams gebruikt.
- Memory (Core) — gebundelde geheugenzoekplugin (standaard ingeschakeld via `plugins.slots.memory`)
- Memory (LanceDB) — gebundelde langetermijngeheugenplugin (automatisch ophalen/vastleggen; stel `plugins.slots.memory = "memory-lancedb"` in)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (provider-authenticatie) — gebundeld als `google-antigravity-auth` (standaard uitgeschakeld)
- Gemini CLI OAuth (provider-authenticatie) — gebundeld als `google-gemini-cli-auth` (standaard uitgeschakeld)
- Qwen OAuth (provider-authenticatie) — gebundeld als `qwen-portal-auth` (standaard uitgeschakeld)
- Copilot Proxy (provider-authenticatie) — lokale VS Code Copilot Proxy-bridge; onderscheiden van ingebouwde `github-copilot` apparaatlogin (gebundeld, standaard uitgeschakeld)

OpenClaw-plugins zijn **TypeScript-modules** die tijdens runtime via jiti worden geladen. **Configuratievalidatie voert geen plugincode uit**; deze gebruikt in plaats daarvan het pluginmanifest en JSON Schema. Zie [Plugin manifest](/plugins/manifest).

Plugins kunnen registreren:

- Gateway RPC-methoden
- Gateway HTTP-handlers
- Agent-tools
- CLI-opdrachten
- Achtergronddiensten
- Optionele configuratievalidatie
- **Skills** (door `skills`-mappen te vermelden in het pluginmanifest)
- **Auto-reply-opdrachten** (uitgevoerd zonder de AI-agent aan te roepen)

Plugins draaien **in-process** met de Gateway, dus behandel ze als vertrouwde code.
Handleiding voor tool-ontwikkeling: [Plugin agent tools](/plugins/agent-tools).

## Runtime-hulpmiddelen

Plugins hebben toegang tot geselecteerde kernhulpmiddelen via `api.runtime`. Voor telefonie-TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Notities:

- Gebruikt de kernconfiguratie `messages.tts` (OpenAI of ElevenLabs).
- Retourneert een PCM-audiobuffer + sample rate. Plugins moeten zelf resamplen/encoderen voor providers.
- Edge TTS wordt niet ondersteund voor telefonie.

## Discovery & prioriteit

OpenClaw scant, in volgorde:

1. Config-paden

- `plugins.load.paths` (bestand of map)

2. Werkruimte-extensies

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Globale extensies

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Gebundelde extensies (meegeleverd met OpenClaw, **standaard uitgeschakeld**)

- `<openclaw>/extensions/*`

Gebundelde plugins moeten expliciet worden ingeschakeld via `plugins.entries.<id>.enabled`
of `openclaw plugins enable <id>`. Geïnstalleerde plugins zijn standaard ingeschakeld,
maar kunnen op dezelfde manier worden uitgeschakeld.

Elke plugin moet een `openclaw.plugin.json`-bestand in de root bevatten. Als een pad
naar een bestand wijst, is de plugin-root de map van dat bestand en moet deze
het manifest bevatten.

Als meerdere plugins naar dezelfde id resolven, wint de eerste overeenkomst
in bovenstaande volgorde en worden kopieën met lagere prioriteit genegeerd.

### Package packs

Een pluginmap kan een `package.json` bevatten met `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Elke entry wordt een plugin. Als het pack meerdere extensies vermeldt, wordt de plugin-id
`name/<fileBase>`.

Als je plugin npm-afhankelijkheden importeert, installeer deze dan in die map zodat
`node_modules` beschikbaar is (`npm install` / `pnpm install`).

### Kanaalcatalogus-metadata

Kanaalplugins kunnen onboarding-metadata adverteren via `openclaw.channel` en
installatiehints via `openclaw.install`. Dit houdt de kerncatalogus vrij van data.

Voorbeeld:

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

OpenClaw kan ook **externe kanaalcatalogi** samenvoegen (bijvoorbeeld een MPM-
registry-export). Plaats een JSON-bestand op een van:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Of wijs `OPENCLAW_PLUGIN_CATALOG_PATHS` (of `OPENCLAW_MPM_CATALOG_PATHS`) naar
een of meer JSON-bestanden (gescheiden door komma/komma-puntkomma/`PATH`). Elk bestand moet
`{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }` bevatten.

## Plugin-ID’s

Standaard plugin-id’s:

- Package packs: `package.json` `name`
- Losstaand bestand: bestandsbasisnaam (`~/.../voice-call.ts` → `voice-call`)

Als een plugin `id` exporteert, gebruikt OpenClaw deze maar waarschuwt
wanneer deze niet overeenkomt met de geconfigureerde id.

## Configuratie

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

Velden

- `enabled`: hoofdswitch (standaard: true)
- `allow`: toegestane lijst (optioneel)
- `deny`: denylist (optioneel; deny wint)
- `load.paths`: extra pluginbestanden/-mappen
- `entries.<id>`: per-plugin schakelaars + configuratie

Configuratiewijzigingen **vereisen een Gateway-herstart**.

Validatieregels (streng):

- Onbekende plugin-id’s in `entries`, `allow`, `deny` of `slots` zijn **fouten**.
- Onbekende `channels.<id>`-sleutels zijn **fouten**, tenzij een pluginmanifest
  de kanaal-id declareert.
- Pluginconfiguratie wordt gevalideerd met het JSON Schema dat is ingesloten in
  `openclaw.plugin.json` (`configSchema`).
- Als een plugin is uitgeschakeld, blijft de configuratie behouden en wordt een **waarschuwing** gegeven.

## Plugin-slots (exclusieve categorieën)

Sommige plugincategorieën zijn **exclusief** (slechts één tegelijk actief). Gebruik
`plugins.slots` om te selecteren welke plugin het slot bezit:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Als meerdere plugins `kind: "memory"` declareren, wordt alleen de geselecteerde geladen. De andere worden uitgeschakeld met diagnostische meldingen.

## Control UI (schema + labels)

De Control UI gebruikt `config.schema` (JSON Schema + `uiHints`) om betere formulieren te renderen.

OpenClaw breidt `uiHints` tijdens runtime uit op basis van ontdekte plugins:

- Voegt per-plugin labels toe voor `plugins.entries.<id>` / `.enabled` / `.config`
- Voegt optionele, door plugins aangeleverde hints voor configuratievelden samen onder:
  `plugins.entries.<id>.config.<field>`

Als je wilt dat je pluginconfiguratievelden goede labels/plaats-houders tonen (en geheimen als gevoelig markeren),
lever dan `uiHints` mee naast je JSON Schema in het pluginmanifest.

Voorbeeld:

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

`plugins update` werkt alleen voor npm-installaties die worden bijgehouden onder `plugins.installs`.

Plugins kunnen ook hun eigen top-level opdrachten registreren (voorbeeld: `openclaw voicecall`).

## Plugin-API (overzicht)

Plugins exporteren óf:

- Een functie: `(api) => { ... }`
- Een object: `{ id, name, configSchema, register(api) { ... } }`

## Plugin-hooks

Plugins kunnen hooks meeleveren en deze tijdens runtime registreren. Hiermee kan een plugin
event-gedreven automatisering bundelen zonder een aparte hook-pack-installatie.

### Voorbeeld

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Notities:

- Hook-mappen volgen de normale hook-structuur (`HOOK.md` + `handler.ts`).
- Regels voor hook-geschiktheid blijven van toepassing (OS/binaries/omgevings-/configvereisten).
- Door plugins beheerde hooks verschijnen in `openclaw hooks list` met `plugin:<id>`.
- Je kunt door plugins beheerde hooks niet in-/uitschakelen via `openclaw hooks`; schakel in plaats daarvan de plugin in/uit.

## Provider-plugins (modelauthenticatie)

Plugins kunnen **modelprovider-authenticatie**-flows registreren zodat gebruikers OAuth of
API-sleutel-installatie binnen OpenClaw kunnen uitvoeren (geen externe scripts nodig).

Registreer een provider via `api.registerProvider(...)`. Elke provider stelt een of meer
auth-methoden beschikbaar (OAuth, API-sleutel, apparaatcode, enz.). Deze methoden voeden:

- `openclaw models auth login --provider <id> [--method <id>]`

Voorbeeld:

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

Notities:

- `run` ontvangt een `ProviderAuthContext` met `prompter`, `runtime`,
  `openUrl` en `oauth.createVpsAwareHandlers`-hulpmiddelen.
- Retourneer `configPatch` wanneer je standaardmodellen of providerconfiguratie moet toevoegen.
- Retourneer `defaultModel` zodat `--set-default` de agent-standaardwaarden kan bijwerken.

### Een messagingkanaal registreren

Plugins kunnen **kanaalplugins** registreren die zich gedragen als ingebouwde kanalen
(WhatsApp, Telegram, enz.). Kanaalconfiguratie staat onder `channels.<id>` en wordt
gevalideerd door je kanaalplugincode.

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

Notities:

- Plaats configuratie onder `channels.<id>` (niet `plugins.entries`).
- `meta.label` wordt gebruikt voor labels in CLI/UI-lijsten.
- `meta.aliases` voegt alternatieve id’s toe voor normalisatie en CLI-invoer.
- `meta.preferOver` vermeldt kanaal-id’s die automatisch inschakelen moeten overslaan wanneer beide zijn geconfigureerd.
- `meta.detailLabel` en `meta.systemImage` stellen UI’s in staat rijkere kanaallabels/iconen te tonen.

### Een nieuw messagingkanaal schrijven (stap-voor-stap)

Gebruik dit wanneer je een **nieuw chatoppervlak** (een “messagingkanaal”) wilt, geen modelprovider.
Documentatie voor modelproviders staat onder `/providers/*`.

1. Kies een id + configuratievorm

- Alle kanaalconfiguratie staat onder `channels.<id>`.
- Geef de voorkeur aan `channels.<id>.accounts.<accountId>` voor multi-accountopstellingen.

2. Definieer de kanaalmetadata

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` bepalen CLI/UI-lijsten.
- `meta.docsPath` moet verwijzen naar een documentatiepagina zoals `/channels/<id>`.
- `meta.preferOver` laat een plugin een ander kanaal vervangen (auto-inschakelen geeft er de voorkeur aan).
- `meta.detailLabel` en `meta.systemImage` worden door UI’s gebruikt voor detailtekst/iconen.

3. Implementeer de vereiste adapters

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (chattypes, media, threads, enz.)
- `outbound.deliveryMode` + `outbound.sendText` (voor basisverzending)

4. Voeg optionele adapters toe indien nodig

- `setup` (wizard), `security` (DM-beleid), `status` (gezondheid/diagnostiek)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (berichtacties), `commands` (native opdrachtgedrag)

5. Registreer het kanaal in je plugin

- `api.registerChannel({ plugin })`

Minimaal configuratievoorbeeld:

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

Minimale kanaalplugin (alleen uitgaand):

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

Laad de plugin (extensions-map of `plugins.load.paths`), herstart de Gateway
en configureer vervolgens `channels.<id>` in je configuratie.

### Agent-tools

Zie de aparte handleiding: [Plugin agent tools](/plugins/agent-tools).

### Een gateway RPC-methode registreren

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### CLI-opdrachten registreren

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

### Auto-reply-opdrachten registreren

Plugins kunnen aangepaste slash-opdrachten registreren die **worden uitgevoerd zonder
de AI-agent aan te roepen**. Dit is handig voor toggle-opdrachten, statuscontroles of snelle acties
die geen LLM-verwerking nodig hebben.

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

Context van de opdrachthandler:

- `senderId`: De ID van de afzender (indien beschikbaar)
- `channel`: Het kanaal waarin de opdracht is verzonden
- `isAuthorizedSender`: Of de afzender een geautoriseerde gebruiker is
- `args`: Argumenten die na de opdracht zijn doorgegeven (indien `acceptsArgs: true`)
- `commandBody`: De volledige opdrachttekst
- `config`: De huidige OpenClaw-configuratie

Opdrachtopties:

- `name`: Opdrachtnaam (zonder de voorloop-`/`)
- `description`: Hulptekst die in opdrachtoverzichten wordt getoond
- `acceptsArgs`: Of de opdracht argumenten accepteert (standaard: false). Als false en er argumenten worden opgegeven, matcht de opdracht niet en valt het bericht door naar andere handlers
- `requireAuth`: Of een geautoriseerde afzender vereist is (standaard: true)
- `handler`: Functie die `{ text: string }` retourneert (kan async zijn)

Voorbeeld met autorisatie en argumenten:

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

Notities:

- Pluginopdrachten worden **vóór** ingebouwde opdrachten en de AI-agent verwerkt
- Opdrachten worden globaal geregistreerd en werken over alle kanalen
- Opdrachtnamen zijn niet hoofdlettergevoelig (`/MyStatus` matcht `/mystatus`)
- Opdrachtnamen moeten met een letter beginnen en mogen alleen letters, cijfers, koppeltekens en underscores bevatten
- Gereserveerde opdrachtnamen (zoals `help`, `status`, `reset`, enz.) kunnen niet door plugins worden overschreven
- Dubbele opdrachtregistratie over plugins heen faalt met een diagnostische fout

### Achtergronddiensten registreren

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Naamgevingsconventies

- Gateway-methoden: `pluginId.action` (voorbeeld: `voicecall.status`)
- Tools: `snake_case` (voorbeeld: `voice_call`)
- CLI-opdrachten: kebab of camel, maar vermijd conflicten met kernopdrachten

## Skills

Plugins kunnen een skill in de repo meeleveren (`skills/<name>/SKILL.md`).
Schakel deze in met `plugins.entries.<id>.enabled` (of andere configuratiepoorten) en zorg
dat deze aanwezig is in je werkruimte-/beheerde skills-locaties.

## Distributie (npm)

Aanbevolen packaging:

- Hoofdpakket: `openclaw` (deze repo)
- Plugins: afzonderlijke npm-pakketten onder `@openclaw/*` (voorbeeld: `@openclaw/voice-call`)

Publicatiecontract:

- Plugin `package.json` moet `openclaw.extensions` bevatten met een of meer entrybestanden.
- Entrybestanden kunnen `.js` of `.ts` zijn (jiti laadt TS tijdens runtime).
- `openclaw plugins install <npm-spec>` gebruikt `npm pack`, extraheert naar `~/.openclaw/extensions/<id>/` en schakelt het in via config.
- Stabiliteit van configsleutels: scoped packages worden genormaliseerd naar de **ongescopte** id voor `plugins.entries.*`.

## Voorbeeldplugin: Voice Call

Deze repo bevat een voice-call-plugin (Twilio of log-fallback):

- Bron: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Tool: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Config (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (optioneel `statusCallbackUrl`, `twimlUrl`)
- Config (dev): `provider: "log"` (geen netwerk)

Zie [Voice Call](/plugins/voice-call) en `extensions/voice-call/README.md` voor installatie en gebruik.

## Veiligheidsnotities

Plugins draaien in-process met de Gateway. Behandel ze als vertrouwde code:

- Installeer alleen plugins die je vertrouwt.
- Geef de voorkeur aan `plugins.allow` toegestane lijsten.
- Herstart de Gateway na wijzigingen.

## Plugins testen

Plugins kunnen (en zouden) tests meeleveren:

- In-repo plugins kunnen Vitest-tests onder `src/**` plaatsen (voorbeeld: `src/plugins/voice-call.plugin.test.ts`).
- Afzonderlijk gepubliceerde plugins moeten hun eigen CI draaien (lint/build/test) en valideren dat `openclaw.extensions` naar het gebouwde entrypoint wijst (`dist/index.js`).

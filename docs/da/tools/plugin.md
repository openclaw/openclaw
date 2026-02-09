---
summary: "OpenClaw plugins/udvidelser: discovery, konfiguration og sikkerhed"
read_when:
  - Tilføjelse eller ændring af plugins/udvidelser
  - Dokumentation af plugin-installation eller indlæsningsregler
title: "Plugins"
---

# Plugins (Udvidelser)

## Hurtig start (ny til plugins?)

Et plugin er blot et **lille kodemodul**, der udvider OpenClaw med ekstra
funktioner (kommandoer, værktøjer og Gateway RPC).

Det meste af tiden bruger du plugins, når du vil have en funktion, der endnu
ikke er indbygget i OpenClaw-kernen (eller når du vil holde valgfrie funktioner
ude af din hovedinstallation).

Hurtig vej:

1. Se hvad der allerede er indlæst:

```bash
openclaw plugins list
```

2. Installér et officielt plugin (eksempel: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Genstart Gateway, og konfigurer derefter under `plugins.entries.<id>.config`.

Se [Voice Call](/plugins/voice-call) for et konkret eksempel på et plugin.

## Tilgængelige plugins (officielle)

- Microsoft Teams er kun plugin-baseret pr. 2026.1.15; installér `@openclaw/msteams`, hvis du bruger Teams.
- Memory (Core) — medfølgende memory search-plugin (aktiveret som standard via `plugins.slots.memory`)
- Memory (LanceDB) — medfølgende long-term memory-plugin (auto-recall/capture; sæt `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (udbyder‑autentificering) — medfølger som `google-antigravity-auth` (deaktiveret som standard)
- Gemini CLI OAuth (udbyder‑autentificering) — medfølger som `google-gemini-cli-auth` (deaktiveret som standard)
- Qwen OAuth (udbyder‑autentificering) — medfølger som `qwen-portal-auth` (deaktiveret som standard)
- Copilot Proxy (udbyder‑autentificering) — lokal VS Code Copilot Proxy‑bro; adskilt fra indbygget `github-copilot` enhedslogin (medfølger, deaktiveret som standard)

OpenClaw plugins er **TypeScript moduler** indlæst på runtime via jiti. **Config
validering eksekverer ikke plugin kode**; den bruger plugin manifest og JSON
Schema i stedet. Se [Plugin manifest](/plugins/manifest).

Plugins kan registrere:

- Gateway RPC-metoder
- Gateway HTTP-handlere
- Agent‑værktøjer
- CLI‑kommandoer
- Baggrundstjenester
- Valgfri konfigurationsvalidering
- **Skills** (ved at angive `skills` mapper i plugin‑manifestet)
- **Auto‑reply‑kommandoer** (eksekveres uden at aktivere AI‑agenten)

Plugins kører **inproces** med Gateway, så behandl dem som betroet kode.
Værktøjs authoring guide: [Plugin agent værktøjer](/plugins/agent-tools).

## Runtime‑hjælpere

Plugins kan få adgang til udvalgte kernehjælpere via `api.runtime`. Til telefoni TTS:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Noter:

- Bruger kerne‑konfigurationen `messages.tts` (OpenAI eller ElevenLabs).
- Returnerer PCM audio buffer + sample rate. Plugins skal resample/encode for udbydere.
- Edge TTS understøttes ikke til telefoni.

## Discovery & prioritet

OpenClaw scanner i rækkefølge:

1. Konfigurationsstier

- `plugins.load.paths` (fil eller mappe)

2. Workspace‑udvidelser

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Globale udvidelser

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Medfølgende udvidelser (leveres med OpenClaw, **deaktiveret som standard**)

- `<openclaw>/extensions/*`

Medfølgende plugins skal udtrykkeligt aktiveres via `plugins.entries.<id>.enabled`
eller `openclaw plugins aktiverer <id>`. Installerede plugins er aktiveret som standard,
men kan deaktiveres på samme måde.

Hvert plugin skal indeholde en `openclaw.plugin.json` fil i sin rod. Hvis en sti
peger på en fil, er plugin-roden filens mappe og skal indeholde
-manifestet.

Hvis flere plugins resolver til samme id, vinder det første match i rækkefølgen
ovenfor, og kopier med lavere prioritet ignoreres.

### Package packs

En plugin‑mappe kan indeholde en `package.json` med `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Hver indgang bliver et plugin. Hvis pakken viser flere udvidelser, bliver plugin id
`navn/<fileBase>`.

Hvis dit plugin importerer npm‑afhængigheder, skal du installere dem i den mappe,
så `node_modules` er tilgængelig (`npm install` / `pnpm install`).

### Kanal‑katalog‑metadata

Kanal plugins kan annoncere onboarding metadata via `openclaw.channel` og
installere hints via `openclaw.install`. Dette holder kernen katalog data-fri.

Eksempel:

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

OpenClaw kan også flette **eksterne kanalkataloger** (for eksempel en MPM
registereksport). Drop en JSON-fil på en af:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Eller punkt `OPENCLAW_PLUGIN_CATALOG_PATHS` (eller `OPENCLAW_MPM_CATALOG_PATHS`) i
en eller flere JSON-filer (comma/semicolon/`PATH`-delimited). Hver fil skal
indeholde `{ "entries": [ { "navn": "@scope/pkg", "openclaw": { "kanal": {...}, "install": {...} } } ] }`.

## Plugin‑id’er

Standard plugin‑id’er:

- Package packs: `package.json` `name`
- Selvstændig fil: filens basisnavn (`~/.../voice-call.ts` → `voice-call`)

Hvis et plugin eksporterer `id`, bruger OpenClaw det, men advarer hvis
det ikke matcher det konfigurerede id.

## Konfiguration

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

Felter:

- `enabled`: master‑toggle (standard: true)
- `allow`: tilladelsesliste (valgfri)
- `deny`: denylist (valgfri; deny vinder)
- `load.paths`: ekstra plugin‑filer/-mapper
- `poster.<id>`: per- plugin skifter + config

Konfigurationsændringer **kræver genstart af gateway**.

Valideringsregler (strenge):

- Ukendte plugin‑id’er i `entries`, `allow`, `deny` eller `slots` er **fejl**.
- Ukendt `kanaler.<id>` nøgler er **errors** medmindre et plugin manifest erklærer
  kanal-id.
- Plugin‑konfiguration valideres ved hjælp af JSON Schema indlejret i
  `openclaw.plugin.json` (`configSchema`).
- Hvis et plugin er deaktiveret, bevares dets konfiguration, og der udsendes en **advarsel**.

## Plugin‑slots (eksklusive kategorier)

Nogle plugin-kategorier er **eksklusive** (kun én aktiv ad gangen). Brug
`plugins.slots` til at vælge hvilket plugin ejer slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Hvis flere plugins erklærer `art: "hukommelse"`, kun den valgte én belastning. Andre
er deaktiveret med diagnostik.

## Control UI (schema + labels)

Control UI bruger `config.schema` (JSON Schema + `uiHints`) til at rendere bedre formularer.

OpenClaw udvider `uiHints` ved runtime baseret på fundne plugins:

- Tilføjer per-plugin etiketter til `plugins.entries.<id>` / `.enabled` / `.config`
- Fletter valgfri plugin-forudsat config felt hints under:
  `plugins.entries.<id>.config.<field>`

Hvis du vil have, at dine plugin‑konfigurationsfelter viser gode labels/placeholders (og markerer hemmeligheder som følsomme),
så angiv `uiHints` sammen med dit JSON Schema i plugin‑manifestet.

Eksempel:

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

`plugins update` virker kun for npm‑installationer, der spores under `plugins.installs`.

Plugins kan også registrere deres egne top‑level kommandoer (eksempel: `openclaw voicecall`).

## Plugin‑API (overblik)

Plugins eksporterer enten:

- En funktion: `(api) => { ... }`
- Et objekt: `{ id, navn, configSchema, register(api) { ... } }`

## Plugin‑hooks

Plugins kan sende kroge og registrere dem på runtime. Dette lader en plugin pakke
event-drevet automatisering uden en separat krog pack installation.

### Eksempel

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Noter:

- Hook‑mapper følger den normale hook‑struktur (`HOOK.md` + `handler.ts`).
- Regler for hook‑egnethed gælder stadig (OS/bins/env/konfigurationskrav).
- Plugin‑styrede hooks vises i `openclaw hooks list` med `plugin:<id>`.
- Du kan ikke aktivere/deaktivere plugin‑styrede hooks via `openclaw hooks`; aktivér/deaktivér plugin’et i stedet.

## Udbyder‑plugins (model‑autentificering)

Plugins kan registrere **modeludbyder‑autentificeringsflows**, så brugere kan køre OAuth eller
API‑nøgle‑opsætning inde i OpenClaw (ingen eksterne scripts nødvendige).

Registrer en udbyder via `api.registerProvider(...)`. Hver udbyder udsætter en
eller flere auth metoder (OAuth, API-nøgle, enhedskode osv.). Disse metoder virker:

- `openclaw models auth login --provider <id> [--method <id>]`

Eksempel:

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

Noter:

- `run` modtager en `ProviderAuthContext` med `prompter`, `runtime`,
  `openUrl` og `oauth.createVpsAwareHandlers`‑hjælpere.
- Returnér `configPatch`, når du skal tilføje standardmodeller eller udbyder‑konfiguration.
- Returnér `defaultModel`, så `--set-default` kan opdatere agent‑standarder.

### Registrér en messaging‑kanal

Plugins kan registrere **kanalplugins**, der opfører sig som indbyggede kanaler
(WhatsApp, Telegram, etc.). Kanal config lever under `kanaler.<id>` og er
valideret af din kanal plugin kode.

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

Noter:

- Sæt config under `kanaler.<id>` (ikke `plugins.entries`).
- `meta.label` bruges til labels i CLI/UI‑lister.
- `meta.aliases` tilføjer alternative id’er til normalisering og CLI‑input.
- `meta.preferOver` lister kanal‑id’er, der skal springes over ved auto‑enable, når begge er konfigureret.
- `meta.detailLabel` og `meta.systemImage` lader UI’er vise rigere kanal‑labels/ikoner.

### Skriv en ny messaging‑kanal (trin‑for‑trin)

Brug dette, når du vil have en **ny chatoverflade** (en “messaging channel”), ikke en model udbyder.
Model provider docs live under `/providers/*`.

1. Vælg et id + konfigurationsform

- Alle kanal config lever under `kanaler.<id>`.
- Foretræk `kanaler.<id>.accounts.<accountId>` for opstillinger på flere konti.

2. Definér kanal‑metadata

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` styrer CLI/UI‑lister.
- `meta.docsPath` bør pege på en docs‑side som `/channels/<id>`.
- `meta.preferOver` lader et plugin erstatte en anden kanal (auto‑enable foretrækker den).
- `meta.detailLabel` og `meta.systemImage` bruges af UI’er til detaljetekst/ikoner.

3. Implementér de krævede adaptere

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (chattyper, medier, tråde osv.)
- `outbound.deliveryMode` + `outbound.sendText` (til basal afsendelse)

4. Tilføj valgfrie adaptere efter behov

- `setup` (wizard), `security` (DM‑politik), `status` (health/diagnostik)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (beskedhandlinger), `commands` (indbygget kommandoadfærd)

5. Registrér kanalen i dit plugin

- `api.registerChannel({ plugin })`

Minimal konfigurations‑eksempel:

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

Minimal kanal‑plugin (kun outbound):

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

Indlæs plugin (udvidelser dir eller `plugins.load.paths`), genstart gateway,
og derefter konfigurere `kanaler.<id>` i din konfiguration.

### Agent‑værktøjer

Se den dedikerede guide: [Plugin agent tools](/plugins/agent-tools).

### Registrér en gateway RPC‑metode

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Registrér CLI‑kommandoer

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

### Registrér auto‑reply‑kommandoer

Plugins kan registrere brugerdefinerede skråstregkommandoer, der udfører **uden at påberåbe sig
AI-agenten**. Dette er nyttigt til at skifte kommandoer, statuskontroller eller hurtige handlinger
som ikke behøver LLM behandling.

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

Kommandohandler‑kontekst:

- `senderId`: Afsenderens id (hvis tilgængeligt)
- `channel`: Kanalen hvor kommandoen blev sendt
- `isAuthorizedSender`: Om afsenderen er en autoriseret bruger
- `args`: Argumenter sendt efter kommandoen (hvis `acceptsArgs: true`)
- `commandBody`: Den fulde kommandotekst
- `config`: Den aktuelle OpenClaw‑konfiguration

Kommandoindstillinger:

- `name`: Kommandonavn (uden det indledende `/`)
- `description`: Hjælpetekst vist i kommandolister
- `acceptsArgs`: Om kommandoen accepterer argumenter (standard: falsk). Hvis falske og argumenter er angivet, vil kommandoen ikke matche og beskeden falder igennem til andre handlere
- `requireAuth`: Om autoriseret afsender kræves (standard: true)
- `handler`: Funktion der returnerer `{ text: string }` (kan være async)

Eksempel med autorisation og argumenter:

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

Noter:

- Plugin‑kommandoer behandles **før** indbyggede kommandoer og AI‑agenten
- Kommandoer registreres globalt og virker på tværs af alle kanaler
- Kommandonavne er ikke case‑sensitive (`/MyStatus` matcher `/mystatus`)
- Kommandonavne skal starte med et bogstav og må kun indeholde bogstaver, tal, bindestreger og underscores
- Reserverede kommandonavne (såsom `help`, `status`, `reset`, etc.) kan ikke tilsidesættes af plugins
- Dobbelt registrering af kommandoer på tværs af plugins vil fejle med en diagnostisk fejl

### Registrér baggrundstjenester

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Navngivningskonventioner

- Gateway‑metoder: `pluginId.action` (eksempel: `voicecall.status`)
- Værktøjer: `snake_case` (eksempel: `voice_call`)
- CLI‑kommandoer: kebab eller camel, men undgå kollisioner med kerne‑kommandoer

## Skills

Plugins kan sende en færdighed i repo (`færdigheder/<name>/SKILL.md`).
Aktiver det med `plugins.entries.<id>.enabled` (eller andre config gates) og sikre
det er til stede i dit arbejdsområde / administrerede færdigheder steder.

## Distribution (npm)

Anbefalet pakning:

- Hovedpakke: `openclaw` (dette repo)
- Plugins: separate npm‑pakker under `@openclaw/*` (eksempel: `@openclaw/voice-call`)

Publiceringskontrakt:

- Plugin `package.json` skal indeholde `openclaw.extensions` med én eller flere entry‑filer.
- Entry‑filer kan være `.js` eller `.ts` (jiti indlæser TS ved runtime).
- `openclaw plugins install <npm-spec>` bruger `npm pack`, udpakker til `~/.openclaw/extensions/<id>/` og aktiverer det i konfigurationen.
- Stabilitet af konfigurationsnøgler: scoped pakker normaliseres til det **unscoped** id for `plugins.entries.*`.

## Eksempel‑plugin: Voice Call

Dette repo indeholder et voice‑call‑plugin (Twilio eller log‑fallback):

- Kilde: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Værktøj: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Konfiguration (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (valgfrit `statusCallbackUrl`, `twimlUrl`)
- Konfiguration (dev): `provider: "log"` (ingen netværk)

Se [Voice Call](/plugins/voice-call) og `extensions/voice-call/README.md` for opsætning og brug.

## Sikkerhedsnoter

Plugins kører i gang med Gateway. Behandl dem som betroet kode:

- Installér kun plugins, du har tillid til.
- Foretræk `plugins.allow` tilladelseslister.
- Genstart Gateway efter ændringer.

## Test af plugins

Plugins kan (og bør) levere tests:

- Plugins i repo’et kan have Vitest‑tests under `src/**` (eksempel: `src/plugins/voice-call.plugin.test.ts`).
- Separat publicerede plugins bør køre deres egen CI (lint/build/test) og validere, at `openclaw.extensions` peger på den byggede entrypoint (`dist/index.js`).

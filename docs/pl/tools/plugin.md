---
summary: "„Wtyczki/rozszerzenia OpenClaw: wykrywanie, konfiguracja i bezpieczeństwo”"
read_when:
  - Dodawanie lub modyfikowanie wtyczek/rozszerzeń
  - Dokumentowanie zasad instalacji lub ładowania wtyczek
title: "„Wtyczki”"
---

# Wtyczki (Rozszerzenia)

## Szybki start (nowy w wtyczkach?)

Wtyczka to po prostu **niewielki moduł kodu**, który rozszerza OpenClaw o dodatkowe
funkcje (polecenia, narzędzia oraz RPC Gateway).

Najczęściej będziesz używać wtyczek wtedy, gdy potrzebujesz funkcji, która nie jest
jeszcze wbudowana w rdzeń OpenClaw (albo chcesz trzymać funkcje opcjonalne poza
główną instalacją).

Szybka ścieżka:

1. Sprawdź, co jest już załadowane:

```bash
openclaw plugins list
```

2. Zainstaluj oficjalną wtyczkę (przykład: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Zrestartuj Gateway, a następnie skonfiguruj w `plugins.entries.<id>.config`.

Zobacz [Voice Call](/plugins/voice-call), aby zapoznać się z konkretnym przykładem wtyczki.

## Dostępne wtyczki (oficjalne)

- Microsoft Teams jest dostępny wyłącznie jako wtyczka od 2026.1.15; zainstaluj `@openclaw/msteams`, jeśli korzystasz z Teams.
- Memory (Core) — dołączona wtyczka wyszukiwania pamięci (włączona domyślnie przez `plugins.slots.memory`)
- Memory (LanceDB) — dołączona wtyczka pamięci długoterminowej (automatyczne przywoływanie/przechwytywanie; ustaw `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (uwierzytelnianie dostawcy) — dołączone jako `google-antigravity-auth` (domyślnie wyłączone)
- Gemini CLI OAuth (uwierzytelnianie dostawcy) — dołączone jako `google-gemini-cli-auth` (domyślnie wyłączone)
- Qwen OAuth (uwierzytelnianie dostawcy) — dołączone jako `qwen-portal-auth` (domyślnie wyłączone)
- Copilot Proxy (uwierzytelnianie dostawcy) — lokalny most VS Code Copilot Proxy; odrębny od wbudowanego logowania urządzenia `github-copilot` (dołączone, domyślnie wyłączone)

Wtyczki OpenClaw są **modułami TypeScript** ładowanymi w czasie działania przez jiti. **Walidacja konfiguracji nie wykonuje kodu wtyczki**; używa zamiast tego manifestu wtyczki oraz schematu JSON. Zobacz [Manifest wtyczki](/plugins/manifest).

Wtyczki mogą rejestrować:

- Metody RPC Gateway
- Procedury HTTP Gateway
- Narzędzia agenta
- Polecenia CLI
- Usługi działające w tle
- Opcjonalną walidację konfiguracji
- **Skills** (poprzez wskazanie katalogów `skills` w manifeście wtyczki)
- **Polecenia auto-odpowiedzi** (wykonywane bez wywoływania agenta AI)

Wtyczki działają **w tym samym procesie** co Gateway, dlatego należy traktować je
jako zaufany kod.
Przewodnik tworzenia narzędzi: [Narzędzia agenta wtyczek](/plugins/agent-tools).

## Pomocnicy Runtime

Wtyczki mogą uzyskiwać dostęp do wybranych pomocników rdzenia poprzez `api.runtime`. Dla TTS w telefonii:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Uwagi:

- Używa podstawowej konfiguracji `messages.tts` (OpenAI lub ElevenLabs).
- Zwraca bufor audio PCM + częstotliwość próbkowania. Wtyczki muszą same wykonać resampling/kodowanie dla dostawców.
- Edge TTS nie jest obsługiwany dla telefonii.

## Wykrywanie i priorytety

OpenClaw skanuje, w kolejności:

1. Ścieżki konfiguracji

- `plugins.load.paths` (plik lub katalog)

2. Rozszerzenia obszaru roboczego

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Rozszerzenia globalne

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Rozszerzenia dołączone (dostarczane z OpenClaw, **domyślnie wyłączone**)

- `<openclaw>/extensions/*`

Dołączone wtyczki muszą być włączone jawnie przez `plugins.entries.<id>.enabled`
lub `openclaw plugins enable <id>`. Zainstalowane wtyczki są domyślnie włączone,
ale można je wyłączyć w ten sam sposób.

Każda wtyczka musi zawierać plik `openclaw.plugin.json` w katalogu głównym. Jeśli ścieżka
wskazuje na plik, katalogiem głównym wtyczki jest katalog tego pliku i musi on
zawierać manifest.

Jeśli wiele wtyczek rozwiązuje się do tego samego identyfikatora, wygrywa pierwsze
dopasowanie według powyższej kolejności, a kopie o niższym priorytecie są ignorowane.

### Pakiety zbiorcze

Katalog wtyczki może zawierać `package.json` z `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Każdy wpis staje się wtyczką. Jeśli pakiet zawiera wiele rozszerzeń, identyfikator
wtyczki przyjmuje postać `name/<fileBase>`.

Jeśli wtyczka importuje zależności npm, zainstaluj je w tym katalogu, aby
`node_modules` było dostępne (`npm install` / `pnpm install`).

### Metadane katalogu kanałów

Wtyczki kanałów mogą ogłaszać metadane onboardingu poprzez `openclaw.channel` oraz
wskazówki instalacyjne poprzez `openclaw.install`. Dzięki temu rdzeń pozostaje wolny
od danych katalogowych.

Przykład:

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

OpenClaw może także scalać **zewnętrzne katalogi kanałów** (na przykład eksport
rejestru MPM). Umieść plik JSON w jednej z lokalizacji:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Lub wskaż w `OPENCLAW_PLUGIN_CATALOG_PATHS` (lub `OPENCLAW_MPM_CATALOG_PATHS`) jeden
lub więcej plików JSON (rozdzielonych przecinkami/średnikami/`PATH`). Każdy
plik powinien zawierać `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## ID wtyczek

Domyślne identyfikatory wtyczek:

- Pakiety zbiorcze: `package.json` `name`
- Pojedynczy plik: nazwa bazowa pliku (`~/.../voice-call.ts` → `voice-call`)

Jeśli wtyczka eksportuje `id`, OpenClaw używa go, ale zgłasza ostrzeżenie,
gdy nie pasuje do skonfigurowanego identyfikatora.

## Konfiguracja

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

Pola:

- `enabled`: przełącznik główny (domyślnie: true)
- `allow`: lista dozwolonych (opcjonalne)
- `deny`: lista blokowanych (opcjonalne; blokada ma pierwszeństwo)
- `load.paths`: dodatkowe pliki/katalogi wtyczek
- `entries.<id>`: przełączniki per wtyczka + konfiguracja

Zmiany konfiguracji **wymagają restartu Gateway**.

Zasady walidacji (ścisłe):

- Nieznane identyfikatory wtyczek w `entries`, `allow`, `deny` lub `slots` są **błędami**.
- Nieznane klucze `channels.<id>` są **błędami**, chyba że manifest wtyczki deklaruje
  identyfikator kanału.
- Konfiguracja wtyczki jest walidowana przy użyciu schematu JSON osadzonego w
  `openclaw.plugin.json` (`configSchema`).
- Jeśli wtyczka jest wyłączona, jej konfiguracja jest zachowana i emitowane jest **ostrzeżenie**.

## Sloty wtyczek (kategorie wyłączne)

Niektóre kategorie wtyczek są **wyłączne** (tylko jedna aktywna naraz). Użyj
`plugins.slots`, aby wybrać, która wtyczka posiada dany slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Jeśli wiele wtyczek deklaruje `kind: "memory"`, ładuje się tylko wybrana. Pozostałe
są wyłączane wraz z diagnostyką.

## Interfejs sterowania (schemat + etykiety)

Interfejs sterowania używa `config.schema` (schemat JSON + `uiHints`) do
renderowania lepszych formularzy.

OpenClaw rozszerza `uiHints` w czasie działania na podstawie wykrytych wtyczek:

- Dodaje etykiety per wtyczka dla `plugins.entries.<id>` / `.enabled` / `.config`
- Scala opcjonalne podpowiedzi pól konfiguracji dostarczone przez wtyczki pod:
  `plugins.entries.<id>.config.<field>`

Jeśli chcesz, aby pola konfiguracji wtyczki miały dobre etykiety/miejsca na tekst
(oraz aby oznaczać sekrety jako wrażliwe), dostarcz `uiHints` obok schematu
JSON w manifeście wtyczki.

Przykład:

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

`plugins update` działa tylko dla instalacji npm śledzonych w `plugins.installs`.

Wtyczki mogą także rejestrować własne polecenia najwyższego poziomu (przykład: `openclaw voicecall`).

## API wtyczek (przegląd)

Wtyczki eksportują jedno z dwóch:

- Funkcję: `(api) => { ... }`
- Obiekt: `{ id, name, configSchema, register(api) { ... } }`

## Hooki wtyczek

Wtyczki mogą dostarczać hooki i rejestrować je w czasie działania. Pozwala to
pakować automatyzacje zdarzeniowe bez instalowania osobnego pakietu hooków.

### Przykład

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Uwagi:

- Katalogi hooków stosują standardową strukturę hooków (`HOOK.md` + `handler.ts`).
- Zasady kwalifikowalności hooków nadal obowiązują (wymagania OS/bin/env/config).
- Hooki zarządzane przez wtyczki pojawiają się w `openclaw hooks list` z `plugin:<id>`.
- Nie można włączać/wyłączać hooków zarządzanych przez wtyczki przez `openclaw hooks`; należy włączyć/wyłączyć całą wtyczkę.

## Wtyczki dostawców (uwierzytelnianie modeli)

Wtyczki mogą rejestrować **przepływy uwierzytelniania dostawców modeli**, aby
użytkownicy mogli uruchamiać konfigurację OAuth lub klucza API bezpośrednio w
OpenClaw (bez zewnętrznych skryptów).

Zarejestruj dostawcę przez `api.registerProvider(...)`. Każdy dostawca udostępnia jedną lub
więcej metod uwierzytelniania (OAuth, klucz API, kod urządzenia itp.). Metody te
zasilają:

- `openclaw models auth login --provider <id> [--method <id>]`

Przykład:

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

Uwagi:

- `run` otrzymuje `ProviderAuthContext` z pomocnikami `prompter`, `runtime`,
  `openUrl` oraz `oauth.createVpsAwareHandlers`.
- Zwróć `configPatch`, gdy trzeba dodać domyślne modele lub konfigurację dostawcy.
- Zwróć `defaultModel`, aby `--set-default` mogło zaktualizować domyślne ustawienia agentów.

### Rejestrowanie kanału komunikacyjnego

Wtyczki mogą rejestrować **wtyczki kanałów**, które zachowują się jak kanały
wbudowane (WhatsApp, Telegram itd.). Konfiguracja kanału znajduje się pod
`channels.<id>` i jest walidowana przez kod wtyczki kanału.

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

Uwagi:

- Umieść konfigurację pod `channels.<id>` (nie `plugins.entries`).
- `meta.label` jest używane jako etykieta w listach CLI/UI.
- `meta.aliases` dodaje alternatywne identyfikatory do normalizacji i wejść CLI.
- `meta.preferOver` wymienia identyfikatory kanałów, które należy pominąć przy
  automatycznym włączaniu, gdy oba są skonfigurowane.
- `meta.detailLabel` i `meta.systemImage` pozwalają interfejsom wyświetlać bogatsze
  etykiety/ikony kanałów.

### Pisanie nowego kanału komunikacyjnego (krok po kroku)

Użyj tego, gdy chcesz stworzyć **nową powierzchnię czatu** („kanał komunikacyjny”),
a nie dostawcę modeli.
Dokumentacja dostawców modeli znajduje się pod
`/providers/*`.

1. Wybierz identyfikator i kształt konfiguracji

- Cała konfiguracja kanału znajduje się pod `channels.<id>`.
- Preferuj `channels.<id>.accounts.<accountId>` dla konfiguracji wielokontowych.

2. Zdefiniuj metadane kanału

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` kontrolują listy CLI/UI.
- `meta.docsPath` powinno wskazywać stronę dokumentacji, taką jak `/channels/<id>`.
- `meta.preferOver` pozwala wtyczce zastąpić inny kanał (auto‑włączanie preferuje go).
- `meta.detailLabel` i `meta.systemImage` są używane przez interfejsy do tekstów
  szczegółowych/ikon.

3. Zaimplementuj wymagane adaptery

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (typy czatu, media, wątki itd.)
- `outbound.deliveryMode` + `outbound.sendText` (dla podstawowego wysyłania)

4. Dodaj opcjonalne adaptery według potrzeb

- `setup` (kreator), `security` (polityka DM), `status` (zdrowie/diagnostyka)
- `gateway` (start/stop/login), `mentions`, `threading`, `streaming`
- `actions` (akcje wiadomości), `commands` (natywne zachowanie poleceń)

5. Zarejestruj kanał w swojej wtyczce

- `api.registerChannel({ plugin })`

Minimalny przykład konfiguracji:

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

Minimalna wtyczka kanału (tylko wychodząca):

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

Załaduj wtyczkę (katalog rozszerzeń lub `plugins.load.paths`), zrestartuj gateway,
a następnie skonfiguruj `channels.<id>` w swojej konfiguracji.

### Narzędzia agenta

Zobacz dedykowany przewodnik: [Narzędzia agenta wtyczek](/plugins/agent-tools).

### Rejestrowanie metody RPC Gateway

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Rejestrowanie poleceń CLI

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

### Rejestrowanie poleceń auto-odpowiedzi

Wtyczki mogą rejestrować niestandardowe polecenia ukośnika, które wykonują się
**bez wywoływania agenta AI**. Jest to przydatne dla poleceń przełączających,
sprawdzania statusu lub szybkich akcji, które nie wymagają przetwarzania przez LLM.

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

Kontekst obsługi polecenia:

- `senderId`: identyfikator nadawcy (jeśli dostępny)
- `channel`: kanał, w którym wysłano polecenie
- `isAuthorizedSender`: czy nadawca jest autoryzowanym użytkownikiem
- `args`: argumenty przekazane po poleceniu (jeśli `acceptsArgs: true`)
- `commandBody`: pełny tekst polecenia
- `config`: bieżąca konfiguracja OpenClaw

Opcje polecenia:

- `name`: nazwa polecenia (bez wiodącego `/`)
- `description`: tekst pomocy wyświetlany na listach poleceń
- `acceptsArgs`: czy polecenie akceptuje argumenty (domyślnie: false). Jeśli false, a argumenty zostaną podane, polecenie nie zostanie dopasowane i wiadomość trafi do innych handlerów
- `requireAuth`: czy wymaga autoryzowanego nadawcy (domyślnie: true)
- `handler`: funkcja zwracająca `{ text: string }` (może być asynchroniczna)

Przykład z autoryzacją i argumentami:

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

Uwagi:

- Polecenia wtyczek są przetwarzane **przed** poleceniami wbudowanymi i agentem AI
- Polecenia są rejestrowane globalnie i działają we wszystkich kanałach
- Nazwy poleceń są niewrażliwe na wielkość liter (`/MyStatus` pasuje do `/mystatus`)
- Nazwy poleceń muszą zaczynać się literą i zawierać wyłącznie litery, cyfry, myślniki oraz podkreślenia
- Zastrzeżone nazwy poleceń (takie jak `help`, `status`, `reset` itd.) nie mogą być nadpisywane przez wtyczki
- Zduplikowana rejestracja poleceń pomiędzy wtyczkami zakończy się błędem diagnostycznym

### Rejestrowanie usług w tle

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Konwencje nazewnictwa

- Metody Gateway: `pluginId.action` (przykład: `voicecall.status`)
- Narzędzia: `snake_case` (przykład: `voice_call`)
- Polecenia CLI: kebab lub camel, ale unikaj kolizji z poleceniami rdzenia

## Skills

Wtyczki mogą dostarczać skill w repozytorium (`skills/<name>/SKILL.md`).
Włącz go przez `plugins.entries.<id>.enabled` (lub inne bramki konfiguracyjne) i upewnij się,
że znajduje się w lokalizacjach skills obszaru roboczego/zarządzanych.

## Dystrybucja (npm)

Zalecane pakowanie:

- Pakiet główny: `openclaw` (to repozytorium)
- Wtyczki: osobne pakiety npm pod `@openclaw/*` (przykład: `@openclaw/voice-call`)

Kontrakt publikacji:

- Wtyczka `package.json` musi zawierać `openclaw.extensions` z jednym lub wieloma plikami wejściowymi.
- Pliki wejściowe mogą być `.js` lub `.ts` (jiti ładuje TS w czasie działania).
- `openclaw plugins install <npm-spec>` używa `npm pack`, wypakowuje do `~/.openclaw/extensions/<id>/` i włącza w konfiguracji.
- Stabilność kluczy konfiguracji: pakiety z zakresem są normalizowane do identyfikatora **bez zakresu** dla `plugins.entries.*`.

## Przykładowa wtyczka: Voice Call

To repozytorium zawiera wtyczkę połączeń głosowych (Twilio lub tryb logowania):

- Źródło: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Narzędzie: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Konfiguracja (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (opcjonalnie `statusCallbackUrl`, `twimlUrl`)
- Konfiguracja (dev): `provider: "log"` (bez sieci)

Zobacz [Voice Call](/plugins/voice-call) oraz `extensions/voice-call/README.md` w celu konfiguracji i użycia.

## Uwagi dotyczące bezpieczeństwa

Wtyczki działają w tym samym procesie co Gateway. Traktuj je jako zaufany kod:

- Instaluj tylko wtyczki, którym ufasz.
- Preferuj listy dozwolonych `plugins.allow`.
- Restartuj Gateway po zmianach.

## Testowanie wtyczek

Wtyczki mogą (i powinny) dostarczać testy:

- Wtyczki w repozytorium mogą trzymać testy Vitest pod `src/**` (przykład: `src/plugins/voice-call.plugin.test.ts`).
- Wtyczki publikowane osobno powinny uruchamiać własne CI (lint/build/test) i weryfikować, że `openclaw.extensions` wskazuje na zbudowany punkt wejścia (`dist/index.js`).

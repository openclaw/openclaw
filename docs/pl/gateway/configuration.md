---
summary: "„Wszystkie opcje konfiguracji dla ~/.openclaw/openclaw.json wraz z przykładami”"
read_when:
  - Dodawanie lub modyfikowanie pól konfiguracji
title: "„Konfiguracja”"
---

# Konfiguracja 🔧

OpenClaw odczytuje opcjonalną konfigurację **JSON5** z pliku `~/.openclaw/openclaw.json` (dozwolone są komentarze i przecinki na końcu).

Jeśli plik nie istnieje, OpenClaw używa bezpiecznych (w miarę) ustawień domyślnych (wbudowany agent Pi + sesje per nadawca + obszar roboczy `~/.openclaw/workspace`). Zwykle konfiguracja jest potrzebna tylko po to, aby:

- ograniczyć, kto może wyzwalać bota (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom` itd.)
- kontrolować listy dozwolonych grup i zachowanie wzmiankowania (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- dostosować prefiksy wiadomości (`messages`)
- ustawić obszar roboczy agenta (`agents.defaults.workspace` lub `agents.list[].workspace`)
- dostroić domyślne ustawienia wbudowanego agenta (`agents.defaults`) oraz zachowanie sesji (`session`)
- ustawić tożsamość per‑agent (`agents.list[].identity`)

> **Nowy w konfiguracji?** Zobacz przewodnik [Configuration Examples](/gateway/configuration-examples), aby zapoznać się z kompletnymi przykładami wraz ze szczegółowymi wyjaśnieniami!

## Ścisła weryfikacja konfiguracji

OpenClaw akceptuje wyłącznie konfiguracje, które w pełni odpowiadają schematowi.
Nieznane klucze, błędne typy lub nieprawidłowe wartości powodują, że Gateway **odmawia uruchomienia** ze względów bezpieczeństwa.

Gdy walidacja zakończy się niepowodzeniem:

- Gateway nie startuje.
- Dozwolone są wyłącznie polecenia diagnostyczne (na przykład: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Uruchom `openclaw doctor`, aby zobaczyć dokładne problemy.
- Uruchom `openclaw doctor --fix` (lub `--yes`), aby zastosować migracje/naprawy.

Doctor nigdy nie zapisuje zmian, chyba że jawnie włączysz `--fix`/`--yes`.

## Schemat + podpowiedzi UI

Gateway udostępnia reprezentację JSON Schema konfiguracji poprzez `config.schema` dla edytorów UI.
Control UI renderuje formularz na podstawie tego schematu, z edytorem **Raw JSON** jako wyjściem awaryjnym.

Wtyczki kanałów i rozszerzenia mogą rejestrować schemat oraz podpowiedzi UI dla swojej konfiguracji, dzięki czemu
ustawienia kanałów pozostają sterowane schematem w różnych aplikacjach bez zakodowanych na sztywno formularzy.

Podpowiedzi (etykiety, grupowanie, pola wrażliwe) są dostarczane wraz ze schematem, aby klienci mogli renderować
lepsze formularze bez twardego kodowania wiedzy o konfiguracji.

## Zastosuj + restart (RPC)

Użyj `config.apply`, aby zweryfikować i zapisać pełną konfigurację oraz zrestartować Gateway w jednym kroku.
Polecenie zapisuje znacznik restartu i wysyła ping do ostatniej aktywnej sesji po ponownym uruchomieniu Gateway.

Ostrzeżenie: `config.apply` zastępuje **całą konfigurację**. Jeśli chcesz zmienić tylko kilka kluczy,
użyj `config.patch` lub `openclaw config set`. Zachowaj kopię zapasową `~/.openclaw/openclaw.json`.

Parametry:

- `raw` (string) — ładunek JSON5 dla całej konfiguracji
- `baseHash` (opcjonalne) — hash konfiguracji z `config.get` (wymagane, gdy konfiguracja już istnieje)
- `sessionKey` (opcjonalne) — klucz ostatniej aktywnej sesji do pingu wybudzającego
- `note` (opcjonalne) — notatka do dołączenia do znacznika restartu
- `restartDelayMs` (opcjonalne) — opóźnienie przed restartem (domyślnie 2000)

Przykład (przez `gateway call`):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Aktualizacje częściowe (RPC)

Użyj `config.patch`, aby scalić częściową aktualizację z istniejącą konfiguracją bez nadpisywania
niepowiązanych kluczy. Stosowane są semantyki JSON merge patch:

- obiekty scalają rekursywnie
- `null` usuwa klucz
- tablice są zastępowane  
  Podobnie jak `config.apply`, polecenie waliduje, zapisuje konfigurację, zapisuje znacznik restartu
  i planuje restart Gateway (z opcjonalnym wybudzeniem, gdy podano `sessionKey`).

Parametry:

- `raw` (string) — ładunek JSON5 zawierający wyłącznie klucze do zmiany
- `baseHash` (wymagane) — hash konfiguracji z `config.get`
- `sessionKey` (opcjonalne) — klucz ostatniej aktywnej sesji do pingu wybudzającego
- `note` (opcjonalne) — notatka do dołączenia do znacznika restartu
- `restartDelayMs` (opcjonalne) — opóźnienie przed restartem (domyślnie 2000)

Przykład:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Minimalna konfiguracja (zalecany punkt startowy)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Zbuduj domyślny obraz jednorazowo za pomocą:

```bash
scripts/sandbox-setup.sh
```

## Tryb self‑chat (zalecany do kontroli grup)

Aby zapobiec odpowiadaniu bota na @‑wzmianki WhatsApp w grupach (odpowiadać tylko na określone wyzwalacze tekstowe):

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

## Dołączanie konfiguracji (`$include`)

Podziel konfigurację na wiele plików, używając dyrektywy `$include`. Jest to przydatne do:

- organizowania dużych konfiguracji (np. definicji agentów per klient)
- współdzielenia wspólnych ustawień między środowiskami
- oddzielania wrażliwych konfiguracji

### Podstawowe użycie

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

### Scal zachowanie

- **Pojedynczy plik**: zastępuje obiekt zawierający `$include`
- **Tablica plików**: głęboko scala pliki w kolejności (późniejsze nadpisują wcześniejsze)
- **Z kluczami sąsiednimi**: klucze sąsiednie są scalane po include (nadpisują wartości dołączone)
- **Klucze sąsiednie + tablice/prymitywy**: nieobsługiwane (dołączona zawartość musi być obiektem)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### Zagnieżdżone include

Dołączane pliki mogą same zawierać dyrektywy `$include` (do 10 poziomów):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### Rozwiązywanie ścieżek

- **Ścieżki względne**: rozwiązywane względem pliku dołączającego
- **Ścieżki bezwzględne**: używane bez zmian
- **Katalogi nadrzędne**: odwołania `../` działają zgodnie z oczekiwaniami

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Obsługa błędów

- **Brak pliku**: czytelny błąd z rozwiązaną ścieżką
- **Błąd parsowania**: wskazuje, który dołączony plik się nie powiódł
- **Cykliczne include**: wykrywane i raportowane wraz z łańcuchem include

### Przykład: konfiguracja prawna dla wielu klientów

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

## Wspólne opcje

### Env vars + `.env`

OpenClaw odczytuje zmienne środowiskowe z procesu nadrzędnego (powłoka, launchd/systemd, CI itd.).

Dodatkowo ładuje:

- `.env` z bieżącego katalogu roboczego (jeśli istnieje)
- globalny fallback `.env` z `~/.openclaw/.env` (czyli `$OPENCLAW_STATE_DIR/.env`)

Żaden plik `.env` nie nadpisuje istniejących zmiennych środowiskowych.

Możesz także podać zmienne środowiskowe inline w konfiguracji. Są one stosowane tylko wtedy, gdy
zmienna nie istnieje w środowisku procesu (ta sama zasada braku nadpisywania):

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

Zobacz [/environment](/help/environment), aby poznać pełną kolejność i źródła.

### `env.shellEnv` (opcjonalne)

Opcjonalne ułatwienie: jeśli włączone i żaden z oczekiwanych kluczy nie jest jeszcze ustawiony,
OpenClaw uruchamia powłokę logowania użytkownika i importuje wyłącznie brakujące oczekiwane klucze
(nigdy nie nadpisuje).
W praktyce oznacza to załadowanie profilu powłoki.

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

Równoważnik Env var:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Podstawienie Env var w konfiguracji

Możesz bezpośrednio odwoływać się do zmiennych środowiskowych w dowolnej wartości string
konfiguracji, używając składni `${VAR_NAME}`. Zmienne są podstawiane w czasie ładowania
konfiguracji, przed walidacją.

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

**Zasady:**

- Dopasowywane są tylko nazwy zmiennych zapisane wielkimi literami: `[A-Z_][A-Z0-9_]*`
- Brakujące lub puste zmienne powodują błąd podczas ładowania konfiguracji
- Użyj `$${VAR}`, aby wypisać dosłowny `${VAR}`
- Działa z `$include` (dołączane pliki również podlegają podstawianiu)

**Podstawianie inline:**

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

### Przechowywanie uwierzytelniania (OAuth + klucze API)

OpenClaw przechowuje profile uwierzytelniania **per‑agent** (OAuth + klucze API) w:

- `<agentDir>/auth-profiles.json` (domyślnie: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

Zobacz także: [/concepts/oauth](/concepts/oauth)

Importy starszego OAuth:

- `~/.openclaw/credentials/oauth.json` (lub `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

Wbudowany agent Pi utrzymuje pamięć podręczną czasu wykonania w:

- `<agentDir>/auth.json` (zarządzane automatycznie; nie edytuj ręcznie)

Starszy katalog agenta (sprzed multi‑agent):

- `~/.openclaw/agent/*` (migrowany przez `openclaw doctor` do `~/.openclaw/agents/<defaultAgentId>/agent/*`)

Nadpisania:

- Katalog OAuth (tylko import legacy): `OPENCLAW_OAUTH_DIR`
- Katalog agenta (nadpisanie domyślnego katalogu głównego agenta): `OPENCLAW_AGENT_DIR` (zalecane), `PI_CODING_AGENT_DIR` (legacy)

Przy pierwszym użyciu OpenClaw importuje wpisy `oauth.json` do `auth-profiles.json`.

### `auth`

Opcjonalne metadane dla profili uwierzytelniania. **Nie** przechowuje sekretów; mapuje
identyfikatory profili na dostawcę i tryb (oraz opcjonalny e‑mail) i definiuje kolejność
rotacji dostawców używaną do przełączania awaryjnego.

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

Opcjonalna tożsamość per‑agent używana dla domyślnych ustawień i UX. Zapisywana przez
asystenta onboardingu macOS.

Jeśli ustawiona, OpenClaw wyprowadza domyślne wartości (tylko gdy nie ustawiono ich jawnie):

- `messages.ackReaction` z `identity.emoji` **aktywnego agenta** (fallback 👀)
- `agents.list[].groupChat.mentionPatterns` z `identity.name`/`identity.emoji` agenta (dzięki czemu „@Samantha” działa w grupach na Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)
- `identity.avatar` akceptuje ścieżkę obrazu względem obszaru roboczego lub zdalny URL/data URL. Pliki lokalne muszą znajdować się w obszarze roboczym agenta.

`identity.avatar` akceptuje:

- Ścieżkę względem obszaru roboczego (musi pozostać w obrębie obszaru roboczego agenta)
- URL `http(s)`
- URI `data:`

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

Metadane zapisywane przez kreatory CLI (`onboard`, `configure`, `doctor`).

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

- Domyślny plik logów: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Jeśli potrzebujesz stabilnej ścieżki, ustaw `logging.file` na `/tmp/openclaw/openclaw.log`.
- Wyjście konsoli można stroić osobno poprzez:
  - `logging.consoleLevel` (domyślnie `info`, podnosi do `debug` gdy `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Podsumowania narzędzi mogą być redagowane, aby uniknąć wycieku sekretów:
  - `logging.redactSensitive` (`off` | `tools`, domyślnie: `tools`)
  - `logging.redactPatterns` (tablica regexów; nadpisuje domyślne)

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

Kontroluje sposób obsługi bezpośrednich czatów WhatsApp (DM‑y):

- `"pairing"` (domyślnie): nieznani nadawcy otrzymują kod parowania; właściciel musi zatwierdzić
- `"allowlist"`: zezwalaj tylko nadawcom z `channels.whatsapp.allowFrom` (lub sparowanej listy dozwolonych)
- `"open"`: zezwalaj na wszystkie przychodzące DM‑y (**wymaga**, aby `channels.whatsapp.allowFrom` zawierało `"*"`)
- `"disabled"`: ignoruj wszystkie przychodzące DM‑y

Kody parowania wygasają po 1 godzinie; bot wysyła kod tylko wtedy, gdy tworzona jest nowa prośba. Oczekujące prośby parowania DM są domyślnie ograniczone do **3 na kanał**.

Zatwierdzanie parowania:

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

Lista dozwolonych numerów telefonów E.164, które mogą wyzwalać automatyczne odpowiedzi WhatsApp (**tylko DM‑y**).
Jeśli pusta i `channels.whatsapp.dmPolicy="pairing"`, nieznani nadawcy otrzymają kod parowania.
Dla grup użyj `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

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

Kontroluje, czy przychodzące wiadomości WhatsApp są oznaczane jako przeczytane (niebieskie znaczniki). Domyślnie: `true`.

Tryb self‑chat zawsze pomija potwierdzenia odczytu, nawet gdy włączone.

Nadpisanie per konto: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (wiele kont)

Uruchom wiele kont WhatsApp w jednym gateway:

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

Uwagi:

- Polecenia wychodzące domyślnie używają konta `default`, jeśli istnieje; w przeciwnym razie pierwszego skonfigurowanego identyfikatora konta (sortowane).
- Starszy katalog uwierzytelniania Baileys dla pojedynczego konta jest migrowany przez `openclaw doctor` do `whatsapp/default`.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

Uruchom wiele kont na kanał (każde konto ma własne `accountId` i opcjonalne `name`):

```json5
{
  kanałów: {
    telegram: {
      kont: {
        domyślnie: {
          nazwa: "Primary bot",
          botToken: "123456:ABC... ,
        }, Alerty
        : {
          nazwa: "Alerts bot",
          botToken: "987654:XYZ. .",
        },
      },
    },
  },
}
```

Uwagi:

- `default` jest używany, gdy `accountId` jest pomijany (CLI + routing).
- Tokeny Env dotyczą tylko **domyślnego** konta.
- Podstawowe ustawienia kanału (polityka grupowa, wzmianka o bramkach itp.) stosuje się do wszystkich kont, chyba że nadpisano na konto.
- Użyj `bindings[].match.accountId` aby przekierować każde konto do innego agenta.defaults.

### Bramowanie czatu grupowego (`agents.list[].Czat` + `messages.groupChat`)

Grupuj wiadomości domyślne do **wymaga wzmianki** (albo wspomnienie o metadanych albo wzory regex). Dotyczy czatów grupowych WhatsApp, Telegram, Discord, Google Chat i iMessage

**Rodzaje wspominania:**

- **Wzmianki o metadanych**: Natywna platforma @-wzmianki (np. WhatsApp tap-to-mention). Ignorowane w trybie własnego czatu WhatsApp (patrz `channels.whatsapp.allowFrom`).
- **Wzory tekstu**: Wzory Regex zdefiniowane w `agents.list[].groupChat.mentionPatterns`. Zawsze sprawdzane niezależnie od trybu samodzielnego czatu.
- Bramowanie wzmiankowe jest wymuszone tylko wtedy, gdy wykrycie wzmianki jest możliwe (wzmianki wzmiankowe lub co najmniej jeden "wzmianka").

```json5
{
  wiadomości: {
    groupChat: { historyLimit: 50 },
  },
  agentów: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` ustawia globalny domyślny kontekst historii grupy. Kanały mogą zastąpić `kanałami.<channel>.historyLimit` (lub `channels.<channel>.accounts.*.historyLimit` dla wielu kont. Ustaw `0` aby wyłączyć pakowanie historii.

#### Limity historii DM

Dyskusje DM wykorzystują historię sesji zarządzaną przez agenta. Możesz ograniczyć liczbę turów użytkowników zachowanych na sesji DM:

```json5
{
  kanałów: {
    telegram: {
      dmHistoryLimit: 30, // limit sesji DM do 30 użytkowników zamienia
      dms: {
        "123456789": { historyLimit: 50 }, // nadpisanie przez użytkownika (ID użytkownika)
      },
    },
  },
}
```

Kolejność rozstrzygania:

1. Nadpisanie per-DM: `kanały.<provider>.dms[userId].historyLimit`
2. Domyślny dostawca: `kanały.<provider>.dmHistoryLimit`
3. Brak limitu (cała historia zachowana)

Obsługiwani dostawcy: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Nadpisanie per-agenta (ma pierwszeństwo gdy jest ustawione, nawet `[]`):

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

Wspominanie o domyślnym żywym kanale (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). Po ustawieniu `*.groups` działa również jako lista dozwolonych grup; dołącz `"*"` aby zezwolić wszystkim grupom.

Aby odpowiedzieć **tylko** na określone wyzwalacze tekstowe (ignorując natywne @-wzmianki):

```json5
{
  kanałów: {
    whatsapp: {
      // Dołącz swój własny numer, aby włączyć tryb samodzielnego czatu (ignoruj natywne @-wzmianki).
      allowFod: ["+15555550123"],
      grupy: { "*": { requireMention: true } },
    },
  },
  agentów: {
    lista: [
      {
        id: "main",
        groupChat: {
          // Tylko te wzorce tekstowe wyzwalają odpowiedzi
          wzmianki: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### Zasady grupowe (na kanał)

Użyj `channels.*.groupPolicy` aby kontrolować, czy wiadomości grupowe/pomieszczenia są akceptowane w:

```json5
{
  kanałów: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFod: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFod: ["+15551234567"],
    },
    imesage: {
      groupPolicy: "allowlist",
      groupAllowFod: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org. om"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: {
          kanałów: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      kanały: { "#general": { allow: true } },
    },
  },
}
```

Uwagi:

- `"open"`: groups bypass allowlists; ention-gating nadal występuje.
- \`"disabled": blokuj wszystkie wiadomości grupy/pokoju.
- `"allowlist"`: zezwól tylko na grupy / pokoje, które pasują do skonfigurowanej listy dozwolonych.
- `channels.defaults.groupPolicy` ustawia wartość domyślną, gdy `groupPolicy` dostawcy jest nieustawiona.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams używają `groupAllowFrom` (fallback: explicit `allowFrom`).
- Discord/Slack używaj list kanałów (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- DM z grupy (Discord/Slack) są nadal kontrolowane przez `dm.groupEnabled` + `dm.groupChannels`.
- Domyślnie jest `groupPolicy: "allowlist"` (chyba że nadpisano przez `channels.defaults.groupPolicy`); jeśli nie skonfigurowano dozwolonej listy, wiadomości grupowe są zablokowane.

### Przekierowywanie wielu agentów (`agents.list` + `bindings`)

Uruchom wiele izolowanych czynników (oddzielny obszar roboczy, `agentDir`, sesje) wewnątrz jednej bramy.
Wiadomości przychodzące są kierowane do agenta za pośrednictwem powiązań.

- `agents.list[]`: nadpisanie per-agenta.
  - `id`: stabilny identyfikator agenta (wymagany).
  - `default`: opcjonalne; gdy ustawione są wielokrotności, rejestruje się pierwsze wygrane i ostrzeżenie.
    Jeśli nic nie jest ustawione, **pierwszy wpis** na liście jest domyślnym agentem.
  - `nazwa`: wyświetlana nazwa agenta.
  - `obszar roboczy`: domyślny `~/.openclaw/workspace-<agentId>` (dla `main`, spada z powrotem do `agents.defaults.workspace`).
  - `agentDir`: domyślne `~/.openclaw/agents/<agentId>/agent`.
  - `model`: model domyślny dla agenta, zastępuje `agents.defaults.model` dla tego agenta.
    - formularz ciągu: `"provider/model"`, zastępuje tylko `agents.defaults.model.primary`
    - formularz obiektu: `{ primary, fallbacks }` (fallbacks override `agents.defaults.model.fallbacks`; `[]` wyłącza globalne upadki dla tego agenta)
  - `identity`: nazwa agenta / motyw/emoji (używane do wzmianki o wzorcach + brak reakcji).
  - `groupChat`: na agenta wzmianka o bramce (`mentionPatterns`).
  - `sandbox`: konfiguracja piaskownicy dla agenta (zastępuje `agents.defaults.sandbox`).
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`
    - `zakresu`: `"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`: niestandardowy obszar roboczy sandbox root
    - `docker`: nadpisywanie przez agenta (np. `image`, `sieć`, `env`, `setupCommand`, limity; ignorowane gdy `scope: "shared"`)
    - `browser`: nadpisanie przeglądarki piaskowanej przez agenta (ignorowane, gdy `zakres: "shared"`)
    - `prune`: nadpisywanie piaskownicy dla agenta (ignorowane gdy `zakres: "shared"`)
  - `subagentów`: domyślne dla agenta subagenta.
    - `allowAgents`: allowlist agent id for `sessions_spawn` from this agent (`["*"]` = allow any; default: only this agent)
  - `tools`: ograniczenia narzędzia dla każdego agenta (stosowane przed polityką narzędzia piaskowego).
    - `profile`: profil narzędzia bazowego (stosowany przed zezwolnieniem/odrzuceniem)
    - `allow`: tablica dozwolonych nazw narzędzi
    - `deny`: tablica nazw odrzuconych narzędzi (odmowa wygrana)
- `agents.defaults`: domyślne współdzielony agent (model, obszar roboczy, sandbox, itp.).
- `bindings[]`: kieruje przychodzące wiadomości do `agentId`.
  - `match.channel` (wymagane)
  - `match.accountId` (opcjonalne; `*` = dowolne konto; pominięte = domyślne konto)
  - `match.peer` (opcjonalne; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (opcjonalne; specyficzne dla kanału)

Deterministyczna kolejność meczu:

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (akt, brak peer/guild/team)
5. `match.accountId: "*"` (cały kanał, brak peer/guild/team)
6. domyślny agent (`agents.list[].domyślny`, w przeciwnym razie pierwszy wpis na liście, w przeciwnym razie `"main"`)

W ramach każdego poziomu dopasowania, pierwszy pasujący wpis w `bindings` wygrywa.

#### Profile dostępu per agent (multi‑agent)

Każdy agent może mieć własną piaskownicę + politykę narzędzi. Użyj tego do mieszania poziomów dostępu
w jednej bramie:

- **Pełny dostęp** (osobisty agent)
- **Tylko do odczytu** narzędzia + obszar roboczy
- **Brak dostępu do systemu plików** (tylko narzędzia do wiadomości/sesji)

Zobacz [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) aby uzyskać pierwszeństwo i
dodatkowe przykłady.

Pełny dostęp (bez piaskownika):

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

Narzędzia tylko do odczytu + przestrzeń robocza tylko do odczytu:

```json5
{
  agents: {
    list: [
      {
        id: "family", Obszar roboczy
        : "~/. penclaw/workspace-family",
        sandbox: {
          mode: "all", zakres
          : „agent”,
          obszar roboczyDostęp: "ro",
        },
        tools: {
          allow: [
            "read",
            „sessions_list”,
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ], Odmów
          ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

Brak dostępu do systemu plików (włączono narzędzia do wysyłania wiadomości/sesji):

```json5
{
  agents: {
    list: [
      {
        id: "public", Obszar roboczy
        : "~/. penclaw/workspace-public",
        sandbox: {
          mode: "all", zakres
          : „agent”,
          obszar roboczyDostęp: "brak",
        },
        narzędzi: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            „whatsapp”,
            „telegram”,
            "slack",
            "discord",
            „bramy internetowe”,
          Odmowa
          [
            "read",
            „pisz”,
            "edytuj",
            „apply_patch”,
            "exec",
            „proces”,
            "przeglądarka",
            „płótna”,
            "węzły",
            „cron”,
            „brama”,
            "obraz",
          ],
        },
      },
    ],
  },
}
```

Przykład: dwa konta WhatsApp → dwóch agentów:

```json5
{
  agents: {
    list: [
      { id: "home", domyślnie: true, obszar roboczy: "~/. penclaw/workspace-home" },
      { id: "work", workspace: "~/. penclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", pasuje: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", ID konta: "biz" } },
  ],
  kanałów: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {},
      },
    },
  },
}
```

### `tools.agentToAgent` (opcjonalnie)

Wiadomości od agenta to opt-in:

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `messages.quKoleje`

Kontroluje jak komunikaty przychodzące zachowują się, gdy uruchomiony agent jest już aktywny.

```json5
{
  wiadomości: {
    kolejka: {
      mode: "collect", // steer | kontynuacja | zbierz | steer-backlog (steer+backlog ok) | przerwaj (kolejka=spis sterowania)
      depozycje: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        imesage: "collect",
        webchat: "collect",
      },
    },
  },
}
```

### `messages.inbound`

Odejmij przychodzące wiadomości od **tego samego nadawcy**, więc wielokrotne wiadomości typu wstecz
stają się pojedynczym agentem. Debouncing jest zakresowany per kanał + konwersacja
i używa najnowszej wiadomości do wątkowania odpowiedzi/ID.

```json5
{
  wiadomości: {
    przychody: {
      Depozyty Ms: 2000, // 0 wyłącza
      byChannel: {
        whatsapp: 5000, luz
        : 1500,
        discord: 1500,
      },
    },
  },
}
```

Uwagi:

- Odbiór partii wiadomości **tylko tekstowo**; media / załączniki natychmiast spłudzają.
- Polecenia sterowania (np. `/qukoleje`, `/new`) bypass debouncing tak, aby pozostawały w stanie samodzielnym.

### `komendy` (obsługa poleceń czatu)

Kontroluje jak polecenia czatu są włączone pomiędzy łącznikami.

```json5
{
  polecenia: {
    native: "auto", // rejestruje natywne polecenia kiedy obsługiwane (auto)
    tekst: true, // analizuj polecenia ukośne w wiadomościach czatu
    : fałsz, // zezwól ! (alias: /bash) (tylko host; wymaga narzędzi. utlenione listy dozwolone)
    bashForegroundMs: 2000, // bash okno (0 tła natychmiast)
    config: false, // zezwól /config (zapisy na dysk)
    debugowanie: false, // zezwól /debugowanie (nadpisywanie tylko uruchomienia)
    restart: fałsz, // zezwól /restart + narzędzie do ponownego uruchomienia bramki
    Użyj Grup dostępu: true, // wymuś listy uprawnień/zasady dla komend
  },
}
```

Uwagi:

- Komendy tekstowe muszą być wysyłane jako wiadomość **standalone** i użyć wiodącego `/` (brak aliasów tekstowych).
- `commands.text: false` wyłącza wysyłanie wiadomości na czacie dla poleceń.
- `commands.native: "auto"` (domyślnie) włącza natywne polecenia dla Discord/Telegram i zostawia Slack wyłączony; nieobsługiwane kanały pozostają tylko tekstem.
- Ustaw `commands.native: true|false` aby wymusić wszystko lub nadpisać dla każdego kanału `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool lub `"auto"`). `false` usuwa poprzednio zarejestrowane polecenia na Discordzie/Telegramie przy starcie; polecenia Slack są zarządzane w aplikacji Slack
- `channels.telegram.customCommands` dodaje dodatkowe wpisy do menu bota Telegram. Nazwy są znormalizowane; konflikty z natywnymi poleceniami są ignorowane.
- `commands.bash: true` włącza `! <cmd>` do uruchamiania poleceń powłoki hosta (`/bash <cmd>` działa również jako alias). Wymaga `tools.elevated.enabled` i pozwala nadawcy na wpisanie `tools.elevated.allowFrom.<channel>`.
- `commands.bashForegroundMs` kontroluje, jak długo czeka na tło. Gdy praca w bash jest uruchomiona, nowy `! <cmd>` żądania zostały odrzucone (jeden naraz).
- `commands.config: true` włącza `/config` (reads/writes `openclaw.json`).
- `kanały.<provider>Bramki Bramki .configWrites` zapoczątkowane przez ten kanał (domyślnie: true). Dotyczy to `/config set|unset` plus auto-migracje specyficzne dla dostawcy (zmiany identyfikatora supergrupy Telegram, zmiany identyfikatora kanału Slack).
- `commands.debug: true` włącza `/debug` (nadpisywanie tylko do uruchomienia).
- `commands.restart: true` włącza `/restart` i czynność ponownego uruchomienia narzędzia bramy.
- `commands.useAccessGroups: false` pozwala poleceniom omijać listy uprawnień/zasady grup dostępu.
- Polecenia slash i dyrektywy są honorowane wyłącznie dla **autoryzowanych nadawców**. Autoryzacja pochodzi z kanału
  Zezwalaj/parowanie plus `commands.useAccessGroups`.

### `web` (WhatsApp Web channel runtime)

WhatsApp działa przez kanał internetowy bramki (Baileys Web). Rozpoczyna się automatycznie, gdy połączona sesja istnieje.
Ustaw `web.enabled: false` aby wyłączyć domyślnie.

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    ponownie połączy: {
      inicjały: 2000,
      maxMs: 120000,
      czynnik: 1. ,
      uderzenia: 0. ,
      maxAttempts: 0,
    },
  },
}
```

### `channels.telegram` (transport botów)

OpenClaw uruchamia Telegram tylko wtedy, gdy istnieje sekcja konfiguracji `channels.telegram`. Token bota jest rozwiązany z `channels.telegram.botToken` (lub `channels.telegram.tokenFile`), z `TELEGRAM_BOT_TOKEN` jako rezerwa dla konta domyślnego.
Ustaw `channels.telegram.enabled: false` aby wyłączyć automatyczne uruchamianie.
Obsługa wielu kont żyje pod `channels.telegram.accounts` (patrz powyżej sekcja wielokonta). Tokeny Env odnoszą się tylko do konta domyślnego.
Ustaw `channels.telegram.configWrites: false` aby zablokować zapisy konfiguracyjne inicjowane przez Telegram-(łącznie z migracjami supergrupy ID i ustawieniami `/config |unset`).

```json5
{
  kanałów: {
    telegram: {
      włączone: true,
      botToken: "your-bot-token",
      dmPolicy: "parowanie", // parowanie | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // opcjonalne; "open" wymaga ["*"]
      grup: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          SystemPromp: "Zachowaj odpowiedzi krótko. ,
          tematów: {
            "99": {
              requireMention: false,
              umiejętności: ["Szukaj"],
              SystemPromp: "Zostań w temacie. ,
            },
          },
        },
      },
      customCommands: [
        { command: "backup", opis: "Git backup" },
        { command: "generate", opis: "Utwórz obraz" },
      ],
      HistoryLimit: 50, // dołącz ostatnie N wiadomości grupowych jako kontekst (0 wyłączonych)
      replyToMode: "first", // wył | najpierw | wszystkie linki
      : true, // przełącz podgląd połączeń wychodzących
      streamMode: "częściowe", // wyłączone | częściowe | blok (szkic streamingu; oddziel od streamingu blokowego)
      draftChunk: {
        // opcjonalne; tylko dla streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // akapit | nowa linia | zdanie
      },
      akcji: { reactions: true, sendMessage: true }// bramki akcji narzędzia (fałszywie wyłączone)
      Powiadomienia reakcji: "własne", // off | własne | wszystkie
      mediaMaxMb: 5,
      powtórzeń: {
        // wychodzące zasady powtórzenia
        prób: 3,
        minOpóźnienia: 400,
        maxDelayMs: 30000,
        uderzenie: 0. ,
      }, Sieć
      : {
        // transport nadpisuje
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example. om/telegram-webhook", // wymaga webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

Notatki do przesyłania strumieniowego:

- Używa Telegram `sendMessageDraft` (szkic bańki, a nie prawdziwej wiadomości).
- Wymaga **prywatnych wątków czatu** (message_thread_id w DMs; bot ma włączone tematy).
- Rozumowanie strumieni `/reasoning stream` do szkicu, a następnie wysyła ostateczną odpowiedź.
  Ponownie spróbuj domyślnych reguł i zachowań są udokumentowane w [Reguła próby](/concepts/retry).

### `channels.discord` (transport botów)

Skonfiguruj bota Discorda, ustawiając token bota i opcjonalne gatowanie:
Wsparcie wielu kont pod `channels.discord.accounts` (patrz sekcja więcej niż jedno konto). Tokeny Env odnoszą się tylko do konta domyślnego.

```json5
{
  kanałów: {
    discord: {
      włączone: true, Token
      : "your-bot-token",
      mediaMaxMb: 8, // clamp przychodzący rozmiar
      zezwala: fałsz, // zezwalaj na bot-autorowane wiadomości
      akcje: {
        // bramki akcji narzędzia (false disables)
        reakcje: true, Naklejki
        : prawda,
        ankiet: prawda, Uprawnienia
        : prawda,
        wiadomości: true,
        wątki: true,
        piny: true,
        search: true,
        userInfo: true,
        role Info: true, Rola
        : false,
        channelInfo: true,
        voiceStatus: true,
        zdarzeń: prawda,
        moderacja: fałsz,
      },
      replyToMode: "off", // wył. | najpierw | wszystkie
      dm: {
        włączone: true, // wyłącz wszystkie pamięci DM, gdy reguła false
        : "parowanie", // parowanie | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // opcjonalna lista dozwolonych DM ("open" wymaga ["*"])
        grupowe: false, // włącz grupę DM.
        groupChannels: ["openclaw-dm"], // opcjonalna lista DM grupy DM
      },
      gildii: {
        "123456789012345678": {
          // id gildii (preferowany) lub slug
          slug: "friends-of-openclaw",
          Wymaganie: fałszywe, // / per -guild default
          Notifications "own", // off | własne | wszystkie | allowlist
          użytkowników: ["987654321098765432"], // opcjonalna lista użytkownika dla gildii
          kanałów: {
            ogólnie: { allow: true },
            pomoc: {
              zezwól na: true, Wymaganie
              : prawda,
              użytkowników: ["987654321098765432"],
              umiejętności: ["docs"], Pysk systemowy
              : "Tylko krótkie odpowiedzi. ,
            },
          },
        },
      },
      HistoryLimit: 20, // dołącz ostatnie N wiadomości gildii jako kontekst
      textChunkLimit: 2000, // opcjonalny rozmiar fragmentu tekstu wychodzącego (znaków)
      tryb chunkMode: "length", // opcjonalny tryb chunking (długość | nowy)
      maxLinesPerMessage: 17, // soft max linii na wiadomość (Discord UI clipping)
      powtórzenia: {
        // wychodzące zasady retry
        prób: 3,
        minOpóźnienia: 500,
        maxDelayMs: 30000,
        jitter: 0. ,
      },
    },
  },
}
```

OpenClaw uruchamia Discord tylko wtedy, gdy istnieje sekcja konfiguracji `channels.discord`. Token jest rozwiązany z `channels.discord.token`, z `DISCORD_BOT_TOKEN` jako domyślne konto (chyba że `channels.discord.enabled` jest `false`). Użyj `user:<id>` (DM) lub `channel:<id>` (kanał gildii) podczas określania celów dostawy dla poleceń cron/CLI; niepotrzebne identyfikatory numeryczne są niejednoznaczne i odrzucone.
Slugi gildii są małymi literami ze spacjami zastąpionymi przez `-`; klucze kanału używają nazwy kanału slugowanego (brak wiodącego `#`). Preferuj identyfikatory gildii jako klucze, aby uniknąć zmiany nazwy dwuznaczności.
Domyślnie ignorowane są wiadomości z bota. Włącz z `channels.discord.allowBots` (własne wiadomości są nadal filtrowane, aby zapobiec pętlom autoodpowiedzi).
Tryb powiadomień reakcji:

- `off`: brak zdarzeń reakcji.
- `own`: reakcje na własnych wiadomościach bota (domyślnie).
- `all`: wszystkie reakcje na wszystkich wiadomościach.
- `allowlist`: reakcje od `guilds.<id>.users` na wszystkich wiadomościach (pusta lista wyłącza).
  Tekst wychodzący jest chunkowany przez `channels.discord.textChunkLimit` (domyślnie 2000). Ustaw `channels.discord.chunkMode="newline"` aby podzielić na puste linie (granice paragrafów) przed wycinaniem długości. Klienci Discorda mogą klipować bardzo wysokie wiadomości, więc `channels.discord.maxLinesPerMessage` (domyślnie 17) dzieli długie wielowymiarowe odpowiedzi nawet gdy są poniżej 2000 znaków.
  Ponownie spróbuj domyślnych reguł i zachowań są udokumentowane w [Reguła próby](/concepts/retry).

### `channels.googlechat` (Chat API webhook)

Czat Google działa przez webhooki HTTP z autoryzacją na poziomie aplikacji (konto usług).
Obsługa wielu kont żyje pod `channels.googlechat.accounts` (patrz powyżej sekcja wielokonta). Env vars ma zastosowanie tylko do konta domyślnego.

```json5
{
  kanałów: {
    googlechat: {
      włączone: true,
      serviceAccountFile: "/path/to/service-account. son",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example. om/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // opcjonalne; ulepsza wzmiankę o wykrywaniu
      dm: {
        włączone: true, polityka
        : „parowanie”, // parowanie | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // opcjonalne; "open" wymaga ["*"]
      },
      groupPolicy: "allowlist",
      grupy: {
        "spaces/AAAA": { allow: true, requireMention: true }
      },
      działania: { reactions: true },
      pisingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Uwagi:

- Konto usługi JSON może być wbudowane (`serviceAccount`) lub oparte na plikach (`serviceAccountFile`).
- Env fallbacks dla domyślnego konta: `GOOGLE_CHAT_SERVICE_ACCOUNT` lub `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `audienceType` + `audience` musi odpowiadać konfiguracji webhooka aplikacji czatu.
- Użyj `spacje/<spaceId>` lub `użytkowników/<userId|email>` podczas ustawiania celów dostawy.

### `channels.slack` (tryb gniazda)

Slack działa w trybie Socket i wymaga zarówno tokena bota, jak i tokenu aplikacji:

```json5
{
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

Obsługa wielu kont żyje pod `channels.slack.accounts` (patrz powyżej sekcja wielokonta). Tokeny Env odnoszą się tylko do konta domyślnego.

OpenClaw rozpoczyna Slack, gdy dostawca jest włączony i oba tokeny są ustawione (poprzez konfigurację lub `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Użyj `user:<id>` (DM) lub `channel:<id>` podczas określania celów dostawy dla poleceń cron/CLI.
Ustaw `channels.slack.configWrites: false` aby zablokować inicjowane Slack-config zapisy konfiguracyjne (w tym migracje ID kanału i `/config set|unset`).

Domyślnie ignorowane są wiadomości z bota. Włącz za pomocą `channels.slack.allowBots` lub `channels.slack.channels.<id>.allowBots`.

Tryb powiadomień reakcji:

- `off`: brak zdarzeń reakcji.
- `own`: reakcje na własnych wiadomościach bota (domyślnie).
- `all`: wszystkie reakcje na wszystkich wiadomościach.
- `allowlist`: reakcje z `channels.slack.reactionAllowlist` na wszystkich wiadomościach (pusta lista wyłączona).

Izolacja sesji wątków:

- `channels.slack.thread.historyScope` kontroluje czy historia wątku jest dla każdego wątku (`wątek, domyślny`, domyślnie) czy współdzielona przez kanał (`kanał`).
- `channels.slack.thread.inheritParent` kontroluje czy nowe sesje wątków odziedziczą transkrypt kanału nadrzędnego (domyślnie: fałsz).

Grupy akcji Slack (działania narzędzia "bramy "slack"):

| Grupa akcji | Domyślnie | Notes                            |
| ----------- | --------- | -------------------------------- |
| reactions   | włączone  | Reakcje + lista reakcji          |
| messages    | włączone  | Odczyt/wysyłanie/edycja/usuwanie |
| pins        | włączone  | Przypinanie/odpinanie/lista      |
| memberInfo  | włączone  | Informacje o członkach           |
| emojiList   | włączone  | Lista niestandardowych emoji     |

### `channels.mattermost` (token bota)

Mattermost jest dostarczany jako wtyczka i nie jest dołączony do instalacji rdzenia.
Zainstaluj najpierw: `openclaw plugins install @openclaw/mattermost` (lub `./extensions/mattermost` z git checkout).

Najbardziej potrzebny jest token bota plus podstawowy adres URL dla Twojego serwera:

```json5
{
  kanałów: {
    mattermost: {
      włączone: true,
      botToken: "mm-token",
      baseUrl: "https://chat. xample. om",
      dmPolicy: "parowanie",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "! ],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

OpenClaw rozpoczyna się Mattermost gdy konto jest skonfigurowane (token bota + bazowy adres URL) i włączone. Token + bazowy adres URL są rozwiązywane z `channels.mattermost.botToken` + `channels.mattermost.baseUrl` lub `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` dla domyślnego konta (chyba że `channels.mattermost.enabled` to `false`).

Tryb czatu:

- `oncall` (domyślnie): odpowiadaj na wiadomości kanału tylko wtedy, gdy @wspomniała.
- `onmessage`: odpowiada na każdą wiadomość w kanale.
- `onchar`: odpowiadaj, gdy wiadomość zaczyna się od prefiksu wyzwalacza (`channels.mattermost.oncharPrefixes`, domyślnie `[">", "!"]`).

Kontrola dostępu:

- Domyślne DM: `channels.mattermost.dmPolicy="pairing"` (nieznani nadawcy otrzymują kod parowania).
- Publiczne DM-y: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.
- Grupy: `channels.mattermost.groupPolicy="allowlist"` domyślnie (mention-gated). Użyj `channels.mattermost.groupAllowFrom` aby ograniczyć nadawców.

Obsługa wielu kont żyje pod `channels.mattermost.accounts` (patrz powyżej sekcja wielokonta). Env vars ma zastosowanie tylko do konta domyślnego.
Użyj `channel:<id>` lub `user:<id>` (lub `@username`) podczas określania celów dostawy; ukryte identyfikatory są traktowane jako identyfikatory kanałów.

### `channels.signal` (sygnał-cli)

Reakcje sygnałowe mogą emitować zdarzenia systemowe (narzędzie współdzielonej reakcji):

```json5
{
  kanałów: {
    sygnał: {
      reactionNotifications: "own", // off | własne | wszystkie | allowlist
      reactionAllowlist: ["+15551234567", "uid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // dołącz ostatnie N wiadomości grupy jako kontekst (0 wyłączonych)
    },
  },
}
```

Tryb powiadomień reakcji:

- `off`: brak zdarzeń reakcji.
- `own`: reakcje na własnych wiadomościach bota (domyślnie).
- `all`: wszystkie reakcje na wszystkich wiadomościach.
- `allowlist`: reakcje z `channels.signal.reactionAllowlist` na wszystkie wiadomości (pusta lista wyłączona).

### `channels.imessage` (imsg CLI)

OpenClaw tworzy `imsg rpc` (JSON-RPC nad stdio). Demon lub port nie jest wymagany.

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

Obsługa wielu kont żyje pod `channels.imessage.accounts` (patrz powyżej sekcja wielokonta).

Uwagi:

- Wymaga pełnego dostępu na dysku do DB.
- Pierwsza wysyłka poprosi o pozwolenie na automatyzację wiadomości.
- Preferuj 'chat_id:<id>' celu. Użyj `czatów imsg --limit 20` aby wyświetlić listę czatów.
- `channels.imessage.cliPath` może wskazywać skrypt wrapper (np. `ssh` do innego Maca, który uruchamia `imsg rpc`); użyj kluczy SSH, aby uniknąć zapytań o hasło.
- Dla zdalnych zawijaczy SSH ustaw `channels.imessage.remoteHost` aby pobrać załączniki za pośrednictwem SCP gdy `includeAttachments` jest włączone.

Przykładowe opakowanie:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

Ustawia **pojedynczy globalny katalog projektowy** używany przez konsultanta do operacji plików.

Domyślnie: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Jeśli `agents.defaults.sandbox` jest włączony, sesje inne niż główne mogą zastąpić to ich własnymi projektami
w zakresie pod `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

Opcjonalny root repozytorium, aby pokazać w wierszu instrukcji systemowej. Jeśli nie jest ustawiony, OpenClaw
próbuje wykryć katalog `.git` przechodząc w górę z obszaru roboczego (i aktualny katalog roboczy
. Ścieżka musi być używana.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

Wyłącza automatyczne tworzenie plików bootstrap (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, i `BOOTSTRAP.md`).

Użyj tego dla wstępnie zaszyfrowanych wdrożeń, w których pliki projektu pochodzą z repozytorium.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

Maksymalna liczba znaków każdego pliku bootstrap wprowadzonego do systemu
przed naciśnięciem. Domyślnie: `20000`.

Gdy plik przekracza ten limit, OpenClaw rejestruje ostrzeżenie i wstrzykuje obcięty nagłówek/ogon
za pomocą znacznika.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

Ustawia strefę czasową użytkownika dla **kontekstu wskazówek systemowych** (nie dla znaczników czasu w kopertach komunikatów
). Jeśli wyłączone, OpenClaw używa strefy czasowej hosta w czasie uruchomienia.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

Kontroluje **format czasu** wyświetlany w aktualnej sekcji daty i czasu w oknie systemu.
Domyślnie: `auto` (preferencje OS).

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `wiadomości`

Kontroluje prefiksy graniczne/wychodzące i opcjonalne reakcje na brak.
Zobacz [Messages](/concepts/messages) dla kolejkowania, sesji i kontekstu streamowania.

```json5
{
  wiadomości: {
    responsePrefix: "🦞", // lub "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` jest stosowany do **wszystkich odpowiedzi wychodzących** (podsumowania narzędzi, blok
streaming, odpowiedzi końcowe) przez kanały, chyba że są już obecne.

Nadpisania można skonfigurować dla każdego kanału i dla każdego konta:

- `channels.<channel>.responsePrefix`
- `channels.<channel>.accounts.<id>.responsePrefix`

Kolejność rozstrzygania (najbardziej szczegółowe wygrywa):

1. `channels.<channel>.accounts.<id>.responsePrefix`
2. `channels.<channel>.responsePrefix`
3. `messages.responsePrefix`

Semantyki:

- `undefined` przechodzi do następnego poziomu.
- `""` wyraźnie wyłącza przedrostek i zatrzymuje kaskadę.
- `"auto"` uzyskuje `[{identity.name}]` dla przekierowanego agenta.

Nadpisywanie stosuje się do wszystkich kanałów, w tym rozszerzeń, oraz do każdego rodzaju odpowiedzi wychodzącej.

Jeśli `messages.responsePrefix` jest nieustawiony, nie stosuje się żadnego prefiksu. WhatsApp self-chat
odpowiedzi są wyjątkiem: domyślnie `[{identity.name}]` gdy jest ustawiony, w przeciwnym razie
`[openclaw]`, więc rozmowy samonatelefoniczne są czytelne.
Ustaw na `"auto"` aby uzyskać `[{identity.name}]` dla przekierowanego agenta (gdy ustawiony).

#### Zmienne szablonu

Ciąg `responsePrefix` może zawierać zmienne szablonu, które rozwiązują dynamicznie:

| Zmienna           | Opis                         | Przykład                                        |
| ----------------- | ---------------------------- | ----------------------------------------------- |
| `{model}`         | Krótka nazwa modelu          | `claude-opus-4-6`, `gpt-4o`                     |
| `{modelFull}`     | Identyfikator pełnego modelu | `anthropic/claudeopus-4-6`                      |
| `{provider}`      | Nazwa dostawcy               | `anthropic`, `openai`                           |
| `{thinkingLevel}` | Bieżący poziom myślenia      | `wysoki`, `niski`, `off`                        |
| `{identity.name}` | Nazwa tożsamości agenta      | (tak samo jak tryb "auto"\`) |

Zmienne są niewrażliwe na wielkość liter (`{MODEL}` = `{model}`). `{think}` jest aliasem dla `{thinkingLevel}`.
Nierozwiązane zmienne pozostają dosłownym tekstem.

```json5
{
  wiadomości: {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

Przykład wyjścia: `[claude-opus-4-6 | think:high] Oto moja odpowiedź...`

WhatsApp przychodzący prefiks jest skonfigurowany przez `channels.whatsapp.messagePrefix` (przestarzały:
`messages.messagePrefix`). Domyślnie **bez zmian**: `"[openclaw]"` gdy
`channels.whatsapp.allowFrom` jest pusty, w przeciwnym razie `""` (brak prefiksu). Gdy używasz
`"[openclaw]"`, OpenClaw użyje zamiast tego `[{identity.name}]`, gdy przekierowany agent
ma ustawioną `identity.name`.

`ackReaction` wysyła reakcję z wielkim wysiłkiem emoji, aby potwierdzić przychodzące wiadomości
na kanałach obsługujących reakcje (Slack/Discord/Telegram/Google Chat). Domyślnie dla
aktywnego agenta `identity.emoji`, gdy jest ustawiony, w przeciwnym razie `"👀"`. Ustaw na `""` aby wyłączyć.

`ackReactionScope` kontroluje podczas reakcji na ogień:

- `group-mentions` (domyślnie): tylko wtedy, gdy grupa / pokój wymaga wzmianki **i** o botu
- `group-all`: wszystkie wiadomości grupy/pokoju
- `direct`: tylko bezpośrednie wiadomości
- `all`: wszystkie wiadomości

`removeAckAfterReply` usuwa reakcję bota po wysłaniu odpowiedzi
(tylko Slack/Discord/Telegram/Google Chat). Domyślnie: `false`.

#### `messages.tts`

Włącz tekst na mowę dla odpowiedzi wychodzących. Gdy włączony, OpenClaw generuje dźwięk
przy użyciu ElevenLabs lub OpenAI i dołącza go do odpowiedzi. Telegram używa notatek głosowych Opus
; inne kanały wysyłają dźwięk MP3.

```json5
{
  wiadomości: {
    tts: {
      automatycznie: "zawsze", // off | zawsze | tryb przychodzący | oznaczony
      : "final", // final | wszystkie (zawierają odpowiedzi narzędzi/bloki)
      dostawca: "elevenlabs",
      Podsumowanie: "openai/gpt-4. -mini",
      modelNadpisywanie: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsŚcieżka: "~/. ołówek/ustawienia/tts. son",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api. levenlab. o",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed 42,
        applyTextNormalizacja: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0. ,
          podobieństwo Boost: 0. Styl 5,
          : 0. ,
          useSpeakerBoost: true, Prędkość
          : 1. ,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        głos: "stopy",
      },
    },
  },
}
```

Uwagi:

- `messages.tts.auto` kontroluje auto-TTS (`off`, `zawsze`, `inbound`, `ttaged`).
- `/tts off|zawsze|inbound|ttaged` ustawia tryb auto sesji (nadpisuje konfigurację).
- `messages.tts.enabled` jest legacy; lekarz migruje go do `messages.tts.auto`.
- `prefsPath` przechowuje lokalne nadpisania (provider/limit/summarize).
- `maxTextLength` jest twardym limitem wejścia TTS; podsumowania są obcięte, aby pasować.
- `summaryModel` zastępuje `agents.defaults.model.primary` dla automatycznego podsumowania.
  - Akceptuje `provider/model` lub alias z `agents.defaults.models`.
- `modelOverrides` umożliwia generowane przez model nadpisywanie tagów `[[tts:...]` (domyślnie).
- Ustawienia podsumowania `/tts limit` i `/tts summary` dla każdego użytkownika.
- Wartości `apiKey` wracają do `ELEVENLABS_API_KEY`/`XI_API_KEY` i `OPENAI_API_KEY`.
- `elevenlabs.baseUrl` zastępuje bazowy adres URL API ElevenLabs.
- `elevenlabs.voiceSettings` obsługuje `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost`, i `speed` (0.5..2.0).

### `talk`

Domyślnie dla trybu Talk (macOS/iOS/Android). Identyfikatory głosowe wracają do `ELEVENLABS_VOICE_ID` lub `SAG_VOICE_ID` po wyłączeniu.
`apiKey` spada z powrotem do `ELEVENLABS_API_KEY` (lub profil powłoki bramy), gdy jest nieustawiony.
`voiceAliases` let Talk Directive using friendly names (e.g. `"voice":"Clawd"`).

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

Kontroluje wbudowany agent czas pracy (model/myślenie/verbose/timeout).
`agents.defaults.models` definiuje skonfigurowany katalog modeli (i działa jako lista dozwolona dla `/model`).
`agents.defaults.model.primary` ustawia domyślny model; `agents.defaults.model.fallbacks` są globalnymi failovers.
`agents.defaults.imageModel` jest opcjonalny i jest **używane tylko wtedy, gdy model podstawowy nie zawiera obrazu**.
Każdy wpis `agents.defaults.models` może zawierać:

- `alias` (opcjonalny skrót modelowy, np. `/opus`).
- `params` (opcjonalne parametry API specyficzne dla dostawcy, przekazane do żądania modelu).

`params` jest również stosowany do operacji strumieniowych (wbudowany agent + frakcja). Obsługiwane klucze dzisiaj: `temperatura`, `maxTokens`. Te połączenia z opcjami czasu połączenia; wartości dostarczane przez dzwoniącego wygrywają. `temperatura` jest zaawansowanym pokrętłem - pozostaw nieustawione, chyba że znasz domyślne ustawienia modelu i potrzebujesz zmiany.

Przykład:

```json5
{
  agents: {
    domyślnie: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5. ": {
          parametry: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Modele Z.AI GLM-4.x automatycznie włączają tryb myślenia, chyba że:

- ustaw `--thinking wyłączony`, lub
- definiuj `agents.defaults.models["zai/<model>"].params.thinking`.

OpenClaw również dostarcza kilka wbudowanych skrótów aliasu. Domyślnie stosuje się tylko, gdy model
jest już obecny w `agents.defaults.models`:

- `opus` -> `anthropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

Jeśli skonfigurujesz tę samą nazwę aliasu (wielkość liter jest różna od liter), Twoja wartość wygrywa (domyślnie nigdy nie nadpisywana).

Przykład: Opus 4.6 podstawowy z awaryjnym miniMax M2.1 (hosted MiniMax):

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2. ": { alias: "minimax" },
      }, Model
      : {
        primary: "anthropic/claude-opus-4-6",
        spada: ["minimax/MiniMax-M2. "],
      },
    },
  },
}
```

MiniMax auth: ustaw `MINIMAX_API_KEY` (env) lub skonfiguruj `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI fallback)

Opcjonalne backendy CLI dla trybu awaryjnego tylko tekstowego (brak połączeń narzędzi). Są one przydatne jako ścieżka tworzenia kopii zapasowej
gdy dostawcy API nie powiedzą się. Przejście obrazu jest obsługiwane podczas konfigurowania
pliku `imageArg`, który akceptuje ścieżki plików.

Uwagi:

- backendy CLI są **tekst-first**; narzędzia są zawsze wyłączone.
- Sesje są obsługiwane, gdy ustawiona jest `sessionArg`; identyfikatory sesji są utrzymywane na zapleczu.
- Dla `claude-cli`, domyślne ustawienia są włączone. Zastąp ścieżkę poleceń, jeśli PATH jest minimalny
  (uruchomiony/system).

Przykład:

```json5
{
  agents: {
    domyślnie: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"], Wyjście
          : „json”,
          modelArg: "--model", sesja
          Arg: "--session", Tryb sesyjny
          : "istnieje",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image", Tryb obrazka
          : "repeat",
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
          alias: "GLM", Parametry
          : {
            myślenie: {
              type: "enabled",
              clear_myśli: fałszywe,
            },
          },
        },
      }, Model
      : {
        primary: "anthropic/claude-opus-4-6",
        wypada: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3. -70b-instruct:free",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2. -vl-72b-instruct:free",
        upada: ["openrouter/google/gemini-2. -flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off", Domyślny wzrost
      : "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      uderzenie serca: {
        zawsze: "30m", Cel
        : "ostatni",
      },
      maksymalnie: 3,
      subagentów: {
        model: "minimax/MiniMax-M2. ",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        tła: 10000,
        timeoutSec: 1800,
        czyszczenia: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### `agents.defaults.contextPruning` (przybornik efektu)

`agents.defaults.contextPruning` prunes **stare narzędzie wynika** z kontekstu w pamięci bezpośrednio przed wysłaniem żądania do LLM.
To **nie** modyfikuje historię sesji na dysku (`*.jsonl` pozostaje gotowe).

Ma to na celu ograniczenie użycia tokenów dla czynników czatowych, które gromadzą duże narzędzia na przestrzeni czasu.

Wysoki poziom:

- Nigdy nie dotyka wiadomości użytkownika/asystenta.
- Chroni ostatnie wiadomości asystenta `keepLastAssistants` (nie ma wyników narzędzia po tym punkcie są prundy).
- Chroni prefiks bootstrap (nie ma nic przed wyciskaniem pierwszej wiadomości użytkownika).
- Tryby:
  - `adaptive`: wyniki narzędzi o rozmiarze nadmiaru (zachowaj głowę/ogon), gdy szacowany stosunek kontekstu przecina `softTrimRatio`.
    Następnie twardo wyczyści najstarsze kwalifikujące się narzędzia gdy szacowany współczynnik kontekstu przecina `hardClearRatio` **i**
    jest wystarczająco dużo narzędzia prądowego (`minPrunableToolChars`).
  - `aggressive`: zawsze zastępuje kwalifikujące się wyniki narzędzia przed odcięciem `hardClear.placeholder` (brak kontroli).

Soft vs hard pruning (jakie zmiany w kontekście wysłano do LLM):

- **Soft-trim**: tylko dla wyników narzędzi _nadrozmiaru_ Zachowuje początek + koniec i umieszcza `...` w środku.
  - Przed: `toolResult("…bardzo długi wyjście…")`
  - Po: `toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")`
- **Trudno wyjaśnić**: zastępuje cały wynik narzędzia symbolem zastępczym.
  - Przed: `toolResult("…bardzo długi wyjście…")`
  - Po: `toolResult("[Old tool result content cleard]")`

Uwagi / aktualne ograniczenia:

- Wyniki narzędzi zawierające **bloki obrazów są pomijane** (nigdy nie przycięte/wyczyszczone).
- Oszacowany „współczynnik kontekstu” opiera się na **znakach** (przybliżonym), a nie dokładnych tokenach.
- Jeśli sesja nie zawiera jeszcze co najmniej wiadomości asystenta `keepLastAssistants`, odprawa jest pomijana.
- W trybie `aggressive` `hardClear.enabled` jest ignorowany (kwalifikujące się wyniki narzędzia są zawsze zastępowane `hardClear.placeholder`).

Domyślne (adaptacyjne):

```json5
{
  agents: { defaults: { contextPruning: { mode: "adaptive" } },
}
```

Aby wyłączyć:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } },
}
```

Domyślne (gdy `mode` to `"adaptive"` lub `"aggressive"`):

- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3` (tylko adaptacyjne)
- `hardClearRatio`: `0.5` (tylko adaptacyjne)
- `minPrunableToolChars`: `50000` (tylko adaptacyjne)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (tylko adaptacyjne)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

Przykład (agresywny, minimalny):

```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } },
}
```

Przykład (adaptacyjny):

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        zachowuje Asystentów: 3,
        softTrimRatio: 0. ,
        hardClearRatio: 0. ,
        minunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, zamiennik: "[Zawartość rezultatu starego narzędzia wyczyszczona]" },
        // Opcjonalnie: Ogranicz wycinanie do konkretnych narzędzi (odrzuć wygrane; obsługuje "*" wildcards)
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

Zobacz [/concepts/session-pruning](/concepts/session-pruning) w celu uzyskania szczegółów zachowań.

#### `agents.defaults.compaction` (zarezerwuj pokój głowy + opróżnianie pamięci)

`agents.defaults.compaction.mode` wybiera strategię podsumowania kompakty. Domyślne do `default`; ustaw `Securard` aby włączyć podsumowanie chunked dla bardzo długich historii. Zobacz [/concepts/compaction](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor` wymusza minimalną wartość `reserveTokens`
dla zagęszczenia Pi (domyślnie: `20000`). Ustaw na `0` aby wyłączyć podłoże.

`agents.defaults.compaction.memoryFlush` uruchamia **cich** agentic obrót przed
auto-compaction, instruując model do przechowywania trwałych pamięci na dysku (np.
`memory/YYYY-MM-DD.md`). Wyzwala się, gdy szacowany token sesji przekroczy wartość
miękkiego progu poniżej limitu frakcji.

Domyślnie starsze:

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: wbudowane domyślne ustawienia z `NO_REPLY`
- Uwaga: pamięć jest pominięta, gdy obszar roboczy sesji jest tylko do odczytu
  (`agents.defaults.sandbox.workspaceAccess: "ro"` lub `"none"`).

Przykład (czujny):

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "Securard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          włączone: true,
          softThresholdTokens: 6000,
          SystemPrompt: "Sesja zbliżająca się do zagęszczania. Przechowuj teraz trwałe pamięci.",
          wskazówka: "Zapisz wszelkie trwałe notatki do pamięci/RRRR-MM-DD. d; odpowiedz NO_REPLY, jeśli nic nie ma do przechowywania. ,
        },
      },
    },
  },
}
```

Blokuj streamowanie:

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (domyślnie wyłączone).

- Nadpisywanie kanałów: `*.blockStreaming` (i warianty dla każdego konta) wymusza włączanie/wyłączanie blokowania streamingu.
  Kanały inne niż Telegram wymagają wyraźnego `*.blockStreaming: true` aby włączyć odpowiedzi bloku.

- `agents.defaults.blockStreamingBreak`: `"text_end"` lub `"message_end"` (domyślnie: text_end).

- `agents.defaults.blockStreamingChunk`: miękki chunking dla bloków strumieniowych. Domyślnie
  800–1200 znaków, preferowane są przerwy w paragrafie (`\n\n`), potem nowe, potem zdania.
  Przykład:

  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```

- `agents.defaults.blockStreamingCoalesce`: scalanie strumieniowych bloków przed wysłaniem.
  Domyślnie `{ idleMs: 1000 }` i dziedziczy `minChars` z `blockStreamingChunk`
  z `maxChars` ograniczonym do limitu tekstu kanału. Sygnał/Slack/Discord/Google Chat domyślnie
  do `minChars: 1500`, chyba że nadpisano.
  Nadpisuje kanał: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,
  `channels.discord.blockStreamingCoalesce`, `kanałs.slack.blockStreamingCoalesce`, `channels.mattermost.blockStreamingCoalesce`,
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,
  `channels.googlechat.blockStreamingCoalesce`
  (i warianty na konto).

- `agents.defaults.humanDelay`: losowa pauza pomiędzy **odpowiedziami bloku** po pierwszej.
  Mody: `off` (domyślnie), `natural` (800–2500ms), `custom` (użyj `minMs`/`maxMs`).
  Nadpisywanie peragenta: `agents.list[].Ludzkie Opóźnienie`.
  Przykład:

  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } },
  }
  ```

  Zobacz [/concepts/streaming](/concepts/streaming) dla zachowania + szczegóły chunkingu.

Wskaźniki pisania:

- `agents.defaults.typingMode`: `"niver" | "instant" | "thinking" | "message"`. Domyślnie
  `instant` dla czatów bezpośrednich / wzmianek i `message` dla niewymienionych czatów grupowych.
- `session.typingMode`: nadpisanie trybu na sesję.
- `agents.defaults.typingIntervalSeconds`: jak często sygnał pisania jest odświeżany (domyślnie: 6s).
- `session.typingIntervalSeconds`: dla każdej sesji nadpisanie odstępu odświeżania.
  Zobacz [/concepts/typing-indicators](/concepts/typing-indicators), aby uzyskać szczegóły zachowań.

`agents.defaults.model.primary` powinien być ustawiony jako `provider/model` (np. `anthropic/claude-opus-4-6`).
Aliasy pochodzą z `agents.defaults.models.*.alias` (np. `Opus`).
Jeśli opuścisz dostawcę, OpenClaw przyjmuje obecnie `anthropic` jako tymczasową rezygnację z kategorii
.
Modele Z.AI są dostępne jako `zai/<model>` (np. `zai/glm-4.7`) i wymagają
`ZAI_API_KEY` (lub starsze `Z_AI_API_KEY`) w środowisku.

`agents.defaults.heartbeat` konfiguruje okresowe bicie serca:

- `every`: ciąg czasu trwania (`ms`, `s`, `m`, `h`); domyślne minuty jednostki. Domyślnie:
  `30m`. Ustaw `0m` aby wyłączyć.
- `model`: opcjonalne nadpisanie modelu dla akcji serca (`provider/model`).
- `includeReasoning`: kiedy `true`, uderzenia serca również dostarczą oddzielną wiadomość `Reasoning:` jeśli jest dostępna (taki sam kształt jak `/rozumowanie na `). Domyślnie: `false`.
- `sesja`: opcjonalny klucz sesji do kontrolowania, w której zaczyna się sesja bicia serca. Domyślnie: `main`.
- `do`: opcjonalne nadpisanie odbiorcy (identyfikator specyficzny dla kanału, np. E.164 dla WhatsApp, identyfikator czatu dla Telegram).
- `target`: opcjonalny kanał dostawy (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). Domyślnie: `last`.
- `prompt`: opcjonalnie nadpisz ciało bicia serca (domyślnie: `Read HEARTBEAT.md jeśli istnieje (kontekst obszaru roboczego). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Nadpisania są wysyłane w słowniku; jeśli nadal chcesz przeczytać plik wpisz wiersz "Przeczytaj HEARTBEAT.md".
- `ackMaxChars`: maksymalna ilość znaków dozwolonych po `HEARTBEAT_OK` przed dostawą (domyślnie: 300).

Heartbeat per‑agent:

- Ustaw `agents.list[].heartbeat` aby włączyć lub zastąpić ustawienia bicia serca dla konkretnego agenta.
- Jeśli jakakolwiek pozycja agenta definiuje `heartbeat`, **tylko te czynniki** uruchamiają bicie serca; domyślnie
  staje się wspólną linią podstawową dla tych czynników.

Heartbeat uruchamia pełne tury agenta. Krótsze odstępy spali więcej tokenów; bądź świadomy
`every`, zachowaj `HEARTBEAT.md` i (lub) wybierz tańszy `model`.

`tools.exec` konfiguruje opóźnienie w tle:

- `tłoMs`: czas przed auto-tłem (ms, domyślnie 10000)
- `timeoutSec`: automatyczne zabijanie po tym czasie (sekundy, domyślnie 1800)
- `cleanupMs`: jak długo zachować ukończone sesje w pamięci (ms, domyślnie 1800000)
- `notifyOnExit`: dodaj do kolejki zdarzenie systemowe + poproś o bicie serca po wyjściu z tła (domyślnie prawda)
- `applyPatch.enabled`: włącz eksperymentalne `apply_patch` (OpenAI/OpenAI Codex tylko domyślnie; false)
- `applyPatch.allowModels`: opcjonalna dopuszczalna lista identyfikatorów modelu (np. `gpt-5.2` lub `openai/gpt-5.2`)
  Uwaga: `applyPatch` jest tylko pod `tools.exec`.

`tools.web` konfiguruje wyszukiwanie internetowe + narzędzia pobierania:

- `tools.web.search.enabled` (domyślnie: true gdy klawisz jest obecny)
- `tools.web.search.apiKey` (zalecane: ustaw za pomocą `openclaw configure --section web`, lub użyj `BRAVE_API_KEY` env var)
- `tools.web.search.maxResults` (1–10, domyślnie 5)
- `tools.web.search.timeoutSeconds` (domyślnie 30)
- `tools.web.search.cacheTtlMinutes` (domyślnie 15)
- `tools.web.fetch.enabled` (domyślnie prawda)
- `tools.web.fetch.maxChars` (domyślnie 50000)
- `tools.web.fetch.maxCharsCap` (domyślnie 50000; clamps maxChars from config/toolcalls)
- `tools.web.fetch.timeoutSeconds` (domyślnie 30)
- `tools.web.fetch.cacheTtlMinutes` (domyślnie 15)
- `tools.web.fetch.userAgent` (opcjonalne nadpisanie)
- `tools.web.fetch.readability` (domyślnie true; wyłącz tylko do czyszczenia HTML)
- `tools.web.fetch.firecrawl.enabled` (domyślnie prawda, gdy klucz API jest ustawiony)
- `tools.web.fetch.firecrawl.apiKey` (opcjonalne; domyślnie `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (domyślnie [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (domyślnie prawda)
- `tools.web.fetch.firecrawl.maxAgeMs` (opcjonalne)
- `tools.web.fetch.firecrawl.timeoutSeconds` (opcjonalne)

`tools.media` konfiguruje zrozumienie przychodzących mediów (obraz/audio/video):

- `tools.media.models`: lista modeli współdzielonych (cap-lists).
- `tools.media.concurrency`: max jednoczesne uruchamianie zdolności (domyślnie 2).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - `enabled`: opt-out przełącznik (domyślnie true gdy modele są skonfigurowane).
  - `prompt`: opcjonalne nadpisanie polecenia (image/video dołącz hint `maxChars` automatycznie).
  - `maxChars`: maksymalna ilość znaków wyjściowych (domyślnie 500 dla zdjęcia/wideo; nieustawione dla audio).
  - `maxBytes`: maksymalny rozmiar multimediów do wysłania (domyślnie: obraz 10MB, dźwięk 20MB, wideo 50MB).
  - `timeoutSeconds`: limit czasu żądania (domyślnie: obrazek 60, dźwięk 60, film 120).
  - `język`: opcjonalna podpowiedź dźwiękowa.
  - `załączniki`: zasady załączników (`mode`, `maxAttachments`, `preferowane `).
  - `zakresu`: opcjonalna bramka (pierwsza wygrana meczu) z `match.channel`, `match.chatType`, lub `match.keyPrefix`.
  - `models`: uporządkowana lista wpisów modelu; błędy lub nadwymiary mediów wracają do następnego wpisu.
- Każdy wpis `models[]`:
  - Wpis dostawcy (`type: "provider"` lub pominięty):
    - `provider`: identyfikator dostawcy API (`openai`, `anthropic`, `google`/`gemini`, `groq`, itp.).
    - `model`: nadpisanie identyfikatora modelu (wymagane dla obrazu; domyślnie `gpt-4o-mini-transcribe`/`whisper-big v3-turbo` dla dostawców audio i `gemini-3-flash-preview` dla wideo).
    - `profile` / `preferowane profile`: wybór profilu autoryzacji.
  - Wpis CLI (`type: "cli"`):
    - `komenda`: wykonywalny do uruchomienia.
    - `args`: templated args (obsługuje `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).
  - `zdolności`: opcjonalna lista (`image`, `audio`, `video`) do bramki wspólnego wpisu. Domyślnie, gdy pominięto: `openai`/`anthropic`/`minimax` → obraz, `google` → obraz+audio+video, `groq` → audio.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language` może zostać zastąpiony na wpis.

Jeśli żadne modele nie są skonfigurowane (lub `enabled: false`), zrozumienie jest pominięte; model nadal otrzymuje oryginalne załączniki.

Autoryzacja dostawcy postępuje zgodnie ze standardowym modelem uwierzytelniania (profile autoryzacji, var jak `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, lub `models.providers.*.apiKey`).

Przykład:

```json5
{
  tools: {
    media: {
      audio: {
        włączone: true,
        maxBajty: 20971520, Zakres
        : {
          domyślnie: "deny", Reguły
          : [{ action: "allow", dopasowanie: { chatType: "direct" } }],
        },
        modele: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      }, Film
      : {
        włączony: true,
        maxBytes: 52428800,
        modely: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` konfiguruje domyślne subagenta:

- `model`: domyślny model dla spawanych podagentów (ciąg znaków lub `{ primary, fallbacks }`). W przypadku pominięcia subagenci dziedziczą model dzwoniącego, chyba że zostanie on zastąpiony przez jednego przedstawiciela lub jednego połączenia.
- `maxConcurrent`: max jednoczesny subagent (domyślnie 1)
- `archiveAfterMinutes`: automatyczne archiwizowanie sesji subagenta po N minutach (domyślnie 60; ustaw `0` na wyłączony)
- Polityka narzędzi dla subagenta: `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (odmawiaj zwycięstw)

`tools.profile` ustawia **bazową listę dozwolonych narzędzi** przed `tools.allow`/`tools.deny`:

- `minimal`: tylko `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: brak ograniczeń (tak samo jak brak ustawienia)

Nadpisanie per-agent: `agents.list[].tools.profile`.

Przykład (domyślnie tylko wiadomości, dodatkowo zezwól na narzędzia Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Przykład (profil programistyczny, ale zabroń exec/process wszędzie):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

`tools.byProvider` pozwala **na dalsze ograniczenie** narzędzi dla określonych dostawców (lub jednego `dostawcy/modelu`).
Nadpisanie per-agent: `agents.list[].tools.byProvider`.

Zamówienie: profil bazowy → profil dostawcy → zezwalaj/odrzuć zasady.
Klucze dostawcy akceptują `provider` (np. `google-antigravity`) lub `provider/model`
(np. `openai/gpt-5.2`).

Przykład (zachowaj globalny profil programistyczny, ale minimalne narzędzia dla Google Antigravity):

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

Przykład (lista uprawnień dla dostawcy/modelu):

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

`tools.allow` / `tools.deny` skonfiguruje globalne narzędzie dozwolone/odmów (odrzuć wygrane).
Dopasowanie jest niewrażliwe na wielkość liter i obsługuje wieloznaczne karty `*` (`"*"` oznacza wszystkie narzędzia).
Jest to stosowane nawet wtedy, gdy piasek dokujący jest **wyłączony**.

Przykład (wyłącz przeglądarkę/płótno wszędzie):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

Grupy narzędzi (skróty) działają w strategiach narzędzi **globalnych** i **na agenta**:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: wszystkie wbudowane narzędzia OpenClaw (z wyłączeniem wtyczek dostawców)

`tools.elevated` kontroluje podwyższony (host) dostęp do wykonawcy:

- `enabled`: włącz tryb podwyższony (domyślnie prawda)
- `allowFod`: dozwolone listy na kanał (puste = wyłączone)
  - `whatsapp`: Numery E.164
  - `telegram`: identyfikatory czatu lub nazwy użytkowników
  - `discord`: identyfikatory użytkownika lub nazwy użytkowników (powróci do `channels.discord.dm.allowFrom`, jeśli zostaniesz pominięty)
  - `sygnał`: liczby E.164
  - `imessage`: handles/chat id
  - `webchat`: identyfikatory sesji lub nazwy użytkowników

Przykład:

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

Nadpisanie perczynnika (dalsze ograniczenie):

```json5
{
  agents: {
    list: [
      {
        id: "family", Narzędzia
        : {
          podwyższone: { enabled: false },
        },
      },
    ],
  },
}
```

Uwagi:

- `tools.elevated` jest globalną linią bazową. `agents.list[].tools.elevated` może ograniczać tylko dalsze ograniczenia (oba muszą pozwalać).
- `/elevated on|off|ask|full` przechowuje stan na klucz sesji; wbudowane dyrektywy dotyczą pojedynczej wiadomości.
- Podwyższony `exec` działa na hosta i omija piaskownicę.
- Wciąż ma zastosowanie polityka narzędzi; jeśli `exec` nie jest używany, nie można użyć podwyższonego limitu.

`agents.defaults.maxConcurrent` ustawia maksymalną liczbę osadzonych uruchomień agenta, które mogą
wykonywać równolegle między sesjami. Każda sesja jest nadal serializowana (jedno wykonanie
na klucz sesji naraz). Domyślnie: 1.

### `agents.defaults.sandbox`

Opcjonalnie **Piaskownica dokująca** dla wbudowanego agenta. Przeznaczone na inne niż główne sesje
więc nie mogą uzyskać dostępu do Twojego systemu hosta.

Szczegóły: [Sandboxing](/gateway/sandboxing)

Domyślne (jeśli włączone):

- zakres: `"agent"` (jeden pojemnik + obszar roboczy na agenta)
- Obraz z książki debiańskiej
- Dostęp do obszaru roboczego agenta: `workspaceAccess: "none"` (domyślnie)
  - `"none"`: użyj obszaru roboczego dla każdego zakresu pod `~/.openclaw/sandboxes`
- `"ro"`: zachowaj obszar roboczy sandbox w `/workspace`, i zamontuj tylko do odczytu konsultanta w `/agent` (wyłącza `write`/`edit`/`apply_patch`)
  - `"rw"`: mount the agent workspace read/write at `/workspace`
- auto-pruning: bezczynność > 24 h LUB wiek > 7 dni
- polityka narzędzi: zezwól tylko na `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (odmawiaj zwycięstw)
  - skonfiguruj za pomocą `tools.sandbox.tools`, nadpisz każdego agenta poprzez `agents.list[].tools.sandbox.tools`
  - skróty grupy narzędzi obsługiwane w polityce sandbox: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (patrz [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- opcjonalna przeglądarka piaskowana (Chromium + CDP, obserwator noVNC)
- utwardzające noby: `sieci`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

Ostrzeżenie: `zakres: "shared"` oznacza wspólny kontener i wspólny obszar roboczy. Brak
izolacji międzysesyjnej. Użyj `zakresu: "sesja"` dla izolacji na sesję.

Legacy: `perSession` jest nadal obsługiwany (`true` → `zakres: "session"`,
`false` → `zakres: "shared"`).

`setupCommand` działa **raz** po utworzeniu kontenera (wewnątrz kontenera poprzez `sh -lc`).
W przypadku instalacji pakietów należy zapewnić odejście od sieci, zapisywalny root FS i użytkownika roota.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        zakres: "agent", // sesja | agent | współdzielony (agent jest domyślny)
        obszar roboczyDostęp: "brak", // no | ro | rw
        obszar roboczy: "~/. penclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          Workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          użytkownik: "1000:1000",
          capDrop: ["WSZYSTKIE"],
          env: { LANG: "C. TF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Nadpisanie per-agenta (multiagent): agenty. ist[].sandbox.docker.
          pidsLimit: 256, pamięć
          : "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 }
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp. son",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1. .1.1”, „8.8.8. "],
          extraHosts: ["internal.service:10.0.0. "],
          binds: ["/var/run/docker.sock:/var/run/docker. ock", "/home/user/source:/source:rw"],
        },
        przeglądarka: {
          włączone: false,
          obrazek: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          bezgłowy: fałszywe,
          enableNoVnc: true,
          allowHostControl: fałsz,
          allowedControlUrls: ["http://10. .0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0. 2"],
          allowedControlPorts: [18791],
          AutoStart: prawda,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          bezgodziny: 24, // 0 wyłącza bezczynności pruning
          maxAgeDays: 7, // 0 wyłącza pruning
        },
      },
    },
  },
  narzędzi: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          „process”,
          „read”,
          "write",
          "edytuj",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status", Odmowa
        ],
        : ["przeglądarka", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Zbuduj domyślny obraz sandbox raz z:

```bash
scripts/sandbox-setup.sh
```

Uwaga: kontenery sandbox domyślne dla `sieć: "none"`; ustaw `agents.defaults.sandbox.docker.network`
na `"bridge"` (lub twoja sieć niestandardowa), jeśli agent potrzebuje dostępu wychodzącego.

Uwaga: przychodzące załączniki są rozłożone w aktywny obszar roboczy w `media/inbound/*`. Z `workspaceAccess: "rw"`, oznacza to, że pliki są zapisywane w obszarze roboczym agenta

Uwaga: `docker.binds` montuje dodatkowe katalogi hostów; globalne i dla każdego agenta są scalone.

Zbuduj opcjonalny obraz przeglądarki z:

```bash
scripts/sandbox-browser-setup.sh
```

Gdy `agents.defaults.sandbox.browser.enabled=true`, narzędzie przeglądarki używa sandboxed
Chromium instancja (CDP). Jeśli noVNC jest włączona (domyślnie gdy headless=false),
adres URL noVNC jest wstrzykiwany w monit systemowy, aby agent mógł się do niego odwołać.
To nie wymaga `browser.enabled` w głównej konfiguracji; sterownik sandbox
URL jest wstrzykiwany na sesję.

`agents.defaults.sandbox.browser.allowHostControl` (domyślnie: false) pozwala
sesjom piaskowanym wyraźnie skierować serwer kontroli przeglądarki **host**
za pomocą narzędzia przeglądarki (`target: "host"`). Pozostaw to wyłączone, jeśli chcesz izolować piaskownicę
.

Listy dozwolone do zdalnego sterowania:

- `allowedControlUrls`: dokładna kontrola adresów URL dozwolonych dla `target: "custom"`.
- `allowedControlHosts`: nazwy hostów dozwolone (tylko nazwa hosta, bez portu).
- `allowedControlPorts`: porty dozwolone (domyślnie: http=80, https=443).
  Domyślnie: wszystkie listy uprawnień są nieustawione (bez ograniczeń). `allowHostControl` domyślnie fałsz.

### `models` (dostawcy niestandardowi + bazowe adresy URL)

OpenClaw używa katalogu modeli **pi-coding-agent**. Możesz dodać dostawców niestandardowych
(LiteLLM, lokalne serwery kompatybilne z OpenAI, proxy Antropic itp.) pisząc
`~/.openclaw/agents/<agentId>/agent/models.json` lub definiując ten sam schemat wewnątrz twojego
OpenClaw config pod `models.providers`.
Dostawca po dostawcach + przykłady: [/concepts/model-providers](/concepts/model-providers).

Gdy jest obecny `models.providers` OpenClaw pisze/merges a `models.json` do
`~/.openclaw/agents/<agentId>/agent/` przy starcie:

- domyślne zachowanie: **scalanie** (zachowuje istniejących dostawców, nadpisuje na nazwie)
- ustaw `models.mode: "replace"` aby nadpisać zawartość pliku

Wybierz model za pomocą `agents.defaults.model.primary` (provider/model).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3. -8b" },
      models: {
        "custom-proxy/llama-3. -8b": {},
      },
    },
  }, modele
  : tryb {
    : "scalanie",
    dostawców: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        modelów: [
          {
            id: "llama-3. -8b",
            nazwa: "Llama 3. Uzasadnienie 8B",
            : fałsz, Wpis
            : ["text"], Koszt
            : { input: 0, wynik: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

### OpenCode Zen (wielomodelowy proxy)

OpenCode Zen jest wielomodelową bramą z poszczególnymi modelowymi punktami końcowymi. OpenClaw używa
wbudowanego dostawcy `opencode` z pi-ai; ustaw `OPENCODE_API_KEY` (lub
`OPENCODE_ZEN_API_KEY`) od [https://opencode.ai/auth](https://opencode.ai/auth).

Uwagi:

- Model odmowa użycia `opencode/<modelId>` (przykład: `opencode/claude-opus-4-6`).
- Jeśli włączysz listę dozwoloną przez `agents.defaults.models`, dodaj każdy model, którego planujesz użyć.
- Skrót: `openclaw onboard --auth-choice opencode-zen`.

```json5
{
  agents: {
    domyślnie: {
      model: { primary: "opencode/claude-opus-4-6" },
      modely: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

### Z.AI (GLM-4.7) — wsparcie aliasu dostawcy

Modele Z.AI są dostępne za pośrednictwem wbudowanego dostawcy `zai`. Ustaw `ZAI_API_KEY`
w swoim środowisku i odwołaj się do modelu według dostawcy/modelu.

Skrót: `openclaw onboard --auth-choice zai-api-key`.

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

Uwagi:

- `z.ai/*` i `z-ai/*` są akceptowane aliasy i znormalizuj do `zai/*`.
- Jeśli brakuje pliku `ZAI_API_KEY`, zapytania do pliku `zai/*` nie powiodą się z błędem uwierzytelniania w czasie uruchomienia.
- Przykładowy błąd: `Nie znaleziono klucza API dla dostawcy "zai".`
- Ogólnym punktem końcowym API Z.AI jest `https://api.z.ai/api/paas/v4`. Żądania kodowania GLM
  używają dedykowanego punktu końcowego kodowania `https://api.z.ai/api/coding/paas/v4`.
  Wbudowany dostawca `zai` używa punktu końcowego kodowania. Jeśli potrzebujesz ogólnego punktu końcowego
  , zdefiniuj dostawcę niestandardowego w `models.providers` z nadpisaniem podstawowego adresu URL
  (patrz powyżej sekcja niestandardowych dostawców).
- Użyj fałszywego symbolu zastępczego w docs/configs; nigdy nie zatwierdzaj prawdziwych kluczy API.

### Moonshot AI (Kimi)

Użyj punktu końcowego kompatybilnego z OpenAI Moonshot:

```json5
{
  pl: { MOONSHOT_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2. " },
      models: { "moonshot/kimi-k2. ": { alias: "Kimi K2. " } },
    },
  },
  models: {
    mode: "merge",
    dostawców: {
      moonshot: {
        baseUrl: "https://api. zrzut ziemi. i/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        modelów: [
          {
            id: "kimi-k2. ",
            nazwa: "Kimi K2. ",
            rozumowanie fałszywe, Wpis
            : ["text"], Koszt
            : { input: 0, wynik: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Uwagi:

- Ustaw `MOONSHOT_API_KEY` w środowisku lub użyj `openclaw onboard --auth-choice moonshot-api-key`.
- Wzór ref: `moonshot/kimi-k2.5`.
- W odniesieniu do punktu końcowego Chin:
  - Uruchom `openclaw onboard --auth-choice moonshot-api-key-cn` (kreator ustali `https://api.moonshot.cn/v1`), lub
  - Ręcznie ustaw `baseUrl: "https://api.moonshot.cn/v1"` w `models.providers.moonshot`.

### Kimi Coding

Użyj punktu końcowego Kodowania Moonshot AI Kimi (kompatybilnego z antropiną, wbudowanego dostawcy):

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

Uwagi:

- Ustaw `KIMI_API_KEY` w środowisku lub użyj `openclaw onboard --auth-choice kimi-code-api-key`.
- Wzór ref: `kimi-coding/k2p5`.

### Syntetyczne (kompatybilne z antytropinami)

Użyj punktu końcowego kompatybilnego z Antropią Synthetic:

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

Uwagi:

- Ustaw `SYNTHETIC_API_KEY` lub użyj `openclaw onboard --auth-choice synthetic-api-key`.
- Wzór ref: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`.
- Bazowy adres URL powinien pominąć `/v1`, ponieważ Klient Antropiczny go przyłącza .

### Modele lokalne (LM Studio) – zalecane ustawienia

Zobacz [/gateway/local-models](/gatewaway/local-models), aby uzyskać aktualne lokalne wytyczne. TL;DR: uruchom MiniMax M2.1 poprzez LM Studio Responses API na poważnym urządzeniu; utrzymuj modele hostowane w celu opadania.

### MiniMax M2.1

Użyj MiniMax M2.1 bezpośrednio bez LM Studio:

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2. " },
    modely: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2. ": { alias: "Minimax" },
    },
  }, modele
  : tryb {
    : "scalanie",
    dostawcy: {
      minimax: {
        baseUrl: "https://api. inimax. o/antropikalne”,
        apiKey: "${MINIMAX_API_KEY}",
        api: „antropikalne”,
        modelów: [
          {
            id: "MiniMax-M2. ",
            nazwa: "MiniMax M2. ",
            rozumowanie fałszywe, Wpis
            : ["text"],
            // Cena: aktualizacja modeli. syn jeśli potrzebujesz dokładnego śledzenia kosztów.
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

Uwagi:

- Ustaw zmienną środowiskową `MINIMAX_API_KEY` lub użyj `openclaw onboard --auth-choice minimax-api`.
- Dostępny model: `MiniMax-M2.1` (domyślnie).
- Zaktualizuj ceny w `models.json` jeśli potrzebujesz dokładnego śledzenia kosztów.

### Cerebras (GLM 4, 6 / 4, 7)

Użyj Cerebras przez punkt końcowy kompatybilny z OpenAI:

```json5
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

Uwagi:

- Użyj `cerebras/zai-glm-4.7` dla Cerebras; użyj `zai/glm-4.7` dla Z.AI bezpośrednio.
- Ustaw `CEREBRAS_API_KEY` w środowisku lub konfiguracji.

Uwagi:

- Obsługiwane APIs: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`
- Użyj `authHeader: true` + `headers` dla niestandardowych potrzeb uwierzytelniania.
- Zastąp root konfiguracji agenta `OPENCLAW_AGENT_DIR` (lub `PI_CODING_AGENT_DIR`)
  jeśli chcesz przechowywać `models.json` gdzie indziej (domyślnie: `~/.openclaw/agents/main/agent`).

### `sesja`

Kontroluje punktację sesji, resetowanie reguły, wyzwalacze resetowania i miejsce zapisu sklepu sesji.

```json5
{
  sesja: {
    zakres: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily", Godzina
      : 4,
      bezczynność: 60,
    },
    resetByType: {
      wątek: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 }, Grupa
      : { mode: "idle", idleMinutes: 120 },
    },
    Wyzwalacze resetowania: ["/new", "/reset"],
    // Domyślnie jest już na agenta pod ~/. penclaw/agents/<agentId>/sessions/sessions.json
    // Możesz zastąpić szablon {agentId}
    sklep "~/. penclaw/agents/{agentId}/sessions/sessions.json",
    // czaty bezpośrednie zwijają się do agenta:<agentId>:<mainKey> (domyślnie: "main").
    główny klawisz: "main",
    agentToAgent: {
      // Max ping-pong reply turns between requester/target (0–5).
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      reguły: [{ action: "deny", dopasowanie: { channel: "discord", chatType: "group" } }],
      domyślnie: "allow",
    },
  },
}
```

Pola:

- `mainKey`: bezpośredni chat bucket (domyślnie: `"main"`). Przydatne, gdy chcesz "zmienić nazwę" głównego wątku pamięci DM bez zmiany `agentId`.
  - Notatka Sandbox: `agents.defaults.sandbox.mode: "non-main"` używa tego klucza do wykrycia sesji głównej. Każdy klucz sesji, który nie pasuje do `mainKey` (grupy/kanały) jest piaskowany.
- `dmScope`: jak sesje pamięci DM są grupowane (domyślnie: `"main"`).
  - `main`: wszystkie DM udostępniają sesję główną dla ciągłości.
  - `per-peer`: izoluj DM przez identyfikator nadawcy.
  - `per-channel-peer`: izoluj DM na kanał + nadawca (zalecane dla wielu użytkowników skrzynki odbiorczej).
  - `per-account-channel-peer`: izoluj DM na konto + kanał + nadawca (zalecane dla wielu kont pocztowych).
  - Tryb bezpieczny DM (zalecany): ustaw `session.dmScope: "per-channel-peer"` gdy wiele osób może DM bota (współdzielone skrzynki odbiorcze, wiele osób na liście lub `dmPolicy: "open"`).
- `identityLinks`: mapuj kanoniczne identyfikatory dla wcześniej ustalonych peerów dostawcy, tak aby ta sama osoba dzieliła sesję pamięci DM pomiędzy kanałami podczas używania `per-peer`, `per-channel-peer`, lub `per-account-channel-peer`.
  - Przykład: `alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `resetuj`: pierwotna reguła resetowania. Domyślnie resetuje się codziennie o godzinie 4:00 czasu lokalnego na organizmie bramy.
  - `mode`: `daily` lub `idle` (domyślnie: `daily` gdy `reset` jest obecny).
  - `atHour`: lokalna godzina (0-23) dla dziennej granicy resetowania.
  - `idleMinutes`: przesuwanie bezczynnego okna w kilka minut. Gdy skonfigurowane są oba (dzienny + bezczynność), wygrywa to, które wygaśnie pierwsze.
- `resetByType`: nadpisywanie sesji dla `dm`, `group`, i `wątk`.
  - Jeśli ustawisz tylko starszy `session.idleMinutes` bez żadnego `reset`/`resetByType`, OpenClaw pozostaje w trybie bezczynności dla kompatybilności wstecz.
- `heartbeatIdleMinutes`: opcjonalna bezczynność dla kontroli bicia serca (codzienne resetowanie nadal obowiązuje, gdy włączone).
- `agentToAgent.maxPingPongTurns`: maksymalna odpowiedź zwrotna między żądającym/docelowym (0–5, domyślnie 5).
- `sendPolicy.default`: `allow` lub `deny` przy braku pasujących reguł.
- `sendPolicy.rules[]`: pasuje do `kanał`, `chatType` (`direct|group|room`) lub `keyPrefix` (np. `cron:`). Po raz pierwszy odmawiaj zwycięstw; w przeciwnym razie zezwól na nie.

### `umiejętności` (konfiguracja umiejętności)

Kontroluje dołączoną listę dozwolonych, zainstaluj preferencje, dodatkowe foldery umiejętności i nadpisywanie umiejętności
. Dotyczy **pakietowych** umiejętności i `~/.openclaw/skills` (umiejętności w obszarze roboczym
nadal wygrywa konflikty nazw).

Pola:

- `allowBundled`: opcjonalna lista dozwolonych wyłącznie dla **dołączonych** skills. Jeśli ustawione, kwalifikują się tylko te
  umiejętności powiązane (bez wpływu na umiejętności zarządzane/w obszarze pracy).
- `load.extraDirs`: dodatkowe katalogi Skills do skanowania (najniższy priorytet).
- `install.preferBrew`: preferuj instalatory brew, gdy są dostępne (domyślnie: true).
- `install.nodeManager`: preferencje instalatora węzłów (`npm` | `pnpm` | `yarn`, domyślne: npm).
- `entries.<skillKey>`: nadpisanie konfiguracji dla umiejętności.

Pola per-skill:

- `enabled`: ustaw `false`, aby wyłączyć skill, nawet jeśli jest dołączony/zainstalowany.
- `env`: zmienne środowiskowe wstrzykiwane do uruchomienia agenta (tylko jeśli nie są już ustawione).
- `apiKey`: opcjonalna wygoda dla umiejętności, które zadeklarowały podstawowy var env (np. `nano-bana-pro` → `GEMINI_API_KEY`).

Przykład:

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

### `plugins` (rozszerzenia)

Kontroluje wykrycie wtyczki, zezwól / odmów oraz konfigurację każdej wtyczki. Plugins are loaded
from `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, plus any
`plugins.load.paths` entries. **Zmiany konfiguracji wymagają ponownego uruchomienia bramy.**
Zobacz [/plugin](/tools/plugin), aby uzyskać pełne użycie.

Pola:

- `enabled`: główny przełącznik ładowania wtyczki (domyślnie: true).
- `zezwalaj`: opcjonalnie dopuszczalna lista identyfikatorów pluginów; gdy jest ustawiona, tylko wymienione wtyki.
- `deny`: opcjonalna odmowa identyfikatorów pluginów (odmowa wygranych).
- `load.paths`: dodatkowe pliki lub katalogi pluginów do załadowania (bezwzględne lub `~`).
- `wpisy.<pluginId>`: nadpisywanie wtyczki.
  - `enabled`: ustaw `false` aby wyłączyć.
  - `config`: obiekt konfiguracyjny specyficzny dla wtyczki (zatwierdzony przez wtyczkę, jeśli jest dostępny).

Przykład:

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    load: {
      ścieżki: ["~/Projects/oss/voice-call-extension"],
    },
    wpisy: {
      "voice-call": {
        włączone: true,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser` (przeglądarka zarządzana przez openclaw)

OpenClaw może rozpocząć **oddzieloną, izolowaną** instancję Chrome/Brave/Edge/Chromium dla openclaw i wystawić na działanie małej usługi kontroli pętli.
Profile mogą wskazywać na **zdalną** przeglądarkę opartą na Chromium poprzez `profile.<name>.cdpUrl`. Zdalne profile
są tylko dołączone (start/stop/reset są wyłączone).

`browser.cdpUrl` pozostaje dla starych konfiguracji pojedynczego profilu i jako podstawowy schemat
dla profili, które ustawiają tylko `cdpPort`.

Domyślne:

- włączone: `true`
- ocena włączona: `true` (ustaw `false` aby wyłączyć `act:evaluate` i `wait --fn`)
- usługa kontroli: tylko pętla (port wynikowy z `gateway.port`, domyślny `18791`)
- Adres URL CDP: `http://127.0.0.1:18792` (kontrola + 1, starszy jeden profil)
- kolor profilu: `#FF4500` (lobster-pomarańczy)
- Uwaga: serwer kontrolny jest uruchamiany przez uruchomioną bramę (OpenClaw.app menu lub `openclaw gateway`).
- Automatycznie wykrywaj kolejność: domyślna przeglądarka jeśli jest oparta na chromie; w przeciwnym razie Chrome → Brave → Edge → Chromium → Chrome Canary.

```json5
{
  przeglądarka: {
    włączone: true,
    evaluateEnabled: true,
    // cdpUrl: "http://127. .0. :18792", // starszy jednoprofil nadpisuje
    domyślny profil: "chrome", Profile
    : {
      openclaw: { cdpPort: 18800, kolor: "#FF4500" },
      praca: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10. .0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // Zaawansowane:
    // bezgłowy: fałszywe,
    // noSandbox: false,
    // wykonywalna Ścieżka: "/Applications/Brave Browser. pp/Contents/MacOS/Brave Browser",
    // attachtyly: false, // ustaw true podczas tunelowania zdalnego CDP na localhost
  },
}
```

### `ui` (wygląd)

Opcjonalny kolor akcentu używany przez natywne aplikacje dla chromu interfejsu użytkownika (np. znacznik bańki w trybie mówienia).

Jeśli wyłączone, klienci wrócą do wyciszonego jasnoniebieskiego.

```json5
{
  ui: {
    seamColor: "#FF4500", // hex (RRGGBB lub #RRGGBB)
    // Opcjonalnie: Nadpisanie tożsamości asystenta interfejsu użytkownika.
    // Jeśli nie ustawione, interfejs zarządzania używa aktywnej tożsamości konsultanta (config lub IDENTITY. d).
    asystent: {
      nazwa: "OpenClaw",
      awatar: "CB", // emoji, krótki tekst, lub adres URL obrazu / danych URI
    },
  },
}
```

### `gateway` (Gateway server mode + bind)

Użyj `gateway.mode` do wyraźnego stwierdzenia, czy ta maszyna powinna uruchomić bramę.

Domyślne:

- tryb: **unset** (traktowane jako "nie uruchamiaj automatycznie")
- bind: `loopback`
- port: `18789` (pojedynczy port dla WS + HTTP)

```json5
{
  gateway: {
    mode: "local", // or "remote"
    port: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // controlUi: { enabled: true, ścieżka: "/openclaw" }
    // auth: { mode: "token", token: "your-token" } // token Bates WS + Control UI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  },
}
```

Kontroluj ścieżkę bazową UI:

- `gateway.controlUi.basePath` ustawia prefiks URL gdzie jest obsługiwany interfejs sterowania.
- Przykłady: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- Domyślnie: root (`/`) (bez zmian).
- `gateway.controlUi.root` ustawia root systemu plików dla zasobów interfejsu użytkownika (domyślnie: `dist/control-ui`).
- `gateway.controlUi.allowInsecureAuth` pozwala na autoryzację tylko tokenem dla interfejsu sterowania, gdy tożsamość urządzenia
  jest pomijana (zazwyczaj przez HTTP). Domyślnie: `false`. Preferuj HTTPS
  (Tailscale Serve) lub `127.0.0.1`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` wyłącza sprawdzanie tożsamości urządzenia dla
  Control UI (tylko token/hasło). Domyślnie: `false`. Wyłącznie szkło pękające.

Powiązana dokumentacja:

- [Interfejs sterowania](/web/control-ui)
- [Przegląd stron internetowych](/web)
- [Tailscale](/gateway/tailscale)
- [Zdalny dostęp](/gateway/remote)

Zaufane proxy:

- `gateway.trustedProxies`: lista odwróconych adresów IP proxy, które kończą TLS przed bramą.
- Gdy połączenie pochodzi z jednego z tych adresów IP, OpenClaw używa `x-forwarded-for` (lub `x-real-ip`) do określenia adresu IP klienta dla lokalnych kontroli parowania i HTTP auth/local checks.
- Tylko lista proxy które kontrolujesz w pełni i upewnij się, że **nadpisuje** przychodzące `x-forwarded-for`.

Uwagi:

- `openclaw gateway` odmówi rozpoczęcia, chyba że `gateway.mode` jest ustawiony na `local` (lub przemieścisz flagę nadpisu).
- `gateway.port` kontroluje pojedynczy wielopleksowy port używany dla WebSocket + HTTP (kontrola UI, hooks, A2UI).
- Punkt końcowy Kompletności OpenAI: **wyłączony domyślnie**; włącz `gateway.http.endpoints.chatCompletions.enabled: true`.
- Poprzednia: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > domyślny `18789`.
- Autoryzacja bramki jest domyślnie wymagana (token/password lub Tailscale Serve identity). Niepętla binds wymaga współdzielonego tokenu/hasła.
- Kreator wdrożenia generuje domyślny token bramy (nawet przy pętl).
- `gateway.remote.token` jest **tylko** dla zdalnych połączeń CLI; nie włącza lokalnego uwierzytelniania bramy. `gateway.token` jest ignorowany.

Auth i skala Ogonowa:

- `gateway.auth.mode` ustawia wymagania handshake (`token` lub `password`). Gdy wyłączone, zostanie założona autoryzacja tokena.
- `gateway.auth.token` przechowuje wspólny token dla uwierzytelniania tokenu (używany przez CLI na tym samym urządzeniu).
- Gdy `gateway.auth.mode` jest ustawiony, tylko ta metoda jest akceptowana (plus opcjonalne nagłówki skali ogonowej).
- `gateway.auth.password` można ustawić tutaj lub za pomocą `OPENCLAW_GATEWAY_PASSWORD` (zalecane).
- `gateway.auth.allowTailscale` pozwala nagłówkom identyfikacyjnym Skala Ogonowa
  (`tailscale-user-login`) na spełnienie wymogu, gdy żądanie dotrze do pętli
  z `x-forwarded-for`, `x-forwarded-proto`, i `x-forwarded-host`. OpenClaw
  weryfikuje tożsamość, rozwiązując adres `x-forwarded-for` przez
  `tailscale whois` przed zaakceptowaniem go. Gdy `true`, Serve requesty nie potrzebują
  tokenu/hasła; ustaw `false` aby wymagać wyraźnych poświadczeń. Domyślnie dla
  `true` gdy `tailscale.mode = "serve"` i tryb autoryzacji nie jest `hasłem`.
- `gateway.tailscale.mode: "serve"` używa Służy Ogonowej (tylko ogon, loopback bind).
- `gateway.tailscale.mode: "funnel"` ujawnia kokpit menedżerski; wymaga autoryzacji.
- `gateway.tailscale.resetOnExit` resetuje konfigurację Serve/Lenel przy wyłączeniu.

Zdalne domyślne ustawienia klienta (CLI):

- `gateway.remote.url` ustawia domyślny adres URL bramki WebSocket dla połączeń CLI, gdy `gateway.mode = "remote"`.
- `gateway.remote.transport` wybiera zdalne transport macOS (domyślnie `ssh`, `direct` dla ws/wss). Gdy `direct`, `gateway.remote.url` musi być `ws://` lub `wss://`. `ws://host` domyślnie dla portu `18789`.
- `gateway.remote.token` dostarcza token dla połączeń zdalnych (pozostaw nieustawione dla braku autora).
- `gateway.remote.password` zawiera hasło dla połączeń zdalnych (pozostaw nieustawione dla braku autora).

Zachowanie aplikacji macOS:

- OpenClaw.app ogląda `~/.openclaw/openclaw.json` i przełącza tryby na żywo po zmianie `gateway.mode` lub `gateway.remote.url`.
- Jeśli plik `gateway.mode` jest nieustawiony, ale plik `gateway.remote.url` jest ustawiony, aplikacja macOS traktuje go jako tryb zdalny.
- Po zmianie trybu połączenia w aplikacji macOS, zapisuje on `gateway.mode` (i `gateway.remote.url` + `gateway.remote.transport` w trybie zdalnym) z powrotem do pliku konfiguracyjnego.

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

Przykład transportu bezpośredniego (aplikacja macOS):

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

### `gateway.reload` (konfig hot reload)

Brama ogląda `~/.openclaw/openclaw.json` (lub `OPENCLAW_CONFIG_PATH`) i wprowadza zmiany automatycznie.

Tryby:

- `hybrid` (domyślnie): Zastosuj bezpieczne zmiany; zrestartuj bramę dla krytycznych zmian.
- `hot`: zastosuj tylko zmiany na gorąco; zaloguj się po ponownym uruchomieniu.
- `restart`: zrestartuj bramę po każdej zmianie konfiguracji.
- `off`: wyłącz gorące przeładowanie.

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

#### Gorąca matryca przeładowania (pliki + wpływ)

Oglądane pliki:

- `~/.openclaw/openclaw.json` (lub `OPENCLAW_CONFIG_PATH`)

Gorąco stosowane (bez ponownego uruchomienia bramy):

- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (ponownie uruchomiono obserwator poczty)
- `browser` (ponowne uruchomienie serwera kontrolnego przeglądarki)
- `cron` (restart usługi cron + aktualizacja kontualu)
- `agents.defaults.heartbeat` (start akcji serca)
- `web` (ponowne uruchomienie kanału WhatsApp)
- `telegram`, `discord`, `signal`, `imessage` (ponowne uruchomienie kanału)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `umiejętności`, `ui`, `talk`, `identity`, `wizard` (dynamiczne czytania)

Wymaga ponownego uruchomienia bramy:

- `gateway` (port/bind/auth/control UI/tailscale)
- `bridge` (legacy)
- `wykrywanie`
- `canvasHost`
- `wtyczki`
- Dowolna nieznana/nieobsługiwana ścieżka konfiguracji (domyślnie do ponownego uruchomienia dla bezpieczeństwa)

### Izolacja wielu instancji

Aby uruchomić wiele bramek na jednym hostu (dla redundancji lub botu ratowniczego), oddziel stan każdej instancji + config i użyj unikalnych portów:

- `OPENCLAW_CONFIG_PATH` (konfiguracja dla każdej instancji)
- `OPENCLAW_STATE_DIR` (sesje/creds)
- `agents.defaults.workspace` (pamięci)
- `gateway.port` (unikalne dla każdej instancji)

Flagi wygodne (CLI):

- `openclaw --dev …` → używa `~/.openclaw-dev` + zmienia porty z `19001`
- `openclaw --profile <name> …` → używa `~/.openclaw-<name>` (port przez config/env/flags)

Zobacz [Gateway runbook](/gateway), aby uzyskać mapowanie portu (brama/browser/canvas).
Zobacz [wiele bramek](/gateway/multiple-gateways), aby uzyskać szczegóły izolacji portu przeglądarki/CDP.

Przykład:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
brama otwierania --port 19001
```

### `hooks` (Gateway webhooks)

Włącz prosty punkt końcowy HTTP na serwerze HTTP bramy.

Domyślne:

- Włączony: `false`
- ścieżka: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    ścieżka: "/hooks",
    : ["gmail"],
    transformsDir: "~/. ołówek/haczyki”,
    mapowanie: [
      {
        dopasowanie: { path: "gmail" }, Działanie
        : „agent”,
        wakeMode: "teraz",
        nazwa: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "Od: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        dostawy: true,
        channel: "last", Model
        : "openai/gpt-5. -mini",
      },
    ],
  },
}
```

Żądania muszą zawierać token haka:

- `Autoryzacja: Bearer <token>` **lub**
- `x-openclaw-token: <token>`

Punkty końcowe:

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
- `POST /hooks/<name>` → rozwiązane przez `hooks.mappings`

`/hooks/agent` zawsze zamieszcza podsumowanie na sesji głównej (i może opcjonalnie wywołać natychmiastowe bicie serca za pomocą `wakeMode: "teraz"`).

Notatki mapowania:

- `match.path` pasuje do podścieżki po `/hooks` (np. `/hooks/gmail` → `gmail`).
- `match.source` pasuje do pola payload (np. `{ source: "gmail" }`), więc możesz użyć generycznej ścieżki `/hooks/ingest`.
- Szablony takie jak `{{messages[0].subject}}` czytane z payloadu.
- `transform` może wskazywać na moduł JS/TS, który zwraca akcję zaczepu.
- `deliver: true` wysyła ostateczną odpowiedź do kanału; `channel` domyślnie do `last` (powróci do WhatsApp).
- Jeśli nie ma poprzedniej trasy dostawy, ustaw `channel` + `do` wyraźnie (wymagane dla Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams).
- `model` zastępuje LLM dla tego biegu zaczepu (`provider/model` lub alias; musi być dozwolone, jeśli ustawiono `agents.defaults.models`).

Konfiguracja pomocnika Gmail (używana przez `openclaw webhooks setup` / `run`):

```json5
{
  hooks: {
    gmail: {
      konto: "openclaw@gmail. om",
      temat: "projects/<project-id>/topics/gog-gmail-watch",
      subskrypcja: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127. .0.1:18789/haks/gmail",
      obejmuje: true,
      maxBajty: 20000,
      rewEveryMinutes: 720,
      serve: { bind: "127. .0. ", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // Opcjonalnie: użyj tańszego modelu dla przetwarzania zaczepu Gmail
      // Upadki z powrotem do agentów. efaults.model. allback, następnie pierwotny, na auth/rate-limit/timeout
      model: "openrouter/meta-llama/llama-3. -70b-instruct:free",
      // Opcjonalnie: domyślny poziom myślenia dla haków Gmail
      myśli: "off",
    },
  },
}
```

Zastąp model dla haków Gmail:

- `hooks.gmail.model` określa model do przetwarzania hooka Gmail (domyślnie podstawowa sesja).
- Akceptuje `provider/model` refs lub aliases z `agents.defaults.models`.
- Wraca do `agents.defaults.model.fallbacks`, a następnie `agents.defaults.model.primary`, na auth/rate-limit/timeouts.
- Jeśli `agents.defaults.models` jest ustawione, dołącz model hooków do listy dozwolonych.
- Przy starcie ostrzega, jeśli skonfigurowany model nie znajduje się w katalogu modeli lub na liście dozwolonych.
- `hooks.gmail.thinking` ustawia domyślny poziom myślenia dla haków Gmail i jest nadpisany przez `thinking`.

Automatyczne uruchamianie bram:

- If `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts
  `gog gmail watch serve` on boot and auto-renews the watch.
- Ustaw `OPENCLAW_SKIP_GMAIL_WATCHER=1` aby wyłączyć auto-start (dla ręcznych uruchomień).
- Unikaj oddzielnego `gog gmail watch serve` obok Gateway;
  nie powiedzie się z `nasłuchiwaniem tcp 127.0.0.1:8788: bind: adres już w użyciu`.

Uwaga: gdy `tailscale.mode` jest włączony, OpenClaw domyślnie `serve.path` do `/` tak, aby
Gailscale może proxy `/gmail-pubsub` poprawnie (usuwa prefiks ustawionej ścieżki).
Jeśli potrzebujesz backendu aby otrzymać predefiniowaną ścieżkę, ustaw
`hooks.gmail.tailscale.target` na pełny adres URL (i wyrównaj `serve.path`).

### `canvasHost` (LAN/tailnet Canvas file server + reload)

Brama obsługuje katalog HTML/CSS/JS przez HTTP, aby iOS/Android węzły mogły po prostu `canvas.navigate`.

Domyślny root: `~/. penclaw/workspace/canvas`  
Domyślny port: `18793` (wybrany aby uniknąć portu CDP przeglądarki openclaw `18792`)  
Serwer nasłuchuje \*\*hosta bramy \*\* (LAN lub Tailnet), aby węzły mogły go dotrzeć.

Serwer:

- obsługuje pliki z `canvasHost.root`
- wstrzykuje malutki klient przeładowania do obsługiwanego HTML
- ogląda katalog i ładuje się ponownie przez punkt końcowy WebSocket w `/__openclaw__/ws`
- automatycznie tworzy starter `index.html` gdy katalog jest pusty (więc zobaczysz coś natychmiast)
- obsługuje również A2UI w `/__openclaw__/a2ui/` i jest reklamowane do węzłów jako `canvasHostUrl`
  (zawsze używane przez węzły dla Canvas/A2UI)

Wyłącz przeładowanie na żywo (i oglądanie plików) jeśli katalog jest duży lub wciśniesz `EMFILE`:

- konfiguracja: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

Zmiany w pliku `canvasHost.*` wymagają ponownego uruchomienia bramy (konfiguracja przeładuje się ponownie).

Wyłącz:

- konfiguracja: `canvasHost: { enabled: false }`
- pl: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge` (starszy mostek TCP, usunięty)

Bieżące kompilacje nie zawierają już słuchacza mostów TCP; klucze `bridge.*` są ignorowane.
Węzły łączą się przez WebSocket bramy. Niniejsza sekcja jest przechowywana do celów historycznych odniesienia.

Zachowanie starszego:

- Brama może wystawić prosty most TCP dla węzłów (iOS/Android), zazwyczaj na porcie `18790`.

Domyślne:

- włączone: `true`
- port: `18790`
- dla: `lan` (wiąże z `0.0.0.0`)

Bind modes:

- `lan`: `0.0.0` (osiągalne na dowolnym interfejsie, w tym LAN/Wi‑Fi i Tailscale)
- `tailnet`: zwiąż tylko z adresem IP w skali progowej (zalecane dla Wiednia <unk> Londyn)
- `loopback`: `127.0.0.1` (tylko lokalnie)
- `auto`: preferuj IP tailnet, jeśli jest obecny, w przeciwnym razie `lan`

TLS:

- `bridge.tls.enabled`: włącz TLS dla połączeń mostkowych (TLS-only when enabled).
- `bridge.tls.autoGenerate`: wygeneruj samopodpisany certyfikat, gdy nie ma certyfikatu lub klucza (domyślnie: true).
- `bridge.tls.certPath` / `bridge.tls.keyPath`: ścieżki PEM dla certyfikatu mostu + klucz prywatny.
- `bridge.tls.caPath`: opcjonalny pakiet CA PEM (własne korzenie lub przyszły mTLS).

Gdy TLS jest włączony, brama reklamuje `bridgeTls=1` i `bridgeTlsSha256` w odkryciu TXT
rekordy, aby węzły mogły przypiąć certyfikat. Ręczne połączenia używają zaufania do pierwszego użycia, jeśli nie zapisano jeszcze odcisku palca
.
Automatyczne generowane certy wymagają `openssl` na PATH; jeśli generowanie się nie powiedzie, most nie uruchomi.

```json5
{
  bridge: {
    włączone: true, port
    : 18790,
    powiązany: „sieć ogonowa”,
    tls: {
      włączone: true,
      // Używa ~/. penclaw/bridge/tls/bridge-{cert,key}. em kiedy pominięto.
      // Ścieżka cert: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // Ścieżka kluczowa: "~/. penclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns` (tryb nadawania Bonjour / mDNS)

Kontroluje transmisje wyszukiwania LAN mDNS (`_openclaw-gw._tcp`).

- `minimal` (domyślnie): pomiń `cliPath` + `sshPort` z rekordów TXT
- `full`: dołącz `cliPath` + `sshPort` do rekordów TXT
- `off`: całkowicie wyłącz transmisje mDNS
- Nazwa hosta: domyślnie `openclaw` (reklamuje `openclaw.local`). Zastąp `OPENCLAW_MDNS_HOSTNAME`.

```json5
{
  odkrycie: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS-SD)

Po włączeniu brama zapisuje unicast strefę DNS-SD dla `_openclaw-gw._tcp` w `~/.openclaw/dns/` przy użyciu skonfigurowanej domeny odkrycia (przykład: `openclaw.internal.`).

Aby odkryć iOS/Android w sieciach (Wiedeń <unk> Londyn), połącz to z:

- serwer DNS na serwerze bramy obsługującym wybraną domenę (CoreDNS jest zalecany)
- Skala przerw **rozdziel DNS**, aby klienci rozwiązali tę domenę za pośrednictwem serwera DNS bramy.

Jednorazowy pomocnik konfiguracji (hosta bramy):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## Zmienne szablonu modelu mediów

Szablonowe symbole są rozszerzone w `tools.media.*.models[].args` i `tools.media.models[].args` (i wszelkie przyszłe pola argumentów szablonów).

\| Zmienna | Opis |
\| ------------------------------------------------------------------------------- | -------- | ------- | ---------- | ----- | ------ | -------- | ------- | ------- | ------- | --- |
\| `{{Body}}` | Pełne przychodzące treści wiadomości |
\| `{{RawBody}}` | Raw przychodzące treści wiadomości (bez zawijania historii/nadawcy; Najlepsze dla parsowania poleceń) |
\| `{{BodyStripped}}` | Treść z usuniętymi wzmiankami grupy (najlepsze domyślne dla agentów) |
\| `{{From}}` | Identyfikator nadawcy (E. 64 dla WhatsApp; może różnić się w zależności od kanału) |
\| `{{To}}` | Identyfikator miejsca przeznaczenia |
\| `{{MessageSid}}` | Identyfikator wiadomości kanału (jeśli dostępny) |
\| `{{SessionId}}` | Bieżąca sesja UUID |
\| `{{IsNewSession}}` | `"true"` gdy nowa sesja została utworzona |
\| `{{MediaUrl}}` | Pseudo-URL mediów przychodzących (jeśli obecnie) |
\| `{{MediaPath}}` | Lokalna ścieżka mediów (jeśli pobrana) |
\| `{{MediaType}}` | Typ mediów (image/audio/document/…)                                             |
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

Cron jest programistą Bateway dla wybudzeń i zaplanowanych prac. Zobacz [Cron jobs](/automation/cron-jobs), aby uzyskać przegląd funkcji i przykłady CLI.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_Następne: [Agent Runtime](/concepts/agent)_ 🦞

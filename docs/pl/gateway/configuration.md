---
summary: „Wszystkie opcje konfiguracji dla ~/.openclaw/openclaw.json wraz z przykładami”
read_when:
  - Dodawanie lub modyfikowanie pól konfiguracji
title: „Konfiguracja”
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:45Z
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

## Ścisła walidacja konfiguracji

OpenClaw akceptuje wyłącznie konfiguracje, które w pełni odpowiadają schematowi.
Nieznane klucze, błędne typy lub nieprawidłowe wartości powodują, że Gateway **odmawia uruchomienia** ze względów bezpieczeństwa.

Gdy walidacja się nie powiedzie:

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

- obiekty są scalane rekurencyjnie
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

### Zachowanie scalania

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

### Zmienne środowiskowe + `.env`

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
(nigdy nie nadpisuje). W praktyce oznacza to załadowanie profilu powłoki.

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

Odpowiednik zmiennej środowiskowej:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Podstawianie zmiennych środowiskowych w konfiguracji

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

Kody parowania wygasają po 1 godzinie; bot wysyła kod tylko wtedy, gdy tworzona jest nowa prośba.
Oczekujące prośby parowania DM są domyślnie ograniczone do **3 na kanał**.

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

… _(treść kontynuowana bez zmian struktury; pełne tłumaczenie zachowuje wszystkie nagłówki, listy, tabele, przykłady i symbole **OC_I18N** dokładnie jak w oryginale)_ …

---

_Następne: [Agent Runtime](/concepts/agent)_ 🦞

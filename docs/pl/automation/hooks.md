---
summary: "Hooki: automatyzacja sterowana zdarzeniami dla poleceń i zdarzeń cyklu życia"
read_when:
  - Chcesz automatyzacji sterowanej zdarzeniami dla /new, /reset, /stop oraz zdarzeń cyklu życia agenta
  - Chcesz tworzyć, instalować lub debugować hooki
title: "Hooki"
---

# Hooki

Hooki zapewniają rozszerzalny system sterowany zdarzeniami do automatyzacji działań w odpowiedzi na polecenia agenta i zdarzenia. Hooki są automatycznie wykrywane z katalogów i mogą być zarządzane za pomocą poleceń CLI, podobnie jak Skills w OpenClaw.

## Orientacja

Hooki to małe skrypty uruchamiane, gdy coś się wydarzy. Istnieją dwa rodzaje:

- **Hooki** (ta strona): uruchamiane wewnątrz Gateway, gdy występują zdarzenia agenta, takie jak `/new`, `/reset`, `/stop` lub zdarzenia cyklu życia.
- **Webhooki**: zewnętrzne webhooki HTTP, które pozwalają innym systemom wyzwalać działania w OpenClaw. Zobacz [Webhook Hooks](/automation/webhook) lub użyj `openclaw webhooks` dla poleceń pomocniczych Gmail.

Hooki mogą być także dołączane do wtyczek; zobacz [Plugins](/tools/plugin#plugin-hooks).

Typowe zastosowania:

- Zapisywanie migawki pamięci przy resetowaniu sesji
- Prowadzenie śladu audytowego poleceń na potrzeby rozwiązywania problemów lub zgodności
- Wyzwalanie dalszej automatyzacji przy rozpoczęciu lub zakończeniu sesji
- Zapisywanie plików w obszarze roboczym agenta lub wywoływanie zewnętrznych API po wystąpieniu zdarzeń

Jeśli potrafisz napisać małą funkcję w TypeScript, możesz napisać hook. Hooki są wykrywane automatycznie, a ich włączanie lub wyłączanie odbywa się przez CLI.

## Przegląd

System hooków umożliwia:

- Zapisywanie kontekstu sesji do pamięci po wydaniu `/new`
- Rejestrowanie wszystkich poleceń do audytu
- Wyzwalanie niestandardowych automatyzacji przy zdarzeniach cyklu życia agenta
- Rozszerzanie zachowania OpenClaw bez modyfikowania kodu rdzenia

## Pierwsze kroki

### Dołączone hooki

OpenClaw zawiera cztery dołączone hooki, które są automatycznie wykrywane:

- **💾 session-memory**: zapisuje kontekst sesji do obszaru roboczego agenta (domyślnie `~/.openclaw/workspace/memory/`) po wydaniu `/new`
- **📝 command-logger**: rejestruje wszystkie zdarzenia poleceń do `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: uruchamia `BOOT.md` przy starcie gateway (wymaga włączonych hooków wewnętrznych)
- **😈 soul-evil**: zamienia wstrzykniętą treść `SOUL.md` na `SOUL_EVIL.md` podczas okna czyszczenia lub losowo

Wyświetl dostępne hooki:

```bash
openclaw hooks list
```

Włącz hook:

```bash
openclaw hooks enable session-memory
```

Sprawdź status hooka:

```bash
openclaw hooks check
```

Uzyskaj szczegółowe informacje:

```bash
openclaw hooks info session-memory
```

### Onboarding

Podczas onboardingu (`openclaw onboard`) zostaniesz poproszony o włączenie zalecanych hooków. Kreator automatycznie wykrywa kwalifikujące się hooki i prezentuje je do wyboru.

## Wykrywanie hooków

Hooki są automatycznie wykrywane z trzech katalogów (w kolejności priorytetu):

1. **Hooki obszaru roboczego**: `<workspace>/hooks/` (na agenta, najwyższy priorytet)
2. **Hooki zarządzane**: `~/.openclaw/hooks/` (instalowane przez użytkownika, współdzielone między obszarami roboczymi)
3. **Hooki dołączone**: `<openclaw>/dist/hooks/bundled/` (dostarczane z OpenClaw)

Katalogi hooków zarządzanych mogą być **pojedynczym hookiem** lub **pakietem hooków** (katalog pakietu).

Każdy hook jest katalogiem zawierającym:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Pakiety hooków (npm/archiwa)

Pakiety hooków to standardowe pakiety npm, które eksportują jeden lub więcej hooków poprzez `openclaw.hooks` w
`package.json`. Instaluj je poleceniem:

```bash
openclaw hooks install <path-or-spec>
```

Przykład `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Każdy wpis wskazuje na katalog hooka zawierający `HOOK.md` oraz `handler.ts` (lub `index.ts`).
Pakiety hooków mogą dostarczać zależności; zostaną one zainstalowane w `~/.openclaw/hooks/<id>`.

## Struktura hooka

### Format HOOK.md

Plik `HOOK.md` zawiera metadane w YAML frontmatter oraz dokumentację Markdown:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### Pola metadanych

Obiekt `metadata.openclaw` obsługuje:

- **`emoji`**: emoji wyświetlane w CLI (np. `"💾"`)
- **`events`**: tablica zdarzeń do nasłuchiwania (np. `["command:new", "command:reset"]`)
- **`export`**: nazwana eksportowana funkcja do użycia (domyślnie `"default"`)
- **`homepage`**: URL dokumentacji
- **`requires`**: opcjonalne wymagania
  - **`bins`**: wymagane binaria w PATH (np. `["git", "node"]`)
  - **`anyBins`**: co najmniej jedno z tych binariów musi być obecne
  - **`env`**: wymagane zmienne środowiskowe
  - **`config`**: wymagane ścieżki konfiguracji (np. `["workspace.dir"]`)
  - **`os`**: wymagane platformy (np. `["darwin", "linux"]`)
- **`always`**: pominięcie sprawdzania kwalifikowalności (boolean)
- **`install`**: metody instalacji (dla dołączonych hooków: `[{"id":"bundled","kind":"bundled"}]`)

### Implementacja obsługi

Plik `handler.ts` eksportuje funkcję `HookHandler`:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### Kontekst zdarzenia

Każde zdarzenie zawiera:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // e.g., 'new', 'reset', 'stop'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Typy zdarzeń

### Zdarzenia poleceń

Wyzwalane, gdy wydawane są polecenia agenta:

- **`command`**: wszystkie zdarzenia poleceń (nasłuch ogólny)
- **`command:new`**: gdy wydane zostaje polecenie `/new`
- **`command:reset`**: gdy wydane zostaje polecenie `/reset`
- **`command:stop`**: gdy wydane zostaje polecenie `/stop`

### Zdarzenia agenta

- **`agent:bootstrap`**: przed wstrzyknięciem plików bootstrap obszaru roboczego (hooki mogą modyfikować `context.bootstrapFiles`)

### Zdarzenia Gateway

Wyzwalane przy starcie gateway:

- **`gateway:startup`**: po uruchomieniu kanałów i załadowaniu hooków

### Hooki wyników narzędzi (API wtyczek)

Te hooki nie są nasłuchiwaczami strumienia zdarzeń; pozwalają wtyczkom synchronicznie modyfikować wyniki narzędzi, zanim OpenClaw je zapisze.

- **`tool_result_persist`**: przekształca wyniki narzędzi przed zapisaniem do transkrypcji sesji. Musi być synchroniczne; zwróć zaktualizowany ładunek wyniku narzędzia lub `undefined`, aby pozostawić bez zmian. Zobacz [Agent Loop](/concepts/agent-loop).

### Przyszłe zdarzenia

Planowane typy zdarzeń:

- **`session:start`**: gdy rozpoczyna się nowa sesja
- **`session:end`**: gdy sesja się kończy
- **`agent:error`**: gdy agent napotyka błąd
- **`message:sent`**: gdy wysyłana jest wiadomość
- **`message:received`**: gdy wiadomość jest odbierana

## Tworzenie niestandardowych hooków

### 1. Wybierz lokalizację

- **Hooki obszaru roboczego** (`<workspace>/hooks/`): na agenta, najwyższy priorytet
- **Hooki zarządzane** (`~/.openclaw/hooks/`): współdzielone między obszarami roboczymi

### 2. Utwórz strukturę katalogów

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Utwórz HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Utwórz handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // Your logic here
};

export default handler;
```

### 5. Włącz i przetestuj

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Konfiguracja

### Nowy format konfiguracji (zalecany)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Konfiguracja per hook

Hooki mogą mieć niestandardową konfigurację:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Dodatkowe katalogi

Ładowanie hooków z dodatkowych katalogów:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Starszy format konfiguracji (nadal wspierany)

Stary format konfiguracji nadal działa ze względu na zgodność wsteczną:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

**Migracja**: w przypadku nowych hooków używaj nowego systemu opartego na wykrywaniu. Starsze procedury obsługi są ładowane po hookach opartych na katalogach.

## Polecenia CLI

### Lista hooków

```bash
# List all hooks
openclaw hooks list

# Show only eligible hooks
openclaw hooks list --eligible

# Verbose output (show missing requirements)
openclaw hooks list --verbose

# JSON output
openclaw hooks list --json
```

### Informacje o hooku

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Sprawdzenie kwalifikowalności

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Włączanie/wyłączanie

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Referencja dołączonych hooków

### session-memory

Zapisuje kontekst sesji do pamięci po wydaniu `/new`.

**Zdarzenia**: `command:new`

**Wymagania**: musi być skonfigurowane `workspace.dir`

**Wyjście**: `<workspace>/memory/YYYY-MM-DD-slug.md` (domyślnie `~/.openclaw/workspace`)

**Co robi**:

1. Używa wpisu sesji sprzed resetu do zlokalizowania właściwej transkrypcji
2. Wyodrębnia ostatnie 15 linii rozmowy
3. Używa LLM do wygenerowania opisowego sluga nazwy pliku
4. Zapisuje metadane sesji do datowanego pliku pamięci

**Przykładowe wyjście**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Przykłady nazw plików**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (zapasowy znacznik czasu, jeśli generowanie sluga się nie powiedzie)

**Włącz**:

```bash
openclaw hooks enable session-memory
```

### command-logger

Rejestruje wszystkie zdarzenia poleceń do scentralizowanego pliku audytu.

**Zdarzenia**: `command`

**Wymagania**: brak

**Wyjście**: `~/.openclaw/logs/commands.log`

**Co robi**:

1. Przechwytuje szczegóły zdarzeń (akcja polecenia, znacznik czasu, klucz sesji, identyfikator nadawcy, źródło)
2. Dopisuje do pliku logu w formacie JSONL
3. Działa cicho w tle

**Przykładowe wpisy logu**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Podgląd logów**:

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Włącz**:

```bash
openclaw hooks enable command-logger
```

### soul-evil

Zamienia wstrzykniętą treść `SOUL.md` na `SOUL_EVIL.md` podczas okna czyszczenia lub losowo.

**Zdarzenia**: `agent:bootstrap`

**Dokumentacja**: [SOUL Evil Hook](/hooks/soul-evil)

**Wyjście**: brak zapisywanych plików; zamiany odbywają się wyłącznie w pamięci.

**Włącz**:

```bash
openclaw hooks enable soul-evil
```

**Konfiguracja**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

Uruchamia `BOOT.md` przy starcie gateway (po uruchomieniu kanałów).
Aby to działało, muszą być włączone hooki wewnętrzne.

**Zdarzenia**: `gateway:startup`

**Wymagania**: musi być skonfigurowane `workspace.dir`

**Co robi**:

1. Odczytuje `BOOT.md` z obszaru roboczego
2. Uruchamia instrukcje przez runner agenta
3. Wysyła wszelkie wymagane wiadomości wychodzące przez narzędzie wiadomości

**Włącz**:

```bash
openclaw hooks enable boot-md
```

## Najlepsze praktyki

### Utrzymuj szybkie procedury obsługi

Hooki działają podczas przetwarzania poleceń. Utrzymuj je lekkie:

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Obsługa błędów gracyjnie

Zawsze opakowuj ryzykowne operacje:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### Wcześnie filtruj zdarzenia

Zwróć wcześniej, jeśli zdarzenie nie jest istotne:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Używaj konkretnych kluczy zdarzeń

Jeśli to możliwe, określaj dokładne zdarzenia w metadanych:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

Zamiast:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debugowanie

### Włącz logowanie hooków

Gateway loguje ładowanie hooków przy starcie:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Sprawdź wykrywanie

Wyświetl wszystkie wykryte hooki:

```bash
openclaw hooks list --verbose
```

### Sprawdź rejestrację

W procedurze obsługi zaloguj, gdy jest wywoływana:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Zweryfikuj kwalifikowalność

Sprawdź, dlaczego hook nie jest kwalifikowalny:

```bash
openclaw hooks info my-hook
```

W wyjściu szukaj brakujących wymagań.

## Testowanie

### Logi Gateway

Monitoruj logi gateway, aby zobaczyć wykonywanie hooków:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Testuj hooki bezpośrednio

Testuj swoje procedury obsługi w izolacji:

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Assert side effects
});
```

## Architektura

### Główne komponenty

- **`src/hooks/types.ts`**: definicje typów
- **`src/hooks/workspace.ts`**: skanowanie katalogów i ładowanie
- **`src/hooks/frontmatter.ts`**: parsowanie metadanych HOOK.md
- **`src/hooks/config.ts`**: sprawdzanie kwalifikowalności
- **`src/hooks/hooks-status.ts`**: raportowanie statusu
- **`src/hooks/loader.ts`**: dynamiczny loader modułów
- **`src/cli/hooks-cli.ts`**: polecenia CLI
- **`src/gateway/server-startup.ts`**: ładuje hooki przy starcie gateway
- **`src/auto-reply/reply/commands-core.ts`**: wyzwala zdarzenia poleceń

### Przepływ wykrywania

```
Gateway startup
    ↓
Scan directories (workspace → managed → bundled)
    ↓
Parse HOOK.md files
    ↓
Check eligibility (bins, env, config, os)
    ↓
Load handlers from eligible hooks
    ↓
Register handlers for events
```

### Przepływ zdarzeń

```
User sends /new
    ↓
Command validation
    ↓
Create hook event
    ↓
Trigger hook (all registered handlers)
    ↓
Command processing continues
    ↓
Session reset
```

## Rozwiązywanie problemów

### Hook nie został wykryty

1. Sprawdź strukturę katalogów:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Zweryfikuj format HOOK.md:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Wyświetl wszystkie wykryte hooki:

   ```bash
   openclaw hooks list
   ```

### Hook niekwalifikowalny

Sprawdź wymagania:

```bash
openclaw hooks info my-hook
```

Szukaj brakujących:

- Binaria (sprawdź PATH)
- Zmienne środowiskowe
- Wartości konfiguracji
- Zgodność z systemem operacyjnym

### Hook nie jest wykonywany

1. Sprawdź, czy hook jest włączony:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Zrestartuj proces gateway, aby hooki zostały ponownie załadowane.

3. Sprawdź logi gateway pod kątem błędów:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Błędy obsługi

Sprawdź błędy TypeScript/importów:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Przewodnik migracji

### Z konfiguracji starszej do wykrywania

**Przed**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**Po**:

1. Utwórz katalog hooka:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Utwórz HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. Zaktualizuj konfigurację:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. Zweryfikuj i zrestartuj proces gateway:

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Korzyści z migracji**:

- Automatyczne wykrywanie
- Zarządzanie przez CLI
- Sprawdzanie kwalifikowalności
- Lepsza dokumentacja
- Spójna struktura

## Zobacz także

- [Referencja CLI: hooks](/cli/hooks)
- [README dołączonych hooków](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Konfiguracja](/gateway/configuration#hooks)

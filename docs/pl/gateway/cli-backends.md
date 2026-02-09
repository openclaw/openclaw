---
summary: "„Backendy CLI: tekstowy tryb awaryjny przez lokalne CLI AI”"
read_when:
  - Gdy potrzebujesz niezawodnego trybu awaryjnego, gdy dostawcy API zawodzą
  - Gdy uruchamiasz Claude Code CLI lub inne lokalne CLI AI i chcesz je ponownie wykorzystać
  - Gdy potrzebujesz wyłącznie tekstowej, pozbawionej narzędzi ścieżki, która nadal obsługuje sesje i obrazy
title: "„Backendy CLI”"
---

# Backendy CLI (środowisko wykonawcze awaryjne)

OpenClaw może uruchamiać **lokalne CLI AI** jako **tekstowy tryb awaryjny**, gdy dostawcy API są niedostępni,
objęci limitami lub tymczasowo działają nieprawidłowo. Jest to celowo rozwiązanie zachowawcze:

- **Narzędzia są wyłączone** (brak wywołań narzędzi).
- **Tekst na wejściu → tekst na wyjściu** (niezawodne).
- **Sesje są obsługiwane** (kolejne tury zachowują spójność).
- **Obrazy mogą być przekazywane** (pass-through), jeśli CLI akceptuje ścieżki do obrazów.

Jest to zaprojektowane jako **siatka bezpieczeństwa**, a nie główna ścieżka. Używaj, gdy
zależy Ci na „zawsze działających” odpowiedziach tekstowych bez polegania na zewnętrznych API.

## Przyjazny dla początkujących szybki start

Możesz używać Claude Code CLI **bez żadnej konfiguracji** (OpenClaw dostarcza wbudowane ustawienia domyślne):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI również działa od razu:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Jeśli Twój gateway działa pod launchd/systemd, a PATH jest minimalny, dodaj tylko
ścieżkę do polecenia:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

To wszystko. Brak kluczy, brak dodatkowej konfiguracji uwierzytelniania poza samym CLI.

## Użycie jako tryb awaryjny

Dodaj backend CLI do listy trybów awaryjnych, aby był uruchamiany tylko wtedy, gdy modele podstawowe zawiodą:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Uwagi:

- Jeśli używasz `agents.defaults.models` (lista dozwolonych), musisz uwzględnić `claude-cli/...`.
- Jeśli podstawowy dostawca zawiedzie (uwierzytelnianie, limity, timeouty), OpenClaw
  spróbuje następnie backendu CLI.

## Przegląd konfiguracji

Wszystkie backendy CLI znajdują się pod:

```
agents.defaults.cliBackends
```

Każdy wpis jest kluczowany **identyfikatorem dostawcy** (np. `claude-cli`, `my-cli`).
Identyfikator dostawcy staje się lewą stroną odwołania do modelu:

```
<provider>/<model>
```

### Przykładowa konfiguracja

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Jak to działa

1. **Wybiera backend** na podstawie prefiksu dostawcy (`claude-cli/...`).
2. **Buduje prompt systemowy** z użyciem tego samego promptu OpenClaw + kontekstu obszaru roboczego.
3. **Wykonuje CLI** z identyfikatorem sesji (jeśli obsługiwane), aby historia pozostała spójna.
4. **Parsuje wyjście** (JSON lub zwykły tekst) i zwraca końcowy tekst.
5. **Utrwala identyfikatory sesji** per backend, aby kolejne wywołania używały tej samej sesji CLI.

## Sessions

- Jeśli CLI obsługuje sesje, ustaw `sessionArg` (np. `--session-id`) lub
  `sessionArgs` (placeholder `{sessionId}`), gdy identyfikator musi być wstawiony
  do wielu flag.
- Jeśli CLI używa **podpolecenia wznawiania** z innymi flagami, ustaw
  `resumeArgs` (zastępuje `args` przy wznawianiu) oraz opcjonalnie `resumeOutput`
  (dla wznawiania nie-JSON).
- `sessionMode`:
  - `always`: zawsze wysyłaj identyfikator sesji (nowy UUID, jeśli żaden nie jest zapisany).
  - `existing`: wysyłaj identyfikator sesji tylko wtedy, gdy był wcześniej zapisany.
  - `none`: nigdy nie wysyłaj identyfikatora sesji.

## Obrazy (pass-through)

Jeśli Twoje CLI akceptuje ścieżki do obrazów, ustaw `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw zapisze obrazy base64 do plików tymczasowych. Jeśli ustawiono `imageArg`,
te ścieżki są przekazywane jako argumenty CLI. Jeśli brakuje `imageArg`, OpenClaw
dołącza ścieżki plików do promptu (wstrzykiwanie ścieżek), co wystarcza dla CLI, które
automatycznie ładują lokalne pliki z samych ścieżek (zachowanie Claude Code CLI).

## Wejścia / wyjścia

- `output: "json"` (domyślnie) próbuje sparsować JSON i wyodrębnić tekst + identyfikator sesji.
- `output: "jsonl"` parsuje strumienie JSONL (Codex CLI `--json`) i wyodrębnia
  ostatnią wiadomość agenta oraz `thread_id`, gdy jest obecne.
- `output: "text"` traktuje stdout jako odpowiedź końcową.

Tryby wejścia:

- `input: "arg"` (domyślnie) przekazuje prompt jako ostatni argument CLI.
- `input: "stdin"` wysyła prompt przez stdin.
- Jeśli prompt jest bardzo długi i ustawiono `maxPromptArgChars`, używany jest stdin.

## Ustawienia domyślne (wbudowane)

OpenClaw dostarcza domyślne ustawienia dla `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw dostarcza również domyślne ustawienia dla `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Nadpisuj tylko w razie potrzeby (częste: bezwzględna ścieżka `command`).

## Ograniczenia

- **Brak narzędzi OpenClaw** (backend CLI nigdy nie otrzymuje wywołań narzędzi). Niektóre CLI
  mogą nadal uruchamiać własne narzędzia agenta.
- **Brak strumieniowania** (wyjście CLI jest zbierane, a następnie zwracane).
- **Wyjścia strukturalne** zależą od formatu JSON danego CLI.
- **Sesje Codex CLI** są wznawiane przez wyjście tekstowe (bez JSONL), co jest mniej
  ustrukturyzowane niż początkowe uruchomienie `--json`. Sesje OpenClaw nadal działają
  normalnie.

## Rozwiązywanie problemów

- **Nie znaleziono CLI**: ustaw `command` na pełną ścieżkę.
- **Nieprawidłowa nazwa modelu**: użyj `modelAliases`, aby mapować `provider/model` → model CLI.
- **Brak ciągłości sesji**: upewnij się, że ustawiono `sessionArg` oraz że `sessionMode` nie jest
  `none` (Codex CLI obecnie nie może wznawiać z wyjściem JSON).
- **Obrazy ignorowane**: ustaw `imageArg` (i sprawdź, czy CLI obsługuje ścieżki plików).

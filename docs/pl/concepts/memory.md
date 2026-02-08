---
summary: "Jak działa pamięć OpenClaw (pliki robocze + automatyczne opróżnianie pamięci)"
read_when:
  - Chcesz poznać układ plików pamięci i przepływ pracy
  - Chcesz dostroić automatyczne opróżnianie pamięci przed kompakcją
x-i18n:
  source_path: concepts/memory.md
  source_hash: e160dc678bb8fda2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:59Z
---

# Pamięć

Pamięć OpenClaw to **zwykły Markdown w obszarze roboczym agenta**. Pliki są
źródłem prawdy; model „pamięta” tylko to, co zostanie zapisane na dysku.

Narzędzia wyszukiwania pamięci są dostarczane przez aktywną wtyczkę pamięci (domyślnie:
`memory-core`). Wtyczki pamięci można wyłączyć za pomocą `plugins.slots.memory = "none"`.

## Pliki pamięci (Markdown)

Domyślny układ obszaru roboczego używa dwóch warstw pamięci:

- `memory/YYYY-MM-DD.md`
  - Dziennik dzienny (tylko dopisywanie).
  - Odczytywany jest dzień bieżący + wczorajszy na początku sesji.
- `MEMORY.md` (opcjonalne)
  - Kuratorowana pamięć długoterminowa.
  - **Ładowana wyłącznie w głównej, prywatnej sesji** (nigdy w kontekstach grupowych).

Pliki te znajdują się w obszarze roboczym (`agents.defaults.workspace`, domyślnie
`~/.openclaw/workspace`). Pełny układ opisano w [Agent workspace](/concepts/agent-workspace).

## Kiedy zapisywać pamięć

- Decyzje, preferencje i trwałe fakty trafiają do `MEMORY.md`.
- Codzienne notatki i bieżący kontekst trafiają do `memory/YYYY-MM-DD.md`.
- Jeśli ktoś mówi „zapamiętaj to”, zapisz to (nie trzymaj w RAM-ie).
- Ten obszar wciąż się rozwija. Pomaga przypominanie modelowi o zapisywaniu wspomnień; będzie wiedział, co zrobić.
- Jeśli chcesz, aby coś się utrwaliło, **poproś bota o zapisanie tego** w pamięci.

## Automatyczne opróżnianie pamięci (ping przed kompakcją)

Gdy sesja jest **bliska automatycznej kompakcji**, OpenClaw uruchamia **cichy,
agentowy krok**, który przypomina modelowi o zapisaniu trwałej pamięci **zanim**
kontekst zostanie skompaktowany. Domyślne prompty wyraźnie mówią, że model _może odpowiedzieć_,
ale zazwyczaj `NO_REPLY` jest poprawną odpowiedzią, dzięki czemu użytkownik nigdy nie widzi tego kroku.

Jest to kontrolowane przez `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

Szczegóły:

- **Miękki próg**: opróżnianie uruchamia się, gdy estymacja tokenów sesji przekroczy
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Cisza domyślna**: prompty zawierają `NO_REPLY`, więc nic nie jest dostarczane.
- **Dwa prompty**: prompt użytkownika oraz prompt systemowy dołączają przypomnienie.
- **Jedno opróżnienie na cykl kompakcji** (śledzone w `sessions.json`).
- **Obszar roboczy musi być zapisywalny**: jeśli sesja działa w sandboxie z
  `workspaceAccess: "ro"` lub `"none"`, opróżnianie jest pomijane.

Pełny cykl życia kompakcji opisano w
[Session management + compaction](/reference/session-management-compaction).

## Wyszukiwanie pamięci wektorowej

OpenClaw może zbudować niewielki indeks wektorowy nad `MEMORY.md` i `memory/*.md`, aby
zapytania semantyczne mogły znajdować powiązane notatki nawet przy różnym brzmieniu.

Ustawienia domyślne:

- Włączone domyślnie.
- Obserwuje pliki pamięci pod kątem zmian (z opóźnieniem).
- Domyślnie używa zdalnych embeddingów. Jeśli `memorySearch.provider` nie jest ustawione, OpenClaw automatycznie wybiera:
  1. `local`, jeśli skonfigurowano `memorySearch.local.modelPath` i plik istnieje.
  2. `openai`, jeśli można rozwiązać klucz OpenAI.
  3. `gemini`, jeśli można rozwiązać klucz Gemini.
  4. `voyage`, jeśli można rozwiązać klucz Voyage.
  5. W przeciwnym razie wyszukiwanie pamięci pozostaje wyłączone do czasu konfiguracji.
- Tryb lokalny używa node-llama-cpp i może wymagać `pnpm approve-builds`.
- Używa sqlite-vec (gdy dostępne) do przyspieszenia wyszukiwania wektorowego w SQLite.

Zdalne embeddingi **wymagają** klucza API dostawcy embeddingów. OpenClaw
rozwiązuje klucze z profili uwierzytelniania, `models.providers.*.apiKey` lub zmiennych
środowiskowych. OAuth Codex obejmuje tylko czat/uzupełniania i **nie** spełnia
wymagań embeddingów do wyszukiwania pamięci. Dla Gemini użyj `GEMINI_API_KEY` lub
`models.providers.google.apiKey`. Dla Voyage użyj `VOYAGE_API_KEY` lub
`models.providers.voyage.apiKey`. Przy użyciu niestandardowego endpointu zgodnego z OpenAI
ustaw `memorySearch.remote.apiKey` (oraz opcjonalnie `memorySearch.remote.headers`).

### Backend QMD (eksperymentalny)

Ustaw `memory.backend = "qmd"`, aby zastąpić wbudowany indeksator SQLite przez
[QMD](https://github.com/tobi/qmd): lokalny sidecar wyszukiwania łączący
BM25 + wektory + reranking. Markdown pozostaje źródłem prawdy; OpenClaw wywołuje
QMD do pobierania wyników. Kluczowe punkty:

**Wymagania wstępne**

- Domyślnie wyłączone. Włączane per-konfiguracja (`memory.backend = "qmd"`).
- Zainstaluj osobno CLI QMD (`bun install -g https://github.com/tobi/qmd` lub pobierz
  wydanie) i upewnij się, że binarka `qmd` znajduje się na `PATH` gateway’a.
- QMD wymaga kompilacji SQLite ze wsparciem rozszerzeń (`brew install sqlite` na
  macOS).
- QMD działa w pełni lokalnie przez Bun + `node-llama-cpp` i automatycznie pobiera
  modele GGUF z HuggingFace przy pierwszym użyciu (nie jest wymagany osobny daemon Ollama).
- Gateway uruchamia QMD w samodzielnym katalogu XDG pod
  `~/.openclaw/agents/<agentId>/qmd/`, ustawiając `XDG_CONFIG_HOME` oraz
  `XDG_CACHE_HOME`.
- Wsparcie OS: macOS i Linux działają od razu po zainstalowaniu Bun + SQLite.
  Windows najlepiej wspierany przez WSL2.

**Jak działa sidecar**

- Gateway zapisuje samodzielny katalog domowy QMD pod
  `~/.openclaw/agents/<agentId>/qmd/` (konfiguracja + cache + baza sqlite).
- Kolekcje są tworzone przez `qmd collection add` z `memory.qmd.paths`
  (plus domyślne pliki pamięci obszaru roboczego), następnie `qmd update` + `qmd embed` są uruchamiane
  przy starcie oraz w konfigurowalnym interwale (`memory.qmd.update.interval`,
  domyślnie 5 min).
- Odświeżanie przy starcie działa teraz domyślnie w tle, aby nie blokować uruchomienia czatu;
  ustaw `memory.qmd.update.waitForBootSync = true`, aby zachować poprzednie blokujące zachowanie.
- Wyszukiwania są wykonywane przez `qmd query --json`. Jeśli QMD zawiedzie lub
  brakuje binarki, OpenClaw automatycznie wraca do wbudowanego menedżera SQLite,
  dzięki czemu narzędzia pamięci nadal działają.
- OpenClaw nie udostępnia obecnie strojenia rozmiaru batcha embeddingów QMD;
  zachowanie batcha kontroluje samo QMD.
- **Pierwsze wyszukiwanie może być wolne**: QMD może pobrać lokalne modele GGUF
  (reranker/rozszerzanie zapytań) przy pierwszym uruchomieniu `qmd query`.
  - OpenClaw automatycznie ustawia `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`, gdy uruchamia QMD.
  - Jeśli chcesz wstępnie pobrać modele ręcznie (i rozgrzać ten sam indeks,
    którego używa OpenClaw), uruchom jednorazowe zapytanie z katalogami XDG agenta.

    Stan QMD OpenClaw znajduje się w Twoim **katalogu stanu** (domyślnie `~/.openclaw`).
    Możesz wskazać `qmd` na dokładnie ten sam indeks, eksportując te same zmienne XDG,
    których używa OpenClaw:

    ```bash
    # Pick the same state dir OpenClaw uses
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    if [ -d "$HOME/.moltbot" ] && [ ! -d "$HOME/.openclaw" ] \
      && [ -z "${OPENCLAW_STATE_DIR:-}" ]; then
      STATE_DIR="$HOME/.moltbot"
    fi

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Optional) force an index refresh + embeddings
    qmd update
    qmd embed

    # Warm up / trigger first-time model downloads
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Powierzchnia konfiguracji (`memory.qmd.*`)**

- `command` (domyślnie `qmd`): nadpisanie ścieżki do pliku wykonywalnego.
- `includeDefaultMemory` (domyślnie `true`): automatyczne indeksowanie `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: dodanie dodatkowych katalogów/plików (`path`, opcjonalnie `pattern`, opcjonalnie
  stabilne `name`).
- `sessions`: włączenie indeksowania JSONL sesji (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: kontrola kadencji odświeżania i wykonywania utrzymania:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: ograniczenie ładunku przywołań (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: ten sam schemat co [`session.sendPolicy`](/gateway/configuration#session).
  Domyślnie tylko DM-y (`deny` wszystkie, `allow` czaty bezpośrednie); poluzuj,
  aby ujawniać trafienia QMD w grupach/kanałach.
- Fragmenty pochodzące spoza obszaru roboczego pojawiają się jako
  `qmd/<collection>/<relative-path>` w wynikach `memory_search`; `memory_get`
  rozumie ten prefiks i czyta z skonfigurowanego katalogu głównego kolekcji QMD.
- Gdy `memory.qmd.sessions.enabled = true`, OpenClaw eksportuje zanonimizowane transkrypty sesji
  (tury Użytkownik/Asystent) do dedykowanej kolekcji QMD pod
  `~/.openclaw/agents/<id>/qmd/sessions/`, dzięki czemu `memory_search` może przywoływać
  ostatnie rozmowy bez dotykania wbudowanego indeksu SQLite.
- Fragmenty `memory_search` zawierają teraz stopkę `Source: <path#line>`, gdy
  `memory.citations` ma wartość `auto`/`on`; ustaw `memory.citations = "off"`,
  aby zachować metadane ścieżki jako wewnętrzne (agent nadal otrzymuje ścieżkę do
  `memory_get`, ale tekst fragmentu pomija stopkę, a prompt systemowy
  ostrzega agenta, aby jej nie cytował).

**Przykład**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [{ action: "allow", match: { chatType: "direct" } }]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Cytowania i fallback**

- `memory.citations` obowiązuje niezależnie od backendu (`auto`/`on`/`off`).
- Gdy działa `qmd`, oznaczamy `status().backend = "qmd"`, aby diagnostyka pokazywała,
  który silnik obsłużył wyniki. Jeśli podproces QMD zakończy się lub wyjście JSON
  nie może zostać sparsowane, menedżer wyszukiwania loguje ostrzeżenie i zwraca
  wbudowanego dostawcę (istniejące embeddingi Markdown), dopóki QMD się nie podniesie.

### Dodatkowe ścieżki pamięci

Jeśli chcesz indeksować pliki Markdown poza domyślnym układem obszaru roboczego,
dodaj jawne ścieżki:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Uwagi:

- Ścieżki mogą być bezwzględne lub względne względem obszaru roboczego.
- Katalogi są skanowane rekurencyjnie w poszukiwaniu plików `.md`.
- Indeksowane są tylko pliki Markdown.
- Dowiązania symboliczne są ignorowane (pliki lub katalogi).

### Embeddingi Gemini (natywne)

Ustaw dostawcę na `gemini`, aby używać bezpośrednio API embeddingów Gemini:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Uwagi:

- `remote.baseUrl` jest opcjonalne (domyślnie bazowy URL API Gemini).
- `remote.headers` pozwala dodać dodatkowe nagłówki, jeśli są potrzebne.
- Domyślny model: `gemini-embedding-001`.

Jeśli chcesz użyć **niestandardowego endpointu zgodnego z OpenAI** (OpenRouter, vLLM lub proxy),
możesz użyć konfiguracji `remote` z dostawcą OpenAI:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Jeśli nie chcesz ustawiać klucza API, użyj `memorySearch.provider = "local"` lub ustaw
`memorySearch.fallback = "none"`.

Fallbacki:

- `memorySearch.fallback` może mieć wartość `openai`, `gemini`, `local` lub `none`.
- Dostawca fallback jest używany tylko wtedy, gdy podstawowy dostawca embeddingów zawiedzie.

Indeksowanie wsadowe (OpenAI + Gemini):

- Włączone domyślnie dla embeddingów OpenAI i Gemini. Ustaw `agents.defaults.memorySearch.remote.batch.enabled = false`, aby wyłączyć.
- Domyślne zachowanie czeka na zakończenie batcha; dostrój `remote.batch.wait`, `remote.batch.pollIntervalMs` i `remote.batch.timeoutMinutes`, jeśli potrzeba.
- Ustaw `remote.batch.concurrency`, aby kontrolować liczbę równoległych zadań batch (domyślnie: 2).
- Tryb batch obowiązuje, gdy `memorySearch.provider = "openai"` lub `"gemini"` i używa odpowiadającego klucza API.
- Zadania batch Gemini używają asynchronicznego endpointu batch embeddingów i wymagają dostępności Gemini Batch API.

Dlaczego batch OpenAI jest szybki i tani:

- Dla dużych uzupełnień wstecznych OpenAI jest zwykle najszybszą wspieraną opcją,
  ponieważ możemy wysyłać wiele żądań embeddingów w jednym zadaniu batch i pozwolić
  OpenAI przetwarzać je asynchronicznie.
- OpenAI oferuje obniżone ceny dla obciążeń Batch API, więc duże przebiegi
  indeksowania są zwykle tańsze niż wysyłanie tych samych żądań synchronicznie.
- Szczegóły w dokumentacji i cenniku OpenAI Batch API:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Przykład konfiguracji:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Narzędzia:

- `memory_search` — zwraca fragmenty z plikiem + zakresami linii.
- `memory_get` — odczyt zawartości pliku pamięci po ścieżce.

Tryb lokalny:

- Ustaw `agents.defaults.memorySearch.provider = "local"`.
- Podaj `agents.defaults.memorySearch.local.modelPath` (GGUF lub URI `hf:`).
- Opcjonalnie: ustaw `agents.defaults.memorySearch.fallback = "none"`, aby uniknąć zdalnego fallbacku.

### Jak działają narzędzia pamięci

- `memory_search` przeszukuje semantycznie fragmenty Markdown (~400 tokenów docelowo, 80-tokenowa nakładka) z `MEMORY.md` + `memory/**/*.md`. Zwraca tekst fragmentu (limit ~700 znaków), ścieżkę pliku, zakres linii, wynik, dostawcę/model oraz informację, czy nastąpił fallback z lokalnych → zdalnych embeddingów. Nie jest zwracana pełna zawartość pliku.
- `memory_get` odczytuje konkretny plik Markdown pamięci (względny względem obszaru roboczego), opcjonalnie od wskazanej linii i przez N linii. Ścieżki poza `MEMORY.md` / `memory/` są odrzucane.
- Oba narzędzia są włączone tylko wtedy, gdy `memorySearch.enabled` rozwiązuje się jako true dla agenta.

### Co jest indeksowane (i kiedy)

- Typ pliku: tylko Markdown (`MEMORY.md`, `memory/**/*.md`).
- Przechowywanie indeksu: SQLite per-agent w `~/.openclaw/memory/<agentId>.sqlite` (konfigurowalne przez `agents.defaults.memorySearch.store.path`, obsługuje token `{agentId}`).
- Świeżość: watcher na `MEMORY.md` + `memory/` oznacza indeks jako brudny (debounce 1,5 s). Synchronizacja jest planowana na start sesji, przy wyszukiwaniu lub w interwale i działa asynchronicznie. Transkrypty sesji używają progów delta do wyzwalania synchronizacji w tle.
- Wyzwalacze reindeksacji: indeks przechowuje **dostawcę/model embeddingów + odcisk endpointu + parametry chunkowania**. Jeśli którekolwiek z nich się zmieni, OpenClaw automatycznie resetuje i reindeksuje cały magazyn.

### Wyszukiwanie hybrydowe (BM25 + wektor)

Gdy włączone, OpenClaw łączy:

- **Podobieństwo wektorowe** (dopasowanie semantyczne, brzmienie może się różnić)
- **Trafność słów kluczowych BM25** (dokładne tokeny, jak identyfikatory, zmienne środowiskowe, symbole kodu)

Jeśli pełnotekstowe wyszukiwanie jest niedostępne na Twojej platformie, OpenClaw wraca do wyszukiwania tylko wektorowego.

#### Dlaczego hybryda?

Wyszukiwanie wektorowe świetnie radzi sobie z „to znaczy to samo”:

- „Mac Studio gateway host” vs „maszyna uruchamiająca gateway”
- „debounce aktualizacje plików” vs „unikać indeksowania przy każdym zapisie”

Może jednak być słabe dla dokładnych, wysoko-sygnałowych tokenów:

- identyfikatory (`a828e60`, `b3b9895a…`)
- symbole kodu (`memorySearch.query.hybrid`)
- ciągi błędów („sqlite-vec unavailable”)

BM25 (pełnotekst) jest odwrotnością: silne dla dokładnych tokenów, słabsze dla parafraz.
Wyszukiwanie hybrydowe to pragmatyczny środek: **używa obu sygnałów pobierania**, aby uzyskać
dobre wyniki zarówno dla zapytań „języka naturalnego”, jak i „igła w stogu siana”.

#### Jak łączymy wyniki (obecny projekt)

Szkic implementacji:

1. Pobierz pulę kandydatów z obu stron:

- **Wektor**: top `maxResults * candidateMultiplier` według podobieństwa cosinusowego.
- **BM25**: top `maxResults * candidateMultiplier` według rangi FTS5 BM25 (niżej = lepiej).

2. Przekształć rangę BM25 w wynik ~0..1:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Połącz kandydatów po id fragmentu i oblicz wynik ważony:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Uwagi:

- `vectorWeight` + `textWeight` jest normalizowane do 1,0 podczas rozwiązywania konfiguracji, więc wagi zachowują się jak procenty.
- Jeśli embeddingi są niedostępne (lub dostawca zwraca wektor zerowy), nadal uruchamiamy BM25 i zwracamy dopasowania słów kluczowych.
- Jeśli FTS5 nie może zostać utworzone, pozostajemy przy wyszukiwaniu tylko wektorowym (bez twardej awarii).

To nie jest „idealne według teorii IR”, ale jest proste, szybkie i zwykle poprawia recall/precyzję na rzeczywistych notatkach.
Jeśli później będziemy chcieli pójść dalej, typowe kolejne kroki to Reciprocal Rank Fusion (RRF) lub normalizacja wyników
(min/max lub z-score) przed mieszaniem.

Konfiguracja:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4
        }
      }
    }
  }
}
```

### Cache embeddingów

OpenClaw może buforować **embeddingi fragmentów** w SQLite, aby reindeksowanie i częste aktualizacje
(zwłaszcza transkrypty sesji) nie wymagały ponownego embedowania niezmienionego tekstu.

Konfiguracja:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Wyszukiwanie pamięci sesji (eksperymentalne)

Opcjonalnie możesz indeksować **transkrypty sesji** i udostępniać je przez `memory_search`.
Funkcja jest ukryta za flagą eksperymentalną.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Uwagi:

- Indeksowanie sesji jest **opcjonalne** (domyślnie wyłączone).
- Aktualizacje sesji są debouncowane i **indeksowane asynchronicznie** po przekroczeniu progów delta (best-effort).
- `memory_search` nigdy nie blokuje na indeksowaniu; wyniki mogą być lekko nieaktualne do czasu zakończenia synchronizacji w tle.
- Wyniki nadal zawierają tylko fragmenty; `memory_get` pozostaje ograniczone do plików pamięci.
- Indeksowanie sesji jest izolowane per agent (indeksowane są tylko logi sesji tego agenta).
- Logi sesji znajdują się na dysku (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Każdy proces/użytkownik z dostępem do systemu plików może je odczytać, więc granicą zaufania jest dostęp do dysku. Dla ostrzejszej izolacji uruchamiaj agentów pod oddzielnymi użytkownikami systemu lub hostami.

Progi delta (pokazane wartości domyślne):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // JSONL lines
        }
      }
    }
  }
}
```

### Przyspieszenie wektorów SQLite (sqlite-vec)

Gdy rozszerzenie sqlite-vec jest dostępne, OpenClaw przechowuje embeddingi w
wirtualnej tabeli SQLite (`vec0`) i wykonuje zapytania odległości wektorów w
bazie danych. Utrzymuje to szybkie wyszukiwanie bez ładowania każdego embeddingu do JS.

Konfiguracja (opcjonalna):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Uwagi:

- `enabled` domyślnie ma wartość true; po wyłączeniu wyszukiwanie wraca do
  obliczania podobieństwa cosinusowego w procesie nad zapisanymi embeddingami.
- Jeśli rozszerzenie sqlite-vec jest niedostępne lub nie uda się go załadować,
  OpenClaw loguje błąd i kontynuuje z fallbackiem JS (bez tabeli wektorowej).
- `extensionPath` nadpisuje dołączoną ścieżkę sqlite-vec (przydatne dla niestandardowych
  buildów lub niestandardowych lokalizacji instalacji).

### Automatyczne pobieranie lokalnych embeddingów

- Domyślny lokalny model embeddingów: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` (~0,6 GB).
- Gdy `memorySearch.provider = "local"`, `node-llama-cpp` rozwiązuje `modelPath`; jeśli GGUF brakuje, jest **automatycznie pobierany** do cache (lub `local.modelCacheDir`, jeśli ustawione), a następnie ładowany. Pobieranie jest wznawiane przy ponownej próbie.
- Wymaganie natywnej kompilacji: uruchom `pnpm approve-builds`, wybierz `node-llama-cpp`, następnie `pnpm rebuild node-llama-cpp`.
- Fallback: jeśli lokalna konfiguracja się nie powiedzie i `memorySearch.fallback = "openai"`, automatycznie przełączamy się na zdalne embeddingi (`openai/text-embedding-3-small`, o ile nie nadpisano) i zapisujemy powód.

### Przykład niestandardowego endpointu zgodnego z OpenAI

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Uwagi:

- `remote.*` ma pierwszeństwo przed `models.providers.openai.*`.
- `remote.headers` łączą się z nagłówkami OpenAI; zdalne wygrywają przy konfliktach kluczy. Pomiń `remote.headers`, aby użyć domyślnych ustawień OpenAI.

---
summary: "Subagenci: uruchamianie odizolowanych przebiegów agentów, które ogłaszają wyniki z powrotem w czacie żądającym"
read_when:
  - Chcesz wykonywać pracę w tle/równolegle za pomocą agenta
  - Zmieniasz politykę sessions_spawn lub narzędzi subagenta
title: "Podagenci"
---

# Subagenci

Subagenci to przebiegi agentów w tle uruchamiane z istniejącego przebiegu agenta. Działają w swojej własnej sesji (`agent:<agentId>:subagent:<uuid>`) i po zakończeniu **ogłaszają** swój wynik z powrotem do kanału czatu żądającego.

## Polecenie slash

Użyj `/subagents`, aby sprawdzić lub kontrolować przebiegi subagentów dla **bieżącej sesji**:

- `/subagents list`
- `/subagents stop <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`

`/subagents info` pokazuje metadane przebiegu (status, znaczniki czasu, identyfikator sesji, ścieżkę transkryptu, czyszczenie).

Główne cele:

- Równoleglenie pracy typu „badania / długie zadania / wolne narzędzia” bez blokowania głównego przebiegu.
- Utrzymanie domyślnej izolacji subagentów (separacja sesji + opcjonalne sandboxing).
- Utrzymanie powierzchni narzędzi trudnej do nadużycia: subagenci **nie** otrzymują domyślnie narzędzi sesji.
- Unikanie zagnieżdżonego fan-outu: subagenci nie mogą uruchamiać subagentów.

Uwaga dotycząca kosztów: każdy subagent ma **własny** kontekst i zużycie tokenów. W przypadku ciężkich lub powtarzalnych zadań ustaw tańszy model dla subagentów, a głównego agenta pozostaw na modelu wyższej jakości.
Możesz to skonfigurować przez `agents.defaults.subagents.model` lub nadpisania per-agent.

## Narzędzie

Użyj `sessions_spawn`:

- Uruchamia przebieg subagenta (`deliver: false`, globalna kolejka: `subagent`)
- Następnie uruchamia krok ogłoszenia i publikuje odpowiedź ogłoszenia w kanale czatu żądającego
- Domyślny model: dziedziczy po wywołującym, chyba że ustawisz `agents.defaults.subagents.model` (lub per-agent `agents.list[].subagents.model`); jawne `sessions_spawn.model` ma pierwszeństwo.
- Domyślne „thinking”: dziedziczy po wywołującym, chyba że ustawisz `agents.defaults.subagents.thinking` (lub per-agent `agents.list[].subagents.thinking`); jawne `sessions_spawn.thinking` ma pierwszeństwo.

Parametry narzędzia:

- `task` (wymagane)
- `label?` (opcjonalne)
- `agentId?` (opcjonalne; uruchom pod innym identyfikatorem agenta, jeśli dozwolone)
- `model?` (opcjonalne; nadpisuje model subagenta; nieprawidłowe wartości są pomijane, a subagent działa na modelu domyślnym z ostrzeżeniem w wyniku narzędzia)
- `thinking?` (opcjonalne; nadpisuje poziom „thinking” dla przebiegu subagenta)
- `runTimeoutSeconds?` (domyślnie `0`; gdy ustawione, przebieg subagenta jest przerywany po N sekundach)
- `cleanup?` (`delete|keep`, domyślnie `keep`)

Lista dozwolonych:

- `agents.list[].subagents.allowAgents`: lista identyfikatorów agentów, które mogą być wskazane przez `agentId` (`["*"]` aby zezwolić na dowolne). Domyślnie: tylko agent żądający.

Wykrywanie:

- Użyj `agents_list`, aby zobaczyć, które identyfikatory agentów są obecnie dozwolone dla `sessions_spawn`.

Automatyczna archiwizacja:

- Sesje subagentów są automatycznie archiwizowane po `agents.defaults.subagents.archiveAfterMinutes` (domyślnie: 60).
- Archiwizacja używa `sessions.delete` i zmienia nazwę transkryptu na `*.deleted.<timestamp>` (ten sam folder).
- `cleanup: "delete"` archiwizuje natychmiast po ogłoszeniu (nadal zachowuje transkrypt poprzez zmianę nazwy).
- Automatyczna archiwizacja jest wykonywana w trybie best-effort; oczekujące timery są tracone, jeśli Gateway zostanie zrestartowany.
- `runTimeoutSeconds` **nie** archiwizuje automatycznie; jedynie zatrzymuje przebieg. Sesja pozostaje do czasu automatycznej archiwizacji.

## Uwierzytelnianie

Uwierzytelnianie subagenta jest rozstrzygane według **identyfikatora agenta**, a nie typu sesji:

- Klucz sesji subagenta to `agent:<agentId>:subagent:<uuid>`.
- Magazyn uwierzytelniania jest ładowany z `agentDir` tego agenta.
- Profile uwierzytelniania głównego agenta są dołączane jako **fallback**; profile agenta mają pierwszeństwo w przypadku konfliktów.

Uwaga: scalanie jest addytywne, więc profile główne są zawsze dostępne jako fallback. W pełni izolowane uwierzytelnianie per agent nie jest jeszcze obsługiwane.

## Ogłoszenie

Subagenci raportują z powrotem poprzez krok ogłoszenia:

- Krok ogłoszenia działa wewnątrz sesji subagenta (nie sesji żądającej).
- Jeśli subagent odpowie dokładnie `ANNOUNCE_SKIP`, nic nie zostanie opublikowane.
- W przeciwnym razie odpowiedź ogłoszenia jest publikowana w kanale czatu żądającego poprzez następcze wywołanie `agent` (`deliver=true`).
- Odpowiedzi ogłoszeń zachowują trasowanie wątków/tematów, gdy jest dostępne (wątki Slack, tematy Telegram, wątki Matrix).
- Wiadomości ogłoszeń są normalizowane do stabilnego szablonu:
  - `Status:` wyprowadzone z wyniku przebiegu (`success`, `error`, `timeout` lub `unknown`).
  - `Result:` treść podsumowania ze kroku ogłoszenia (lub `(not available)`, jeśli brak).
  - `Notes:` szczegóły błędów i inny użyteczny kontekst.
- `Status` nie jest wnioskowany z wyjścia modelu; pochodzi z sygnałów wyniku wykonania.

Ładunki ogłoszeń zawierają na końcu linię statystyk (nawet gdy są opakowane):

- Czas wykonania (np. `runtime 5m12s`)
- Zużycie tokenów (wejście/wyjście/razem)
- Szacowany koszt, gdy skonfigurowane jest cennikowanie modeli (`models.providers.*.models[].cost`)
- `sessionKey`, `sessionId` oraz ścieżkę transkryptu (aby główny agent mógł pobrać historię przez `sessions_history` lub sprawdzić plik na dysku)

## Polityka narzędzi (narzędzia subagenta)

Domyślnie subagenci otrzymują **wszystkie narzędzia z wyjątkiem narzędzi sesji**:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

Nadpisanie przez konfigurację:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny wins
        deny: ["gateway", "cron"],
        // if allow is set, it becomes allow-only (deny still wins)
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## Współbieżność

Subagenci używają dedykowanej kolejki w procesie:

- Nazwa kolejki: `subagent`
- Współbieżność: `agents.defaults.subagents.maxConcurrent` (domyślnie `8`)

## Zatrzymywanie

- Wysłanie `/stop` w czacie żądającym przerywa sesję żądającą i zatrzymuje wszelkie aktywne przebiegi subagentów uruchomione z niej.

## Ograniczenia

- Ogłoszenie subagenta jest w trybie **best-effort**. Jeśli Gateway zostanie zrestartowany, oczekujące prace „ogłoszenia z powrotem” zostaną utracone.
- Subagenci nadal współdzielą zasoby tego samego procesu Gateway; traktuj `maxConcurrent` jako zawór bezpieczeństwa.
- `sessions_spawn` jest zawsze nieblokujące: zwraca `{ status: "accepted", runId, childSessionKey }` natychmiast.
- Kontekst subagenta wstrzykuje tylko `AGENTS.md` + `TOOLS.md` (bez `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` ani `BOOTSTRAP.md`).

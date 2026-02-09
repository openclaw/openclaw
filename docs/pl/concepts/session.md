---
summary: "Zasady zarządzania sesjami, klucze i trwałość dla czatów"
read_when:
  - Modyfikowanie obsługi sesji lub przechowywania
title: "Zarządzanie sesjami"
---

# Zarządzanie sesjami

OpenClaw traktuje **jedną sesję czatu bezpośredniego na agenta** jako podstawową. Czat bezpośredni jest scalany do `agent:<agentId>:<mainKey>` (domyślnie `main`), natomiast czaty grupowe/kanałowe otrzymują własne klucze. `session.mainKey` jest respektowane.

Użyj `session.dmScope`, aby kontrolować, jak grupowane są **wiadomości bezpośrednie**:

- `main` (domyślnie): wszystkie DM-y współdzielą główną sesję dla zachowania ciągłości.
- `per-peer`: izolacja według identyfikatora nadawcy w kanałach.
- `per-channel-peer`: izolacja według kanału + nadawcy (zalecane dla skrzynek wieloużytkownikowych).
- `per-account-channel-peer`: izolacja według konta + kanału + nadawcy (zalecane dla skrzynek wielokontowych).
  Użyj `session.identityLinks`, aby mapować identyfikatory peerów z prefiksem dostawcy do tożsamości kanonicznej, tak aby ta sama osoba współdzieliła sesję DM między kanałami przy użyciu `per-peer`, `per-channel-peer` lub `per-account-channel-peer`.

## Tryb bezpiecznych DM (zalecany dla konfiguracji wieloużytkownikowych)

> **Ostrzeżenie bezpieczeństwa:** Jeśli agent może odbierać DM-y od **wielu osób**, zdecydowanie należy rozważyć włączenie trybu bezpiecznych DM. Bez niego wszyscy użytkownicy współdzielą ten sam kontekst rozmowy, co może prowadzić do ujawnienia prywatnych informacji między użytkownikami.

**Przykład problemu przy ustawieniach domyślnych:**

- Alicja (`<SENDER_A>`) pisze do agenta w prywatnej sprawie (na przykład wizyta lekarska)
- Bob (`<SENDER_B>`) pisze do agenta z pytaniem „O czym rozmawialiśmy?”
- Ponieważ oba DM-y współdzielą tę samą sesję, model może odpowiedzieć Bobowi, wykorzystując wcześniejszy kontekst Alicji.

**Rozwiązanie:** Ustaw `dmScope`, aby izolować sesje na użytkownika:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Kiedy włączyć:**

- Masz zatwierdzanie parowania dla więcej niż jednego nadawcy
- Używasz listy dozwolonych DM z wieloma wpisami
- Ustawiasz `dmPolicy: "open"`
- Wiele numerów telefonów lub kont może pisać do agenta

Uwagi:

- Domyślnie obowiązuje `dmScope: "main"` dla ciągłości (wszystkie DM-y współdzielą główną sesję). To jest w porządku dla konfiguracji jednoosobowych.
- Dla skrzynek wielokontowych w tym samym kanale preferuj `per-account-channel-peer`.
- Jeśli ta sama osoba kontaktuje się z Tobą w wielu kanałach, użyj `session.identityLinks`, aby scalić jej sesje DM w jedną tożsamość kanoniczną.
- Ustawienia DM możesz zweryfikować poleceniem `openclaw security audit` (zobacz [security](/cli/security)).

## Gateway jest źródłem prawdy

Cały stan sesji jest **własnością gateway** (głównego OpenClaw). Klienci UI (aplikacja macOS, WebChat itp.) muszą odpytywać gateway o listy sesji i liczniki tokenów zamiast czytać pliki lokalne.

- W **trybie zdalnym** magazyn sesji, który ma znaczenie, znajduje się na zdalnym hoście gateway, a nie na Twoim Macu.
- Liczniki tokenów wyświetlane w UI pochodzą z pól magazynu gateway (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Klienci nie parsują transkryptów JSONL, aby „korygować” sumy.

## Gdzie znajduje się stan

- Na **hoście gateway**:
  - Plik magazynu: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (na agenta).
- Transkrypty: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (sesje tematów Telegram używają `.../<SessionId>-topic-<threadId>.jsonl`).
- Magazyn jest mapą `sessionKey -> { sessionId, updatedAt, ... }`. Usuwanie wpisów jest bezpieczne; są odtwarzane na żądanie.
- Wpisy grupowe mogą zawierać `displayName`, `channel`, `subject`, `room` i `space` do etykietowania sesji w UI.
- Wpisy sesji zawierają metadane `origin` (etykieta + wskazówki routingu), aby UI mogły wyjaśnić pochodzenie sesji.
- OpenClaw **nie** odczytuje starszych folderów sesji Pi/Tau.

## Przycinanie sesji

OpenClaw domyślnie usuwa **stare wyniki narzędzi** z kontekstu w pamięci tuż przed wywołaniami LLM.
To **nie** przepisuje historii JSONL. Zobacz [/concepts/session-pruning](/concepts/session-pruning).

## Wstępne opróżnianie pamięci przed kompaktacją

Gdy sesja zbliża się do automatycznej kompaktacji, OpenClaw może wykonać **ciche opróżnienie pamięci**
— turę, która przypomina modelowi o zapisaniu trwałych notatek na dysku. Uruchamia się to tylko wtedy,
gdy obszar roboczy jest zapisywalny. Zobacz [Memory](/concepts/memory) oraz
[Compaction](/concepts/compaction).

## Mapowanie transportów → klucze sesji

- Czaty bezpośrednie stosują `session.dmScope` (domyślnie `main`).
  - `main`: `agent:<agentId>:<mainKey>` (ciągłość między urządzeniami/kanałami).
    - Wiele numerów telefonów i kanałów może mapować się do tego samego głównego klucza agenta; działają one jako transporty do jednej rozmowy.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId domyślnie `default`).
  - Jeśli `session.identityLinks` pasuje do identyfikatora peera z prefiksem dostawcy (na przykład `telegram:123`), klucz kanoniczny zastępuje `<peerId>`, dzięki czemu ta sama osoba współdzieli sesję między kanałami.
- Czaty grupowe izolują stan: `agent:<agentId>:<channel>:group:<id>` (pokoje/kanały używają `agent:<agentId>:<channel>:channel:<id>`).
  - Tematy forów Telegram dodają `:topic:<threadId>` do identyfikatora grupy dla izolacji.
  - Starsze klucze `group:<id>` są nadal rozpoznawane na potrzeby migracji.
- Konteksty przychodzące mogą nadal używać `group:<id>`; kanał jest wnioskowany z `Provider` i normalizowany do kanonicznej postaci `agent:<agentId>:<channel>:group:<id>`.
- Inne źródła:
  - Zadania cron: `cron:<job.id>`
  - Webhooki: `hook:<uuid>` (o ile nie ustawiono jawnie przez hook)
  - Uruchomienia węzłów: `node-<nodeId>`

## Cykl życia

- Polityka resetu: sesje są ponownie używane do czasu wygaśnięcia, a wygaśnięcie jest oceniane przy następnym komunikacie przychodzącym.
- Dzienny reset: domyślnie **4:00 czasu lokalnego na hoście gateway**. Sesja jest przestarzała, gdy jej ostatnia aktualizacja jest wcześniejsza niż najnowszy czas dziennego resetu.
- Reset bezczynności (opcjonalny): `idleMinutes` dodaje przesuwne okno bezczynności. Gdy skonfigurowane są zarówno reset dzienny, jak i bezczynności, **wcześniejszy z nich** wymusza nową sesję.
- Starszy tryb tylko-bezczynność: jeśli ustawisz `session.idleMinutes` bez żadnej konfiguracji `session.reset`/`resetByType`, OpenClaw pozostaje w trybie tylko-bezczynności dla zgodności wstecznej.
- Nadpisania per-typ (opcjonalne): `resetByType` pozwala nadpisać politykę dla sesji `dm`, `group` i `thread` (wątki = wątki Slack/Discord, tematy Telegram, wątki Matrix, gdy dostarczone przez konektor).
- Nadpisania per-kanał (opcjonalne): `resetByChannel` nadpisuje politykę resetu dla kanału (dotyczy wszystkich typów sesji dla tego kanału i ma pierwszeństwo nad `reset`/`resetByType`).
- Wyzwalacze resetu: dokładne `/new` lub `/reset` (plus wszelkie dodatki w `resetTriggers`) rozpoczynają nowy identyfikator sesji i przekazują resztę wiadomości dalej. `/new <model>` akceptuje alias modelu, `provider/model` lub nazwę dostawcy (dopasowanie rozmyte), aby ustawić model nowej sesji. Jeśli `/new` lub `/reset` zostanie wysłane samodzielnie, OpenClaw uruchamia krótką turę powitalną „hello”, aby potwierdzić reset.
- Reset ręczny: usuń konkretne klucze z magazynu lub usuń transkrypt JSONL; następna wiadomość je odtworzy.
- Izolowane zadania cron zawsze tworzą nowy `sessionId` na uruchomienie (bez ponownego użycia bezczynności).

## Polityka wysyłania (opcjonalna)

Blokuj dostarczanie dla określonych typów sesji bez wypisywania pojedynczych identyfikatorów.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Nadpisanie w czasie działania (tylko właściciel):

- `/send on` → zezwól dla tej sesji
- `/send off` → odmów dla tej sesji
- `/send inherit` → wyczyść nadpisanie i użyj reguł konfiguracji
  Wyślij je jako samodzielne wiadomości, aby zostały zarejestrowane.

## Konfiguracja (opcjonalny przykład zmiany nazwy)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Inspekcja

- `openclaw status` — pokazuje ścieżkę magazynu i ostatnie sesje.
- `openclaw sessions --json` — zrzuca każdy wpis (filtruj za pomocą `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — pobiera sesje z działającego gateway (użyj `--url`/`--token` do zdalnego dostępu do gateway).
- Wyślij `/status` jako samodzielną wiadomość na czacie, aby sprawdzić, czy agent jest osiągalny, ile kontekstu sesji jest używane, bieżące przełączniki myślenia/trybu szczegółowego oraz kiedy ostatnio odświeżono poświadczenia WhatsApp web (pomaga wykryć potrzebę ponownego powiązania).
- Wyślij `/context list` lub `/context detail`, aby zobaczyć, co znajduje się w prompcie systemowym i wstrzykniętych plikach obszaru roboczego (oraz największych kontrybutorów kontekstu).
- Wyślij `/stop` jako samodzielną wiadomość, aby przerwać bieżące uruchomienie, wyczyścić kolejkę dalszych działań dla tej sesji i zatrzymać wszystkie uruchomienia podagentów z niej zainicjowane (odpowiedź zawiera liczbę zatrzymanych).
- Wyślij `/compact` (opcjonalne instrukcje) jako samodzielną wiadomość, aby podsumować starszy kontekst i zwolnić miejsce w oknie. Zobacz [/concepts/compaction](/concepts/compaction).
- Transkrypty JSONL można otworzyć bezpośrednio, aby przejrzeć pełne tury.

## Wskazówki

- Zachowaj klucz główny dedykowany ruchowi 1:1; pozwól grupom zachować własne klucze.
- Przy automatyzacji porządkowania usuwaj pojedyncze klucze zamiast całego magazynu, aby zachować kontekst w innych miejscach.

## Metadane pochodzenia sesji

Każdy wpis sesji rejestruje (w miarę możliwości) swoje pochodzenie w `origin`:

- `label`: etykieta czytelna dla człowieka (rozwiązana z etykiety rozmowy + tematu grupy/kanału)
- `provider`: znormalizowany identyfikator kanału (w tym rozszerzenia)
- `from`/`to`: surowe identyfikatory routingu z koperty przychodzącej
- `accountId`: identyfikator konta dostawcy (gdy wiele kont)
- `threadId`: identyfikator wątku/tematu, gdy kanał to obsługuje
  Pola pochodzenia są wypełniane dla wiadomości bezpośrednich, kanałów i grup. Jeśli
  konektor aktualizuje wyłącznie routing dostarczania (na przykład, aby utrzymać świeżość
  głównej sesji DM), nadal powinien dostarczyć kontekst przychodzący, aby sesja zachowała
  swoje metadane wyjaśniające. Rozszerzenia mogą to zrobić, wysyłając `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` i `SenderName` w kontekście
  przychodzącym oraz wywołując `recordSessionMetaFromInbound` (lub przekazując ten sam kontekst
  do `updateLastRoute`).

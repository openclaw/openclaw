---
summary: "Jak OpenClaw buduje kontekst promptu oraz raportuje użycie tokenów i koszty"
read_when:
  - Wyjaśnianie użycia tokenów, kosztów lub okien kontekstu
  - Debugowanie wzrostu kontekstu lub zachowania kompakcji
title: "Użycie tokenów i koszty"
---

# Użycie tokenów i koszty

OpenClaw śledzi **tokeny**, a nie znaki. Tokeny są zależne od modelu, ale większość
modeli w stylu OpenAI ma średnio ~4 znaki na token dla tekstu w języku angielskim.

## Jak budowany jest prompt systemowy

OpenClaw składa własny prompt systemowy przy każdym uruchomieniu. Zawiera on:

- Listę narzędzi + krótkie opisy
- Listę Skills (tylko metadane; instrukcje są ładowane na żądanie przez `read`)
- Instrukcje samodzielnej aktualizacji
- Obszar roboczy + pliki startowe (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` gdy są nowe). Duże pliki są obcinane przez `agents.defaults.bootstrapMaxChars` (domyślnie: 20000).
- Czas (UTC + strefa czasowa użytkownika)
- Tagi odpowiedzi + zachowanie heartbeat
- Metadane czasu wykonania (host/OS/model/thinking)

Pełne zestawienie znajdziesz w [System Prompt](/concepts/system-prompt).

## Co wlicza się do okna kontekstu

Wszystko, co otrzymuje model, wlicza się do limitu kontekstu:

- Prompt systemowy (wszystkie sekcje wymienione powyżej)
- Historia rozmowy (wiadomości użytkownika + asystenta)
- Wywołania narzędzi i wyniki narzędzi
- Załączniki/transkrypcje (obrazy, audio, pliki)
- Podsumowania kompakcji i artefakty przycinania
- Opakowania dostawcy lub nagłówki bezpieczeństwa (niewidoczne, ale nadal liczone)

Aby uzyskać praktyczne zestawienie (na wstrzyknięty plik, narzędzia, skills oraz rozmiar promptu systemowego), użyj `/context list` lub `/context detail`. Zobacz [Context](/concepts/context).

## Jak sprawdzić bieżące użycie tokenów

Użyj w czacie:

- `/status` → **karta stanu bogata w emoji** z modelem sesji, użyciem kontekstu,
  tokenami wejścia/wyjścia ostatniej odpowiedzi oraz **szacowanym kosztem** (tylko klucz API).
- `/usage off|tokens|full` → dołącza **stopkę użycia na odpowiedź** do każdej repliki.
  - Utrzymuje się per sesję (zapisywane jako `responseUsage`).
  - Uwierzytelnianie OAuth **ukrywa koszt** (tylko tokeny).
- `/usage cost` → pokazuje lokalne podsumowanie kosztów z logów sesji OpenClaw.

Inne interfejsy:

- **TUI/Web TUI:** obsługiwane są `/status` + `/usage`.
- **CLI:** `openclaw status --usage` oraz `openclaw channels list` pokazują
  okna limitów dostawcy (nie koszty per odpowiedź).

## Szacowanie kosztów (gdy wyświetlane)

Koszty są szacowane na podstawie konfiguracji cen Twojego modelu:

```
models.providers.<provider>.models[].cost
```

Są to **USD za 1 mln tokenów** dla `input`, `output`, `cacheRead` oraz
`cacheWrite`. Jeśli brakuje cennika, OpenClaw pokazuje tylko tokeny. Tokeny OAuth
nigdy nie pokazują kosztu w dolarach.

## TTL pamięci podręcznej i wpływ przycinania

Pamięć podręczna promptów dostawcy obowiązuje tylko w obrębie okna TTL cache. OpenClaw może
opcjonalnie uruchamiać **przycinanie cache-ttl**: przycina sesję po wygaśnięciu TTL cache,
a następnie resetuje okno cache, aby kolejne żądania mogły ponownie używać świeżo
zbuforowanego kontekstu zamiast ponownego buforowania całej historii. Dzięki temu
koszty zapisów do cache pozostają niższe, gdy sesja pozostaje bezczynna dłużej niż TTL.

Skonfiguruj to w [Gateway configuration](/gateway/configuration) i zobacz szczegóły
zachowania w [Session pruning](/concepts/session-pruning).

Heartbeat może utrzymywać cache **ciepły** pomiędzy okresami bezczynności. Jeśli TTL cache
Twojego modelu wynosi `1h`, ustawienie interwału heartbeat tuż poniżej tego
(np. `55m`) może zapobiec ponownemu buforowaniu pełnego promptu, redukując
koszty zapisów do cache.

W cenniku API Anthropic odczyty z cache są znacząco tańsze niż tokeny wejścia,
natomiast zapisy do cache są rozliczane z wyższym mnożnikiem. Aktualne stawki i
mnożniki TTL znajdziesz w dokumentacji Anthropic dotyczącej cache’owania promptów:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Przykład: utrzymanie ciepłej cache przez 1 h za pomocą heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Wskazówki dotyczące redukcji presji tokenów

- Użyj `/compact`, aby podsumować długie sesje.
- Przycinaj duże wyniki narzędzi w swoich przepływach pracy.
- Utrzymuj krótkie opisy skills (lista skills jest wstrzykiwana do promptu).
- Preferuj mniejsze modele do rozbudowanej, eksploracyjnej pracy.

Zobacz [Skills](/tools/skills), aby poznać dokładną formułę narzutu listy skills.

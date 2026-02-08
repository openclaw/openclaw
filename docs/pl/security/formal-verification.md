---
title: Weryfikacja formalna (modele bezpieczeństwa)
summary: Modele bezpieczeństwa weryfikowane maszynowo dla ścieżek najwyższego ryzyka w OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:51Z
---

# Weryfikacja formalna (modele bezpieczeństwa)

Ta strona śledzi **formalne modele bezpieczeństwa** OpenClaw (obecnie TLA+/TLC; w razie potrzeby kolejne).

> Uwaga: niektóre starsze linki mogą odnosić się do poprzedniej nazwy projektu.

**Cel (north star):** dostarczyć argument weryfikowany maszynowo, że OpenClaw egzekwuje
zamierzoną politykę bezpieczeństwa (autoryzację, izolację sesji, bramkowanie narzędzi oraz
bezpieczeństwo konfiguracji), przy jawnie określonych założeniach.

**Czym to jest (dziś):** wykonywalny, napędzany przez atakującego **pakiet regresji bezpieczeństwa**:

- Każde twierdzenie ma uruchamialne sprawdzenie modelu w skończonej przestrzeni stanów.
- Wiele twierdzeń ma sparowany **model negatywny**, który generuje ślad kontrprzykładu dla realistycznej klasy błędów.

**Czym to nie jest (jeszcze):** dowodem, że „OpenClaw jest bezpieczny pod każdym względem” ani że pełna implementacja TypeScript jest poprawna.

## Gdzie znajdują się modele

Modele są utrzymywane w osobnym repozytorium: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Ważne zastrzeżenia

- To są **modele**, a nie pełna implementacja TypeScript. Możliwe są rozbieżności między modelem a kodem.
- Wyniki są ograniczone przestrzenią stanów eksplorowaną przez TLC; „zielony” wynik nie implikuje bezpieczeństwa poza zamodelowanymi założeniami i granicami.
- Niektóre twierdzenia opierają się na jawnych założeniach środowiskowych (np. poprawne wdrożenie, poprawne dane wejściowe konfiguracji).

## Odtwarzanie wyników

Obecnie wyniki odtwarza się poprzez sklonowanie repozytorium modeli lokalnie i uruchomienie TLC (zob. poniżej). Przyszła iteracja może oferować:

- modele uruchamiane w CI z publicznymi artefaktami (ślady kontrprzykładów, logi uruchomień)
- hostowany przepływ pracy „uruchom ten model” dla małych, ograniczonych sprawdzeń

Pierwsze kroki:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Ekspozycja Gateway i błędna konfiguracja otwartego gateway

**Twierdzenie:** wiązanie poza loopback bez uwierzytelniania może umożliwić zdalne przejęcie / zwiększa ekspozycję; token/hasło blokuje nieuwierzytelnionych atakujących (zgodnie z założeniami modelu).

- Uruchomienia zielone:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Czerwone (oczekiwane):
  - `make gateway-exposure-v2-negative`

Zobacz także: `docs/gateway-exposure-matrix.md` w repozytorium modeli.

### Potok Nodes.run (zdolność najwyższego ryzyka)

**Twierdzenie:** `nodes.run` wymaga (a) listy dozwolonych poleceń węzła wraz z zadeklarowanymi poleceniami oraz (b) bieżącej akceptacji, gdy jest skonfigurowana; akceptacje są tokenizowane, aby zapobiec odtworzeniom (w modelu).

- Uruchomienia zielone:
  - `make nodes-pipeline`
  - `make approvals-token`
- Czerwone (oczekiwane):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Magazyn parowania (bramkowanie DM-ów)

**Twierdzenie:** żądania parowania respektują TTL oraz limity oczekujących żądań.

- Uruchomienia zielone:
  - `make pairing`
  - `make pairing-cap`
- Czerwone (oczekiwane):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Bramkowanie wejścia (wzmianki + obejście poleceń sterujących)

**Twierdzenie:** w kontekstach grupowych wymagających wzmianki nieautoryzowane „polecenie sterujące” nie może obejść bramkowania opartego na wzmiankach.

- Zielone:
  - `make ingress-gating`
- Czerwone (oczekiwane):
  - `make ingress-gating-negative`

### Izolacja routingu/kluczy sesji

**Twierdzenie:** DM-y od różnych nadawców nie zapadają się do tej samej sesji, o ile nie są jawnie połączone/skonfigurowane.

- Zielone:
  - `make routing-isolation`
- Czerwone (oczekiwane):
  - `make routing-isolation-negative`

## v1++: dodatkowe modele ograniczone (współbieżność, ponowienia, poprawność śladów)

Są to modele uzupełniające, które zwiększają wierność wobec rzeczywistych trybów awarii (nieatomowe aktualizacje, ponowienia i rozsył wiadomości).

### Współbieżność / idempotencja magazynu parowania

**Twierdzenie:** magazyn parowania powinien egzekwować `MaxPending` oraz idempotencję nawet przy przeplotach (tj. „sprawdź-then-zapisz” musi być atomowe / zablokowane; odświeżanie nie powinno tworzyć duplikatów).

Co to oznacza:

- Przy współbieżnych żądaniach nie można przekroczyć `MaxPending` dla kanału.
- Powtarzane żądania/odświeżenia dla tego samego `(channel, sender)` nie powinny tworzyć zduplikowanych, aktywnych wierszy oczekujących.

- Uruchomienia zielone:
  - `make pairing-race` (atomowe/zablokowane sprawdzenie limitu)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Czerwone (oczekiwane):
  - `make pairing-race-negative` (nieatomowy wyścig begin/commit limitu)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Korelacja śladów wejścia / idempotencja

**Twierdzenie:** ingestia powinna zachować korelację śladów przy rozsyłaniu oraz być idempotentna przy ponowieniach dostawcy.

Co to oznacza:

- Gdy jedno zdarzenie zewnętrzne staje się wieloma komunikatami wewnętrznymi, każda część zachowuje tę samą tożsamość śladu/zdarzenia.
- Ponowienia nie skutkują podwójnym przetwarzaniem.
- Jeśli identyfikatory zdarzeń dostawcy są nieobecne, deduplikacja przełącza się na bezpieczny klucz (np. identyfikator śladu), aby uniknąć odrzucania odrębnych zdarzeń.

- Zielone:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Czerwone (oczekiwane):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Pierwszeństwo dmScope routingu + identityLinks

**Twierdzenie:** routing musi domyślnie utrzymywać izolację sesji DM i zapadać sesje tylko wtedy, gdy jest to jawnie skonfigurowane (pierwszeństwo kanału + powiązania tożsamości).

Co to oznacza:

- Nadpisania dmScope specyficzne dla kanału muszą mieć pierwszeństwo przed globalnymi domyślnymi.
- identityLinks powinny zapadać sesje wyłącznie w ramach jawnie powiązanych grup, a nie między niepowiązanymi nadawcami.

- Zielone:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Czerwone (oczekiwane):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`

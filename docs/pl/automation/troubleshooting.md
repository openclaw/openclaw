---
summary: "Rozwiązywanie problemów z harmonogramem cron i harmonogramem oraz dostarczaniem heartbeat"
read_when:
  - Cron nie uruchomił się
  - Cron uruchomił się, ale nie dostarczono wiadomości
  - Heartbeat wydaje się milczeć lub być pomijany
title: "Rozwiązywanie problemów z automatyzacją"
---

# Rozwiązywanie problemów z automatyzacją

Użyj tej strony do problemów z harmonogramem i dostarczaniem (`cron` + `heartbeat`).

## Drabina poleceń

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Następnie uruchom kontrole automatyzacji:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron nie uruchamia się

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Poprawne wyjście wygląda następująco:

- `cron status` raportuje włączone oraz przyszłe `nextWakeAtMs`.
- Zadanie jest włączone i ma prawidłowy harmonogram/strefę czasową.
- `cron runs` pokazuje `ok` lub jawną przyczynę pominięcia.

Typowe sygnatury:

- `cron: scheduler disabled; jobs will not run automatically` → cron wyłączony w konfiguracji/zmiennych środowiskowych.
- `cron: timer tick failed` → tick harmonogramu uległ awarii; sprawdź otaczający kontekst stosu/logów.
- `reason: not-due` w wyjściu uruchomienia → ręczne uruchomienie wywołane bez `--force`, a zadanie nie jest jeszcze należne.

## Cron uruchomił się, ale brak dostarczenia

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Poprawne wyjście wygląda następująco:

- Status uruchomienia to `ok`.
- Tryb/cele dostarczania są ustawione dla zadań izolowanych.
- Sonda kanału raportuje, że docelowy kanał jest połączony.

Typowe sygnatury:

- Uruchomienie zakończyło się powodzeniem, ale tryb dostarczania to `none` → nie oczekuje się żadnej wiadomości zewnętrznej.
- Brakujący/nieprawidłowy cel dostarczania (`channel`/`to`) → uruchomienie może zakończyć się sukcesem wewnętrznie, ale pominąć wysyłkę.
- Błędy uwierzytelniania kanału (`unauthorized`, `missing_scope`, `Forbidden`) → dostarczanie zablokowane przez poświadczenia/uprawnienia kanału.

## Heartbeat stłumiony lub pominięty

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Poprawne wyjście wygląda następująco:

- Heartbeat włączony z niezerowym interwałem.
- Ostatni wynik heartbeat to `ran` (lub znana jest przyczyna pominięcia).

Typowe sygnatury:

- `heartbeat skipped` z `reason=quiet-hours` → poza `activeHours`.
- `requests-in-flight` → główny tor zajęty; heartbeat odroczony.
- `empty-heartbeat-file` → `HEARTBEAT.md` istnieje, ale nie ma treści możliwej do wykonania.
- `alerts-disabled` → ustawienia widoczności tłumią wychodzące wiadomości heartbeat.

## Pułapki strefy czasowej i activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Szybkie zasady:

- `Config path not found: agents.defaults.userTimezone` oznacza, że klucz nie jest ustawiony; heartbeat wraca do strefy czasowej hosta (lub `activeHours.timezone`, jeśli ustawione).
- Cron bez `--tz` używa strefy czasowej hosta gateway.
- Heartbeat `activeHours` używa skonfigurowanego rozwiązywania strefy czasowej (`user`, `local` lub jawna strefa IANA).
- Znaczniki czasu ISO bez strefy czasowej są traktowane jako UTC dla harmonogramów cron `at`.

Typowe sygnatury:

- Zadania uruchamiają się o niewłaściwej godzinie zegarowej po zmianach strefy czasowej hosta.
- Heartbeat jest zawsze pomijany w ciągu dnia, ponieważ `activeHours.timezone` jest nieprawidłowe.

Powiązane:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)

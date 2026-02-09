---
summary: "Referencja CLI dla `openclaw cron` (planowanie i uruchamianie zadań w tle)"
read_when:
  - Chcesz korzystać z zaplanowanych zadań i wybudzeń
  - Debugujesz wykonanie cron i logi
title: "cron"
---

# `openclaw cron`

Zarządzaj zadaniami cron dla harmonogramu Gateway.

Powiązane:

- Zadania cron: [Zadania cron](/automation/cron-jobs)

Wskazówka: uruchom `openclaw cron --help`, aby zobaczyć pełny zakres poleceń.

Uwaga: izolowane zadania `cron add` domyślnie używają dostarczania `--announce`. Użyj `--no-deliver`, aby zachować
wyjście jako wewnętrzne. `--deliver` pozostaje przestarzałym aliasem dla `--announce`.

Uwaga: zadania jednorazowe (`--at`) są domyślnie usuwane po powodzeniu. Użyj `--keep-after-run`, aby je zachować.

Uwaga: zadania cykliczne używają teraz wykładniczego opóźnienia ponownych prób po kolejnych błędach (30 s → 1 min → 5 min → 15 min → 60 min), a następnie wracają do normalnego harmonogramu po następnym udanym uruchomieniu.

## Wspólne edycje

Zaktualizuj ustawienia dostarczania bez zmiany wiadomości:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Wyłącz dostarczanie dla izolowanego zadania:

```bash
openclaw cron edit <job-id> --no-deliver
```

Ogłoś do określonego kanału:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

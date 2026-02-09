---
summary: "Flagi diagnostyczne do ukierunkowanych logów debugowania"
read_when:
  - Potrzebujesz ukierunkowanych logów debugowania bez podnoszenia globalnych poziomów logowania
  - Musisz zebrać logi specyficzne dla podsystemu na potrzeby wsparcia
title: "Flagi diagnostyczne"
---

# Flagi diagnostyczne

Flagi diagnostyczne umożliwiają włączenie ukierunkowanych logów debugowania bez włączania szczegółowego logowania wszędzie. Flagi są opcjonalne i nie mają wpływu, dopóki dany podsystem ich nie sprawdza.

## Jak to działa

- Flagi są ciągami znaków (wielkość liter jest różna).
- Flagi można włączyć w konfiguracji lub przez nadpisanie zmienną środowiskową.
- Obsługiwane są karty dzikie:
  - `telegram.*` dopasowuje `telegram.http`
  - `*` włącza wszystkie flagi

## Włącz przez konfigurację

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Wiele flag:

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

Po zmianie flag uruchom ponownie gateway (bramę).

## Zastąp Env (jednorazowy)

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Wyłącz wszystkie flagi:

```bash
OPENCLAW_DIAGNOSTICS=0
```

## Gdzie trafiają logi

Flagi zapisują logi do standardowego pliku logów diagnostycznych. Domyślnie:

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

Jeśli ustawisz `logging.file`, używany będzie ten adres. Logi są w formacie JSONL (jeden obiekt JSON na linię). Nadal obowiązuje redakcja na podstawie `logging.redactSensitive`.

## Wyodrębnianie logów

Wybierz najnowszy plik logu:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

Filtruj diagnostykę HTTP Telegrama:

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

Lub ogon podczas reprodukcji:

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

Dla zdalnych gatewayów (bram) możesz także użyć `openclaw logs --follow` (zobacz [/cli/logs](/cli/logs)).

## Uwagi

- Jeśli `logging.level` jest ustawione wyżej niż `warn`, te logi mogą być tłumione. Domyślne `info` jest odpowiednie.
- Flagi są bezpieczne do pozostawienia włączone; wpływają jedynie na wolumen logów dla konkretnego podsystemu.
- Użyj [/logging](/logging), aby zmienić miejsca docelowe logów, poziomy oraz redakcję.

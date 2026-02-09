---
summary: "Dokumentacja CLI dla `openclaw update` (względnie bezpieczna aktualizacja ze źródeł + automatyczny restart Gateway)"
read_when:
  - Chcesz bezpiecznie zaktualizować checkout ze źródeł
  - Musisz zrozumieć zachowanie skrótu `--update`
title: "update"
---

# `openclaw update`

Bezpiecznie aktualizuj OpenClaw i przełączaj się między kanałami stable/beta/dev.

Jeśli instalacja została wykonana przez **npm/pnpm** (instalacja globalna, bez metadanych gita), aktualizacje odbywają się przez mechanizm menedżera pakietów opisany w [Updating](/install/updating).

## Usage

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart`: pomija restart usługi Gateway po pomyślnej aktualizacji.
- `--channel <stable|beta|dev>`: ustawia kanał aktualizacji (git + npm; zapisywane w konfiguracji).
- `--tag <dist-tag|version>`: nadpisuje dist-tag npm lub wersję tylko dla tej aktualizacji.
- `--json`: drukuje czytelny maszynowo JSON `UpdateRunResult`.
- `--timeout <seconds>`: limit czasu na krok (domyślnie 1200 s).

Uwaga: obniżanie wersji wymaga potwierdzenia, ponieważ starsze wersje mogą uszkodzić konfigurację.

## `update status`

Wyświetla aktywny kanał aktualizacji + tag/gałąź/SHA gita (dla checkoutów ze źródeł) oraz dostępność aktualizacji.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Opcje:

- `--json`: drukuje czytelny maszynowo JSON statusu.
- `--timeout <seconds>`: limit czasu na sprawdzenia (domyślnie 3 s).

## `update wizard`

Interaktywny przepływ umożliwiający wybór kanału aktualizacji i potwierdzenie, czy po aktualizacji zrestartować Gateway
(domyślnie następuje restart). Jeśli wybierzesz `dev` bez checkoutu gita,
zostanie zaproponowane jego utworzenie.

## What it does

Gdy jawnie przełączasz kanały (`--channel ...`), OpenClaw utrzymuje również spójność
metody instalacji:

- `dev` → zapewnia checkout gita (domyślnie: `~/openclaw`, nadpisanie przez `OPENCLAW_GIT_DIR`),
  aktualizuje go i instaluje globalne CLI z tego checkoutu.
- `stable`/`beta` → instaluje z npm, używając pasującego dist-tagu.

## Git checkout flow

Kanały:

- `stable`: checkout najnowszego taga niebędącego beta, następnie build + doctor.
- `beta`: checkout najnowszego taga `-beta`, następnie build + doctor.
- `dev`: checkout `main`, następnie fetch + rebase.

Wysoki poziom:

1. Wymaga czystego drzewa roboczego (brak niezacommitowanych zmian).
2. Przełącza na wybrany kanał (tag lub gałąź).
3. Pobiera zmiany z upstream (tylko dev).
4. Tylko dev: wstępne lintowanie + build TypeScript w tymczasowym worktree; jeśli czubek nie przechodzi, cofa się do 10 commitów, aby znaleźć najnowszy czysty build.
5. Rebase na wybrany commit (tylko dev).
6. Instaluje zależności (preferowane pnpm; fallback npm).
7. Buduje oraz buduje Control UI.
8. Uruchamia `openclaw doctor` jako końcową kontrolę „bezpiecznej aktualizacji”.
9. Synchronizuje wtyczki z aktywnym kanałem (dev używa dołączonych rozszerzeń; stable/beta używa npm) i aktualizuje wtyczki zainstalowane przez npm.

## Skrót `--update`

`openclaw --update` jest przepisywane na `openclaw update` (przydatne dla powłok i skryptów uruchamiających).

## See also

- `openclaw doctor` (oferuje uruchomienie aktualizacji najpierw dla checkoutów gita)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)

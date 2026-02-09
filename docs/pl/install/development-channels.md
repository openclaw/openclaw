---
summary: "Kanały stable, beta i dev: semantyka, przełączanie i tagowanie"
read_when:
  - Chcesz przełączać się między stable/beta/dev
  - Tagujesz lub publikujesz wydania prerelease
title: "Kanały rozwojowe"
---

# Kanały rozwojowe

Ostatnia aktualizacja: 2026-01-21

OpenClaw udostępnia trzy kanały aktualizacji:

- **stable**: npm dist-tag `latest`.
- **beta**: npm dist-tag `beta` (buildy w trakcie testów).
- **dev**: ruchomy head `main` (git). npm dist-tag: `dev` (gdy opublikowane).

Wysyłamy buildy do **beta**, testujemy je, a następnie **promujemy zweryfikowany build do `latest`**
bez zmiany numeru wersji — dist-tagi są źródłem prawdy dla instalacji npm.

## Przełączanie kanałów

Git checkout:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` pobiera najnowszy pasujący tag (często ten sam tag).
- `dev` przełącza na `main` i wykonuje rebase na upstreamie.

Instalacja globalna npm/pnpm:

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Aktualizacja następuje przez odpowiadający npm dist-tag (`latest`, `beta`, `dev`).

Gdy **jawnie** przełączysz kanał za pomocą `--channel`, OpenClaw dodatkowo dopasowuje
metodę instalacji:

- `dev` zapewnia checkout git (domyślnie `~/openclaw`, nadpisanie przez `OPENCLAW_GIT_DIR`),
  aktualizuje go i instaluje globalne CLI z tego checkoutu.
- `stable`/`beta` instaluje z npm, używając pasującego dist-tagu.

Wskazówka: jeśli chcesz mieć stable + dev równolegle, utrzymuj dwa klony i skieruj gateway na stabilny.

## Wtyczki i kanały

Gdy przełączasz kanały za pomocą `openclaw update`, OpenClaw synchronizuje również źródła wtyczek:

- `dev` preferuje dołączone wtyczki z checkoutu git.
- `stable` oraz `beta` przywracają pakiety wtyczek zainstalowane przez npm.

## Najlepsze praktyki tagowania

- Taguj wydania, na których mają lądować checkouty git (`vYYYY.M.D` lub `vYYYY.M.D-<patch>`).
- Utrzymuj niezmienność tagów: nigdy nie przesuwaj ani nie używaj ponownie taga.
- npm dist-tagi pozostają źródłem prawdy dla instalacji npm:
  - `latest` → stable
  - `beta` → build kandydujący
  - `dev` → snapshot main (opcjonalnie)

## Dostępność aplikacji na macOS

Buildy beta i dev **mogą nie** zawierać wydania aplikacji na macOS. To w porządku:

- Tag git i npm dist-tag nadal mogą zostać opublikowane.
- W notatkach do wydania lub changelogu zaznacz „brak buildu macOS dla tej bety”.

---
summary: "„Przewodnik po ClawHub: publiczny rejestr Skills + przepływy pracy CLI”"
read_when:
  - Wprowadzanie ClawHub dla nowych użytkowników
  - Instalowanie, wyszukiwanie lub publikowanie Skills
  - Wyjaśnianie flag CLI ClawHub i zachowania synchronizacji
title: "ClawHub"
---

# ClawHub

ClawHub to **publiczny rejestr Skills dla OpenClaw**. Jest to bezpłatna usługa: wszystkie Skills są publiczne, otwarte i widoczne dla wszystkich do udostępniania i ponownego użycia. Skill to po prostu folder z plikiem `SKILL.md` (oraz wspierającymi plikami tekstowymi). Możesz przeglądać Skills w aplikacji webowej lub używać CLI do wyszukiwania, instalowania, aktualizowania i publikowania Skills.

Strona: [clawhub.ai](https://clawhub.ai)

## Czym jest ClawHub

- Publiczny rejestr Skills dla OpenClaw.
- Wersjonowany magazyn pakietów Skills i metadanych.
- Powierzchnia odkrywania oparta na wyszukiwaniu, tagach i sygnałach użycia.

## Jak to działa

1. Użytkownik publikuje pakiet Skill (pliki + metadane).
2. ClawHub przechowuje pakiet, parsuje metadane i przypisuje wersję.
3. Rejestr indeksuje Skill do wyszukiwania i odkrywania.
4. Użytkownicy przeglądają, pobierają i instalują Skills w OpenClaw.

## Co możesz zrobić

- Publikować nowe Skills oraz nowe wersje istniejących Skills.
- Odkrywać Skills według nazwy, tagów lub wyszukiwania.
- Pobierać pakiety Skills i przeglądać ich pliki.
- Zgłaszać Skills, które są nadużywające lub niebezpieczne.
- Jeśli jesteś moderatorem, ukrywać, odkrywać, usuwać lub banować.

## Dla kogo to jest (przyjazne dla początkujących)

Jeśli chcesz dodać nowe możliwości do swojego agenta OpenClaw, ClawHub jest najprostszym sposobem na znalezienie i zainstalowanie Skills. Nie musisz wiedzieć, jak działa backend. Możesz:

- Wyszukiwać Skills prostym językiem.
- Instalować Skill w swoim obszarze roboczym.
- Aktualizować Skills później jednym poleceniem.
- Tworzyć kopie zapasowe własnych Skills, publikując je.

## Szybki start (nietechniczny)

1. Zainstaluj CLI (zobacz następną sekcję).
2. Wyszukaj to, czego potrzebujesz:
   - `clawhub search "calendar"`
3. Zainstaluj Skill:
   - `clawhub install <skill-slug>`
4. Uruchom nową sesję OpenClaw, aby wczytała nowy Skill.

## Instalacja CLI

Wybierz jedną opcję:

```bash
npm i -g clawhub
```

```bash
pnpm add -g clawhub
```

## Jak to pasuje do OpenClaw

Domyślnie CLI instaluje Skills do `./skills` w bieżącym katalogu roboczym. Jeśli skonfigurowano obszar roboczy OpenClaw, `clawhub` przełącza się na ten obszar roboczy, chyba że nadpiszesz `--workdir` (lub `CLAWHUB_WORKDIR`). OpenClaw ładuje Skills obszaru roboczego z `<workspace>/skills` i wczyta je w **następnej** sesji. Jeśli używasz już `~/.openclaw/skills` lub Skills dołączonych, Skills obszaru roboczego mają pierwszeństwo.

Więcej szczegółów na temat ładowania, udostępniania i ograniczania Skills znajdziesz w
[Skills](/tools/skills).

## Przegląd systemu Skills

Skill to wersjonowany pakiet plików, który uczy OpenClaw wykonywania
konkretnego zadania. Każda publikacja tworzy nową wersję, a rejestr zachowuje
historię wersji, aby użytkownicy mogli audytować zmiany.

Typowy Skill zawiera:

- Plik `SKILL.md` z podstawowym opisem i sposobem użycia.
- Opcjonalne konfiguracje, skrypty lub pliki pomocnicze używane przez Skill.
- Metadane, takie jak tagi, podsumowanie i wymagania instalacyjne.

ClawHub wykorzystuje metadane do zasilania mechanizmów odkrywania i bezpiecznego
udostępniania możliwości Skills.
Rejestr śledzi także sygnały użycia (takie jak
gwiazdki i pobrania), aby poprawić ranking i widoczność.

## Co zapewnia usługa (funkcje)

- **Publiczne przeglądanie** Skills i ich zawartości `SKILL.md`.
- **Wyszukiwanie** oparte na embeddingach (wyszukiwanie wektorowe), a nie tylko słowach kluczowych.
- **Wersjonowanie** z semver, dziennikami zmian i tagami (w tym `latest`).
- **Pobrania** jako zip dla każdej wersji.
- **Gwiazdki i komentarze** dla opinii społeczności.
- **Moderacja**: mechanizmy zatwierdzania i audytu.
- **API przyjazne dla CLI** do automatyzacji i skryptów.

## Bezpieczeństwo i moderacja

ClawHub jest domyślnie otwarty. Każdy może przesyłać Skills, jednak konto GitHub
musi mieć co najmniej tydzień, aby publikować. Pomaga to spowalniać nadużycia bez
blokowania legalnych współtwórców.

Zgłaszanie i moderacja:

- Każdy zalogowany użytkownik może zgłosić Skill.
- Powody zgłoszeń są wymagane i rejestrowane.
- Każdy użytkownik może mieć jednocześnie do 20 aktywnych zgłoszeń.
- Skills z więcej niż 3 unikalnymi zgłoszeniami są domyślnie automatycznie ukrywane.
- Moderatorzy mogą przeglądać ukryte Skills, odkrywać je, usuwać lub banować użytkowników.
- Nadużywanie funkcji zgłaszania może skutkować banem konta.

Chcesz zostać moderatorem? Zapytaj na Discordzie OpenClaw i skontaktuj się z
moderatorem lub opiekunem projektu.

## Polecenia i parametry CLI

Opcje globalne (dotyczą wszystkich poleceń):

- `--workdir <dir>`: Katalog roboczy (domyślnie: bieżący katalog; przełącza się na obszar roboczy OpenClaw).
- `--dir <dir>`: Katalog Skills, względny do katalogu roboczego (domyślnie: `skills`).
- `--site <url>`: Bazowy URL strony (logowanie w przeglądarce).
- `--registry <url>`: Bazowy URL API rejestru.
- `--no-input`: Wyłącz monity (tryb nieinteraktywny).
- `-V, --cli-version`: Wyświetl wersję CLI.

Uwierzytelnianie:

- `clawhub login` (przepływ przeglądarkowy) lub `clawhub login --token <token>`
- `clawhub logout`
- `clawhub whoami`

Opcje:

- `--token <token>`: Wklej token API.
- `--label <label>`: Etykieta zapisywana dla tokenów logowania w przeglądarce (domyślnie: `CLI token`).
- `--no-browser`: Nie otwieraj przeglądarki (wymaga `--token`).

Wyszukiwanie:

- `clawhub search "query"`
- `--limit <n>`: Maksymalna liczba wyników.

Instalacja:

- `clawhub install <slug>`
- `--version <version>`: Zainstaluj określoną wersję.
- `--force`: Nadpisz, jeśli folder już istnieje.

Aktualizacja:

- `clawhub update <slug>`
- `clawhub update --all`
- `--version <version>`: Zaktualizuj do określonej wersji (tylko pojedynczy slug).
- `--force`: Nadpisz, gdy pliki lokalne nie pasują do żadnej opublikowanej wersji.

Lista:

- `clawhub list` (odczytuje `.clawhub/lock.json`)

Publikacja:

- `clawhub publish <path>`
- `--slug <slug>`: Slug Skill.
- `--name <name>`: Nazwa wyświetlana.
- `--version <version>`: Wersja semver.
- `--changelog <text>`: Tekst dziennika zmian (może być pusty).
- `--tags <tags>`: Tagi oddzielone przecinkami (domyślnie: `latest`).

Usuwanie/odwracanie usunięcia (tylko właściciel/admin):

- `clawhub delete <slug> --yes`
- `clawhub undelete <slug> --yes`

Synchronizacja (skanowanie lokalnych Skills + publikowanie nowych/zaktualizowanych):

- `clawhub sync`
- `--root <dir...>`: Dodatkowe katalogi skanowania.
- `--all`: Prześlij wszystko bez monitów.
- `--dry-run`: Pokaż, co zostałoby przesłane.
- `--bump <type>`: `patch|minor|major` dla aktualizacji (domyślnie: `patch`).
- `--changelog <text>`: Dziennik zmian dla aktualizacji nieinteraktywnych.
- `--tags <tags>`: Tagi oddzielone przecinkami (domyślnie: `latest`).
- `--concurrency <n>`: Kontrole rejestru (domyślnie: 4).

## Typowe przepływy pracy dla agentów

### Wyszukiwanie Skills

```bash
clawhub search "postgres backups"
```

### Pobieranie nowych Skills

```bash
clawhub install my-skill-pack
```

### Aktualizowanie zainstalowanych Skills

```bash
clawhub update --all
```

### Tworzenie kopii zapasowych Skills (publikacja lub synchronizacja)

Dla pojedynczego folderu Skill:

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.0.0 --tags latest
```

Aby zeskanować i wykonać kopię zapasową wielu Skills jednocześnie:

```bash
clawhub sync --all
```

## Szczegóły zaawansowane (techniczne)

### Wersjonowanie i tagi

- Każda publikacja tworzy nową **semver** `SkillVersion`.
- Tagi (takie jak `latest`) wskazują na wersję; przenoszenie tagów pozwala na cofanie zmian.
- Dzienniki zmian są przypisane do każdej wersji i mogą być puste podczas synchronizacji lub publikowania aktualizacji.

### Zmiany lokalne a wersje w rejestrze

Aktualizacje porównują lokalną zawartość Skill z wersjami w rejestrze przy użyciu skrótu treści. Jeśli pliki lokalne nie pasują do żadnej opublikowanej wersji, CLI pyta przed nadpisaniem (lub wymaga `--force` w trybie nieinteraktywnym).

### Skanowanie synchronizacji i zapasowe katalogi

`clawhub sync` najpierw skanuje bieżący katalog roboczy. Jeśli nie zostaną znalezione Skills, przełącza się na znane lokalizacje starszych instalacji (na przykład `~/openclaw/skills` i `~/.openclaw/skills`). Ma to na celu odnalezienie starszych instalacji Skills bez dodatkowych flag.

### Przechowywanie i plik blokady

- Zainstalowane Skills są rejestrowane w `.clawhub/lock.json` w katalogu roboczym.
- Tokeny uwierzytelniania są przechowywane w pliku konfiguracji CLI ClawHub (nadpisanie przez `CLAWHUB_CONFIG_PATH`).

### Telemetria (liczniki instalacji)

Gdy uruchamiasz `clawhub sync` będąc zalogowanym, CLI wysyła minimalny zrzut do obliczania liczników instalacji. Możesz to całkowicie wyłączyć:

```bash
export CLAWHUB_DISABLE_TELEMETRY=1
```

## Zmienne środowiskowe

- `CLAWHUB_SITE`: Nadpisz URL strony.
- `CLAWHUB_REGISTRY`: Nadpisz URL API rejestru.
- `CLAWHUB_CONFIG_PATH`: Nadpisz miejsce przechowywania tokenu/konfiguracji przez CLI.
- `CLAWHUB_WORKDIR`: Nadpisz domyślny katalog roboczy.
- `CLAWHUB_DISABLE_TELEMETRY=1`: Wyłącz telemetrię dla `sync`.

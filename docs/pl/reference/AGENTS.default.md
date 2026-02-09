---
summary: "Domyślne instrukcje agenta OpenClaw oraz lista Skills dla konfiguracji osobistego asystenta"
read_when:
  - Rozpoczynanie nowej sesji agenta OpenClaw
  - Włączanie lub audyt domyślnych Skills
---

# AGENTS.md — Osobisty Asystent OpenClaw (domyślny)

## Pierwsze uruchomienie (zalecane)

OpenClaw używa dedykowanego katalogu obszaru roboczego dla agenta. Domyślnie: `~/.openclaw/workspace` (konfigurowalne przez `agents.defaults.workspace`).

1. Utwórz obszar roboczy (jeśli jeszcze nie istnieje):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Skopiuj domyślne szablony obszaru roboczego do obszaru roboczego:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Opcjonalnie: jeśli chcesz listę Skills osobistego asystenta, zastąp AGENTS.md tym plikiem:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Opcjonalnie: wybierz inny obszar roboczy, ustawiając `agents.defaults.workspace` (obsługuje `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Domyślne zasady bezpieczeństwa

- Nie zrzucaj katalogów ani sekretów do czatu.
- Nie uruchamiaj destrukcyjnych poleceń, chyba że wyraźnie o to poproszono.
- Nie wysyłaj częściowych/strumieniowych odpowiedzi do zewnętrznych powierzchni komunikacyjnych (tylko odpowiedzi końcowe).

## Start sesji (wymagane)

- Przeczytaj `SOUL.md`, `USER.md`, `memory.md` oraz dziś+wczoraj w `memory/`.
- Zrób to przed udzieleniem odpowiedzi.

## Dusza (wymagane)

- `SOUL.md` definiuje tożsamość, ton i granice. Utrzymuj je na bieżąco.
- Jeśli zmienisz `SOUL.md`, poinformuj użytkownika.
- W każdej sesji jesteś świeżą instancją; ciągłość znajduje się w tych plikach.

## Przestrzenie współdzielone (zalecane)

- Nie jesteś głosem użytkownika; zachowuj ostrożność na czatach grupowych lub kanałach publicznych.
- Nie udostępniaj danych prywatnych, informacji kontaktowych ani notatek wewnętrznych.

## System pamięci (zalecane)

- Dziennik dzienny: `memory/YYYY-MM-DD.md` (utwórz `memory/`, jeśli to konieczne).
- Pamięć długoterminowa: `memory.md` dla trwałych faktów, preferencji i decyzji.
- Na starcie sesji przeczytaj dziś + wczoraj + `memory.md`, jeśli istnieje.
- Rejestruj: decyzje, preferencje, ograniczenia, otwarte pętle.
- Unikaj sekretów, chyba że wyraźnie o to poproszono.

## Narzędzia i Skills

- Narzędzia znajdują się w Skills; stosuj się do `SKILL.md` każdej Skills, gdy jej potrzebujesz.
- Notatki specyficzne dla środowiska przechowuj w `TOOLS.md` (Notes for Skills).

## Wskazówka dotycząca kopii zapasowych (zalecane)

Jeśli traktujesz ten obszar roboczy jako „pamięć” Clawda, zrób z niego repozytorium git (najlepiej prywatne), aby `AGENTS.md` oraz Twoje pliki pamięci były objęte kopią zapasową.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## Co robi OpenClaw

- Uruchamia gateway WhatsApp + agenta kodowania Pi, dzięki czemu asystent może czytać/pisać czaty, pobierać kontekst i uruchamiać Skills przez host Mac.
- Aplikacja na macOS zarządza uprawnieniami (nagrywanie ekranu, powiadomienia, mikrofon) i udostępnia CLI `openclaw` poprzez dołączony plik binarny.
- Czaty bezpośrednie domyślnie łączą się w sesję `main` agenta; grupy pozostają odizolowane jako `agent:<agentId>:<channel>:group:<id>` (pokoje/kanały: `agent:<agentId>:<channel>:channel:<id>`); sygnały heartbeat utrzymują zadania w tle przy życiu.

## Podstawowe Skills (włącz w Settings → Skills)

- **mcporter** — Środowisko uruchomieniowe/CLI serwera narzędzi do zarządzania zewnętrznymi backendami Skills.
- **Peekaboo** — Szybkie zrzuty ekranu macOS z opcjonalną analizą wizji AI.
- **camsnap** — Przechwytywanie klatek, klipów lub alertów ruchu z kamer bezpieczeństwa RTSP/ONVIF.
- **oracle** — Gotowy na OpenAI agent CLI z odtwarzaniem sesji i kontrolą przeglądarki.
- **eightctl** — Kontrola snu z poziomu terminala.
- **imsg** — Wysyłanie, odczyt i strumieniowanie iMessage oraz SMS.
- **wacli** — CLI WhatsApp: synchronizacja, wyszukiwanie, wysyłanie.
- **discord** — Akcje Discord: reakcje, naklejki, ankiety. Używaj celów `user:<id>` lub `channel:<id>` (same numeryczne identyfikatory są niejednoznaczne).
- **gog** — CLI Google Suite: Gmail, Kalendarz, Drive, Kontakty.
- **spotify-player** — Terminalowy klient Spotify do wyszukiwania/kolejkowania/kontroli odtwarzania.
- **sag** — Mowa ElevenLabs z UX w stylu mac; domyślnie strumieniuje do głośników.
- **Sonos CLI** — Sterowanie głośnikami Sonos (wykrywanie/status/odtwarzanie/głośność/grupowanie) ze skryptów.
- **blucli** — Odtwarzanie, grupowanie i automatyzacja odtwarzaczy BluOS ze skryptów.
- **OpenHue CLI** — Sterowanie oświetleniem Philips Hue dla scen i automatyzacji.
- **OpenAI Whisper** — Lokalna transkrypcja mowy na tekst do szybkiego dyktowania i transkryptów poczty głosowej.
- **Gemini CLI** — Modele Google Gemini z terminala do szybkich pytań i odpowiedzi.
- **agent-tools** — Zestaw narzędzi użytkowych do automatyzacji i skryptów pomocniczych.

## Uwagi dotyczące użycia

- Do skryptów preferuj CLI `openclaw`; aplikacja macOS obsługuje uprawnienia.
- Instalacje uruchamiaj z karty Skills; przycisk jest ukryty, jeśli plik binarny jest już obecny.
- Utrzymuj włączone sygnały heartbeat, aby asystent mógł planować przypomnienia, monitorować skrzynki odbiorcze i wyzwalać przechwytywanie z kamer.
- Interfejs Canvas działa w trybie pełnoekranowym z natywnymi nakładkami. Unikaj umieszczania krytycznych elementów sterujących w górnym lewym/górnym prawym/dolnym obszarze; dodaj jawne marginesy w układzie i nie polegaj na insetach bezpiecznego obszaru.
- Do weryfikacji sterowanej przeglądarką używaj `openclaw browser` (karty/status/zrzut ekranu) z profilem Chrome zarządzanym przez OpenClaw.
- Do inspekcji DOM używaj `openclaw browser eval|query|dom|snapshot` (oraz `--json`/`--out`, gdy potrzebujesz wyjścia maszynowego).
- Do interakcji używaj `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (kliknięcie/pisanie wymaga odwołań do zrzutów; do selektorów CSS używaj `evaluate`).

---
summary: "Terminalowy interfejs użytkownika (TUI): połącz się z Gateway z dowolnej maszyny"
read_when:
  - Chcesz przyjaznego dla początkujących wprowadzenia do TUI
  - Potrzebujesz kompletnej listy funkcji, poleceń i skrótów TUI
title: "TUI"
---

# TUI (Terminal UI)

## Szybki start

1. Uruchom Gateway.

```bash
openclaw gateway
```

2. Otwórz TUI.

```bash
openclaw tui
```

3. Wpisz wiadomość i naciśnij Enter.

Zdalny Gateway:

```bash
openclaw tui --url ws://<host>:<port> --token <gateway-token>
```

Użyj `--password`, jeśli Twój Gateway korzysta z uwierzytelniania hasłem.

## Co widzisz

- Nagłówek: URL połączenia, bieżący agent, bieżąca sesja.
- Dziennik czatu: wiadomości użytkownika, odpowiedzi asystenta, komunikaty systemowe, karty narzędzi.
- Linia stanu: stan połączenia/uruchomienia (łączenie, uruchomione, strumieniowanie, bezczynne, błąd).
- Stopka: stan połączenia + agent + sesja + model + think/verbose/reasoning + liczniki tokenów + dostarczanie.
- Wejście: edytor tekstu z autouzupełnianiem.

## Model mentalny: agenci + sesje

- Agenci to unikalne identyfikatory (np. `main`, `research`). Gateway udostępnia ich listę.
- Sesje należą do bieżącego agenta.
- Klucze sesji są przechowywane jako `agent:<agentId>:<sessionKey>`.
  - Jeśli wpiszesz `/session main`, TUI rozwinie to do `agent:<currentAgent>:main`.
  - Jeśli wpiszesz `/session agent:other:main`, przełączysz się jawnie na sesję tego agenta.
- Zakres sesji:
  - `per-sender` (domyślnie): każdy agent ma wiele sesji.
  - `global`: TUI zawsze używa sesji `global` (selektor może być pusty).
- Bieżący agent + sesja są zawsze widoczne w stopce.

## Wysyłanie + dostarczanie

- Wiadomości są wysyłane do Gateway; dostarczanie do dostawców jest domyślnie wyłączone.
- Włącz dostarczanie:
  - `/deliver on`
  - lub w panelu Ustawienia
  - albo uruchom z `openclaw tui --deliver`

## Selektory + nakładki

- Selektor modelu: lista dostępnych modeli i ustawienie nadpisania sesji.
- Selektor agenta: wybór innego agenta.
- Selektor sesji: pokazuje tylko sesje dla bieżącego agenta.
- Ustawienia: przełączanie dostarczania, rozwijania wyjścia narzędzi oraz widoczności „thinking”.

## Skróty klawiaturowe

- Enter: wyślij wiadomość
- Esc: przerwij aktywne uruchomienie
- Ctrl+C: wyczyść wejście (naciśnij dwa razy, aby wyjść)
- Ctrl+D: wyjście
- Ctrl+L: selektor modelu
- Ctrl+G: selektor agenta
- Ctrl+P: selektor sesji
- Ctrl+O: przełącz rozwijanie wyjścia narzędzi
- Ctrl+T: przełącz widoczność „thinking” (przeładowuje historię)

## Polecenia ukośnikowe

Podstawowe:

- `/help`
- `/status`
- `/agent <id>` (lub `/agents`)
- `/session <key>` (lub `/sessions`)
- `/model <provider/model>` (lub `/models`)

Sterowanie sesją:

- `/think <off|minimal|low|medium|high>`
- `/verbose <on|full|off>`
- `/reasoning <on|off|stream>`
- `/usage <off|tokens|full>`
- `/elevated <on|off|ask|full>` (alias: `/elev`)
- `/activation <mention|always>`
- `/deliver <on|off>`

Cykl życia sesji:

- `/new` lub `/reset` (reset sesji)
- `/abort` (przerwij aktywne uruchomienie)
- `/settings`
- `/exit`

Inne polecenia ukośnikowe Gateway (na przykład `/context`) są przekazywane do Gateway i pokazywane jako wyjście systemowe. Zobacz [Polecenia ukośnikowe](/tools/slash-commands).

## Lokalne polecenia powłoki

- Poprzedź linię `!`, aby uruchomić lokalne polecenie powłoki na hoście TUI.
- TUI pyta raz na sesję o zgodę na lokalne wykonanie; odmowa pozostawia `!` wyłączone dla sesji.
- Polecenia są uruchamiane w świeżej, nieinteraktywnej powłoce w katalogu roboczym TUI (bez trwałych `cd`/env).
- Samotne `!` jest wysyłane jako zwykła wiadomość; wiodące spacje nie uruchamiają lokalnego wykonania.

## Wyjście narzędzi

- Wywołania narzędzi są pokazywane jako karty z argumentami i wynikami.
- Ctrl+O przełącza widok zwinięty/rozwinięty.
- Podczas działania narzędzi częściowe aktualizacje są strumieniowane do tej samej karty.

## Historia + strumieniowanie

- Po połączeniu TUI ładuje najnowszą historię (domyślnie 200 wiadomości).
- Odpowiedzi strumieniowane aktualizują się w miejscu aż do finalizacji.
- TUI nasłuchuje także zdarzeń narzędzi agenta, aby prezentować bogatsze karty narzędzi.

## Szczegóły połączenia

- TUI rejestruje się w Gateway jako `mode: "tui"`.
- Ponowne połączenia wyświetlają komunikat systemowy; luki zdarzeń są ujawniane w dzienniku.

## Opcje

- `--url <url>`: URL WebSocket Gateway (domyślnie z konfiguracji lub `ws://127.0.0.1:<port>`)
- `--token <token>`: token Gateway (jeśli wymagany)
- `--password <password>`: hasło Gateway (jeśli wymagane)
- `--session <key>`: klucz sesji (domyślnie: `main` lub `global` przy zakresie globalnym)
- `--deliver`: dostarczaj odpowiedzi asystenta do dostawcy (domyślnie wyłączone)
- `--thinking <level>`: nadpisanie poziomu „thinking” dla wysyłek
- `--timeout-ms <ms>`: limit czasu agenta w ms (domyślnie `agents.defaults.timeoutSeconds`)

Uwaga: gdy ustawisz `--url`, TUI nie korzysta z zapasowych poświadczeń z konfiguracji ani środowiska.
Przekaż jawnie `--token` lub `--password`. Brak jawnych poświadczeń jest błędem.

## Rozwiązywanie problemów

Brak wyjścia po wysłaniu wiadomości:

- Uruchom `/status` w TUI, aby potwierdzić, że Gateway jest połączony i bezczynny/zajęty.
- Sprawdź logi Gateway: `openclaw logs --follow`.
- Potwierdź, że agent może działać: `openclaw status` i `openclaw models status`.
- Jeśli oczekujesz wiadomości w kanale czatu, włącz dostarczanie (`/deliver on` lub `--deliver`).
- `--history-limit <n>`: liczba wpisów historii do wczytania (domyślnie 200)

## Rozwiązywanie problemów z połączeniem

- `disconnected`: upewnij się, że Gateway działa i że Twoje `--url/--token/--password` są poprawne.
- Brak agentów w selektorze: sprawdź `openclaw agents list` i konfigurację routingu.
- Pusty selektor sesji: możesz być w zakresie globalnym lub nie mieć jeszcze żadnych sesji.

---
summary: "Polecenia slash: tekstowe vs natywne, konfiguracja i obsługiwane polecenia"
read_when:
  - Korzystanie z poleceń czatu lub ich konfiguracja
  - Debugowanie routingu poleceń lub uprawnień
title: "Polecenia slash"
---

# Polecenia slash

Polecenia są obsługiwane przez Gateway. Większość poleceń musi być wysyłana jako **samodzielna** wiadomość zaczynająca się od `/`.
Polecenie czatu bash dostępne tylko dla hosta używa `! <cmd>` (z `/bash <cmd>` jako aliasem).

Istnieją dwa powiązane systemy:

- **Polecenia**: samodzielne wiadomości `/...`.
- **Dyrektywy**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Dyrektywy są usuwane z wiadomości, zanim zobaczy ją model.
  - W zwykłych wiadomościach czatu (nie tylko dyrektywach) są traktowane jako „wskazówki inline” i **nie** utrwalają ustawień sesji.
  - W wiadomościach zawierających wyłącznie dyrektywy utrwalają się w sesji i zwracają potwierdzenie.
  - Dyrektywy są stosowane wyłącznie dla **autoryzowanych nadawców** (listy dozwolonych kanałów/parowanie plus `commands.useAccessGroups`).
    Nieautoryzowani nadawcy widzą dyrektywy traktowane jako zwykły tekst.

Istnieje także kilka **skrótów inline** (tylko dla nadawców z listy dozwolonych/autoryzowanych): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Uruchamiają się natychmiast, są usuwane zanim model zobaczy wiadomość, a pozostały tekst przechodzi dalej normalnym tokiem.

## Konfiguracja

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (domyślnie `true`) włącza parsowanie `/...` w wiadomościach czatu.
  - Na powierzchniach bez natywnych poleceń (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams) polecenia tekstowe nadal działają, nawet jeśli ustawisz to na `false`.
- `commands.native` (domyślnie `"auto"`) rejestruje natywne polecenia.
  - Auto: włączone dla Discord/Telegram; wyłączone dla Slack (do czasu dodania poleceń slash); ignorowane dla dostawców bez natywnego wsparcia.
  - Ustaw `channels.discord.commands.native`, `channels.telegram.commands.native` lub `channels.slack.commands.native`, aby nadpisać per dostawca (bool lub `"auto"`).
  - `false` czyści wcześniej zarejestrowane polecenia na Discord/Telegram przy starcie. Polecenia Slack są zarządzane w aplikacji Slack i nie są usuwane automatycznie.
- `commands.nativeSkills` (domyślnie `"auto"`) rejestruje natywnie polecenia **skill**, gdy są obsługiwane.
  - Auto: włączone dla Discord/Telegram; wyłączone dla Slack (Slack wymaga utworzenia polecenia slash dla każdej skill).
  - Ustaw `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` lub `channels.slack.commands.nativeSkills`, aby nadpisać per dostawca (bool lub `"auto"`).
- `commands.bash` (domyślnie `false`) włącza `! <cmd>` do uruchamiania poleceń powłoki hosta (`/bash <cmd>` jest aliasem; wymaga list dozwolonych `tools.elevated`).
- `commands.bashForegroundMs` (domyślnie `2000`) kontroluje, jak długo bash czeka przed przełączeniem do trybu tła (`0` przełącza do tła natychmiast).
- `commands.config` (domyślnie `false`) włącza `/config` (odczyt/zapis `openclaw.json`).
- `commands.debug` (domyślnie `false`) włącza `/debug` (nadpisania tylko w czasie działania).
- `commands.useAccessGroups` (domyślnie `true`) wymusza listy dozwolonych/polityki dla poleceń.

## Lista poleceń

Tekstowe + natywne (gdy włączone):

- `/help`
- `/commands`
- `/skill <name> [input]` (uruchom skill po nazwie)
- `/status` (pokaż bieżący stan; zawiera użycie/limity dostawcy dla aktualnego dostawcy modelu, gdy dostępne)
- `/allowlist` (lista/dodaj/usuń wpisy listy dozwolonych)
- `/approve <id> allow-once|allow-always|deny` (rozwiąż monity zatwierdzania exec)
- `/context [list|detail|json]` (wyjaśnij „kontekst”; `detail` pokazuje rozmiar per plik + per narzędzie + per skill + prompt systemowy)
- `/whoami` (pokaż identyfikator nadawcy; alias: `/id`)
- `/subagents list|stop|log|info|send` (inspekcja, zatrzymanie, logowanie lub wysyłanie wiadomości do uruchomień sub-agenta dla bieżącej sesji)
- `/config show|get|set|unset` (zapis konfiguracji na dysk, tylko właściciel; wymaga `commands.config: true`)
- `/debug show|set|unset|reset` (nadpisania w czasie działania, tylko właściciel; wymaga `commands.debug: true`)
- `/usage off|tokens|full|cost` (stopka użycia per odpowiedź lub lokalne podsumowanie kosztów)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (sterowanie TTS; zob. [/tts](/tts))
  - Discord: natywne polecenie to `/voice` (Discord rezerwuje `/tts`); tekstowe `/tts` nadal działa.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (przełącz odpowiedzi na Telegram)
- `/dock-discord` (alias: `/dock_discord`) (przełącz odpowiedzi na Discord)
- `/dock-slack` (alias: `/dock_slack`) (przełącz odpowiedzi na Slack)
- `/activation mention|always` (tylko grupy)
- `/send on|off|inherit` (tylko właściciel)
- `/reset` lub `/new [model]` (opcjonalna wskazówka modelu; reszta jest przekazywana dalej)
- `/think <off|minimal|low|medium|high|xhigh>` (dynamiczne wybory według modelu/dostawcy; aliasy: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; gdy włączone, wysyła osobną wiadomość z prefiksem `Reasoning:`; `stream` = tylko szkic Telegram)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` pomija zatwierdzanie exec)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (wyślij `/exec`, aby pokazać bieżące)
- `/model <name>` (alias: `/models`; lub `/<alias>` z `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus opcje takie jak `debounce:2s cap:25 drop:summarize`; wyślij `/queue`, aby zobaczyć bieżące ustawienia)
- `/bash <command>` (tylko host; alias dla `! <command>`; wymaga list dozwolonych `commands.bash: true` + `tools.elevated`)

Tylko tekstowe:

- `/compact [instructions]` (zob. [/concepts/compaction](/concepts/compaction))
- `! <command>` (tylko host; po jednym naraz; użyj `!poll` + `!stop` dla długotrwałych zadań)
- `!poll` (sprawdź wyjście / status; akceptuje opcjonalnie `sessionId`; `/bash poll` także działa)
- `!stop` (zatrzymaj uruchomione zadanie bash; akceptuje opcjonalnie `sessionId`; `/bash stop` także działa)

Uwagi:

- Polecenia akceptują opcjonalne `:` między poleceniem a argumentami (np. `/think: high`, `/send: on`, `/help:`).
- `/new <model>` akceptuje alias modelu, `provider/model` lub nazwę dostawcy (dopasowanie przybliżone); jeśli brak dopasowania, tekst jest traktowany jako treść wiadomości.
- Aby uzyskać pełny podział użycia według dostawcy, użyj `openclaw status --usage`.
- `/allowlist add|remove` wymaga `commands.config=true` i respektuje kanałowe `configWrites`.
- `/usage` kontroluje stopkę użycia per odpowiedź; `/usage cost` drukuje lokalne podsumowanie kosztów z logów sesji OpenClaw.
- `/restart` jest domyślnie wyłączone; ustaw `commands.restart: true`, aby je włączyć.
- `/verbose` jest przeznaczone do debugowania i zwiększonej widoczności; w normalnym użyciu pozostaw **wyłączone**.
- `/reasoning` (oraz `/verbose`) są ryzykowne w ustawieniach grupowych: mogą ujawniać wewnętrzne rozumowanie lub wyjście narzędzi, których nie zamierzałeś ujawnić. Preferuj pozostawienie ich wyłączonych, zwłaszcza w czatach grupowych.
- **Szybka ścieżka:** wiadomości zawierające wyłącznie polecenia od nadawców z listy dozwolonych są obsługiwane natychmiast (z pominięciem kolejki + modelu).
- **Bramkowanie wzmianek w grupach:** wiadomości zawierające wyłącznie polecenia od nadawców z listy dozwolonych omijają wymagania dotyczące wzmianek.
- **Skróty inline (tylko nadawcy z listy dozwolonych):** niektóre polecenia działają także, gdy są osadzone w zwykłej wiadomości i są usuwane, zanim model zobaczy pozostały tekst.
  - Przykład: `hey /status` wyzwala odpowiedź statusu, a pozostały tekst przechodzi dalej normalnym tokiem.
- Obecnie: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Nieautoryzowane wiadomości zawierające wyłącznie polecenia są po cichu ignorowane, a tokeny inline `/...` są traktowane jako zwykły tekst.
- **Polecenia skill:** skille `user-invocable` są udostępniane jako polecenia slash. Nazwy są sanityzowane do `a-z0-9_` (maks. 32 znaki); kolizje otrzymują sufiksy liczbowe (np. `_2`).
  - `/skill <name> [input]` uruchamia skill po nazwie (przydatne, gdy limity natywnych poleceń uniemożliwiają polecenia per skill).
  - Domyślnie polecenia skill są przekazywane do modelu jako zwykłe żądanie.
  - Skille mogą opcjonalnie deklarować `command-dispatch: tool`, aby routować polecenie bezpośrednio do narzędzia (deterministycznie, bez modelu).
  - Przykład: `/prose` (wtyczka OpenProse) — zob. [OpenProse](/prose).
- **Argumenty poleceń natywnych:** Discord używa autouzupełniania dla opcji dynamicznych (oraz menu przycisków, gdy pominiesz wymagane argumenty). Telegram i Slack pokazują menu przycisków, gdy polecenie obsługuje wybory, a pominiesz argument.

## Powierzchnie użycia (co gdzie się wyświetla)

- **Użycie/limit dostawcy** (np. „Claude 80% left”) pojawia się w `/status` dla bieżącego dostawcy modelu, gdy śledzenie użycia jest włączone.
- **Tokeny/koszt per odpowiedź** są kontrolowane przez `/usage off|tokens|full` (dołączane do normalnych odpowiedzi).
- `/model status` dotyczy **modeli/uwierzytelniania/endpointów**, a nie użycia.

## Wybór modelu (`/model`)

`/model` jest zaimplementowane jako dyrektywa.

Przykłady:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Uwagi:

- `/model` oraz `/model list` pokazują kompaktowy, numerowany selektor (rodzina modeli + dostępni dostawcy).
- `/model <#>` wybiera z tego selektora (i preferuje bieżącego dostawcę, gdy to możliwe).
- `/model status` pokazuje widok szczegółowy, w tym skonfigurowany endpoint dostawcy (`baseUrl`) oraz tryb API (`api`), gdy są dostępne.

## Nadpisania debugowania

`/debug` pozwala ustawić **nadpisania tylko w czasie działania** konfiguracji (pamięć, nie dysk). Tylko właściciel. Domyślnie wyłączone; włącz za pomocą `commands.debug: true`.

Przykłady:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Uwagi:

- Nadpisania obowiązują natychmiast dla nowych odczytów konfiguracji, ale **nie** zapisują się do `openclaw.json`.
- Użyj `/debug reset`, aby wyczyścić wszystkie nadpisania i wrócić do konfiguracji na dysku.

## Aktualizacje konfiguracji

`/config` zapisuje do konfiguracji na dysku (`openclaw.json`). Tylko właściciel. Domyślnie wyłączone; włącz za pomocą `commands.config: true`.

Przykłady:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Uwagi:

- Konfiguracja jest walidowana przed zapisem; nieprawidłowe zmiany są odrzucane.
- Aktualizacje `/config` utrzymują się po restartach.

## Uwagi dotyczące powierzchni

- **Polecenia tekstowe** działają w normalnej sesji czatu (DM-y współdzielą `main`, grupy mają własną sesję).
- **Polecenia natywne** używają izolowanych sesji:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefiks konfigurowalny przez `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (celuje w sesję czatu przez `CommandTargetSessionKey`)
- **`/stop`** celuje w aktywną sesję czatu, aby móc przerwać bieżące uruchomienie.
- **Slack:** `channels.slack.slashCommand` jest nadal obsługiwane dla pojedynczego polecenia w stylu `/openclaw`. Jeśli włączysz `commands.native`, musisz utworzyć jedno polecenie slash Slack dla każdego wbudowanego polecenia (te same nazwy co `/help`). Menu argumentów poleceń dla Slack są dostarczane jako efemeryczne przyciski Block Kit.

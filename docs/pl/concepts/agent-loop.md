---
summary: "Cykl życia pętli agenta, strumienie i semantyka oczekiwania"
read_when:
  - Potrzebujesz dokładnego przejścia przez pętlę agenta lub zdarzenia cyklu życia
title: "Pętla agenta"
---

# Pętla agenta (OpenClaw)

Pętla agentowa to pełny, „rzeczywisty” przebieg agenta: przyjęcie → złożenie kontekstu → inferencja modelu →
wykonanie narzędzi → strumieniowanie odpowiedzi → utrwalenie. Jest to autorytatywna ścieżka, która
zamienia wiadomość w działania i odpowiedź końcową, jednocześnie utrzymując spójny stan sesji.

W OpenClaw pętla to pojedyncze, zserializowane uruchomienie na sesję, które emituje zdarzenia cyklu życia
i strumieni w trakcie myślenia modelu, wywołań narzędzi oraz strumieniowania wyjścia. Ten dokument
wyjaśnia, jak ta właściwa pętla jest połączona end-to-end.

## Punkty wejścia

- RPC Gateway: `agent` i `agent.wait`.
- CLI: polecenie `agent`.

## Jak to działa (wysoki poziom)

1. RPC `agent` weryfikuje parametry, rozwiązuje sesję (sessionKey/sessionId), zapisuje metadane sesji i natychmiast zwraca `{ runId, acceptedAt }`.
2. `agentCommand` uruchamia agenta:
   - rozwiązuje model + domyślne ustawienia thinking/verbose
   - ładuje migawkę skills
   - wywołuje `runEmbeddedPiAgent` (środowisko uruchomieniowe pi-agent-core)
   - emituje **lifecycle end/error**, jeśli osadzona pętla nie wyemituje takiego zdarzenia
3. `runEmbeddedPiAgent`:
   - serializuje uruchomienia przez kolejki per-sesja + globalne
   - rozwiązuje model + profil uwierzytelniania i buduje sesję pi
   - subskrybuje zdarzenia pi i strumieniuje delty asystenta/narzędzi
   - wymusza limit czasu -> przerywa działanie, jeśli przekroczony
   - zwraca ładunki + metadane użycia
4. `subscribeEmbeddedPiSession` mostkuje zdarzenia pi-agent-core do strumienia OpenClaw `agent`:
   - zdarzenia narzędzi => `stream: "tool"`
   - delty asystenta => `stream: "assistant"`
   - zdarzenia cyklu życia => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` używa `waitForAgentJob`:
   - czeka na **lifecycle end/error** dla `runId`
   - zwraca `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Kolejkowanie + współbieżność

- Uruchomienia są serializowane per klucz sesji (pas sesji) i opcjonalnie przez pas globalny.
- Zapobiega to wyścigom narzędzi/sesji i utrzymuje spójność historii sesji.
- Kanały komunikacyjne mogą wybierać tryby kolejek (collect/steer/followup), które zasilają ten system pasów.
  Zobacz [Command Queue](/concepts/queue).

## Przygotowanie sesji + obszaru roboczego

- Obszar roboczy jest rozwiązywany i tworzony; uruchomienia w sandboxie mogą przekierowywać do katalogu głównego obszaru roboczego sandbox.
- Skills są ładowane (lub ponownie używane z migawki) i wstrzykiwane do środowiska oraz promptu.
- Pliki bootstrap/kontekstu są rozwiązywane i wstrzykiwane do raportu promptu systemowego.
- Uzyskiwana jest blokada zapisu sesji; `SessionManager` jest otwierany i przygotowywany przed strumieniowaniem.

## Składanie promptu + prompt systemowy

- Prompt systemowy jest budowany z bazowego promptu OpenClaw, promptu skills, kontekstu bootstrap oraz nadpisań per-uruchomienie.
- Egzekwowane są limity specyficzne dla modelu oraz rezerwa tokenów na kompaktowanie.
- Zobacz [System prompt](/concepts/system-prompt), aby dowiedzieć się, co widzi model.

## Punkty hooków (gdzie można przechwycić)

OpenClaw ma dwa systemy hooków:

- **Hooki wewnętrzne** (hooki Gateway): skrypty sterowane zdarzeniami dla poleceń i zdarzeń cyklu życia.
- **Hooki wtyczek**: punkty rozszerzeń wewnątrz cyklu życia agenta/narzędzi oraz potoku gateway.

### Hooki wewnętrzne (hooki Gateway)

- **`agent:bootstrap`**: uruchamiany podczas budowania plików bootstrap przed finalizacją promptu systemowego.
  Użyj tego, aby dodać/usunąć pliki kontekstu bootstrap.
- **Hooki poleceń**: `/new`, `/reset`, `/stop` oraz inne zdarzenia poleceń (zobacz dokumentację Hooków).

Zobacz [Hooks](/automation/hooks) w celu konfiguracji i przykładów.

### Hooki wtyczek (cykl życia agenta + gateway)

Działają one wewnątrz pętli agenta lub potoku gateway:

- **`before_agent_start`**: wstrzykuje kontekst lub nadpisuje prompt systemowy przed startem uruchomienia.
- **`agent_end`**: inspekcja końcowej listy wiadomości i metadanych uruchomienia po zakończeniu.
- **`before_compaction` / `after_compaction`**: obserwacja lub adnotacja cykli kompaktowania.
- **`before_tool_call` / `after_tool_call`**: przechwytywanie parametrów/wyników narzędzi.
- **`tool_result_persist`**: synchroniczna transformacja wyników narzędzi przed zapisaniem ich do transkryptu sesji.
- **`message_received` / `message_sending` / `message_sent`**: hooki wiadomości przychodzących i wychodzących.
- **`session_start` / `session_end`**: granice cyklu życia sesji.
- **`gateway_start` / `gateway_stop`**: zdarzenia cyklu życia gateway.

Zobacz [Plugins](/tools/plugin#plugin-hooks) w celu zapoznania się z API hooków i szczegółami rejestracji.

## Strumieniowanie + odpowiedzi częściowe

- Delty asystenta są strumieniowane z pi-agent-core i emitowane jako zdarzenia `assistant`.
- Strumieniowanie blokowe może emitować odpowiedzi częściowe na `text_end` lub `message_end`.
- Strumieniowanie rozumowania może być emitowane jako osobny strumień lub jako odpowiedzi blokowe.
- Zobacz [Streaming](/concepts/streaming) w celu informacji o dzieleniu na fragmenty i zachowaniu odpowiedzi blokowych.

## Wykonanie narzędzi + narzędzia komunikacyjne

- Zdarzenia start/update/end narzędzi są emitowane na strumieniu `tool`.
- Wyniki narzędzi są sanityzowane pod kątem rozmiaru i ładunków obrazów przed logowaniem/emisją.
- Wysyłki narzędzi komunikacyjnych są śledzone w celu tłumienia zduplikowanych potwierdzeń asystenta.

## Kształtowanie odpowiedzi + tłumienie

- Końcowe ładunki są składane z:
  - tekstu asystenta (i opcjonalnego rozumowania)
  - wbudowanych podsumowań narzędzi (gdy verbose + dozwolone)
  - tekstu błędu asystenta, gdy model zwróci błąd
- `NO_REPLY` jest traktowany jako cichy token i filtrowany z wychodzących ładunków.
- Duplikaty narzędzi komunikacyjnych są usuwane z końcowej listy ładunków.
- Jeśli nie pozostaną renderowalne ładunki, a narzędzie zwróciło błąd, emitowana jest zapasowa odpowiedź błędu narzędzia
  (chyba że narzędzie komunikacyjne już wysłało odpowiedź widoczną dla użytkownika).

## Kompaktowanie + ponowienia

- Automatyczne kompaktowanie emituje zdarzenia strumienia `compaction` i może wyzwolić ponowienie.
- Przy ponowieniu bufory w pamięci i podsumowania narzędzi są resetowane, aby uniknąć zduplikowanego wyjścia.
- Zobacz [Compaction](/concepts/compaction) w celu poznania potoku kompaktowania.

## Strumienie zdarzeń (obecnie)

- `lifecycle`: emitowane przez `subscribeEmbeddedPiSession` (oraz jako fallback przez `agentCommand`)
- `assistant`: strumieniowane delty z pi-agent-core
- `tool`: strumieniowane zdarzenia narzędzi z pi-agent-core

## Obsługa kanału czatu

- Delty asystenta są buforowane do wiadomości czatu `delta`.
- Wiadomość czatu `final` jest emitowana przy **lifecycle end/error**.

## Limity czasu

- Domyślnie `agent.wait`: 30 s (tylko oczekiwanie). Parametr `timeoutMs` nadpisuje.
- Czas działania agenta: domyślnie `agents.defaults.timeoutSeconds` 600 s; egzekwowane w `runEmbeddedPiAgent` przez timer przerwania.

## Gdzie proces może zakończyć się wcześniej

- Limit czasu agenta (przerwanie)
- AbortSignal (anulowanie)
- Rozłączenie gateway lub timeout RPC
- Limit czasu `agent.wait` (tylko oczekiwanie, nie zatrzymuje agenta)

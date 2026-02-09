---
summary: "„Projekt kolejki poleceń, który serializuje przychodzące uruchomienia automatycznych odpowiedzi”"
read_when:
  - Zmiana wykonywania automatycznych odpowiedzi lub współbieżności
title: "Kolejka poleceń"
---

# Kolejka poleceń (2026-01-16)

Serializujemy przychodzące uruchomienia automatycznych odpowiedzi (we wszystkich kanałach) przez niewielką kolejkę w procesie, aby zapobiec kolizjom wielu uruchomień agentów, jednocześnie umożliwiając bezpieczną równoległość między sesjami.

## Dlaczego

- Uruchomienia automatycznych odpowiedzi mogą być kosztowne (wywołania LLM) i mogą wchodzić ze sobą w kolizję, gdy wiele wiadomości przychodzących pojawi się w krótkim odstępie czasu.
- Serializacja zapobiega rywalizacji o współdzielone zasoby (pliki sesji, logi, stdin CLI) i zmniejsza ryzyko limitów po stronie upstream.

## Jak to działa

- Kolejka FIFO świadoma pasów (lane-aware) opróżnia każdy pas z konfigurowalnym limitem współbieżności (domyślnie 1 dla pasów bez konfiguracji; main domyślnie 4, subagent 8).
- `runEmbeddedPiAgent` kolejkowuje według **klucza sesji** (pas `session:<key>`), aby zagwarantować tylko jedno aktywne uruchomienie na sesję.
- Każde uruchomienie sesji jest następnie kolejkowane do **globalnego pasa** (domyślnie `main`), dzięki czemu ogólna równoległość jest ograniczona przez `agents.defaults.maxConcurrent`.
- Gdy włączone jest szczegółowe logowanie, zakolejkowane uruchomienia emitują krótką informację, jeśli czekały ponad ~2 s przed startem.
- Wskaźniki pisania nadal uruchamiają się natychmiast po dodaniu do kolejki (gdy kanał to obsługuje), więc doświadczenie użytkownika pozostaje niezmienione, podczas gdy czekamy na swoją kolej.

## Tryby kolejki (na kanał)

Wiadomości przychodzące mogą sterować bieżącym uruchomieniem, czekać na kolejną turę lub robić oba:

- `steer`: natychmiastowe wstrzyknięcie do bieżącego uruchomienia (anuluje oczekujące wywołania narzędzi po następnej granicy narzędzia). Jeśli nie ma strumieniowania, przechodzi do trybu followup.
- `followup`: dodanie do kolejki na następną turę agenta po zakończeniu bieżącego uruchomienia.
- `collect`: scalenie wszystkich zakolejkowanych wiadomości w **jedną** turę followup (domyślnie). Jeśli wiadomości dotyczą różnych kanałów/wątków, są opróżniane indywidualnie, aby zachować routowanie.
- `steer-backlog` (aka `steer+backlog`): steruj teraz **i** zachowaj wiadomość na turę followup.
- `interrupt` (legacy): przerwij aktywne uruchomienie dla tej sesji, a następnie uruchom najnowszą wiadomość.
- `queue` (legacy alias): to samo co `steer`.

Steer-backlog oznacza, że możesz otrzymać odpowiedź followup po sterowanym uruchomieniu, więc
powierzchnie strumieniujące mogą wyglądać jak duplikaty. Preferuj `collect`/`steer`, jeśli chcesz
jedną odpowiedź na każdą wiadomość przychodzącą.
Wyślij `/queue collect` jako samodzielne polecenie (na sesję) lub ustaw `messages.queue.byChannel.discord: "collect"`.

Ustawienia domyślne (gdy nie są ustawione w konfiguracji):

- Wszystkie powierzchnie → `collect`

Skonfiguruj globalnie lub per kanał przez `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Opcje kolejki

Opcje dotyczą `followup`, `collect` i `steer-backlog` (oraz `steer`, gdy przechodzi do followup):

- `debounceMs`: czekaj na ciszę przed rozpoczęciem tury followup (zapobiega „kontynuuj, kontynuuj”).
- `cap`: maksymalna liczba zakolejkowanych wiadomości na sesję.
- `drop`: polityka przepełnienia (`old`, `new`, `summarize`).

Tryb podsumowania zachowuje krótką listę punktów porzuconych wiadomości i wstrzykuje ją jako syntetyczny prompt followup.
Ustawienia domyślne: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Nadpisania per sesja

- Wyślij `/queue <mode>` jako samodzielne polecenie, aby zapisać tryb dla bieżącej sesji.
- Opcje można łączyć: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` lub `/queue reset` czyści nadpisanie sesji.

## Zakres i gwarancje

- Dotyczy uruchomień agenta automatycznych odpowiedzi we wszystkich kanałach przychodzących, które korzystają z potoku odpowiedzi gateway (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat itd.).
- Domyślny pas (`main`) jest współdzielony w obrębie procesu dla przychodzących + heartbeatów main; ustaw `agents.defaults.maxConcurrent`, aby umożliwić równoległe sesje.
- Mogą istnieć dodatkowe pasy (np. `cron`, `subagent`), dzięki czemu zadania w tle mogą działać równolegle bez blokowania odpowiedzi przychodzących.
- Pasy per sesja gwarantują, że tylko jedno uruchomienie agenta dotyka danej sesji w danym czasie.
- Brak zależności zewnętrznych lub wątków roboczych w tle; czysty TypeScript + promisy.

## Rozwiązywanie problemów

- Jeśli polecenia wydają się zablokowane, włącz szczegółowe logi i szukaj linii „queued for …ms”, aby potwierdzić, że kolejka się opróżnia.
- Jeśli potrzebujesz głębokości kolejki, włącz szczegółowe logi i obserwuj linie dotyczące czasu kolejki.

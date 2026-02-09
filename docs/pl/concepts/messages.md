---
summary: "„Przepływ wiadomości, sesje, kolejkowanie i widoczność rozumowania”"
read_when:
  - Wyjaśnianie, jak wiadomości przychodzące stają się odpowiedziami
  - Doprecyzowanie sesji, trybów kolejkowania lub zachowania strumieniowania
  - Dokumentowanie widoczności rozumowania i implikacji użytkowych
title: "Wiadomości"
---

# Wiadomości

Ta strona spina sposób, w jaki OpenClaw obsługuje wiadomości przychodzące, sesje, kolejkowanie,
strumieniowanie oraz widoczność rozumowania.

## Przepływ wiadomości (wysoki poziom)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Kluczowe ustawienia znajdują się w konfiguracji:

- `messages.*` dla prefiksów, kolejkowania i zachowania w grupach.
- `agents.defaults.*` dla strumieniowania blokowego i domyślnych ustawień porcjowania.
- Nadpisania per kanał (`channels.whatsapp.*`, `channels.telegram.*` itd.) dla limitów i przełączników strumieniowania.

Pełny schemat: [Konfiguracja](/gateway/configuration).

## Deduplikacja przychodzących

Kanały mogą ponownie dostarczyć tę samą wiadomość po ponownym połączeniu. OpenClaw utrzymuje
krótkotrwałą pamięć podręczną kluczowaną przez kanał/konto/peer/sesję/ID wiadomości, aby
zduplikowane dostarczenia nie uruchamiały kolejnego przebiegu agenta.

## Debouncing przychodzących

Szybkie, następujące po sobie wiadomości od **tego samego nadawcy** mogą być łączone w jedną
turę agenta poprzez `messages.inbound`. Debouncing jest zakresowany per kanał + konwersacja
i używa najnowszej wiadomości do wątkowania odpowiedzi/ID.

Konfiguracja (globalna domyślna + nadpisania per kanał):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Uwagi:

- Debounce dotyczy wiadomości **tylko tekstowych**; media/załączniki są opróżniane natychmiast.
- Polecenia kontrolne omijają debouncing, aby pozostały samodzielne.

## Sesje i urządzenia

Sesje są własnością Gateway, a nie klientów.

- Czaty bezpośrednie zapadają się do głównego klucza sesji agenta.
- Grupy/kanały otrzymują własne klucze sesji.
- Magazyn sesji i transkrypty znajdują się na hoście Gateway.

Wiele urządzeń/kanałów może mapować do tej samej sesji, ale historia nie jest w pełni
synchronizowana z powrotem do każdego klienta. Rekomendacja: używaj jednego
głównego urządzenia do długich rozmów, aby uniknąć rozbieżnego kontekstu. Control UI i TUI
zawsze pokazują transkrypt sesji oparty o Gateway, więc stanowią źródło prawdy.

Szczegóły: [Zarządzanie sesjami](/concepts/session).

## Treści przychodzące i kontekst historii

OpenClaw rozdziela **treść promptu** od **treści polecenia**:

- `Body`: tekst promptu wysyłany do agenta. Może zawierać koperty kanału i
  opcjonalne opakowania historii.
- `CommandBody`: surowy tekst użytkownika do parsowania dyrektyw/poleceń.
- `RawBody`: starszy alias dla `CommandBody` (zachowany dla kompatybilności).

Gdy kanał dostarcza historię, używa wspólnego opakowania:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Dla **czatów niedyrektywnych** (grupy/kanały/pokoje) **bieżąca treść wiadomości** jest poprzedzona
etykietą nadawcy (ten sam styl, co dla wpisów historii). Zapewnia to spójność
wiadomości w czasie rzeczywistym oraz kolejkowanych/historii w promptcie agenta.

Bufory historii są **tylko oczekujące**: obejmują wiadomości grupowe, które _nie_
uruchomiły przebiegu (na przykład wiadomości bramkowane wzmianką) i **wykluczają** wiadomości
już znajdujące się w transkrypcie sesji.

Usuwanie dyrektyw dotyczy wyłącznie sekcji **bieżącej wiadomości**, dzięki czemu historia
pozostaje nienaruszona. Kanały, które opakowują historię, powinny ustawić `CommandBody` (lub
`RawBody`) na oryginalny tekst wiadomości i zachować `Body` jako połączony prompt.
Bufory historii są konfigurowalne poprzez `messages.groupChat.historyLimit` (domyślne globalnie) oraz nadpisania
per kanał, takie jak `channels.slack.historyLimit` lub `channels.telegram.accounts.<id>.historyLimit` (ustaw `0`, aby wyłączyć).

## Kolejkowanie i follow-upy

Jeśli przebieg jest już aktywny, wiadomości przychodzące mogą być kolejkowane, kierowane do
bieżącego przebiegu lub zbierane na turę follow-up.

- Konfiguracja poprzez `messages.queue` (oraz `messages.queue.byChannel`).
- Tryby: `interrupt`, `steer`, `followup`, `collect`, plus warianty backlogu.

Szczegóły: [Kolejkowanie](/concepts/queue).

## Strumieniowanie, porcjowanie i batchowanie

Strumieniowanie blokowe wysyła częściowe odpowiedzi w miarę, jak model produkuje bloki tekstu.
Porcjowanie respektuje limity tekstu kanału i unika dzielenia ogrodzonych bloków kodu.

Kluczowe ustawienia:

- `agents.defaults.blockStreamingDefault` (`on|off`, domyślnie wyłączone)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (batchowanie oparte na bezczynności)
- `agents.defaults.humanDelay` (ludzka pauza między odpowiedziami blokowymi)
- Nadpisania per kanał: `*.blockStreaming` oraz `*.blockStreamingCoalesce` (kanały inne niż Telegram wymagają jawnego `*.blockStreaming: true`)

Szczegóły: [Strumieniowanie + porcjowanie](/concepts/streaming).

## Widoczność rozumowania i tokeny

OpenClaw może ujawniać lub ukrywać rozumowanie modelu:

- `/reasoning on|off|stream` kontroluje widoczność.
- Treści rozumowania nadal wliczają się do użycia tokenów, gdy są generowane przez model.
- Telegram obsługuje strumień rozumowania do bańki szkicowej.

Szczegóły: [Dyrektywy myślenia + rozumowania](/tools/thinking) oraz [Użycie tokenów](/reference/token-use).

## Prefiksy, wątkowanie i odpowiedzi

Formatowanie wiadomości wychodzących jest scentralizowane w `messages`:

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` i `channels.<channel>.accounts.<id>.responsePrefix` (kaskada prefiksów wychodzących) oraz `channels.whatsapp.messagePrefix` (prefiks przychodzący WhatsApp)
- Wątkowanie odpowiedzi poprzez `replyToMode` oraz domyślne ustawienia per kanał

Szczegóły: [Konfiguracja](/gateway/configuration#messages) oraz dokumentacja kanałów.

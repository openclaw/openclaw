---
summary: "Strumieniowanie + zachowanie chunkingu (blokuj odpowiedzi, szkic streamingu, limity)"
read_when:
  - Wyjaśnianie, jak działa strumieniowanie lub porcjowanie w kanałach
  - Zmiana zachowania strumieniowania blokowego lub porcjowania kanałów
  - Debugowanie zduplikowanych/wczesnych odpowiedzi blokowych lub strumieniowania wersji roboczej
title: "Strumieniowanie i czowanie"
---

# Strumieniowanie + chunking

OpenClaw ma dwie oddzielne warstwy „strumieniowania”:

- **Strumieniowanie blokowe (kanały):** emituje ukończone **bloki** w miarę pisania przez asystenta. Są to zwykłe wiadomości kanału (nie delty tokenów).
- **Strumieniowanie quasi-tokenowe (tylko Telegram):** aktualizuje **dymek wersji roboczej** częściowym tekstem podczas generowania; końcowa wiadomość jest wysyłana na końcu.

Obecnie **nie ma prawdziwego strumieniowania tokenów** do zewnętrznych wiadomości kanałów. Jedyną powierzchnią częściowego strumieniowania jest strumieniowanie wersji roboczej w Telegramie.

## Strumieniowanie blokowe (wiadomości kanału)

Strumieniowanie blokowe wysyła odpowiedź asystenta w grubych porcjach, gdy stają się dostępne.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legenda:

- `text_delta/events`: zdarzenia strumienia modelu (mogą być rzadkie dla modeli niestrumieniujących).
- `chunker`: `EmbeddedBlockChunker` z zastosowaniem minimalnych/maksymalnych granic + preferencji podziału.
- `channel send`: faktyczne wiadomości wychodzące (odpowiedzi blokowe).

**Sterowanie:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (domyślnie wyłączone).
- Nadpisania kanału: `*.blockStreaming` (oraz warianty per-konto), aby wymusić `"on"`/`"off"` na kanał.
- `agents.defaults.blockStreamingBreak`: `"text_end"` lub `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (scalanie strumieniowanych bloków przed wysyłką).
- Twardy limit kanału: `*.textChunkLimit` (np. `channels.whatsapp.textChunkLimit`).
- Tryb porcjowania kanału: `*.chunkMode` (`length` domyślnie, `newline` dzieli po pustych liniach (granice akapitów) przed porcjowaniem długości).
- Miękki limit Discorda: `channels.discord.maxLinesPerMessage` (domyślnie 17) dzieli wysokie odpowiedzi, aby uniknąć przycinania UI.

**Semantyka granic:**

- `text_end`: strumieniuje bloki, gdy tylko porcjownik je wyemituje; opróżnia bufor przy każdym `text_end`.
- `message_end`: czeka do zakończenia wiadomości asystenta, a następnie opróżnia zbuforowane wyjście.

`message_end` nadal używa porcjownika, jeśli zbuforowany tekst przekracza `maxChars`, więc może wyemitować wiele porcji na końcu.

## Algorytm porcjowania (dolna/górna granica)

Porcjowanie bloków jest realizowane przez `EmbeddedBlockChunker`:

- **Dolna granica:** nie emituj, dopóki bufor >= `minChars` (chyba że wymuszone).
- **Górna granica:** preferuj podziały przed `maxChars`; jeśli wymuszone, podziel przy `maxChars`.
- **Preferencja podziału:** `paragraph` → `newline` → `sentence` → `whitespace` → twardy podział.
- **Bloki kodu:** nigdy nie dziel wewnątrz bloków; gdy wymuszone przy `maxChars`, zamknij i ponownie otwórz blok, aby zachować poprawność Markdown.

`maxChars` jest ograniczane przez `textChunkLimit` kanału, więc nie można przekroczyć limitów per-kanał.

## Scalanie (łączenie strumieniowanych bloków)

Gdy strumieniowanie blokowe jest włączone, OpenClaw może **scalać kolejne porcje bloków**
przed ich wysłaniem. Zmniejsza to „spam jednolinijkowy”, zachowując jednocześnie
postępowe wyjście.

- Scalanie czeka na **przerwy bezczynności** (`idleMs`) przed opróżnieniem bufora.
- Bufory są ograniczone przez `maxChars` i zostaną opróżnione po jego przekroczeniu.
- `minChars` zapobiega wysyłaniu drobnych fragmentów, dopóki nie zbierze się wystarczająca ilość tekstu
  (końcowe opróżnienie zawsze wysyła pozostały tekst).
- Łącznik jest wyprowadzany z `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → spacja).
- Nadpisania kanału są dostępne przez `*.blockStreamingCoalesce` (w tym konfiguracje per-konto).
- Domyślna wartość scalania `minChars` jest podniesiona do 1500 dla Signal/Slack/Discord, o ile nie zostanie nadpisana.

## Ludzkie tempo między blokami

Gdy strumieniowanie blokowe jest włączone, można dodać **losową pauzę** między
odpowiedziami blokowymi (po pierwszym bloku). Sprawia to, że odpowiedzi z wieloma dymkami
wydają się bardziej naturalne.

- Konfiguracja: `agents.defaults.humanDelay` (nadpisanie per agent przez `agents.list[].humanDelay`).
- Tryby: `off` (domyślny), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- Dotyczy tylko **odpowiedzi blokowych**, nie odpowiedzi końcowych ani podsumowań narzędzi.

## „Strumieniować porcje czy wszystko”

Mapowanie:

- **Strumieniuj porcje:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emituj na bieżąco). Kanały inne niż Telegram wymagają także `*.blockStreaming: true`.
- **Strumieniuj wszystko na końcu:** `blockStreamingBreak: "message_end"` (jednorazowe opróżnienie, możliwie w wielu porcjach, jeśli bardzo długie).
- **Brak strumieniowania blokowego:** `blockStreamingDefault: "off"` (tylko odpowiedź końcowa).

**Uwaga dotycząca kanałów:** Dla kanałów innych niż Telegram strumieniowanie blokowe jest **wyłączone, chyba że**
`*.blockStreaming` zostanie jawnie ustawione na `true`. Telegram może strumieniować wersje robocze
(`channels.telegram.streamMode`) bez odpowiedzi blokowych.

Przypomnienie o lokalizacji konfiguracji: domyślne wartości `blockStreaming*` znajdują się pod
`agents.defaults`, a nie w konfiguracji głównej.

## Strumieniowanie projektu Telegram (token ish)

Telegram jest jedynym kanałem ze strumieniowaniem wersji roboczej:

- Używa Bot API `sendMessageDraft` w **czatach prywatnych z tematami**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: aktualizacje wersji roboczej z najnowszym tekstem strumienia.
  - `block`: aktualizacje wersji roboczej w porcjowanych blokach (te same reguły porcjownika).
  - `off`: brak projektu streamingu.
- Konfiguracja porcji wersji roboczej (tylko dla `streamMode: "block"`): `channels.telegram.draftChunk` (domyślne: `minChars: 200`, `maxChars: 800`).
- Strumieniowanie wersji roboczej jest niezależne od strumieniowania blokowego; odpowiedzi blokowe są domyślnie wyłączone i włączane tylko przez `*.blockStreaming: true` na kanałach innych niż Telegram.
- Odpowiedź końcowa jest nadal zwykłą wiadomością.
- `/reasoning stream` zapisuje rozumowanie do dymka wersji roboczej (tylko Telegram).

Gdy strumieniowanie wersji roboczej jest aktywne, OpenClaw wyłącza strumieniowanie blokowe dla tej odpowiedzi, aby uniknąć podwójnego strumieniowania.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legenda:

- `sendMessageDraft`: dymek wersji roboczej Telegrama (nie jest prawdziwą wiadomością).
- `final reply`: zwykła wysyłka wiadomości w Telegramie.

---
summary: "„Kiedy OpenClaw pokazuje wskaźniki pisania i jak je dostroić”"
read_when:
  - Zmiana zachowania lub ustawień domyślnych wskaźników pisania
title: "„Wskaźniki pisania”"
---

# Wskaźniki pisania

Wskaźniki pisania są wysyłane do kanału czatu, gdy przebieg jest aktywny. Użyj
`agents.defaults.typingMode`, aby kontrolować **kiedy** rozpoczyna się pisanie, oraz `typingIntervalSeconds`,
aby kontrolować **jak często** jest odświeżane.

## Ustawienia domyślne

Gdy `agents.defaults.typingMode` jest **nieustawione**, OpenClaw zachowuje dotychczasowe zachowanie:

- **Czaty bezpośrednie**: pisanie zaczyna się natychmiast po rozpoczęciu pętli modelu.
- **Czaty grupowe z wzmianką**: pisanie zaczyna się natychmiast.
- **Czaty grupowe bez wzmianki**: pisanie zaczyna się dopiero, gdy rozpocznie się strumieniowanie treści wiadomości.
- **Przebiegi heartbeat**: pisanie jest wyłączone.

## Mody

Ustaw `agents.defaults.typingMode` na jedną z opcji:

- `never` — brak wskaźnika pisania, kiedykolwiek.
- `instant` — rozpocznij pisanie **natychmiast po starcie pętli modelu**, nawet jeśli przebieg
  później zwróci wyłącznie cichy token odpowiedzi.
- `thinking` — rozpocznij pisanie przy **pierwszym przyroście rozumowania** (wymaga
  `reasoningLevel: "stream"` dla przebiegu).
- `message` — rozpocznij pisanie przy **pierwszym niecichym przyroście tekstu** (ignoruje
  cichy token `NO_REPLY`).

Kolejność według „jak wcześnie się uruchamia”:
`never` → `message` → `thinking` → `instant`

## Konfiguracja

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Możesz nadpisać tryb lub częstotliwość odświeżania dla danej sesji:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Uwagi

- Tryb `message` nie pokaże wskaźnika pisania dla odpowiedzi wyłącznie cichych (np. token `NO_REPLY`
  używany do tłumienia wyjścia).
- `thinking` uruchamia się tylko wtedy, gdy przebieg strumieniuje rozumowanie (`reasoningLevel: "stream"`).
  Jeśli model nie emituje przyrostów rozumowania, pisanie się nie rozpocznie.
- Heartbeat nigdy nie pokazuje wskaźników pisania, niezależnie od trybu.
- `typingIntervalSeconds` kontroluje **częstotliwość odświeżania**, a nie moment rozpoczęcia.
  Wartość domyślna to 6 sekund.

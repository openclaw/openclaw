---
summary: "Polityka ponawiania dla wychodzących wywołań do dostawców"
read_when:
  - Aktualizacja zachowania lub domyślnych ustawień ponawiania u dostawców
  - Debugowanie błędów wysyłania lub limitów szybkości u dostawców
title: "Polityka ponawiania"
---

# Polityka ponawiania

## Cele

- Ponawianie na poziomie pojedynczego żądania HTTP, a nie wieloetapowego przepływu.
- Zachowanie kolejności poprzez ponawianie wyłącznie bieżącego kroku.
- Unikanie duplikowania operacji nieidempotentnych.

## Ustawienia domyślne

- Próby: 3
- Maksymalny limit opóźnienia: 30000 ms
- Jitter: 0,1 (10 procent)
- Ustawienia domyślne dostawców:
  - Telegram – minimalne opóźnienie: 400 ms
  - Discord – minimalne opóźnienie: 500 ms

## Zachowanie

### Discord

- Ponawia wyłącznie przy błędach limitu szybkości (HTTP 429).
- Używa `retry_after` tam, gdzie jest dostępne, w przeciwnym razie wykładniczego wycofania (exponential backoff).

### Telegram

- Ponawia przy błędach przejściowych (429, timeout, connect/reset/closed, tymczasowo niedostępne).
- Używa `retry_after` tam, gdzie jest dostępne, w przeciwnym razie wykładniczego wycofania (exponential backoff).
- Błędy parsowania Markdown nie są ponawiane; następuje przejście na zwykły tekst.

## Konfiguracja

Ustaw politykę ponawiania per dostawca w `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Uwagi

- Ponawianie dotyczy pojedynczego żądania (wysyłanie wiadomości, przesyłanie multimediów, reakcja, ankieta, naklejka).
- Złożone przepływy nie ponawiają już ukończonych kroków.

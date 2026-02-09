---
summary: "„Globalne słowa wybudzania głosem (należące do Gateway) i sposób ich synchronizacji między węzłami”"
read_when:
  - Zmiana zachowania lub ustawień domyślnych słów wybudzania głosem
  - Dodawanie nowych platform węzłów, które wymagają synchronizacji słów wybudzania
title: "Wybudzanie głosem"
---

# Wybudzanie głosem (globalne słowa wybudzania)

OpenClaw traktuje **słowa wybudzania jako jedną globalną listę** należącą do **Gateway**.

- **Nie ma niestandardowych słów wybudzania per węzeł**.
- **Dowolny interfejs węzła/aplikacji może edytować** listę; zmiany są zapisywane przez Gateway i rozgłaszane do wszystkich.
- Każde urządzenie nadal zachowuje własny przełącznik **Wybudzanie głosem włączone/wyłączone** (lokalny UX + różnice uprawnień).

## Przechowywanie (host Gateway)

Słowa wybudzania są przechowywane na maszynie gateway pod adresem:

- `~/.openclaw/settings/voicewake.json`

Kształt:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protokół

### Metody

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` z parametrami `{ triggers: string[] }` → `{ triggers: string[] }`

Uwagi:

- Wyzwalacze są normalizowane (przycinanie, usuwanie pustych). Puste listy wracają do wartości domyślnych.
- Dla bezpieczeństwa egzekwowane są limity (liczby/długości).

### Zdarzenia

- `voicewake.changed` ładunek `{ triggers: string[] }`

Kto je otrzymuje:

- Wszyscy klienci WebSocket (aplikacja na macOS, WebChat itd.).
- Wszystkie podłączone węzły (iOS/Android), a także przy połączeniu węzła jako początkowe wysłanie „aktualnego stanu”.

## Zachowanie klienta

### Aplikacja na macOS

- Używa listy globalnej do bramkowania wyzwalaczy `VoiceWakeRuntime`.
- Edycja „Słów wyzwalania” w ustawieniach Wybudzania głosem wywołuje `voicewake.set`, a następnie polega na rozgłoszeniu, aby utrzymać synchronizację pozostałych klientów.

### Węzeł iOS

- Używa listy globalnej do wykrywania wyzwalaczy `VoiceWakeManager`.
- Edycja Słów wybudzania w Ustawieniach wywołuje `voicewake.set` (przez Gateway WS) i jednocześnie utrzymuje responsywność lokalnego wykrywania słów wybudzania.

### Węzeł Android

- Udostępnia edytor Słów wybudzania w Ustawieniach.
- Wywołuje `voicewake.set` przez Gateway WS, aby edycje synchronizowały się wszędzie.

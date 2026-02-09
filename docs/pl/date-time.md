---
summary: "Obsługa daty i czasu w kopertach, promptach, narzędziach i konektorach"
read_when:
  - Zmieniasz sposób prezentacji znaczników czasu dla modelu lub użytkowników
  - Debugujesz formatowanie czasu w wiadomościach lub w wyjściu promptu systemowego
title: "Data i czas"
---

# Data i czas

OpenClaw domyślnie używa **czasu lokalnego hosta dla znaczników czasu transportu** oraz **strefy czasowej użytkownika wyłącznie w promptcie systemowym**.
Znaczniki czasu dostawców są zachowywane, aby narzędzia utrzymywały swoje natywne znaczenie semantyczne (bieżący czas jest dostępny przez `session_status`).

## Koperty wiadomości (domyślnie lokalne)

Przychodzące wiadomości są opakowywane znacznikiem czasu (dokładność do minut):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Ten znacznik czasu koperty jest **domyślnie lokalny dla hosta**, niezależnie od strefy czasowej dostawcy.

Możesz nadpisać to zachowanie:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` używa UTC.
- `envelopeTimezone: "local"` używa strefy czasowej hosta.
- `envelopeTimezone: "user"` używa `agents.defaults.userTimezone` (w razie braku — strefa hosta).
- Użyj jawnej strefy IANA (np. `"America/Chicago"`) dla stałej strefy.
- `envelopeTimestamp: "off"` usuwa bezwzględne znaczniki czasu z nagłówków kopert.
- `envelopeElapsed: "off"` usuwa sufiksy czasu upływu (styl `+2m`).

### Przykłady

**Lokalnie (domyślnie):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Strefa czasowa użytkownika:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Włączony czas upływu:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Prompt systemowy: bieżąca data i czas

Jeśli strefa czasowa użytkownika jest znana, prompt systemowy zawiera dedykowaną sekcję
**Bieżąca data i czas** wyłącznie ze **strefą czasową** (bez zegara/formatu czasu),
aby zachować stabilność cache’owania promptów:

```
Time zone: America/Chicago
```

Gdy agent potrzebuje bieżącego czasu, użyj narzędzia `session_status`; karta stanu
zawiera wiersz ze znacznikiem czasu.

## Wiersze zdarzeń systemowych (domyślnie lokalne)

Zdarzenia systemowe w kolejce, wstawiane do kontekstu agenta, są poprzedzane znacznikiem czasu
z użyciem tego samego wyboru strefy co koperty wiadomości (domyślnie: lokalna strefa hosta).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Konfiguracja strefy czasowej użytkownika + formatu

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` ustawia **lokalną strefę czasową użytkownika** dla kontekstu promptu.
- `timeFormat` kontroluje **wyświetlanie 12h/24h** w promptcie. `auto` podąża za preferencjami systemu operacyjnego.

## Wykrywanie formatu czasu (automatyczne)

Gdy `timeFormat: "auto"`, OpenClaw sprawdza preferencje systemu operacyjnego (macOS/Windows)
i w razie potrzeby przechodzi na formatowanie według ustawień regionalnych. Wykryta wartość
jest **buforowana per proces**, aby uniknąć powtarzanych wywołań systemowych.

## Ładunki narzędzi + konektory (surowy czas dostawcy + pola znormalizowane)

Narzędzia kanałowe zwracają **natywne znaczniki czasu dostawcy** i dodają pola znormalizowane
dla spójności:

- `timestampMs`: milisekundy epoki (UTC)
- `timestampUtc`: łańcuch ISO 8601 w UTC

Surowe pola dostawcy są zachowywane, więc nic nie zostaje utracone.

- Slack: łańcuchy podobne do epoki z API
- Discord: znaczniki czasu ISO w UTC
- Telegram/WhatsApp: znaczniki czasu specyficzne dla dostawcy (numeryczne/ISO)

Jeśli potrzebujesz czasu lokalnego, przelicz go dalej, używając znanej strefy czasowej.

## Powiązana dokumentacja

- [Prompt systemowy](/concepts/system-prompt)
- [Strefy czasowe](/concepts/timezone)
- [Wiadomości](/concepts/messages)

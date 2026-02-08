---
summary: "Referencja CLI dla `openclaw configure` (interaktywne monity konfiguracji)"
read_when:
  - Chcesz interaktywnie dostosować poświadczenia, urządzenia lub domyślne ustawienia agenta
title: "configure"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:50Z
---

# `openclaw configure`

Interaktywny kreator do konfigurowania poświadczeń, urządzeń oraz domyślnych ustawień agenta.

Uwaga: Sekcja **Model** zawiera teraz wybór wielokrotny dla listy dozwolonych `agents.defaults.models` (co pojawia się w `/model` oraz w selektorze modelu).

Wskazówka: `openclaw config` bez podkomendy otwiera ten sam kreator. Użyj
`openclaw config get|set|unset` do nieinteraktywnych edycji.

Powiązane:

- Referencja konfiguracji Gateway: [Konfiguracja](/gateway/configuration)
- CLI konfiguracji: [Konfiguracja](/cli/config)

Uwagi:

- Wybór miejsca uruchomienia Gateway zawsze aktualizuje `gateway.mode`. Możesz wybrać „Continue” bez innych sekcji, jeśli to wszystko, czego potrzebujesz.
- Usługi zorientowane na kanały (Slack/Discord/Matrix/Microsoft Teams) podczas konfiguracji proszą o listy dozwolonych kanałów/pokoi. Możesz podać nazwy lub identyfikatory; kreator, gdy to możliwe, rozwiązuje nazwy do identyfikatorów.

## Przykłady

```bash
openclaw configure
openclaw configure --section models --section channels
```

---
summary: "Referencja CLI dla `openclaw channels` (konta, status, logowanie/wylogowanie, logi)"
read_when:
  - Chcesz dodać/usunąć konta kanałów (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (wtyczka)/Signal/iMessage)
  - Chcesz sprawdzić status kanału lub śledzić logi kanału
title: "channels"
---

# `openclaw channels`

Zarządzaj kontami kanałów czatu oraz ich stanem wykonania na Gateway.

Powiązana dokumentacja:

- Przewodniki po kanałach: [Channels](/channels/index)
- Konfiguracja Gateway: [Configuration](/gateway/configuration)

## Typowe polecenia

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Dodawanie / usuwanie kont

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Wskazówka: `openclaw channels add --help` pokazuje flagi specyficzne dla kanałów (token, app token, ścieżki signal-cli itd.).

## Logowanie / wylogowanie (interaktywne)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Rozwiązywanie problemów

- Uruchom `openclaw status --deep` w celu wykonania szerokiej diagnostyki.
- Użyj `openclaw doctor` do przeprowadzenia napraw z przewodnikiem.
- `openclaw channels list` wypisuje `Claude: HTTP 403 ... user:profile` → migawka użycia wymaga zakresu `user:profile`. Użyj `--no-usage` albo podaj klucz sesji claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), albo przeprowadź ponowne uwierzytelnienie przez Claude Code CLI.

## Sondowanie możliwości

Pobierz wskazówki dotyczące możliwości dostawcy (intenty/zakresy, tam gdzie dostępne) oraz statyczne wsparcie funkcji:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Uwagi:

- `--channel` jest opcjonalne; pomiń je, aby wylistować każdy kanał (w tym rozszerzenia).
- `--target` akceptuje `channel:<id>` lub surowy numeryczny identyfikator kanału i dotyczy wyłącznie Discord.
- Sondowania są specyficzne dla dostawców: intenty Discord + opcjonalne uprawnienia kanałów; zakresy bota i użytkownika Slack; flagi bota Telegram + webhook; wersja demona Signal; token aplikacji MS Teams + role/zakresy Graph (oznaczone tam, gdzie znane). Kanały bez sond raportują `Probe: unavailable`.

## Rozwiązywanie nazw na identyfikatory

Rozwiąż nazwy kanałów/użytkowników na identyfikatory przy użyciu katalogu dostawcy:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Uwagi:

- Użyj `--kind user|group|auto`, aby wymusić typ celu.
- Rozwiązywanie preferuje aktywne dopasowania, gdy wiele wpisów ma tę samą nazwę.

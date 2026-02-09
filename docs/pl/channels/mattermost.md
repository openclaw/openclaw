---
summary: "Konfiguracja bota Mattermost i konfiguracja OpenClaw"
read_when:
  - Konfiguracja Mattermost
  - Debugowanie routingu Mattermost
title: "Mattermost"
---

# Mattermost (wtyczka)

Status: obsługiwany przez wtyczkę (token bota + zdarzenia WebSocket). Obsługiwane są kanały, grupy i DM-y.
Mattermost to samodzielnie hostowana platforma komunikacji zespołowej; szczegóły produktu i pliki do pobrania znajdują się na oficjalnej stronie
[mattermost.com](https://mattermost.com).

## Wymagana wtyczka

Mattermost jest dostarczany jako wtyczka i nie jest dołączony do instalacji rdzenia.

Instalacja przez CLI (rejestr npm):

```bash
openclaw plugins install @openclaw/mattermost
```

Lokalna kopia robocza (gdy uruchamiane z repozytorium git):

```bash
openclaw plugins install ./extensions/mattermost
```

Jeśli podczas konfiguracji/onboardingu wybierzesz Mattermost i zostanie wykryta kopia git,
OpenClaw automatycznie zaproponuje lokalną ścieżkę instalacji.

Szczegóły: [Plugins](/tools/plugin)

## Szybka konfiguracja

1. Zainstaluj wtyczkę Mattermost.
2. Utwórz konto bota Mattermost i skopiuj **token bota**.
3. Skopiuj **bazowy URL** Mattermost (np. `https://chat.example.com`).
4. Skonfiguruj OpenClaw i uruchom gateway.

Minimalna konfiguracja:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Zmienne środowiskowe (konto domyślne)

Ustaw je na hoście gateway, jeśli wolisz zmienne środowiskowe:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Zmienne środowiskowe mają zastosowanie wyłącznie do konta **domyślnego** (`default`). Inne konta muszą używać wartości z konfiguracji.

## Tryby czatu

Mattermost odpowiada na DM-y automatycznie. Zachowanie w kanałach jest kontrolowane przez `chatmode`:

- `oncall` (domyślnie): odpowiada tylko po @wzmiance w kanałach.
- `onmessage`: odpowiada na każdą wiadomość w kanale.
- `onchar`: odpowiada, gdy wiadomość zaczyna się od prefiksu wyzwalacza.

Przykład konfiguracji:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Uwagi:

- `onchar` nadal odpowiada na jawne @wzmianki.
- `channels.mattermost.requireMention` jest honorowane dla starszych konfiguracji, ale preferowane jest `chatmode`.

## Kontrola dostępu (DM-y)

- Domyślnie: `channels.mattermost.dmPolicy = "pairing"` (nieznani nadawcy otrzymują kod parowania).
- Zatwierdzanie przez:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Publiczne DM-y: `channels.mattermost.dmPolicy="open"` plus `channels.mattermost.allowFrom=["*"]`.

## Kanały (grupy)

- Domyślnie: `channels.mattermost.groupPolicy = "allowlist"` (wymagana wzmianka).
- Lista dozwolonych nadawców przez `channels.mattermost.groupAllowFrom` (ID użytkowników lub `@username`).
- Otwarte kanały: `channels.mattermost.groupPolicy="open"` (wymagana wzmianka).

## Cele dostarczania wychodzącego

Użyj tych formatów celów z `openclaw message send` lub cron/webhookami:

- `channel:<id>` dla kanału
- `user:<id>` dla DM-a
- `@username` dla DM-a (rozwiązywane przez API Mattermost)

Same identyfikatory są traktowane jako kanały.

## Wiele kont

Mattermost obsługuje wiele kont w ramach `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Rozwiązywanie problemów

- Brak odpowiedzi w kanałach: upewnij się, że bot jest w kanale i wspomnij go (oncall), użyj prefiksu wyzwalacza (onchar) lub ustaw `chatmode: "onmessage"`.
- Błędy uwierzytelniania: sprawdź token bota, bazowy URL oraz czy konto jest włączone.
- Problemy z wieloma kontami: zmienne środowiskowe mają zastosowanie tylko do konta `default`.

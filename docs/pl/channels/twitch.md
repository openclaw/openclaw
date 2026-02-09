---
summary: "Konfiguracja i uruchomienie bota czatu Twitch"
read_when:
  - Konfiguracja integracji czatu Twitch dla OpenClaw
title: "Twitch"
---

# Twitch (wtyczka)

Obsługa czatu Twitch przez połączenie IRC. OpenClaw łączy się jako użytkownik Twitch (konto bota), aby odbierać i wysyłać wiadomości na kanałach.

## Wymagana wtyczka

Twitch jest dostarczany jako wtyczka i nie jest dołączony do instalacji podstawowej.

Instalacja przez CLI (rejestr npm):

```bash
openclaw plugins install @openclaw/twitch
```

Lokalne pobranie (podczas uruchamiania z repozytorium git):

```bash
openclaw plugins install ./extensions/twitch
```

Szczegóły: [Plugins](/tools/plugin)

## Szybka konfiguracja (dla początkujących)

1. Utwórz dedykowane konto Twitch dla bota (lub użyj istniejącego konta).
2. Wygeneruj poświadczenia: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Wybierz **Bot Token**
   - Upewnij się, że zaznaczone są zakresy `chat:read` i `chat:write`
   - Skopiuj **Client ID** oraz **Access Token**
3. Znajdź swój identyfikator użytkownika Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Skonfiguruj token:
   - Zmienna środowiskowa: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (tylko konto domyślne)
   - Lub konfiguracja: `channels.twitch.accessToken`
   - Jeśli ustawione są oba, konfiguracja ma pierwszeństwo (zmienna środowiskowa działa tylko dla konta domyślnego).
5. Uruchom gateway.

**⚠️ Ważne:** Dodaj kontrolę dostępu (`allowFrom` lub `allowedRoles`), aby zapobiec wyzwalaniu bota przez nieautoryzowanych użytkowników. `requireMention` domyślnie ma wartość `true`.

Minimalna konfiguracja:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Czym to jest

- Kanał Twitch należący do Gateway.
- Deterministyczne routowanie: odpowiedzi zawsze wracają do Twitch.
- Każde konto mapuje się na izolowany klucz sesji `agent:<agentId>:twitch:<accountName>`.
- `username` to konto bota (które się uwierzytelnia), a `channel` to pokój czatu, do którego należy dołączyć.

## Konfiguracja (szczegółowa)

### Generowanie poświadczeń

Użyj [Twitch Token Generator](https://twitchtokengenerator.com/):

- Wybierz **Bot Token**
- Upewnij się, że zaznaczone są zakresy `chat:read` i `chat:write`
- Skopiuj **Client ID** oraz **Access Token**

Nie jest wymagana ręczna rejestracja aplikacji. Tokeny wygasają po kilku godzinach.

### Konfiguracja bota

**Zmienna środowiskowa (tylko konto domyślne):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Lub konfiguracja:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Jeśli ustawione są zarówno zmienna środowiskowa, jak i konfiguracja, pierwszeństwo ma konfiguracja.

### Kontrola dostępu (zalecane)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Preferuj `allowFrom` dla twardej listy dozwolonych. Użyj `allowedRoles` zamiast tego, jeśli chcesz kontroli dostępu opartej na rolach.

**Dostępne role:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Dlaczego identyfikatory użytkowników?** Nazwy użytkowników mogą się zmieniać, co umożliwia podszywanie się. Identyfikatory użytkowników są trwałe.

Znajdź swój identyfikator użytkownika Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Konwersja nazwy użytkownika Twitch na ID)

## Odświeżanie tokenu (opcjonalne)

Tokeny z [Twitch Token Generator](https://twitchtokengenerator.com/) nie mogą być automatycznie odświeżane — należy je regenerować po wygaśnięciu.

Aby włączyć automatyczne odświeżanie tokenów, utwórz własną aplikację Twitch w [Twitch Developer Console](https://dev.twitch.tv/console) i dodaj ją do konfiguracji:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

Bot automatycznie odświeża tokeny przed ich wygaśnięciem i zapisuje zdarzenia odświeżania w logach.

## Obsługa wielu kont

Użyj `channels.twitch.accounts` z tokenami przypisanymi do poszczególnych kont. Zobacz [`gateway/configuration`](/gateway/configuration) dla wspólnego wzorca.

Przykład (jedno konto bota na dwóch kanałach):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Uwaga:** Każde konto wymaga własnego tokenu (jeden token na kanał).

## Kontrola dostępu

### Ograniczenia oparte na rolach

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Lista dozwolonych według ID użytkownika (najbezpieczniejsze)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Dostęp oparty na rolach (alternatywa)

`allowFrom` to twarda lista dozwolonych. Gdy jest ustawiona, dozwolone są wyłącznie te identyfikatory użytkowników.
Jeśli chcesz dostępu opartego na rolach, pozostaw `allowFrom` nieustawione i skonfiguruj zamiast tego `allowedRoles`:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Wyłącz wymóg @mention

Domyślnie `requireMention` ma wartość `true`. Aby wyłączyć i odpowiadać na wszystkie wiadomości:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Rozwiązywanie problemów

Najpierw uruchom polecenia diagnostyczne:

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot nie odpowiada na wiadomości

**Sprawdź kontrolę dostępu:** Upewnij się, że Twój identyfikator użytkownika znajduje się w `allowFrom`, lub tymczasowo usuń
`allowFrom` i ustaw `allowedRoles: ["all"]` w celu testów.

**Sprawdź, czy bot jest na kanale:** Bot musi dołączyć do kanału określonego w `channel`.

### Problemy z tokenem

**„Failed to connect” lub błędy uwierzytelniania:**

- Sprawdź, czy `accessToken` jest wartością tokenu dostępu OAuth (zwykle zaczyna się od prefiksu `oauth:`)
- Sprawdź, czy token ma zakresy `chat:read` i `chat:write`
- Jeśli używasz odświeżania tokenu, upewnij się, że ustawione są `clientSecret` i `refreshToken`

### Odświeżanie tokenu nie działa

**Sprawdź logi pod kątem zdarzeń odświeżania:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Jeśli widzisz „token refresh disabled (no refresh token)”:

- Upewnij się, że podano `clientSecret`
- Upewnij się, że podano `refreshToken`

## Konfiguracja

**Konfiguracja konta:**

- `username` — nazwa użytkownika bota
- `accessToken` — token dostępu OAuth z zakresami `chat:read` i `chat:write`
- `clientId` — identyfikator klienta Twitch (z Token Generator lub własnej aplikacji)
- `channel` — kanał do dołączenia (wymagane)
- `enabled` — włączenie tego konta (domyślnie: `true`)
- `clientSecret` — opcjonalne: do automatycznego odświeżania tokenu
- `refreshToken` — opcjonalne: do automatycznego odświeżania tokenu
- `expiresIn` — czas wygaśnięcia tokenu w sekundach
- `obtainmentTimestamp` — znacznik czasu uzyskania tokenu
- `allowFrom` — lista dozwolonych identyfikatorów użytkowników
- `allowedRoles` — kontrola dostępu oparta na rolach (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` — wymaganie @wzmianki (domyślnie: `true`)

**Opcje dostawcy:**

- `channels.twitch.enabled` — włączenie/wyłączenie uruchamiania kanału
- `channels.twitch.username` — nazwa użytkownika bota (uproszczona konfiguracja jednego konta)
- `channels.twitch.accessToken` — token dostępu OAuth (uproszczona konfiguracja jednego konta)
- `channels.twitch.clientId` — identyfikator klienta Twitch (uproszczona konfiguracja jednego konta)
- `channels.twitch.channel` — kanał do dołączenia (uproszczona konfiguracja jednego konta)
- `channels.twitch.accounts.<accountName>` — konfiguracja wielu kont (wszystkie pola kont powyżej)

Pełny przykład:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Akcje narzędzia

Agent może wywołać `twitch` z akcją:

- `send` — wysłanie wiadomości na kanał

Przykład:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Bezpieczeństwo i operacje

- **Traktuj tokeny jak hasła** — nigdy nie commituj tokenów do git
- **Używaj automatycznego odświeżania tokenów** dla botów działających długotrwale
- **Używaj list dozwolonych identyfikatorów użytkowników** zamiast nazw użytkowników do kontroli dostępu
- **Monitoruj logi** pod kątem zdarzeń odświeżania tokenów i stanu połączenia
- **Ogranicz zakresy tokenów do minimum** — żądaj tylko `chat:read` i `chat:write`
- **Jeśli utkniesz**: Zrestartuj gateway po potwierdzeniu, że żaden inny proces nie jest właścicielem sesji

## Limity

- **500 znaków** na wiadomość (automatyczne dzielenie na granicach słów)
- Markdown jest usuwany przed dzieleniem
- Brak limitowania po stronie aplikacji (wykorzystywane są wbudowane limity Twitch)

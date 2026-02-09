---
summary: "„Kanał DM Nostr przez zaszyfrowane wiadomości NIP-04”"
read_when:
  - Chcesz, aby OpenClaw odbierał DM-y przez Nostr
  - Konfigurujesz zdecentralizowane komunikowanie
title: "Nostr"
---

# Nostr

**Status:** Opcjonalna wtyczka (domyślnie wyłączona).

Nostr to zdecentralizowany protokół sieci społecznościowych. Ten kanał umożliwia OpenClaw odbieranie i odpowiadanie na zaszyfrowane wiadomości bezpośrednie (DM-y) przez NIP-04.

## Instalacja (na żądanie)

### Onboarding (zalecane)

- Kreator onboardingu (`openclaw onboard`) oraz `openclaw channels add` wyświetlają opcjonalne wtyczki kanałów.
- Wybranie Nostr spowoduje instalację wtyczki na żądanie.

Domyślne tryby instalacji:

- **Kanał Dev + dostępny checkout git:** używa lokalnej ścieżki wtyczki.
- **Stable/Beta:** pobiera z npm.

Wybór można zawsze nadpisać w monicie.

### Instalacja ręczna

```bash
openclaw plugins install @openclaw/nostr
```

Użycie lokalnego checkoutu (przepływy dev):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Po zainstalowaniu lub włączeniu wtyczek zrestartuj Gateway.

## Szybka konfiguracja

1. Wygeneruj parę kluczy Nostr (jeśli potrzebne):

```bash
# Using nak
nak key generate
```

2. Dodaj do konfiguracji:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Wyeksportuj klucz:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Zrestartuj Gateway.

## Referencja konfiguracji

| Klucz        | Typ                                                          | Domyślna                                    | Opis                                        |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------- |
| `privateKey` | string                                                       | wymagane                                    | Klucz prywatny w formacie `nsec` lub hex    |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Adresy relay (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | Polityka dostępu do DM-ów                   |
| `allowFrom`  | string[] | `[]`                                        | Dozwolone klucze publiczne nadawców         |
| `enabled`    | boolean                                                      | `true`                                      | Włącz/wyłącz kanał                          |
| `name`       | string                                                       | -                                           | Nazwa wyświetlana                           |
| `profile`    | object                                                       | -                                           | Metadane profilu NIP-01                     |

## Metadane profilu

Dane profilu są publikowane jako zdarzenie NIP-01 `kind:0`. Możesz nimi zarządzać z poziomu Control UI (Channels -> Nostr -> Profile) albo ustawić je bezpośrednio w konfiguracji.

Przykład:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Uwagi:

- Adresy URL profilu muszą używać `https://`.
- Import z relayów scala pola i zachowuje lokalne nadpisania.

## Kontrola dostępu

### Polityki DM-ów

- **pairing** (domyślne): nieznani nadawcy otrzymują kod parowania.
- **allowlist**: DM-y mogą wysyłać tylko klucze publiczne z `allowFrom`.
- **open**: publiczne przychodzące DM-y (wymaga `allowFrom: ["*"]`).
- **disabled**: ignoruj przychodzące DM-y.

### Przykład allowlisty

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Formaty kluczy

Akceptowane formaty:

- **Klucz prywatny:** `nsec...` lub 64-znakowy hex
- **Klucze publiczne (`allowFrom`):** `npub...` lub hex

## Relaye

Domyślne: `relay.damus.io` oraz `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

Wskazówki:

- Używaj 2–3 relayów dla redundancji.
- Unikaj zbyt wielu relayów (opóźnienia, duplikacja).
- Płatne relaye mogą poprawić niezawodność.
- Lokalne relaye są w porządku do testów (`ws://localhost:7777`).

## Obsługa protokołów

| NIP    | Status      | Opis                                            |
| ------ | ----------- | ----------------------------------------------- |
| NIP-01 | Obsługiwane | Podstawowy format zdarzeń + metadane profilu    |
| NIP-04 | Obsługiwane | Zaszyfrowane DM-y (`kind:4`) |
| NIP-17 | Planowane   | DM-y w „gift-wrap”                              |
| NIP-44 | Planowane   | Wersjonowane szyfrowanie                        |

## Testowanie

### Lokalny relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Test ręczny

1. Zanotuj klucz publiczny bota (npub) z logów.
2. Otwórz klienta Nostr (Damus, Amethyst itd.).
3. Wyślij DM do klucza publicznego bota.
4. Zweryfikuj odpowiedź.

## Rozwiązywanie problemów

### Nie odbiera wiadomości

- Sprawdź, czy klucz prywatny jest prawidłowy.
- Upewnij się, że adresy relayów są osiągalne i używają `wss://` (lub `ws://` dla lokalnych).
- Potwierdź, że `enabled` nie jest `false`.
- Sprawdź logi Gateway pod kątem błędów połączeń z relayami.

### Nie wysyła odpowiedzi

- Sprawdź, czy relay akceptuje zapisy.
- Zweryfikuj łączność wychodzącą.
- Zwróć uwagę na limity szybkości relayów.

### Zduplikowane odpowiedzi

- Oczekiwane przy użyciu wielu relayów.
- Wiadomości są deduplikowane według identyfikatora zdarzenia; tylko pierwsze dostarczenie wyzwala odpowiedź.

## Bezpieczeństwo

- Nigdy nie commituj kluczy prywatnych.
- Używaj zmiennych środowiskowych dla kluczy.
- Rozważ `allowlist` dla botów produkcyjnych.

## Ograniczenia (MVP)

- Tylko wiadomości bezpośrednie (brak czatów grupowych).
- Brak załączników multimedialnych.
- Tylko NIP-04 (planowany gift-wrap NIP-17).

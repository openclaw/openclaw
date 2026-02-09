---
summary: "Status wsparcia Tlon/Urbit, możliwości i konfiguracja"
read_when:
  - Praca nad funkcjami kanału Tlon/Urbit
title: "Tlon"
---

# Tlon (wtyczka)

Tlon to zdecentralizowany komunikator zbudowany na Urbit. OpenClaw łączy się z Twoim statkiem Urbit i może
odpowiadać na DM-y oraz wiadomości na czatach grupowych. Odpowiedzi w grupach domyślnie wymagają wzmianki @ i mogą
być dodatkowo ograniczone za pomocą list dozwolonych.

Status: obsługiwane przez wtyczkę. DM-y, wzmianki w grupach, odpowiedzi w wątkach oraz zastępcza obsługa mediów tylko tekstowych
(URL dołączony do podpisu). Reakcje, ankiety oraz natywne przesyłanie multimediów nie są obsługiwane.

## Wymagana wtyczka

Tlon jest dostarczany jako wtyczka i nie jest dołączony do instalacji rdzenia.

Instalacja przez CLI (rejestr npm):

```bash
openclaw plugins install @openclaw/tlon
```

Lokalne sprawdzenie (przy uruchamianiu z repozytorium git):

```bash
openclaw plugins install ./extensions/tlon
```

Szczegóły: [Plugins](/tools/plugin)

## Konfiguracja

1. Zainstaluj wtyczkę Tlon.
2. Zbierz adres URL swojego statku oraz kod logowania.
3. Skonfiguruj `channels.tlon`.
4. Zrestartuj gateway.
5. Wyślij DM do bota lub oznacz go wzmianką w kanale grupowym.

Minimalna konfiguracja (jedno konto):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Kanały grupowe

Automatyczne wykrywanie jest domyślnie włączone. Kanały można także przypinać ręcznie:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Wyłączenie automatycznego wykrywania:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Kontrola dostępu

Lista dozwolonych DM-ów (pusta = zezwól wszystkim):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Autoryzacja grup (domyślnie ograniczona):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Cele dostarczania (CLI/cron)

Używaj ich z `openclaw message send` lub z dostarczaniem przez cron:

- DM: `~sampel-palnet` lub `dm/~sampel-palnet`
- Grupa: `chat/~host-ship/channel` lub `group:~host-ship/channel`

## Uwagi

- Odpowiedzi w grupach wymagają wzmianki (np. `~your-bot-ship`), aby odpowiedzieć.
- Odpowiedzi w wątkach: jeśli wiadomość przychodząca jest w wątku, OpenClaw odpowiada w tym samym wątku.
- Media: `sendMedia` przełącza się na tekst + URL (bez natywnego przesyłania).

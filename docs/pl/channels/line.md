---
summary: "„Konfiguracja, ustawienia i użycie wtyczki LINE Messaging API”"
read_when:
  - Chcesz połączyć OpenClaw z LINE
  - Potrzebujesz konfiguracji webhooka i poświadczeń LINE
  - Chcesz używać opcji wiadomości specyficznych dla LINE
title: LINE
---

# LINE (wtyczka)

LINE łączy się z OpenClaw za pośrednictwem LINE Messaging API. Wtyczka działa jako
odbiornik webhooków na gateway i używa tokenu dostępu do kanału oraz sekretu kanału
do uwierzytelniania.

Status: obsługiwane przez wtyczkę. Obsługiwane są wiadomości bezpośrednie, czaty
grupowe, multimedia, lokalizacje, wiadomości Flex, wiadomości szablonowe oraz szybkie
odpowiedzi. Reakcje i wątki nie są obsługiwane.

## Wymagana wtyczka

Zainstaluj wtyczkę LINE:

```bash
openclaw plugins install @openclaw/line
```

Lokalne repozytorium (przy uruchamianiu z repozytorium git):

```bash
openclaw plugins install ./extensions/line
```

## Konfiguracja

1. Utwórz konto LINE Developers i otwórz konsolę:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Utwórz (lub wybierz) Providera i dodaj kanał **Messaging API**.
3. Skopiuj **Channel access token** oraz **Channel secret** z ustawień kanału.
4. Włącz **Use webhook** w ustawieniach Messaging API.
5. Ustaw adres URL webhooka na punkt końcowy gateway (wymagane HTTPS):

```
https://gateway-host/line/webhook
```

Gateway odpowiada na weryfikację webhooka LINE (GET) oraz zdarzenia przychodzące (POST).
Jeśli potrzebujesz niestandardowej ścieżki, ustaw `channels.line.webhookPath` lub
`channels.line.accounts.<id>.webhookPath` i odpowiednio zaktualizuj adres URL.

## Konfiguracja

Minimalna konfiguracja:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Zmienne środowiskowe (tylko konto domyślne):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Pliki tokenu/sekretu:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Wiele kont:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Kontrola dostępu

Wiadomości bezpośrednie domyślnie wymagają parowania. Nieznani nadawcy otrzymują kod
parowania, a ich wiadomości są ignorowane do czasu zatwierdzenia.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Listy dozwolonych i polityki:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: dozwolone identyfikatory użytkowników LINE dla DM-ów
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: dozwolone identyfikatory użytkowników LINE dla grup
- Nadpisania per grupa: `channels.line.groups.<groupId>.allowFrom`

Identyfikatory LINE są rozróżniane wielkością liter. Prawidłowe identyfikatory mają postać:

- Użytkownik: `U` + 32 znaki szesnastkowe
- Grupa: `C` + 32 znaki szesnastkowe
- Pokój: `R` + 32 znaki szesnastkowe

## Zachowanie wiadomości

- Tekst jest dzielony na fragmenty po 5000 znaków.
- Formatowanie Markdown jest usuwane; bloki kodu i tabele są konwertowane do kart
  Flex, gdy to możliwe.
- Odpowiedzi strumieniowane są buforowane; LINE otrzymuje pełne fragmenty z animacją
  ładowania, podczas gdy agent pracuje.
- Pobieranie multimediów jest ograniczone przez `channels.line.mediaMaxMb` (domyślnie 10).

## Dane kanału (wiadomości bogate)

Użyj `channelData.line`, aby wysyłać szybkie odpowiedzi, lokalizacje, karty Flex lub
wiadomości szablonowe.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

Wtyczka LINE zawiera także polecenie `/card` dla presetów wiadomości Flex:

```
/card info "Welcome" "Thanks for joining!"
```

## Rozwiązywanie problemów

- **Weryfikacja webhooka nie powiodła się:** upewnij się, że adres URL webhooka używa
  HTTPS oraz że `channelSecret` jest zgodny z konsolą LINE.
- **Brak zdarzeń przychodzących:** potwierdź, że ścieżka webhooka odpowiada
  `channels.line.webhookPath` oraz że gateway jest osiągalny z LINE.
- **Błędy pobierania multimediów:** zwiększ `channels.line.mediaMaxMb`, jeśli multimedia
  przekraczają domyślny limit.

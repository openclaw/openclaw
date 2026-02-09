---
summary: "Szybkie rozwiązywanie problemów na poziomie kanału z charakterystycznymi sygnaturami awarii i poprawkami dla poszczególnych kanałów"
read_when:
  - Transport kanału pokazuje połączenie, ale odpowiedzi nie działają
  - Potrzebne są kontrole specyficzne dla kanału przed sięgnięciem po szczegółową dokumentację dostawcy
title: "Rozwiązywanie problemów z kanałami"
---

# Rozwiązywanie problemów z kanałami

Użyj tej strony, gdy kanał się łączy, ale zachowanie jest nieprawidłowe.

## Drabina poleceń

Najpierw uruchom je w tej kolejności:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Zdrowa linia bazowa:

- `Runtime: running`
- `RPC probe: ok`
- Sonda kanału pokazuje stan połączony/gotowy

## WhatsApp

### Sygnatury awarii WhatsApp

| Objaw                                        | Najszybsza kontrola                                       | Naprawa                                                                                         |
| -------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Połączony, ale brak odpowiedzi w DM          | `openclaw pairing list whatsapp`                          | Zatwierdź nadawcę lub zmień politykę DM/listę dozwolonych.                      |
| Ignorowane wiadomości grupowe                | Sprawdź `requireMention` + wzorce wzmianek w konfiguracji | Wspomnij bota lub poluzuj politykę wzmianek dla tej grupy.                      |
| Losowe rozłączenia/pętle ponownego logowania | `openclaw channels status --probe` + logi                 | Zaloguj się ponownie i zweryfikuj, że katalog poświadczeń jest w dobrym stanie. |

Pełne rozwiązywanie problemów: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Sygnatury awarii Telegram

| Objaw                                              | Najszybsza kontrola                                     | Naprawa                                                                             |
| -------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `/start` ale brak użytecznego przepływu odpowiedzi | `openclaw pairing list telegram`                        | Zatwierdź parowanie lub zmień politykę DM.                          |
| Bot online, ale grupa pozostaje cicha              | Zweryfikuj wymóg wzmianek i tryb prywatności bota       | Wyłącz tryb prywatności dla widoczności w grupie lub wspomnij bota. |
| Błędy wysyłania z błędami sieci                    | Sprawdź logi pod kątem niepowodzeń wywołań API Telegram | Napraw routowanie DNS/IPv6/proxy do `api.telegram.org`.             |

Pełne rozwiązywanie problemów: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Sygnatury awarii Discord

| Objaw                                       | Najszybsza kontrola                                | Naprawa                                                                                      |
| ------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Bot online, ale brak odpowiedzi na serwerze | `openclaw channels status --probe`                 | Zezwól serwerowi/kanałowi i zweryfikuj uprawnienie „Message Content Intent”. |
| Ignorowane wiadomości grupowe               | Sprawdzaj dzienniki dla wzmianek o kroplach bramki | Wspomnij bota lub ustaw `requireMention: false` dla serwera/kanału.          |
| Brak odpowiedzi w DM                        | `openclaw pairing list discord`                    | Zatwierdź parowanie DM lub dostosuj politykę DM.                             |

Pełne rozwiązywanie problemów: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Sygnatury awarii Slack

| Objaw                                      | Najszybsza kontrola                               | Naprawa                                                                        |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Tryb Socket połączony, ale brak odpowiedzi | `openclaw channels status --probe`                | Zweryfikuj token aplikacji + token bota oraz wymagane zakresy. |
| Zablokowane DM                             | `openclaw pairing list slack`                     | Zatwierdź parowanie lub poluzuj politykę DM.                   |
| Ignorowana wiadomość na kanale             | Sprawdź `groupPolicy` i listę dozwolonych kanałów | Zezwól na kanał lub zmień politykę na `open`.                  |

Pełne rozwiązywanie problemów: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage i BlueBubbles

### Sygnatury awarii iMessage i BlueBubbles

| Objaw                                    | Najszybsza kontrola                                                      | Naprawa                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Brak zdarzeń przychodzących              | Zweryfikuj osiągalność webhooka/serwera oraz uprawnienia aplikacji       | Napraw adres URL webhooka lub stan serwera BlueBubbles.          |
| Można wysyłać, ale brak odbioru na macOS | Sprawdź uprawnienia prywatności macOS dla automatyzacji Wiadomości       | Ponownie nadaj uprawnienia TCC i uruchom ponownie proces kanału. |
| Zablokowany nadawca DM                   | `openclaw pairing list imessage` lub `openclaw pairing list bluebubbles` | Zatwierdź parowanie lub zaktualizuj listę dozwolonych.           |

Pełne rozwiązywanie problemów:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Sygnatury awarii Signal

| Objaw                                 | Najszybsza kontrola                              | Naprawa                                                                           |
| ------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Demon osiągalny, ale bot milczy       | `openclaw channels status --probe`               | Zweryfikuj adres URL/konto demona `signal-cli` oraz tryb odbioru. |
| Zablokowane DM                        | `openclaw pairing list signal`                   | Zatwierdź nadawcę lub dostosuj politykę DM.                       |
| Odpowiedzi w grupach nie są wyzwalane | Sprawdź listę dozwolonych grup i wzorce wzmianek | Dodaj nadawcę/grupę lub poluzuj bramkowanie.                      |

Pełne rozwiązywanie problemów: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Sygnatury awarii Matrix

| Objaw                                        | Najszybsza kontrola                                       | Naprawa                                                                          |
| -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Zalogowany, ale ignoruje wiadomości w pokoju | `openclaw channels status --probe`                        | Sprawdź `groupPolicy` i listę dozwolonych pokoi.                 |
| DM nie są przetwarzane                       | `openclaw pairing list matrix`                            | Zatwierdź nadawcę lub dostosuj politykę DM.                      |
| Zaszyfrowane pokoje nie działają             | Zweryfikuj moduł kryptograficzny i ustawienia szyfrowania | Włącz obsługę szyfrowania i ponownie dołącz/zsynchronizuj pokój. |

Pełne rozwiązywanie problemów: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)

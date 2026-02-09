---
summary: "Status obsługi bota Zalo, możliwości i konfiguracja"
read_when:
  - Praca nad funkcjami Zalo lub webhookami
title: "Zalo"
---

# Zalo (Bot API)

Status: eksperymentalny. Tylko wiadomości bezpośrednie; grupy wkrótce zgodnie z dokumentacją Zalo.

## Wymagana wtyczka

Zalo jest dostarczane jako wtyczka i nie jest dołączone do instalacji rdzenia.

- Instalacja przez CLI: `openclaw plugins install @openclaw/zalo`
- Lub wybierz **Zalo** podczas onboardingu i potwierdź monit instalacji
- Szczegóły: [Plugins](/tools/plugin)

## Szybka konfiguracja (dla początkujących)

1. Zainstaluj wtyczkę Zalo:
   - Z checkoutu źródeł: `openclaw plugins install ./extensions/zalo`
   - Z npm (jeśli opublikowana): `openclaw plugins install @openclaw/zalo`
   - Lub wybierz **Zalo** w onboardingu i potwierdź monit instalacji
2. Ustaw token:
   - Wpis: `ZALO_BOT_TOKEN=...`
   - Lub konfiguracja: `channels.zalo.botToken: "..."`.
3. Zrestartuj gateway (lub zakończ onboarding).
4. Dostęp do DM-ów domyślnie wymaga parowania; zatwierdź kod parowania przy pierwszym kontakcie.

Minimalna konfiguracja:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Czym to jest

Zalo to komunikator skoncentrowany na Wietnamie; jego Bot API pozwala Gateway uruchamiać bota do rozmów 1:1.
To dobre rozwiązanie do wsparcia lub powiadomień, gdy potrzebne jest deterministyczne kierowanie odpowiedzi z powrotem do Zalo.

- Kanał Zalo Bot API należący do Gateway.
- Deterministyczne trasowanie: odpowiedzi wracają do Zalo; model nigdy nie wybiera kanałów.
- DM-y współdzielą główną sesję agenta.
- Grupy nie są jeszcze obsługiwane (dokumentacja Zalo wskazuje „coming soon”).

## Konfiguracja (szybka ścieżka)

### 1. Utwórz token bota (Zalo Bot Platform)

1. Przejdź do [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) i zaloguj się.
2. Utwórz nowego bota i skonfiguruj jego ustawienia.
3. Skopiuj token bota (format: `12345689:abc-xyz`).

### 2) Skonfiguruj token (env lub config)

Przykład:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Opcja env: `ZALO_BOT_TOKEN=...` (działa tylko dla konta domyślnego).

Obsługa wielu kont: użyj `channels.zalo.accounts` z tokenami per konto oraz opcjonalnie `name`.

3. Zrestartuj gateway. Zalo uruchamia się, gdy token zostanie rozpoznany (env lub config).
4. Dostęp do DM-ów domyślnie wymaga parowania. Zatwierdź kod przy pierwszym kontakcie z botem.

## Jak to działa (zachowanie)

- Wiadomości przychodzące są normalizowane do wspólnej koperty kanału z placeholderami mediów.
- Odpowiedzi zawsze wracają do tej samej rozmowy Zalo.
- Domyślnie długie odpytywanie (long-polling); tryb webhook dostępny z `channels.zalo.webhookUrl`.

## Limity

- Tekst wychodzący jest dzielony na fragmenty po 2000 znaków (limit API Zalo).
- Pobieranie/wysyłanie mediów jest ograniczone przez `channels.zalo.mediaMaxMb` (domyślnie 5).
- Strumieniowanie jest domyślnie zablokowane, ponieważ limit 2000 znaków czyni je mniej użytecznym.

## Kontrola dostępu (DM-y)

### Dostęp do DM-ów

- Domyślnie: `channels.zalo.dmPolicy = "pairing"`. Nieznani nadawcy otrzymują kod parowania; wiadomości są ignorowane do czasu zatwierdzenia (kody wygasają po 1 godzinie).
- Zatwierdzanie przez:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Parowanie jest domyślną wymianą tokenów. Szczegóły: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` akceptuje numeryczne identyfikatory użytkowników (brak wyszukiwania po nazwie użytkownika).

## Long-polling vs webhook

- Domyślnie: long-polling (nie wymaga publicznego URL).
- Tryb webhook: ustaw `channels.zalo.webhookUrl` i `channels.zalo.webhookSecret`.
  - Sekret webhooka musi mieć 8–256 znaków.
  - URL webhooka musi używać HTTPS.
  - Zalo wysyła zdarzenia z nagłówkiem `X-Bot-Api-Secret-Token` do weryfikacji.
  - HTTP Gateway obsługuje żądania webhooka pod `channels.zalo.webhookPath` (domyślnie ścieżka URL webhooka).

**Uwaga:** getUpdates (polling) i webhook są wzajemnie wykluczające się zgodnie z dokumentacją API Zalo.

## Obsługiwane typy wiadomości

- **Wiadomości tekstowe**: pełna obsługa z dzieleniem na 2000 znaków.
- **Wiadomości z obrazami**: pobieranie i przetwarzanie obrazów przychodzących; wysyłanie obrazów przez `sendPhoto`.
- **Naklejki**: rejestrowane, ale nie w pełni przetwarzane (brak odpowiedzi agenta).
- **Typy nieobsługiwane**: rejestrowane (np. wiadomości od użytkowników chronionych).

## Możliwości

| Funkcja                           | Status                                                |
| --------------------------------- | ----------------------------------------------------- |
| Wiadomości bezpośrednie           | ✅ Obsługiwane                                         |
| Grupy                             | ❌ Wkrótce (wg dokumentacji Zalo)   |
| Media (obrazy) | ✅ Obsługiwane                                         |
| Reakcje                           | ❌ Nieobsługiwane                                      |
| Wątki                             | ❌ Nieobsługiwane                                      |
| Ankiety                           | ❌ Nieobsługiwane                                      |
| Polecenia natywne                 | ❌ Nieobsługiwane                                      |
| Strumieniowanie                   | ⚠️ Zablokowane (limit 2000 znaków) |

## Cele dostarczania (CLI/cron)

- Użyj identyfikatora czatu jako celu.
- Przykład: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Rozwiązywanie problemów

**Bot nie odpowiada:**

- Sprawdź, czy token jest prawidłowy: `openclaw channels status --probe`
- Zweryfikuj, czy nadawca jest zatwierdzony (parowanie lub allowFrom)
- Sprawdź logi gateway: `openclaw logs --follow`

**Webhook nie odbiera zdarzeń:**

- Upewnij się, że URL webhooka używa HTTPS
- Zweryfikuj, że sekret ma 8–256 znaków
- Potwierdź, że punkt końcowy HTTP gateway jest osiągalny na skonfigurowanej ścieżce
- Sprawdź, czy polling getUpdates nie jest uruchomiony (są wzajemnie wykluczające się)

## Referencja konfiguracji (Zalo)

Pełna konfiguracja: [Configuration](/gateway/configuration)

Opcje dostawcy:

- `channels.zalo.enabled`: włącz/wyłącz uruchamianie kanału.
- `channels.zalo.botToken`: token bota z Zalo Bot Platform.
- `channels.zalo.tokenFile`: odczyt tokena z pliku.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (domyślnie: parowanie).
- `channels.zalo.allowFrom`: lista dozwolonych DM-ów (identyfikatory użytkowników). `open` wymaga `"*"`. Kreator poprosi o identyfikatory numeryczne.
- `channels.zalo.mediaMaxMb`: limit mediów przychodzących/wychodzących (MB, domyślnie 5).
- `channels.zalo.webhookUrl`: włącz tryb webhook (wymagany HTTPS).
- `channels.zalo.webhookSecret`: sekret webhooka (8–256 znaków).
- `channels.zalo.webhookPath`: ścieżka webhooka na serwerze HTTP gateway.
- `channels.zalo.proxy`: URL proxy dla żądań API.

Opcje wielu kont:

- `channels.zalo.accounts.<id>.botToken`: token per konto.
- `channels.zalo.accounts.<id>.tokenFile`: plik tokena per konto.
- `channels.zalo.accounts.<id>.name`: nazwa wyświetlana.
- `channels.zalo.accounts.<id>.enabled`: włącz/wyłącz konto.
- `channels.zalo.accounts.<id>.dmPolicy`: polityka DM per konto.
- `channels.zalo.accounts.<id>.allowFrom`: lista dozwolonych per konto.
- `channels.zalo.accounts.<id>.webhookUrl`: URL webhooka per konto.
- `channels.zalo.accounts.<id>.webhookSecret`: sekret webhooka per konto.
- `channels.zalo.accounts.<id>.webhookPath`: ścieżka webhooka per konto.
- `channels.zalo.accounts.<id>.proxy`: URL proxy per konto.

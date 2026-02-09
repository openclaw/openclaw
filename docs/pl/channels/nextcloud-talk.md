---
summary: "Status wsparcia Nextcloud Talk, możliwości i konfiguracja"
read_when:
  - Prace nad funkcjami kanału Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (wtyczka)

Status: obsługiwany przez wtyczkę (bot webhook). Obsługiwane są wiadomości bezpośrednie, pokoje, reakcje oraz wiadomości w Markdown.

## Wymagana wtyczka

Nextcloud Talk jest dostarczany jako wtyczka i nie jest dołączony do instalacji podstawowej.

Instalacja przez CLI (rejestr npm):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Lokalne pobranie (przy uruchamianiu z repozytorium git):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Jeśli podczas konfiguracji/onboardingu wybierzesz Nextcloud Talk i zostanie wykryte pobranie z gita,
OpenClaw automatycznie zaproponuje lokalną ścieżkę instalacji.

Szczegóły: [Plugins](/tools/plugin)

## Szybka konfiguracja (dla początkujących)

1. Zainstaluj wtyczkę Nextcloud Talk.

2. Na serwerze Nextcloud utwórz bota:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Włącz bota w ustawieniach docelowego pokoju.

4. Skonfiguruj OpenClaw:
   - Konfiguracja: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Lub zmienne środowiskowe: `NEXTCLOUD_TALK_BOT_SECRET` (tylko konto domyślne)

5. Uruchom ponownie gateway (lub zakończ onboarding).

Minimalna konfiguracja:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Uwagi

- Boty nie mogą inicjować DM-ów. Użytkownik musi najpierw napisać do bota.
- Adres URL webhooka musi być osiągalny przez Gateway; ustaw `webhookPublicUrl`, jeśli jesteś za proxy.
- Przesyłanie multimediów nie jest obsługiwane przez API bota; media są wysyłane jako adresy URL.
- Payload webhooka nie rozróżnia DM-ów i pokoi; ustaw `apiUser` + `apiPassword`, aby włączyć wyszukiwanie typu pokoju (w przeciwnym razie DM-y są traktowane jak pokoje).

## Kontrola dostępu (DM-y)

- Domyślnie: `channels.nextcloud-talk.dmPolicy = "pairing"`. Nieznani nadawcy otrzymują kod parowania.
- Zatwierdzanie przez:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Publiczne DM-y: `channels.nextcloud-talk.dmPolicy="open"` oraz `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` dopasowuje wyłącznie identyfikatory użytkowników Nextcloud; nazwy wyświetlane są ignorowane.

## Pokoje (grupy)

- Domyślnie: `channels.nextcloud-talk.groupPolicy = "allowlist"` (wymagane wzmianki).
- Lista dozwolonych pokoi za pomocą `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Aby nie zezwalać na żadne pokoje, pozostaw listę dozwolonych pustą lub ustaw `channels.nextcloud-talk.groupPolicy="disabled"`.

## Możliwości

| Funkcja                 | Status         |
| ----------------------- | -------------- |
| Wiadomości bezpośrednie | Obsługiwane    |
| Pokoje                  | Obsługiwane    |
| Wątki                   | Nieobsługiwane |
| Multimedia              | Tylko URL      |
| Reakcje                 | Obsługiwane    |
| Polecenia natywne       | Nieobsługiwane |

## Referencja konfiguracji (Nextcloud Talk)

Pełna konfiguracja: [Configuration](/gateway/configuration)

Opcje dostawcy:

- `channels.nextcloud-talk.enabled`: włącz/wyłącz uruchamianie kanału.
- `channels.nextcloud-talk.baseUrl`: adres URL instancji Nextcloud.
- `channels.nextcloud-talk.botSecret`: współdzielony sekret bota.
- `channels.nextcloud-talk.botSecretFile`: ścieżka do pliku sekretu.
- `channels.nextcloud-talk.apiUser`: użytkownik API do wyszukiwania pokoi (wykrywanie DM-ów).
- `channels.nextcloud-talk.apiPassword`: hasło API/aplikacji do wyszukiwania pokoi.
- `channels.nextcloud-talk.apiPasswordFile`: ścieżka do pliku hasła API.
- `channels.nextcloud-talk.webhookPort`: port nasłuchu webhooka (domyślnie: 8788).
- `channels.nextcloud-talk.webhookHost`: host webhooka (domyślnie: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: ścieżka webhooka (domyślnie: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: zewnętrznie osiągalny adres URL webhooka.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: lista dozwolonych DM-ów (identyfikatory użytkowników). `open` wymaga `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: lista dozwolonych grup (identyfikatory użytkowników).
- `channels.nextcloud-talk.rooms`: ustawienia per pokój i lista dozwolonych.
- `channels.nextcloud-talk.historyLimit`: limit historii grup (0 wyłącza).
- `channels.nextcloud-talk.dmHistoryLimit`: limit historii DM-ów (0 wyłącza).
- `channels.nextcloud-talk.dms`: nadpisania per DM (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: rozmiar fragmentu tekstu wychodzącego (znaki).
- `channels.nextcloud-talk.chunkMode`: `length` (domyślnie) lub `newline`, aby dzielić po pustych liniach (granice akapitów) przed dzieleniem według długości.
- `channels.nextcloud-talk.blockStreaming`: wyłącz strumieniowanie blokowe dla tego kanału.
- `channels.nextcloud-talk.blockStreamingCoalesce`: dostrajanie scalania strumieniowania blokowego.
- `channels.nextcloud-talk.mediaMaxMb`: limit multimediów przychodzących (MB).

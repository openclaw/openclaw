---
summary: "Status for Nextcloud Talk-support, funktioner og konfiguration"
read_when:
  - Arbejder med Nextcloud Talk-kanalfunktioner
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Status: understøttet via plugin (webhook bot). Direkte beskeder, værelser, reaktioner og markdown beskeder understøttes.

## Plugin påkrævet

Nextcloud Talk leveres som et plugin og er ikke inkluderet i kerneinstallationen.

Installér via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Lokalt checkout (når der køres fra et git-repo):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Hvis du vælger Nextcloud Talk under konfiguration/introduktion, og et git-checkout registreres,
vil OpenClaw automatisk tilbyde den lokale installationssti.

Detaljer: [Plugins](/tools/plugin)

## Hurtig opsætning (begynder)

1. Installér Nextcloud Talk-pluginet.

2. Opret en bot på din Nextcloud-server:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Aktivér botten i indstillingerne for det ønskede rum.

4. Konfigurér OpenClaw:
   - Konfiguration: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Eller env: `NEXTCLOUD_TALK_BOT_SECRET` (kun standardkonto)

5. Genstart gatewayen (eller afslut introduktionen).

Minimal konfiguration:

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

## Noter

- Bots kan ikke starte DMs. Brugeren skal først sende en besked til botten.
- Webhook-URL’en skal kunne nås af Gateway; sæt `webhookPublicUrl` hvis du er bag en proxy.
- Medieuploads understøttes ikke af bot-API’et; medier sendes som URL’er.
- Webhook-payloaden skelner ikke mellem direkte beskeder og rum; sæt `apiUser` + `apiPassword` for at aktivere opslag af rumtyper (ellers behandles direkte beskeder som rum).

## Adgangskontrol (direkte beskeder)

- Standard: `channels.nextcloud-talk.dmPolicy = "pairing"`. Ukendt afsendere får en parringskode.
- Godkend via:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Offentlige direkte beskeder: `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` matcher kun Nextcloud-bruger-id’er; visningsnavne ignoreres.

## Rum (grupper)

- Standard: `channels.nextcloud-talk.groupPolicy = "allowlist"` (mention-begrænset).
- Tilladelseslist rum med `channels.nextcloud-talk.rooms`:

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

- For ikke at tillade nogen rum skal tilladelseslisten være tom eller `channels.nextcloud-talk.groupPolicy="disabled"` sættes.

## Funktioner

| Funktion              | Status            |
| --------------------- | ----------------- |
| Direkte beskeder      | Understøttet      |
| Rum                   | Understøttet      |
| Tråde                 | Ikke understøttet |
| Medier                | Kun URL’er        |
| Reaktioner            | Understøttet      |
| Indbyggede kommandoer | Ikke understøttet |

## Konfigurationsreference (Nextcloud Talk)

Fuld konfiguration: [Konfiguration](/gateway/configuration)

Udbyderindstillinger:

- `channels.nextcloud-talk.enabled`: aktivér/deaktivér kanalstart.
- `channels.nextcloud-talk.baseUrl`: URL til Nextcloud-instans.
- `channels.nextcloud-talk.botSecret`: delt hemmelighed for bot.
- `channels.nextcloud-talk.botSecretFile`: filsti til hemmelighed.
- `channels.nextcloud-talk.apiUser`: API-bruger til rumopslag (detektion af direkte beskeder).
- `channels.nextcloud-talk.apiPassword`: API-/app-adgangskode til rumopslag.
- `channels.nextcloud-talk.apiPasswordFile`: filsti til API-adgangskode.
- `channels.nextcloud-talk.webhookPort`: webhook-lytteport (standard: 8788).
- `channels.nextcloud-talk.webhookHost`: webhook-vært (standard: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: webhook-sti (standard: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: eksternt tilgængelig webhook-URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM allowlist (bruger IDs). `open` kræver `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: tilladelsesliste for grupper (bruger-id’er).
- `channels.nextcloud-talk.rooms`: indstillinger og tilladelsesliste pr. rum.
- `channels.nextcloud-talk.historyLimit`: historikgrænse for grupper (0 deaktiverer).
- `channels.nextcloud-talk.dmHistoryLimit`: historikgrænse for direkte beskeder (0 deaktiverer).
- `channels.nextcloud-talk.dms`: tilsidesættelser pr. direkte besked (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: størrelse på udgående tekststykker (tegn).
- `channels.nextcloud-talk.chunkMode`: `length` (standard) eller `newline` for at opdele ved tomme linjer (afsnitsgrænser) før længdeopdeling.
- `channels.nextcloud-talk.blockStreaming`: deaktivér blokstreaming for denne kanal.
- `channels.nextcloud-talk.blockStreamingCoalesce`: justering af sammensmeltning for blokstreaming.
- `channels.nextcloud-talk.mediaMaxMb`: grænse for indgående medier (MB).

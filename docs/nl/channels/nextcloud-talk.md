---
summary: "Ondersteuningsstatus, mogelijkheden en configuratie van Nextcloud Talk"
read_when:
  - Werken aan Nextcloud Talk-kanaalfuncties
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Status: ondersteund via plugin (webhook-bot). Directe berichten, rooms, reacties en markdown-berichten worden ondersteund.

## Plugin vereist

Nextcloud Talk wordt geleverd als plugin en is niet gebundeld met de kerninstallatie.

Installeren via CLI (npm-registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Lokale checkout (bij uitvoeren vanuit een git-repo):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Als je tijdens configuratie/onboarding voor Nextcloud Talk kiest en er een git-checkout wordt gedetecteerd,
biedt OpenClaw automatisch het lokale installatiepad aan.

Details: [Plugins](/tools/plugin)

## Snelle installatie (beginner)

1. Installeer de Nextcloud Talk-plugin.

2. Maak op je Nextcloud-server een bot aan:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Schakel de bot in binnen de instellingen van de doelroom.

4. Configureer OpenClaw:
   - Config: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Of env: `NEXTCLOUD_TALK_BOT_SECRET` (alleen standaardaccount)

5. Herstart de Gateway (of rond de onboarding af).

Minimale config:

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

## Notities

- Bots kunnen geen DM's initiëren. De gebruiker moet eerst een bericht naar de bot sturen.
- De webhook-URL moet bereikbaar zijn voor de Gateway; stel `webhookPublicUrl` in als je achter een proxy zit.
- Media-uploads worden niet ondersteund door de bot-API; media wordt als URL verzonden.
- De webhook-payload maakt geen onderscheid tussen DM's en rooms; stel `apiUser` + `apiPassword` in om room-typen te kunnen opzoeken (anders worden DM's als rooms behandeld).

## Toegangsbeheer (DM's)

- Standaard: `channels.nextcloud-talk.dmPolicy = "pairing"`. Onbekende afzenders krijgen een koppelcode.
- Goedkeuren via:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Openbare DM's: `channels.nextcloud-talk.dmPolicy="open"` plus `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` komt alleen overeen met Nextcloud-gebruikers-ID's; weergavenamen worden genegeerd.

## Rooms (groepen)

- Standaard: `channels.nextcloud-talk.groupPolicy = "allowlist"` (vermelding-gestuurd).
- Sta rooms toe via de toegestane lijst met `channels.nextcloud-talk.rooms`:

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

- Om geen rooms toe te staan, laat de toegestane lijst leeg of stel `channels.nextcloud-talk.groupPolicy="disabled"` in.

## Mogelijkheden

| Functie           | Status           |
| ----------------- | ---------------- |
| Directe berichten | Ondersteund      |
| Rooms             | Ondersteund      |
| Threads           | Niet ondersteund |
| Media             | Alleen URL's     |
| Reacties          | Ondersteund      |
| Native opdrachten | Niet ondersteund |

## Configuratiereferentie (Nextcloud Talk)

Volledige configuratie: [Configuratie](/gateway/configuration)

Provider-opties:

- `channels.nextcloud-talk.enabled`: kanaalstart in-/uitschakelen.
- `channels.nextcloud-talk.baseUrl`: URL van de Nextcloud-instantie.
- `channels.nextcloud-talk.botSecret`: gedeeld botgeheim.
- `channels.nextcloud-talk.botSecretFile`: pad naar geheimenbestand.
- `channels.nextcloud-talk.apiUser`: API-gebruiker voor room-opzoekingen (DM-detectie).
- `channels.nextcloud-talk.apiPassword`: API-/app-wachtwoord voor room-opzoekingen.
- `channels.nextcloud-talk.apiPasswordFile`: pad naar API-wachtwoordbestand.
- `channels.nextcloud-talk.webhookPort`: poort voor webhook-listener (standaard: 8788).
- `channels.nextcloud-talk.webhookHost`: webhook-host (standaard: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: webhook-pad (standaard: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: extern bereikbare webhook-URL.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM-toegestane lijst (gebruikers-ID's). `open` vereist `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: groep-toegestane lijst (gebruikers-ID's).
- `channels.nextcloud-talk.rooms`: per-room-instellingen en toegestane lijst.
- `channels.nextcloud-talk.historyLimit`: groepsgeschiedenislimeit (0 schakelt uit).
- `channels.nextcloud-talk.dmHistoryLimit`: DM-geschiedenislimeit (0 schakelt uit).
- `channels.nextcloud-talk.dms`: per-DM-overschrijvingen (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: uitgaande tekstblokgrootte (tekens).
- `channels.nextcloud-talk.chunkMode`: `length` (standaard) of `newline` om te splitsen op lege regels (paragraafgrenzen) vóór lengte-chunking.
- `channels.nextcloud-talk.blockStreaming`: blokstreaming uitschakelen voor dit kanaal.
- `channels.nextcloud-talk.blockStreamingCoalesce`: afstemming voor het samenvoegen van blokstreaming.
- `channels.nextcloud-talk.mediaMaxMb`: limiet voor inkomende media (MB).

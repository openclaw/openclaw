---
summary: "Status, mogelijkheden en configuratie van Matrix-ondersteuning"
read_when:
  - Werken aan Matrix-kanaalfunctionaliteit
title: "Matrix"
---

# Matrix (plugin)

Matrix is een open, gedecentraliseerd berichtenprotocol. OpenClaw verbindt als een Matrix-**gebruiker**
op elke homeserver, dus je hebt een Matrix-account nodig voor de bot. Zodra deze is ingelogd, kun je de bot
rechtstreeks een DM sturen of hem uitnodigen in kamers (Matrix-„groepen”). Beeper is ook een geldige clientoptie,
maar vereist dat E2EE is ingeschakeld.

Status: ondersteund via plugin (@vector-im/matrix-bot-sdk). Directe berichten, kamers, threads, media, reacties,
polls (verzenden + poll-start als tekst), locatie en E2EE (met crypto-ondersteuning).

## Plugin vereist

Matrix wordt geleverd als een plugin en is niet gebundeld met de kerninstallatie.

Installeren via CLI (npm‑registry):

```bash
openclaw plugins install @openclaw/matrix
```

Lokale checkout (bij uitvoeren vanuit een git-repo):

```bash
openclaw plugins install ./extensions/matrix
```

Als je Matrix kiest tijdens configuratie/onboarding en een git-checkout wordt gedetecteerd,
biedt OpenClaw automatisch het lokale installatiepad aan.

Details: [Plugins](/tools/plugin)

## Installatie

1. Installeer de Matrix-plugin:
   - Vanuit npm: `openclaw plugins install @openclaw/matrix`
   - Vanuit een lokale checkout: `openclaw plugins install ./extensions/matrix`

2. Maak een Matrix-account aan op een homeserver:
   - Bekijk hostingopties op [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Of host het zelf.

3. Verkrijg een access token voor het botaccount:

   - Gebruik de Matrix login-API met `curl` op je homeserver:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Vervang `matrix.example.org` door de URL van je homeserver.
   - Of stel `channels.matrix.userId` + `channels.matrix.password` in: OpenClaw roept hetzelfde
     login-eindpunt aan, slaat het access token op in `~/.openclaw/credentials/matrix/credentials.json`,
     en hergebruikt dit bij de volgende start.

4. Configureer referenties:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (of `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Of config: `channels.matrix.*`
   - Als beide zijn ingesteld, heeft config voorrang.
   - Met access token: gebruikers-ID wordt automatisch opgehaald via `/whoami`.
   - Indien ingesteld, moet `channels.matrix.userId` de volledige Matrix-ID zijn (voorbeeld: `@bot:example.org`).

5. Herstart de Gateway (of rond onboarding af).

6. Start een DM met de bot of nodig hem uit in een kamer vanuit een Matrix-client
   (Element, Beeper, enz.; zie [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper vereist E2EE,
   dus stel `channels.matrix.encryption: true` in en verifieer het apparaat.

Minimale config (access token, gebruikers-ID automatisch opgehaald):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

E2EE-config (end-to-end-encryptie ingeschakeld):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Encryptie (E2EE)

End-to-end-encryptie wordt **ondersteund** via de Rust crypto SDK.

Inschakelen met `channels.matrix.encryption: true`:

- Als de crypto-module laadt, worden versleutelde kamers automatisch ontsleuteld.
- Uitgaande media wordt versleuteld bij verzending naar versleutelde kamers.
- Bij de eerste verbinding vraagt OpenClaw apparaatverificatie aan bij je andere sessies.
- Verifieer het apparaat in een andere Matrix-client (Element, enz.) om sleuteldeling in te schakelen.
- Als de crypto-module niet kan worden geladen, wordt E2EE uitgeschakeld en worden versleutelde kamers niet ontsleuteld;
  OpenClaw logt een waarschuwing.
- Als je fouten ziet over een ontbrekende crypto-module (bijvoorbeeld `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  sta build-scripts toe voor `@matrix-org/matrix-sdk-crypto-nodejs` en voer
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` uit of haal het binaire bestand op met
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

De crypto-status wordt per account + access token opgeslagen in
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite-database). De sync-status staat ernaast in `bot-storage.json`.
Als het access token (apparaat) verandert, wordt een nieuwe store aangemaakt en moet de bot
opnieuw worden geverifieerd voor versleutelde kamers.

**Apparaatverificatie:**
Wanneer E2EE is ingeschakeld, vraagt de bot bij het opstarten verificatie aan bij je andere sessies.
Open Element (of een andere client) en keur het verificatieverzoek goed om vertrouwen tot stand te brengen.
Na verificatie kan de bot berichten in versleutelde kamers ontsleutelen.

## Routeringsmodel

- Antwoorden gaan altijd terug naar Matrix.
- DM’s delen de hoofd­sessie van de agent; kamers worden gekoppeld aan groepssessies.

## Toegangsbeheer (DM’s)

- Standaard: `channels.matrix.dm.policy = "pairing"`. Onbekende afzenders krijgen een koppelcode.
- Goedkeuren via:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Openbare DM’s: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` accepteert volledige Matrix-gebruikers-ID’s (voorbeeld: `@user:server`). De wizard zet weergavenamen om naar gebruikers-ID’s wanneer de directoryzoekactie één exacte match vindt.

## Kamers (groepen)

- Standaard: `channels.matrix.groupPolicy = "allowlist"` (mention-gated). Gebruik `channels.defaults.groupPolicy` om de standaard te overschrijven wanneer niet ingesteld.
- Sta kamers toe met `channels.matrix.groups` (kamer-ID’s of aliassen; namen worden omgezet naar ID’s wanneer de directoryzoekactie één exacte match vindt):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` schakelt automatisch antwoorden in die kamer in.
- `groups."*"` kan standaardinstellingen voor mention-gating over kamers heen instellen.
- `groupAllowFrom` beperkt welke afzenders de bot in kamers kunnen activeren (volledige Matrix-gebruikers-ID’s).
- Per-kamer `users`-toegestane lijsten kunnen afzenders binnen een specifieke kamer verder beperken (gebruik volledige Matrix-gebruikers-ID’s).
- De configuratiewizard vraagt om kamer-toegestane lijsten (kamer-ID’s, aliassen of namen) en zet namen alleen om bij een exacte, unieke match.
- Bij het opstarten zet OpenClaw kamer-/gebruikersnamen in toegestane lijsten om naar ID’s en logt de mapping; niet-opgeloste items worden genegeerd bij het matchen van toegestane lijsten.
- Uitnodigingen worden standaard automatisch geaccepteerd; beheer dit met `channels.matrix.autoJoin` en `channels.matrix.autoJoinAllowlist`.
- Om **geen kamers** toe te staan, stel `channels.matrix.groupPolicy: "disabled"` in (of houd een lege toegestane lijst).
- Verouderde sleutel: `channels.matrix.rooms` (zelfde vorm als `groups`).

## Threads

- Antwoord-threading wordt ondersteund.
- `channels.matrix.threadReplies` bepaalt of antwoorden in threads blijven:
  - `off`, `inbound` (standaard), `always`
- `channels.matrix.replyToMode` bepaalt reply-to-metadata wanneer niet in een thread wordt geantwoord:
  - `off` (standaard), `first`, `all`

## Mogelijkheden

| Functie           | Status                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Directe berichten | ✅ Ondersteund                                                                                                           |
| Kamers            | ✅ Ondersteund                                                                                                           |
| Threads           | ✅ Ondersteund                                                                                                           |
| Media             | ✅ Ondersteund                                                                                                           |
| E2EE              | ✅ Ondersteund (crypto-module vereist)                                                                |
| Reacties          | ✅ Ondersteund (verzenden/lezen via tools)                                                            |
| Polls             | ✅ Verzenden ondersteund; inkomende poll-starts worden omgezet naar tekst (reacties/einden genegeerd) |
| Locatie           | ✅ Ondersteund (geo-URI; hoogte genegeerd)                                                            |
| Native opdrachten | ✅ Ondersteund                                                                                                           |

## Problemen oplossen

Doorloop eerst deze ladder:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bevestig daarna indien nodig de DM-koppelingsstatus:

```bash
openclaw pairing list matrix
```

Veelvoorkomende fouten:

- Ingelogd maar kamerberichten genegeerd: kamer geblokkeerd door `groupPolicy` of kamer-toegestane lijst.
- DM’s genegeerd: afzender wacht op goedkeuring wanneer `channels.matrix.dm.policy="pairing"`.
- Versleutelde kamers falen: mismatch in crypto-ondersteuning of encryptie-instellingen.

Voor triageflow: [/channels/troubleshooting](/channels/troubleshooting).

## Configuratiereferentie (Matrix)

Volledige configuratie: [Configuration](/gateway/configuration)

Provider-opties:

- `channels.matrix.enabled`: kanaalstart in-/uitschakelen.
- `channels.matrix.homeserver`: homeserver-URL.
- `channels.matrix.userId`: Matrix-gebruikers-ID (optioneel met access token).
- `channels.matrix.accessToken`: access token.
- `channels.matrix.password`: wachtwoord voor login (token opgeslagen).
- `channels.matrix.deviceName`: weergavenaam van het apparaat.
- `channels.matrix.encryption`: E2EE inschakelen (standaard: false).
- `channels.matrix.initialSyncLimit`: initiële sync-limiet.
- `channels.matrix.threadReplies`: `off | inbound | always` (standaard: inbound).
- `channels.matrix.textChunkLimit`: uitgaande tekst-chunkgrootte (tekens).
- `channels.matrix.chunkMode`: `length` (standaard) of `newline` om op lege regels (paragraafgrenzen) te splitsen vóór lengte-chunking.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (standaard: pairing).
- `channels.matrix.dm.allowFrom`: DM-toegestane lijst (volledige Matrix-gebruikers-ID’s). `open` vereist `"*"`. De wizard zet namen waar mogelijk om naar ID’s.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (standaard: allowlist).
- `channels.matrix.groupAllowFrom`: toegestane afzenders voor groepsberichten (volledige Matrix-gebruikers-ID’s).
- `channels.matrix.allowlistOnly`: afdwingen van allowlist-regels voor DM’s + kamers.
- `channels.matrix.groups`: groeps-allowlist + per-kamerinstellingenkaart.
- `channels.matrix.rooms`: verouderde groeps-allowlist/config.
- `channels.matrix.replyToMode`: reply-to-modus voor threads/tags.
- `channels.matrix.mediaMaxMb`: inbound/outbound media-limiet (MB).
- `channels.matrix.autoJoin`: uitnodigingsafhandeling (`always | allowlist | off`, standaard: always).
- `channels.matrix.autoJoinAllowlist`: toegestane kamer-ID’s/aliassen voor auto-join.
- `channels.matrix.actions`: per-actie tool-gating (reactions/messages/pins/memberInfo/channelInfo).

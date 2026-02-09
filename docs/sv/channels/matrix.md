---
summary: "Status, funktioner och konfiguration för Matrix-stöd"
read_when:
  - Arbetar med funktioner för Matrix-kanalen
title: "Matrix"
---

# Matrix (plugin)

Matrix är ett öppet, decentraliserat meddelandeprotokoll. OpenClaw ansluter som en matris **användare**
på alla homeserver, så du behöver ett Matrix-konto för boten. När den är inloggad kan du DM
boten direkt eller bjuda in den till rum (matris "grupper"). Beeper är ett giltigt klientalternativ också,
men det kräver att E2EE aktiveras.

Status: stöds via plugin (@vector-im/matrix-bot-sdk). Direktmeddelanden, rum, trådar, media, reaktioner,
opinionsundersökningar (skicka + poll-start som text), plats och E2EE (med crypto support).

## Plugin krävs

Matrix levereras som ett plugin och ingår inte i kärninstallationen.

Installera via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/matrix
```

Lokal checkout (när du kör från ett git-repo):

```bash
openclaw plugins install ./extensions/matrix
```

Om du väljer Matrix under konfigurering/introduktion och en git-checkout upptäcks,
erbjuder OpenClaw automatiskt den lokala installationssökvägen.

Detaljer: [Plugins](/tools/plugin)

## Konfigurering

1. Installera Matrix-pluginet:
   - Från npm: `openclaw plugins install @openclaw/matrix`
   - Från en lokal checkout: `openclaw plugins install ./extensions/matrix`

2. Skapa ett Matrix-konto på en homeserver:
   - Utforska värdalternativ på [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Eller hosta själv.

3. Skaffa en åtkomsttoken för botkontot:

   - Använd Matrix inloggnings-API med `curl` på din homeserver:

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

   - Ersätt `matrix.example.org` med din homeserver-URL.
   - Eller sätt `channels.matrix.userId` + `channels.matrix.password`: OpenClaw anropar samma
     inloggningsendpoint, lagrar åtkomsttoken i `~/.openclaw/credentials/matrix/credentials.json`,
     och återanvänder den vid nästa start.

4. Konfigurera autentiseringsuppgifter:
   - Miljö: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (eller `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Eller konfig: `channels.matrix.*`
   - Om båda är satta har konfig företräde.
   - Med åtkomsttoken: användar-ID hämtas automatiskt via `/whoami`.
   - När den är satt ska `channels.matrix.userId` vara hela Matrix-ID:t (exempel: `@bot:example.org`).

5. Starta om gatewayen (eller slutför introduktionen).

6. Starta en DM med botten eller bjud in den till ett rum från någon Matrix klient
   (Element, Beeper, etc.; se [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper kräver E2EE,
   så sätt `channels.matrix.encryption: true` och verifiera enheten.

Minimal konfig (åtkomsttoken, användar-ID hämtas automatiskt):

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

E2EE-konfig (end-to-end-kryptering aktiverad):

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

## Kryptering (E2EE)

End-to-end-kryptering **stöds** via Rust crypto SDK.

Aktivera med `channels.matrix.encryption: true`:

- Om kryptomodulen laddas dekrypteras krypterade rum automatiskt.
- Utgående media krypteras när den skickas till krypterade rum.
- Vid första anslutningen begär OpenClaw enhetsverifiering från dina andra sessioner.
- Verifiera enheten i en annan matrisklient (Element, etc.) för att aktivera nyckeldelning.
- Om kryptomodulen inte kan laddas inaktiveras E2EE och krypterade rum dekrypteras inte;
  OpenClaw loggar en varning.
- Om du ser fel om saknad kryptomodul (till exempel `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  tillåt byggskript för `@matrix-org/matrix-sdk-crypto-nodejs` och kör
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` eller hämta binären med
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Kryptostatus lagras per konto + åtkomsttoken i
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite-databas). Synkronisera tillståndet lever tillsammans med det i `bot-storage.json`.
If the access token (device) changes, a new store is created and the bot must be
re-verified for encrypted rooms.

**Enhetsverifiering:**
När E2EE är aktiverat kommer boten att begära verifiering från dina andra sessioner vid start.
Öppna Element (eller en annan klient) och godkänn verifieringsbegäran för att skapa förtroende.
När boten har verifierats kan den dekryptera meddelanden i krypterade rum.

## Routingmodell

- Svar går alltid tillbaka till Matrix.
- DM delar agentens huvudsession; rum mappas till gruppsessioner.

## Åtkomstkontroll (DM)

- Standard: `channels.matrix.dm.policy = "pairing"`. Okända avsändare får en parningskod.
- Godkänn via:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Publika DM: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` accepterar fullständiga Matrix användar-ID (exempel: `@user:server`). Guiden löser visningsnamn till användar-ID när katalogsökningen hittar en enda exakt match.

## Rum (grupper)

- Standard: `channels.matrix.groupPolicy = "allowlist"` (omnämnandespärr). Använd `channels.defaults.groupPolicy` för att åsidosätta standard när du inaktiverar.
- Tillåtelselista för rum med `channels.matrix.groups` (rum-ID:n eller alias; namn löses till ID:n när katalogsökningen hittar en enda exakt matchning):

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

- `requireMention: false` aktiverar autosvar i det rummet.
- `groups."*"` kan sätta standardvärden för omnämnandespärr över rum.
- `groupAllowFrom` begränsar vilka avsändare som kan trigga boten i rum (fullständiga Matrix-användar-ID:n).
- Per-rum `users`-tillåtelselistor kan ytterligare begränsa avsändare i ett specifikt rum (använd fullständiga Matrix-användar-ID:n).
- Konfigurationsguiden frågar efter tillåtelselistor för rum (rum-ID:n, alias eller namn) och löser namn endast vid en exakt, unik matchning.
- Vid uppstart löser OpenClaw rums-/användarnamn i tillåtelselistor till ID:n och loggar mappningen; olösta poster ignoreras vid matchning.
- Inbjudningar accepteras automatiskt som standard; styr med `channels.matrix.autoJoin` och `channels.matrix.autoJoinAllowlist`.
- För att tillåta **inga rum**, sätt `channels.matrix.groupPolicy: "disabled"` (eller behåll en tom tillåtelselista).
- Äldre nyckel: `channels.matrix.rooms` (samma form som `groups`).

## Trådar

- Svarstrådning stöds.
- `channels.matrix.threadReplies` styr om svar stannar i trådar:
  - `off`, `inbound` (standard), `always`
- `channels.matrix.replyToMode` styr reply-to-metadata när man inte svarar i en tråd:
  - `off` (standard), `first`, `all`

## Funktioner

| Funktion           | Status                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Direktmeddelanden  | ✅ Stöds                                                                                             |
| Rum                | ✅ Stöds                                                                                             |
| Trådar             | ✅ Stöds                                                                                             |
| Media              | ✅ Stöds                                                                                             |
| E2EE               | ✅ Stöds (kryptomodul krävs)                                                      |
| Reaktioner         | ✅ Stöds (skicka/läsa via verktyg)                                                |
| Omröstningar       | ✅ Skick stöds; inkommande poll-start konverteras till text (svar/slut ignoreras) |
| Plats              | ✅ Stöds (geo-URI; höjd ignoreras)                                                |
| Inbyggda kommandon | ✅ Stöds                                                                                             |

## Felsökning

Kör denna stege först:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bekräfta sedan DM-parningsstatus vid behov:

```bash
openclaw pairing list matrix
```

Vanliga fel:

- Inloggad men rumsmeddelanden ignoreras: rummet blockeras av `groupPolicy` eller rumstillåtelselistan.
- DM ignoreras: avsändaren väntar på godkännande när `channels.matrix.dm.policy="pairing"`.
- Krypterade rum misslyckas: kryptostöd eller inställningar för kryptering matchar inte.

För triage-flöde: [/channels/troubleshooting](/channels/troubleshooting).

## Konfigurationsreferens (Matrix)

Fullständig konfiguration: [Konfiguration](/gateway/configuration)

Leverantörsalternativ:

- `channels.matrix.enabled`: aktivera/inaktivera kanalstart.
- `channels.matrix.homeserver`: homeserver-URL.
- `channels.matrix.userId`: Matrix-användar-ID (valfritt med åtkomsttoken).
- `channels.matrix.accessToken`: åtkomsttoken.
- `channels.matrix.password`: lösenord för inloggning (token lagras).
- `channels.matrix.deviceName`: visningsnamn för enheten.
- `channels.matrix.encryption`: aktivera E2EE (standard: false).
- `channels.matrix.initialSyncLimit`: initial synkgräns.
- `channels.matrix.threadReplies`: `off | inbound | always` (standard: inkommande).
- `channels.matrix.textChunkLimit`: textstyckningsstorlek för utgående text (tecken).
- `channels.matrix.chunkMode`: `length` (standard) eller `newline` för att dela vid tomma rader (styckegränser) före längdstyckning.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (standard: parning).
- `channels.matrix.dm.allowFrom`: DM allowlist (full Matrix användar-ID). `open` kräver `"*"`. Guiden löser namn på ID när det är möjligt.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (standard: tillåtelselista).
- `channels.matrix.groupAllowFrom`: tillåtna avsändare för gruppmeddelanden (fullständiga Matrix-användar-ID:n).
- `channels.matrix.allowlistOnly`: tvinga tillåtelselisteregler för DM + rum.
- `channels.matrix.groups`: grupp-tillåtelselista + per-rum-inställningskarta.
- `channels.matrix.rooms`: äldre grupp-tillåtelselista/konfig.
- `channels.matrix.replyToMode`: reply-to-läge för trådar/taggar.
- `channels.matrix.mediaMaxMb`: gräns för inkommande/utgående media (MB).
- `channels.matrix.autoJoin`: hantering av inbjudningar (`always | allowlist | off`, standard: alltid).
- `channels.matrix.autoJoinAllowlist`: tillåtna rum-ID:n/alias för auto-anslutning.
- `channels.matrix.actions`: per-åtgärd-verktygsspärr (reaktioner/meddelanden/pins/memberInfo/channelInfo).

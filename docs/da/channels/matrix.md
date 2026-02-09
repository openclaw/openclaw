---
summary: "Matrix-supportstatus, funktioner og konfiguration"
read_when:
  - Arbejder med Matrix-kanalfunktioner
title: "Matrix"
---

# Matrix (plugin)

Matrix er en åben, decentraliseret meddelelsesprotokol. OpenClaw forbinder som en Matrix **bruger**
på en hvilken som helst hjemmeserver, så du har brug for en Matrix-konto til boten. Når den er logget ind, kan du DM
botten direkte eller invitere den til rum (Matrix "grupper"). Bieper er også en gyldig klientmulighed,
men det kræver E2EE at være aktiveret.

Status: understøttet via plugin (@vector-im/matrix-bot-sdk). Direkte beskeder, værelser, tråde, medier, reaktioner,
meningsmålinger (send + poll-start som tekst), placering og E2EE (med kryptostøtte).

## Plugin påkrævet

Matrix leveres som et plugin og er ikke inkluderet i kerneinstallationen.

Installér via CLI (npm-registret):

```bash
openclaw plugins install @openclaw/matrix
```

Lokalt checkout (ved kørsel fra et git-repo):

```bash
openclaw plugins install ./extensions/matrix
```

Hvis du vælger Matrix under konfiguration/introduktion, og et git-checkout registreres,
tilbyder OpenClaw automatisk den lokale installationssti.

Detaljer: [Plugins](/tools/plugin)

## Opsætning

1. Installér Matrix-plugin’et:
   - Fra npm: `openclaw plugins install @openclaw/matrix`
   - Fra et lokalt checkout: `openclaw plugins install ./extensions/matrix`

2. Opret en Matrix-konto på en homeserver:
   - Se hostingmuligheder på [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Eller host selv.

3. Hent en adgangstoken til botkontoen:

   - Brug Matrix login-API’et med `curl` på din homeserver:

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

   - Erstat `matrix.example.org` med din homeserver-URL.
   - Eller sæt `channels.matrix.userId` + `channels.matrix.password`: OpenClaw kalder samme
     login-endpoint, gemmer adgangstoken i `~/.openclaw/credentials/matrix/credentials.json`,
     og genbruger den ved næste start.

4. Konfigurér legitimationsoplysninger:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (eller `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Eller konfiguration: `channels.matrix.*`
   - Hvis begge er sat, har konfigurationen forrang.
   - Med adgangstoken hentes bruger-id automatisk via `/whoami`.
   - Når den er sat, skal `channels.matrix.userId` være det fulde Matrix-id (eksempel: `@bot:example.org`).

5. Genstart gateway’en (eller afslut introduktionen).

6. Start en DM med botten eller inviter den til et rum fra enhver Matrix klient
   (Element, Beeper, etc.; se [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Bieper kræver E2EE,
   så sæt `channels.matrix.encryption: true` og verificer enheden.

Minimal konfiguration (adgangstoken, bruger-id hentes automatisk):

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

E2EE-konfiguration (end-to-end-kryptering aktiveret):

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

End-to-end-kryptering er **understøttet** via Rust crypto SDK.

Aktivér med `channels.matrix.encryption: true`:

- Hvis kryptomodullet indlæses, dekrypteres krypterede rum automatisk.
- Udgående medier krypteres ved afsendelse til krypterede rum.
- Ved første forbindelse anmoder OpenClaw om enhedsverifikation fra dine andre sessioner.
- Kontroller enheden i en anden Matrix klient (Element, osv.) for at aktivere nøgledeling.
- Hvis kryptomodullet ikke kan indlæses, deaktiveres E2EE, og krypterede rum dekrypteres ikke;
  OpenClaw logger en advarsel.
- Hvis du ser fejl om manglende kryptomodul (for eksempel `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  tillad build-scripts for `@matrix-org/matrix-sdk-crypto-nodejs` og kør
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` eller hent binæren med
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Kryptotilstand gemmes pr. konto + adgangstoken i
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(SQLite database). Synkroniser tilstand lever sammen med det i `bot-storage.json`.
Hvis adgangstoken (enheden) ændres, oprettes en ny butik, og botten skal være
re-verificeret for krypterede rum.

**Enhedsbekræftelse:**
Når E2EE er aktiveret, vil botten anmode om bekræftelse fra dine andre sessioner ved opstart.
Åbn Element (eller en anden klient) og godkend verifikationsanmodningen for at etablere tillid.
Når den er verificeret, kan botten dekryptere beskeder i krypterede rum.

## Routingmodel

- Svar går altid tilbage til Matrix.
- DM’er deler agentens hovedsession; rum mappes til gruppesessioner.

## Adgangskontrol (DM’er)

- Standard: `channels.matrix.dm.policy = "pairing"`. Ukendt afsendere får en parringskode.
- Godkend via:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Offentlige DM’er: `channels.matrix.dm.policy="open"` plus `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` accepterer fulde Matrix bruger-id'er (eksempel: `@user:server`). Guiden løser visningsnavne til brugernavne, når mappesøgning finder en enkelt nøjagtig match.

## Rum (grupper)

- Standard: `channels.matrix.groupPolicy = "allowlist"` (mention-begrænset). Brug `channels.defaults.groupPolicy` for at tilsidesætte standarden, når den ikke er angivet.
- Tilladelseslist rum med `channels.matrix.groups` (rum-id’er eller aliaser; navne resolveres til id’er, når katalogsøgningen finder et enkelt, præcist match):

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

- `requireMention: false` aktiverer autosvar i det rum.
- `groups."*"` kan sætte standarder for mention-gating på tværs af rum.
- `groupAllowFrom` begrænser, hvilke afsendere der kan udløse botten i rum (fulde Matrix-bruger-id’er).
- Per-rum `users`-tilladelseslister kan yderligere begrænse afsendere i et specifikt rum (brug fulde Matrix-bruger-id’er).
- Opsætningsguiden spørger efter rumtilladelseslister (rum-id’er, aliaser eller navne) og resolverer kun navne ved et præcist, entydigt match.
- Ved opstart resolverer OpenClaw rum-/brugernavne i tilladelseslister til id’er og logger mappingen; uløste poster ignoreres ved matchning.
- Invitationer tilsluttes automatisk som standard; styr med `channels.matrix.autoJoin` og `channels.matrix.autoJoinAllowlist`.
- For at tillade **ingen rum**, sæt `channels.matrix.groupPolicy: "disabled"` (eller behold en tom tilladelsesliste).
- Ældre nøgle: `channels.matrix.rooms` (samme struktur som `groups`).

## Tråde

- Svar i tråde er understøttet.
- `channels.matrix.threadReplies` styrer, om svar forbliver i tråde:
  - `off`, `inbound` (standard), `always`
- `channels.matrix.replyToMode` styrer svar-til-metadata, når der ikke svares i en tråd:
  - `off` (standard), `first`, `all`

## Funktioner

| Funktion          | Status                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Direkte beskeder  | ✅ Understøttet                                                                                                 |
| Rum               | ✅ Understøttet                                                                                                 |
| Tråde             | ✅ Understøttet                                                                                                 |
| Medier            | ✅ Understøttet                                                                                                 |
| E2EE              | ✅ Understøttet (kryptomodul påkrævet)                                                       |
| Reaktioner        | ✅ Understøttet (send/læs via værktøjer)                                                     |
| Afstemninger      | ✅ Afsendelse understøttet; indgående poll-start konverteres til tekst (svar/slut ignoreres) |
| Placering         | ✅ Understøttet (geo-URI; højde ignoreres)                                                   |
| Native kommandoer | ✅ Understøttet                                                                                                 |

## Fejlfinding

Kør denne trappe først:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bekræft derefter DM-parringstilstand om nødvendigt:

```bash
openclaw pairing list matrix
```

Almindelige fejl:

- Logget ind, men rumbeskeder ignoreres: rummet er blokeret af `groupPolicy` eller rumtilladelseslisten.
- DM’er ignoreres: afsender afventer godkendelse, når `channels.matrix.dm.policy="pairing"`.
- Krypterede rum fejler: manglende kryptosupport eller mismatch i krypteringsindstillinger.

For triage-flow: [/channels/troubleshooting](/channels/troubleshooting).

## Konfigurationsreference (Matrix)

Fuld konfiguration: [Konfiguration](/gateway/configuration)

Udbyderindstillinger:

- `channels.matrix.enabled`: aktivér/deaktivér kanalopstart.
- `channels.matrix.homeserver`: homeserver-URL.
- `channels.matrix.userId`: Matrix-bruger-id (valgfrit med adgangstoken).
- `channels.matrix.accessToken`: adgangstoken.
- `channels.matrix.password`: adgangskode til login (token gemmes).
- `channels.matrix.deviceName`: enhedsvisningsnavn.
- `channels.matrix.encryption`: aktivér E2EE (standard: false).
- `channels.matrix.initialSyncLimit`: initial synkgrænse.
- `channels.matrix.threadReplies`: `off | inbound | always` (standard: inbound).
- `channels.matrix.textChunkLimit`: udgående tekststørrelse pr. chunk (tegn).
- `channels.matrix.chunkMode`: `length` (standard) eller `newline` for at splitte på tomme linjer (afsnitsgrænser) før længdeopdeling.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (standard: parring).
- `channels.matrix.dm.allowFrom`: DM allowlist (full Matrix user IDs). `open` kræver `"*"`. Guiden løser navne til ID'er når det er muligt.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (standard: tilladelsesliste).
- `channels.matrix.groupAllowFrom`: tilladte afsendere for gruppemeddelelser (fulde Matrix-bruger-id’er).
- `channels.matrix.allowlistOnly`: gennemtving tilladelseslistregler for DM’er + rum.
- `channels.matrix.groups`: gruppetilladelsesliste + per-rum-indstillingskort.
- `channels.matrix.rooms`: ældre gruppetilladelsesliste/konfiguration.
- `channels.matrix.replyToMode`: reply-to-tilstand for tråde/tags.
- `channels.matrix.mediaMaxMb`: ind-/udgående mediebegrænsning (MB).
- `channels.matrix.autoJoin`: invitationshåndtering (`always | allowlist | off`, standard: altid).
- `channels.matrix.autoJoinAllowlist`: tilladte rum-id’er/aliaser for auto-tilslutning.
- `channels.matrix.actions`: per-handling værktøjs-gating (reaktioner/beskeder/pins/memberInfo/channelInfo).

---
summary: "Cameravastlegging (iOS-node + macOS-app) voor agentgebruik: foto’s (jpg) en korte videoclips (mp4)"
read_when:
  - Bij het toevoegen of wijzigen van cameravastlegging op iOS-nodes of macOS
  - Bij het uitbreiden van door agenten toegankelijke MEDIA-tempbestandworkflows
title: "Cameravastlegging"
---

# Cameravastlegging (agent)

OpenClaw ondersteunt **cameravastlegging** voor agentworkflows:

- **iOS-node** (gekoppeld via Gateway): maak een **foto** (`jpg`) of **korte videoclip** (`mp4`, met optionele audio) via `node.invoke`.
- **Android-node** (gekoppeld via Gateway): maak een **foto** (`jpg`) of **korte videoclip** (`mp4`, met optionele audio) via `node.invoke`.
- **macOS-app** (node via Gateway): maak een **foto** (`jpg`) of **korte videoclip** (`mp4`, met optionele audio) via `node.invoke`.

Alle cameratoegang is afgeschermd met **door de gebruiker beheerde instellingen**.

## iOS-node

### Gebruikersinstelling (standaard aan)

- iOS-instellingentab → **Camera** → **Camera toestaan** (`camera.enabled`)
  - Standaard: **aan** (ontbrekende sleutel wordt als ingeschakeld behandeld).
  - Wanneer uit: `camera.*`-opdrachten retourneren `CAMERA_DISABLED`.

### Opdrachten (via Gateway `node.invoke`)

- `camera.list`
  - Antwoordpayload:
    - `devices`: array van `{ id, name, position, deviceType }`

- `camera.snap`
  - Parameters:
    - `facing`: `front|back` (standaard: `front`)
    - `maxWidth`: number (optioneel; standaard `1600` op de iOS-node)
    - `quality`: `0..1` (optioneel; standaard `0.9`)
    - `format`: momenteel `jpg`
    - `delayMs`: number (optioneel; standaard `0`)
    - `deviceId`: string (optioneel; van `camera.list`)
  - Antwoordpayload:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Payloadbeveiliging: foto’s worden opnieuw gecomprimeerd om de base64-payload onder 5 MB te houden.

- `camera.clip`
  - Parameters:
    - `facing`: `front|back` (standaard: `front`)
    - `durationMs`: number (standaard `3000`, begrensd tot een maximum van `60000`)
    - `includeAudio`: boolean (standaard `true`)
    - `format`: momenteel `mp4`
    - `deviceId`: string (optioneel; van `camera.list`)
  - Antwoordpayload:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Voorgrondvereiste

Net als `canvas.*` staat de iOS-node `camera.*`-opdrachten alleen toe in de **voorgrond**. Achtergrondaanroepen retourneren `NODE_BACKGROUND_UNAVAILABLE`.

### CLI-helper (tempbestanden + MEDIA)

De eenvoudigste manier om bijlagen te verkrijgen is via de CLI-helper, die gedecodeerde media naar een tempbestand schrijft en `MEDIA:<path>` afdrukt.

Voorbeelden:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Notities:

- `nodes camera snap` staat standaard op **beide** camera’s om de agent beide perspectieven te geven.
- Uitvoerbestanden zijn tijdelijk (in de OS-tempmap), tenzij je je eigen wrapper bouwt.

## Android-node

### Android-gebruikersinstelling (standaard aan)

- Android-instellingenblad → **Camera** → **Camera toestaan** (`camera.enabled`)
  - Standaard: **aan** (ontbrekende sleutel wordt als ingeschakeld behandeld).
  - Wanneer uit: `camera.*`-opdrachten retourneren `CAMERA_DISABLED`.

### Permissions

- Android vereist runtime-rechten:
  - `CAMERA` voor zowel `camera.snap` als `camera.clip`.
  - `RECORD_AUDIO` voor `camera.clip` wanneer `includeAudio=true`.

Als rechten ontbreken, zal de app waar mogelijk een prompt tonen; bij weigering mislukken `camera.*`-verzoeken met een
`*_PERMISSION_REQUIRED`-fout.

### Android-voorgrondvereiste

Net als `canvas.*` staat de Android-node `camera.*`-opdrachten alleen toe in de **voorgrond**. Achtergrondaanroepen retourneren `NODE_BACKGROUND_UNAVAILABLE`.

### Payloadbeveiliging

Foto’s worden opnieuw gecomprimeerd om de base64-payload onder 5 MB te houden.

## macOS-app

### Gebruikersinstelling (standaard uit)

De macOS-companion-app biedt een selectievakje:

- **Instellingen → Algemeen → Camera toestaan** (`openclaw.cameraEnabled`)
  - Standaard: **uit**
  - Wanneer uit: cameraverzoeken retourneren “Camera disabled by user”.

### CLI-helper (node-aanroep)

Gebruik de hoofd-`openclaw` CLI om camera-opdrachten op de macOS-node aan te roepen.

Voorbeelden:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Notities:

- `openclaw nodes camera snap` staat standaard op `maxWidth=1600`, tenzij overschreven.
- Op macOS wacht `camera.snap` `delayMs` (standaard 2000 ms) na opwarming/expositiestabilisatie voordat wordt vastgelegd.
- Fotopayloads worden opnieuw gecomprimeerd om base64 onder 5 MB te houden.

## Veiligheid + praktische limieten

- Camera- en microfoontoegang activeren de gebruikelijke OS-toestemmingsprompts (en vereisen usage-strings in Info.plist).
- Videoclips zijn begrensd (momenteel `<= 60s`) om te grote node-payloads te voorkomen (base64-overhead + berichtlimieten).

## macOS-schermvideo (op OS-niveau)

Voor _scherm_-video (niet camera), gebruik de macOS-companion:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Notities:

- Vereist macOS-recht **Schermopname** (TCC).

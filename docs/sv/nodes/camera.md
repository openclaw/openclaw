---
summary: "Kamerainspelning (iOS-nod + macOS-app) för agentanvändning: foton (jpg) och korta videoklipp (mp4)"
read_when:
  - Lägger till eller ändrar kamerainspelning på iOS-noder eller macOS
  - Utökar agentåtkomliga MEDIA-arbetsflöden med temporära filer
title: "Kamerainspelning"
---

# Kamerainspelning (agent)

OpenClaw stöder **kamerainspelning** för agentarbetsflöden:

- **iOS-nod** (parad via Gateway): ta ett **foto** (`jpg`) eller ett **kort videoklipp** (`mp4`, med valfritt ljud) via `node.invoke`.
- **Android-nod** (parad via Gateway): ta ett **foto** (`jpg`) eller ett **kort videoklipp** (`mp4`, med valfritt ljud) via `node.invoke`.
- **macOS-app** (nod via Gateway): ta ett **foto** (`jpg`) eller ett **kort videoklipp** (`mp4`, med valfritt ljud) via `node.invoke`.

All kameratillgång är spärrad bakom **användarkontrollerade inställningar**.

## iOS-nod

### Användarinställning (standard på)

- iOS-inställningsfliken → **Kamera** → **Tillåt kamera** (`camera.enabled`)
  - Standard: **på** (saknad nyckel behandlas som aktiverad).
  - När av: `camera.*`-kommandon returnerar `CAMERA_DISABLED`.

### Kommandon (via Gateway `node.invoke`)

- `camera.list`
  - Svarspayload:
    - `devices`: array av `{ id, name, position, deviceType }`

- `camera.snap`
  - Parametrar:
    - `facing`: `front|back` (standard: `front`)
    - `maxWidth`: number (valfri; standard `1600` på iOS-noden)
    - `quality`: `0..1` (valfri; standard `0.9`)
    - `format`: för närvarande `jpg`
    - `delayMs`: number (valfri; standard `0`)
    - `deviceId`: string (valfri; från `camera.list`)
  - Svarspayload:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Payload-skydd: foton rekomprimeras för att hålla base64-payloaden under 5 MB.

- `camera.clip`
  - Parametrar:
    - `facing`: `front|back` (standard: `front`)
    - `durationMs`: number (standard `3000`, begränsad till max `60000`)
    - `includeAudio`: boolean (standard `true`)
    - `format`: för närvarande `mp4`
    - `deviceId`: string (valfri; från `camera.list`)
  - Svarspayload:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Förgrundskrav

Som `canvas.*`, tillåter iOS-noden endast `camera.*` kommandon i **förgrunden**. Bakgrundsinciteringar returnerar `NODE_BACKGROUND_UNAVAILABLE`.

### CLI-hjälpare (temporära filer + MEDIA)

Det enklaste sättet att få bilagor är via CLI-hjälparen, som skriver avkodad media till en temporär fil och skriver ut `MEDIA:<path>`.

Exempel:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Noteringar:

- `nodes camera snap` är som standard **båda** riktningarna för att ge agenten båda vyerna.
- Utdatafiler är temporära (i OS:ets temporära katalog) om du inte bygger ett eget omslag.

## Android-nod

### Android-användarinställning (standard på)

- Android-inställningsblad → **Kamera** → **Tillåt kamera** (`camera.enabled`)
  - Standard: **på** (saknad nyckel behandlas som aktiverad).
  - När av: `camera.*`-kommandon returnerar `CAMERA_DISABLED`.

### Behörigheter

- Android kräver körningsbehörigheter:
  - `CAMERA` för både `camera.snap` och `camera.clip`.
  - `RECORD_AUDIO` för `camera.clip` när `includeAudio=true`.

Om behörigheter saknas uppmanar appen när det är möjligt; om de nekas misslyckas `camera.*`-begäranden med ett
`*_PERMISSION_REQUIRED`-fel.

### Android-krav på förgrund

Som `canvas.*`, tillåter Android-noden endast `camera.*` kommandon i **förgrunden**. Bakgrundsinciteringar returnerar `NODE_BACKGROUND_UNAVAILABLE`.

### Payload-skydd

Foton rekomprimeras för att hålla base64-payloaden under 5 MB.

## macOS-app

### Användarinställning (standard av)

macOS companion-appen exponerar en kryssruta:

- **Inställningar → Allmänt → Tillåt kamera** (`openclaw.cameraEnabled`)
  - Standard: **av**
  - När av: kamerabegäranden returnerar ”Kamera inaktiverad av användaren”.

### CLI-hjälpare (nodanrop)

Använd huvud-CLI:t `openclaw` för att anropa kamerakommandon på macOS-noden.

Exempel:

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

Noteringar:

- `openclaw nodes camera snap` är som standard `maxWidth=1600` om inget annat anges.
- På macOS väntar `camera.snap` `delayMs` (standard 2000 ms) efter uppvärmning/exponeringsstabilisering innan inspelning.
- Fotopayloads rekomprimeras för att hålla base64 under 5 MB.

## Säkerhet + praktiska gränser

- Kamera- och mikrofonåtkomst triggar de vanliga OS-behörighetspromptarna (och kräver användningssträngar i Info.plist).
- Videoklipp är begränsade (för närvarande `<= 60s`) för att undvika överstora nodpayloads (base64-overhead + meddelandegränser).

## macOS-skärmvideo (OS-nivå)

För _skärm_-video (inte kamera), använd macOS companion:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Noteringar:

- Kräver macOS-behörigheten **Skärminspelning** (TCC).

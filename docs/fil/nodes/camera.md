---
summary: "Pagkuha ng camera (iOS node + macOS app) para sa paggamit ng agent: mga larawan (jpg) at maiikling video clip (mp4)"
read_when:
  - Pagdaragdag o pagbabago ng pagkuha ng camera sa mga iOS node o macOS
  - Pagpapalawak ng mga MEDIA temp-file workflow na naa-access ng agent
title: "Pagkuha ng Camera"
---

# Pagkuha ng camera (agent)

Sinusuportahan ng OpenClaw ang **pagkuha ng camera** para sa mga workflow ng agent:

- **iOS node** (nakapares sa pamamagitan ng Gateway): kumuha ng **larawan** (`jpg`) o **maikling video clip** (`mp4`, may opsyonal na audio) sa pamamagitan ng `node.invoke`.
- **Android node** (nakapares sa pamamagitan ng Gateway): kumuha ng **larawan** (`jpg`) o **maikling video clip** (`mp4`, may opsyonal na audio) sa pamamagitan ng `node.invoke`.
- **macOS app** (node sa pamamagitan ng Gateway): kumuha ng **larawan** (`jpg`) o **maikling video clip** (`mp4`, may opsyonal na audio) sa pamamagitan ng `node.invoke`.

Ang lahat ng access sa camera ay dumadaan sa **mga setting na kontrolado ng user**.

## iOS node

### Setting ng user (default na naka-on)

- iOS Settings tab → **Camera** → **Allow Camera** (`camera.enabled`)
  - Default: **on** (ang nawawalang key ay itinuturing na naka-enable).
  - Kapag naka-off: ang mga command na `camera.*` ay nagbabalik ng `CAMERA_DISABLED`.

### Mga command (sa pamamagitan ng Gateway `node.invoke`)

- `camera.list`
  - Response payload:
    - `devices`: array ng `{ id, name, position, deviceType }`

- `camera.snap`
  - Params:
    - `facing`: `front|back` (default: `front`)
    - `maxWidth`: number (opsyonal; default `1600` sa iOS node)
    - `quality`: `0..1` (opsyonal; default `0.9`)
    - `format`: kasalukuyang `jpg`
    - `delayMs`: number (opsyonal; default `0`)
    - `deviceId`: string (opsyonal; mula sa `camera.list`)
  - Response payload:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Payload guard: ang mga larawan ay nire-recompress upang mapanatili ang base64 payload na mas mababa sa 5 MB.

- `camera.clip`
  - Params:
    - `facing`: `front|back` (default: `front`)
    - `durationMs`: number (default `3000`, nililimitahan sa max na `60000`)
    - `includeAudio`: boolean (default `true`)
    - `format`: kasalukuyang `mp4`
    - `deviceId`: string (opsyonal; mula sa `camera.list`)
  - Response payload:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Kinakailangan sa foreground

Tulad ng `canvas.*`, pinapayagan lamang ng iOS node ang mga `camera.*` na command sa **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### CLI helper (temp files + MEDIA)

Ang pinakamadaling paraan para makakuha ng mga attachment ay sa pamamagitan ng CLI helper, na nagsusulat ng na-decode na media sa isang temp file at nagpi-print ng `MEDIA:<path>`.

Mga halimbawa:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Mga tala:

- Ang `nodes camera snap` ay default sa **parehong** facing upang mabigyan ang agent ng parehong view.
- Ang mga output file ay pansamantala (nasa OS temp directory) maliban kung gagawa ka ng sarili mong wrapper.

## Android node

### Setting ng Android user (default na naka-on)

- Android Settings sheet → **Camera** → **Allow Camera** (`camera.enabled`)
  - Default: **on** (ang nawawalang key ay itinuturing na naka-enable).
  - Kapag naka-off: ang mga command na `camera.*` ay nagbabalik ng `CAMERA_DISABLED`.

### Mga pahintulot

- Nangangailangan ang Android ng runtime permissions:
  - `CAMERA` para sa parehong `camera.snap` at `camera.clip`.
  - `RECORD_AUDIO` para sa `camera.clip` kapag `includeAudio=true`.

Kung kulang ang mga pahintulot, magpo-prompt ang app kapag posible; kung tinanggihan, ang mga request na `camera.*` ay mabibigo na may
`*_PERMISSION_REQUIRED` error.

### Kinakailangan sa foreground ng Android

Tulad ng `canvas.*`, pinapayagan lamang ng Android node ang mga `camera.*` na command kapag nasa **foreground**. Ang mga invocation sa background ay nagbabalik ng `NODE_BACKGROUND_UNAVAILABLE`.

### Payload guard

Ang mga larawan ay nire-recompress upang mapanatili ang base64 payload na mas mababa sa 5 MB.

## macOS app

### Setting ng user (default na naka-off)

Naglalantad ang macOS companion app ng isang checkbox:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - Default: **off**
  - Kapag naka-off: ang mga request sa camera ay nagbabalik ng “Camera disabled by user”.

### CLI helper (node invoke)

Gamitin ang pangunahing `openclaw` CLI upang i-invoke ang mga command ng camera sa macOS node.

Mga halimbawa:

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

Mga tala:

- Ang `openclaw nodes camera snap` ay default sa `maxWidth=1600` maliban kung i-override.
- Sa macOS, ang `camera.snap` ay naghihintay ng `delayMs` (default 2000ms) pagkatapos ng warm-up/pag-settle ng exposure bago kumuha.
- Ang mga payload ng larawan ay nire-recompress upang mapanatili ang base64 na mas mababa sa 5 MB.

## Kaligtasan + praktikal na limitasyon

- Ang access sa camera at mikropono ay nagti-trigger ng karaniwang OS permission prompts (at nangangailangan ng mga usage string sa Info.plist).
- Ang mga video clip ay may cap (kasalukuyang `<= 60s`) upang maiwasan ang sobrang laki ng node payloads (base64 overhead + mga limitasyon sa mensahe).

## macOS screen video (antas-OS)

Para sa _screen_ video (hindi camera), gamitin ang macOS companion:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Mga tala:

- Nangangailangan ng pahintulot na macOS **Screen Recording** (TCC).

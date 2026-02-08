---
summary: "Command ng lokasyon para sa mga node (location.get), mga mode ng pahintulot, at pag-uugali sa background"
read_when:
  - Pagdaragdag ng suporta sa location node o UI ng mga pahintulot
  - Pagdidisenyo ng mga daloy para sa background location + push
title: "Command ng Lokasyon"
x-i18n:
  source_path: nodes/location-command.md
  source_hash: 23124096256384d2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:39Z
---

# Command ng lokasyon (mga node)

## TL;DR

- `location.get` ay isang node command (sa pamamagitan ng `node.invoke`).
- Naka-off bilang default.
- Gumagamit ang Settings ng selector: Off / While Using / Always.
- Hiwalay na toggle: Precise Location.

## Bakit selector (hindi lang switch)

Multi-level ang mga pahintulot ng OS. Maaari tayong mag-expose ng selector sa app, pero ang OS pa rin ang nagdedesisyon sa aktwal na grant.

- iOS/macOS: maaaring piliin ng user ang **While Using** o **Always** sa mga system prompt/Settings. Maaaring humiling ang app ng upgrade, pero maaaring kailanganin ng OS ang Settings.
- Android: hiwalay na pahintulot ang background location; sa Android 10+ madalas kailangan ng daloy papunta sa Settings.
- Ang precise location ay hiwalay na grant (iOS 14+ “Precise”, Android “fine” vs “coarse”).

Ang selector sa UI ang nagdidikta ng hinihiling naming mode; ang aktwal na grant ay nasa OS settings.

## Model ng settings

Bawat node device:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

Pag-uugali ng UI:

- Ang pagpili ng `whileUsing` ay humihiling ng pahintulot sa foreground.
- Ang pagpili ng `always` ay tinitiyak muna ang `whileUsing`, saka hihiling ng background (o ipapadala ang user sa Settings kung kinakailangan).
- Kapag tinanggihan ng OS ang hinihiling na antas, bumalik sa pinakamataas na naibigay na antas at ipakita ang status.

## Pagmamapa ng pahintulot (node.permissions)

Opsyonal. Ang macOS node ay nag-uulat ng `location` sa pamamagitan ng permissions map; maaaring wala nito ang iOS/Android.

## Command: `location.get`

Tinatawag sa pamamagitan ng `node.invoke`.

Mga param (iminumungkahi):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Response payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Mga error (stable codes):

- `LOCATION_DISABLED`: naka-off ang selector.
- `LOCATION_PERMISSION_REQUIRED`: kulang ang pahintulot para sa hinihiling na mode.
- `LOCATION_BACKGROUND_UNAVAILABLE`: nasa background ang app pero While Using lang ang pinapayagan.
- `LOCATION_TIMEOUT`: walang fix sa tamang oras.
- `LOCATION_UNAVAILABLE`: system failure / walang providers.

## Pag-uugali sa background (hinaharap)

Layunin: makakahiling ang model ng lokasyon kahit nasa background ang node, pero kapag:

- Pinili ng user ang **Always**.
- Pinapayagan ng OS ang background location.
- Pinapayagan ang app na tumakbo sa background para sa lokasyon (iOS background mode / Android foreground service o espesyal na pahintulot).

Push-triggered na daloy (hinaharap):

1. Nagpapadala ang Gateway ng push sa node (silent push o FCM data).
2. Sandaling nagigising ang node at humihiling ng lokasyon mula sa device.
3. Ipinapasa ng node ang payload sa Gateway.

Mga tala:

- iOS: kailangan ang Always permission + background location mode. Maaaring ma-throttle ang silent push; asahan ang paminsan-minsang pagkabigo.
- Android: maaaring kailanganin ng background location ang foreground service; kung hindi, asahan ang pagtanggi.

## Integrasyon ng model/tooling

- Tool surface: ang `nodes` tool ay nagdaragdag ng `location_get` action (kailangan ang node).
- CLI: `openclaw nodes location get --node <id>`.
- Mga gabay para sa agent: tawagin lamang kapag pinagana ng user ang lokasyon at nauunawaan ang saklaw.

## UX copy (iminumungkahi)

- Off: “Naka-disable ang pagbabahagi ng lokasyon.”
- While Using: “Kapag bukas lang ang OpenClaw.”
- Always: “Payagan ang background location. Nangangailangan ng pahintulot ng system.”
- Precise: “Gumamit ng tumpak na GPS location. I-toggle off para magbahagi ng tinatayang lokasyon.”

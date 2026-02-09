---
summary: "Felsök nodparning, förgrundskrav, behörigheter och verktygsfel"
read_when:
  - Noden är ansluten men verktyg för kamera/canvas/skärm/exec misslyckas
  - Du behöver den mentala modellen för nodparning kontra godkännanden
title: "Felsökning av noder"
---

# Felsökning av noder

Använd den här sidan när en nod är synlig i status men nodverktyg misslyckas.

## Kommandostege

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Kör sedan nodspecifika kontroller:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Friska signaler:

- Noden är ansluten och parad för rollen `node`.
- `nodes describe` inkluderar den kapacitet du anropar.
- Exec-godkännanden visar förväntat läge/tillåtelselista.

## Förgrundskrav

`canvas.*`, `camera.*` och `screen.*` är endast tillgängliga i förgrunden på iOS-/Android-noder.

Snabb kontroll och åtgärd:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Om du ser `NODE_BACKGROUND_UNAVAILABLE`, ta fram nodappen i förgrunden och försök igen.

## Behörighetsmatris

| Kapacitet                    | iOS                                                            | Android                                                       | macOS-nodapp                                         | Typisk felkod                  |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Kamera (+ mikrofon för klippljud)           | Kamera (+ mikrofon för klippljud)          | Kamera (+ mikrofon för klippljud) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Skärminspelning (+ mikrofon valfri)         | Skärminspelningsprompt (+ mikrofon valfri) | Skärminspelning                                      | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Vid användning eller Alltid (beror på läge) | Förgrunds-/bakgrundsplats baserat på läge                     | Platsbehörighet                                      | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (nodvärdsökväg)                         | n/a (nodvärdsökväg)                        | Exec-godkännanden krävs                              | `SYSTEM_RUN_DENIED`            |

## Parning kontra godkännanden

Detta är olika grindar:

1. **Enhetsparning**: kan denna nod ansluta till gatewayn?
2. **Exec-godkännanden**: kan denna nod köra ett specifikt skalkommando?

Snabba kontroller:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Om parkoppling saknas, godkänn nodenheten först.
Om parning är bra men `system.run` misslyckas, åtgärda exec godkännanden/tillåtna lista.

## Vanliga nodfelkoder

- `NODE_BACKGROUND_UNAVAILABLE` → appen är i bakgrunden; ta den till förgrunden.
- `CAMERA_DISABLED` → kameraväxeln är inaktiverad i nodinställningarna.
- `*_PERMISSION_REQUIRED` → OS-behörighet saknas/nekad.
- `LOCATION_DISABLED` → platsläge är avstängt.
- `LOCATION_PERMISSION_REQUIRED` → begärt platsläge är inte beviljat.
- `LOCATION_BACKGROUND_UNAVAILABLE` → appen är i bakgrunden men endast behörigheten ”Vid användning” finns.
- `SYSTEM_RUN_DENIED: approval required` → exec-begäran kräver uttryckligt godkännande.
- `SYSTEM_RUN_DENIED: allowlist miss` → kommandot blockeras av tillåtelselistan.

## Snabb återställningsloop

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Om du fortfarande sitter fast:

- Godkänn enhetsparning på nytt.
- Öppna nodappen igen (förgrunden).
- Bevilja OS-behörigheter på nytt.
- Skapa om/justera policyn för exec-godkännanden.

Relaterat:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)

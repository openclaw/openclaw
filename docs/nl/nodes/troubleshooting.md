---
summary: "Problemen oplossen bij node-koppeling, voorgrondvereisten, rechten en toolfouten"
read_when:
  - Node is verbonden maar camera-/canvas-/scherm-/exec-tools falen
  - Je hebt het mentale model nodig voor node-koppeling versus goedkeuringen
title: "Node-problemen oplossen"
---

# Node-problemen oplossen

Gebruik deze pagina wanneer een node zichtbaar is in de status, maar node-tools falen.

## Opdrachtenladder

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Voer daarna node-specifieke controles uit:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Gezonde signalen:

- Node is verbonden en gekoppeld voor rol `node`.
- `nodes describe` bevat de capability die je aanroept.
- Exec-goedkeuringen tonen de verwachte modus/toegestane lijst.

## Voorgrondvereisten

`canvas.*`, `camera.*` en `screen.*` werken alleen in de voorgrond op iOS-/Android-nodes.

Snelle controle en oplossing:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Als je `NODE_BACKGROUND_UNAVAILABLE` ziet, breng de node-app naar de voorgrond en probeer opnieuw.

## Rechtenmatrix

| Capability                   | iOS                                                                                      | Android                                                                                  | macOS node-app                                          | Typische foutcode              |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Camera (+ microfoon voor clip-audio)                                  | Camera (+ microfoon voor clip-audio)                                  | Camera (+ microfoon voor clip-audio) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Schermopname (+ microfoon optioneel)                                  | Schermopnameprompt (+ microfoon optioneel)                            | Schermopname                                            | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Tijdens gebruik of Altijd (afhankelijk van modus)                     | Locatie in voorgrond/achtergrond afhankelijk van modus                                   | Locatierechten                                          | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n.v.t. (node-hostpad) | n.v.t. (node-hostpad) | Exec-goedkeuringen vereist                              | `SYSTEM_RUN_DENIED`            |

## Koppeling versus goedkeuringen

Dit zijn verschillende poorten:

1. **Apparaatkoppeling**: kan deze node verbinding maken met de gateway?
2. **Exec-goedkeuringen**: kan deze node een specifieke shell-opdracht uitvoeren?

Snelle controles:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Als koppeling ontbreekt, keur eerst het node-apparaat goed.
Als koppeling in orde is maar `system.run` faalt, los exec-goedkeuringen/toegestane lijst op.

## Veelvoorkomende node-foutcodes

- `NODE_BACKGROUND_UNAVAILABLE` → app draait op de achtergrond; breng deze naar de voorgrond.
- `CAMERA_DISABLED` → cameraregelschakelaar uitgeschakeld in node-instellingen.
- `*_PERMISSION_REQUIRED` → OS-rechten ontbreken/geweigerd.
- `LOCATION_DISABLED` → locatiemodus staat uit.
- `LOCATION_PERMISSION_REQUIRED` → gevraagde locatiemodus niet verleend.
- `LOCATION_BACKGROUND_UNAVAILABLE` → app draait op de achtergrond maar er bestaat alleen een ‘Tijdens gebruik’-recht.
- `SYSTEM_RUN_DENIED: approval required` → exec-aanvraag vereist expliciete goedkeuring.
- `SYSTEM_RUN_DENIED: allowlist miss` → opdracht geblokkeerd door modus van de toegestane lijst.

## Snelle herstelcyclus

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Als je nog steeds vastzit:

- Keur apparaatkoppeling opnieuw goed.
- Open de node-app opnieuw (voorgrond).
- Verleen OS-rechten opnieuw.
- Maak het exec-goedkeuringsbeleid opnieuw aan of pas het aan.

Gerelateerd:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)

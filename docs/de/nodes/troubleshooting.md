---
summary: "Fehlerbehebung bei Node-Pairing, Vordergrundanforderungen, Berechtigungen und Werkzeugfehlern"
read_when:
  - Node ist verbunden, aber Kamera-/Canvas-/Bildschirm-/Exec-Werkzeuge schlagen fehl
  - Sie benötigen das mentale Modell zu Node-Pairing versus Genehmigungen
title: "Node-Fehlerbehebung"
---

# Node-Fehlerbehebung

Verwenden Sie diese Seite, wenn ein Node im Status sichtbar ist, aber Node-Werkzeuge fehlschlagen.

## Befehlsleiter

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Führen Sie dann node-spezifische Prüfungen aus:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Gesunde Signale:

- Node ist verbunden und für die Rolle `node` gepairt.
- `nodes describe` umfasst die von Ihnen aufgerufene Fähigkeit.
- Exec-Genehmigungen zeigen den erwarteten Modus/die Allowlist.

## Vordergrundanforderungen

`canvas.*`, `camera.*` und `screen.*` sind auf iOS-/Android-Nodes nur im Vordergrund verfügbar.

Schnelle Prüfung und Behebung:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Wenn Sie `NODE_BACKGROUND_UNAVAILABLE` sehen, bringen Sie die Node-App in den Vordergrund und versuchen Sie es erneut.

## Berechtigungsmatrix

| Fähigkeit                    | iOS                                                                       | Android                                                                   | macOS-Node-App                                        | Typischer Fehlercode           |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Kamera (+ Mikrofon für Clip-Audio)                     | Kamera (+ Mikrofon für Clip-Audio)                     | Kamera (+ Mikrofon für Clip-Audio) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Bildschirmaufnahme (+ Mikrofon optional)               | Bildschirmaufnahme-Aufforderung (+ Mikrofon optional)  | Bildschirmaufnahme                                    | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Während der Nutzung oder Immer (abhängig vom Modus)    | Standort im Vorder-/Hintergrund je nach Modus                             | Standortberechtigung                                  | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n. a. (Node-Host-Pfad) | n. a. (Node-Host-Pfad) | Exec-Genehmigungen erforderlich                       | `SYSTEM_RUN_DENIED`            |

## Pairing versus Genehmigungen

Dies sind unterschiedliche Hürden:

1. **Geräte-Pairing**: Kann sich dieser Node mit dem Gateway verbinden?
2. **Exec-Genehmigungen**: Darf dieser Node einen bestimmten Shell-Befehl ausführen?

Schnelle Prüfungen:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Wenn das Pairing fehlt, genehmigen Sie zuerst das Node-Gerät.
Wenn das Pairing in Ordnung ist, aber `system.run` fehlschlägt, korrigieren Sie Exec-Genehmigungen/Allowlist.

## Häufige Node-Fehlercodes

- `NODE_BACKGROUND_UNAVAILABLE` → App ist im Hintergrund; bringen Sie sie in den Vordergrund.
- `CAMERA_DISABLED` → Kamera-Schalter in den Node-Einstellungen deaktiviert.
- `*_PERMISSION_REQUIRED` → Betriebssystem-Berechtigung fehlt/wurde verweigert.
- `LOCATION_DISABLED` → Standortmodus ist deaktiviert.
- `LOCATION_PERMISSION_REQUIRED` → Angeforderter Standortmodus nicht gewährt.
- `LOCATION_BACKGROUND_UNAVAILABLE` → App ist im Hintergrund, aber es existiert nur die Berechtigung „Während der Nutzung“.
- `SYSTEM_RUN_DENIED: approval required` → Exec-Anfrage benötigt eine explizite Genehmigung.
- `SYSTEM_RUN_DENIED: allowlist miss` → Befehl durch Allowlist-Modus blockiert.

## Schneller Wiederherstellungszyklus

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Wenn Sie weiterhin feststecken:

- Geräte-Pairing erneut genehmigen.
- Node-App erneut öffnen (Vordergrund).
- Betriebssystem-Berechtigungen erneut erteilen.
- Exec Genehmigungsrichtlinien neu erstellen/anpassen.

Verwandt:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)

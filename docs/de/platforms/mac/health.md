---
summary: "Wie die macOS-App Gesundheitszustände von Gateway/Baileys meldet"
read_when:
  - Debugging von Gesundheitsanzeigen der macOS-App
title: "Health Checks"
---

# Health Checks unter macOS

So sehen Sie in der Menüleisten‑App, ob der verknüpfte Kanal gesund ist.

## Menüleiste

- Der Statuspunkt spiegelt jetzt den Baileys‑Gesundheitszustand wider:
  - Grün: verknüpft + Socket kürzlich geöffnet.
  - Orange: verbindet sich / versucht erneut.
  - Rot: abgemeldet oder Probe fehlgeschlagen.
- Die zweite Zeile zeigt „linked · auth 12m“ oder den Fehlergrund an.
- Der Menüpunkt „Run Health Check“ löst eine On‑Demand‑Probe aus.

## Einstellungen

- Der Tab „Allgemein“ erhält eine Health‑Karte mit: Alter der verknüpften Authentifizierung, Pfad/Anzahl des Session‑Stores, Zeitpunkt der letzten Prüfung, letzter Fehler/Statuscode sowie Schaltflächen für „Run Health Check“ / „Reveal Logs“.
- Verwendet einen zwischengespeicherten Snapshot, damit die UI sofort lädt und bei Offline‑Status elegant zurückfällt.
- Der **Tab „Kanäle“** zeigt Kanalstatus + Steuerungen für WhatsApp/Telegram (Login‑QR, Logout, Probe, letzte Trennung/Fehler).

## Funktionsweise der Probe

- Die App führt `openclaw health --json` über `ShellExecutor` etwa alle ~60 s und bei Bedarf aus. Die Probe lädt Anmeldedaten und meldet den Status, ohne Nachrichten zu senden.
- Der letzte gute Snapshot und der letzte Fehler werden getrennt zwischengespeichert, um Flackern zu vermeiden; jeweils mit Zeitstempel.

## Im Zweifelsfall

- Sie können weiterhin den CLI‑Ablauf in [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) verwenden und `/tmp/openclaw/openclaw-*.log` für `web-heartbeat` / `web-reconnect` verfolgen.

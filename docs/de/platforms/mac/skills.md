---
summary: "„macOS-Skills-Einstellungs-UI und Gateway-gestützter Status“"
read_when:
  - „Aktualisieren der macOS-Skills-Einstellungs-UI“
  - „Ändern der Skills-Gating- oder Installationslogik“
title: "„Skills“"
---

# Skills (macOS)

Die macOS-App stellt OpenClaw Skills über das Gateway bereit; sie wertet Skills nicht lokal aus.

## Datenquelle

- `skills.status` (Gateway) gibt alle Skills sowie Eignung und fehlende Anforderungen zurück
  (einschließlich Allowlist-Sperren für gebündelte Skills).
- Anforderungen werden aus `metadata.openclaw.requires` in jeder `SKILL.md` abgeleitet.

## Installationsaktionen

- `metadata.openclaw.install` definiert Installationsoptionen (brew/node/go/uv).
- Die App ruft `skills.install` auf, um Installer auf dem Gateway-Host auszuführen.
- Das Gateway stellt nur einen bevorzugten Installer bereit, wenn mehrere vorhanden sind
  (brew, wenn verfügbar, andernfalls der Node-Manager aus `skills.install`, standardmäßig npm).

## Env/API-Schlüssel

- Die App speichert Schlüssel in `~/.openclaw/openclaw.json` unter `skills.entries.<skillKey>`.
- `skills.update` patcht `enabled`, `apiKey` und `env`.

## Remote-Modus

- Installation und Konfigurationsaktualisierungen erfolgen auf dem Gateway-Host (nicht auf dem lokalen Mac).

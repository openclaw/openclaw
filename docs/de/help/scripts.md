---
summary: "„Repository-Skripte: Zweck, Umfang und Sicherheitshinweise“"
read_when:
  - Ausführen von Skripten aus dem Repository
  - Hinzufügen oder Ändern von Skripten unter ./scripts
title: "Skripte"
---

# Skripte

Das Verzeichnis `scripts/` enthält Hilfsskripte für lokale Workflows und Betriebsaufgaben.
Nutzen Sie diese, wenn eine Aufgabe eindeutig an ein Skript gebunden ist; andernfalls bevorzugen Sie die CLI.

## Konventionen

- Skripte sind **optional**, sofern sie nicht in der Dokumentation oder in Release-Checklisten referenziert werden.
- Bevorzugen Sie CLI-Oberflächen, wenn diese existieren (Beispiel: Authentifizierungsüberwachung verwendet `openclaw models status --check`).
- Gehen Sie davon aus, dass Skripte host-spezifisch sind; lesen Sie sie, bevor Sie sie auf einer neuen Maschine ausführen.

## Skripte zur Authentifizierungsüberwachung

Skripte zur Authentifizierungsüberwachung sind hier dokumentiert:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Beim Hinzufügen von Skripten

- Halten Sie Skripte fokussiert und dokumentiert.
- Fügen Sie einen kurzen Eintrag in der relevanten Dokumentation hinzu (oder erstellen Sie eine, falls sie fehlt).

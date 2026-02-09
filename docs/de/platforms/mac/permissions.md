---
summary: "Persistenz von macOS-Berechtigungen (TCC) und Signierungsanforderungen"
read_when:
  - Debugging fehlender oder hängen gebliebener macOS-Berechtigungsabfragen
  - Paketierung oder Signierung der macOS-App
  - Ändern von Bundle-IDs oder App-Installationspfaden
title: "macOS-Berechtigungen"
---

# macOS-Berechtigungen (TCC)

macOS-Berechtigungsfreigaben sind fragil. TCC verknüpft eine Berechtigungsfreigabe mit der
Codesignatur, der Bundle-ID und dem Pfad auf dem Datenträger der App. Wenn sich eines davon ändert,
behandelt macOS die App als neu und kann Abfragen verwerfen oder ausblenden.

## Anforderungen für stabile Berechtigungen

- Gleicher Pfad: Führen Sie die App von einem festen Speicherort aus (für OpenClaw: `dist/OpenClaw.app`).
- Gleiche Bundle-ID: Das Ändern der Bundle-ID erzeugt eine neue Berechtigungsidentität.
- Signierte App: Nicht signierte oder ad-hoc-signierte Builds speichern Berechtigungen nicht.
- Konsistente Signatur: Verwenden Sie ein echtes Apple Development- oder Developer-ID-Zertifikat,
  damit die Signatur über Neubuilds hinweg stabil bleibt.

Ad-hoc-Signaturen erzeugen bei jedem Build eine neue Identität. macOS vergisst frühere
Freigaben, und Abfragen können vollständig verschwinden, bis veraltete Einträge gelöscht werden.

## Wiederherstellungs-Checkliste, wenn Abfragen verschwinden

1. Beenden Sie die App.
2. Entfernen Sie den App-Eintrag in Systemeinstellungen -> Datenschutz & Sicherheit.
3. Starten Sie die App vom gleichen Pfad erneut und erteilen Sie die Berechtigungen erneut.
4. Wenn die Abfrage weiterhin nicht erscheint, setzen Sie TCC-Einträge mit `tccutil` zurück und versuchen Sie es erneut.
5. Einige Berechtigungen erscheinen erst nach einem vollständigen Neustart von macOS wieder.

Beispiel-Resets (Bundle-ID bei Bedarf ersetzen):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Berechtigungen für Dateien und Ordner (Desktop/Dokumente/Downloads)

macOS kann Desktop, Dokumente und Downloads auch für Terminal-/Hintergrundprozesse sperren. Wenn Dateizugriffe oder Verzeichnisauflistungen hängen bleiben, gewähren Sie Zugriff für denselben Prozesskontext, der die Dateioperationen ausführt (zum Beispiel Terminal/iTerm, eine per LaunchAgent gestartete App oder ein SSH-Prozess).

Workaround: Verschieben Sie Dateien in den OpenClaw-Arbeitsbereich (`~/.openclaw/workspace`), wenn Sie Ordner-spezifische Freigaben vermeiden möchten.

Wenn Sie Berechtigungen testen, signieren Sie stets mit einem echten Zertifikat. Ad-hoc-
Builds sind nur für schnelle lokale Läufe akzeptabel, bei denen Berechtigungen keine Rolle spielen.

---
summary: "OpenClaw-Protokollierung: rotierende Diagnosedatei + Datenschutz-Flags des Unified Logging"
read_when:
  - Erfassen von macOS-Logs oder Untersuchung der Protokollierung privater Daten
  - Debugging von Problemen mit Sprachaktivierung und Sitzungslebenszyklus
title: "macOS-Protokollierung"
---

# Protokollierung (macOS)

## Rotierende Diagnosedatei (Debug-Bereich)

OpenClaw leitet macOS-App-Logs über swift-log (standardmäßig Unified Logging) und kann bei Bedarf ein lokales, rotierendes Dateilog auf die Festplatte schreiben, wenn Sie eine dauerhafte Erfassung benötigen.

- Ausführlichkeit: **Debug-Bereich → Logs → App-Protokollierung → Ausführlichkeit**
- Aktivieren: **Debug-Bereich → Logs → App-Protokollierung → „Rotierendes Diagnoselog schreiben (JSONL)“**
- Speicherort: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rotiert automatisch; alte Dateien erhalten die Suffixe `.1`, `.2`, …)
- Leeren: **Debug-Bereich → Logs → App-Protokollierung → „Leeren“**

Hinweise:

- Dies ist **standardmäßig deaktiviert**. Aktivieren Sie es nur während des aktiven Debuggings.
- Behandeln Sie die Datei als sensibel; geben Sie sie nicht ohne Prüfung weiter.

## Private Daten im Unified Logging unter macOS

Unified Logging redigiert die meisten Nutzdaten, sofern sich ein Subsystem nicht für `privacy -off` entscheidet. Laut Peters Beitrag zu macOS [„logging privacy shenanigans“](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) wird dies über eine plist in `/Library/Preferences/Logging/Subsystems/` gesteuert, die nach dem Subsystem-Namen geschlüsselt ist. Nur neue Logeinträge übernehmen das Flag, aktivieren Sie es daher vor dem Reproduzieren eines Problems.

## Für OpenClaw aktivieren (`bot.molt`)

- Schreiben Sie die plist zunächst in eine temporäre Datei und installieren Sie sie anschließend atomar als Root:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- Ein Neustart ist nicht erforderlich; logd erkennt die Datei schnell, aber nur neue Logzeilen enthalten private Nutzdaten.
- Zeigen Sie die umfangreichere Ausgabe mit dem vorhandenen Hilfswerkzeug an, z. B. `./scripts/clawlog.sh --category WebChat --last 5m`.

## Nach dem Debugging deaktivieren

- Entfernen Sie die Überschreibung: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Optional führen Sie `sudo log config --reload` aus, um logd zu zwingen, die Überschreibung sofort zu verwerfen.
- Denken Sie daran, dass diese Oberfläche Telefonnummern und Nachrichteninhalte enthalten kann; belassen Sie die plist nur so lange an Ort und Stelle, wie Sie die zusätzlichen Details aktiv benötigen.

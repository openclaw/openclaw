---
summary: "„Kontextfenster + Kompaktierung: wie OpenClaw Sitzungen innerhalb der Modellgrenzen hält“"
read_when:
  - Sie möchten Auto-Kompaktierung und /compact verstehen
  - Sie debuggen lange Sitzungen, die an Kontextgrenzen stoßen
title: "Verdichtung"
---

# Kontextfenster & Kompaktierung

Jedes Modell hat ein **Kontextfenster** (maximale Tokenanzahl, die es sehen kann). Länger laufende Chats sammeln Nachrichten und Werkzeugergebnisse; wird das Fenster knapp, **kompaktiert** OpenClaw ältere Historie, um innerhalb der Grenzen zu bleiben.

## Was Kompaktierung ist

Kompaktierung **fasst ältere Konversationen zusammen** zu einem kompakten Zusammenfassungseintrag und behält aktuelle Nachrichten unverändert bei. Die Zusammenfassung wird im Sitzungsverlauf gespeichert, sodass zukünftige Anfragen verwenden:

- Die Kompaktierungszusammenfassung
- Aktuelle Nachrichten nach dem Kompaktierungspunkt

Kompaktierung **persistiert** im JSONL-Verlauf der Sitzung.

## Konfiguration

Siehe [Compaction config & modes](/concepts/compaction) für die Einstellungen `agents.defaults.compaction`.

## Auto-Kompaktierung (standardmäßig aktiviert)

Wenn sich eine Sitzung dem Kontextfenster des Modells nähert oder es überschreitet, löst OpenClaw die Auto-Kompaktierung aus und kann die ursprüngliche Anfrage mit dem kompaktierten Kontext erneut ausführen.

Sie sehen:

- `🧹 Auto-compaction complete` im ausführlichen Modus
- `/status`, das `🧹 Compactions: <count>` anzeigt

Vor der Kompaktierung kann OpenClaw einen **stillen Memory-Flush** ausführen, um
dauerhafte Notizen auf die Festplatte zu schreiben. Siehe [Memory](/concepts/memory) für Details und Konfiguration.

## Manuelle Kompaktierung

Verwenden Sie `/compact` (optional mit Anweisungen), um einen Kompaktierungslauf zu erzwingen:

```
/compact Focus on decisions and open questions
```

## Quelle des Kontextfensters

Das Kontextfenster ist modellspezifisch. OpenClaw verwendet die Modelldefinition aus dem konfigurierten Anbieter-Katalog, um die Grenzen zu bestimmen.

## Kompaktierung vs. Pruning

- **Kompaktierung**: fasst zusammen und **persistiert** in JSONL.
- **Sitzungs-Pruning**: schneidet nur alte **Werkzeugergebnisse** ab, **im Speicher**, pro Anfrage.

Siehe [/concepts/session-pruning](/concepts/session-pruning) für Details zum Pruning.

## Tipps

- Verwenden Sie `/compact`, wenn sich Sitzungen abgestanden anfühlen oder der Kontext aufgebläht ist.
- Große Werkzeugausgaben werden bereits gekürzt; Pruning kann den Aufbau von Werkzeugergebnissen weiter reduzieren.
- Wenn Sie einen Neustart benötigen, startet `/new` oder `/reset` eine neue Sitzungs-ID.

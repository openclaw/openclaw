---
summary: "„Wie OpenClaw Prompt-Kontext aufbaut und Token-Nutzung sowie Kosten meldet“"
read_when:
  - Erläuterung von Token-Nutzung, Kosten oder Kontextfenstern
  - Debugging von Kontextwachstum oder Kompaktierungsverhalten
title: "„Token-Nutzung und Kosten“"
---

# Token-Nutzung & Kosten

OpenClaw verfolgt **Tokens**, nicht Zeichen. Tokens sind modellspezifisch, aber die meisten
OpenAI‑ähnlichen Modelle liegen im Durchschnitt bei ca. 4 Zeichen pro Token für englischen Text.

## Wie der System-Prompt aufgebaut wird

OpenClaw setzt bei jedem Lauf seinen eigenen System-Prompt zusammen. Er enthält:

- Werkzeugliste + kurze Beschreibungen
- Skills-Liste (nur Metadaten; Anweisungen werden bei Bedarf mit `read` geladen)
- Selbstaktualisierungsanweisungen
- Workspace- + Bootstrap-Dateien (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` bei neuen Sitzungen). Große Dateien werden durch `agents.defaults.bootstrapMaxChars` gekürzt (Standard: 20000).
- Zeit (UTC + Benutzerzeitzone)
- Antwort-Tags + Heartbeat-Verhalten
- Laufzeit-Metadaten (Host/OS/Modell/Thinking)

Die vollständige Aufschlüsselung finden Sie unter [System Prompt](/concepts/system-prompt).

## Was im Kontextfenster zählt

Alles, was das Modell erhält, zählt zum Kontextlimit:

- System-Prompt (alle oben aufgeführten Abschnitte)
- Konversationsverlauf (Nachrichten von Benutzer und Assistent)
- Tool-Aufrufe und Tool-Ergebnisse
- Anhänge/Transkripte (Bilder, Audio, Dateien)
- Kompaktierungszusammenfassungen und Pruning-Artefakte
- Provider-Wrapper oder Sicherheits-Header (nicht sichtbar, werden aber mitgezählt)

Für eine praktische Aufschlüsselung (pro injizierter Datei, Tools, Skills und Größe des System-Prompts) verwenden Sie `/context list` oder `/context detail`. Siehe [Context](/concepts/context).

## Aktuelle Token-Nutzung anzeigen

Verwenden Sie dies im Chat:

- `/status` → **emoji‑reiche Statuskarte** mit Sitzungsmodell, Kontextnutzung,
  Input-/Output-Tokens der letzten Antwort und **geschätzten Kosten** (nur API‑Schlüssel).
- `/usage off|tokens|full` → fügt jeder Antwort eine **pro-Antwort-Nutzungsfußzeile** hinzu.
  - Bleibt pro Sitzung bestehen (gespeichert als `responseUsage`).
  - OAuth‑Authentifizierung **blendet Kosten aus** (nur Tokens).
- `/usage cost` → zeigt eine lokale Kostenübersicht aus OpenClaw Session-Logs.

Weitere Oberflächen:

- **TUI/Web‑TUI:** `/status` + `/usage` werden unterstützt.
- **CLI:** `openclaw status --usage` und `openclaw channels list` zeigen
  Provider‑Kontingentfenster (keine Kosten pro Antwort).

## Kostenschätzung (falls angezeigt)

Kosten werden anhand Ihrer Modell‑Preis-Konfiguration geschätzt:

```
models.providers.<provider>.models[].cost
```

Dies sind **USD pro 1 Mio. Tokens** für `input`, `output`, `cacheRead` und
`cacheWrite`. Wenn Preise fehlen, zeigt OpenClaw nur Tokens an. OAuth‑Tokens
zeigen niemals Dollar‑Kosten an.

## Cache‑TTL und Auswirkungen von Pruning

Provider‑Prompt‑Caching gilt nur innerhalb des Cache‑TTL‑Fensters. OpenClaw kann
optional **Cache‑TTL‑Pruning** ausführen: Die Sitzung wird bereinigt, sobald der Cache‑TTL
abgelaufen ist, und anschließend wird das Cache‑Fenster zurückgesetzt, sodass
nachfolgende Anfragen den frisch gecachten Kontext wiederverwenden können, anstatt
den gesamten Verlauf erneut zu cachen. Dies hält die Cache‑Schreibkosten niedrig,
wenn eine Sitzung über den TTL hinaus inaktiv ist.

Konfigurieren Sie dies in der [Gateway‑Konfiguration](/gateway/configuration) und
sehen Sie die Verhaltensdetails unter [Session pruning](/concepts/session-pruning).

Der Heartbeat kann den Cache über Leerlaufphasen hinweg **warm** halten. Wenn Ihr
Modell‑Cache‑TTL `1h` beträgt, kann das Setzen des Heartbeat‑Intervalls knapp darunter
(z. B. `55m`) das erneute Cachen des gesamten Prompts vermeiden und so
Cache‑Schreibkosten reduzieren.

Für Anthropic‑API‑Preise sind Cache‑Lesevorgänge deutlich günstiger als Input‑Tokens,
während Cache‑Schreibvorgänge mit einem höheren Multiplikator berechnet werden. Die aktuellen Sätze und TTL‑Multiplikatoren finden Sie in Anthropics
Prompt‑Caching‑Preisen:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Beispiel: 1‑h‑Cache mit Heartbeat warm halten

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Tipps zur Reduzierung des Token‑Drucks

- Verwenden Sie `/compact`, um lange Sitzungen zusammenzufassen.
- Kürzen Sie große Tool‑Ausgaben in Ihren Workflows.
- Halten Sie Skill‑Beschreibungen kurz (die Skill‑Liste wird in den Prompt injiziert).
- Bevorzugen Sie kleinere Modelle für ausführliche, explorative Arbeit.

Siehe [Skills](/tools/skills) für die exakte Formel zum Overhead der Skill‑Liste.

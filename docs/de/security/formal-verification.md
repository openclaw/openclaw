---
title: Formale Verifikation (Sicherheitsmodelle)
summary: Maschinell geprüfte Sicherheitsmodelle für die risikoreichsten Pfade von OpenClaw.
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:37:28Z
---

# Formale Verifikation (Sicherheitsmodelle)

Diese Seite verfolgt die **formalen Sicherheitsmodelle** von OpenClaw (heute TLA+/TLC; bei Bedarf weitere).

> Hinweis: Einige ältere Links können sich auf den früheren Projektnamen beziehen.

**Ziel (Nordstern):** ein maschinell geprüftes Argument liefern, dass OpenClaw seine
beabsichtigte Sicherheitsrichtlinie (Autorisierung, Sitzungsisolierung, Werkzeug-Freigabe und
Sicherheit bei Fehlkonfigurationen) unter expliziten Annahmen durchsetzt.

**Was das ist (heute):** eine ausführbare, angreifergetriebene **Sicherheits-Regressionssuite**:

- Jede Behauptung hat eine ausführbare Model-Check-Prüfung über einen endlichen Zustandsraum.
- Viele Behauptungen haben ein gekoppeltes **negatives Modell**, das eine Gegenbeispiel-Spur für eine realistische Fehlerklasse erzeugt.

**Was das (noch) nicht ist:** ein Beweis, dass „OpenClaw in jeder Hinsicht sicher ist“, oder dass die vollständige TypeScript-Implementierung korrekt ist.

## Wo die Modelle liegen

Die Modelle werden in einem separaten Repo gepflegt: [vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models).

## Wichtige Einschränkungen

- Dies sind **Modelle**, nicht die vollständige TypeScript-Implementierung. Abweichungen zwischen Modell und Code sind möglich.
- Ergebnisse sind durch den von TLC erkundeten Zustandsraum begrenzt; „grün“ impliziert keine Sicherheit über die modellierten Annahmen und Grenzen hinaus.
- Einige Behauptungen stützen sich auf explizite Umgebungsannahmen (z. B. korrekte Bereitstellung, korrekte Konfigurationseingaben).

## Ergebnisse reproduzieren

Derzeit werden Ergebnisse reproduziert, indem das Modelle-Repo lokal geklont und TLC ausgeführt wird (siehe unten). Eine zukünftige Iteration könnte bieten:

- CI-ausgeführte Modelle mit öffentlichen Artefakten (Gegenbeispiel-Spuren, Run-Logs)
- einen gehosteten „Dieses Modell ausführen“-Workflow für kleine, begrenzte Prüfungen

Erste Schritte:

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway-Exposition und offene Gateway-Fehlkonfiguration

**Behauptung:** Bindung über loopback hinaus ohne Authentifizierung kann eine Remote-Kompromittierung ermöglichen bzw. die Angriffsfläche erhöhen; Token/Passwort blockieren nicht autorisierte Angreifer (gemäß den Modellannahmen).

- Grüne Läufe:
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- Rot (erwartet):
  - `make gateway-exposure-v2-negative`

Siehe auch: `docs/gateway-exposure-matrix.md` im Modelle-Repo.

### Nodes.run-Pipeline (höchstriskante Fähigkeit)

**Behauptung:** `nodes.run` erfordert (a) eine Node-Befehl-Allowlist plus deklarierte Befehle und (b) Live-Genehmigung, wenn konfiguriert; Genehmigungen sind tokenisiert, um Replay zu verhindern (im Modell).

- Grüne Läufe:
  - `make nodes-pipeline`
  - `make approvals-token`
- Rot (erwartet):
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### Pairing-Store (DM-Gating)

**Behauptung:** Pairing-Anfragen berücksichtigen TTL und Limits für ausstehende Anfragen.

- Grüne Läufe:
  - `make pairing`
  - `make pairing-cap`
- Rot (erwartet):
  - `make pairing-negative`
  - `make pairing-cap-negative`

### Ingress-Gating (Erwähnungen + Umgehung von Kontrollbefehlen)

**Behauptung:** In Gruppenkontexten, die eine Erwähnung erfordern, kann ein nicht autorisierter „Kontrollbefehl“ das Erwähnungs-Gating nicht umgehen.

- Grün:
  - `make ingress-gating`
- Rot (erwartet):
  - `make ingress-gating-negative`

### Routing-/Sitzungsschlüssel-Isolierung

**Behauptung:** Direktnachrichten von unterschiedlichen Peers fallen nicht in dieselbe Sitzung zusammen, sofern sie nicht explizit verknüpft/konfiguriert sind.

- Grün:
  - `make routing-isolation`
- Rot (erwartet):
  - `make routing-isolation-negative`

## v1++: zusätzliche begrenzte Modelle (Nebenläufigkeit, Retries, Trace-Korrektheit)

Dies sind nachgelagerte Modelle, die die Genauigkeit im Hinblick auf reale Fehlermodi (nicht-atomare Updates, Retries und Message-Fan-out) erhöhen.

### Pairing-Store-Nebenläufigkeit / Idempotenz

**Behauptung:** Ein Pairing-Store sollte `MaxPending` und Idempotenz selbst unter Interleavings durchsetzen (d. h. „check-then-write“ muss atomar/gesperrt sein; Refresh darf keine Duplikate erzeugen).

Was das bedeutet:

- Unter gleichzeitigen Anfragen kann `MaxPending` für einen Kanal nicht überschritten werden.
- Wiederholte Anfragen/Refreshes für denselben `(channel, sender)` sollten keine doppelten aktiven Pending-Zeilen erzeugen.

- Grüne Läufe:
  - `make pairing-race` (atomare/gesperrte Cap-Prüfung)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- Rot (erwartet):
  - `make pairing-race-negative` (nicht-atomarer Begin/Commit-Cap-Race)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### Ingress-Trace-Korrelation / Idempotenz

**Behauptung:** Die Ingestion sollte die Trace-Korrelation über Fan-out hinweg bewahren und unter Provider-Retries idempotent sein.

Was das bedeutet:

- Wenn ein externes Ereignis zu mehreren internen Nachrichten wird, behält jeder Teil dieselbe Trace-/Ereignisidentität.
- Retries führen nicht zu doppelter Verarbeitung.
- Wenn Provider-Ereignis-IDs fehlen, fällt die Deduplizierung auf einen sicheren Schlüssel (z. B. Trace-ID) zurück, um das Verwerfen unterschiedlicher Ereignisse zu vermeiden.

- Grün:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Rot (erwartet):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### Routing dmScope-Priorität + identityLinks

**Behauptung:** Das Routing muss DM-Sitzungen standardmäßig isoliert halten und Sitzungen nur dann zusammenführen, wenn dies explizit konfiguriert ist (Kanal-Priorität + Identity-Links).

Was das bedeutet:

- Kanal-spezifische dmScope-Overrides müssen gegenüber globalen Standardwerten Vorrang haben.
- identityLinks sollten nur innerhalb explizit verknüpfter Gruppen zusammenführen, nicht über nicht zusammenhängende Peers hinweg.

- Grün:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Rot (erwartet):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`

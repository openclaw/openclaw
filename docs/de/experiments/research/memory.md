---
summary: "Forschungsnotizen: Offline-Memory-System für Clawd-Workspaces (Markdown als Source of Truth + abgeleiteter Index)"
read_when:
  - Entwurf von Workspace-Memory (~/.openclaw/workspace) über tägliche Markdown-Logs hinaus
  - Deciding: "Entscheidung: eigenständige CLI vs. tiefe OpenClaw-Integration"
  - Hinzufügen von Offline-Recall + Reflexion (retain/recall/reflect)
title: "Workspace-Memory-Forschung"
---

# Workspace Memory v2 (offline): Forschungsnotizen

Ziel: Clawd-ähnlicher Workspace (`agents.defaults.workspace`, Standard `~/.openclaw/workspace`), in dem „Memory“ als eine Markdown-Datei pro Tag (`memory/YYYY-MM-DD.md`) plus ein kleiner Satz stabiler Dateien (z. B. `memory.md`, `SOUL.md`) gespeichert wird.

Dieses Dokument schlägt eine **offline-first**-Memory-Architektur vor, die Markdown als kanonische, überprüfbare Source of Truth beibehält, aber **strukturierte Recall-Funktionen** (Suche, Entitätszusammenfassungen, Konfidenz-Updates) über einen abgeleiteten Index ergänzt.

## Warum ändern?

Das aktuelle Setup (eine Datei pro Tag) ist hervorragend für:

- „append-only“-Journaling
- menschliche Bearbeitung
- git-gestützte Dauerhaftigkeit + Auditierbarkeit
- geringe Reibungsaufnahmen („einfach aufschreiben“)

Es ist schwach bei:

- Retrieval mit hoher Trefferquote („Was haben wir zu X entschieden?“, „Wann haben wir Y zuletzt ausprobiert?“)
- entitätszentrierten Antworten („Erzähl mir etwas über Alice / The Castle / warelay“) ohne viele Dateien erneut zu lesen
- Stabilität von Meinungen/Präferenzen (und Nachweise bei Änderungen)
- Zeitbezug („Was galt im Nov 2025?“) und Konfliktauflösung und Konfliktlösung

## Designziele

- **Offline**: funktioniert ohne Netzwerk; läuft auf Laptop/Castle; keine Cloud-Abhängigkeit.
- **Erklärbar**: abgerufene Elemente sollten zuordenbar sein (Datei + Position) und von Inferenz trennbar.
- **Geringer Aufwand**: tägliches Logging bleibt Markdown, keine schwere Schemaarbeit.
- **Inkrementell**: v1 ist bereits mit FTS nützlich; semantische/Vektor-Ansätze und Graphen sind optionale Upgrades.
- **Agent-freundlich**: erleichtert „Recall innerhalb von Token-Budgets“ (Rückgabe kleiner Faktenbündel).

## Nordstern-Modell (Hindsight × Letta)

Zwei zu mischende Stücke:

1. **Letta/MemGPT-ähnliche Kontrollschleife**

- einen kleinen „Kern“ stets im Kontext halten (Persona + zentrale Nutzerfakten)
- alles andere liegt außerhalb des Kontexts und wird über Werkzeuge abgerufen
- Memory-Schreibvorgänge sind explizite Tool-Aufrufe (append/replace/insert), werden persistiert und im nächsten Turn erneut injiziert

2. **Hindsight-ähnliches Memory-Substrat**

- Trennung dessen, was beobachtet wird, was geglaubt wird und was zusammengefasst ist
- Unterstützung von retain/recall/reflect
- meinungstragende Aussagen mit Konfidenz, die sich mit Evidenz weiterentwickeln
- entitätsbewusste Retrievals + zeitliche Abfragen (auch ohne vollständige Wissensgraphen)

## Vorgeschlagene Architektur (Markdown als Source of Truth + abgeleiteter Index)

### Kanonischer Speicher (git-freundlich)

Behalten Sie `~/.openclaw/workspace` als kanonischen, menschenlesbaren Memory-Speicher bei.

Vorgeschlagenes Workspace-Layout:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Hinweise:

- **Tägliches Log bleibt tägliches Log**. Es muss nicht in JSON umgewandelt werden.
- Die `bank/`-Dateien sind **kuratiert**, werden durch Reflexionsjobs erzeugt und können weiterhin von Hand bearbeitet werden.
- `memory.md` bleibt „klein + kernnah“: die Dinge, die Clawd in jeder Sitzung sehen soll.

### Abgeleiteter Speicher (maschinelles Recall)

Fügen Sie einen abgeleiteten Index unter dem Workspace hinzu (nicht zwingend per git getrackt):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Unterlegt durch:

- SQLite-Schema für Fakten + Entitätsverknüpfungen + Meinungsmetadaten
- SQLite **FTS5** für lexikalisches Recall (schnell, klein, offline)
- optionale Embeddings-Tabelle für semantisches Recall (weiterhin offline)

Der Index ist jederzeit **aus Markdown neu aufbaubar**.

## Retain / Recall / Reflect (operativer Loop)

### Retain: tägliche Logs in „Fakten“ normalisieren

Hindsights zentrale, hier relevante Erkenntnis: **narrative, in sich geschlossene Fakten** speichern, nicht winzige Snippets.

Praktische Regel für `memory/YYYY-MM-DD.md`:

- fügen Sie am Tagesende (oder währenddessen) einen Abschnitt `## Retain` mit 2–5 Stichpunkten hinzu, die:
  - narrativ sind (kontextübergreifend)
  - eigenständig (Standalone macht später Sinn)
  - mit Typ + Entitätsnennungen getaggt sind

Beispiel:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Minimales Parsing:

- Typ-Präfix: `W` (Welt), `B` (Erfahrung/biografisch), `O` (Meinung), `S` (Beobachtung/Zusammenfassung; meist generiert)
- Entitäten: `@Peter`, `@warelay` usw. (Slugs mappen auf `bank/entities/*.md`)
- Meinungs-Konfidenz: `O(c=0.0..1.0)` optional

Wenn Autorinnen und Autoren darüber nicht nachdenken sollen: Der Reflexionsjob kann diese Stichpunkte aus dem restlichen Log ableiten, aber ein expliziter Abschnitt `## Retain` ist der einfachste „Qualitätshebel“.

### Recall: Abfragen über den abgeleiteten Index

Recall sollte unterstützen:

- **lexikalisch**: „exakte Begriffe / Namen / Commands finden“ (FTS5)
- **entitätsbezogen**: „Erzähl mir etwas über X“ (Entitätsseiten + entitätsverknüpfte Fakten)
- **zeitlich**: „Was geschah um den 27. Nov“ / „seit letzter Woche“
- **meinungsbezogen**: „Was bevorzugt Peter?“ (mit Konfidenz + Evidenz) (mit Vertrauen + Beweis)

Das Rückgabeformat sollte agentenfreundlich sein und Quellen zitieren:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (Quelldatum oder extrahierter Zeitraum, falls vorhanden)
- `entities` (`["Peter","warelay"]`)
- `content` (der narrative Fakt)
- `source` (`memory/2025-11-27.md#L12` usw.)

### Reflect: stabile Seiten erzeugen + Überzeugungen aktualisieren

Reflexion ist ein geplanter Job (täglich oder Heartbeat `ultrathink`), der:

- `bank/entities/*.md` aus aktuellen Fakten aktualisiert (Entitätszusammenfassungen)
- die Konfidenz von `bank/opinions.md` basierend auf Bestätigung/Widerspruch aktualisiert
- optional Bearbeitungsvorschläge für `memory.md` macht („kernnahe“ dauerhafte Fakten)

Meinungsentwicklung (einfach, erklärbar):

- jede Meinung hat:
  - Aussage
  - Konfidenz `c ∈ [0,1]`
  - last_updated
  - Evidenz-Links (unterstützende + widersprechende Fakten-IDs)
- wenn neue Fakten eintreffen:
  - Kandidatenmeinungen über Entitätsüberlappung + Ähnlichkeit finden (zuerst FTS, später Embeddings)
  - Konfidenz in kleinen Deltas anpassen; große Sprünge erfordern starken Widerspruch + wiederholte Evidenz

## CLI-Integration: eigenständig vs. tiefe Integration

Empfehlung: **tiefe Integration in OpenClaw**, aber mit trennbarer Kernbibliothek.

### Warum in OpenClaw integrieren?

- OpenClaw kennt bereits:
  - den Workspace-Pfad (`agents.defaults.workspace`)
  - das Sitzungsmodell + Heartbeats
  - Logging- + Fehlerbehebungsmuster
- Der Agent selbst soll die Tools aufrufen:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### Warum dennoch eine Bibliothek abspalten?

- Memory-Logik ohne Gateway/Runtime testbar halten
- Wiederverwendung in anderen Kontexten (lokale Skripte, zukünftige Desktop-App usw.)

Form:
Die Memory-Tools sind als kleine CLI + Bibliotheksschicht gedacht; dies ist jedoch rein explorativ.

## „S-Collide“ / SuCo: wann einsetzen (Forschung)

Wenn sich „S-Collide“ auf **SuCo (Subspace Collision)** bezieht: Es handelt sich um einen ANN-Retrieval-Ansatz, der starke Recall-/Latenz-Kompromisse durch gelernte/strukturierte Kollisionen in Subräumen anstrebt (Paper: arXiv 2411.14754, 2024).

Pragmatische Einschätzung für `~/.openclaw/workspace`:

- **nicht starten** mit SuCo.
- mit SQLite FTS + (optional) einfachen Embeddings starten; damit erzielen Sie sofort die meisten UX-Gewinne.
- SuCo/HNSW/ScaNN-ähnliche Lösungen erst erwägen, wenn:
  - der Korpus groß ist (Zehntausende/Hunderttausende Chunks)
  - brute-force Embedding-Suche zu langsam wird
  - die Recall-Qualität sinnvollerweise durch lexikalische Suche limitiert ist

Offline-freundliche Alternativen (in steigender Komplexität):

- SQLite FTS5 + Metadatenfilter (kein ML)
- Embeddings + brute force (funktioniert überraschend lange bei geringer Chunk-Zahl)
- HNSW-Index (verbreitet, robust; benötigt eine Bibliotheksbindung)
- SuCo (Forschungsniveau; attraktiv, wenn es eine solide, einbettbare Implementierung gibt)

Offene Frage:

- welches ist das **beste** Offline-Embedding-Modell für „Personal-Assistant-Memory“ auf Ihren Maschinen (Laptop + Desktop)?
  - wenn Sie bereits Ollama nutzen: mit einem lokalen Modell embeddieren; andernfalls ein kleines Embedding-Modell in die Toolchain integrieren.

## Kleinstes nützliches Pilotprojekt

Wenn Sie eine minimale, dennoch nützliche Version möchten:

- Fügen Sie `bank/`-Entitätsseiten und einen Abschnitt `## Retain` in täglichen Logs hinzu.
- Nutzen Sie SQLite FTS für Recall mit Zitaten (Pfad + Zeilennummern).
- Embeddings nur hinzufügen, wenn Recall-Qualität oder Skalierung es erfordern.

## Referenzen

- Letta-/MemGPT-Konzepte: „core memory blocks“ + „archival memory“ + toolgesteuerte, selbsteditierende Memory.
- Hindsight Technical Report: „retain / recall / reflect“, Vier-Netzwerk-Memory, narrative Faktenextraktion, Konfidenzentwicklung von Meinungen.
- SuCo: arXiv 2411.14754 (2024): „Subspace Collision“ Approximate-Nearest-Neighbor-Retrieval.

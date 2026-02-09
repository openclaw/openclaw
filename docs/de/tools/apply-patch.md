---
summary: "„Mehrdatei-Patches mit dem Werkzeug apply_patch anwenden“"
read_when:
  - Sie benötigen strukturierte Dateibearbeitungen über mehrere Dateien hinweg
  - Sie möchten patchbasierte Bearbeitungen dokumentieren oder debuggen
title: "„apply_patch-Werkzeug“"
---

# apply_patch-Werkzeug

Wenden Sie Dateiänderungen mit einem strukturierten Patch-Format an. Dies ist ideal für Änderungen über mehrere Dateien
oder mehrere Hunks hinweg, bei denen ein einzelner `edit`-Aufruf fragil wäre.

Das Werkzeug akzeptiert eine einzelne `input`-Zeichenkette, die eine oder mehrere Dateioperationen kapselt:

```
*** Begin Patch
*** Add File: path/to/file.txt
+line 1
+line 2
*** Update File: src/app.ts
@@
-old line
+new line
*** Delete File: obsolete.txt
*** End Patch
```

## Parameter

- `input` (erforderlich): Vollständiger Patch-Inhalt einschließlich `*** Begin Patch` und `*** End Patch`.

## Hinweise

- Pfade werden relativ zum Workspace-Stamm aufgelöst.
- Verwenden Sie `*** Move to:` innerhalb eines `*** Update File:`-Hunks, um Dateien umzubenennen.
- `*** End of File` kennzeichnet bei Bedarf ein reines EOF-Insertion.
- Experimentell und standardmäßig deaktiviert. Aktivieren Sie es mit `tools.exec.applyPatch.enabled`.
- Nur für OpenAI (einschließlich OpenAI Codex). Optional nach Modell steuerbar über
  `tools.exec.applyPatch.allowModels`.
- Die Konfiguration befindet sich ausschließlich unter `tools.exec`.

## Beispiel

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

---
summary: "Tillämpa flerfils-patchar med verktyget apply_patch"
read_when:
  - Du behöver strukturerade filändringar över flera filer
  - Du vill dokumentera eller felsöka patch-baserade ändringar
title: "apply_patch-verktyget"
---

# apply_patch tool

Tillämpa filändringar med ett strukturerat patch-format. Detta är idealiskt för multi-file
eller multi-hunk redigeringar där ett enda `edit`-anrop skulle vara sprött.

Verktyget accepterar en enda `input`-sträng som omsluter en eller flera filoperationer:

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

## Parametrar

- `input` (krävs): Fullständigt patchinnehåll inklusive `*** Begin Patch` och `*** End Patch`.

## Noteringar

- Sökvägar löses relativt arbetsytans rot.
- Använd `*** Move to:` inom en `*** Update File:`-hunk för att byta namn på filer.
- `*** End of File` markerar en enbart EOF-infogning när det behövs.
- Experimentell och inaktiverad som standard. Aktivera med `tools.exec.applyPatch.enabled`.
- OpenAI-endast (inklusive OpenAI Codex). Valfritt gate av modell via
  `tools.exec.applyPatch.allowModels`.
- Konfiguration finns endast under `tools.exec`.

## Exempel

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

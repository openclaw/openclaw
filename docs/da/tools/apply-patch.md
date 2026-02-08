---
summary: "Anvend patches på tværs af flere filer med værktøjet apply_patch"
read_when:
  - Du har brug for strukturerede filredigeringer på tværs af flere filer
  - Du vil dokumentere eller fejlfinde patch-baserede redigeringer
title: "apply_patch-værktøj"
x-i18n:
  source_path: tools/apply-patch.md
  source_hash: 8cec2b4ee3afa910
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:40Z
---

# apply_patch-værktøj

Anvend filændringer ved hjælp af et struktureret patch-format. Dette er ideelt til redigeringer på tværs af flere filer
eller flere hunks, hvor et enkelt `edit`-kald ville være skrøbeligt.

Værktøjet accepterer en enkelt `input`-streng, der indkapsler én eller flere filoperationer:

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

## Parametre

- `input` (påkrævet): Fuldt patch-indhold inklusive `*** Begin Patch` og `*** End Patch`.

## Noter

- Stier opløses relativt til workspace-roden.
- Brug `*** Move to:` inden for en `*** Update File:`-hunk til at omdøbe filer.
- `*** End of File` markerer en indsættelse kun ved EOF, når det er nødvendigt.
- Eksperimentel og deaktiveret som standard. Aktivér med `tools.exec.applyPatch.enabled`.
- Kun OpenAI (inklusive OpenAI Codex). Kan valgfrit afgrænses efter model via
  `tools.exec.applyPatch.allowModels`.
- Konfiguration findes kun under `tools.exec`.

## Eksempel

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

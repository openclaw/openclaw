---
summary: "Pas patches voor meerdere bestanden toe met de apply_patch-tool"
read_when:
  - Je hebt gestructureerde bestandsbewerkingen over meerdere bestanden nodig
  - Je wilt patch-gebaseerde bewerkingen documenteren of debuggen
title: "apply_patch-tool"
---

# apply_patch-tool

Pas bestandswijzigingen toe met een gestructureerd patchformaat. Dit is ideaal voor bewerkingen over meerdere bestanden
of met meerdere hunks, waarbij één enkele `edit`-aanroep kwetsbaar zou zijn.

De tool accepteert één enkele `input`-string die één of meer bestandsoperaties omvat:

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

## Parameters

- `input` (vereist): Volledige patchinhoud inclusief `*** Begin Patch` en `*** End Patch`.

## Notities

- Paden worden relatief ten opzichte van de workspace-root opgelost.
- Gebruik `*** Move to:` binnen een `*** Update File:`-hunk om bestanden te hernoemen.
- `*** End of File` markeert indien nodig een invoeging alleen bij EOF.
- Experimenteel en standaard uitgeschakeld. Schakel in met `tools.exec.applyPatch.enabled`.
- Alleen voor OpenAI (inclusief OpenAI Codex). Optioneel te beperken per model via
  `tools.exec.applyPatch.allowModels`.
- Configuratie staat alleen onder `tools.exec`.

## Voorbeeld

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

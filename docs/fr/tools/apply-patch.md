---
summary: "Appliquer des correctifs multi-fichiers avec l’outil apply_patch"
read_when:
  - Vous avez besoin d’editions de fichiers structurees sur plusieurs fichiers
  - Vous souhaitez documenter ou depanner des modifications basees sur des correctifs
title: "Outil apply_patch"
---

# outil apply_patch

Appliquez des modifications de fichiers a l’aide d’un format de correctif structure. C’est ideal pour des editions multi-fichiers
ou multi-hunks, lorsque un seul appel `edit` serait fragile.

L’outil accepte une seule chaine `input` qui encapsule une ou plusieurs operations sur les fichiers :

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

## Parametres

- `input` (requis) : contenu complet du correctif, y compris `*** Begin Patch` et `*** End Patch`.

## Notes

- Les chemins sont resolus relativement a la racine de l’espace de travail.
- Utilisez `*** Move to:` au sein d’un hunk `*** Update File:` pour renommer des fichiers.
- `*** End of File` indique une insertion uniquement en fin de fichier lorsque necessaire.
- Experimental et desactive par defaut. Activez-le avec `tools.exec.applyPatch.enabled`.
- Reserve a OpenAI (y compris OpenAI Codex). Possibilite de filtrer par modele via
  `tools.exec.applyPatch.allowModels`.
- La configuration se trouve uniquement sous `tools.exec`.

## Exemple

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

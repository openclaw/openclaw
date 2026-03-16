---
summary: "Appliquer des correctifs multi-fichiers avec l'outil apply_patch"
read_when:
  - Vous avez besoin d'éditions de fichiers structurées sur plusieurs fichiers
  - Vous souhaitez documenter ou déboguer des éditions basées sur des correctifs
title: "Outil apply_patch"
---

# Outil apply_patch

Appliquer des modifications de fichiers en utilisant un format de correctif structuré. C'est idéal pour des éditions multi-fichiers ou multi-blocs où un seul appel `edit` serait fragile.

L'outil accepte une seule chaîne `input` qui englobe une ou plusieurs opérations de fichiers :

```
*** Begin Patch
*** Add File: path/to/file.txt
+ligne 1
+ligne 2
*** Update File: src/app.ts
@@
-ancienne ligne
+nouvelle ligne
*** Delete File: obsolete.txt
*** End Patch
```

## Paramètres

- `input` (requis) : Contenu complet du correctif incluant `*** Begin Patch` et `*** End Patch`.

## Remarques

- Les chemins du correctif supportent les chemins relatifs (depuis le répertoire de l'espace de travail) et les chemins absolus.
- `tools.exec.applyPatch.workspaceOnly` vaut `true` par défaut (confiné à l'espace de travail). Définissez-le à `false` uniquement si vous souhaitez intentionnellement que `apply_patch` écrive/supprime en dehors du répertoire de l'espace de travail.
- Utilisez `*** Move to:` dans un bloc `*** Update File:` pour renommer des fichiers.
- `*** End of File` marque une insertion EOF uniquement si nécessaire.
- Expérimental et désactivé par défaut. Activez avec `tools.exec.applyPatch.enabled`.
- OpenAI uniquement (incluant OpenAI Codex). Éventuellement restreindre par modèle via `tools.exec.applyPatch.allowModels`.
- La configuration se trouve uniquement sous `tools.exec`.

## Exemple

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

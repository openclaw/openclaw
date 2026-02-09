---
summary: "Stosuj wieloplikowe poprawki za pomocą narzędzia apply_patch"
read_when:
  - Potrzebujesz uporządkowanych edycji plików w wielu plikach
  - Chcesz dokumentować lub debugować edycje oparte na poprawkach
title: "Narzędzie apply_patch"
---

# narzędzie apply_patch

Stosuj zmiany w plikach przy użyciu uporządkowanego formatu poprawek. Jest to idealne rozwiązanie dla edycji wieloplikowych
lub wielohunkowych, gdzie pojedyncze wywołanie `edit` byłoby kruche.

Narzędzie przyjmuje pojedynczy ciąg `input`, który opakowuje jedną lub więcej operacji na plikach:

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

## Parametry

- `input` (wymagane): Pełna zawartość poprawki, w tym `*** Begin Patch` oraz `*** End Patch`.

## Uwagi

- Ścieżki są rozwiązywane względem katalogu głównego obszaru roboczego.
- Użyj `*** Move to:` w obrębie hunka `*** Update File:`, aby zmieniać nazwy plików.
- `*** End of File` oznacza wstawienie wyłącznie na końcu pliku (EOF), gdy jest to potrzebne.
- Funkcja eksperymentalna i domyślnie wyłączona. Włącz za pomocą `tools.exec.applyPatch.enabled`.
- Tylko dla OpenAI (w tym OpenAI Codex). Opcjonalnie można ograniczyć według modelu przez
  `tools.exec.applyPatch.allowModels`.
- Konfiguracja znajduje się wyłącznie pod `tools.exec`.

## Przykład

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

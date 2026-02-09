---
summary: "Mag-apply ng mga multi-file patch gamit ang apply_patch tool"
read_when:
  - Kailangan mo ng structured na pag-edit ng file sa maraming file
  - Gusto mong idokumento o i-debug ang mga edit na nakabatay sa patch
title: "apply_patch Tool"
---

# apply_patch tool

15. Ilapat ang mga pagbabago sa file gamit ang isang structured patch format. 16. Ito ay mainam para sa mga multi-file o multi-hunk na pag-edit kung saan marupok ang isang solong `edit` call.

Tumatanggap ang tool ng isang `input` na string na bumabalot sa isa o higit pang operasyon sa file:

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

- `input` (kinakailangan): Buong nilalaman ng patch kabilang ang `*** Begin Patch` at `*** End Patch`.

## Notes

- Ang mga path ay nireresolba nang relative sa workspace root.
- Gamitin ang `*** Move to:` sa loob ng isang `*** Update File:` hunk para mag-rename ng mga file.
- Minamarkahan ng `*** End of File` ang isang EOF-only insert kapag kinakailangan.
- 17. Eksperimental at naka-disable bilang default. 18. I-enable gamit ang `tools.exec.applyPatch.enabled`.
- 19. OpenAI-only (kasama ang OpenAI Codex). 16. Opsyonal na i-gate ayon sa modelo gamit ang
      `tools.exec.applyPatch.allowModels`.
- Ang config ay nasa ilalim lamang ng `tools.exec`.

## Example

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

---
summary: "Aplique patches de vários arquivos com a ferramenta apply_patch"
read_when:
  - Voce precisa de edições estruturadas de arquivos em vários arquivos
  - Voce quer documentar ou depurar edições baseadas em patch
title: "Ferramenta apply_patch"
---

# ferramenta apply_patch

Aplique alterações de arquivos usando um formato de patch estruturado. Isso é ideal para edições em vários arquivos
ou com vários hunks, onde uma única chamada `edit` seria frágil.

A ferramenta aceita uma única string `input` que encapsula uma ou mais operações de arquivo:

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

## Parâmetros

- `input` (obrigatório): Conteúdo completo do patch, incluindo `*** Begin Patch` e `*** End Patch`.

## Notas

- Os caminhos são resolvidos em relação à raiz do workspace.
- Use `*** Move to:` dentro de um hunk `*** Update File:` para renomear arquivos.
- `*** End of File` marca uma inserção apenas no EOF quando necessário.
- Experimental e desativado por padrão. Habilite com `tools.exec.applyPatch.enabled`.
- Exclusivo da OpenAI (incluindo OpenAI Codex). Opcionalmente, restrinja por modelo via
  `tools.exec.applyPatch.allowModels`.
- A configuração fica apenas em `tools.exec`.

## Exemplo

```json
{
  "tool": "apply_patch",
  "input": "*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"
}
```

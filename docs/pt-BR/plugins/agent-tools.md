---
summary: "Escreva ferramentas de agente em um plugin (esquemas, ferramentas opcionais, listas de permissões)"
read_when:
  - Você quer adicionar uma nova ferramenta de agente em um plugin
  - Você precisa tornar uma ferramenta opt-in via listas de permissões
title: "Ferramentas de agente de plugin"
---

# Ferramentas de agente de plugin

Plugins do OpenClaw podem registrar **ferramentas de agente** (funções com esquema JSON) que são expostas
ao LLM durante execuções do agente. As ferramentas podem ser **obrigatórias** (sempre disponíveis) ou
**opcionais** (opt‑in).

As ferramentas de agente são configuradas em `tools` na configuração principal, ou por agente em
`agents.list[].tools`. A política de lista de permissões/lista de negação controla quais ferramentas o agente
pode chamar.

## Ferramenta básica

```ts
import { Type } from "@sinclair/typebox";

export default function (api) {
  api.registerTool({
    name: "my_tool",
    description: "Do a thing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
```

## Ferramenta opcional (opt‑in)

Ferramentas opcionais **nunca** são habilitadas automaticamente. Os usuários devem adicioná‑las a uma
lista de permissões do agente.

```ts
export default function (api) {
  api.registerTool(
    {
      name: "workflow_tool",
      description: "Run a local workflow",
      parameters: {
        type: "object",
        properties: {
          pipeline: { type: "string" },
        },
        required: ["pipeline"],
      },
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.pipeline }] };
      },
    },
    { optional: true },
  );
}
```

Habilite ferramentas opcionais em `agents.list[].tools.allow` (ou no global `tools.allow`):

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          allow: [
            "workflow_tool", // specific tool name
            "workflow", // plugin id (enables all tools from that plugin)
            "group:plugins", // all plugin tools
          ],
        },
      },
    ],
  },
}
```

Outros ajustes de configuração que afetam a disponibilidade de ferramentas:

- Listas de permissões que nomeiam apenas ferramentas de plugin são tratadas como opt‑ins de plugin; as ferramentas do núcleo permanecem
  habilitadas, a menos que você também inclua ferramentas do núcleo ou grupos na lista de permissões.
- `tools.profile` / `agents.list[].tools.profile` (lista de permissões base)
- `tools.byProvider` / `agents.list[].tools.byProvider` (permissão/negação específica do provedor)
- `tools.sandbox.tools.*` (política de ferramentas do sandbox quando em sandbox)

## Regras + dicas

- Os nomes das ferramentas **não** devem entrar em conflito com nomes de ferramentas do núcleo; ferramentas conflitantes são ignoradas.
- IDs de plugin usados em listas de permissões não devem entrar em conflito com nomes de ferramentas do núcleo.
- Prefira `optional: true` para ferramentas que disparam efeitos colaterais ou exigem
  binários/credenciais extras.

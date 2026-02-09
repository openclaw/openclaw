---
summary: "Esquema de configuração de Skills e exemplos"
read_when:
  - Adicionando ou modificando a configuração de Skills
  - Ajustando a lista de permissões empacotada ou o comportamento de instalação
title: "Configuração de Skills"
---

# Configuração de Skills

Toda a configuração relacionada a Skills fica em `skills` em `~/.openclaw/openclaw.json`.

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
      watch: true,
      watchDebounceMs: 250,
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun (Gateway runtime still Node; bun not recommended)
    },
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

## Campos

- `allowBundled`: lista de permissões opcional apenas para Skills **empacotadas**. Quando definida, apenas
  as Skills empacotadas na lista são elegíveis (Skills gerenciadas/de workspace não são afetadas).
- `load.extraDirs`: diretórios adicionais de Skills para varrer (menor precedência).
- `load.watch`: observar pastas de Skills e atualizar o snapshot de Skills (padrão: true).
- `load.watchDebounceMs`: debounce para eventos do observador de Skills em milissegundos (padrão: 250).
- `install.preferBrew`: preferir instaladores do brew quando disponíveis (padrão: true).
- `install.nodeManager`: preferência do instalador Node (`npm` | `pnpm` | `yarn` | `bun`, padrão: npm).
  Isso afeta apenas **instalações de Skills**; o runtime do Gateway ainda deve ser Node
  (Bun não recomendado para WhatsApp/Telegram).
- `entries.<skillKey>`: sobrescritas por Skill.

Campos por Skill:

- `enabled`: defina `false` para desativar uma Skill mesmo que ela esteja empacotada/instalada.
- `env`: variáveis de ambiente injetadas para a execução do agente (apenas se ainda não estiverem definidas).
- `apiKey`: conveniência opcional para Skills que declaram uma variável de ambiente primária.

## Notas

- As chaves sob `entries` mapeiam para o nome da Skill por padrão. Se uma Skill definir
  `metadata.openclaw.skillKey`, use essa chave.
- Alterações nas Skills são captadas no próximo turno do agente quando o observador está habilitado.

### Skills em sandbox + variáveis de ambiente

Quando uma sessão está **em sandbox**, os processos de Skills são executados dentro do Docker. O sandbox
**não** herda o `process.env` do host.

Use uma das opções:

- `agents.defaults.sandbox.docker.env` (ou `agents.list[].sandbox.docker.env` por agente)
- incorporar as variáveis de ambiente na sua imagem de sandbox personalizada

`env` e `skills.entries.<skill>.env/apiKey` globais se aplicam apenas a execuções no **host**.

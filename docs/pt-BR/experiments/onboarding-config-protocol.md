---
summary: "Notas do protocolo RPC para o assistente de integração inicial e o esquema de configuração"
read_when: "Ao alterar as etapas do assistente de integração inicial ou os endpoints do esquema de configuração"
title: "Protocolo de Integração Inicial e Configuração"
---

# Protocolo de Integração Inicial + Configuração

Objetivo: superfícies compartilhadas de integração inicial + configuração entre a CLI, o app macOS e a Web UI.

## Componentes

- Mecanismo do assistente (sessão compartilhada + prompts + estado de integração inicial).
- A integração inicial via CLI usa o mesmo fluxo do assistente que os clientes de UI.
- O RPC do Gateway expõe endpoints do assistente + do esquema de configuração.
- A integração inicial no macOS usa o modelo de etapas do assistente.
- A Web UI renderiza formulários de configuração a partir de JSON Schema + dicas de UI.

## RPC do Gateway

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Respostas (formato)

- Assistente: `{ sessionId, done, step?, status?, error? }`
- Esquema de configuração: `{ schema, uiHints, version, generatedAt }`

## Dicas de UI

- `uiHints` com chave por caminho; metadados opcionais (rótulo/ajuda/grupo/ordem/avançado/sensível/placeholder).
- Campos sensíveis são renderizados como entradas de senha; sem camada de redação.
- Nós de esquema não suportados recorrem ao editor JSON bruto.

## Notas

- Este documento é o único lugar para acompanhar refatorações de protocolo para integração inicial/configuração.

---
summary: "CLI de modelos: listar, definir, aliases, fallbacks, varredura, status"
read_when:
  - Adicionar ou modificar a CLI de modelos (models list/set/scan/aliases/fallbacks)
  - Alterar o comportamento de fallback de modelos ou a UX de seleção
  - Atualizar sondas de varredura de modelos (ferramentas/imagens)
title: "CLI de modelos"
---

# CLI de modelos

Veja [/concepts/model-failover](/concepts/model-failover) para rotação de perfis
de autenticação, cooldowns e como isso interage com fallbacks.
Visão geral rápida de provedores + exemplos: [/concepts/model-providers](/concepts/model-providers).

## Como funciona a seleção de modelos

O OpenClaw seleciona modelos nesta ordem:

1. **Primário** (`agents.defaults.model.primary` ou `agents.defaults.model`).
2. **Fallbacks** em `agents.defaults.model.fallbacks` (em ordem).
3. **Failover de autenticação do provedor** acontece dentro de um provedor antes de
   passar para o próximo modelo.

Relacionado:

- `agents.defaults.models` é a lista de permissões/catálogo de modelos que o OpenClaw pode usar (além de aliases).
- `agents.defaults.imageModel` é usado **apenas quando** o modelo primário não aceita imagens.
- Padrões por agente podem substituir `agents.defaults.model` via `agents.list[].model` mais bindings (veja [/concepts/multi-agent](/concepts/multi-agent)).

## Escolhas rápidas de modelos (anedóticas)

- **GLM**: um pouco melhor para código/chamada de ferramentas.
- **MiniMax**: melhor para escrita e “vibes”.

## Assistente de configuração (recomendado)

Se voce não quiser editar a configuração manualmente, execute o assistente de integração inicial:

```bash
openclaw onboard
```

Ele pode configurar modelo + autenticação para provedores comuns, incluindo **OpenAI Code (Codex)
subscription** (OAuth) e **Anthropic** (chave de API recomendada; `claude
setup-token` também é compatível).

## Chaves de configuração (visão geral)

- `agents.defaults.model.primary` e `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` e `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (lista de permissões + aliases + parâmetros do provedor)
- `models.providers` (provedores personalizados gravados em `models.json`)

Referências de modelos são normalizadas para minúsculas. Aliases de provedores como `z.ai/*` normalizam
para `zai/*`.

Exemplos de configuração de provedores (incluindo OpenCode Zen) ficam em
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “Modelo não é permitido” (e por que as respostas param)

Se `agents.defaults.models` estiver definido, ele se torna a **lista de permissões** para `/model` e para
substituições de sessão. Quando um usuário seleciona um modelo que não está nessa lista,
o OpenClaw retorna:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Isso acontece **antes** de uma resposta normal ser gerada, então a mensagem pode parecer
que “não respondeu”. A correção é:

- Adicionar o modelo a `agents.defaults.models`, ou
- Limpar a lista de permissões (remover `agents.defaults.models`), ou
- Escolher um modelo de `/model list`.

Exemplo de configuração de lista de permissões:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Alternar modelos no chat (`/model`)

Voce pode alternar modelos para a sessão atual sem reiniciar:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notas:

- `/model` (e `/model list`) é um seletor compacto e numerado (família do modelo + provedores disponíveis).
- `/model <#>` seleciona a partir desse seletor.
- `/model status` é a visualização detalhada (candidatos de autenticação e, quando configurado, endpoint do provedor `baseUrl` + modo `api`).
- Referências de modelos são analisadas dividindo no **primeiro** `/`. Use `provider/model` ao digitar `/model <ref>`.
- Se o próprio ID do modelo contiver `/` (estilo OpenRouter), voce deve incluir o prefixo do provedor (exemplo: `/model openrouter/moonshotai/kimi-k2`).
- Se voce omitir o provedor, o OpenClaw trata a entrada como um alias ou um modelo para o **provedor padrão** (funciona apenas quando não há `/` no ID do modelo).

Comportamento/configuração completa do comando: [Slash commands](/tools/slash-commands).

## Comandos da CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (sem subcomando) é um atalho para `models status`.

### `models list`

Mostra os modelos configurados por padrão. Flags úteis:

- `--all`: catálogo completo
- `--local`: apenas provedores locais
- `--provider <name>`: filtrar por provedor
- `--plain`: um modelo por linha
- `--json`: saída legível por máquina

### `models status`

Mostra o modelo primário resolvido, fallbacks, modelo de imagem e uma visão geral de autenticação
dos provedores configurados. Também exibe o status de expiração do OAuth para perfis encontrados
no armazenamento de autenticação (avisa dentro de 24h por padrão). `--plain` imprime apenas o
modelo primário resolvido.
O status do OAuth é sempre exibido (e incluído na saída de `--json`). Se um provedor configurado
não tiver credenciais, `models status` imprime uma seção **Missing auth**.
O JSON inclui `auth.oauth` (janela de aviso + perfis) e `auth.providers`
(autenticação efetiva por provedor).
Use `--check` para automação (saída `1` quando ausente/expirada, `2` quando prestes a expirar).

A autenticação preferida da Anthropic é o setup-token do Claude Code CLI (execute em qualquer lugar; cole no host do Gateway se necessário):

```bash
claude setup-token
openclaw models status
```

## Varredura (modelos gratuitos do OpenRouter)

`openclaw models scan` inspeciona o **catálogo de modelos gratuitos** do OpenRouter e pode
opcionalmente sondar modelos para suporte a ferramentas e imagens.

Principais flags:

- `--no-probe`: pular sondagens ao vivo (apenas metadados)
- `--min-params <b>`: tamanho mínimo de parâmetros (bilhões)
- `--max-age-days <days>`: pular modelos mais antigos
- `--provider <name>`: filtro de prefixo de provedor
- `--max-candidates <n>`: tamanho da lista de fallbacks
- `--set-default`: definir `agents.defaults.model.primary` como a primeira seleção
- `--set-image`: definir `agents.defaults.imageModel.primary` como a primeira seleção de imagem

A sondagem requer uma chave de API do OpenRouter (dos perfis de autenticação ou
`OPENROUTER_API_KEY`). Sem uma chave, use `--no-probe` para listar apenas candidatos.

Os resultados da varredura são classificados por:

1. Suporte a imagens
2. Latência de ferramentas
3. Tamanho de contexto
4. Contagem de parâmetros

Entrada

- Lista de `/models` do OpenRouter (filtro `:free`)
- Requer chave de API do OpenRouter dos perfis de autenticação ou `OPENROUTER_API_KEY` (veja [/environment](/help/environment))
- Filtros opcionais: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Controles de sondagem: `--timeout`, `--concurrency`

Ao executar em um TTY, voce pode selecionar fallbacks interativamente. No modo não interativo,
passe `--yes` para aceitar os padrões.

## Registro de modelos (`models.json`)

Provedores personalizados em `models.providers` são gravados em `models.json` sob o
diretório do agente (padrão `~/.openclaw/agents/<agentId>/models.json`). Este arquivo
é mesclado por padrão, a menos que `models.mode` esteja definido como `replace`.

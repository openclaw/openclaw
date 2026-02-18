---
summary: "CLI de Modelos: listar, definir, aliases, fallbacks, scan, status"
read_when:
  - Adicionando ou modificando CLI de modelos (models list/set/scan/aliases/fallbacks)
  - Mudando comportamento de fallback de modelo ou seleção UX
  - Atualizando probes de scan de modelo (tools/images)
title: "CLI de Modelos"
---

# CLI de Modelos

Veja [/pt-BR/concepts/model-failover](/pt-BR/concepts/model-failover) para rotação de perfil de autenticação, cooldowns e como isso interage com fallbacks.
Visão geral rápida do provedor + exemplos: [/pt-BR/concepts/model-providers](/pt-BR/concepts/model-providers).

## Como funciona a seleção de modelo

OpenClaw seleciona modelos nesta ordem:

1. **Modelo primário** (`agents.defaults.model.primary` ou `agents.defaults.model`).
2. **Fallbacks** em `agents.defaults.model.fallbacks` (em ordem).
3. **Failover de autenticação do provedor** acontece dentro de um provedor antes de passar para o próximo modelo.

Relacionado:

- `agents.defaults.models` é a lista de permissões/catálogo de modelos que OpenClaw pode usar (mais aliases).
- `agents.defaults.imageModel` é usado **apenas quando** o modelo primário não pode aceitar imagens.
- Padrões por agente podem sobrescrever `agents.defaults.model` via `agents.list[].model` mais bindings (veja [/pt-BR/concepts/multi-agent](/pt-BR/concepts/multi-agent)).

## Escolhas rápidas de modelo (anedótico)

- **GLM**: um pouco melhor para codificação/tool calling.
- **MiniMax**: melhor para escrita e vibes.

## Assistente de configuração (recomendado)

Se você não quer editar manualmente a config, execute o assistente de onboarding:

```bash
openclaw onboard
```

Pode configurar modelo + autenticação para provedores comuns, incluindo **Assinatura OpenAI Code (Codex)** (OAuth) e **Anthropic** (API key recomendada; `claude setup-token` também suportado).

## Chaves de configuração (visão geral)

- `agents.defaults.model.primary` e `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` e `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (lista de permissões + aliases + parâmetros do provedor)
- `models.providers` (provedores personalizados escritos em `models.json`)

Referências de modelo são normalizadas para minúsculas. Aliases do provedor como `z.ai/*` normalizam para `zai/*`.

Exemplos de configuração do provedor (incluindo OpenCode Zen) vivem em [/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## "Modelo não é permitido" (e por que as respostas param)

Se `agents.defaults.models` estiver definido, ele se torna a **lista de permissões** para `/model` e para substituições de sessão. Quando um usuário seleciona um modelo que não está nessa lista de permissões, OpenClaw retorna:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Isso acontece **antes** de uma resposta normal ser gerada, então a mensagem pode parecer que "não respondeu." A solução é:

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

## Trocando modelos no chat (`/model`)

Você pode trocar modelos para a sessão atual sem reiniciar:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notas:

- `/model` (e `/model list`) é um seletor compacto e numerado (família de modelo + provedores disponíveis).
- `/model <#>` seleciona a partir desse seletor.
- `/model status` é a visão detalhada (candidatos de autenticação e, quando configurado, endpoint do provedor `baseUrl` + modo `api`).
- Referências de modelo são analisadas dividindo no **primeiro** `/`. Use `provider/model` ao digitar `/model <ref>`.
- Se o ID do modelo em si contiver `/` (estilo OpenRouter), você deve incluir o prefixo do provedor (exemplo: `/model openrouter/moonshotai/kimi-k2`).
- Se você omitir o provedor, OpenClaw trata a entrada como um alias ou um modelo para o **provedor padrão** (funciona apenas quando não há `/` no ID do modelo).

Comportamento completo do comando/config: [Comandos Slash](/tools/slash-commands).

## Comandos CLI

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

Mostra modelos configurados por padrão. Flags úteis:

- `--all`: catálogo completo
- `--local`: apenas provedores locais
- `--provider <name>`: filtrar por provedor
- `--plain`: um modelo por linha
- `--json`: saída legível por máquina

### `models status`

Mostra o modelo primário resolvido, fallbacks, modelo de imagem e uma visão geral de autenticação de provedores configurados. Também expõe o status de expiração de OAuth para perfis encontrados no armazenamento de autenticação (avisa dentro de 24h por padrão). `--plain` imprime apenas o modelo primário resolvido.
Status OAuth é sempre mostrado (e incluído na saída `--json`). Se um provedor configurado não tem credenciais, `models status` imprime uma seção **Missing auth**.
JSON inclui `auth.oauth` (janela de aviso + perfis) e `auth.providers` (auth efetiva por provedor).
Use `--check` para automação (saída `1` quando faltando/expirado, `2` quando expirando).

Autenticação Anthropic preferida é o setup-token CLI do Claude Code (execute em qualquer lugar; cole no host do gateway se necessário):

```bash
claude setup-token
openclaw models status
```

## Scanning (modelos gratuitos OpenRouter)

`openclaw models scan` inspeciona o **catálogo de modelo gratuito** OpenRouter e pode opcionalmente fazer probe de modelos para suporte a ferramentas e imagens.

Flags principais:

- `--no-probe`: pular probes ao vivo (apenas metadados)
- `--min-params <b>`: tamanho mínimo de parâmetro (bilhões)
- `--max-age-days <days>`: pular modelos mais antigos
- `--provider <name>`: filtro de prefixo de provedor
- `--max-candidates <n>`: tamanho da lista de fallback
- `--set-default`: definir `agents.defaults.model.primary` para a primeira seleção
- `--set-image`: definir `agents.defaults.imageModel.primary` para a primeira seleção de imagem

Probing requer uma chave de API OpenRouter (de perfis de autenticação ou `OPENROUTER_API_KEY`). Sem uma chave, use `--no-probe` para listar apenas candidatos.

Resultados de scan são classificados por:

1. Suporte a imagem
2. Latência de ferramenta
3. Tamanho de contexto
4. Contagem de parâmetro

Entrada

- Lista `/models` OpenRouter (filtro `:free`)
- Requer chave de API OpenRouter de perfis de autenticação ou `OPENROUTER_API_KEY` (veja [/help/environment](/help/environment))
- Filtros opcionais: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Controles de probe: `--timeout`, `--concurrency`

Quando executado em um TTY, você pode selecionar fallbacks interativamente. Em modo não-interativo, passe `--yes` para aceitar padrões.

## Registro de modelos (`models.json`)

Provedores personalizados em `models.providers` são escritos em `models.json` sob o diretório do agente (padrão `~/.openclaw/agents/<agentId>/models.json`). Este arquivo é mesclado por padrão a menos que `models.mode` seja definido como `replace`.

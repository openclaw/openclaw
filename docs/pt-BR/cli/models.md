---
summary: "Referência da CLI para `openclaw models` (status/list/set/scan, aliases, fallbacks, autenticação)"
read_when:
  - Você quer alterar os modelos padrão ou ver o status de autenticação do provedor
  - Você quer escanear modelos/provedores disponíveis e depurar perfis de autenticação
title: "modelos"
---

# `openclaw models`

Descoberta de modelos, varredura e configuração (modelo padrão, fallbacks, perfis de autenticação).

Relacionado:

- Provedores + modelos: [Models](/providers/models)
- Configuração de autenticação do provedor: [Primeiros passos](/start/getting-started)

## Comandos comuns

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` mostra o padrão resolvido/fallbacks junto com uma visão geral de autenticação.
Quando instantâneos de uso do provedor estão disponíveis, a seção de status OAuth/token inclui
cabeçalhos de uso do provedor.
Adicione `--probe` para executar sondagens de autenticação ao vivo em cada perfil de provedor configurado.
As sondagens são requisições reais (podem consumir tokens e acionar limites de taxa).
Use `--agent <id>` para inspecionar o estado de modelo/autenticação de um agente configurado. Quando omitido,
o comando usa `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` se definidos; caso contrário, o
agente padrão configurado.

Notas:

- `models set <model-or-alias>` aceita `provider/model` ou um alias.
- Referências de modelo são analisadas dividindo pelo **primeiro** `/`. Se o ID do modelo incluir `/` (estilo OpenRouter), inclua o prefixo do provedor (exemplo: `openrouter/moonshotai/kimi-k2`).
- Se você omitir o provedor, o OpenClaw trata a entrada como um alias ou um modelo para o **provedor padrão** (funciona apenas quando não há `/` no ID do modelo).

### `models status`

Opções:

- `--json`
- `--plain`
- `--check` (sair 1=expirado/ausente, 2=expirando)
- `--probe` (sondagem ao vivo de perfis de autenticação configurados)
- `--probe-provider <name>` (sondar um provedor)
- `--probe-profile <id>` (repetir ou IDs de perfil separados por vírgula)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (ID do agente configurado; substitui `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Aliases + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Perfis de autenticação

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` executa o fluxo de autenticação de um plugin de provedor (OAuth/chave de API). Use
`openclaw plugins list` para ver quais provedores estão instalados.

Notas:

- `setup-token` solicita um valor de setup-token (gere-o com `claude setup-token` em qualquer máquina).
- `paste-token` aceita uma string de token gerada em outro lugar ou a partir de automação.

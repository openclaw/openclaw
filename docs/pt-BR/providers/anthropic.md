---
summary: "Use o Anthropic Claude por meio de chaves de API ou setup-token no OpenClaw"
read_when:
  - Você quer usar modelos da Anthropic no OpenClaw
  - Você quer setup-token em vez de chaves de API
title: "Anthropic"
---

# Anthropic (Claude)

A Anthropic desenvolve a família de modelos **Claude** e fornece acesso por meio de uma API.
No OpenClaw, você pode se autenticar com uma chave de API ou um **setup-token**.

## Opção A: Chave de API da Anthropic

**Melhor para:** acesso padrão à API e cobrança baseada em uso.
Crie sua chave de API no Console da Anthropic.

### Configuração da CLI

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Trecho de configuração

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Cache de prompt (API da Anthropic)

O OpenClaw oferece suporte ao recurso de cache de prompt da Anthropic. Isso é **somente por API**; a autenticação por assinatura não respeita as configurações de cache.

### Configuração

Use o parâmetro `cacheRetention` na configuração do seu modelo:

| Valor   | Duração do cache | Descrição                                             |
| ------- | ---------------- | ----------------------------------------------------- |
| `none`  | Sem cache        | Desativar o cache de prompt                           |
| `short` | 5 minutos        | Padrão para autenticação por chave de API             |
| `long`  | 1 hora           | Cache estendido (requer flag beta) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Padrões

Ao usar autenticação por Chave de API da Anthropic, o OpenClaw aplica automaticamente `cacheRetention: "short"` (cache de 5 minutos) para todos os modelos da Anthropic. Você pode sobrescrever isso definindo explicitamente `cacheRetention` na sua configuração.

### Parâmetro legado

O parâmetro antigo `cacheControlTtl` ainda é suportado para compatibilidade retroativa:

- `"5m"` mapeia para `short`
- `"1h"` mapeia para `long`

Recomendamos migrar para o novo parâmetro `cacheRetention`.

O OpenClaw inclui a flag beta `extended-cache-ttl-2025-04-11` para requisições à API da Anthropic; mantenha-a se você sobrescrever os cabeçalhos do provedor (veja [/gateway/configuration](/gateway/configuration)).

## Opção B: Claude setup-token

**Melhor para:** usar sua assinatura do Claude.

### Onde obter um setup-token

Os setup-tokens são criados pela **Claude Code CLI**, não pelo Console da Anthropic. Você pode executar isso em **qualquer máquina**:

```bash
claude setup-token
```

Cole o token no OpenClaw (assistente: **Anthropic token (colar setup-token)**), ou execute-o no host do Gateway:

```bash
openclaw models auth setup-token --provider anthropic
```

Se você gerou o token em outra máquina, cole-o:

```bash
openclaw models auth paste-token --provider anthropic
```

### Configuração da CLI (setup-token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Trecho de configuração (setup-token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Notas

- Gere o setup-token com `claude setup-token` e cole-o, ou execute `openclaw models auth setup-token` no host do gateway.
- Se você vir “OAuth token refresh failed …” em uma assinatura do Claude, reautentique com um setup-token. Veja [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Detalhes de autenticação + regras de reutilização estão em [/concepts/oauth](/concepts/oauth).

## Solução de problemas

**Erros 401 / token subitamente inválido**

- A autenticação da assinatura do Claude pode expirar ou ser revogada. Execute novamente `claude setup-token`
  e cole-o no **host do gateway**.
- Se o login da Claude CLI estiver em outra máquina, use
  `openclaw models auth paste-token --provider anthropic` no host do gateway.

**Nenhuma chave de API encontrada para o provedor "anthropic"**

- A autenticação é **por agente**. Novos agentes não herdam as chaves do agente principal.
- Execute novamente a integração inicial para esse agente ou cole um setup-token / chave de API no
  host do gateway e, em seguida, verifique com `openclaw models status`.

**Nenhuma credencial encontrada para o perfil `anthropic:default`**

- Execute `openclaw models status` para ver qual perfil de autenticação está ativo.
- Execute novamente a integração inicial ou cole um setup-token / chave de API para esse perfil.

**Nenhum perfil de autenticação disponível (todos em cooldown/indisponíveis)**

- Verifique `openclaw models status --json` para `auth.unusableProfiles`.
- Adicione outro perfil da Anthropic ou aguarde o cooldown.

Mais: [/gateway/troubleshooting](/gateway/troubleshooting) e [/help/faq](/help/faq).

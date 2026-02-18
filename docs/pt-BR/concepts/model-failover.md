---
summary: "Como OpenClaw rotaciona perfis de autenticação e faz fallback entre modelos"
read_when:
  - Diagnosticando rotação de perfil de autenticação, cooldowns ou comportamento de fallback de modelo
  - Atualizando regras de failover para perfis de autenticação ou modelos
title: "Failover de Modelo"
---

# Failover de modelo

OpenClaw manipula falhas em dois estágios:

1. **Rotação de perfil de autenticação** dentro do provedor atual.
2. **Fallback de modelo** para o próximo modelo em `agents.defaults.model.fallbacks`.

Este documento explica as regras de runtime e os dados que as suportam.

## Armazenamento de autenticação (chaves + OAuth)

OpenClaw usa **perfis de autenticação** para chaves de API e tokens OAuth.

- Segredos vivem em `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legado: `~/.openclaw/agent/auth-profiles.json`).
- Config `auth.profiles` / `auth.order` são **apenas metadados + roteamento** (sem segredos).
- Arquivo OAuth apenas para importação legada: `~/.openclaw/credentials/oauth.json` (importado para `auth-profiles.json` no primeiro uso).

Mais detalhes: [/pt-BR/concepts/oauth](/pt-BR/concepts/oauth)

Tipos de credencial:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` para alguns provedores)

## IDs de perfil

Logins OAuth criam perfis distintos para que múltiplas contas possam coexistir.

- Padrão: `provider:default` quando nenhum email está disponível.
- OAuth com email: `provider:<email>` (por exemplo `google-antigravity:user@gmail.com`).

Perfis vivem em `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` sob `profiles`.

## Ordem de rotação

Quando um provedor tem múltiplos perfis, OpenClaw escolhe uma ordem assim:

1. **Config explícita**: `auth.order[provider]` (se definido).
2. **Perfis configurados**: `auth.profiles` filtrado por provedor.
3. **Perfis armazenados**: entradas em `auth-profiles.json` para o provedor.

Se nenhuma ordem explícita é configurada, OpenClaw usa uma ordem round-robin:

- **Primary key:** tipo de perfil (**OAuth antes de chaves de API**).
- **Secondary key:** `usageStats.lastUsed` (mais antiga primeiro, dentro de cada tipo).
- **Perfis em cooldown/desabilitados** são movidos para o final, ordenados por expiração mais próxima.

### Aderência de sessão (amigável a cache)

OpenClaw **fixa o perfil de autenticação escolhido por sessão** para manter caches de provedor aquecidos.
Ele **não** rotaciona em cada requisição. O perfil fixado é reutilizado até:

- a sessão ser resetada (`/new` / `/reset`)
- uma compactação se completar (contagem de compactação incrementa)
- o perfil estar em cooldown/desabilitado

Seleção manual via `/model …@<profileId>` define uma **substituição de usuário** para aquela sessão e não é rotacionada automaticamente até uma nova sessão iniciar.

Perfis auto-fixados (selecionados pelo roteador de sessão) são tratados como uma **preferência**:
eles são tentados primeiro, mas OpenClaw pode rotacionar para outro perfil em rate limits/timeouts.
Perfis fixados por usuário permanecem travados naquele perfil; se falhar e fallbacks de modelo forem configurados, OpenClaw move para o próximo modelo em vez de trocar perfis.

### Por que OAuth pode "parecer perdido"

Se você tem tanto um perfil OAuth quanto um perfil de chave de API para o mesmo provedor, round-robin pode trocar entre eles entre mensagens a menos que fixado. Para forçar um perfil único:

- Fixe com `auth.order[provider] = ["provider:profileId"]`, ou
- Use uma substituição por sessão via `/model …` com uma substituição de perfil (quando suportado por sua interface/superfície de chat).

## Cooldowns

Quando um perfil falha devido a erros de autenticação/rate-limit (ou um timeout que parece rate limiting), OpenClaw o marca em cooldown e move para o próximo perfil. Erros de formato/requisição inválida (por exemplo falhas de validação de ID de chamada de ferramenta Cloud Code Assist) são tratados como dignos de failover e usam os mesmos cooldowns.

Cooldowns usam exponential backoff:

- 1 minuto
- 5 minutos
- 25 minutos
- 1 hora (cap)

Estado é armazenado em `auth-profiles.json` sob `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Desabilita de faturamento

Falhas de faturamento/crédito (por exemplo "créditos insuficientes" / "saldo de crédito muito baixo") são tratadas como dignas de failover, mas geralmente não são transitórias. Em vez de um cooldown curto, OpenClaw marca o perfil como **desabilitado** (com um backoff mais longo) e rotaciona para o próximo perfil/provedor.

Estado é armazenado em `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Padrões:

-backoff de faturamento começa em **5 horas**, dobra por falha de faturamento e caplocks em **24 horas**.

- Contadores de backoff resetam se o perfil não falhou por **24 horas** (configurável).

## Fallback de modelo

Se todos os perfis para um provedor falharem, OpenClaw move para o próximo modelo em `agents.defaults.model.fallbacks`. Isso se aplica a falhas de autenticação, rate limits e timeouts que esgotaram rotação de perfil (outros erros não avançam fallback).

Quando uma execução começa com uma substituição de modelo (ganchos ou CLI), fallbacks ainda acabam em `agents.defaults.model.primary` após tentar qualquer fallback configurado.

## Config relacionada

Veja [Configuração do Gateway](/gateway/configuration) para:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- Roteamento de `agents.defaults.imageModel`

Veja [Modelos](/pt-BR/concepts/models) para a visão geral mais ampla de seleção de modelo e fallback.
